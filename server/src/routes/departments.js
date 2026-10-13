import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { findOr404, idParamSchema } from '../lib/common.js';

const router = Router();

const schema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(255).nullish(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT dp.*, COUNT(d.id) AS doctor_count
         FROM departments dp LEFT JOIN doctors d ON d.department_id = dp.id
        GROUP BY dp.id ORDER BY dp.name`
    );
    res.json({ data: rows });
  })
);

router.post(
  '/',
  requireRole(),
  validate(schema),
  asyncHandler(async (req, res) => {
    const { name, description } = req.valid.body;
    const r = await query('INSERT INTO departments (name, description) VALUES (?, ?)', [name, description ?? null]);
    res.status(201).json(await findOr404('departments', r.insertId, { label: 'Department' }));
  })
);

router.delete(
  '/:id',
  requireRole(),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await findOr404('departments', req.valid.params.id, { label: 'Department' });
    await query('DELETE FROM departments WHERE id = ?', [req.valid.params.id]);
    res.status(204).end();
  })
);

export default router;
