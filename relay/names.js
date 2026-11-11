// relay/names.js — who may be called Mumon (wish #27, "Mumon will be counted last").
//
// The owner: "make the name Mumon unavailable except for me, and make other players see Mumon different, an intricate and
// larger character". A name is the player's own word, sent in 'join' and kept by the room (relay.js Room, server/index.js);
// nothing else about a player is known to the room. So the one name is held by a key only the owner has: OWNER_KEY, a
// wrangler secret on the relay (an environment variable for a LAN server). A join whose name spells Mumon — any case,
// spacing or punctuation, a held letter, the usual look-alikes (MUM0N, Mu.mon, rnumon, a Cyrillic м or о), or inside a
// longer name (MumonSatanic, xMumonx) — keeps that name only with the key; without it the room calls that player
// 'wanderer', the name many share. With it the room adds mark: 'mumon' to the player's frames ('joined', 'players'), and
// the game draws that player as the larger figure (gfx-sprites.js PERSON.mumon). No secret set: no one is Mumon.
//
// The key is read once at join and compared here; it is never kept on the socket, never logged, never sent on. The client
// sends it only over a TLS connection (src/net/client.js), so a LAN server, spoken to in the clear, never sees it — and
// refuses the name to everyone unless it has a key of its own and is reached over TLS.
//
// server/names.js is a byte-identical copy below its header (the packaged app bundles server/ but not relay/);
// test/names.test.js asserts the two stay equal.

export const OWNER_MARK = 'mumon'
export const SHARED_NAME = 'wanderer'
export const NAME_MAX = 24
export const KEY_MIN = 16                 // a secret shorter than this holds nothing: the name is refused to everyone
export const KEY_MAX = 128

// look-alikes folded to the letter they pass for (after NFKD has taken the accents off)
const LOOKALIKE = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'м': 'm', 'п': 'n', 'и': 'u', 'ц': 'u', 'н': 'h', 'т': 't',
  'μ': 'u', 'υ': 'u', 'ս': 'u', 'ο': 'o', 'ө': 'o', 'ø': 'o', 'ν': 'v', 'η': 'n', 'ɱ': 'm', 'ɯ': 'm',
  '0': 'o', '1': 'l', '|': 'l', '!': 'i', '@': 'a', '$': 's', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b',
}

// the letters a name reads as: lowercase a..z only, look-alikes folded, 'rn' read as 'm', 'v' as 'u', a held letter once
export function nameLetters(name) {
  let s = String(name ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  s = Array.from(s, (ch) => LOOKALIKE[ch] ?? ch).join('')
  s = s.replace(/[^a-z]/g, '').replace(/rn/g, 'm').replace(/v/g, 'u').replace(/(.)\1+/g, '$1')
  return s
}

// does this name spell Mumon (anywhere in it)?
export function isReservedName(name) { return nameLetters(name).includes('mumon') }

// the key against the secret: both strings, the secret long enough, the same length, compared without an early way out
export function ownerKeyOk(key, secret) {
  if (typeof key !== 'string' || typeof secret !== 'string') return false
  if (secret.length < KEY_MIN || secret.length > KEY_MAX || key.length !== secret.length) return false
  let d = 0
  for (let i = 0; i < secret.length; i++) d |= key.charCodeAt(i) ^ secret.charCodeAt(i)
  return d === 0
}

// the room's name for a join: { name, mark } — the asked name (cut to NAME_MAX, 'wanderer' when blank), unless it spells
// Mumon without the key, which makes it 'wanderer'; mark is OWNER_MARK only for the name held with the key, else null
export function admitName(name, key, secret) {
  const asked = String(name || SHARED_NAME).slice(0, NAME_MAX)
  if (!isReservedName(asked)) return { name: asked, mark: null }
  if (ownerKeyOk(key, secret)) return { name: asked, mark: OWNER_MARK }
  return { name: SHARED_NAME, mark: null }
}
