// terminal.js — the field terminal (v2.0.6): a small scrollback screen with a prompt that reads back what the file has of you.
//
// It grows out of the field console (the Enter line): the line keeps working as it does, and a terminal word typed there hands off here.
// HELD, NOT MODAL: nothing pauses, the world runs; game.js sets chatOpen while it is up, so every gate the line holds holds for it too.
// What it reads back is already found: m.'s pages read (in the order found, across walks and rooms: the casebook, casebook.js), the
// station's groups heard this session, the cache words picked up, what the lost and the drawers said, the sights and the dens, floor by
// floor, the open case as far as it is read (recover-seal.js), a log of the building's recent lines and a margin you write yourself.
//
// Nothing here is drawn per frame and nothing goes on the wire. Pure but for createTermCard (the DOM, mapcard.js style). game.js builds
// the `view` per command — never per frame:
//   { scraps, names, book (casebook.view()), readSet, redacted, radio: { mask, groups, ledgerHeard },
//     texts: { npc, statusPools, drawers, first: { note, soul, room }, sights, phrases }, floorNames, floor, onBlock, log, photoIdx,
//     site, notes: [{ title, text }] }
// run(parseTermLine(raw), view) -> { rows: [{ t, cls }], effect: null | { kind, arg } }: the rows print, game.js runs the effect
// ('pass' to handleCommand, 'notes', 'file', 'where', 'exit', 'clear', 'jot', 'strike').
//
// Two rules keep it from telling more than it has: a locked word gets the UNKNOWN reply byte for byte as nonsense does (known() is the
// unlock rule), and a filing's answer is never echoed, kept in the history, printed or stored (parseTermLine masks it; the gate is shared
// with the line: createFilingGate).
import { SEALED_TEXT, REDACTED_FOOT } from './papercard.js'
import { pagesGiven } from './status.js'
import { words as countWord } from './compose-radio.js'
import { LEDGER_LABEL } from './closings.js'

// ── the strings ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// VOICE REVIEW: every line below is new in v2.0.6 and waits for the owner's voice pass (terminal-spec §6). Prose: lowercase, no '!', no
// digits, no number words, ends with a period (test/terminal.test.js lints it). The HUD ones are said through showMessage by game.js.
export const TERM = Object.freeze({
  BANNER: 'the terminal reads back what the file has of you. it never writes down an answer.',
  FIRST_KEEP: 'the file keeps a copy. the terminal reads it back.',                        // HUD, once (the casebook's first find)
  UNKNOWN: 'the terminal does not know that word. type help.',
  HELP_HEAD: 'it answers to these.',
  NOT_STANDING: 'the terminal waits for you to stand.',                                    // HUD
  PAGES_HEAD: "m.'s pages, in the order you found them.",
  PAGES_NONE: "the file has none of m.'s pages from you yet.",
  PAGES_SEALED: 'the file keeps them sealed.',
  READ_WHICH: 'read which. the names are in pages.',
  NO_NAME: 'the file holds nothing by that name.',
  READ_FOOT: 'a copy. the page itself is where you left it.',
  RADIO_HEAD: "the station's groups, as you heard them.",
  RADIO_WENT_BY: 'some of its count went by without you.',
  RADIO_WAKE: 'the station counts from the start each time you wake. so does this.',
  WORDS_HEAD: 'what you picked up, and who left it.',
  VOICES_LOST: 'what the lost told you.',
  VOICES_DRAWERS: 'what the drawers held.',
  VOICES_THREAD: 'the note by the cone, and what came of it.',
  SIGHTS_HEAD: 'what you saw, and where.',
  DENS_HEAD: 'what the film caught, and where it keeps.',
  FLOORS_HEAD: 'what you found, floor by floor.',
  FLOORS_NONE: 'the file has nothing from any floor yet.',
  WHERE_NONE: 'the file holds nothing from here.',
  WHERE_CASE: 'the open case can be read from here.',
  GREP_SHORT: 'give it more than that.',
  GREP_NONE: 'nothing you found has that word.',
  GREP_MORE: 'there is more. give it another word.',
  NOTES_OPEN: 'open. file it when you have it.',
  NOTES_PLACE: 'this one is read at a place. the board has it.',
  NOTE_COPY: "this machine's copy.",
  NOTE_SHUT: 'its note does not open on this machine. the board can take the answer again.',
  HONOUR_BADGE: 'filed from its floor.',
  CLOSING_HEAD: 'the closing file.',
  REWARD_SHUT: 'the closing file is sealed to this machine. the board opens it with your answers.',
  REWARD_NOCRYPTO: 'this machine cannot open a sealed file.',
  REWARD_ERR: 'the closing file would not open.',
  FILE_READING: 'reading it against the record.',                                          // HUD
  FILE_WAIT: 'the office is still reading your last filing.',                              // HUD
  FILE_NOKEY: 'filed. this machine could not keep the key.',                               // HUD, after the filed line
  FILE_HONOUR: 'filed where it was meant to be read. the file notes where.',               // HUD
  CASE_CLOSED: 'the case is read. the terminal keeps its closing file.',                   // HUD, in place of the closing key
  LOG_HEAD: 'what the building said, lately. it keeps no more than this.',
  LOG_NONE: 'the building has said nothing to you yet.',
  JOT_WHAT: 'jot what.',
  JOT_OK: 'in the margin.',
  JOT_FULL: 'the margin is full. strike a line first.',
  MARGIN_HEAD: 'your lines. the file does not read them.',
  MARGIN_NONE: 'the margin is empty.',
  STRUCK: 'struck.',
  STRIKE_NONE: 'no line in the margin has that word.',
  NO_LINKS: 'the terminal does not hand out links. the line does.',
  FILM: 'the file does not keep your film. you were asked to transcribe it.',              // only after a letter developed this session
})

