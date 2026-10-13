/**
 * Seeds demo data for local development.
 *
 *   node scripts/seed.js
 *
 * Idempotent-ish: reference data (users, departments, patients, wards, beds, medicines,
 * lab tests) is upserted on its unique keys; doctors are matched by name; transactional
 * data (appointments, admission, bill, payment) is only inserted when those tables are empty.
 */
import bcrypt from 'bcryptjs';
import { pool, withTransaction } from '../src/db.js';
import { computeTotals, recalcBill, toCents, fromCents } from '../src/lib/billing.js';

const USERS = [
  { name: 'System Admin', email: 'admin@hosp.local', password: 'admin123!', role: 'admin' },
  { name: 'Dr. Arjun Mehta', email: 'doc.mehta@hosp.local', password: 'doc123!', role: 'doctor' },
  { name: 'Riya Sharma', email: 'recep@hosp.local', password: 'recep123!', role: 'receptionist' },
  { name: 'Karan Patel', email: 'pharm@hosp.local', password: 'pharm123!', role: 'pharmacist' },
  { name: 'Neha Iyer', email: 'lab@hosp.local', password: 'lab123!', role: 'labtech' },
  { name: 'Vikram Rao', email: 'acct@hosp.local', password: 'acct123!', role: 'accountant' },
];

const DEPARTMENTS = [
  { name: 'Cardiology', description: 'Heart and vascular care' },
  { name: 'Orthopedics', description: 'Bones, joints and musculoskeletal care' },
  { name: 'General', description: 'General medicine and outpatient care' },
];

// First doctor is linked to the doc.mehta user account.
const DOCTORS = [
  { name: 'Dr. Arjun Mehta', dept: 'Cardiology', specialization: 'Interventional Cardiology', phone: '9800000001', email: 'doc.mehta@hosp.local', fee: 800, userEmail: 'doc.mehta@hosp.local' },
  { name: 'Dr. Sunita Kapoor', dept: 'Cardiology', specialization: 'Electrophysiology', phone: '9800000002', email: 'sunita.kapoor@hosp.local', fee: 900 },
  { name: 'Dr. Rahul Verma', dept: 'Orthopedics', specialization: 'Joint Replacement', phone: '9800000003', email: 'rahul.verma@hosp.local', fee: 700 },
  { name: 'Dr. Priya Nair', dept: 'Orthopedics', specialization: 'Sports Medicine', phone: '9800000004', email: 'priya.nair@hosp.local', fee: 650 },
  { name: 'Dr. Amit Joshi', dept: 'General', specialization: 'Internal Medicine', phone: '9800000005', email: 'amit.joshi@hosp.local', fee: 400 },
];

const PATIENTS = [
  ['Aarav', 'Gupta', '1985-03-12', 'male', 'B+'],
  ['Diya', 'Singh', '1992-07-25', 'female', 'O+'],
  ['Rohan', 'Das', '1978-11-02', 'male', 'A+'],
  ['Ananya', 'Reddy', '2001-01-19', 'female', 'AB+'],
  ['Kabir', 'Khan', '1965-05-30', 'male', 'O-'],
  ['Isha', 'Menon', '1999-09-09', 'female', 'B-'],
  ['Vivaan', 'Bose', '1988-12-15', 'male', 'A-'],
  ['Meera', 'Pillai', '1972-04-04', 'female', 'O+'],
  ['Aditya', 'Kulkarni', '1995-08-21', 'male', 'B+'],
  ['Saanvi', 'Chopra', '2010-02-14', 'female', 'A+'],
].map(([first_name, last_name, dob, gender, blood_group], i) => ({
  mrn: `MRN-${String(i + 1).padStart(4, '0')}`,
  first_name,
  last_name,
  dob,
  gender,
  blood_group,
  phone: `91000000${String(i + 1).padStart(2, '0')}`,
  email: `${first_name.toLowerCase()}.${last_name.toLowerCase()}@example.com`,
}));

