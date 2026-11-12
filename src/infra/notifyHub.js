'use strict';

const { EventEmitter } = require('events');

const { Client } = require('pg');

const config = require('../../config');

const { sequelize } = require('../db/models');
const getLogger = require('../utils/logger');

const logger = getLogger(__filename);

/**
 * The LISTEN connection is idle by design, so a server-side idle_session_timeout must not kill it.
 * Set after connecting, not as a startup option: Postgres < 14 and poolers (pgbouncer) refuse unknown
 * startup parameters, which would make every connect fail. There the setting does not exist, so skip it.
 */
const disableIdleTimeout = async (client) => {
    try {
        // raw because: session setting on the dedicated LISTEN connection
        await client.query('SET idle_session_timeout = 0');
    } catch (error) {
        logger.debug(`idle_session_timeout not set on the LISTEN connection: ${error.message}`);
    }
};

const RECONNECT_DELAY_MS = 2000;

/**
 * One dedicated LISTEN connection per process, fanned out in memory (rules §1).
 * Publishing uses the regular pool (pg_notify), so it can run after a transaction commits.
 */
class NotifyHub extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(0);
        this.client = null;
        this.channels = new Set();
        this.closed = false;
        this.reconnecting = false;
    }

    /**
     * @param {string[]} channels
     * @returns {Promise<void>}
     */
    start = async (channels) => {
        const added = channels.filter((c) => !this.channels.has(c));
        added.forEach((c) => this.channels.add(c));
        this.closed = false;
        // A pending reconnect will LISTEN on every channel in the set, including the new ones.
        if (this.reconnecting) return;
        if (!this.client) {
            await this.connect();
            return;
        }
        for (const channel of added) {
            // raw because: LISTEN
            await this.client.query(`LISTEN ${this.client.escapeIdentifier(channel)}`);
        }
    };

    connect = async () => {
        const client = new Client({ connectionString: config.get('postgres.url') });
        client.on('notification', ({ channel, payload }) => this.dispatch(channel, payload));
        // pg can emit several errors for one dead connection; only the current client may trigger a reconnect.
        client.on('error', (error) => this.handleLost(client, error));
        try {
            await client.connect();
            await disableIdleTimeout(client);
            for (const channel of this.channels) {
                // raw because: LISTEN
                await client.query(`LISTEN ${client.escapeIdentifier(channel)}`);
            }
        } catch (error) {
            await client.end().catch(() => {});
            throw error;
        }
        if (this.closed) {
            await client.end().catch(() => {});
            return;
        }
        this.client = client;
    };

    handleLost = (client, error) => {
        if (client !== this.client) return;
        this.client = null;
        client.end().catch(() => {});
        this.reconnect(error);
    };

    dispatch = (channel, payload) => {
        try {
            this.emit(channel, payload ? JSON.parse(payload) : {});
        } catch (error) {
            logger.warn(`Ignoring malformed notification on ${channel}: ${error.message}`);
        }
    };

    reconnect = (error) => {
        if (this.closed || this.reconnecting) return;
        logger.warn(`LISTEN connection lost (${error.message}); reconnecting`);
        this.reconnecting = true;
        setTimeout(async () => {
            try {
                if (!this.closed) await this.connect();
                this.reconnecting = false;
            } catch (e) {
                this.reconnecting = false;
                this.reconnect(e);
            }
        }, RECONNECT_DELAY_MS).unref();
    };

    /**
     * @param {string} channel
     * @param {Object} payload small JSON (ids only, never content)
     * @returns {Promise<void>}
     */
    publish = async (channel, payload) => {
        // raw because: pg_notify
        await sequelize.query('SELECT pg_notify(:channel, :payload)', {
            replacements: { channel, payload: JSON.stringify(payload) },
        });
    };

    /** @returns {Promise<void>} */
    stop = async () => {
        this.closed = true;
        this.channels.clear();
        if (this.client) await this.client.end().catch(() => {});
        this.client = null;
    };
}

module.exports = new NotifyHub();
