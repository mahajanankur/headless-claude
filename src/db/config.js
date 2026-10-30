'use strict';

// Database settings for sequelize-cli (migrations). Same source as the app.
const config = require('../../config');

const base = { url: config.get('postgres.url'), dialect: 'postgres', logging: false };

module.exports = { development: base, test: base, production: base };