const WARDS = [
  { name: 'General', type: 'general', floor: '1', beds: 6, prefix: 'G', rate: 1500 },
  { name: 'ICU', type: 'icu', floor: '2', beds: 4, prefix: 'ICU', rate: 6000 },
];

const MEDICINES = [
  { sku: 'MED-PARA-500', name: 'Paracetamol 500mg', generic_name: 'Paracetamol', form: 'tablet', strength: '500mg', unit_price: 2, stock_qty: 500, reorder_level: 50, batch_no: 'PCM2401', expiry_date: '2028-01-01' },
  { sku: 'MED-AMOX-250', name: 'Amoxicillin 250mg', generic_name: 'Amoxicillin', form: 'capsule', strength: '250mg', unit_price: 6.5, stock_qty: 8, reorder_level: 20, batch_no: 'AMX2405', expiry_date: '2027-06-01' },
  { sku: 'MED-EXPIRED', name: 'ExpiredDrug', generic_name: 'Expired', form: 'tablet', strength: '10mg', unit_price: 1, stock_qty: 100, reorder_level: 10, batch_no: 'EXP1901', expiry_date: '2020-01-01' },
];

const LAB_TESTS = [
  { code: 'CBC', name: 'Complete Blood Count', sample_type: 'blood', unit: 'g/dL', reference_range: '12-17 (Hb)', critical_low: 7, critical_high: 20, price: 350 },
  { code: 'BSUGAR', name: 'Blood Sugar (Fasting)', sample_type: 'blood', unit: 'mg/dL', reference_range: '70-100', critical_low: 40, critical_high: 400, price: 150 },
  { code: 'XRAY-CHEST', name: 'X-Ray Chest', sample_type: 'imaging', unit: null, reference_range: null, critical_low: null, critical_high: null, price: 600 },
  { code: 'ECG', name: 'ECG', sample_type: 'none', unit: null, reference_range: null, critical_low: null, critical_high: null, price: 300 },
];

const DAY = 24 * 60 * 60_000;

/** A slot later today (UTC) that is still in the future, so markNoShows() leaves it alone. */
function laterToday() {
  const now = new Date();
  const endOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 0));
  const start = new Date(Math.min(now.getTime() + 60 * 60_000, endOfDay.getTime() - 30 * 60_000));
  start.setUTCSeconds(0, 0);
  const end = new Date(Math.min(start.getTime() + 30 * 60_000, endOfDay.getTime()));
  return [start, end];
}

/** A fixed hour/minute (UTC) on a day offset from today. */
function at(dayOffset, hour, minute = 0) {
  const d = new Date(Date.now() + dayOffset * DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute));
}

const plus = (date, minutes) => new Date(date.getTime() + minutes * 60_000);

async function seedUsers(conn) {
  const ids = {};
  for (const u of USERS) {
    const hash = await bcrypt.hash(u.password, 10);
    await conn.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), password_hash = VALUES(password_hash), role = VALUES(role), is_active = 1`,
      [u.name, u.email, hash, u.role]
    );
    const [[row]] = await conn.query('SELECT id FROM users WHERE email = ?', [u.email]);
    ids[u.email] = row.id;
  }
  return ids;
}

async function seedDepartments(conn) {
  const ids = {};
  for (const d of DEPARTMENTS) {
    await conn.query(
      'INSERT INTO departments (name, description) VALUES (?, ?) ON DUPLICATE KEY UPDATE description = VALUES(description)',
      [d.name, d.description]
    );
    const [[row]] = await conn.query('SELECT id FROM departments WHERE name = ?', [d.name]);
    ids[d.name] = row.id;
  }
  return ids;
}

async function seedDoctors(conn, userIds, deptIds) {
  const ids = [];
  for (const d of DOCTORS) {
    const userId = d.userEmail ? userIds[d.userEmail] : null;
    const values = [userId, deptIds[d.dept], d.specialization, d.phone, d.email, d.fee];
    const [[existing]] = await conn.query('SELECT id FROM doctors WHERE name = ? LIMIT 1', [d.name]);
    if (existing) {
      await conn.query(
        `UPDATE doctors SET user_id = ?, department_id = ?, specialization = ?, phone = ?, email = ?, consultation_fee = ?
          WHERE id = ?`,
        [...values, existing.id]
      );
      ids.push(existing.id);
    } else {
      const [r] = await conn.query(
        `INSERT INTO doctors (user_id, department_id, specialization, phone, email, consultation_fee, name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [...values, d.name]
      );
      ids.push(r.insertId);
    }
  }
  return ids;
}

