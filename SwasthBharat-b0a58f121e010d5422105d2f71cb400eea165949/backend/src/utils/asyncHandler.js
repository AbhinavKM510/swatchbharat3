/**
 * Wraps an async route handler so a rejected promise reaches Express's error handler.
 *
 * Express 4 does not await handlers, so without this an async throw becomes an
 * unhandled rejection and the request hangs until the client times out.
 */
export function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
