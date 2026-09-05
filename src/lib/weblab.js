// WebLab — data model, building-block definitions, and the UX rule engine (pure logic, no React).

// ---------------------------------------------------------------------------
// Types (plain JS — this project uses JSX, no TS)
// A Board is an array of screens. A Screen has blocks. Connections link screens.
// ---------------------------------------------------------------------------

/** @typedef {'text'|'heading'|'button'|'image'|'card'|'form'|'video'|'gallery'|'navbar'|'footer'|'hero'|'divider'|'list'|'icon'} BlockType */

export const BLOCK_TYPES = [
  { type: 'navbar',   label: 'Navbar',    icon: '≡', desc: 'Top navigation bar',           defaultW: 360, defaultH: 44 },
  { type: 'hero',     label: 'Hero',      icon: '★', desc: 'Big headline section',         defaultW: 360, defaultH: 150 },
  { type: 'heading',  label: 'Heading',   icon: 'H', desc: 'Section heading',              defaultW: 320, defaultH: 40 },
  { type: 'text',     label: 'Text',      icon: '¶', desc: 'Paragraph text',               defaultW: 320, defaultH: 70 },
  { type: 'button',   label: 'Button',    icon: '▣', desc: 'Clickable button',             defaultW: 140, defaultH: 40 },
  { type: 'image',    label: 'Image',     icon: '▧', desc: 'Image placeholder',            defaultW: 240, defaultH: 140 },
  { type: 'card',     label: 'Card',      icon: '▭', desc: 'Card container',               defaultW: 320, defaultH: 130 },
  { type: 'list',     label: 'List',      icon: '☰', desc: 'Bullet list / steps',          defaultW: 300, defaultH: 120 },
  { type: 'gallery',  label: 'Gallery',   icon: '❐', desc: 'Image grid',                   defaultW: 340, defaultH: 150 },
  { type: 'form',     label: 'Form',      icon: '✎', desc: 'Input form (name, email...)',  defaultW: 320, defaultH: 180 },
  { type: 'video',    label: 'Video',     icon: '▶', desc: 'Video embed placeholder',      defaultW: 320, defaultH: 170 },
  { type: 'divider',  label: 'Divider',   icon: '―', desc: 'Horizontal separator',         defaultW: 300, defaultH: 20 },
  { type: 'footer',   label: 'Footer',    icon: '⌄', desc: 'Footer section',               defaultW: 360, defaultH: 90 },
  { type: 'icon',     label: 'Icon',      icon: '◈', desc: 'Small icon / symbol',          defaultW: 40,  defaultH: 40 },
];

export const TYPE_MAP = Object.fromEntries(BLOCK_TYPES.map(b => [b.type, b]));

