// WebLab v2 — Prompt Studio.
// Visual brainstorm chat with Hermes. The artifact is the PROMPT, not code.
// This module: data model, prompt builder, local rule engine (works without Hermes).

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

// The categories we probe during a brainstorm. They map to prompt sections.
export const CATEGORIES = [
  { id: 'idea',    label: 'Idee & Ziel',    short: 'Was ist es?' },
  { id: 'screens', label: 'Screens',        short: 'Welche Ansichten?' },
  { id: 'features',label: 'Features',       short: 'Was passiert bei…?' },
  { id: 'data',    label: 'Daten',          short: 'Wo liegen die Daten?' },
  { id: 'design',  label: 'Design-Stil',    short: 'Wie soll es wirken?' },
  { id: 'quality', label: 'Qualität',       short: 'Was darf nie fehlen?' },
]

// A brainstorm project.
export function newProject(name) {
  return {
    id: uid(),
    name: name || 'Untitled Project',
    idea: '',
    answers: {},        // categoryId -> accumulated text (from suggestions + user)
    customNotes: [],    // free-form user notes added to the prompt
    chat: [],           // chat messages (see shapes below)
    status: 'draft',    // draft | building | live
    liveUrl: '',
    updatedAt: Date.now(),
  }
}

// Chat message shapes:
// { id, role: 'user'|'hermes'|'system', kind: 'text'|'suggestions'|'status'|'build', text?, suggestions?, data? }

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export function buildPrompt(project) {
  const L = []
  const appName = project.name || 'Untitled App'
  L.push(`# ${appName}`)
  L.push('')
  L.push('Build this web app exactly as specified below. Do not add features that are not described. Do not change the described behavior. Use plain HTML/CSS/JS in one index.html unless told otherwise.')
  L.push('')
  L.push('## Core idea')
  L.push(project.idea.trim() || '*Not described yet.*')
  L.push('')

  for (const cat of CATEGORIES) {
    const val = (project.answers[cat.id] || '').trim()
    if (!val) continue
    L.push(`## ${cat.label}`)
    L.push(val)
    L.push('')
  }

  if (project.customNotes.length) {
    L.push('## Additional notes')
    project.customNotes.forEach(n => L.push('- ' + n))
    L.push('')
  }

  L.push('## Quality bar')
  const q = [
    'Responsive: must work on iPhone, iPad, and desktop.',
    'Clean, modern dark-friendly design with decent spacing.',
  ]
  if (!(project.answers.quality || '').toLowerCase().includes('dark'))
    q.push('Optional: dark mode toggle if the design suits it.')
  q.forEach(x => L.push('- ' + x))
  L.push('')
  L.push('Build it, host it on GitHub Pages, and return the live URL.')
  return L.join('\n')
}

// Compact one-line version of the prompt for quick review.
export function promptSummary(project) {
  const parts = [project.idea.trim()]
  for (const cat of CATEGORIES) if ((project.answers[cat.id] || '').trim()) parts.push((project.answers[cat.id] || '').trim())
  return parts.join(' · ').slice(0, 160)
}

// ---------------------------------------------------------------------------
// Local rule engine — generates suggestions WITHOUT calling Hermes.
// Returns an array of { id, categoryId, title, desc, apply(text) }.
// Applied suggestions append text to the category.
// ---------------------------------------------------------------------------

