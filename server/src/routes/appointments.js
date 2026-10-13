import { Router } from 'express';
import { z } from 'zod';
import { pool, query, withTransaction } from '../db.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HttpError } from '../lib/httpError.js';
import { dateTime, findOr404, idParamSchema, isoDate } from '../lib/common.js';
import { listSchema, paginate } from '../lib/list.js';

const router = Router();

const STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'];
const DEFAULT_MINUTES = 30;
const MAX_MINUTES = 8 * 60;

const SORT = { starts: 'a.starts_at', id: 'a.id', created: 'a.created_at', status: 'a.status', doctor: 'd.name' };
const listQuery = listSchema(
  SORT,
  {
    status: z.enum(STATUSES).optional(),
    doctor_id: z.coerce.number().int().positive().optional(),
    patient_id: z.coerce.number().int().positive().optional(),
    date: isoDate.optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  },
  'asc'
);

const timesSchema = z.object({
  starts_at: dateTime,
  ends_at: dateTime.optional(),
});
const createSchema = timesSchema.extend({
  patient_id: z.coerce.number().int().positive(),
  doctor_id: z.coerce.number().int().positive(),
  reason: z.string().trim().max(255).nullish(),
  notes: z.string().trim().max(5000).nullish(),
});
const updateSchema = z
  .object({
    starts_at: dateTime.optional(),
    ends_at: dateTime.optional(),
    doctor_id: z.coerce.number().int().positive().optional(),
    reason: z.string().trim().max(255).nullish(),
    notes: z.string().trim().max(5000).nullish(),
  })
  .refine((o) => Object.keys(o).length > 0, 'No fields to update');
const notesSchema = z.object({ notes: z.string().trim().max(5000).optional() });

const SELECT = `a.id, a.*, CONCAT(p.first_name, ' ', p.last_name) AS patient_name, p.mrn, p.phone AS patient_phone,
  d.name AS doctor_name, dp.name AS department_name`;
const FROM = `appointments a
  JOIN patients p ON p.id = a.patient_id
  JOIN doctors d ON d.id = a.doctor_id
  JOIN departments dp ON dp.id = d.department_id`;

async function getAppointment(id) {
  const [row] = await query(`SELECT ${SELECT} FROM ${FROM} WHERE a.id = ?`, [id]);
  if (!row) throw HttpError.notFound(`Appointment ${id} not found`);
  return row;
}

/** Marks scheduled appointments whose end time has passed as no-shows. Returns affected count. */
export async function markNoShows() {
  const [r] = await pool.query(
    "UPDATE appointments SET status = 'no_show' WHERE status = 'scheduled' AND ends_at < NOW()"
  );
  return r.affectedRows;
}

function resolveTimes(startsAt, endsAt) {
  const ends = endsAt ?? new Date(startsAt.getTime() + DEFAULT_MINUTES * 60_000);
  if (startsAt.getTime() <= Date.now()) throw HttpError.badRequest('Cannot book an appointment in the past');
  if (ends <= startsAt) throw HttpError.badRequest('ends_at must be after starts_at');
  if (ends - startsAt > MAX_MINUTES * 60_000) throw HttpError.badRequest(`Appointment cannot exceed ${MAX_MINUTES} minutes`);
  return [startsAt, ends];
}

/**
 * Locks the doctor row (serialising all bookings for that doctor) then checks for any
 * overlapping active appointment. Must run inside a transaction.
 */
async function assertNoOverlap(conn, doctorId, startsAt, endsAt, excludeId = 0) {
  const [[doctor]] = await conn.query('SELECT id, is_active FROM doctors WHERE id = ? FOR UPDATE', [doctorId]);
  if (!doctor) throw HttpError.notFound(`Doctor ${doctorId} not found`);
  if (!doctor.is_active) throw HttpError.conflict('Doctor is not active');
  const [clash] = await conn.query(
    `SELECT id, starts_at, ends_at FROM appointments
      WHERE doctor_id = ? AND status IN ('scheduled', 'completed') AND id <> ?
        AND starts_at < ? AND ends_at > ?
      LIMIT 1`,
    [doctorId, excludeId, endsAt, startsAt]
  );
  if (clash.length) {
    throw HttpError.conflict('Doctor already has an appointment in this time slot', { conflictingAppointment: clash[0] });
  }
}

