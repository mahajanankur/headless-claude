'use strict';

const config = require('../../../config');

const API = config.get('git.githubApiUrl');

/**
 * owner/repo from a GitHub https URL, or null for other hosts.
 * @param {string} repoUrl
 * @returns {{owner: string, repo: string}|null}
 */
const parseGithubRepo = (repoUrl) => {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repoUrl);
    return match ? { owner: match[1], repo: match[2] } : null;
};

const request = async ({ fetchImpl, method, url, token, body }) => {
    const res = await fetchImpl(url, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'headless-claude',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
        throw new Error(`GitHub ${method} ${new URL(url).pathname} → ${res.status}: ${data.message || ''}`.trim());
    return data;
};

/**
 * Open a pull request, or return the existing open one for the branch (idempotent).
 * @param {{repoUrl: string, head: string, base: string, title: string, body: string, token: string, fetchImpl?: Function}} options
 * @returns {Promise<string>} the PR html_url
 * @throws {Error} for non-GitHub repositories or API failures
 */
const ensurePullRequest = async ({ repoUrl, head, base, title, body, token, fetchImpl = fetch }) => {
    const gh = parseGithubRepo(repoUrl);
    if (!gh) throw new Error('Pull requests are supported for github.com repositories only.');
    const prefix = `${API}/repos/${gh.owner}/${gh.repo}/pulls`;
    const existing = await request(
        fetchImpl,
        'GET',
        `${prefix}?state=open&head=${encodeURIComponent(`${gh.owner}:${head}`)}`,
        token,
    );
    if (Array.isArray(existing) && existing.length) return existing[0].html_url;
    const created = await request({ fetchImpl, method: 'POST', url: prefix, token, body: { title, head, base, body } });
    return created.html_url;
};

module.exports = { parseGithubRepo, ensurePullRequest };
