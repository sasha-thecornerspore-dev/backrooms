// server/evguard.js — COPY of relay/evguard.js. Do not edit here: edit relay/evguard.js
// and re-copy. The packaged app bundles server/ but not relay/, so the node server
// cannot import across. test/evguard.test.js asserts both copies are equal below
// their headers.
// relay/evguard.js — the three guards every relayed 'ev' frame passes.
//
// Extracted from relay.js (like seed.js) so plain vitest can import it:
// relay.js imports 'cloudflare:workers', which cannot resolve under
// environment:'node'. server/evguard.js is a byte-identical copy below its
// header — the packaged app bundles server/ but not relay/ — and
// test/evguard.test.js asserts the two stay equal.
//
// The server never inspects kind semantics or payload. It checks the frame
// size, the kind's spelling and the sender's rate, attaches id/name/t and
// forwards. Everything else is the client bus's business (src/net/evbus.js).
//
// No imports. Pure.

export const EV_KIND_RE = /^[a-z][a-z0-9-]{0,15}$/
export const EV_FRAME_MAX = 1536   // UTF-16 units of the whole frame
export const EV_RATE = 10          // tokens per second
export const EV_BURST = 20         // bucket depth

export function evKindOk(kind) {
  return typeof kind === 'string' && EV_KIND_RE.test(kind)
}

// raw is what the socket handed us: a string (relay, ws text frames) or
// bytes (node ws gives a Buffer; a worker may give an ArrayBuffer).
export function evFrameOk(raw) {
  let s
  if (typeof raw === 'string') s = raw
  else if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) s = new TextDecoder().decode(raw)
  else return false
  return s.length <= EV_FRAME_MAX
}

// Token bucket kept on the per-socket attachment (evTok, evT) so the relay
// can round-trip it through serializeAttachment across hibernation.
// tok = min(BURST, tok + (now − last) / 100); need ≥ 1; take 1.
export function evBucket(att, now) {
  const last = att.evT == null ? now : att.evT
  const dt = Math.max(0, now - last)
  const tok = Math.min(EV_BURST, (att.evTok == null ? EV_BURST : att.evTok) + dt * (EV_RATE / 1000))
  att.evT = now
  if (tok < 1) { att.evTok = tok; return false }
  att.evTok = tok - 1
  return true
}
