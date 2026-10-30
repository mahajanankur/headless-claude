'use strict';

const { Client } = require('pg');

const config = require('../../config');

/**
 * Session-level Postgres advisory locks on a dedicated connection, so a cron runs on one worker only.
 * The lock is held until release() or the connection drops (e.g. the worker dies).
 */
class AdvisoryLock {
    /**
     * @param {number} key
     * @param {{connectionString?: string}} [options] defaults to postgres.url
     */
    constructor(key, { connectionString = config.get('postgres.url') } = {}) {
        this.key = key;
        this.connectionString = connectionString;
        this.client = null;
        this.held = false;
    }

    /** @returns {Promise<boolean>} whether this process holds the lock */
    tryAcquire = async () => {
        if (this.held) return true;
        if (!this.client) {
            const client = new Client({ connectionString: this.connectionString });
            client.on('error', () => {
                this.held = false;
                this.client = null;
            });
            await client.connect(); // throws before caching, so the next tick reconnects
            this.client = client;
        }
        // raw because: advisory lock
        const { rows } = await this.client.query('SELECT pg_try_advisory_lock($1) AS ok', [this.key]);
        this.held = rows[0].ok;
        return this.held;
    };

    /** @returns {Promise<void>} */
    release = async () => {
        if (this.client) await this.client.end().catch(() => {});
        this.client = null;
        this.held = false;
    };
}

module.exports = { AdvisoryLock };
