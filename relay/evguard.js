// relay/evguard.js — the guards every relayed 'ev' frame passes.
//
// Extracted from relay.js (like seed.js) so plain vitest can import it:
// relay.js imports 'cloudflare:workers', which cannot resolve under
// environment:'node'. server/evguard.js is a byte-identical copy below its
// header — the packaged app bundles server/ but not relay/ — and
// test/evguard.test.js asserts the two stay equal.
//
// The server never inspects payload. It checks the frame size, the kind's
// spelling and the sender's rate, attaches id/name/t and forwards. Kind
// semantics are the client bus's business (src/net/evbus.js) with one
// exception: the keep/drop log (evlog.js) is stored, so which kinds it may
// hold is named here (EV_KEEP_KINDS / EV_DROP_KINDS) and a stored keep has a
// budget of its own (evKeepBucket). A frame of any other kind that carries
// keep or drop is still relayed live, and never logged; so is a keep over the
// budget. A new kind the log should hold is a relay change: add it here.
//
// No imports. Pure.

export const EV_KIND_RE = /^[a-z][a-z0-9-]{0,15}$/
export const EV_FRAME_MAX = 1536   // UTF-16 units of the whole frame
export const EV_RATE = 10          // tokens per second
export const EV_BURST = 20         // bucket depth
export const EV_KEEP_KINDS = Object.freeze(['cache'])   // a cache set down (game.js relayLater('cache', …, { keep }))
export const EV_DROP_KINDS = Object.freeze(['take'])    // and its taking (game.js relayLater('take', …, { drop }))
export const EV_KEEP_RATE = 0.5    // stored keeps per second: one every 2 s (an honest client sets a cache down at most every 3 s)
export const EV_KEEP_BURST = 4

export function evKindOk(kind) {
  return typeof kind === 'string' && EV_KIND_RE.test(kind)
}

export function evKeepOk(kind) { return EV_KEEP_KINDS.includes(kind) }
export function evDropOk(kind) { return EV_DROP_KINDS.includes(kind) }

// raw is what the socket handed us: a string (relay, ws text frames) or
// bytes (node ws gives a Buffer; a worker may give an ArrayBuffer).
export function evFrameOk(raw) {
  let s
  if (typeof raw === 'string') s = raw
  else if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) s = new TextDecoder().decode(raw)
  else return false
  return s.length <= EV_FRAME_MAX
}

// A token bucket kept on the per-socket attachment so the relay can
// round-trip it through serializeAttachment across hibernation.
// tok = min(burst, tok + (now − last) × rate); need ≥ 1; take 1.
function bucket(att, now, tokKey, tKey, rate, burst) {
  const last = att[tKey] == null ? now : att[tKey]
  const dt = Math.max(0, now - last)
  const tok = Math.min(burst, (att[tokKey] == null ? burst : att[tokKey]) + dt * (rate / 1000))
  att[tKey] = now
  if (tok < 1) { att[tokKey] = tok; return false }
  att[tokKey] = tok - 1
  return true
}

// every ev frame: evTok / evT, 10 a second, a burst of 20
export function evBucket(att, now) { return bucket(att, now, 'evTok', 'evT', EV_RATE, EV_BURST) }

// a keep the log will store: kpTok / kpT, one every 2 s, a burst of 4
export function evKeepBucket(att, now) { return bucket(att, now, 'kpTok', 'kpT', EV_KEEP_RATE, EV_KEEP_BURST) }
