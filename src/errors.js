export class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function invalid(message) {
  return new AppError('invalid_input', message, 400);
}

export function conflict(message, code = 'intent_conflict') {
  return new AppError(code, message, 409);
}

export function notFound(message = 'resource not found') {
  return new AppError('not_found', message, 404);
}

export function unavailable(message = 'durable authority unavailable') {
  return new AppError('authority_unavailable', message, 503);
}
