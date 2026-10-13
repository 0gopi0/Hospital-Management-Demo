import { Router } from 'express';
import { pool, query } from '../db.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { markNoShows } from './appointments.js';

const router = Router();

const num = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v ?? 0)]));

router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    await markNoShows();
    const one = async (sql) => num((await pool.query(sql))[0][0]);

    const [patients, appts, beds, admissions, billing, pharmacy, lab, upcoming] = await Promise.all([
      one(`SELECT COUNT(*) AS total, SUM(created_at >= CURDATE()) AS new_today FROM patients`),
      one(`SELECT COUNT(*) AS today,
                  SUM(status = 'scheduled') AS scheduled, SUM(status = 'completed') AS completed,
                  SUM(status = 'cancelled') AS cancelled, SUM(status = 'no_show') AS no_show
             FROM appointments WHERE starts_at >= CURDATE() AND starts_at < CURDATE() + INTERVAL 1 DAY`),
      one(`SELECT COUNT(*) AS total, SUM(status = 'available') AS available,
                  SUM(status = 'occupied') AS occupied, SUM(status = 'maintenance') AS maintenance FROM beds`),
      one(`SELECT SUM(status = 'admitted') AS current,
                  SUM(admitted_at >= CURDATE()) AS admitted_today,
                  SUM(discharged_at >= CURDATE()) AS discharged_today FROM admissions`),
      one(`SELECT
             (SELECT COALESCE(SUM(balance), 0) FROM bills WHERE status IN ('unpaid', 'partial')) AS outstanding,
             (SELECT COUNT(*) FROM bills WHERE status IN ('unpaid', 'partial')) AS open_bills,
             (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE created_at >= CURDATE()) AS collected_today,
             (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')) AS collected_month`),
      one(`SELECT SUM(stock_qty <= reorder_level) AS low_stock, SUM(expiry_date < CURDATE()) AS expired,
                  SUM(expiry_date BETWEEN CURDATE() AND CURDATE() + INTERVAL 30 DAY) AS expiring_30d,
                  (SELECT COUNT(*) FROM prescriptions WHERE status = 'pending') AS pending_prescriptions
             FROM medicines`),
      one(`SELECT SUM(status = 'registered') AS registered, SUM(status = 'collected') AS collected,
                  SUM(status = 'resulted' AND resulted_at >= CURDATE()) AS resulted_today,
                  SUM(is_critical = 1 AND resulted_at >= NOW() - INTERVAL 7 DAY) AS critical_7d
             FROM lab_orders`),
      query(`SELECT a.id, a.starts_at, a.ends_at, CONCAT(p.first_name, ' ', p.last_name) AS patient_name, d.name AS doctor_name
               FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN doctors d ON d.id = a.doctor_id
              WHERE a.status = 'scheduled' AND a.starts_at >= NOW() ORDER BY a.starts_at LIMIT 5`),
    ]);

    res.json({
      generatedAt: new Date(),
      patients,
      appointmentsToday: appts,
      beds: { ...beds, occupancyPct: beds.total ? Math.round((beds.occupied / beds.total) * 100) : 0 },
      admissions,
      billing,
      pharmacy,
      lab,
      upcomingAppointments: upcoming,
    });
  })
);

export default router;
