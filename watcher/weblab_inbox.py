#!/usr/bin/env python3
"""
WebLab Inbox Watcher — bridges WebLab (browser) with Hermes (this Mac).

How it works:
  - WebLab posts chat messages & build requests as comments on issues in
    the user's GitHub repo "WebLab-Inbox".
  - This script polls that inbox. When a NEW message from the user arrives,
    it prints it to stdout (so Hermes/cron can react) and marks it handled.
  - After Hermes builds an app (or replies), a publisher script posts the
    reply back (see publish_reply.py / CLI flags below).

Usage (watcher, poll once):
  python3 weblab_inbox.py check [--since-cursor FILE]
Usage (publish a reply):
  python3 weblab_inbox.py reply --issue N --role hermes --text "..."
Usage (publish build result):
  python3 weblab_inbox.py build --issue N --url https://... [--prompt "..."]
"""

import json, os, sys, urllib.request, urllib.error
from pathlib import Path

API = 'https://api.github.com'
REPO = 'WebLab-Inbox'

def token():
    # Prefer keychain via security(1) on macOS, fall back to env
    try:
        import subprocess
        p = subprocess.run(['security', 'find-internet-password', '-s', 'github.com', '-w'],
                           capture_output=True, text=True, timeout=10)
        if p.returncode == 0 and p.stdout.strip():
            return p.stdout.strip()
    except Exception:
        pass
    return os.environ.get('GITHUB_TOKEN', '')

def gh(method, path, body=None):
    t = token()
    if not t:
        raise RuntimeError('No GitHub token (keychain or GITHUB_TOKEN)')
    req = urllib.request.Request(API + path, method=method,
        headers={'Authorization': f'Bearer {t}', 'Accept': 'application/vnd.github+json',
                 'User-Agent': 'WebLab-Watcher', 'Content-Type': 'application/json'},
        data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: err = json.loads(raw)
        except Exception: err = {}
        raise RuntimeError(f'GitHub {e.code}: {err.get("message", raw[:200])}')

def ensure_inbox():
    me = gh('GET', '/user')
    login = me['login']
    full = f'{login}/{REPO}'
    try:
        gh('GET', f'/repos/{full}')
    except RuntimeError:
        gh('POST', '/user/repos', {
            'name': REPO, 'description': 'WebLab ↔ Hermes brainstorm bridge',
            'private': False, 'auto_init': True, 'has_issues': True, 'has_wiki': False})
    return full

def list_issues():
    full = ensure_inbox()
    return gh('GET', f'/repos/{full}/issues?state=open&per_page=30')

def list_comments(full, number):
    return gh('GET', f'/repos/{full}/issues/{number}/comments?per_page=100')

def cursor_path():
    return Path(os.environ.get('HERMES_HOME', str(Path.home() / '.hermes'))) / 'weblab_inbox.cursor.json'

def load_cursor():
    p = cursor_path()
    if p.exists():
        try: return json.loads(p.read_text())
        except Exception: pass
    return {}

def save_cursor(cursor):
    p = cursor_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cursor))

def check(show_all=False):
    cursor = load_cursor()
    full = ensure_inbox()
    new_found = False
    for issue in list_issues():
        number = issue['number']
        comments = list_comments(full, number)
        # Only consider comments after our cursor (or all if no cursor)
        for c in comments:
            key = str(c['id'])
            if key in cursor:
                continue
            cursor[key] = True
            body = c['body'] or ''
            first = body.split('\n')[0] or ''
            if first.startswith('/weblab/msg'):
                role = first.replace('/weblab/msg', '').strip()
                text = '\n'.join(body.split('\n')[1:]).strip()
                if role == 'user':
                    new_found = True
                    print(json.dumps({
                        'type': 'message', 'issue': number, 'url': issue['html_url'],
                        'title': issue['title'], 'text': text,
                    }))
            elif first.startswith('/weblab/build'):
                payload = body.replace('/weblab/build', '').strip()
                new_found = True
                print(json.dumps({
                    'type': 'build_request', 'issue': number, 'url': issue['html_url'],
                    'title': issue['title'], 'payload': payload,
                }))
    save_cursor(cursor)
    if not new_found and show_all:
        print('NO_NEW')
    return 0

def reply(issue, role, text):
    full = ensure_inbox()
    body = f'/weblab/msg {role}\n{text}'
    gh('POST', f'/repos/{full}/issues/{issue}/comments', {'body': body})
    print(f'Replied to issue {issue} as {role}')
    return 0

def build_result(issue, url, prompt=''):
    full = ensure_inbox()
    body = f'/weblab/build ' + json.dumps({'url': url, 'prompt': prompt[:2000]})
    gh('POST', f'/repos/{full}/issues/{issue}/comments', {'body': body})
    print(f'Posted build result to issue {issue}: {url}')
    return 0

def main():
    if len(sys.argv) < 2:
        print(__doc__); return 1
    cmd = sys.argv[1]
    try:
        if cmd == 'check':
            return check(show_all='--all' in sys.argv)
        if cmd == 'reply':
            issue = int(sys.argv[sys.argv.index('--issue') + 1])
            role = sys.argv[sys.argv.index('--role') + 1]
            text = sys.argv[sys.argv.index('--text') + 1]
            return reply(issue, role, text)
        if cmd == 'build':
            issue = int(sys.argv[sys.argv.index('--issue') + 1])
            url = sys.argv[sys.argv.index('--url') + 1]
            return build_result(issue, url)
        print('Unknown command', cmd); return 1
    except Exception as e:
        print(f'ERROR: {e}', file=sys.stderr)
        return 2

if __name__ == '__main__':
    sys.exit(main())