async function seedPatients(conn) {
  const ids = [];
  for (const p of PATIENTS) {
    await conn.query(
      `INSERT INTO patients (mrn, first_name, last_name, dob, gender, phone, email, blood_group)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE first_name = VALUES(first_name), last_name = VALUES(last_name), phone = VALUES(phone)`,
      [p.mrn, p.first_name, p.last_name, p.dob, p.gender, p.phone, p.email, p.blood_group]
    );
    const [[row]] = await conn.query('SELECT id FROM patients WHERE mrn = ?', [p.mrn]);
    ids.push(row.id);
  }
  return ids;
}

/** Returns bed ids per ward name, in bed-number order. */
async function seedWardsAndBeds(conn) {
  const beds = {};
  for (const w of WARDS) {
    await conn.query(
      'INSERT INTO wards (name, type, floor) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE type = VALUES(type), floor = VALUES(floor)',
      [w.name, w.type, w.floor]
    );
    const [[ward]] = await conn.query('SELECT id FROM wards WHERE name = ?', [w.name]);
    beds[w.name] = [];
    for (let i = 1; i <= w.beds; i += 1) {
      const bedNumber = `${w.prefix}-${String(i).padStart(2, '0')}`;
      await conn.query(
        'INSERT INTO beds (ward_id, bed_number, daily_rate) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE daily_rate = VALUES(daily_rate)',
        [ward.id, bedNumber, w.rate]
      );
      const [[bed]] = await conn.query('SELECT id FROM beds WHERE ward_id = ? AND bed_number = ?', [ward.id, bedNumber]);
      beds[w.name].push(bed.id);
    }
  }
  return beds;
}

async function seedMedicines(conn) {
  for (const m of MEDICINES) {
    await conn.query(
      `INSERT INTO medicines (sku, name, generic_name, form, strength, unit_price, stock_qty, reorder_level, batch_no, expiry_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), stock_qty = VALUES(stock_qty),
         reorder_level = VALUES(reorder_level), expiry_date = VALUES(expiry_date)`,
      [m.sku, m.name, m.generic_name, m.form, m.strength, m.unit_price, m.stock_qty, m.reorder_level, m.batch_no, m.expiry_date]
    );
  }
}

async function seedLabTests(conn) {
  for (const t of LAB_TESTS) {
    await conn.query(
      `INSERT INTO lab_tests (code, name, sample_type, unit, reference_range, critical_low, critical_high, price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), price = VALUES(price)`,
      [t.code, t.name, t.sample_type, t.unit, t.reference_range, t.critical_low, t.critical_high, t.price]
    );
  }
}

async function isEmpty(conn, table) {
  const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
  return n === 0;
}

