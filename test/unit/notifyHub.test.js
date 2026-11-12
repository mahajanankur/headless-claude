'use strict';

const { EventEmitter } = require('events');

const clients = [];

jest.mock('pg', () => {
    const { EventEmitter: Emitter } = require('events');
    class FakeClient extends Emitter {
        constructor(options) {
            super();
            this.options = options;
            this.ended = false;
            this.failConnect = FakeClient.nextConnectFails > 0;
            if (this.failConnect) FakeClient.nextConnectFails -= 1;
            clients.push(this);
        }

        connect = async () => {
            if (this.failConnect) throw new Error('sorry, too many clients already');
        };

        queries = [];

        query = async (sql) => {
            this.queries.push(sql);
            if (sql.startsWith('SET idle_session_timeout') && FakeClient.oldServer) {
                throw new Error('unrecognized configuration parameter "idle_session_timeout"');
            }
            return { rows: [] };
        };

        escapeIdentifier = (name) => `"${name}"`;

        end = async () => {
            this.ended = true;
        };
    }
    FakeClient.nextConnectFails = 0;
    FakeClient.oldServer = false;
    return { Client: FakeClient };
});
jest.mock('../../src/db/models', () => ({ sequelize: { query: jest.fn() } }));

const { Client } = require('pg');

const notifyHub = require('../../src/infra/notifyHub');

const flush = async () => {
    jest.advanceTimersByTime(5000);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('notifyHub reconnect', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        clients.length = 0;
        Client.nextConnectFails = 0;
        Client.oldServer = false;
    });

    afterEach(async () => {
        await notifyHub.stop();
        jest.useRealTimers();
    });

    it('opens one new connection when a dropped connection reports two errors', async () => {
        await notifyHub.start(['job_events']);
        expect(clients).toHaveLength(1);

        clients[0].emit('error', new Error('terminating connection due to idle-session timeout'));
        clients[0].emit('error', new Error('Connection terminated unexpectedly'));
        await flush();

        expect(clients).toHaveLength(2);
        expect(clients[0].ended).toBe(true);
    });

    it('closes a client whose connect failed and keeps a single retry going', async () => {
        await notifyHub.start(['job_events']);
        Client.nextConnectFails = 2;
        clients[0].emit('error', new Error('Connection terminated unexpectedly'));

        await flush();
        await flush();
        await flush();

        expect(clients).toHaveLength(4);
        expect(clients[1].ended).toBe(true);
        expect(clients[2].ended).toBe(true);
        expect(clients[3].ended).toBe(false);
    });

    it('turns off the idle-session timeout for its own LISTEN connection, without a startup option', async () => {
        await notifyHub.start(['job_events']);
        expect(clients[0].options.options).toBeUndefined();
        expect(clients[0].queries[0]).toBe('SET idle_session_timeout = 0');
        expect(clients[0].queries).toContain('LISTEN "job_events"');
    });

    it('still listens on a server without idle_session_timeout (Postgres 13, pgbouncer)', async () => {
        Client.oldServer = true;
        await notifyHub.start(['job_events']);
        expect(clients).toHaveLength(1);
        expect(clients[0].ended).toBe(false);
        expect(clients[0].queries).toContain('LISTEN "job_events"');
    });

    it('is an EventEmitter', () => {
        expect(notifyHub).toBeInstanceOf(EventEmitter);
    });
});
