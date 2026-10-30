'use strict';

const { runWithContext, getContext } = require('../../src/utils/requestContext');

describe('requestContext', () => {
    test('is empty outside a context', () => {
        expect(getContext()).toEqual({});
    });

    test('propagates across awaits and merges nested contexts', async () => {
        await runWithContext({ requestId: 'r1' }, async () => {
            await new Promise((resolve) => setImmediate(resolve));
            expect(getContext()).toEqual({ requestId: 'r1' });
            await runWithContext({ jobId: 'j1' }, async () => {
                expect(getContext()).toEqual({ requestId: 'r1', jobId: 'j1' });
            });
            expect(getContext()).toEqual({ requestId: 'r1' });
        });
    });
});
