import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { HttpError } from '../lib/httpError.js';

export const ROLES = ['admin', 'doctor', 'receptionist', 'pharmacist', 'labtech', 'accountant'];

export function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), email: user.email, name: user.name, role: user.role },
    env.jwt.secret,
    { expiresIn: env.jwt.expiresIn }
  );
}

/** Requires `Authorization: Bearer <jwt>`; sets req.user = { id, email, name, role }. */
export function requireAuth(req, res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(HttpError.unauthorized());
  try {
    const payload = jwt.verify(token, env.jwt.secret);
    req.user = { id: Number(payload.sub), email: payload.email, name: payload.name, role: payload.role };
    next();
  } catch {
    next(HttpError.unauthorized('Invalid or expired token'));
  }
}

/** Allows the listed roles (admin is always allowed). Use after requireAuth. */
export const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.user) return next(HttpError.unauthorized());
    if (req.user.role === 'admin' || roles.includes(req.user.role)) return next();
    next(HttpError.forbidden(`Requires role: ${['admin', ...roles].join(' | ')}`));
  };