export function generateSuggestions(project) {
  const out = []
  const a = project.answers

  // --- idea ---
  if (!project.idea.trim()) {
    out.push(sugg('idea', 'idea', 'Was ist die Kern-Idee?',
      'Beschreibe kurz, was die App tun soll — am besten als ein Satz: "Eine Quiz-App über Hunde mit 20 Fragen".',
      null, 'idea'))
  } else {
    const words = project.idea.trim().split(/\s+/).length
    if (words < 8) out.push(sugg('idea-more', 'idea', 'Etwas ausführlicher?',
      'Deine Idee ist sehr kurz. Wer ist die App für? Welches Problem löst sie?', null, 'idea'))
  }

  // --- screens ---
  if (!a.screens) out.push(sugg('screens', 'screens', 'Welche Ansichten gibt es?',
    'Typisch: Home, Detail, Ergebnis. Nenne alle Ansichten, die die App braucht.',
    'Home, Detail/Ergebnis', 'screens'))
  else if (a.screens.trim().split(/[\n,]/).filter(s => s.trim()).length < 2)
    out.push(sugg('screens-2', 'screens', 'Eine Ansicht mehr?',
      'Die meisten Apps brauchen mindestens zwei Ansichten. Fehlt z.B. eine Ergebnis- oder Detail-Ansicht?',
      '\n- Ergebnis-Ansicht', 'screens'))

  // --- features ---
  if (!a.features) out.push(sugg('features', 'features', 'Welche Interaktionen?',
    'Was passiert bei einem Klick? Was bei leerem Formular? Zähler, Filter, Timer?',
    'Interaktionen: Button-Klicks, Formular-Absenden, Zähler', 'features'))
  else {
    const f = a.features.toLowerCase()
    if (!/(timer|zeit|countdown)/.test(f)) out.push(sugg('timer', 'features', 'Timer einbauen?',
      'Für Quizze/Spiele erhöht ein Timer Spannung. Soll es einen geben?', '\n- Timer pro Frage (Countdown)', 'features'))
    if (!/(punkt|score|rang|ergebnis|auswertung)/.test(f)) out.push(sugg('score', 'features', 'Punkte & Auswertung?',
      'Wie wird das Ergebnis festgehalten? Punkte, Ränge, Prozent?', '\n- Punkte zählen und Ergebnis auswerten', 'features'))
    if (!/(dark|dunkel|theme|farbe)/.test(f)) out.push(sugg('dark', 'features', 'Dark Mode?',
      'Viele Nutzer lieben Dark Mode. Soll die App ihn unterstützen?', '\n- Dark Mode (Umschalter)', 'features'))
  }

  // --- data ---
  if (!a.data) out.push(sugg('data', 'data', 'Wo liegen die Daten?',
    'Gibt es Daten (Quiz-Fragen, Einträge)? Wenn ja: im Browser (localStorage), nur im Code, oder später ein Backend?',
    'Daten liegen zunächst lokal im Browser (localStorage) bzw. direkt im Code.', 'data'))

  // --- design ---
  if (!a.design) out.push(sugg('design', 'design', 'Wie soll es aussehen?',
    'Stimmung, Farben, Vibe — z.B. "süß und verspielt, pastellfarben" oder "clean, minimalistisch, dunkel".',
    'Design: clean, minimalistisch, dunkel, modern', 'design'))
  else {
    const d = a.design.toLowerCase()
    if (!/(dunkel|dark|schwarz|dunkle)/.test(d)) out.push(sugg('design-dark', 'design', 'Dunkles Design?',
      'Passt ein dunkles Theme zu deiner App?', '\n- Dunkles Theme', 'design'))
    if (!/(farbe|farbschema|palette|bunt|pastell|farbig)/.test(d)) out.push(sugg('design-color', 'design', 'Farbschema festlegen?',
      'Ein konkretes Farbschema macht den Prompt deutlicher.', '\n- Farbschema: (z.B. Blau/Türkis-Akzente auf Dunkel)', 'design'))
  }

  // --- quality ---
  if (!a.quality) out.push(sugg('quality', 'quality', 'Qualitäts-Anforderungen?',
    'Was darf die KI nie vergessen? Responsive, Barrierefreiheit, Ladezeiten?',
    'Responsive auf iPhone/iPad/Desktop, saubere Semantik (semantische HTML-Tags, aria-labels), schnelle Ladezeit.', 'quality'))
  else {
    const q = a.quality.toLowerCase()
    if (!/(respons|handy|mobil|iphone|ipad)/.test(q)) out.push(sugg('q-resp', 'quality', 'Responsive erwähnen',
      'Deine Qualitäts-Kriterien erwähnen Mobile nicht explizit.', '\n- Responsive auf iPhone, iPad, Desktop', 'quality'))
    if (!/(barriere|aria|semantik|zugäng)/.test(q)) out.push(sugg('q-a11y', 'quality', 'Barrierefreiheit?',
      'Semantische HTML-Tags + aria-Labels machen die App zugänglich und die KI arbeitet sauberer.', '\n- Barrierefreiheit (semantische Tags, aria-labels)', 'quality'))
  }

  return out
}

function sugg(id, categoryId, title, desc, addText, target) {
  return { id, categoryId, title, desc, addText, target }
}

export function applySuggestion(project, s) {
  const text = s.addText ? s.addText : ''
  if (text) {
    const cur = project.answers[s.categoryId] || ''
    project.answers[s.categoryId] = (cur + (cur ? '\n' : '') + text).trim()
  }
  return project
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const LS = 'weblab.projects.v2'

export function loadProjects() {
  try { return JSON.parse(localStorage.getItem(LS)) || [] }
  catch { return [] }
}
export function saveProjects(projects) {
  try { localStorage.setItem(LS, JSON.stringify(projects)) } catch {}
}