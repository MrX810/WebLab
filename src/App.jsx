// WebLab v2 — Prompt Studio.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  CATEGORIES, buildPrompt, promptSummary, generateSuggestions, applySuggestion,
  loadProjects, saveProjects, newProject, uid,
} from './lib/weblab.js'
import * as gh from './lib/github.js'

// ---------------------------------------------------------------------------
// App shell: login + project list
// ---------------------------------------------------------------------------

const LS_AUTH = 'weblab.auth.v2'
const LS_PASS = 'weblab.pass.v2'

async function hash(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('weblab::' + s))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export default function App() {
  const [authed, setAuthed] = useState(() => localStorage.getItem(LS_AUTH) === '1')
  const [projects, setProjects] = useState([])
  const [activeId, setActiveId] = useState(null)

  useEffect(() => {
    if (authed) setProjects(loadProjects())
  }, [authed])

  if (!authed) return <LoginGate onDone={() => { setAuthed(true); setProjects(loadProjects()) }} />

  const active = projects.find(p => p.id === activeId) || null

  return (
    <div className="app">
      {active ? (
        <Studio key={active.id}
          project={active}
          onBack={() => setActiveId(null)}
          onProjectChange={p => setProjects(ps => { const next = ps.map(x => x.id === p.id ? p : x); saveProjects(next); return next })}
          onDelete={() => { if (confirm('Projekt löschen?')) { setProjects(ps => { const next = ps.filter(x => x.id !== active.id); saveProjects(next); return next }); setActiveId(null) } }}
        />
      ) : (
        <Home projects={projects}
          onOpen={setActiveId}
          onCreate={() => { const p = newProject(`App ${projects.length + 1}`); setProjects(ps => { const next = [...ps, p]; saveProjects(next); return next }); setActiveId(p.id) }}
          onDelete={id => { if (confirm('Projekt löschen?')) setProjects(ps => { const next = ps.filter(x => x.id !== id); saveProjects(next); return next }) }}
          onLogout={() => { localStorage.removeItem(LS_AUTH); setAuthed(false) }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Login (single access code)
// ---------------------------------------------------------------------------

function LoginGate({ onDone }) {
  const [pass, setPass] = useState('')
  const [err, setErr] = useState('')
  const [mode, setMode] = useState(() => localStorage.getItem(LS_PASS) ? 'entry' : 'create')

  async function submit(e) {
    e.preventDefault()
    if (mode === 'create') {
      if (pass.length < 4) { setErr('Mindestens 4 Zeichen.'); return }
      localStorage.setItem(LS_PASS, await hash(pass))
      localStorage.setItem(LS_AUTH, '1')
      onDone()
    } else {
      const stored = localStorage.getItem(LS_PASS)
      if (!stored) { setMode('create'); return }
      if (await hash(pass) === stored) { localStorage.setItem(LS_AUTH, '1'); onDone() }
      else setErr('Falscher Code. Nochmal?')
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="logo">WebLab</div>
        <p className="sub">
          {mode === 'create'
            ? 'Lege deinen persönlichen Zugangscode fest — er entsperrt WebLab in diesem Browser.'
            : 'Gib deinen Zugangscode ein.'}
        </p>
        <form onSubmit={submit}>
          <input type="password" autoFocus value={pass} onChange={e => setPass(e.target.value)}
            placeholder={mode === 'create' ? 'Neuer Zugangscode' : 'Zugangscode'} />
          <button type="submit" className="primary">{mode === 'create' ? 'Code setzen & starten' : 'Oeffnen'}</button>
        </form>
        {err && <div className="err">{err}</div>}
        <div className="hint">Daten bleiben nur in diesem Browser.</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Home: project list
// ---------------------------------------------------------------------------

function Home({ projects, onOpen, onCreate, onDelete, onLogout }) {
  return (
    <div className="home">
      <div className="home-top">
        <div className="logo">WebLab</div>
        <button className="ghost" onClick={onLogout}>Log out</button>
      </div>
      <div className="home-body">
        <div className="home-hero">
          <h1>Dein Webapp-Prompt-Studio</h1>
          <p>Brainstorme mit Hermes und destilliere daraus den perfekten Build-Prompt. Code entsteht erst nach deinem Go.</p>
        </div>
        <div className="board-grid">
          {projects.map(p => (
            <div key={p.id} className="board-card" onClick={() => onOpen(p.id)}>
              <div className="board-card-name">{p.name}</div>
              <div className="board-card-meta">
                {p.status === 'live' ? <span className="badge ok">live</span>
                  : p.status === 'building' ? <span className="badge busy">building</span>
                  : <span className="badge draft">draft</span>}
                {p.liveUrl && <a href={p.liveUrl} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>{p.liveUrl.replace('https://','')}</a>}
              </div>
              <div className="board-card-desc">{promptSummary(p) || 'Noch keine Idee…'}</div>
              <button className="del" onClick={e => { e.stopPropagation(); onDelete(p.id) }}>x</button>
            </div>
          ))}
          <div className="board-card new" onClick={onCreate}>+ Neues Projekt</div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Studio: visual brainstorm chat + growing prompt + checklist
// ---------------------------------------------------------------------------

function Studio({ project, onBack, onProjectChange, onDelete }) {
  const [local, setLocal] = useState(project)
  const [chat, setChat] = useState([])          // rendered messages
  const [input, setInput] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [ghState, setGhState] = useState(() => localStorage.getItem('weblab.gh.token') ? 'ready' : 'idle')
  const [ghErr, setGhErr] = useState('')
  const [inbox, setInbox] = useState(null)       // { owner, repo, number, url }
  const [sending, setSending] = useState(false)
  const [goState, setGoState] = useState('idle') // idle | sent | building | live | error
  const [liveUrl, setLiveUrl] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsToken, setSettingsToken] = useState('')
  const chatEndRef = useRef(null)
  const pollRef = useRef(null)

  // keep parent in sync with local edits
  useEffect(() => { onProjectChange(local) }, [local])

  // initial welcome
  useEffect(() => {
    setChat([{ id: uid(), role: 'hermes', kind: 'text',
      text: 'Hey! Ich bin Hermes. Erzaehl mir kurz, welche Web-App du bauen willst — oder nimm unten einen Vorschlag. Wir brainstormen, bis der Prompt perfekt ist. Code entsteht erst, wenn du Go sagst.' }])
  }, [])

  // regenerate suggestions whenever answers/idea change
  useEffect(() => { setSuggestions(generateSuggestions(local)) }, [local.idea, local.answers])

  // autoscroll
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [chat])

  // ----- local echo helpers -----
  function pushUser(text) {
    setChat(c => [...c, { id: uid(), role: 'user', kind: 'text', text }])
  }
  function pushHermes(text) {
    setChat(c => [...c, { id: uid(), role: 'hermes', kind: 'text', text }])
  }
  function pushStatus(text) {
    setChat(c => [...c, { id: uid(), role: 'system', kind: 'status', text }])
  }
  function pushSuggestions(ss) {
    setChat(c => [...c, { id: uid(), role: 'hermes', kind: 'suggestions', suggestions: ss }])
  }

  // ----- GitHub inbox helpers -----
  async function ensureInboxNow() {
    if (inbox) return inbox
    const token = localStorage.getItem('weblab.gh.token')
    if (!token) { setGhState('error'); setGhErr('Bitte zuerst GitHub-Token in den Einstellungen setzen.'); return null }
    try {
      const issue = await gh.createAndPost(local, buildPrompt(local), '')
      const ib = { owner: issue.owner, repo: issue.repo, number: issue.number, url: issue.url }
      setInbox(ib)
      return ib
    } catch (e) {
      setGhState('error'); setGhErr(e.message); return null
    }
  }

  const sendMessage = useCallback(async (text) => {
    if (!text.trim()) return
    pushUser(text.trim())
    setInput('')
    setSending(true)
    try {
      const ib = inbox || await ensureInboxNow()
      if (!ib) { setSending(false); return }
      await gh.postMessage(ib.owner, ib.repo, ib.number, text.trim())
      pushStatus('Gesendet an Hermes — er denkt nach...')
      // local rules still apply instantly
      const next = { ...local }
      if (!next.idea) next.idea = text.trim()
      else if (!next.answers.features) next.answers.features = text.trim()
      setLocal(next)
      setSuggestions(generateSuggestions(next))
    } catch (e) {
      pushStatus('Senden fehlgeschlagen: ' + e.message)
    }
    setSending(false)
  }, [inbox, local])

  // ----- poll the inbox for Hermes replies -----
  useEffect(() => {
    if (!inbox) return
    const seen = new Set(chat.map(m => m.id))
    const tick = async () => {
      try {
        const comments = await gh.fetchComments(inbox.owner, inbox.repo, inbox.number)
        for (const c of comments) {
          const parsed = gh.parseComment(c.body)
          if (parsed.kind === 'msg' && parsed.role === 'hermes') {
            const key = 'c' + c.id
            if (!seen.has(key)) {
              seen.add(key)
              setChat(prev => [...prev, { id: key, role: 'hermes', kind: 'text', text: parsed.text, actions: parsed.actions }])
            }
            // Handle actions: auto-fill categories
            if (parsed.actions) {
              const next = { ...local }
              for (const [catId, val] of Object.entries(parsed.actions)) {
                if (val && val.trim()) next.answers[catId] = (next.answers[catId] || '') + (next.answers[catId] ? '\n' : '') + val.trim()
              }
              setLocal(next)
              setSuggestions(generateSuggestions(next))
            }
          } else if (parsed.kind === 'status') {
            const key = 's' + c.id
            if (!seen.has(key)) {
              seen.add(key)
              setChat(prev => [...prev, { id: key, role: 'system', kind: 'status', text: parsed.text }])
            }
          } else if (parsed.kind === 'build') {
            const key = 'b' + c.id
            if (!seen.has(key)) {
              seen.add(key)
              const url = parsed.json?.url || parsed.text.match(/https?:\/\/[^\s]+/)?.[0] || ''
              if (url) { setLiveUrl(url); setLocal(p => ({ ...p, status: 'live', liveUrl: url })) }
              setGoState('live')
              setChat(prev => [...prev, { id: key, role: 'hermes', kind: 'text',
                text: url ? `Fertig! Deine App ist live: ${url}` : 'Fertig! Deine App ist gebaut.' }])
            }
          }
        }
      } catch (e) { /* transient */ }
    }
    tick()
    pollRef.current = setInterval(tick, 10000)
    return () => clearInterval(pollRef.current)
  }, [inbox])

  // ----- accept a suggestion card -----
  function acceptSuggestion(s) {
    const next = { ...local }
    applySuggestion(next, s)
    setLocal(next)
    setSuggestions(generateSuggestions(next))
    pushHermes('Notiert — "' + s.title + '" ist jetzt im Prompt.')
  }

  // ----- mark a category as "answered" via textarea -----
  function setCategoryValue(catId, val) {
    const next = { ...local, answers: { ...local.answers, [catId]: val } }
    setLocal(next)
    setSuggestions(generateSuggestions(next))
  }

  // ----- Go: finalize prompt + request build -----
  async function doGo() {
    const finalPrompt = buildPrompt(local)
    setGoState('sent')
    try {
      const ib = inbox || await ensureInboxNow()
      if (!ib) { setGoState('error'); return }
      await gh.postMessage(ib.owner, ib.repo, ib.number, '/weblab/build ' + JSON.stringify({ prompt: finalPrompt, name: local.name }))
      setLocal(p => ({ ...p, status: 'building' }))
      setGoState('building')
      pushStatus('Go! Der Build-Auftrag ist raus. Hermes baut deine App...')
    } catch (e) {
      setGoState('error'); pushStatus('Go fehlgeschlagen: ' + e.message)
    }
  }

  // ----- Settings modal -----
  function openSettings() {
    setSettingsToken(localStorage.getItem('weblab.gh.token') || '')
    setSettingsOpen(true)
  }
  async function saveSettings() {
    if (!settingsToken.trim()) return
    setGhState('verifying')
    try {
      gh.setToken(settingsToken.trim())
      const login = await gh.verifyToken()
      localStorage.setItem('weblab.gh.token', settingsToken.trim())
      setGhState('ready')
      setGhErr('')
      setSettingsOpen(false)
      pushStatus('GitHub verbunden (' + login + '). Briefkasten bereit.')
    } catch (e) {
      gh.clearToken()
      setGhState('error'); setGhErr(e.message)
    }
  }
  function clearToken() {
    gh.clearToken()
    localStorage.removeItem('weblab.gh.token')
    setGhState('idle')
    setGhErr('')
    pushStatus('Token entfernt.')
  }

  // categories completion percentage
  const answeredCount = CATEGORIES.filter(c => (local.answers[c.id] || '').trim()).length
  const pct = Math.round(answeredCount / CATEGORIES.length * 100)

  return (
    <div className="studio">
      {/* Header */}
      <div className="toolbar">
        <div className="tb-left">
          <button className="icon-btn" onClick={onBack} title="Zurueck">Zurueck</button>
          <input className="board-name" value={local.name} onChange={e => setLocal(p => ({ ...p, name: e.target.value }))} />
          {local.status === 'live' && <span className="badge ok">live</span>}
          {local.status === 'building' && <span className="badge busy">building</span>}
        </div>
        <div className="tb-center">
          <span className="progress-label">Prompt: {pct}%</span>
          <div className="progress"><div className="progress-fill" style={{ width: pct + '%' }} /></div>
        </div>
        <div className="tb-right">
          <button className="icon-btn" onClick={openSettings} title="Einstellungen">Einstellungen</button>
          <button className="ghost" onClick={onDelete} title="Projekt loeschen">Loeschen</button>
          <button className="primary" onClick={doGo} disabled={!local.idea || goState === 'sent' || goState === 'building'}>
            Go
          </button>
        </div>
      </div>

      {/* Main */}
      <div className="studio-body">
        {/* Left: visual brainstorm area */}
        <div className="chat-col">
          <div className="chat-scroll">
            {chat.map(m => {
              if (m.kind === 'status') return <div key={m.id} className="chat-status">{m.text}</div>
              if (m.kind === 'suggestions') return (
                <div key={m.id} className="chat-sugg-group">
                  {m.suggestions.map(s => (
                    <div key={s.id} className="sugg-card">
                      <div className="sugg-body">
                        <b>{s.title}</b>
                        <div className="sugg-desc">{s.desc}</div>
                      </div>
                      <div className="sugg-actions">
                        <button className="primary sm" onClick={() => acceptSuggestion(s)}>Annehmen</button>
                        <button className="ghost sm" onClick={() => setSuggestions(ss => ss.filter(x => x.id !== s.id))}>Ignorieren</button>
                      </div>
                    </div>
                  ))}
                </div>
              )
              return (
                <div key={m.id} className={`chat-msg ${m.role}`}>
                  {m.role === 'hermes' && <div className="avatar">H</div>}
                  <div className="bubble">{m.text}</div>
                </div>
              )
            })}
            <div ref={chatEndRef} />
          </div>
          <div className="chat-input-row">
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input) } }}
              placeholder="Deine Idee, Antwort oder Rueckfrage..."
              disabled={sending}
            />
            <button className="primary" onClick={() => sendMessage(input)} disabled={sending || !input.trim()}>Senden</button>
          </div>
          {ghState === 'idle' && (
            <div className="gh-hint">
              <span>Kein GitHub-Token gesetzt. In den Einstellungen (Zahnrad oben rechts) einmalig eintragen.</span>
            </div>
          )}
          {ghState === 'error' && (
            <div className="gh-hint err">Token Fehler: {ghErr} — in den Einstellungen korrigieren.</div>
          )}
          {ghState === 'ready' && <div className="gh-ok">Briefkasten bereit — schreibe unten eine Nachricht.</div>}
        </div>

        {/* Right: prompt + checklist */}
        <div className="prompt-col">
          <div className="prompt-head">
            <span className="prompt-title">Live Prompt</span>
            <button className="ghost sm" onClick={() => { navigator.clipboard?.writeText(buildPrompt(local)); pushStatus('Prompt kopiert.') }}>Kopieren</button>
          </div>
          <pre className="prompt-preview">{buildPrompt(local)}</pre>

          <div className="checklist">
            <div className="checklist-title">Checkliste</div>
            {CATEGORIES.map(cat => {
              const val = (local.answers[cat.id] || '').trim()
              const done = !!val
              return (
                <div key={cat.id} className={`check-item ${done ? 'done' : ''}`}>
                  <div className="check-line">
                    <span className="check-box">{done ? '+' : ''}</span>
                    <div className="check-info">
                      <b>{cat.label}</b>
                      <span className="check-short">{done ? val.split('\n')[0] : cat.short}</span>
                    </div>
                  </div>
                  {!done && (
                    <textarea
                      className="check-input"
                      placeholder={cat.short}
                      value={local.answers[cat.id] || ''}
                      readOnly
                      rows={2}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Settings Modal */}
      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <span>Einstellungen</span>
              <button className="ghost" onClick={() => setSettingsOpen(false)}>x</button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>GitHub Token (ghp_...)</label>
                <input type="password" value={settingsToken} onChange={e => setSettingsToken(e.target.value)} placeholder="ghp_..." />
              </div>
              <div className="modal-actions">
                <button className="primary" onClick={saveSettings} disabled={!settingsToken.trim() || ghState === 'verifying'}>Speichern & Verbinden</button>
                <button className="ghost" onClick={clearToken} disabled={!localStorage.getItem('weblab.gh.token')}>Token loeschen</button>
                <button className="ghost" onClick={() => setSettingsOpen(false)}>Abbrechen</button>
              </div>
              {ghState === 'verifying' && <div className="muted">Pruefe Token...</div>}
              {ghState === 'error' && <div className="err">{ghErr}</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}