// VOICE REVIEW: the chrome — labels, readout templates ({name} slots), the help rows and the settings row (out of fiction, sentence case).
// Templates and labels, so outside the prose lint; index.html carries the hint span and the line's placeholder addition (a test holds
// them equal to these).
export const TERM_CHROME = Object.freeze({
  TITLE: 'field terminal',
  CLOSE_HINT: 'tap · ` · esc — put it away',
  PLACEHOLDER: 'help · notes · status · log',
  PROMPT: '{floor} ›',
  ECHO: '› {line}',
  ECHO_FILE: '› file · · ·',
  HINT_SPAN: '` terminal',
  CHAT_PLACEHOLDER: ' · /term',
  BOARD: 'the board at /recover/ keeps the rest.',
  PAGE_COUNT: '{n} of twenty-six pages in the file.',
  PAGE_EARLIER: '{name} · an earlier walk',
  PAGE_GIVEN_UP: '{sealed} · given up',
  WORD_MINE: '{phrase} · {floor} · yours',
  WORD_BY: '{phrase} · {floor} · left by {name}',
  WORD_SOMEONE: '{phrase} · {floor} · left by someone',
  SIGHT_ROW: '{sight} · {floor} — {line}',
  DEN_ROW: 'the {kind} · {floor}',
  FLOOR_PARTS: Object.freeze({ pages: ' · pages {n}', voices: ' · voices {n}', words: ' · words {n}', sights: ' · sights {n}' }),
  FLOOR_UNKNOWN: 'somewhere the file did not write down',
  GREP_ROW: '{section} · {name} · …{snippet}…',
  GREP_SECTIONS: Object.freeze({ pages: 'pages', voices: 'voices', words: 'words', sights: 'sights', margin: 'margin', notes: 'notes' }),
  GREP_NAMES: Object.freeze({ lost: 'the lost', drawer: 'a drawer', thread: 'the thread', margin: 'yours' }),
  READ_BY: 'read it by · {parity}',
  ASKS_FOR: 'it asks for · {prompt}',
  READ_DONE: '{title} — read.',
  RADIO_ROW: '{group}   [{i}/{n}]',
  // the help rows, each with the word that unlocks it (known())
  HELP: Object.freeze([
    Object.freeze(['pages', "pages · m.'s pages you have read"]),
    Object.freeze(['read', 'read <name> · one of them again']),
    Object.freeze(['radio', "radio · the station's groups, as you heard them"]),
    Object.freeze(['words', 'words · what you picked up with things']),
    Object.freeze(['voices', 'voices · what was said to you']),
    Object.freeze(['sights', 'sights · what you saw']),
    Object.freeze(['floors', 'floors · what you found, floor by floor']),
    Object.freeze(['where', 'where · this floor, as the file has it']),
    Object.freeze(['grep', 'grep <word> · that word, across what you found']),
    Object.freeze(['notes', 'notes · the open case, as far as you have read it']),
    Object.freeze(['file', 'file <answer> · an answer, for the open instrument']),
    Object.freeze(['recover', 'recover · cases · intake · status · as on the line']),
    Object.freeze(['jot', 'jot <words> · a line in the margin']),
    Object.freeze(['margin', 'margin · your lines']),
    Object.freeze(['strike', 'strike <word> · a line out of the margin']),
    Object.freeze(['log', 'log · what the building said lately']),
    Object.freeze(['clear', 'clear · exit']),
  ]),
  SETTINGS_FORGET: 'Forget what the terminal kept',
  SETTINGS_FORGET_HINT: "Clears the terminal's record on this device. Your file, your save and your case marks stay.",
  SETTINGS_FORGET_AGAIN: 'Press again to forget it.',
  SETTINGS_FORGOTTEN: 'Forgotten.',
})

