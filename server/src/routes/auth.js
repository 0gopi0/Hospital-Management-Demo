import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/rateLimits.js';
import { validate } from '../middleware/validate.js';
import { HttpError } from '../lib/httpError.js';

const router = Router();

const loginSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1).max(200),
});

// Constant-time-ish failure path when the email is unknown.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

async function loadProfile(userId) {
  const [user] = await query(
    `SELECT u.id, u.name, u.email, u.role, u.is_active, u.last_login_at, d.id AS doctor_id
       FROM users u LEFT JOIN doctors d ON d.user_id = u.id WHERE u.id = ?`,
    [userId]
  );
  return user;
}

router.post(
  '/login',
  loginLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.valid.body;
    const [user] = await query('SELECT * FROM users WHERE email = ?', [email]);
    const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) throw HttpError.unauthorized('Invalid email or password');
    if (!user.is_active) throw HttpError.forbidden('Account is disabled');

    await query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
    res.json({ token: signToken(user), user: await loadProfile(user.id) });
  })
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await loadProfile(req.user.id);
    if (!user || !user.is_active) throw HttpError.unauthorized('Account no longer active');
    res.json({ user });
  })
);

export default router;
