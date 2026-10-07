// status.js — filed under: the column you want on your own file.
//
// The one owner of every status string. Four words (the notice you never answered,
// and the three you can ask for), the file that remembers which one you are under,
// and what each word inverts. Inversions, never stats: a status changes what a thing
// MEANS (the sour water, the film, the radio, the pages), not how much it costs.
//
// Pure and import-safe in Node and in the main process (main.js / tools read
// parseTrailer): prefs.js and scraps.js touch no DOM at import. The file is GLOBAL —
// it lives in prefs, not in the save — so every run and every room shares it.
// Per-frame reads (statusMods) return frozen singletons built once, here.

import { setPref } from './prefs.js'
import { SCRAPS } from './scraps.js'

export const STATUSES = Object.freeze(['notice-mailed', 'extension', 'compliance', 'litigation'])
export const DEFAULT_STATUS = 'notice-mailed'
export const CLOSINGS = Object.freeze(['extension', 'compliance', 'litigation'])
// the record's own words: only the trailer and the notice text are in capitals
export const STATUS_LABEL = Object.freeze({ 'notice-mailed': 'NOTICE MAILED', extension: 'EXTENSION', compliance: 'COMPLIANCE', litigation: 'LITIGATION' })
export const DAY_MS = 86_400_000

const STATUS_SET = new Set(STATUSES)
const CLOSING_SET = new Set(CLOSINGS)

export const STRINGS = Object.freeze({
  // the dialog's placeholder (index.html's 'speak.' today) and the origin's own
  PLACEHOLDER: 'speak.',
  PLACEHOLDER_PROCESSED: 'amend.',
  PLACEHOLDER_UNNAMED: 'the file cannot spell you.',
  // the three tappable lines under the dialog: the word before ' · ' is what gets typed
  STAMP_LINES: Object.freeze(['extension · let it stay open', 'compliance · close the file', 'litigation · contest it']),
  FILED: 'filed. the office will not confirm receipt.',
  NOTICE_UNANSWERED: 'a notice was mailed to you. you have not answered.',
  OFFICE_CLOSED: 'the office is closed. come back tomorrow.',
  REFILED: 'the office opens a new file. the old one is still closed.',
  NEW_NOTICE: 'a new notice is mailed to you. the old file is still closed.',
  SAME_STATUS: 'the file already has you under that word.',
  SOUR_ADVANCE: 'the water is sour. you have stopped tasting the difference. somewhere a line moves.',
  NPC_EXTENSION: 'you can stop looking for the stairs now.',
  NPC_COMPLIANCE: 'the thirteen who complied — nobody remembers them. that was the point.',
  NPC_LITIGATION: 'write it where the dark can read it. then write it again.',
  // closings.js's
  COMPLIANCE_CLOSED: 'the file reaches compliance. the fourteenth, in twenty-one years. the office does not celebrate.',
  SLIP_EXTENSION: 'notice 30150A. status: EXTENSION. twenty-two years. it is yours now, and it will not close.',
  // game.js's extension-slip line, byte for byte: what everyone who is not under the word reads
  SLIP_LEGACY: 'notice 30150A. status: EXTENSION — the one line the system never closed. a door left ajar it cannot foreclose. make your claim where the presence waits.',
})

// ── depth ───────────────────────────────────────────────────────────────────────────────────
// THE one depth helper, total over both domains: level.index 0..4 (4 is ∅) and
// cfg.levelIndex 0..3 | '∅'. The two never collide (4 is no levelIndex, '∅' no index).
export function depthOf(v) {
  if (v === '∅' || v === 4) return 0
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)
  if (!Number.isFinite(n)) return 0
  const t = Math.trunc(n)
  return t >= 0 && t <= 3 ? t + 0 : 0          // + 0: never a -0
}

// ── the file ────────────────────────────────────────────────────────────────────────────────
// { status, at (ms of the last filing | null), ledgerHeard, closing, redacted: frag[] }
export function loadFile(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const redacted = []
  if (Array.isArray(o.redacted)) {
    for (const f of o.redacted) if (Number.isInteger(f) && f >= 0 && f < SCRAPS.length && !redacted.includes(f)) redacted.push(f)
  }
  return {
    status: STATUS_SET.has(o.status) ? o.status : DEFAULT_STATUS,
    at: Number.isFinite(o.at) ? o.at : null,
    ledgerHeard: o.ledgerHeard === true,
    closing: CLOSING_SET.has(o.closing) ? o.closing : null,
    redacted,
  }
}

// always a fresh copy: setPref drops a write whose value is the same reference it already holds
export function saveFile(f) {
  setPref('file', { ...f, redacted: Array.isArray(f.redacted) ? [...f.redacted] : [] })
}

// the file reads you once you have heard the ledger, found five pages, or gone deep enough
export function canFile({ ledgerHeard, pagesRead, depth } = {}) {
  return ledgerHeard === true || pagesRead >= 5 || depth >= 2
}

export function canRefile(at, now) {
  return at == null || now - at >= DAY_MS
}

const STATUS_WISH = /^\s*(extension|compliance|litigation)\s*$/i
const STATUS_WISH_LONG = /^\s*file me under (extension|compliance|litigation)\s*$/i
export function parseStatusWish(text) {
  if (typeof text !== 'string') return null
  const m = STATUS_WISH.exec(text) || STATUS_WISH_LONG.exec(text)
  return m ? m[1].toLowerCase() : null
}

const NO_RESETS = Object.freeze([])
const RESETS = Object.freeze(['photoIdx', 'stationIdx', 'claimFiled'])   // beaconFired is a fact; it stays

