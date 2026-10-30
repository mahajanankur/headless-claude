'use strict';

const {
    AppError,
    ValidationError,
    NotFoundError,
    ConflictError,
    QuotaExceededError,
    mapDbError,
    PG_ERROR,
} = require('../../src/utils/AppError');

describe('AppError family', () => {
    test('carries status, code and name', () => {
        const e = new NotFoundError('Job not found.', 'JOB_NOT_FOUND');
        expect(e).toBeInstanceOf(AppError);
        expect(e.statusCode).toBe(404);
        expect(e.code).toBe('JOB_NOT_FOUND');
        expect(e.name).toBe('NotFoundError');
    });

    test('defaults', () => {
        expect(new AppError('x').statusCode).toBe(500);
        expect(new ValidationError('x').statusCode).toBe(400);
        expect(new QuotaExceededError('x', { resetsAt: 'r' }).details).toEqual({ resetsAt: 'r' });
    });

    test('mapDbError maps constraint codes and passes others through', () => {
        const pg = (code) => Object.assign(new Error('db'), { parent: { code } });
        expect(mapDbError(pg(PG_ERROR.UNIQUE))).toBeInstanceOf(ConflictError);
        expect(mapDbError(pg(PG_ERROR.FOREIGN_KEY))).toBeInstanceOf(ValidationError);
        expect(mapDbError(pg(PG_ERROR.NOT_NULL))).toBeInstanceOf(ValidationError);
        const other = new Error('boom');
        expect(mapDbError(other)).toBe(other);
    });
});
