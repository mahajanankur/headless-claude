'use strict';

const { validateSchema, schemaError } = require('../../src/utils/jsonSchema');

describe('jsonSchema', () => {
    test('validates and reports paths', () => {
        const schema = { type: 'object', required: ['a'], properties: { a: { type: 'number' } } };
        expect(validateSchema(schema, { a: 1 })).toEqual({ valid: true, errors: [] });
        expect(validateSchema(schema, { a: 'x' }).errors[0].path).toBe('/a');
        expect(validateSchema(null, 'anything').valid).toBe(true);
    });

    test('a schema with $id can be validated from fresh copies (as read from the DB)', () => {
        const copy = () => ({ $id: 'https://example.com/s', type: 'object' });
        expect(validateSchema(copy(), {}).valid).toBe(true);
        expect(() => validateSchema(copy(), {})).not.toThrow();
        expect(validateSchema(copy(), 1).valid).toBe(false);
    });

    test('schemaError reports uncompilable schemas', () => {
        expect(schemaError({ type: 'object' })).toBeNull();
        expect(schemaError({ type: 'objekt' })).toMatch(/type/);
        expect(schemaError({ $ref: '#/definitions/missing' })).toMatch(/resolve|missing/i);
    });
});
