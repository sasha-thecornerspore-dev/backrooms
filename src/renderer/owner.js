// owner.js — the owner's key for the name Mumon (wish #27), kept on this device only.
//
// The relay keeps the name Mumon for whoever holds OWNER_KEY (relay/names.js). The owner types '/owner <key>' once at the field
// console (game.js handleCommand); the key is kept here, in its own localStorage entry (never in the prefs, never in a save),
// and index.html hands it to the multiplayer client, which sends it in 'join' over TLS only (src/net/client.js). '/owner off'
// forgets it; '/owner' alone says whether one is kept. No line ever repeats the key. Guarded: no localStorage (tests, a locked-
// down browser) reads as no key, and a write that fails says so.

export const OWNER_STORE = 'backrooms:owner-key'
export const OWNER_KEY_MIN = 16           // relay/names.js KEY_MIN / KEY_MAX: a key the relay could never accept is not kept
export const OWNER_KEY_MAX = 128

export const OWNER_LINES = Object.freeze({
  held: 'a key is kept on this device. the next room you enter will read it.',
  none: 'no key is kept on this device.',
  kept: 'the key is kept on this device. the next room you enter will read it.',
  forgot: 'the key is gone from this device.',
  bad: 'that is not a key this device can keep.',
  failed: 'this device would not keep the key.',
})

function store() { try { return globalThis.localStorage ?? null } catch { return null } }

export function validOwnerKey(k) { return typeof k === 'string' && k.length >= OWNER_KEY_MIN && k.length <= OWNER_KEY_MAX && !/\s/.test(k) }

// the kept key, or null (none, unreadable, or not one the relay could accept)
export function readOwnerKey(ls = store()) {
  try { const v = ls ? ls.getItem(OWNER_STORE) : null; return validOwnerKey(v) ? v : null } catch { return null }
}

// '/owner <key>' keeps it, '/owner off' forgets it, '/owner' says whether one is kept -> { line }
export function ownerCommand(arg, ls = store()) {
  const a = String(arg ?? '').trim()
  if (!a) return { line: readOwnerKey(ls) ? OWNER_LINES.held : OWNER_LINES.none }
  if (a === 'off' || a === 'forget') {
    try { if (ls) ls.removeItem(OWNER_STORE) } catch { /* nothing kept to forget */ }
    return { line: OWNER_LINES.forgot }
  }
  if (!validOwnerKey(a)) return { line: OWNER_LINES.bad }
  try { if (!ls) return { line: OWNER_LINES.failed }; ls.setItem(OWNER_STORE, a) } catch { return { line: OWNER_LINES.failed } }
  return { line: OWNER_LINES.kept }
}
