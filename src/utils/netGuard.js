'use strict';

const dns = require('dns').promises;
const net = require('net');

const PRIVATE_V4 = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
];

const v4ToInt = (ip) => ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;

const inV4Range = (ip, [base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
};

/**
 * Expand an IPv6 address (any notation, including an embedded dotted IPv4 tail) to 16 bytes.
 * @param {string} ip
 * @returns {number[]|null}
 */
const ipv6Bytes = (ip) => {
    let text = ip.toLowerCase().split('%')[0];
    const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (dotted) {
        const v4 = dotted[1].split('.').map(Number);
        text = `${text.slice(0, -dotted[1].length)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
    }
    const [head, tail] = text.split('::');
    const parse = (part) => (part ? part.split(':') : []);
    const left = parse(head);
    const right = tail === undefined ? [] : parse(tail);
    const fill = tail === undefined ? [] : Array(8 - left.length - right.length).fill('0');
    const groups = [...left, ...fill, ...right];
    if (groups.length !== 8) return null;
    return groups.flatMap((g) => {
        const n = parseInt(g, 16);
        return [(n >> 8) & 0xff, n & 0xff];
    });
};

const v4From = (bytes, offset) => bytes.slice(offset, offset + 4).join('.');
const startsWith = (bytes, prefix) => prefix.every((b, i) => bytes[i] === b);
const allZero = (bytes, from, to) => bytes.slice(from, to).every((b) => b === 0);

/** IPv4 address embedded in an IPv6 one (mapped, compatible, NAT64, 6to4), or null. */
const embeddedV4 = (bytes) => {
    if (allZero(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return v4From(bytes, 12); // ::ffff:a.b.c.d
    if (allZero(bytes, 0, 12) && !allZero(bytes, 12, 15)) return v4From(bytes, 12); // ::a.b.c.d (deprecated)
    if (startsWith(bytes, [0x00, 0x64, 0xff, 0x9b]) && allZero(bytes, 4, 12)) return v4From(bytes, 12); // 64:ff9b::/96
    if (startsWith(bytes, [0x20, 0x02])) return v4From(bytes, 2); // 2002::/16 (6to4)
    return null;
};

const isPrivateV6 = (bytes) =>
    allZero(bytes, 0, 15) || // :: and ::1
    (bytes[0] & 0xfe) === 0xfc || // fc00::/7 unique local
    (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) || // fe80::/10 link local
    bytes[0] === 0xff || // multicast
    startsWith(bytes, [0x20, 0x01, 0x0d, 0xb8]) || // documentation
    (startsWith(bytes, [0x01, 0x00]) && allZero(bytes, 2, 8)); // 100::/64 discard

/**
 * Is this IP loopback, private, link-local, CGNAT, multicast or reserved? IPv6 addresses that embed an
 * IPv4 address are judged by that address.
 * @param {string} ip
 * @returns {boolean}
 */
const isPrivateAddress = (ip) => {
    if (net.isIPv4(ip)) return PRIVATE_V4.some((range) => inV4Range(ip, range));
    if (!net.isIPv6(ip)) return true;
    const bytes = ipv6Bytes(ip);
    if (!bytes) return true;
    const v4 = embeddedV4(bytes);
    return v4 ? isPrivateAddress(v4) : isPrivateV6(bytes);
};

/**
 * Validate an outbound URL: https (http only when private hosts are allowed), host on the
 * allow-list, and every resolved address public unless allowPrivate.
 * @param {string} rawUrl
 * @param {{allowedHosts: string[], allowPrivate?: boolean, lookup?: Function}} options
 * @returns {Promise<URL>}
 * @throws {Error} with a user-safe message
 */
const assertSafeOutboundUrl = async (rawUrl, { allowedHosts, allowPrivate = false, lookup = dns.lookup }) => {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error('URL is not valid.');
    }
    if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:'))
        throw new Error('URL must use https.');
    if (url.username || url.password) throw new Error('URL must not contain credentials.');
    if (!allowedHosts.includes(url.hostname)) throw new Error(`Host ${url.hostname} is not on this app's allow-list.`);
    if (!allowPrivate) {
        const addresses = await lookup(url.hostname, { all: true });
        if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
            throw new Error('URL resolves to a private or reserved address.');
        }
    }
    return url;
};

module.exports = { isPrivateAddress, assertSafeOutboundUrl };