router.get(
  '/',
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    await markNoShows();
    const q = req.valid.query;
    // Doctors only see their own appointments.
    const ownDoctorId = req.user.role === 'doctor' ? await doctorIdForUser(req.user.id) : null;
    res.json(
      await paginate({
        select: SELECT,
        from: FROM,
        where: [
          q.status && ['a.status = ?', q.status],
          q.doctor_id && ['a.doctor_id = ?', q.doctor_id],
          ownDoctorId && ['a.doctor_id = ?', ownDoctorId],
          q.patient_id && ['a.patient_id = ?', q.patient_id],
          q.date && ['a.starts_at >= ? AND a.starts_at < DATE_ADD(?, INTERVAL 1 DAY)', q.date, q.date],
          q.from && ['a.starts_at >= ?', q.from],
          q.to && ['a.starts_at < DATE_ADD(?, INTERVAL 1 DAY)', q.to],
        ],
        searchCols: ['p.first_name', 'p.last_name', "CONCAT(p.first_name, ' ', p.last_name)", 'p.mrn', 'p.phone', 'd.name', 'a.reason'],
        sortMap: SORT,
        q,
      })
    );
  })
);

async function doctorIdForUser(userId) {
  const [row] = await query('SELECT id FROM doctors WHERE user_id = ?', [userId]);
  return row?.id ?? -1;
}

router.post(
  '/mark-no-shows',
  requireRole('receptionist', 'doctor'),
  asyncHandler(async (req, res) => {
    res.json({ updated: await markNoShows() });
  })
);

router.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await markNoShows();
    res.json(await getAppointment(req.valid.params.id));
  })
);

router.post(
  '/',
  requireRole('receptionist', 'doctor'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    const [startsAt, endsAt] = resolveTimes(b.starts_at, b.ends_at);
    const id = await withTransaction(async (conn) => {
      await findOr404('patients', b.patient_id, { conn, label: 'Patient' });
      await assertNoOverlap(conn, b.doctor_id, startsAt, endsAt);
      const [r] = await conn.query(
        `INSERT INTO appointments (patient_id, doctor_id, starts_at, ends_at, reason, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [b.patient_id, b.doctor_id, startsAt, endsAt, b.reason ?? null, b.notes ?? null, req.user.id]
      );
      return r.insertId;
    });
    res.status(201).json(await getAppointment(id));
  })
);

router.patch(
  '/:id',
  requireRole('receptionist', 'doctor'),
  validate(idParamSchema, 'params'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    const b = req.valid.body;
    await withTransaction(async (conn) => {
      const appt = await findOr404('appointments', id, { conn, label: 'Appointment', lock: true });
      const rescheduling = b.starts_at || b.ends_at || b.doctor_id;
      let startsAt = appt.starts_at;
      let endsAt = appt.ends_at;
      if (rescheduling) {
        if (appt.status !== 'scheduled') throw HttpError.conflict(`Cannot reschedule a ${appt.status} appointment`);
        const duration = appt.ends_at - appt.starts_at;
        startsAt = b.starts_at ?? appt.starts_at;
        endsAt = b.ends_at ?? (b.starts_at ? new Date(startsAt.getTime() + duration) : appt.ends_at);
        [startsAt, endsAt] = resolveTimes(startsAt, endsAt);
        await assertNoOverlap(conn, b.doctor_id ?? appt.doctor_id, startsAt, endsAt, id);
      }
      await conn.query(
        `UPDATE appointments SET doctor_id = ?, starts_at = ?, ends_at = ?, reason = ?, notes = ? WHERE id = ?`,
        [b.doctor_id ?? appt.doctor_id, startsAt, endsAt,
          b.reason === undefined ? appt.reason : b.reason, b.notes === undefined ? appt.notes : b.notes, id]
      );
    });
    res.json(await getAppointment(id));
  })
);

/** Status transitions allowed only from 'scheduled'. */
const transition = (to, roles, { requireStarted = false } = {}) => [
  requireRole(...roles),
  validate(idParamSchema, 'params'),
  validate(notesSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    await withTransaction(async (conn) => {
      const appt = await findOr404('appointments', id, { conn, label: 'Appointment', lock: true });
      if (appt.status !== 'scheduled') {
        throw HttpError.conflict(`Only scheduled appointments can be ${to.replace('_', '-')}; current status is ${appt.status}`);
      }
      if (requireStarted && appt.starts_at > new Date()) {
        throw HttpError.conflict('Cannot mark an appointment that has not started yet');
      }
      await conn.query('UPDATE appointments SET status = ?, notes = COALESCE(?, notes) WHERE id = ?', [
        to, req.valid.body.notes ?? null, id,
      ]);
    });
    res.json(await getAppointment(id));
  }),
];

router.post('/:id/cancel', ...transition('cancelled', ['receptionist', 'doctor']));
router.post('/:id/complete', ...transition('completed', ['doctor']));
router.post('/:id/no-show', ...transition('no_show', ['receptionist', 'doctor'], { requireStarted: true }));

router.delete(
  '/:id',
  requireRole(),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await findOr404('appointments', req.valid.params.id, { label: 'Appointment' });
    await query('DELETE FROM appointments WHERE id = ?', [req.valid.params.id]);
    res.status(204).end();
  })
);

export default router;
