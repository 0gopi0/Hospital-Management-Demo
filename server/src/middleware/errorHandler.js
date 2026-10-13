import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { HttpError } from '../lib/httpError.js';

export function notFound(req, res, next) {
  next(HttpError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
}

// MySQL/MariaDB errors that map to client errors rather than 500s.
const DB_ERRORS = {
  ER_DUP_ENTRY: [409, 'Duplicate value violates a unique constraint'],
  ER_ROW_IS_REFERENCED_2: [409, 'Record is referenced by other records and cannot be deleted'],
  ER_NO_REFERENCED_ROW_2: [400, 'Referenced record does not exist'],
  ER_LOCK_DEADLOCK: [409, 'Concurrent update detected, please retry'],
  ER_LOCK_WAIT_TIMEOUT: [409, 'Record is busy, please retry'],
};

/** Central error handler — always responds with { error: { message, details? } }. */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let status = 500;
  let message = 'Internal server error';
  let details;

  if (err instanceof ZodError) {
    status = 400;
    message = 'Validation failed';
    details = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
  } else if (err instanceof HttpError) {
    status = err.status;
    message = err.message;
    details = err.details;
  } else if (DB_ERRORS[err?.code]) {
    [status, message] = DB_ERRORS[err.code];
    if (!env.isProd) details = { cause: err.sqlMessage };
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    message = 'Malformed JSON body';
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    message = 'Request body too large';
  }

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    if (!env.isProd && err?.message) details = { cause: err.message };
  }

  res.status(status).json({ error: details === undefined ? { message } : { message, details } });
}
