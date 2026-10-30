'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { backoffSec } = require('../../src/utils/backoff');
const {
    resolveInside,
    readFileInside,
    listRegularFiles,
    writeFileAtomic,
    chownTree,
} = require('../../src/utils/safeFs');
const { encryptSecret, decryptSecret } = require('../../src/utils/encryption');
const { isPrivateAddress, assertSafeOutboundUrl } = require('../../src/utils/netGuard');

describe('backoffSec', () => {
    test('grows exponentially within [cap/2, cap] and respects max', () => {
        expect(backoffSec(1, { baseSec: 10, maxSec: 100, random: () => 0 })).toBe(5);
        expect(backoffSec(3, { baseSec: 10, maxSec: 100, random: () => 1 })).toBe(40);
        expect(backoffSec(10, { baseSec: 10, maxSec: 100, random: () => 1 })).toBe(100);
        expect(backoffSec(5, { baseSec: 0, maxSec: 100 })).toBe(0);
    });
});

describe('safeFs', () => {
    let root;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-safefs-'));
        fs.mkdirSync(path.join(root, 'out'));
        fs.writeFileSync(path.join(root, 'out', 'a.txt'), 'hello');
        fs.writeFileSync(path.join(os.tmpdir(), 'gw-secret.txt'), 'secret');
        fs.symlinkSync(path.join(os.tmpdir(), 'gw-secret.txt'), path.join(root, 'out', 'link.txt'));
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    test('reads regular files and caps size', () => {
        expect(readFileInside(root, 'out/a.txt', 10).toString()).toBe('hello');
        expect(() => readFileInside(root, 'out/a.txt', 2)).toThrow(/exceeds/);
        expect(readFileInside(root, 'out/missing.txt', 10)).toBeNull();
    });

    test('refuses symlinks and escapes', () => {
        expect(() => readFileInside(root, 'out/link.txt', 100)).toThrow(/Symlinks/);
        expect(() => resolveInside(root, '../etc/passwd')).toThrow(/escapes/);
    });

    test('lists regular files only', () => {
        expect(listRegularFiles(root, 'out')).toEqual(['a.txt']);
        expect(listRegularFiles(root, 'nope')).toEqual([]);
    });

    test('writeFileAtomic replaces content', () => {
        const f = path.join(root, 'x.json');
        writeFileAtomic(f, '1');
        writeFileAtomic(f, '2');
        expect(fs.readFileSync(f, 'utf8')).toBe('2');
    });

    test('chownTree changes the whole tree without following symlinks', () => {
        const spy = jest.spyOn(fs, 'lchownSync').mockImplementation(() => {});
        try {
            chownTree(root, 1000, 1000);
            const touched = spy.mock.calls.map(([p]) => path.relative(root, p)).sort();
            expect(touched).toEqual(['', 'out', 'out/a.txt', 'out/link.txt']);
            expect(spy.mock.calls.every(([, uid, gid]) => uid === 1000 && gid === 1000)).toBe(true);
        } finally {
            spy.mockRestore();
        }
    });
});

describe('encryption', () => {
    const key = 'ab'.repeat(32);
    test('round-trips and detects tampering or a wrong key', () => {
        const enc = encryptSecret('webhook-secret', key);
        expect(decryptSecret(enc, key)).toBe('webhook-secret');
        expect(() => decryptSecret(enc, 'cd'.repeat(32))).toThrow();
        const last = enc.slice(-1);
        const tampered = enc.slice(0, -1) + (last === 'A' ? 'B' : 'A'); // always a different character
        expect(() => decryptSecret(tampered, key)).toThrow();
        expect(() => encryptSecret('x', 'short')).toThrow(/32 bytes/);
    });
});

describe('netGuard', () => {
    test.each([
        ['127.0.0.1', true],
        ['10.1.2.3', true],
        ['172.20.0.1', true],
        ['192.168.1.1', true],
        ['169.254.169.254', true],
        ['100.64.0.1', true],
        ['8.8.8.8', false],
        ['::1', true],
        ['fd00::1', true],
        ['::ffff:127.0.0.1', true],
        ['2606:4700::1111', false],
        ['::ffff:7f00:1', true],
        ['::ffff:a9fe:a9fe', true],
        ['64:ff9b::a9fe:a9fe', true],
        ['2002:a9fe:a9fe::1', true],
        ['::127.0.0.1', true],
        ['fe80::1', true],
        ['ff02::1', true],
        ['::ffff:8.8.8.8', false],
        ['64:ff9b::808:808', false],
        ['not-an-ip', true],
    ])('isPrivateAddress(%s) → %s', (ip, expected) => expect(isPrivateAddress(ip)).toBe(expected));

    const lookup = (map) => async (host) => map[host].map((address) => ({ address }));

    test('accepts an allow-listed public https host', async () => {
        await expect(
            assertSafeOutboundUrl('https://hooks.example.com/x', {
                allowedHosts: ['hooks.example.com'],
                lookup: lookup({ 'hooks.example.com': ['8.8.8.8'] }),
            }),
        ).resolves.toBeInstanceOf(URL);
    });

    test.each([
        ['http://hooks.example.com/x', /https/],
        ['https://other.example.com/x', /allow-list/],
        ['https://u:p@hooks.example.com/x', /credentials/],
        ['not a url', /not valid/],
    ])('rejects %s', async (url, message) => {
        await expect(
            assertSafeOutboundUrl(url, { allowedHosts: ['hooks.example.com'], lookup: lookup({}) }),
        ).rejects.toThrow(message);
    });

    test('rejects hosts that resolve to private addresses (DNS rebinding)', async () => {
        await expect(
            assertSafeOutboundUrl('https://hooks.example.com/x', {
                allowedHosts: ['hooks.example.com'],
                lookup: lookup({ 'hooks.example.com': ['8.8.8.8', '10.0.0.5'] }),
            }),
        ).rejects.toThrow(/private/);
    });
});
