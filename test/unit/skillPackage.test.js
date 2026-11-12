'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const tar = require('tar');

const { pack, unpack, isAllowedPath, PackageError } = require('../../src/utils/skillPackage');

const LIMITS = { maxUnpackedBytes: 100000, maxFiles: 20 };

/** Build a gzipped tar from raw entries, so tests can create archives tar.c would refuse to make. */
const rawArchive = (entries) => {
    const blocks = [];
    entries.forEach(({ path: entryPath, type = 'File', body = '', linkpath }) => {
        const data = Buffer.from(body);
        const header = new tar.Header({
            path: entryPath,
            type,
            size: type === 'File' ? data.length : 0,
            mode: 0o644,
            linkpath,
        });
        header.encode();
        blocks.push(header.block);
        if (type === 'File' && data.length) {
            const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
            data.copy(padded);
            blocks.push(padded);
        }
    });
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
};

describe('skillPackage', () => {
    let root;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-pkg-'));
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    const makeSkill = () => {
        const dir = path.join(root, 'src');
        fs.mkdirSync(path.join(dir, '.claude/skills/demo/references'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), '{"name":"demo"}');
        fs.writeFileSync(path.join(dir, '.claude/skills/demo/SKILL.md'), 'Do it.');
        fs.writeFileSync(path.join(dir, '.claude/skills/demo/references/a.md'), 'ref');
        fs.writeFileSync(path.join(dir, 'README.md'), 'not packed');
        return dir;
    };

    it('round-trips a skill folder and leaves out files outside manifest.json and .claude', async () => {
        const out = path.join(root, 'out');
        await unpack(await pack(makeSkill()), out, LIMITS);
        expect(fs.readFileSync(path.join(out, '.claude/skills/demo/references/a.md'), 'utf8')).toBe('ref');
        expect(fs.existsSync(path.join(out, 'README.md'))).toBe(false);
    });

    it('normalises modes: no executables or setuid bits survive', async () => {
        const dir = makeSkill();
        fs.chmodSync(path.join(dir, '.claude/skills/demo/SKILL.md'), 0o4755);
        const out = path.join(root, 'out');
        await unpack(await pack(dir), out, LIMITS);
        expect(fs.statSync(path.join(out, '.claude/skills/demo/SKILL.md')).mode & 0o7777).toBe(0o644);
    });

    it.each([
        ['a symlink', [{ path: '.claude/link', type: 'SymbolicLink', linkpath: '/etc/passwd' }], 'SymbolicLink'],
        ['a hard link', [{ path: '.claude/hard', type: 'Link', linkpath: 'manifest.json' }], 'Link'],
        ['a parent path', [{ path: '.claude/../../escape.txt', body: 'x' }], 'only manifest.json'],
        ['a file outside .claude', [{ path: 'run.sh', body: 'x' }], 'only manifest.json'],
    ])('rejects %s', async (label, entries, reason) => {
        const out = path.join(root, 'out');
        await expect(unpack(rawArchive(entries), out, LIMITS)).rejects.toThrow(reason);
        expect(fs.existsSync(path.join(root, 'escape.txt'))).toBe(false);
    });

    it('rejects more files than allowed', async () => {
        const entries = Array.from({ length: 4 }, (_, i) => ({ path: `.claude/f${i}.md`, body: 'x' }));
        await expect(unpack(rawArchive(entries), path.join(root, 'out'), { ...LIMITS, maxFiles: 3 })).rejects.toThrow(
            'more than 3 files',
        );
    });

    it('rejects a gzip bomb before writing it', async () => {
        const bomb = zlib.gzipSync(Buffer.alloc(5 * 1024 * 1024));
        await expect(unpack(bomb, path.join(root, 'out'), LIMITS)).rejects.toThrow(PackageError);
    });

    it('rejects something that is not gzip', async () => {
        await expect(unpack(Buffer.from('nope'), path.join(root, 'out'), LIMITS)).rejects.toThrow('not a valid gzip');
    });

    it.each([
        ['manifest.json', true],
        ['./manifest.json', true],
        ['.claude/skills/x/SKILL.md', true],
        ['/etc/passwd', false],
        ['.claude/../x', false],
        ['other.txt', false],
        ['.claudex/a', false],
    ])('isAllowedPath(%s) is %s', (p, expected) => {
        expect(isAllowedPath(p)).toBe(expected);
    });
});
