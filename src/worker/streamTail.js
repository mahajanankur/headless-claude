'use strict';

const fs = require('fs');

const CHUNK_BYTES = 1024 * 1024;

/**
 * Read complete lines appended after `offset`. A trailing partial line is left for the next read.
 * Lines longer than maxLineBytes are skipped (counted in `skipped`).
 * @param {string} file
 * @param {number} offset byte offset already consumed
 * @param {number} maxLineBytes
 * @returns {{lines: string[], offset: number, skipped: number}}
 */
const readNewLines = (file, offset, maxLineBytes) => {
    if (!fs.existsSync(file)) return { lines: [], offset, skipped: 0 };
    const size = fs.statSync(file).size;
    if (size <= offset) return { lines: [], offset, skipped: 0 };
    const length = Math.min(size - offset, CHUNK_BYTES + maxLineBytes);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try {
        fs.readSync(fd, buffer, 0, length, offset);
    } finally {
        fs.closeSync(fd);
    }
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline === -1) {
        // one oversized line with no end yet: skip it once it exceeds the cap
        return length >= maxLineBytes
            ? { lines: [], offset: offset + length, skipped: 1 }
            : { lines: [], offset, skipped: 0 };
    }
    const parts = buffer.subarray(0, lastNewline).toString('utf8').split('\n');
    const lines = parts.filter((l) => l.length > 0 && Buffer.byteLength(l) <= maxLineBytes);
    return {
        lines,
        offset: offset + lastNewline + 1,
        skipped: parts.filter((l) => Buffer.byteLength(l) > maxLineBytes).length,
    };
};

module.exports = { readNewLines };
