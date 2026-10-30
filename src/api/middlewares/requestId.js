'use strict';

const crypto = require('crypto');

const { runWithContext } = require('../../utils/requestContext');

const VALID = /^[A-Za-z0-9._-]{8,64}$/;

/** Accept a well-formed X-Request-Id or generate one; attach it to the response and every log line. */
const requestId = (req, res, next) => {
    const incoming = req.get('X-Request-Id');
    const id = incoming && VALID.test(incoming) ? incoming : crypto.randomUUID();
    req.context = { requestId: id };
    res.set('X-Request-Id', id);
    runWithContext({ requestId: id }, next);
};

module.exports = { requestId };
