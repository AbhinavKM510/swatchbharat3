/**
 * Error type carrying an HTTP status and a machine-readable code.
 *
 * The `code` matters more than the message here: the frontend is translated into three
 * languages, so it keys off codes and renders its own text. Messages are for logs.
 */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code   SCREAMING_SNAKE_CASE, stable across releases
   * @param {string} message
   * @param {object} [details] extra payload, e.g. per-field validation errors
   */
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(code, message, details) {
    return new ApiError(400, code, message, details);
  }

  static unauthorized(code = 'UNAUTHORIZED', message = 'Authentication required') {
    return new ApiError(401, code, message);
  }

  static forbidden(code = 'FORBIDDEN', message = 'You do not have access to this resource') {
    return new ApiError(403, code, message);
  }

  static notFound(code = 'NOT_FOUND', message = 'Resource not found') {
    return new ApiError(404, code, message);
  }

  static conflict(code, message, details) {
    return new ApiError(409, code, message, details);
  }

  /**
   * The feature exists in the code but is not enabled on this server.
   *
   * Distinct from 404 on purpose: 501 tells a client "this endpoint is real, this
   * deployment has not configured it", which is the honest answer for an optional
   * integration such as Firebase phone sign-in. A 404 would suggest the client had the
   * wrong URL and send whoever is debugging in the wrong direction.
   */
  static notImplemented(code = 'NOT_IMPLEMENTED', message = 'This feature is not enabled on this server') {
    return new ApiError(501, code, message);
  }
}
