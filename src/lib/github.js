// WebLab — GitHub client for the "Go" flow.
// Runs entirely in the browser. The user's GitHub token lives ONLY in localStorage.

const API = 'https://api.github.com';

function token() {
  return localStorage.getItem('weblab.gh.token');
}

export function hasToken() {
  return !!token();
}

export function setToken(t) {
  localStorage.setItem('weblab.gh.token', t.trim());
}

export function clearToken() {
  localStorage.removeItem('weblab.gh.token');
}

export function tokenInfo() {
  const t = token();
  if (!t) return { ok: false, error: 'No token stored.' };
  return { ok: true, prefix: t.slice(0, 4) + '…' + t.slice(-4) };
}

async function gh(method, path, body) {
  const t = token();
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${t}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'WebLab',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `GitHub ${res.status}`;
    try { const j = await res.json(); if (j.message) msg = j.message; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// Verify the token by loading the authenticated user.
export async function verifyToken() {
  const u = await gh('GET', '/user');
  return u.login;
}

// Find the "WebLab Inbox" repo we use as a bridge to the agent (Hermes).
export async function getInboxRepo() {
  const me = await gh('GET', '/user');
  const name = 'WebLab-Inbox';
  try {
    await gh('GET', `/repos/${me.login}/${name}`);
    return { owner: me.login, repo: name };
  } catch {
    // repo doesn't exist; create it (public so Pages works, empty otherwise)
    await gh('POST', '/user/repos', {
      name,
      description: 'WebLab build requests (agent bridge). Created automatically.',
      private: false,
      auto_init: true,
      has_issues: true,
      has_wiki: false,
    });
    return { owner: me.login, repo: name };
  }
}

// Submit a build request: create an issue in the Inbox repo with the full plan.
export async function submitBuildRequest(appName, specJson, specMarkdown) {
  const inbox = await getInboxRepo();
  const title = `[BUILD] ${appName}`;
  const body = [
    '**WebLab build request** — please build exactly this plan. **No code until Julian approves this spec** (Go = the spec is final).',
    '',
    '```json',
    specJson.slice(0, 12000),
    '```',
    '',
    '---',
    specMarkdown,
  ].join('\n');

  const issue = await gh('POST', `/repos/${inbox.owner}/${inbox.repo}/issues`, {
    title,
    body,
    labels: ['weblab-build'],
  });
  return { url: issue.html_url, number: issue.number };
}

// Poll a build request: look for the comment in `/weblab/status` on the issue.
export async function pollBuildStatus(owner, repo, issueNumber) {
  const comments = await gh('GET', `/repos/${owner}/${repo}/issues/${issueNumber}/comments`);
  const marker = comments.filter(c => c.body.startsWith('/weblab/status')).pop();
  if (!marker) return { state: 'queued', message: 'Waiting for the builder…' };
  const m = marker.body.match(/\/weblab\/status\n([\s\S]*)/);
  return { state: 'done', message: m ? m[1].trim() : 'Done.' };
}

// Get live status of an in-flight job by listing issues (for the Inbox repo).
export async function listBuildRequests() {
  const inbox = await getInboxRepo();
  const issues = await gh('GET', `/repos/${inbox.owner}/${inbox.repo}/issues?state=open`);
  return issues.map(i => ({
    number: i.number,
    title: i.title,
    url: i.html_url,
    createdAt: i.created_at,
    comments: i.comments,
  }));
}