'use strict';

/** Base API error. Services/repositories throw these; errorHandler renders them. */
class AppError extends Error {
    /**
     * @param {string} message Human-readable, actionable, 1-2 sentences.
     * @param {number} [statusCode=500]
     * @param {string} [code='INTERNAL_ERROR']
     * @param {*} [details]
     */
    constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details) {
        super(message);
        Object.assign(this, { name: this.constructor.name, statusCode, code, details });
    }
}

class ValidationError extends AppError {
    constructor(message, details, code = 'INPUT_INVALID') {
        super(message, 400, code, details);
    }
}

class AuthError extends AppError {
    constructor(message = 'Missing or invalid API key.', code = 'UNAUTHORIZED') {
        super(message, 401, code);
    }
}

class ForbiddenError extends AppError {
    constructor(message, code = 'FORBIDDEN', details) {
        super(message, 403, code, details);
    }
}

class NotFoundError extends AppError {
    constructor(message, code = 'NOT_FOUND') {
        super(message, 404, code);
    }
}

class ConflictError extends AppError {
    constructor(message, code = 'INVALID_STATE', details) {
        super(message, 409, code, details);
    }
}

class QuotaExceededError extends AppError {
    constructor(message, details, code = 'QUOTA_EXCEEDED') {
        super(message, 429, code, details);
    }
}

class UpstreamError extends AppError {
    constructor(message, details, code = 'CAPACITY_PAUSED') {
        super(message, 503, code, details);
    }
}

const PG_ERROR = Object.freeze({ UNIQUE: '23505', FOREIGN_KEY: '23503', NOT_NULL: '23502' });

/**
 * Map a Postgres constraint error to a typed AppError; anything else is returned unchanged.
 * @param {Error} error
 * @returns {Error}
 */
const mapDbError = (error) => {
    const pgCode = error && (error.parent || error.original || {}).code;
    if (pgCode === PG_ERROR.UNIQUE) return new ConflictError('The resource already exists.', 'CONFLICT');
    if (pgCode === PG_ERROR.FOREIGN_KEY) return new ValidationError('A referenced resource does not exist.');
    if (pgCode === PG_ERROR.NOT_NULL) return new ValidationError('A required field is missing.');
    return error;
};

module.exports = {
    AppError,
    ValidationError,
    AuthError,
    ForbiddenError,
    NotFoundError,
    ConflictError,
    QuotaExceededError,
    UpstreamError,
    mapDbError,
    PG_ERROR,
};
