// WebLab v2 — GitHub "Inbox" client.
// WebLab talks to Hermes through a small GitHub repo of issues.
// Everything runs in the browser; the user's token stays in localStorage.

const API = 'https://api.github.com'
const INBOX_REPO = 'WebLab-Inbox'

function token() { return localStorage.getItem('weblab.gh.token') }
export const hasToken = () => !!token()
export function setToken(t) { localStorage.setItem('weblab.gh.token', t.trim()) }
export function clearToken() { localStorage.removeItem('weblab.gh.token') }
export function tokenPreview() {
  const t = token(); if (!t) return ''
  return t.slice(0, 4) + '…' + t.slice(-4)
}

async function gh(method, path, body) {
  const t = token()
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${t}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'WebLab',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = `GitHub ${res.status}`
    try { const j = await res.json(); if (j.message) msg = j.message } catch {}
    throw new Error(msg)
  }
  return res.json()
}

// Verify token and return login.
export async function verifyToken() {
  const u = await gh('GET', '/user')
  return u.login
}

// Ensure the Inbox repo exists (use existing, don't try to create if exists).
export async function ensureInbox() {
  const me = await verifyToken()
  const full = `${me.login}/${INBOX_REPO}`
  try {
    await gh('GET', `/repos/${full}`)
    return full
  } catch (e) {
    // Only create if it truly doesn't exist (404)
    if (e.message.includes('404') || e.message.includes('Not Found')) {
      await gh('POST', '/user/repos', {
        name: INBOX_REPO,
        description: 'WebLab <-> Hermes brainstorm bridge (issues are conversations).',
        private: false, auto_init: true, has_issues: true, has_wiki: false,
      })
      return full
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// Project = an Issue. Chat messages = issue comments.
// Message framing: each comment body starts with a "frame" line.
//   /weblab/msg <role>   — a chat message (user or hermes)
//   /weblab/build <json> — final build request (contains prompt)
//   /weblab/status <text> — builder status update (Hermes -> WebLab)
// ---------------------------------------------------------------------------

export async function openProjectIssue(project, prompt) {
  const full = await ensureInbox()
  const title = `[WEBLAB] ${project.name || 'Untitled Project'}`
  const body = [
    '/weblab/project',
    'name: ' + (project.name || 'Untitled'),
    'id: ' + project.id,
    'idea: ' + (project.idea || '').slice(0, 500),
    '',
    '--- Live prompt (grows as we talk) ---',
    '```',
    (prompt || '').slice(0, 3000),
    '```',
  ].join('\n')
  const issue = await gh('POST', `/repos/${full}/issues`, { title, body })
  return { owner: full.split('/')[0], repo: INBOX_REPO, number: issue.number, url: issue.html_url }
}

// Fetch comments on an issue, undecoded into chat-ish messages.
export async function fetchComments(owner, repo, number) {
  const list = await gh('GET', `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`)
  return list.map(c => ({ id: c.id, user: c.user.login, body: c.body, createdAt: c.created_at }))
}

// Parse a comment body into a structured message.
export function parseComment(body) {
  const first = body.split('\n')[0] || ''
  if (first.startsWith('/weblab/msg ')) {
    const role = first.replace('/weblab/msg ', '').trim()
    const text = body.split('\n').slice(1).join('\n').trim()
    // Check for embedded action data (JSON after a marker)
    let actions = null
    const actionMatch = text.match(/\/weblab\/action\s+(\{[\s\S]*\})/)
    if (actionMatch) {
      try { actions = JSON.parse(actionMatch[1]) } catch {}
    }
    return { kind: 'msg', role, text: text.replace(/\/weblab\/action\s+\{[\s\S]*\}/, '').trim(), actions }
  }
  if (first.startsWith('/weblab/status ')) {
    const text = body.replace('/weblab/status ', '').trim()
    return { kind: 'status', text }
  }
  if (first.startsWith('/weblab/build ')) {
    let text = body.replace('/weblab/build ', '').trim()
    let json = {}
    try { json = JSON.parse(text) } catch {}
    return { kind: 'build', text, json }
  }
  return { kind: 'raw', text: body }
}

// Helper for Hermes to post a message with category-fill actions.
export function formatHermesMessage(text, actions) {
  const actionStr = actions ? '\n/weblab/action ' + JSON.stringify(actions) : ''
  return '/weblab/msg hermes\n' + text + actionStr
}

// Helper for build request with full prompt.
export function formatBuildRequest(prompt, name) {
  return '/weblab/build ' + JSON.stringify({ prompt, name })
}

// Post a user chat message to the issue.
export async function postMessage(owner, repo, number, text) {
  const body = '/weblab/msg user\n' + text
  return gh('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { body })
}

// For the very first send: create the issue with the initial user message folded in.
export async function createAndPost(project, prompt, firstText) {
  const full = await ensureInbox()
  const owner = full.split('/')[0]
  const issue = await openProjectIssue(project, prompt)
  if (firstText) await postMessage(owner, INBOX_REPO, issue.number, firstText)
  return issue
}

// List open inbox issues (for the watcher/browser status).
export async function listOpenIssues() {
  const full = await ensureInbox()
  const issues = await gh('GET', `/repos/${full}/issues?state=open&per_page=30`)
  return issues.map(i => ({ number: i.number, title: i.title, url: i.html_url, comments: i.comments }))
}