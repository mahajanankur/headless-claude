'use strict';

const fs = require('fs');
const path = require('path');

const config = require('../../config');
const { PATHS } = require('../../config/paths');

const { listRegularFiles, readFileInside } = require('../utils/safeFs');
const { sha256 } = require('../utils/hash');

const MAX_ARTIFACT_BYTES = config.get('job.maxArtifactBytes');
const MAX_FILES = 200;

const MIME = Object.freeze({
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.patch': 'text/x-diff',
    '.diff': 'text/x-diff',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
});

const artifactDir = (jobId) => path.join(PATHS.dataDir, 'artifacts', jobId);

/**
 * Store one buffer as an artifact file and return its row (without job/app ids).
 * @param {string} jobId
 * @param {string} name
 * @param {Buffer} content
 * @returns {{name: string, path: string, size: number, mime: string, sha256: string}}
 */
const storeArtifact = (jobId, name, content) => {
    const dir = artifactDir(jobId);
    fs.mkdirSync(dir, { recursive: true });
    const safeName = name.replace(/[^A-Za-z0-9._/-]/g, '_').replace(/\.\.+/g, '_');
    const target = path.join(dir, safeName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return {
        name: safeName,
        path: target,
        size: content.length,
        mime: MIME[path.extname(safeName).toLowerCase()] || 'application/octet-stream',
        sha256: sha256(content),
    };
};

/**
 * Copy regular files from ws/out into the artifact store. Symlinks, oversized files and anything
 * outside the workspace are skipped (output is untrusted, rules §11).
 * @param {string} jobId
 * @param {string} wsDir
 * @returns {{artifacts: Object[], skipped: string[]}}
 */
const collectOutputs = (jobId, wsDir) => {
    const files = listRegularFiles(wsDir, 'out').slice(0, MAX_FILES);
    const artifacts = [];
    const skipped = [];
    for (const rel of files) {
        try {
            artifacts.push(storeArtifact(jobId, rel, readFileInside(wsDir, path.join('out', rel), MAX_ARTIFACT_BYTES)));
        } catch (error) {
            skipped.push(`${rel}: ${error.message}`);
        }
    }
    return { artifacts, skipped };
};

/** @param {string} jobId @returns {void} */
const removeArtifacts = (jobId) => fs.rmSync(artifactDir(jobId), { recursive: true, force: true });

module.exports = { storeArtifact, collectOutputs, removeArtifacts };
