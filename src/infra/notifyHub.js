'use strict';

const { EventEmitter } = require('events');

const { Client } = require('pg');

const config = require('../../config');

const { sequelize } = require('../db/models');
const getLogger = require('../utils/logger');

const logger = getLogger(__filename);

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
    }

    /**
     * @param {string[]} channels
     * @returns {Promise<void>}
     */
    start = async (channels) => {
        const added = channels.filter((c) => !this.channels.has(c));
        added.forEach((c) => this.channels.add(c));
        this.closed = false;
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
        client.on('error', (error) => this.reconnect(error));
        await client.connect();
        for (const channel of this.channels) {
            // raw because: LISTEN
            await client.query(`LISTEN ${client.escapeIdentifier(channel)}`);
        }
        this.client = client;
    };

    dispatch = (channel, payload) => {
        try {
            this.emit(channel, payload ? JSON.parse(payload) : {});
        } catch (error) {
            logger.warn(`Ignoring malformed notification on ${channel}: ${error.message}`);
        }
    };

    reconnect = (error) => {
        if (this.closed) return;
        logger.warn(`LISTEN connection lost (${error.message}); reconnecting`);
        this.client = null;
        setTimeout(() => {
            if (!this.closed) this.connect().catch((e) => this.reconnect(e));
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