async function seedAppointments(conn, patientIds, doctorIds, createdBy) {
  if (!(await isEmpty(conn, 'appointments'))) return 'skipped (table not empty)';
  const [todayStart, todayEnd] = laterToday();
  const rows = [
    // 1 today, scheduled (still in the future so it is not auto-marked no_show)
    [patientIds[1], doctorIds[0], todayStart, todayEnd, 'scheduled', 'Chest pain follow-up'],
    // 1 completed (yesterday)
    [patientIds[2], doctorIds[2], at(-1, 4, 30), at(-1, 5, 0), 'completed', 'Knee pain'],
    [patientIds[3], doctorIds[4], at(1, 5, 0), at(1, 5, 30), 'scheduled', 'Fever and cough'],
    [patientIds[4], doctorIds[1], at(2, 6, 0), at(2, 6, 30), 'scheduled', 'Palpitations'],
    [patientIds[5], doctorIds[3], at(-3, 7, 0), at(-3, 7, 30), 'cancelled', 'Sports injury review'],
  ];
  for (const [p, d, s, e, status, reason] of rows) {
    await conn.query(
      `INSERT INTO appointments (patient_id, doctor_id, starts_at, ends_at, status, reason, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [p, d, s, e, status, reason, createdBy]
    );
  }
  return `${rows.length} inserted`;
}

async function seedAdmissionAndBill(conn, patientId, bedId, doctorId, createdBy) {
  if (!(await isEmpty(conn, 'admissions'))) return 'skipped (table not empty)';
  const admittedAt = at(-2, 4, 0);
  const [adm] = await conn.query(
    `INSERT INTO admissions (patient_id, bed_id, doctor_id, admitted_at, status, reason, created_by)
     VALUES (?, ?, ?, ?, 'admitted', ?, ?)`,
    [patientId, bedId, doctorId, admittedAt, 'Observation for unstable angina', createdBy]
  );
  await conn.query("UPDATE beds SET status = 'occupied' WHERE id = ?", [bedId]);

  const [[bed]] = await conn.query('SELECT daily_rate FROM beds WHERE id = ?', [bedId]);
  const [[doc]] = await conn.query('SELECT consultation_fee FROM doctors WHERE id = ?', [doctorId]);
  const items = [
    { item_type: 'bed', description: 'ICU bed charges (2 days)', quantity: 2, unit_price: bed.daily_rate },
    { item_type: 'consultation', description: 'Cardiology consultation', quantity: 1, unit_price: doc.consultation_fee },
  ];
  const discount = 500;
  const taxRate = 5;
  const t = computeTotals(items, { discount, taxRate });

  const [bill] = await conn.query(
    `INSERT INTO bills (bill_number, patient_id, admission_id, discount, tax_rate, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [`TMP-${adm.insertId}`, patientId, adm.insertId, discount, taxRate, 'Interim bill', createdBy]
  );
  const billId = bill.insertId;
  await conn.query('UPDATE bills SET bill_number = ? WHERE id = ?', [
    `INV-${new Date().getUTCFullYear()}-${String(billId).padStart(6, '0')}`, billId,
  ]);
  for (const l of t.lines) {
    await conn.query(
      'INSERT INTO bill_items (bill_id, item_type, description, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?)',
      [billId, l.item_type, l.description, l.quantity, l.unit_price, l.amount]
    );
  }
  const paid = fromCents(Math.round(toCents(t.total) * 0.4));
  await conn.query(
    `INSERT INTO payments (bill_id, kind, amount, method, reference, notes, created_by)
     VALUES (?, 'payment', ?, 'upi', 'UPI-SEED-0001', 'Advance (40%)', ?)`,
    [billId, paid, createdBy]
  );
  const result = await recalcBill(conn, billId);
  return `admission #${adm.insertId}, bill #${billId} subtotal=${result.subtotal} discount=${result.discount} tax=${result.tax} total=${result.total} paid=${result.paid} balance=${result.balance} status=${result.status}`;
}

async function main() {
  const summary = await withTransaction(async (conn) => {
    const userIds = await seedUsers(conn);
    const deptIds = await seedDepartments(conn);
    const doctorIds = await seedDoctors(conn, userIds, deptIds);
    const patientIds = await seedPatients(conn);
    const beds = await seedWardsAndBeds(conn);
    await seedMedicines(conn);
    await seedLabTests(conn);
    const adminId = userIds['admin@hosp.local'];
    const appts = await seedAppointments(conn, patientIds, doctorIds, userIds['recep@hosp.local']);
    const admission = await seedAdmissionAndBill(conn, patientIds[0], beds.ICU[0], doctorIds[0], adminId);
    return {
      users: Object.keys(userIds).length,
      departments: Object.keys(deptIds).length,
      doctors: doctorIds.length,
      patients: patientIds.length,
      beds: Object.values(beds).flat().length,
      medicines: MEDICINES.length,
      labTests: LAB_TESTS.length,
      appointments: appts,
      admission,
    };
  });
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(12)} ${v}`);
  console.log('Seed complete.');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
