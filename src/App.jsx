import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  BLOCK_TYPES, TYPE_MAP, COLOR_PRESETS, FONT_PRESETS, uid, newScreen, newBlock,
  generateSuggestions, applySuggestion, exportPlan, loadBoards, saveBoards, newBoard,
} from './lib/weblab.js'
import * as gh from './lib/github.js'

// ---------------------------------------------------------------------------
// App shell: login gate + board management
// ---------------------------------------------------------------------------

const LS_AUTH = 'weblab.auth.v1'
const LS_PASS = 'weblab.pass.v1'

function useLogin() {
  const [authed, setAuthed] = useState(() => localStorage.getItem(LS_AUTH) === '1')
  const [mode, setMode] = useState('entry') // entry | create-pass

  return { authed, mode, setMode, setAuthed }
}

export default function App() {
  const { authed, mode, setMode, setAuthed } = useLogin()
  const [boards, setBoards] = useState([])
  const [activeId, setActiveId] = useState(null)

  useEffect(() => {
    if (authed) setBoards(loadBoards())
  }, [authed])

  if (!authed) return <LoginGate mode={mode} setMode={setMode} onDone={() => { setAuthed(true); setBoards(loadBoards()) }} />

  const active = boards.find(b => b.id === activeId) || null

  return (
    <div className="app">
      {active ? (
        <BoardView key={active.id} board={active}
          onRename={n => setBoards(bs => { const next = bs.map(b => b.id === active.id ? { ...b, name: n } : b); saveBoards(next); return next })}
          onClose={() => setActiveId(null)}
          onDelete={() => { if (confirm('Delete this board?')) { setBoards(bs => { const next = bs.filter(b => b.id !== active.id); saveBoards(next); setActiveId(null); return next }); } }}
        />
      ) : (
        <BoardHome boards={boards}
          onOpen={setActiveId}
          onCreate={() => { const b = newBoard(`Board ${boards.length + 1}`); setBoards(bs => { const next = [...bs, b]; saveBoards(next); return next }); setActiveId(b.id) }}
          onDelete={id => { if (confirm('Delete this board?')) setBoards(bs => { const next = bs.filter(b => b.id !== id); saveBoards(next); return next }) }}
          onLogout={() => { localStorage.removeItem(LS_AUTH); setAuthed(false) }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Login gate (simple access code, stored hashed; per-user single-device)
// ---------------------------------------------------------------------------

async function hash(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('weblab::' + s))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function LoginGate({ mode, setMode, onDone }) {
  const [pass, setPass] = useState('')
  const [err, setErr] = useState('')

  async function submit(e) {
    e.preventDefault()
    if (mode === 'create-pass') {
      if (pass.length < 4) { setErr('Use at least 4 characters.'); return }
      localStorage.setItem(LS_PASS, await hash(pass))
      localStorage.setItem(LS_AUTH, '1')
      onDone()
    } else {
      const stored = localStorage.getItem(LS_PASS)
      if (!stored) { setMode('create-pass'); return }
      if (await hash(pass) === stored) { localStorage.setItem(LS_AUTH, '1'); onDone() }
      else setErr('Wrong code. Try again.')
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="logo">◈ WebLab</div>
        <p className="sub">
          {mode === 'create-pass'
            ? 'Set an access code — only you will know it. It unlocks WebLab on this browser.'
            : 'Enter your access code to open your lab.'}
        </p>
        <form onSubmit={submit}>
          <input type="password" autoFocus value={pass} onChange={e => setPass(e.target.value)}
            placeholder={mode === 'create-pass' ? 'New access code' : 'Access code'} />
          <button type="submit" className="primary">{mode === 'create-pass' ? 'Set code & enter' : 'Enter Lab'}</button>
        </form>
        {err && <div className="err">{err}</div>}
        <div className="hint">Data stays in this browser only.</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Board home (list boards)
// ---------------------------------------------------------------------------

function BoardHome({ boards, onOpen, onCreate, onDelete, onLogout }) {
  return (
    <div className="home">
      <div className="home-top">
        <div className="logo">◈ WebLab</div>
        <button className="ghost" onClick={onLogout}>Log out</button>
      </div>
      <div className="home-body">
        <div className="home-hero">
          <h1>Your webapp lab</h1>
          <p>Design apps visually. Export a precise build spec. You stay in control.</p>
        </div>
        <div className="board-grid">
          {boards.map(b => (
            <div key={b.id} className="board-card" onClick={() => onOpen(b.id)}>
              <div className="board-card-name">{b.name}</div>
              <div className="board-card-meta">{b.screens.length} screen(s)</div>
              <button className="del" onClick={e => { e.stopPropagation(); onDelete(b.id) }}>✕</button>
            </div>
          ))}
          <div className="board-card new" onClick={onCreate}>+ New board</div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Canvas: pan/zoom, screens, drag & drop
// ---------------------------------------------------------------------------

function BoardView({ board, onRename, onClose, onDelete }) {
  const [name, setName] = useState(board.name)
  const [view, setView] = useState(() => ({ panX: 40, panY: 30, zoom: 1 }))
  const [selected, setSelected] = useState(null) // { kind:'screen'|'block', id }
  const [drag, setDrag] = useState(null)        // palette item being dragged
  const [dragging, setDragging] = useState(null) // in-flight DnD
  const [suggestions, setSuggestions] = useState([])
  const [exportOpen, setExportOpen] = useState(false)
  const [ghState, setGhState] = useState(null) // { phase:'idle'|'verify'|'send'|'done'|'error', ... }
  const canvasRef = useRef(null)

  const update = useCallback((fn) => {
    const b = { ...board }
    // board is immutable; we thread through by mutating a shallow copy below
    // (the parent passes the same object; we persist on change)
    fn(b)
    saveBoards([...loadBoards().map(x => x.id === b.id ? b : x)])
    // note: parent state is not lifted; BoardView holds the working copy via props.board
    // simpler: we store local state too
  }, [board])

  const [localBoard, setLocalBoard] = useState(board)

  useEffect(() => { setSuggestions(generateSuggestions(localBoard.screens)) }, [localBoard])

  useEffect(() => { onRename(name) }, [name])

  // ---------- canvas wheel/pan ----------
  const toCanvas = (clientX, clientY) => {
    const r = canvasRef.current?.getBoundingClientRect()
    return { x: (clientX - r.left - view.panX) / view.zoom, y: (clientY - r.top - view.panY) / view.zoom }
  }

  function zoomAt(clientX, clientY, factor) {
    const r = canvasRef.current?.getBoundingClientRect()
    const mx = (clientX - r.left - view.panX) / view.zoom
    const my = (clientY - r.top - view.panY) / view.zoom
    const nz = Math.min(2, Math.max(0.4, view.zoom * factor))
    setView(v => ({ zoom: nz, panX: clientX - r.left - mx * nz, panY: clientY - r.top - my * nz }))
  }

  // wheel = zoom (unless we implement pan via middle-drag)
  function onWheel(e) {
    e.preventDefault()
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 0.9)
  }

  // middle/right-drag to pan
  const panRef = useRef(null)
  function onMouseDown(e) {
    if (e.button === 1 || e.button === 2) {
      e.preventDefault()
      panRef.current = { x: e.clientX - view.panX, y: e.clientY - view.panY }
    }
  }
  function onMouseMove(e) {
    if (panRef.current) {
      setView(v => ({ ...v, panX: e.clientX - panRef.current.x, panY: e.clientY - panRef.current.y }))
      return
    }
    if (dragging) {
      setDragging(d => ({ ...d, x: (e.clientX - d.startX) / view.zoom, y: (e.clientY - d.startY) / view.zoom }))
    }
  }
  function onMouseUp() {
    panRef.current = null
    if (dragging) {
      setDragging(d => {
        // finalize: place block into screen under cursor
        const r = canvasRef.current?.getBoundingClientRect()
        const cx = (d.mouseX - r.left - view.panX) / view.zoom
        const cy = (d.mouseY - r.top - view.panY) / view.zoom
        const screen = localBoard.screens.find(s => {
          const sx = s.x, sy = s.y, sw = 380, sh = 240
          return cx >= sx && cx <= sx + sw && cy >= sy && cy <= sy + sh
        })
        if (screen) {
          const blk = newBlock(d.type, Math.round(cx - screen.x), Math.round(cy - screen.y))
          setLocalBoard(lb => {
            const b = { ...lb, screens: lb.screens.map(s => s.id === screen.id ? { ...s, blocks: [...s.blocks, blk] } : s) }
            persist(b)
            return b
          })
          setSelected({ kind: 'block', id: blk.id })
        }
        return null
      })
    }
    setDragging(null)
  }

  function persist(b) {
    const all = loadBoards().map(x => x.id === b.id ? b : x)
    saveBoards(all)
  }

  // Add a screen at the center of the current view
  function addScreen() {
    const s = newScreen(`Screen ${localBoard.screens.length + 1}`)
    s.x = 40 + localBoard.screens.length * 450
    s.y = 60
    setLocalBoard(lb => {
      const b = { ...lb, screens: [...lb.screens, s] }
      persist(b)
      return b
    })
    setSelected({ kind: 'screen', id: s.id })
  }

  const addBlockToSelectedScreen = (type) => {
    const sel = localBoard.screens.find(s => selected?.kind === 'screen' && s.id === selected.id)
    if (!sel) return
    const blk = newBlock(type)
    blk.x = 10 + sel.blocks.length * 12
    blk.y = 10 + sel.blocks.length * 12
    setLocalBoard(lb => {
      const b = { ...lb, screens: lb.screens.map(s => s.id === sel.id ? { ...s, blocks: [...s.blocks, blk] } : s) }
      persist(b)
      return b
    })
    setSelected({ kind: 'block', id: blk.id })
  }

  return (
    <div className="studio">
      <Toolbar board={localBoard} name={name} setName={setName}
        onSuggest={setSuggestions} onExport={() => setExportOpen(true)}
        onGitHub={() => setGhState({ phase: 'verify' })}
        onClose={onClose} onDelete={onDelete} onAddScreen={addScreen} />
      <div className="studio-body">
        <Palette onPick={t => { setDrag(t); setDragging({ type: t, startX: 0, startY: 0, x: 0, y: 0, mouseX: 0, mouseY: 0 }) }} />
        <div className="canvas-wrap">
          <div className="canvas" ref={canvasRef}
            onWheel={onWheel} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp}
            onContextMenu={e => e.preventDefault()}
            style={{ transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`, transformOrigin: '0 0' }}>
            <BoardCanvas board={localBoard} selected={selected} setSelected={setSelected} />
            {dragging && (
              <div className="drag-ghost" style={{ left: dragging.x, top: dragging.y }}>
                <div className={`block-preview type-${dragging.type}`}>{TYPE_MAP[dragging.type]?.icon}</div>
              </div>
            )}
          </div>
        </div>
        <Inspector board={localBoard} selected={selected} setSelected={setSelected}
          onAddBlock={addBlockToSelectedScreen} />
      </div>
      {suggestions.length > 0 && (
        <SuggestPanel suggestions={suggestions} onAccept={s => {
          const res = applySuggestion(localBoard.screens, s)
          setLocalBoard(lb => { const b = { ...lb, screens: res.board }; persist(b); return b })
          if (res.screenId) setSelected({ kind: 'screen', id: res.screenId })
          setSuggestions(generateSuggestions(res.board))
        }} onDismiss={s => setSuggestions(suggestions.filter(x => x.id !== s.id))} />
      )}
      {exportOpen && <ExportModal board={localBoard} onClose={() => setExportOpen(false)} ghState={ghState} setGhState={setGhState} onGo={async () => {
        const plan = exportPlan(localBoard.screens, name)
        setGhState({ phase: 'send' })
        try {
          const tokenLogin = await gh.verifyToken()
          const res = await gh.submitBuildRequest(name, plan.json, plan.markdown)
          setGhState({ phase: 'done', url: res.url, login: tokenLogin })
        } catch (e) {
          setGhState({ phase: 'error', error: e.message })
        }
      }} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toolbar / palette / canvas / inspector
// ---------------------------------------------------------------------------

function Toolbar({ board, name, setName, onSuggest, onExport, onGitHub, onClose, onDelete, onAddScreen }) {
  return (
    <div className="toolbar">
      <div className="tb-left">
        <span className="logo">◈</span>
        <input className="board-name" value={name} onChange={e => setName(e.target.value)} />
      </div>
      <div className="tb-center">
        <button onClick={onAddScreen}>+ Screen</button>
        <button onClick={() => onSuggest(generateSuggestions(board.screens))}>✦ Suggestions</button>
        <button onClick={onGitHub}>GitHub</button>
      </div>
      <div className="tb-right">
        <button className="primary" onClick={onExport} disabled={!board.screens.length}>Go → Export Plan</button>
        <button className="ghost" onClick={onClose}>✕</button>
      </div>
    </div>
  )
}

function Palette({ onPick }) {
  return (
    <div className="palette">
      <div className="palette-title">Blocks</div>
      {BLOCK_TYPES.map(b => (
        <div key={b.type} className="palette-item" draggable
          onDragStart={e => { e.dataTransfer.setData('text/plain', b.type); onPick(b.type) }}
          title={b.desc}
        >
          <span className="pi-icon">{b.icon}</span>
          <span className="pi-label">{b.label}</span>
        </div>
      ))}
    </div>
  )
}

function BoardCanvas({ board, selected, setSelected }) {
  return (
    <>
      {board.screens.map(s => {
        const sx = s.x || 40, sy = s.y || 60
        return (
          <div key={s.id} className={`screen ${selected?.kind === 'screen' && selected.id === s.id ? 'sel' : ''}`}
            style={{ left: sx, top: sy }}
            onClick={e => { e.stopPropagation(); setSelected({ kind: 'screen', id: s.id }) }}>
            <div className="screen-chrome">
              <span className="dot r" /><span className="dot y" /><span className="dot g" />
              <span className="screen-name">{s.name}</span>
            </div>
            <div className="screen-body" style={{ background: s.bg, color: s.textColor }}>
              {s.blocks.length === 0 && <div className="screen-empty">Drop blocks here…</div>}
              {s.blocks.map(b => (
                <div key={b.id} className={`block type-${b.type} ${selected?.kind === 'block' && selected.id === b.id ? 'sel' : ''}`}
                  style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
                  onClick={e => { e.stopPropagation(); setSelected({ kind: 'block', id: b.id }) }}
                  onMouseDown={e => e.stopPropagation()}
                  draggable
                  onDragStart={e => e.stopPropagation()}
                >
                  <BlockPreview block={b} />
                </div>
              ))}
            </div>
            {s.connections.map((c, i) => (
              <div key={i} className="conn-label">→ {board.screens.find(x => x.id === c.to)?.name || '?'}</div>
            ))}
          </div>
        )
      })}
    </>
  )
}

function BlockPreview({ block }) {
  const p = block.props || {}
  switch (block.type) {
    case 'navbar': return <div className="bp-navbar"><b>{p.title || 'My App'}</b><span className="bp-links">{(p.links || '').split('\n')[0]}</span></div>
    case 'hero': return <div className="bp-hero"><div className="bp-h1">{p.heading || 'Headline'}</div><div className="bp-sub">{p.subtext || ''}</div>{p.cta && <div className="bp-btn">{p.cta}</div>}</div>
    case 'heading': return <div className="bp-heading">{p.text || 'Heading'}</div>
    case 'text': return <div className="bp-text">{p.text || 'Text…'}</div>
    case 'button': return <div className={`bp-btn ${p.style === 'secondary' ? 'secondary' : ''}`}>{p.label || 'Button'}</div>
    case 'image': return <div className="bp-image">{p.alt || 'Image'}</div>
    case 'card': return <div className="bp-card"><b>{p.title || 'Card title'}</b><div className="bp-text">{p.body || ''}</div>{p.image && <div className="bp-image sm">img</div>}</div>
    case 'list': return <div className="bp-list">{(p.items || '').split('\n').slice(0, 3).map((it, i) => <div key={i} className="bp-list-item">• {it}</div>)}</div>
    case 'gallery': return <div className="bp-gallery">{Array.from({ length: Math.min(p.images || 4, 6) }).map((_, i) => <div key={i} className="bp-gcell" />)}</div>
    case 'form': return <div className="bp-form">{(p.fields || '').split('\n').slice(0, 2).map((f, i) => <div key={i} className="bp-input">{f}</div>)}{p.button && <div className="bp-btn sm">{p.button}</div>}</div>
    case 'video': return <div className="bp-video">{p.url ? p.url.replace(/^https?:\/\//, '') : 'Video'}</div>
    case 'divider': return <div className="bp-divider" />
    case 'footer': return <div className="bp-footer"><div>{p.text || ''}</div></div>
    case 'icon': return <div className="bp-icon">{p.symbol || '◆'}</div>
    default: return <div className="bp-text">Block</div>
  }
}

function Inspector({ board, selected, setSelected, onAddBlock }) {
  const screen = board.screens.find(s => selected?.kind === 'screen' && s.id === selected.id)
  const block = screen?.blocks.find(b => selected?.kind === 'block' && b.id === selected.id)

  function upd(fn) {
    // mutate copy via closure over board (BoardView passes the same object; we call persist)
    fn(board)
    saveBoards(loadBoards().map(x => x.id === board.id ? board : x))
    // force re-render: parent should own this… simplest: dispatch? we'll re-read localStorage
  }

  if (!screen && !block) return <div className="inspector"><div className="insp-empty">Select a screen or block</div></div>

  if (block) {
    const p = block.props || {}
    const T = TYPE_MAP[block.type]
    return (
      <div className="inspector">
        <div className="insp-title">{T?.label} <span className="mono">#{block.type}</span></div>

        {block.type === 'text' && <Field label="Text" value={p.text} onChange={v => { p.text = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />}
        {block.type === 'heading' && <Field label="Text" value={p.text} onChange={v => { p.text = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />}
        {block.type === 'button' && <>
          <Field label="Label" value={p.label} onChange={v => { p.label = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
          <Select label="Style" value={p.style} options={[['primary', 'Primary'], ['secondary', 'Secondary'], ['ghost', 'Ghost']]} onChange={v => { p.style = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
        </>}
        {block.type === 'hero' && <>
          <Field label="Headline" value={p.heading} onChange={v => { p.heading = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
          <FieldArea label="Subtext" value={p.subtext} onChange={v => { p.subtext = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
          <Field label="CTA button" value={p.cta} onChange={v => { p.cta = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
        </>}
        {block.type === 'navbar' && <>
          <Field label="App title" value={p.title} onChange={v => { p.title = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
          <FieldArea label="Links (one per line)" value={p.links} onChange={v => { p.links = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
        </>}
        {block.type === 'card' && <>
          <Field label="Title" value={p.title} onChange={v => { p.title = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
          <FieldArea label="Body" value={p.body} onChange={v => { p.body = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
          <Toggle label="Show image" value={p.image} onChange={v => { p.image = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
        </>}
        {block.type === 'list' && <FieldArea label="Items (one per line)" value={p.items} onChange={v => { p.items = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />}
        {block.type === 'gallery' && <>
          <NumberField label="Images" value={p.images} onChange={v => { p.images = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
          <Toggle label="Captions" value={p.caption} onChange={v => { p.caption = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
        </>}
        {block.type === 'form' && <>
          <FieldArea label="Fields (one per line)" value={p.fields} onChange={v => { p.fields = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
          <Field label="Button text" value={p.button} onChange={v => { p.button = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
        </>}
        {block.type === 'footer' && <>
          <FieldArea label="Text" value={p.text} onChange={v => { p.text = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
          <FieldArea label="Links (one per line)" value={p.links} onChange={v => { p.links = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
        </>}
        {block.type === 'image' && <>
          <Field label="Image URL (optional)" value={p.src} onChange={v => { p.src = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
          <Field label="Alt text" value={p.alt} onChange={v => { p.alt = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
        </>}
        {block.type === 'video' && <>
          <Field label="Video URL (YouTube…)" value={p.url} onChange={v => { p.url = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
          <Field label="Caption" value={p.caption} onChange={v => { p.caption = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
        </>}
        {block.type === 'divider' && <Select label="Style" value={p.style} options={[['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']]} onChange={v => { p.style = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />}
        {block.type === 'icon' && <>
          <Field label="Symbol" value={p.symbol} onChange={v => { p.symbol = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
          <Field label="Label" value={p.label} onChange={v => { p.label = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
        </>}

        <div className="insp-sep" />
        <SizeFields block={block} onSize={(w, h) => { block.w = w; block.h = h; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
        <button className="ghost danger" onClick={() => {
          if (!confirm('Remove this block?')) return
          board.screens.forEach(s => { s.blocks = s.blocks.filter(b => b.id !== block.id) })
          saveBoards(loadBoards().map(x => x.id === board.id ? board : x))
          setSelected({ kind: 'screen', id: screen.id })
        }}>Remove block</button>
      </div>
    )
  }

  // screen selected
  return (
    <div className="inspector">
      <div className="insp-title">Screen</div>
      <Field label="Name" value={screen.name} onChange={v => { screen.name = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
      <ColorField label="Background" value={screen.bg} onChange={v => { screen.bg = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
      <ColorField label="Text color" value={screen.textColor} onChange={v => { screen.textColor = v; saveBoards(loadBoards().map(x => x.id === board.id ? board : x)); setSelected({ ...selected, tick: Date.now() }) }} />
      <div className="insp-sep" />
      <div className="insp-label">Add block</div>
      <div className="quick-blocks">
        {BLOCK_TYPES.slice(0, 8).map(b => (
          <button key={b.type} onClick={() => onAddBlock(b.type)} title={b.desc}>{b.icon} {b.label}</button>
        ))}
      </div>
    </div>
  )
}

// small field helpers
function Field({ label, value, onChange }) {
  return <label className="field"><span>{label}</span><input value={value || ''} onChange={e => onChange(e.target.value)} /></label>
}
function FieldArea({ label, value, onChange }) {
  return <label className="field"><span>{label}</span><textarea rows={3} value={value || ''} onChange={e => onChange(e.target.value)} /></label>
}
function NumberField({ label, value, onChange }) {
  return <label className="field"><span>{label}</span><input type="number" min={1} max={12} value={value} onChange={e => onChange(parseInt(e.target.value) || 1)} /></label>
}
function Toggle({ label, value, onChange }) {
  return <label className="field toggle"><input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} /><span>{label}</span></label>
}
function Select({ label, value, options, onChange }) {
  return <label className="field"><span>{label}</span><select value={value} onChange={e => onChange(e.target.value)}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
}
function ColorField({ label, value, onChange }) {
  return (
    <label className="field"><span>{label}</span>
      <div className="color-row">
        <input type="color" value={value} onChange={e => onChange(e.target.value)} />
        <div className="swatches">{COLOR_PRESETS.map(c => <button key={c} className={`sw ${c === value ? 'on' : ''}`} style={{ background: c }} onClick={() => onChange(c)} />)}</div>
      </div>
    </label>
  )
}
function SizeFields({ block, onSize }) {
  return <div className="size-row"><span>Size</span><input type="number" value={block.w} onChange={e => onSize(parseInt(e.target.value) || 40, block.h)} />×<input type="number" value={block.h} onChange={e => onSize(block.w, parseInt(e.target.value) || 40)} /></div>
}

// ---------------------------------------------------------------------------
// Suggestions panel
// ---------------------------------------------------------------------------

function SuggestPanel({ suggestions, onAccept, onDismiss }) {
  return (
    <div className="suggest">
      <div className="suggest-title">✦ Architect suggestions</div>
      {suggestions.map(s => (
        <div key={s.id} className="suggest-card">
          <div className="suggest-body">
            <b>{s.title}</b>
            <div className="suggest-desc">{s.desc}</div>
          </div>
          <div className="suggest-actions">
            <button className="primary sm" onClick={() => onAccept(s)}>Apply</button>
            <button className="ghost sm" onClick={() => onDismiss(s)}>Dismiss</button>
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Export modal (the "Go" flow)
// ---------------------------------------------------------------------------

function ExportModal({ board, onClose, ghState, setGhState, onGo }) {
  const plan = exportPlan(board.screens, board.name)
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div><b>Go — build spec</b><div className="muted">Review exactly what will be built. Nothing is sent until you press Go.</div></div>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>

        <div className="modal-tabs">
          <div className="tab active">Markdown</div>
        </div>
        <pre className="spec-preview">{plan.markdown}</pre>

        <div className="modal-footer">
          <div className="gh-status">
            {!ghState || ghState.phase === 'idle' ? (
              <GitHubSetup setGhState={setGhState} />
            ) : ghState.phase === 'verify' ? (
              <span className="muted">Checking your GitHub…</span>
            ) : ghState.phase === 'send' ? (
              <span className="muted">Creating build request…</span>
            ) : ghState.phase === 'done' ? (
              <a href={ghState.url} target="_blank" rel="noreferrer" className="ok">✅ Build request sent → open it</a>
            ) : (
              <span className="err">⚠ {ghState.error}</span>
            )}
          </div>
          <button className="primary" onClick={onGo}
            disabled={!board.screens.length || (ghState?.phase === 'send' || ghState?.phase === 'verify')}>
            🚀 Go — send to builder
          </button>
        </div>
      </div>
    </div>
  )
}

function GitHubSetup({ setGhState }) {
  const [t, setT] = useState('')
  async function save() {
    if (!t.trim()) return
    const trimmed = t.trim()
    // verify it works before storing
    try {
      gh.setToken(trimmed)
      const login = await gh.verifyToken()
      setGhState({ phase: 'idle', login, verified: true })
      alert(`GitHub connected as ${login}.`)
    } catch (e) {
      gh.clearToken()
      setGhState({ phase: 'error', error: e.message })
    }
  }
  return (
    <div className="gh-setup">
      <input type="password" placeholder="GitHub token (repo scope)" value={t} onChange={e => setT(e.target.value)} />
      <button className="ghost sm" onClick={save}>Connect</button>
    </div>
  )
}