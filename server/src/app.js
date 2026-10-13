import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import { pingDb } from './db.js';
import { apiLimiter } from './middleware/rateLimits.js';
import { requireAuth, requireRole } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import authRouter from './routes/auth.js';
import departmentsRouter from './routes/departments.js';
import doctorsRouter from './routes/doctors.js';
import patientsRouter from './routes/patients.js';
import appointmentsRouter from './routes/appointments.js';
import bedsRouter from './routes/beds.js';
import admissionsRouter from './routes/admissions.js';
import billingRouter from './routes/billing.js';
import pharmacyRouter from './routes/pharmacy.js';
import labRouter from './routes/lab.js';
import dashboardRouter from './routes/dashboard.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.trustProxy);

  app.use(helmet());
  app.use(
    cors({
      origin(origin, cb) {
        // Same-origin / server-to-server requests have no Origin header.
        if (!origin || env.corsOrigins.includes(origin)) return cb(null, true);
        cb(null, false);
      },
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    })
  );
  app.use(morgan(env.isProd ? 'combined' : 'dev'));
  app.use(express.json({ limit: '200kb' }));

  app.get('/api/health', async (req, res) => {
    const db = await pingDb();
    res.status(db ? 200 : 503).json({ status: db ? 'ok' : 'degraded', db });
  });

  app.use('/api', apiLimiter);
  app.use('/api/auth', authRouter);

  // Everything below requires a valid token; per-module role gates, finer gates inside routers.
  app.use('/api', requireAuth);
  app.use('/api/departments', departmentsRouter);
  app.use('/api/doctors', doctorsRouter);
  app.use('/api/patients', patientsRouter);
  app.use('/api/appointments', requireRole('doctor', 'receptionist'), appointmentsRouter);
  app.use('/api/beds', requireRole('doctor', 'receptionist'), bedsRouter);
  app.use('/api/admissions', requireRole('doctor', 'receptionist', 'accountant'), admissionsRouter);
  app.use('/api/billing', requireRole('accountant', 'receptionist'), billingRouter);
  app.use('/api/pharmacy', requireRole('pharmacist', 'doctor'), pharmacyRouter);
  app.use('/api/lab', requireRole('labtech', 'doctor'), labRouter);
  app.use('/api/dashboard', dashboardRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
