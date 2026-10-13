export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }

  static badRequest(message = 'Bad request', details) {
    return new HttpError(400, message, details);
  }

  static unauthorized(message = 'Authentication required') {
    return new HttpError(401, message);
  }

  static paymentRequired(message = 'Payment required', details) {
    return new HttpError(402, message, details);
  }

  static forbidden(message = 'You do not have permission to perform this action') {
    return new HttpError(403, message);
  }

  static notFound(message = 'Not found') {
    return new HttpError(404, message);
  }

  static conflict(message = 'Conflict', details) {
    return new HttpError(409, message, details);
  }
}
