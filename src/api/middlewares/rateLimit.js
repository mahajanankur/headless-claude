'use strict';

const config = require('../../../config');

const { AppError } = require('../../utils/AppError');
const { API_ERROR } = require('../../constants/apiErrors');

const WINDOW_MS = config.get('rateLimit.windowSec') * 1000;

/**
 * Fixed-window in-memory limiter (one API process). Sets RateLimit-* headers; 429 with Retry-After.
 * @param {{limit: number, keyFn: (req) => string}} options
 * @returns {Function} middleware
 */
const rateLimit = ({ limit, keyFn }) => {
    const buckets = new Map();
    const sweep = setInterval(() => {
        const now = Date.now();
        buckets.forEach((b, k) => b.resetAt <= now && buckets.delete(k));
    }, WINDOW_MS);
    sweep.unref();
    return (req, res, next) => {
        const key = keyFn(req);
        const now = Date.now();
        const bucket =
            buckets.get(key) && buckets.get(key).resetAt > now
                ? buckets.get(key)
                : { count: 0, resetAt: now + WINDOW_MS };
        bucket.count += 1;
        buckets.set(key, bucket);
        const resetSec = Math.ceil((bucket.resetAt - now) / 1000);
        res.set({
            'RateLimit-Limit': String(limit),
            'RateLimit-Remaining': String(Math.max(0, limit - bucket.count)),
            'RateLimit-Reset': String(resetSec),
        });
        if (bucket.count <= limit) return next();
        res.set('Retry-After', String(resetSec));
        return next(new AppError('Too many requests; slow down.', 429, API_ERROR.RATE_LIMITED));
    };
};

const perIp = rateLimit({ limit: config.get('rateLimit.perIp'), keyFn: (req) => `ip:${req.ip}` });
const perKey = rateLimit({ limit: config.get('rateLimit.perKey'), keyFn: (req) => `key:${req.context.keyId}` });

module.exports = { rateLimit, perIp, perKey };