// Default editable properties per block type (the "panels" the user edits)
export const DEFAULT_PROPS = {
  navbar:   { title: 'My App', links: 'Home\nAbout\nContact' },
  hero:     { heading: 'Welcome to My App', subtext: 'A short, catchy description goes here.', cta: 'Get Started' },
  heading:  { text: 'Section Heading' },
  text:     { text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. This is placeholder text.' },
  button:   { label: 'Click Me', style: 'primary' },
  image:    { src: '', alt: 'Image description' },
  card:     { title: 'Card Title', body: 'Card body text goes here. Add more details about this item.', image: false },
  list:     { items: 'First item\nSecond item\nThird item' },
  gallery:  { images: 4, caption: false },
  form:     { fields: 'name\nemail', button: 'Submit' },
  video:    { url: '', caption: '' },
  divider:  { style: 'solid' },
  footer:   { text: '© 2026 My App. All rights reserved.', links: 'Imprint\nPrivacy' },
  icon:     { symbol: '⚡', label: '' },
};

export const COLOR_PRESETS = ['#3b82f6', '#22c55e', '#ef4444', '#f59e0b', '#8b5cf6', '#10b981',
  '#f43f5e', '#0ea5e9', '#64748b', '#f97316', '#84cc16', '#a855f7'];

export const FONT_PRESETS = ['Inter', 'System', 'Georgia', 'Space Grotesk', 'Poppins'];

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function newScreen(name) {
  return { id: uid(), name: name || 'New Screen', blocks: [], connections: [], bg: '#ffffff', textColor: '#111827' };
}

export function newBlock(type, x = 0, y = 0) {
  const t = TYPE_MAP[type];
  return {
    id: uid(), type, x, y,
    w: t ? t.defaultW : 200, h: t ? t.defaultH : 60,
    props: JSON.parse(JSON.stringify(DEFAULT_PROPS[type] || {})),
  };
}

// ---------------------------------------------------------------------------
// UX rule engine — scans a board and produces suggestions (the "Architect").
// Each suggestion can be applied to the board (applySuggestion) and undone.
// ---------------------------------------------------------------------------

const has = (screen, type) => screen.blocks.some(b => b.type === type);

export function generateSuggestions(board) {
  const out = [];
  for (const screen of board) {
    const blocks = screen.blocks;

    // Missing closing section
    if (has(screen, 'navbar') && !has(screen, 'footer'))
      out.push(sugg('footer', screen.id, 'Add a footer', 'This screen has a navbar but no footer. Visually unbalanced.', { type: 'footer' }));

    // Hero without CTA button
    if (has(screen, 'hero') && !has(screen, 'button') && !has(screen, 'form'))
      out.push(sugg('cta', screen.id, 'Add a call-to-action button', 'A hero usually needs a primary button below it. One click to add it.', { type: 'button', props: { label: 'Get Started', style: 'primary' } }));

    // Contact / imprint screen flow
    if (board.length >= 2 && !board.some(s => /contact|impress|about/i.test(s.name)))
      out.push(sugg('about', screen.id, 'Add an "About" screen', 'Multi-screen apps benefit from an About/Contact screen for trust.', null, null, 'A new screen "About" connected from the first screen.'));

    // Form without fields
    const form = blocks.find(b => b.type === 'form');
    if (form && (!form.props.fields || form.props.fields.trim() === ''))
      out.push(sugg('formfields', screen.id, 'Add form fields', 'Your form has no input fields yet.', { id: form.id, type: 'form', props: { fields: 'name\nemail' } }));
  }

  // Empty board
  if (board.length === 0)
    out.push(sugg('start', null, 'Start with a screen', 'Boards begin with at least one screen. Click to add a "Home" screen.', null, null, 'A screen "Home" with a hero, button and footer.'));

  return out;
}

function sugg(id, screenId, title, desc, apply, targetScreenId, note) {
  return { id: uid(), ruleId: id, screenId, title, desc, apply, targetScreenId, note };
}

export function applySuggestion(board, suggestion) {
  const next = JSON.parse(JSON.stringify(board));

  if (suggestion.ruleId === 'start') {
    const s = newScreen('Home');
    s.blocks.push(newBlock('hero', 10, 10));
    s.blocks.push(newBlock('button', 130, 170));
    next.push(s);
    return { board: next, screenId: s.id };
  }

  const screen = next.find(s => s.id === suggestion.screenId);
  if (!screen) return { board: next, screenId: null };

  if (suggestion.ruleId === 'about') {
    const s = newScreen('About');
    s.blocks.push(newBlock('heading', 10, 10));
    s.blocks.push(newBlock('text', 10, 60));
    s.blocks.push(newBlock('button', 10, 160));
    const from = screen.id;
    screen.connections.push({ to: s.id });
    next.push(s);
    return { board: next, screenId: s.id };
  }

  let target = screen;
  if (suggestion.targetScreenId) target = next.find(s => s.id === suggestion.targetScreenId) || screen;

  if (suggestion.apply?.props?.id) {
    const blk = target.blocks.find(b => b.id === suggestion.apply.props.id);
    if (blk) Object.assign(blk.props, suggestion.apply.props);
  } else {
    const blk = newBlock(suggestion.apply.type, 10 + target.blocks.length * 12, 10 + target.blocks.length * 12);
    if (suggestion.apply.props) Object.assign(blk.props, suggestion.apply.props);
    target.blocks.push(blk);
  }

  return { board: next, screenId: target.id };
}

// ---------------------------------------------------------------------------
// Export: the "Go" plan — JSON spec + human-readable markdown brief.
// ---------------------------------------------------------------------------

export function exportPlan(board, appName) {
  const cleaned = board.map(s => ({
    id: s.id,
    name: s.name,
    bg: s.bg,
    textColor: s.textColor,
    connections: s.connections,
    blocks: s.blocks.map(b => ({ type: b.type, x: b.x, y: b.y, w: b.w, h: b.h, props: b.props })),
  }));

  const md = buildMarkdown(board, appName);
  return { json: JSON.stringify({ app: appName || 'Untitled App', screens: cleaned }, null, 2), markdown: md };
}

function buildMarkdown(board, appName) {
  const lines = [];
  lines.push(`# ${appName || 'Untitled App'} — Build Specification`);
  lines.push('');
  lines.push('**Generated by WebLab.** This is the complete plan for the app. Build it exactly as described.');
  lines.push('');
  lines.push(`## Overview\n- ${board.length} screen(s): ${board.map(s => s.name).join(', ')}`);
  lines.push('');
  board.forEach((s, i) => {
    lines.push(`## Screen ${i + 1}: ${s.name}`);
    lines.push(`- Background: ${s.bg} · Text color: ${s.textColor}`);
    if (s.connections.length) lines.push(`- Connects to: ${s.connections.map(c => board.find(x => x.id === c.to)?.name || '?').join(', ')}`);
    if (!s.blocks.length) { lines.push('- (empty — no blocks yet)'); return; }
    lines.push('### Blocks, top to bottom:');
    s.blocks.slice().sort((a, b) => a.y - b.y).forEach(b => {
      const p = b.props || {};
      const desc = propsToText(b.type, p);
      lines.push(`- **${TYPE_MAP[b.type]?.label || b.type}**${desc ? ': ' + desc : ''}`);
    });
    lines.push('');
  });
  if (!board.length) lines.push('_No screens yet._');
  lines.push('---');
  lines.push('Build this plan 1:1. Only basic static HTML/CSS/JS is expected unless a feature explicitly requires a backend.');
  return lines.join('\n');
}

function propsToText(type, p) {
  const t = TYPE_MAP[type]?.label || type;
  switch (type) {
    case 'text': case 'heading': return p.text || '';
    case 'button': return p.label || '';
    case 'navbar': return p.title + (p.links ? ' [' + p.links.split('\n').join(' · ') + ']' : '');
    case 'hero': return (p.heading || '') + (p.subtext ? ' — ' + p.subtext : '') + (p.cta ? ' [CTA: ' + p.cta + ']' : '');
    case 'card': return p.title || '';
    case 'list': return p.items ? p.items.split('\n').slice(0, 3).join(', ') + (p.items.split('\n').length > 3 ? '…' : '') : '';
    case 'form': return 'fields: ' + (p.fields || '').split('\n').join(', ') + (p.button ? ' → button: ' + p.button : '');
    case 'gallery': return p.images + ' images' + (p.caption ? ', captions' : '');
    case 'footer': return p.text || '';
    case 'image': return p.alt || '(image)';
    case 'video': return p.url || '(video)';
    default: return '';
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const LS_BOARDS = 'weblab.boards.v1';

export function loadBoards() {
  try { return JSON.parse(localStorage.getItem(LS_BOARDS)) || []; }
  catch { return []; }
}

export function saveBoards(boards) {
  try { localStorage.setItem(LS_BOARDS, JSON.stringify(boards)); } catch {}
}

export function newBoard(name) {
  return { id: uid(), name: name || 'Untitled Board', screens: [], updatedAt: Date.now() };
}