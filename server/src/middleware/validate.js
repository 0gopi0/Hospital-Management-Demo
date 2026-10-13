/**
 * Validates req[part] against a zod schema and stores the parsed result on
 * req.valid[part] (Express 5 makes req.query read-only, so we never overwrite).
 */
export const validate =
  (schema, part = 'body') =>
  (req, res, next) => {
    const result = schema.safeParse(req[part] ?? {});
    if (!result.success) return next(result.error);
    req.valid = { ...req.valid, [part]: result.data };
    next();
  };