// a template's {slots} filled; a value is spliced verbatim (a function replacer: no `$` pattern in a name is read)
export function fill(tpl, vars) { return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m)) }
const C = TERM_CHROME
const row = (t, cls = 't-out') => ({ t: String(t), cls })

// ── the words ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// typed on the Enter line (with the slash), these open the terminal and run there
export const TERM_WORDS = Object.freeze(['term', 'terminal', 'help', 'pages', 'read', 'radio', 'words', 'voices', 'sights', 'floors', 'where', 'grep',
  'notes', 'log', 'jot', 'margin', 'strike'])
// always known (§3.4); the rest unlock with the first find of their kind
export const ALWAYS_KNOWN = Object.freeze(['help', 'notes', 'recover', 'cases', 'file', 'intake', 'status', 'log', 'where', 'floors', 'jot', 'margin',
  'strike', 'clear', 'exit'])
const PASS = new Set(['recover', 'cases', 'intake', 'status'])
const OPENERS = new Set(['term', 'terminal'])
const TERM_WORD_SET = new Set(TERM_WORDS)

export function termWord(line) {
  const t = String(line == null ? '' : line).trim()
  if (t[0] !== '/') return false
  const w = t.slice(1).split(/\s+/)[0].toLowerCase()
  return TERM_WORD_SET.has(w)
}
export const isOpener = (cmd) => OPENERS.has(cmd)

const ECHO_MAX = 80
// raw -> { cmd, arg, echo, line }: the slash optional, the word lowercased, the argument as typed; a filing echoes masked
export function parseTermLine(raw) {
  const line = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  const bare = line[0] === '/' ? line.slice(1).trim() : line
  const sp = bare.search(/\s/)
  const cmd = (sp < 0 ? bare : bare.slice(0, sp)).toLowerCase()
  const arg = sp < 0 ? '' : bare.slice(sp + 1).trim()
  let echo
  if (cmd === 'file') echo = C.ECHO_FILE
  else {
    const shown = line.length > ECHO_MAX - 2 ? line.slice(0, ECHO_MAX - 3) + '…' : line
    echo = fill(C.ECHO, { line: shown })
  }
  return { cmd, arg, echo, line: cmd === 'file' ? '' : line }
}

// 'level 2 — pipe dreams' -> 'pipe dreams' (no digit in the prompt)
export function floorWord(name) {
  const s = String(name == null ? '' : name), i = s.indexOf(' — ')
  return i < 0 ? s : s.slice(i + 3)
}

// one slug per page: its first words, letters only, hyphen-joined, as many words as it takes to be unique; stable (pure of the text)
export function pageNames(scraps) {
  const taken = new Set(), out = []
  const list = Array.isArray(scraps) ? scraps : []
  for (let i = 0; i < list.length; i++) {
    const w = String(list[i] ?? '').toLowerCase().split(/\s+/).map((x) => x.replace(/[^a-z]/g, '')).filter(Boolean)
    let n = Math.min(3, w.length), s = w.slice(0, n).join('-') || 'page'
    while (taken.has(s) && n < w.length) s = w.slice(0, ++n).join('-')
    let k = 0, base = s
    while (taken.has(s)) s = base + '-' + 'abcdefghijklmnopqrstuvwxyz'[k++ % 26]
    taken.add(s); out.push(s)
  }
  return Object.freeze(out)
}

const hasFinds = (b) => b.pages.length > 0 || b.souls.length > 0 || b.drawers.length > 0 || b.thread > 0 || b.caches.length > 0 ||
  b.sights.length > 0 || b.dens.length > 0 || b.margin.length > 0
// the unlock rule (§3.4): the words this view answers to, in help's order
export function known(view) {
  const b = view.book, red = view.redacted || []
  const out = ALWAYS_KNOWN.slice()
  if (b.pages.length || red.length) out.push('pages', 'read')
  if ((view.radio && view.radio.mask) || (view.radio && view.radio.ledgerHeard)) out.push('radio')
  if (b.caches.length) out.push('words')
  if (b.souls.length || b.drawers.length || b.thread > 0) out.push('voices')
  if (b.sights.length || b.dens.length) out.push('sights')
  if (hasFinds(b)) out.push('grep')
  return Object.freeze(out)
}

