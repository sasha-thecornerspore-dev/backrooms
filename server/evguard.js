// server/evguard.js — COPY of relay/evguard.js. Do not edit here: edit relay/evguard.js
// and re-copy. The packaged app bundles server/ but not relay/, so the node server
// cannot import across. test/evguard.test.js asserts both copies are equal below
// their headers.
// relay/evguard.js — the guards every relayed 'ev' frame passes, and the pace
// of pos, chat and typing (2.0.7, below).
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

// ── pos, chat and typing: a pace each ───────────────────────────────────────────────────────
// Nothing limited these three before 2.0.7. Each limit is at least twice the most an honest client
// sends, read off the client (src/net/client.js and its callers in src/renderer/game.js), and each
// burst covers what a line that stalled hands the socket all at once: frames queue in the sender
// while nothing moves, then arrive together.
//
// pos: game.js sends one when netTimer passes 0.05 s of play, then sets it back to 0, so at most one
// a frame and never two within 0.05 s; a frame's dt is the time that passed, capped at 0.05 s, so play
// never runs ahead of the clock. 20 a second is the most, whatever the frame rate (world.json
// net.posHz may only lower it).
export const POS_RATE = 40           // twice 20
export const POS_BURST = 60          // three seconds of honest frames
// chat: typed by hand. Enter opens the line, and the Enter that sends it closes it, so a line is three
// keys at the least (Enter, a letter, Enter); holding Enter sends nothing (the line opens empty and
// closes empty). A hand at its fastest, about fifteen keys a second and only for a moment, sends five
// lines a second.
export const CHAT_RATE = 10          // twice 5
export const CHAT_BURST = 20         // four seconds of that hand
// typing: noteTyping sends on with the first key of a line and off when its 1800 ms stop timer runs
// out or the line closes, so two frames a line at the most (Enter, a letter, Escape is enough): the
// same hand sends ten a second.
export const TYPING_RATE = 20        // twice 10
export const TYPING_BURST = 40       // four seconds of that hand

// The close. A frame one of the three refuses is dropped and nothing is said; it is also a strike. A
// socket holds FLOOD_STRIKES of them and they come back at FLOOD_HEAL a second; the strike it does not
// have closes it, FLOOD_CLOSE 'too fast', the one close a 2.0.7 client takes as do not reconnect.
// Why an honest client never comes near it: at its own pace each kind takes at most half of what its
// bucket refills, so in steady play nothing is refused at all. Only a line that stalls and then hands
// over what it queued can be refused, and then no more than the client made during the stall, less
// the three bursts. Over any stretch longer than a moment an honest client makes fewer than
// FLOOD_HEAL frames a second (pos 20, and 6 from a hand that keeps up two lines a second: it cannot
// keep up five), so stall after stall never wears the strikes down; and FLOOD_STRIKES is more than it
// makes in a minute and a half, so no stall shorter than that spends them (over a minute even with
// the hand at its fastest throughout). test/relay-buckets.test.js plays both. A socket that keeps
// sending past a limit by more than FLOOD_HEAL a second is closed in seconds: at a thousand a second,
// in under three.
export const FLOOD_STRIKES = 2400
export const FLOOD_HEAL = 30
export const FLOOD_CLOSE = 4029      // a private-use WebSocket close code (4000–4999)
export const FLOOD_REASON = 'too fast'

// posTok / posT, chTok / chT, tyTok / tyT: on the attachment, like evTok / evT
export function posBucket(att, now) { return bucket(att, now, 'posTok', 'posT', POS_RATE, POS_BURST) }
export function chatBucket(att, now) { return bucket(att, now, 'chTok', 'chT', CHAT_RATE, CHAT_BURST) }
export function typingBucket(att, now) { return bucket(att, now, 'tyTok', 'tyT', TYPING_RATE, TYPING_BURST) }
// a refused frame's strike, flTok / flT: false when there was none left to spend
export function floodStrike(att, now) { return bucket(att, now, 'flTok', 'flT', FLOOD_HEAL, FLOOD_STRIKES) }

const PACED = Object.freeze({ __proto__: null, pos: posBucket, chat: chatBucket, typing: typingBucket })

// The one call both servers make for a pos, chat or typing frame: 'pass' (relay it), 'drop' (over its
// limit: drop it, say nothing) or 'close' (out of strikes: close the socket FLOOD_CLOSE, FLOOD_REASON).
// A type it does not pace passes.
export function pace(att, type, now) {
  const b = PACED[type]
  if (!b || b(att, now)) return 'pass'
  return floodStrike(att, now) ? 'drop' : 'close'
}
