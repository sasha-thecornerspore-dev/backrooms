// closings.js — the three ways a file closes.
//
// extension: you stand in the dark on the deepest floor until the notice is extended
// over you. compliance: you give up thirteen pages and ask the file to close. litigation:
// you hold the seam (the core's ending — its lines stay in tryFinale). Each closing is a
// fact on the file (file.closing), and what it changes is read LIVE where it applies:
// closingOverlay() is a frozen singleton per closing, standTick() one reused record, so
// the per-frame paths allocate nothing. Pure and import-safe.

import { STRINGS } from './status.js'
// the processed read their own slip (W2): the block keeps its strings as flat exports
import { SLIP_LINE as PROCESSED_SLIP_LINE } from './origin-processed.js'

export const WORDS = Object.freeze(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen'])
const PAGES_TO_CLOSE = 13

export const NO_STANDING = 'you have no standing to file this.'
export const CLOSED_OFFICE = 'the file is closed. there is no one to ask.'

// the unaffiliated keep today's ending; nobody holds the seam once a file is closed
export function canFinale(status, closing) {
  return closing == null && (status === 'litigation' || status === 'notice-mailed')
}

// ── the stand ───────────────────────────────────────────────────────────────────────────────
// standFloor comes from the docket (3, or 2 when the room leads extension); never below 2,
// so ∅ (depth 0) and the lobby are out. nearD is the hunt's th.nearest (Infinity when nothing
// hostile is on the floor).
export function standConditions(ctx) {
  const standFloor = ctx.standFloor ?? 3
  if (!(standFloor >= 2)) return false
  return ctx.status === 'extension' && ctx.closing == null && ctx.depth === standFloor && !ctx.flashlight &&
    ctx.ledgerHeard === true && !ctx.moving && ctx.nearD >= 10 && ctx.sanity > 30 && !ctx.transitioning
}

const stand = { held: 0, done: false }
// -> the ONE reused { held, done }: done fires once, on the frame held crosses needS
export function standTick(held, dt, ok, needS = 45) {
  const next = ok ? held + dt : 0
  stand.done = !!ok && held < needS && next >= needS
  stand.held = next
  return stand
}

// ── compliance ──────────────────────────────────────────────────────────────────────────────
export function isCloseWish(text) {
  return /^\s*close the file\s*$/i.test(String(text))
}

const pagesGiven = (n) => (n >= PAGES_TO_CLOSE ? 'thirteen pages given up' : WORDS[n] + ' of thirteen pages given up')

// -> { file, reply, closed }: files nothing else, submits nothing
export function closeFile(file) {
  const n = file.redacted.length
  if (n >= PAGES_TO_CLOSE) return { file: { ...file, closing: 'compliance' }, reply: STRINGS.COMPLIANCE_CLOSED, closed: true }
  return { file, reply: 'the file is not ready to close. ' + pagesGiven(n) + '.', closed: false }
}

// ── what a closing changes, read live ───────────────────────────────────────────────────────
// frozen and keyless when nothing applies, so `co.scrapsDenom === 0` is false and `co.tension ?? 0` is 0
const EMPTY = Object.freeze({})
const OVERLAYS = {
  // the street frays you, one floor down a little less, the deep holds you
  extension: Object.freeze({ sanityDepthTerm: (index, depth) => (index === 4 || depth === 0 ? -1.5 : depth === 1 ? -0.75 : 0.75) }),
  compliance: Object.freeze({ presence: false, scrapsDenom: 0, tension: -0.3 }),
}
export function closingOverlay(closing) {
  return (closing === 'extension' || closing === 'compliance') ? OVERLAYS[closing] : EMPTY
}

export function isWishOpen(closing) {
  return closing !== 'compliance'
}

const LINES = {
  extension: Object.freeze([
    'the lights hold.',
    'the notice is extended. twenty-two years. you are in it now, under the same word.',
    'the deep is home. the street is the thin place.',
  ]),
  // [0] is the dialog's reply; [1] and [2] follow once it has closed
  compliance: Object.freeze([
    STRINGS.COMPLIANCE_CLOSED,
    'the shimmer is gone from the walls. there is nothing left to ask.',
    'the pages you did not read stay unread. the floors stop leaving them out.',
  ]),
}
const NO_LINES = Object.freeze([])
// the seam's three lines stay in tryFinale (core); nothing closed has none
export function closingLines(closing) {
  return (closing === 'extension' || closing === 'compliance') ? LINES[closing] : NO_LINES
}

// an ordinary wish after the extension: still submitted, this is the reply
export function closingReply(closing) {
  return closing === 'extension' ? 'the file notes the extension. received.' : null
}

// ── progress (the settings row, /status) ────────────────────────────────────────────────────
export function closingProgress(status, st) {
  const s = st || {}
  const closing = s.closing ?? null
  if (status === 'extension') {
    return { done: closing === 'extension', steps: [
      { label: 'the station has read its last group to you', met: s.ledgerHeard === true },
      { label: 'standing in the dark on the deepest floor', met: closing === 'extension' },
    ] }
  }
  if (status === 'compliance') {
    const n = Array.isArray(s.redacted) ? s.redacted.length : (Number.isFinite(s.redacted) ? Math.max(0, Math.floor(s.redacted)) : 0)
    return { done: closing === 'compliance', steps: [
      { label: pagesGiven(n), met: n >= PAGES_TO_CLOSE },
      { label: 'the file, closed', met: closing === 'compliance' },
    ] }
  }
  if (status === 'litigation') {
    return { done: closing === 'litigation', steps: [
      { label: 'the claim, typed', met: s.claimFiled === true },
      { label: 'the beacon, pushed', met: s.beaconFired === true },
    ] }
  }
  return { done: false, steps: [] }
}

// the extension-slip's line: the extended read their own notice, the processed theirs, everyone else today's
export function slipText(origin, status, closing) {
  if (closing === 'extension' || status === 'extension') return STRINGS.SLIP_EXTENSION
  if (origin === 'processed') return PROCESSED_SLIP_LINE
  return STRINGS.SLIP_LEGACY
}

const ORIGIN_LINES = {
  tenant: 'the file has you at an address.',
  anchored: 'the file has your body at a pin.',
  unnamed: 'the file cannot spell you.',
  processed: 'the file opened a line on you.',
}
const NO_ORIGIN_LINE = 'the file does not have you yet.'
const NEW_NOTICE_CONTROL = 'request a new notice'

// the settings row renders all but the last as text and the last as the button; /status joins all but the last
export function yourFileLines(file, origin, progress) {
  const head = file.status === 'notice-mailed' ? 'notice mailed. unanswered.'
    : 'filed under ' + file.status + (file.at != null ? ' · since ' + new Date(file.at).toISOString().slice(0, 10) : '')
  const out = [head, Object.hasOwn(ORIGIN_LINES, origin) ? ORIGIN_LINES[origin] : NO_ORIGIN_LINE]
  if (progress && Array.isArray(progress.steps)) for (const s of progress.steps) out.push(s.label + (s.met ? ' · done' : ''))
  out.push(NEW_NOTICE_CONTROL)
  return out
}