// ── the readouts ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const floorOf = (view, lv) => (Number.isInteger(lv) && lv >= 0 && lv < view.floorNames.length ? view.floorNames[lv] : C.FLOOR_UNKNOWN)
const wordOf = (n) => (n === 0 ? 'zero' : countWord(n))
const soulText = (view, s) => (s.k === 0 ? view.texts.npc[s.i] : (view.texts.statusPools[s.k - 1] || [])[s.i])
function threadTexts(view) {
  const f = view.texts.first, n = view.book.thread, out = []
  if (n >= 1) out.push(f.note)
  if (n >= 2) out.push(f.soul)
  if (n >= 3) out.push(f.room)
  return out
}
const uniq = (list) => { const seen = new Set(), out = []; for (const x of list) if (x && !seen.has(x)) { seen.add(x); out.push(x) } return out }
const voicesLost = (view) => uniq(view.book.souls.map((s) => soulText(view, s)))
const voicesDrawers = (view) => uniq(view.book.drawers.map((d) => view.texts.drawers[d.i]))

function pagesRows(view) {
  const b = view.book, red = view.redacted || [], rows = [row(TERM.PAGES_HEAD)]
  let n = 0
  const seen = new Set()
  for (const p of b.pages) {
    seen.add(p.frag); n++
    if (red.includes(p.frag)) rows.push(row(fill(C.PAGE_GIVEN_UP, { sealed: SEALED_TEXT })))
    else rows.push(row(view.readSet && view.readSet.has(p.frag) ? view.names[p.frag] : fill(C.PAGE_EARLIER, { name: view.names[p.frag] })))
  }
  for (const f of red) if (!seen.has(f)) { seen.add(f); n++; rows.push(row(fill(C.PAGE_GIVEN_UP, { sealed: SEALED_TEXT }))) }
  if (n === 0) return [row(TERM.PAGES_NONE)]
  rows.push(row(fill(C.PAGE_COUNT, { n: wordOf(n) }), 't-dim'))
  if (red.length) { rows.push(row(pagesGiven(red.length) + '.', 't-dim')); rows.push(row(TERM.PAGES_SEALED, 't-dim')) }
  return rows
}
function readRows(view, arg) {
  const want = String(arg || '').trim().toLowerCase()
  if (!want) return [row(TERM.READ_WHICH)]
  const frag = view.names.indexOf(want)
  const red = view.redacted || []
  if (frag < 0 || !(view.book.pages.some((p) => p.frag === frag) || red.includes(frag))) return [row(TERM.NO_NAME)]
  if (red.includes(frag)) return [row(SEALED_TEXT, 't-page'), row(REDACTED_FOOT, 't-dim')]
  return [row(view.scraps[frag], 't-page'), row(TERM.READ_FOOT, 't-dim')]
}
function radioRows(view) {
  const r = view.radio, g = r.groups, rows = [row(TERM.RADIO_HEAD)]
  let all = true
  for (let i = 0; i < g.length; i++) {
    if (r.mask & (1 << i)) rows.push(row(fill(C.RADIO_ROW, { group: g[i], i: i + 1, n: g.length }), 't-page'))
    else all = false
  }
  if (r.ledgerHeard) { rows.push(row(LEDGER_LABEL + '.', 't-dim')); if (!all) rows.push(row(TERM.RADIO_WENT_BY, 't-dim')) }
  rows.push(row(TERM.RADIO_WAKE, 't-dim'))
  return rows
}
function wordsRows(view) {
  const rows = [row(TERM.WORDS_HEAD)]
  for (const c of view.book.caches) {
    const v = { phrase: view.texts.phrases[c.ph], floor: floorOf(view, c.lv), name: c.by }
    rows.push(row(fill(c.mine ? C.WORD_MINE : c.by ? C.WORD_BY : C.WORD_SOMEONE, v), 't-page'))
  }
  return rows
}
function voicesRows(view) {
  const rows = []
  const lost = voicesLost(view), drawers = voicesDrawers(view), thread = threadTexts(view)
  if (lost.length) { rows.push(row(TERM.VOICES_LOST)); for (const t of lost) rows.push(row(t, 't-page')) }
  if (drawers.length) { rows.push(row(TERM.VOICES_DRAWERS)); for (const t of drawers) rows.push(row(t, 't-page')) }
  if (thread.length) { rows.push(row(TERM.VOICES_THREAD)); for (const t of thread) rows.push(row(t, 't-page')) }
  return rows
}
function sightsRows(view) {
  const b = view.book, S = view.texts.sights, rows = [row(TERM.SIGHTS_HEAD)]
  for (const s of b.sights) { const d = S[s.type]; if (d) rows.push(row(fill(C.SIGHT_ROW, { sight: d.name, floor: floorOf(view, s.lv), line: d.line }), 't-page')) }
  if (b.dens.length) { rows.push(row(TERM.DENS_HEAD)); for (const d of b.dens) rows.push(row(fill(C.DEN_ROW, { kind: d.kind, floor: floorOf(view, d.lv) }), 't-page')) }
  return rows
}
// the floor's row, or null when the file has nothing from it (the block never has)
function floorRow(view, lv) {
  const b = view.book, at = (e) => e.lv === lv
  const n = { pages: b.pages.filter(at).length, voices: b.souls.filter(at).length + b.drawers.filter(at).length,
    words: b.caches.filter(at).length, sights: b.sights.filter(at).length + b.dens.filter(at).length }
  let s = ''
  for (const k of ['pages', 'voices', 'words', 'sights']) if (n[k] > 0) s += fill(C.FLOOR_PARTS[k], { n: wordOf(n[k]) })
  return s ? view.floorNames[lv] + s : null
}
// (floorNames are the floors the casebook can tag, 0..3: the block is never one of them)
function floorsRows(view) {
  const rows = []
  for (let lv = 0; lv < view.floorNames.length; lv++) { const r = floorRow(view, lv); if (r) rows.push(row(r, 't-page')) }
  return rows.length ? [row(TERM.FLOORS_HEAD), ...rows] : [row(TERM.FLOORS_NONE)]
}
function whereRows(view) {
  const r = view.onBlock ? null : floorRow(view, view.floor)
  return [r ? row(r, 't-page') : row(TERM.WHERE_NONE)]
}

