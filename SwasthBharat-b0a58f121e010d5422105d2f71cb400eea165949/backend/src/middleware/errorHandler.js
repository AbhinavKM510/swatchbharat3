/**
 * Central error handling.
 *
 * Every failure leaves as `{ error: { code, message, details? } }` so the translated
 * frontend can switch on `code` and render its own language. Stack traces are logged,
 * never returned.
 */

import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

export function notFoundHandler(req, _res, next) {
  next(ApiError.notFound('ROUTE_NOT_FOUND', `No route for ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity
export function errorHandler(error, req, res, next) {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong on the server';
  let details;

  if (error instanceof ApiError) {
    status = error.status;
    code = error.code;
    message = error.message;
    details = error.details;
  } else if (error?.code === 'VALIDATION_FAILED' && Array.isArray(error.validationErrors)) {
    // Thrown by the shared risk engine.
    status = 400;
    code = 'VALIDATION_FAILED';
    message = 'Some values are missing or out of range';
    details = { fields: error.validationErrors };
  } else if (error instanceof mongoose.Error.ValidationError) {
    status = 400;
    code = 'VALIDATION_FAILED';
    message = 'Some values are missing or out of range';
    details = {
      fields: Object.entries(error.errors).map(([field, err]) => ({
        field,
        code: 'INVALID',
        i18nKey: 'validation.invalid',
        message: err.message,
      })),
    };
  } else if (error instanceof mongoose.Error.CastError) {
    status = 400;
    code = 'INVALID_ID';
    message = `"${error.value}" is not a valid identifier`;
  } else if (error?.code === 11000) {
    // Duplicate key. On sync paths this is expected and handled upstream; reaching here
    // means a genuinely conflicting create.
    status = 409;
    code = 'DUPLICATE_KEY';
    message = 'A record with this identifier already exists';
    details = { keys: Object.keys(error.keyPattern || {}) };
  } else if (error?.type === 'entity.parse.failed') {
    status = 400;
    code = 'MALFORMED_JSON';
    message = 'Request body is not valid JSON';
  }

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, error);
  } else if (!config.isProduction) {
    console.warn(`[${status}] ${req.method} ${req.originalUrl} -> ${code}: ${message}`);
  }

  res.status(status).json({
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  });
}
