// origin-intake.js — the form on the counter.
//
// Nobody chooses a column. The file writes you into one by how you arrived, on the first way you take (game.js travel()):
// opened the room yourself (a walked-in player on any shared route) -> processed; came with a pin -> anchored; came without a
// name the dark can read -> unnamed; otherwise -> tenant. Exactly one origin per player; thin (arriving into a room that
// already had someone live, or coming back from the dark) is a layer the rule composer puts on top, never intake's business.
//
// Pure: no DOM, no clock, no Math.random. The save helpers (identityOut / identityIn) let game.js add the identity to
// snapshot() and read it back before applyResume() in one validated call each.
import { formatAnchor } from './anchor.js'

export const ORIGINS = Object.freeze(['tenant', 'anchored', 'processed', 'unnamed'])   // the four evbus.js accepts beside null
const ROUTES = ['solo', 'online', 'lan', 'host']
const ARRIVALS = ['walked', 'dropped']
const NAME_MAX = 24   // index.html getName(): the input is capped at 24

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// A pin is a real place: finite lat in [-90, 90], lng in [-180, 180] (anchor.js's own rule).
export function isValidPin(a) {
  return isObj(a) && Number.isFinite(a.lat) && Number.isFinite(a.lng) &&
    a.lat >= -90 && a.lat <= 90 && a.lng >= -180 && a.lng <= 180
}

// 'wanderer' is what the title screen writes when you leave the name empty: the file cannot spell it either.
export function isBlankName(name) {
  if (typeof name !== 'string') return true
  const t = name.trim()
  return t === '' || /^wanderer$/i.test(t)
}

export function intake(ctx) {
  const c = isObj(ctx) ? ctx : {}
  const route = c.route ?? 'solo'
  if (route !== 'solo' && (c.arrival ?? 'walked') === 'walked') return 'processed'   // you opened the room
  if (isValidPin(c.anchor)) return 'anchored'
  if (isBlankName(c.name)) return 'unnamed'
  return 'tenant'
}

export function filingLine(origin, thin) {
  return 'the file has you now.' +
    (thin ? ' you dropped in. not all of you arrived.' : '') +
    (origin === 'processed' ? ' it opened a line on you.' : '')
}

// The form's text, one string per line (the card joins them). The name is written the way the file writes everything.
export function formText(ctx, fileStatus) {
  const c = isObj(ctx) ? ctx : {}
  const blank = isBlankName(c.name)
  const lines = [
    'intake.',
    `name: ${blank ? '______' : c.name.trim().toLowerCase()}.`,
    isValidPin(c.anchor) ? `address: ${formatAnchor(c.anchor)}. the body is there.` : 'address: woodyear st. (there is no woodyear st.)',
    `status: ${fileStatus || '______'}. the pen ran out.`,
  ]
  if (blank) lines.push('the file cannot spell you. write your name where the dark can read it.')
  return lines
}

export const FORM_FOOT = 'the form on the counter.'
export const AMEND_LINE = 'the file does not take amendments. it takes forms.'

// '/intake' re-opens the form; anything typed after it is an amendment, and the file does not take those.
export function parseIntakeCommand(arg) {
  return String(arg ?? '').trim() === '' ? { show: true } : { refuse: AMEND_LINE }
}

// A validated copy of an intake ctx, or the fallback when there is none to copy.
export function normaliseIntakeCtx(ctx, fallback) {
  if (!isObj(ctx)) return fallback
  return {
    route: ROUTES.includes(ctx.route) ? ctx.route : 'solo',
    arrival: ARRIVALS.includes(ctx.arrival) ? ctx.arrival : null,
    anchor: isValidPin(ctx.anchor) ? { lat: ctx.anchor.lat, lng: ctx.anchor.lng } : null,
    name: typeof ctx.name === 'string' ? ctx.name.slice(0, NAME_MAX) : '',
  }
}

// snapshot() adds these (plain data: the Set becomes an array).
export function identityOut({ origin = null, thin = false, filed = false, intakeCtx = null, filedFloors = null } = {}) {
  const c = isObj(intakeCtx) ? intakeCtx : {}
  return {
    origin, thin, filed,
    intakeCtx: {
      route: c.route ?? 'solo',
      arrival: c.arrival ?? null,
      anchor: isValidPin(c.anchor) ? { lat: c.anchor.lat, lng: c.anchor.lng } : null,
      name: c.name ?? '',
    },
    filedFloors: filedFloors ? [...filedFloors] : [],
  }
}

// The resume reads these BEFORE applyResume(). An unfiled record is always { origin: null, thin: false }: a v:1 save without
// the fields resumes unfiled and files on its next travel. A filed record whose origin is not a column is unfiled too, so it
// files again instead of walking LEGACY forever.
export function identityIn(resume, fallbackIntakeCtx) {
  const r = isObj(resume) ? resume : {}
  const filed = r.filed === true && ORIGINS.includes(r.origin)
  return {
    origin: filed ? r.origin : null,
    thin: filed && r.thin === true,
    filed,
    intakeCtx: isObj(r.intakeCtx) ? normaliseIntakeCtx(r.intakeCtx, fallbackIntakeCtx) : fallbackIntakeCtx,
    filedFloors: new Set(Array.isArray(r.filedFloors) ? r.filedFloors.filter((s) => typeof s === 'string') : []),
  }
}
