'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const manifestSchema = require('../schemas/skillManifest.schema.json');
const { validateSchema, schemaError } = require('../utils/jsonSchema');
const {
    SKILL_CLASS,
    CHANGE_MODE,
    CREDENTIAL_PROFILE,
    BARE_FILE_TOOLS,
    RESERVED_SKILL_NAMES,
    FORBIDDEN_TOOLS,
} = require('../constants/skill');

/**
 * Values applied when a manifest omits a field (mirrors the schema defaults).
 * Returned fresh on every call so no two manifests share an array or object.
 * @returns {Object}
 */
const manifestDefaults = () => ({
    class: SKILL_CLASS.QUICK,
    defaultModel: 'sonnet',
    timeoutSec: 900,
    maxTurns: 40,
    credentialProfile: CREDENTIAL_PROFILE.MAX_SUBSCRIPTION,
    allowedTools: [],
    disallowedTools: [],
    env: {},
    uses: [],
    mcpServers: {},
    network: { allowedHosts: [] },
    repo: null,
    changes: CHANGE_MODE.NONE,
    edits: false,
    rerunSafe: false,
    keepWorkspaceOnRetry: false,
    logContent: false,
    runWindows: null,
});

const withDefaults = (manifest) => {
    const defaults = manifestDefaults();
    return { ...defaults, ...manifest, network: { ...defaults.network, ...(manifest.network || {}) } };
};

const readManifest = (file) => {
    try {
        return { raw: fs.readFileSync(file, 'utf8') };
    } catch (error) {
        return {
            error: error.code === 'ENOENT' ? 'manifest.json missing' : `manifest.json unreadable: ${error.message}`,
        };
    }
};

const parseManifest = (raw) => {
    try {
        return { manifest: JSON.parse(raw) };
    } catch (error) {
        return { error: `manifest.json is not valid JSON: ${error.message}` };
    }
};

/** Tool family of a permission rule: 'Bash(git diff:*)' → 'Bash'. */
const toolFamily = (rule) => String(rule).split('(')[0];

/** SKILL.md must not grant tools itself: grants belong in the manifest (a skill's allowed-tools bypass it). */
const MAX_INSTRUCTIONS_CHARS = 20000;

/**
 * SKILL.md body without its frontmatter: the instructions the gateway injects into every run.
 * @param {string} text
 * @returns {string}
 */
const instructionsFrom = (text) => text.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();

const skillMdError = (skillMdPath) => {
    const text = fs.readFileSync(skillMdPath, 'utf8');
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text);
    if (frontmatter && /^\s*allowed[-_]?tools\s*:/im.test(frontmatter[1])) {
        return 'SKILL.md must not declare allowed-tools; grant tools in manifest.json allowedTools';
    }
    const body = instructionsFrom(text);
    if (!body) return 'SKILL.md has no instructions';
    if (body.length > MAX_INSTRUCTIONS_CHARS)
        return `SKILL.md instructions exceed ${MAX_INSTRUCTIONS_CHARS} characters`;
    return null;
};

const checkManifest = (name, manifest, skillMdPath) => {
    const { valid, errors } = validateSchema(manifestSchema, manifest);
    if (!valid) return `manifest invalid: ${errors.map((e) => `${e.path} ${e.message}`).join('; ')}`;
    if (manifest.name !== name) return `manifest name '${manifest.name}' does not match folder '${name}'`;
    if (RESERVED_SKILL_NAMES.includes(name))
        return `name '${name}' is a Claude Code built-in command; choose another name`;
    const forbidden = (manifest.allowedTools || []).filter((t) => FORBIDDEN_TOOLS.includes(toolFamily(t)));
    if (forbidden.length) return `allowedTools must not contain ${forbidden.join(', ')}`;
    const bare = (manifest.allowedTools || []).filter((t) => BARE_FILE_TOOLS.includes(t));
    if (bare.length) return `allowedTools must not contain bare file tools (${bare.join(', ')})`;
    for (const key of ['inputSchema', 'outputSchema']) {
        const compileError = manifest[key] && schemaError(manifest[key]);
        if (compileError) return `${key} is not a valid JSON schema: ${compileError}`;
    }
    if (!fs.existsSync(skillMdPath)) return `missing .claude/skills/${name}/SKILL.md`;
    return skillMdError(skillMdPath);
};

const listFilesRecursive = (dir, base = dir) =>
    fs
        .readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap((entry) => {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) return listFilesRecursive(full, base);
            return entry.isFile() ? [path.relative(base, full)] : [];
        });

/**
 * Content checksum over every regular file in the skill folder (path and content, length-prefixed
 * so file boundaries are unambiguous). Any change to a script or reference changes the checksum.
 * @param {string} dir
 * @returns {string}
 */
const checksumFolder = (dir) => {
    const hash = crypto.createHash('sha256');
    listFilesRecursive(dir).forEach((rel) => {
        const content = fs.readFileSync(path.join(dir, rel));
        hash.update(`${rel.length}:${rel}${content.length}:`).update(content);
    });
    return hash.digest('hex');
};

/**
 * Read and validate one skill folder. Filesystem only; no database.
 * @param {string} dir absolute skill folder; its basename is the skill name
 * @returns {{name: string, manifest?: Object, checksum?: string, error?: string}}
 */
const readSkillFolder = (dir) => {
    const name = path.basename(dir);
    const skillMdPath = path.join(dir, '.claude', 'skills', name, 'SKILL.md');
    const { raw, error: readError } = readManifest(path.join(dir, 'manifest.json'));
    if (readError) return { name, error: readError };
    const { manifest, error: parseError } = parseManifest(raw);
    if (parseError) return { name, error: parseError };
    const error = checkManifest(name, manifest, skillMdPath);
    if (error) return { name, error };
    const instructions = instructionsFrom(fs.readFileSync(skillMdPath, 'utf8'));
    return { name, manifest: { ...withDefaults(manifest), instructions }, checksum: checksumFolder(dir) };
};

/**
 * Absolute paths of every skill folder in a directory (missing directory → []).
 * @param {string} skillsDir
 * @returns {string[]}
 */
const listSkillFolders = (skillsDir) => {
    if (!fs.existsSync(skillsDir)) return [];
    return fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(skillsDir, d.name))
        .sort();
};

module.exports = { readSkillFolder, listSkillFolders, manifestDefaults, toolFamily, instructionsFrom };