// -> { file, reply (the dialog's text), line (the world's voice, after the dialog closes), resets }
export function fileStatus(file, chosen, now, ok) {
  if (!STATUS_SET.has(chosen)) return { file, reply: null, line: null, resets: NO_RESETS }     // not a word the file has
  if (chosen === file.status) return { file, reply: STRINGS.SAME_STATUS, line: null, resets: NO_RESETS }
  if (!ok && chosen !== DEFAULT_STATUS) return { file, reply: STRINGS.NOTICE_UNANSWERED, line: null, resets: NO_RESETS }
  if (!canRefile(file.at, now)) return { file, reply: STRINGS.OFFICE_CLOSED, line: null, resets: NO_RESETS }
  return {
    file: { status: chosen, at: now, ledgerHeard: file.ledgerHeard === true, closing: null, redacted: [] },
    reply: chosen === DEFAULT_STATUS ? STRINGS.NEW_NOTICE : STRINGS.FILED,
    line: file.at == null ? null : STRINGS.REFILED,
    resets: RESETS,
  }
}

// ── the trailer on a wish ───────────────────────────────────────────────────────────────────
export function wishTrailer(status, depth) {
  return status === DEFAULT_STATUS || !STATUS_LABEL[status] ? '' : '\nfiled under: ' + STATUS_LABEL[status] + ' · level ' + depth
}

const TRAILER = /^filed under: (EXTENSION|COMPLIANCE|LITIGATION) · level ([0-3])$/
// THE one parser (the main process and the docket tool import it): the last trailer line wins
export function parseTrailer(body) {
  if (typeof body !== 'string') return null
  const lines = body.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = TRAILER.exec(lines[i].trim())
    if (m) return { status: m[1].toLowerCase(), level: Number(m[2]) }
  }
  return null
}
// a typed line that reads as a trailer is the player's, not the file's: dropped before the real one goes on (R3SP-2)
export const stripTrailers = (t) => String(t).split('\n').filter((l) => !TRAILER.test(l.trim())).join('\n').trim()

// the dialog's placeholder and the faint lines under it
export function wishPrompt({ origin, status, closing, canFile: cf, canRefile: cr } = {}) {
  const placeholder = origin === 'processed' ? STRINGS.PLACEHOLDER_PROCESSED
    : origin === 'unnamed' ? STRINGS.PLACEHOLDER_UNNAMED
      : STRINGS.PLACEHOLDER
  const sub = !cf ? [STRINGS.NOTICE_UNANSWERED]
    : !cr ? ['filed under ' + status + '. the office is closed until tomorrow.']
      : [...STRINGS.STAMP_LINES]
  return { placeholder, sub }
}

// ── the inversions ──────────────────────────────────────────────────────────────────────────
// the post-core lines, as additive terms. game.js:1796 `sdelta -= (level.index >= 0 && level.index <= 3 ? level.index : 0) * 0.5`
// (∅, index 4, drains nothing on the block); 0 - x keeps +0 where the block leaves sdelta untouched
const legacyDepthTerm = (index) => 0 - ((index >= 0 && index <= 3) ? index : 0) * 0.5
// game.js:987 `const finalizing = sanity < 40 || (level?.index ?? 0) >= 3` reads the INDEX: ∅ is finalizing today
const legacyGlyph = (index, depth, sanity) => !(sanity < 40 || index >= 3)
// game.js:1008 `deep = dfloor === 2 || dfloor === 3`
const legacyRadio = (depth) => (depth === 2 || depth === 3 ? 'ledger' : 'crackle')
const filedRadio = (depth) => (depth === 2 || depth === 3 ? 'ledger' : 'roll')

// the SAME seven keys, in the same order, for every status
const MODS = {
  'notice-mailed': Object.freeze({
    sanityDepthTerm: (index, depth) => legacyDepthTerm(index),
    sourWater: 'today',
    polaroidGlyph: legacyGlyph,
    thinSanity: 0,
    sealedCards: false,
    radioMode: legacyRadio,
    npcLine: null,
  }),
  extension: Object.freeze({
    // the deep holds you, the street frays you
    sanityDepthTerm: (index, depth) => (index === 4 ? -1.0 : (depth - 1.5) * 0.5),
    sourWater: 'advance',
    polaroidGlyph: legacyGlyph,
    thinSanity: 0,
    sealedCards: false,
    radioMode: filedRadio,
    npcLine: STRINGS.NPC_EXTENSION,
  }),
  compliance: Object.freeze({
    sanityDepthTerm: (index, depth) => legacyDepthTerm(index),
    sourWater: 'today',
    polaroidGlyph: () => false,          // honest film
    thinSanity: 0,
    sealedCards: true,
    radioMode: filedRadio,
    npcLine: STRINGS.NPC_COMPLIANCE,
  }),
  litigation: Object.freeze({
    sanityDepthTerm: (index, depth) => legacyDepthTerm(index),
    sourWater: 'today',
    polaroidGlyph: () => true,           // the claim develops on every floor
    thinSanity: 4,
    sealedCards: false,
    radioMode: filedRadio,
    npcLine: STRINGS.NPC_LITIGATION,
  }),
}
const NPC_POOLS = {}
for (const s of STATUSES) NPC_POOLS[s] = Object.freeze(MODS[s].npcLine ? [MODS[s].npcLine] : [])

export function statusMods(status) {
  return MODS[STATUS_SET.has(status) ? status : DEFAULT_STATUS]
}

// the status's line for the lost souls' pool: NPC_LINES.concat(npcLines(status))
export function npcLines(status) {
  return NPC_POOLS[STATUS_SET.has(status) ? status : DEFAULT_STATUS]
}