const GREP_MAX = 6, SNIP = 24
function snippet(text, i, len) {
  const t = String(text).replace(/\s+/g, ' ')
  const a = Math.max(0, i - SNIP), b = Math.min(t.length, i + len + SNIP)
  return t.slice(a, b).trim()
}
// what grep may read: only what is already found (never a radio group, a caption, a locked clue or an unread page)
function grepCorpus(view) {
  const b = view.book, red = view.redacted || [], S = C.GREP_SECTIONS, N = C.GREP_NAMES, out = []
  for (const p of b.pages) if (!red.includes(p.frag)) out.push([S.pages, view.names[p.frag], view.scraps[p.frag]])
  for (const t of voicesLost(view)) out.push([S.voices, N.lost, t])
  for (const t of voicesDrawers(view)) out.push([S.voices, N.drawer, t])
  for (const t of threadTexts(view)) out.push([S.voices, N.thread, t])
  for (const c of b.caches) out.push([S.words, floorOf(view, c.lv), view.texts.phrases[c.ph]])
  for (const s of b.sights) { const d = view.texts.sights[s.type]; if (d) out.push([S.sights, d.name, d.line]) }
  for (const m of b.margin) out.push([S.margin, N.margin, m])
  for (const n of view.notes || []) out.push([S.notes, n.title, n.text])
  return out
}
function grepRows(view, arg) {
  const want = String(arg || '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (!/[a-z]{3,}/.test(want)) return [row(TERM.GREP_SHORT)]
  const hits = []
  for (const [section, name, text] of grepCorpus(view)) {
    if (typeof text !== 'string') continue
    const i = text.toLowerCase().replace(/\s+/g, ' ').indexOf(want)
    if (i >= 0) hits.push(fill(C.GREP_ROW, { section, name, snippet: snippet(text, i, want.length) }))
  }
  if (!hits.length) return [row(TERM.GREP_NONE)]
  const rows = hits.slice(0, GREP_MAX).map((h) => row(h, 't-page'))
  if (hits.length > GREP_MAX) rows.push(row(TERM.GREP_MORE, 't-dim'))
  return rows
}
function helpRows(view) {
  const k = known(view), rows = [row(TERM.HELP_HEAD)]
  for (const [w, line] of C.HELP) if (k.includes(w)) rows.push(row(line, 't-dim'))
  return rows
}
function logRows(view) {
  const log = view.log || []
  if (!log.length) return [row(TERM.LOG_NONE)]
  return [row(TERM.LOG_HEAD), ...log.map((t) => row(t, 't-sys'))]
}
function marginRows(view) {
  const m = view.book.margin
  return m.length ? [row(TERM.MARGIN_HEAD), ...m.map((t) => row(t, 't-page'))] : [row(TERM.MARGIN_NONE)]
}
export const jotRows = (r) => [row(r === 'ok' ? TERM.JOT_OK : r === 'full' ? TERM.JOT_FULL : TERM.JOT_WHAT)]
export const strikeRows = (ok) => [row(ok ? TERM.STRUCK : TERM.STRIKE_NONE)]
const unknownRows = () => [row(TERM.UNKNOWN)]

// one parsed line against one view -> the rows to print (the echo first) and the effect game.js runs
export function run(p, view) {
  const rows = [row(p.echo, 't-in')]
  const cmd = p.cmd
  const out = (more, effect = null) => { for (const r of more) rows.push(r); return { rows, effect } }
  if (!cmd || OPENERS.has(cmd)) return out([])
  if (cmd === 'invite') return out([row(TERM.NO_LINKS)])                  // a link that can carry a pin never lands here
  if (cmd === 'film') return out(view.photoIdx > 0 ? [row(TERM.FILM)] : unknownRows())
  if (cmd === 'exit') return out([], { kind: 'exit', arg: '' })
  if (!known(view).includes(cmd)) return out(unknownRows())
  switch (cmd) {
    case 'help': return out(helpRows(view))
    case 'pages': return out(pagesRows(view))
    case 'read': return out(readRows(view, p.arg))
    case 'radio': return out(radioRows(view))
    case 'words': return out(wordsRows(view))
    case 'voices': return out(voicesRows(view))
    case 'sights': return out(sightsRows(view))
    case 'floors': return out(floorsRows(view))
    case 'where': return out(whereRows(view), view.onBlock ? null : { kind: 'where', arg: '' })
    case 'grep': return out(grepRows(view, p.arg))
    case 'log': return out(logRows(view))
    case 'margin': return out(marginRows(view))
    case 'notes': return out([], { kind: 'notes', arg: p.arg })
    case 'file': return out([], { kind: 'file', arg: p.arg })
    case 'jot': return out([], { kind: 'jot', arg: p.arg })
    case 'strike': return out([], { kind: 'strike', arg: p.arg })
    case 'clear': return out([], { kind: 'clear', arg: '' })
  }
  if (PASS.has(cmd)) return out([], { kind: 'pass', arg: p.arg })
  return out(unknownRows())
}

// Tab: the word, or a page name after 'read ' — only ever from what known() and the visible names offer. -> the new line, or null
export function complete(line, view) {
  const s = String(line == null ? '' : line)
  const slash = s.trimStart()[0] === '/' ? '/' : ''
  const bare = s.trim().replace(/^\//, '')
  const sp = bare.search(/\s/)
  const pick = (cands, part) => {
    const m = cands.filter((c) => c.startsWith(part))
    if (!m.length) return null
    let pre = m[0]
    for (const c of m) while (!c.startsWith(pre)) pre = pre.slice(0, -1)
    return m.length === 1 ? m[0] : pre.length > part.length ? pre : null
  }
  const k = known(view)
  if (sp < 0) {
    const w = pick(k, bare.toLowerCase())
    return w == null ? null : slash + w + (k.includes(w) && bare.length <= w.length ? ' ' : '')
  }
  const cmd = bare.slice(0, sp).toLowerCase(), part = bare.slice(sp + 1).trim().toLowerCase()
  if (cmd !== 'read' || !k.includes('read')) return null
  const red = view.redacted || []
  const visible = view.book.pages.filter((p) => !red.includes(p.frag)).map((p) => view.names[p.frag])
  const n = pick(visible, part)
  return n == null ? null : slash + 'read ' + n
}

// ── the case ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// the floors a station says it can be read on (manifest .maze = { level | levels, hint }); the /recover rule
export const mazeFloors = (s) => (s && s.maze ? (Array.isArray(s.maze.levels) ? s.maze.levels : [s.maze.level]) : [])
// /recover's summary, byte for byte the line it always said (game.js)
export function caseLine(m, solved) {
  const done = m.stations.filter(s => solved(m.id, s.id)).length
  const next = m.stations.find(s => !solved(m.id, s.id))
  return m.title + ' — ' + done + ' of ' + m.stations.length + ' instruments read.' + (next ? ' next: ' + next.title + '.' : ' the case is read.')
}
// `where`'s second half: the open case's next instrument, when it says it is read on this floor (never the block)
export function whereCaseRows(m, solved, floor, onBlock) {
  if (onBlock || !m || !Array.isArray(m.stations)) return []
  const next = m.stations.find((s) => !solved(m.id, s.id))
  if (!next || !next.maze || !next.maze.hint || !mazeFloors(next).includes(floor)) return []
  return [row(TERM.WHERE_CASE), row(next.maze.hint, 't-page')]
}
// `notes [case]`: the case as far as it is read. The read marks and the completion are checked HERE, before either seal call: an unsealed
// manifest's openStation answers whatever the read state, and so does its openReward (recover-seal.js). It stops at the first instrument
// not read; what lies past it is only caseLine's n of m. Never read: where, link, geo, a reward's href or linkLabel.
export async function reviewCase(m, { solved, openStation, openReward, fieldComplete = () => false, honour = () => false, floor = null, onBlock = false,
  site = false, onNote = null } = {}) {
  const st = m && Array.isArray(m.stations) ? m.stations : []
  const rows = [row(caseLine({ ...m, stations: st }, solved))]
  let open = false
  for (const s of st) {
    if (!solved(m.id, s.id)) {
      open = true
      rows.push(row(TERM.NOTES_OPEN), row(s.title))
      if (Array.isArray(s.parity) && s.parity.length) rows.push(row(fill(C.READ_BY, { parity: s.parity.join(' · ') }), 't-dim'))
      if (s.prompt) rows.push(row(fill(C.ASKS_FOR, { prompt: s.prompt }), 't-dim'))
      if (s.geo) rows.push(row(TERM.NOTES_PLACE, 't-dim'))
      else if (s.clue) rows.push(row(s.clue, 't-page'))
      if (!onBlock && s.maze && s.maze.hint && mazeFloors(s).includes(floor)) rows.push(row(s.maze.hint, 't-page'))
      break
    }
    rows.push(row(fill(C.READ_DONE, { title: s.title })))
    const note = await openStation(m, s)
    if (note == null) rows.push(row(TERM.NOTE_SHUT, 't-dim'))
    else {
      rows.push(row(note.text, 't-page'))
      if (note.from === 'copy') rows.push(row(TERM.NOTE_COPY, 't-dim'))
      if (onNote) onNote(s.title, note.text)
    }
    if (honour(m.id, s.id)) rows.push(row(TERM.HONOUR_BADGE, 't-dim'))
  }
  if (open || !st.length) return rows
  const r = await openReward(m)
  if (r && r.reward) {
    const w = r.reward
    rows.push(row(TERM.CLOSING_HEAD), row(w.title))
    rows.push(row(fieldComplete(m) && typeof w.fieldText === 'string' && w.fieldText ? w.fieldText : w.text, 't-page'))
    if (w.key) rows.push(row(w.key, 't-page'))
    if (site) rows.push(row(C.BOARD, 't-dim'))
  } else if (r && r.missing) rows.push(row(TERM.REWARD_SHUT, 't-dim'))
  else if (r && r.unsupported) rows.push(row(TERM.REWARD_NOCRYPTO, 't-dim'))
  else if (r && r.error) rows.push(row(TERM.REWARD_ERR, 't-dim'))
  return rows
}

// ── the filing gate, shared by the line and the terminal ────────────────────────────────────────────────────────────────────────────
// Never faster than the board: every filing takes at least floorMs from the ask to its answer, and a miss holds the next ask off for
// firstMissMs, doubling to capMs; a hit resets it. It knows nothing of the answer, so nothing it says can vary by the guess. A reload
// starts it over (memory only). release() lets go of an ask that filed nothing (the case already read, no signal).
export function createFilingGate({ floorMs = 1500, firstMissMs = 4000, capMs = 32000 } = {}) {
  let busy = false, askedAt = -Infinity, until = -Infinity, nextMiss = firstMissMs
  return {
    ask(now) {
      if (busy) return { busy: true }
      if (now < until) return { waitMs: until - now }
      busy = true; askedAt = now
      return { ok: true }
    },
    settle(ok, now) {
      busy = false
      if (ok) { nextMiss = firstMissMs; until = -Infinity }
      else { until = now + nextMiss; nextMiss = Math.min(capMs, nextMiss * 2) }
    },
    release() { busy = false },
    floorLeft(now) { return Math.max(0, askedAt + floorMs - now) },
  }
}

// ── the line history (ArrowUp / ArrowDown): the last `cap` lines, never a filing, no repeat of the line before ────────────────────────
export function createHistory(cap = 12) {
  const lines = []
  let at = 0
  return {
    push(line) {
      const s = String(line == null ? '' : line).trim()
      at = lines.length
      if (!s || parseTermLine(s).cmd === 'file') return
      if (lines[lines.length - 1] === s) return
      lines.push(s)
      if (lines.length > cap) lines.shift()
      at = lines.length
    },
    up() { if (!lines.length) return null; at = Math.max(0, at - 1); return lines[at] },
    down() { if (at >= lines.length) return null; at++; return at >= lines.length ? '' : lines[at] },
    reset() { at = lines.length },
    clear() { lines.length = 0; at = 0 },
    size: () => lines.length,
  }
}

// ── the log: the building's last n lines, in a fixed ring of string refs (push allocates nothing; list fills the caller's array) ─────
export function createLogRing(n = 24) {
  const buf = new Array(n).fill(null)
  let head = 0, count = 0
  return {
    push(text) { buf[head] = text; head = (head + 1) % n; if (count < n) count++ },
    list(out) { out.length = 0; for (let i = 0; i < count; i++) out.push(buf[(head - count + i + n) % n]); return out },
    clear() { for (let i = 0; i < n; i++) buf[i] = null; head = 0; count = 0 },
    count: () => count,
    capacity: () => buf.length,
  }
}

// a HUD line the log (and the scrollback's copy) may keep: never the film's (a caption names a street, a pin, a letter), a link (an
// invite can carry a pin), the network line, or a line that carries the pin's own text. No allocation: called once per line shown
export function loggable(text, pinText = null) {
  if (typeof text !== 'string' || !text) return false
  if (text.startsWith('the film ')) return false
  if (text.indexOf('://') !== -1) return false
  if (text.startsWith('this room is on your network.')) return false
  if (pinText && text.indexOf(pinText) !== -1) return false
  return true
}

// ── the card (index.html #term): the DOM, textContent only; rows are made only when something prints, at most MAX_ROWS kept ────────
export const MAX_ROWS = 120
const NOOP_CARD = Object.freeze({ ok: false, open() {}, close() {}, print() {}, mirror() {}, clear() {}, setPrompt() {}, isOpen: () => false, focus() {} })

export function createTermCard(doc, { onSubmit = null, onClose = null, onTab = null, onHistory = null } = {}) {
  const el = doc && typeof doc.getElementById === 'function' ? doc.getElementById('term') : null
  if (!el) return NOOP_CARD
  const out = doc.getElementById('term-out'), input = doc.getElementById('term-input'), prompt = doc.getElementById('term-prompt')
  const title = doc.getElementById('term-title'), hint = doc.getElementById('term-close')
  if (title) title.textContent = C.TITLE
  if (hint) hint.textContent = C.CLOSE_HINT
  if (input) { input.placeholder = C.PLACEHOLDER; input.maxLength = 120 }
  let open = false
  const close = () => { if (onClose) onClose() }

  input?.addEventListener('keydown', (e) => {
    e.stopPropagation()                                           // the game never reads a key typed here
    const code = e.code
    if (code === 'Enter' || code === 'NumpadEnter' || (e.key === 'Enter' && !e.isComposing)) {
      e.preventDefault()
      const v = input.value
      input.value = ''
      if (onSubmit) onSubmit(v)
    } else if (code === 'Escape' || code === 'Backquote') { e.preventDefault(); if (!e.repeat) close() }   // (a held key does not fold it again)
    else if (code === 'Tab') { e.preventDefault(); const r = onTab ? onTab(input.value) : null; if (typeof r === 'string') input.value = r }
    else if (code === 'ArrowUp' || code === 'ArrowDown') {
      e.preventDefault()
      const r = onHistory ? onHistory(code === 'ArrowUp' ? -1 : 1) : null
      if (typeof r === 'string') input.value = r
    } else if (code === 'PageUp' || code === 'PageDown') {
      e.preventDefault()
      if (out) out.scrollTop += (code === 'PageUp' ? -1 : 1) * Math.max(40, (out.clientHeight || 0) * 0.9)
    }
  })
  hint?.addEventListener('pointerdown', (e) => { e.preventDefault?.(); e.stopPropagation?.(); close() })
  // a mouse press outside the panel folds it; a touch press does not (a thumb on the discs is play, not leaving)
  doc.addEventListener?.('pointerdown', (e) => {
    if (!open || e.pointerType !== 'mouse') return
    if (el.contains && el.contains(e.target)) return
    close()
  }, true)
  // a click in the scrollback that selects nothing gives the keys back to the input (a selection is left for copying)
  el.addEventListener?.('pointerup', (e) => {
    if (!open || e.target === hint) return
    const sel = typeof doc.getSelection === 'function' ? doc.getSelection() : null
    if (!sel || !String(sel)) input?.focus?.()
  })

  function print(rows) {
    if (!out || !rows || !rows.length) return
    const stick = !out.scrollHeight || out.scrollTop + (out.clientHeight || 0) >= out.scrollHeight - 4
    for (const r of rows) {
      const d = doc.createElement('div')
      d.className = r.cls || 't-out'
      d.textContent = r.t
      out.appendChild(d)
    }
    while (out.children.length > MAX_ROWS) out.removeChild(out.children[0])
    if (stick) out.scrollTop = out.scrollHeight
  }
  return {
    ok: true,
    open(p) {
      open = true
      el.style.display = 'flex'
      if (p != null && prompt) prompt.textContent = p
      if (input) { input.value = ''; input.focus?.() }
      if (out) out.scrollTop = out.scrollHeight
    },
    close() { open = false; el.style.display = 'none'; input?.blur?.() },
    print,
    mirror(text) { print([row(text, 't-sys')]) },
    clear() { if (out) while (out.children.length) out.removeChild(out.children[0]) },
    setPrompt(p) { if (prompt) prompt.textContent = p },
    isOpen: () => open,
    focus() { input?.focus?.() },
  }
}
