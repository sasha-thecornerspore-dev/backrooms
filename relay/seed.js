// relay/seed.js — what world does a room have?
//
// Extracted from relay.js so plain vitest can import it: relay.js imports
// 'cloudflare:workers', which cannot resolve under environment:'node'. That
// untestability is why the relay silently threw away every anchor seed —
// nothing could reach in and check.
//
// No imports. Pure. The only place the seed decision is made.

const MAX = 0xFFFFFFFF

// Seeds are uint32 and never 0 — world.js:191 reads 0 as both "fixed seed"
// and "unseeded first visit", so a 0 seed produces the drift world while
// claiming to be seeded.
export function isValidSeed(v) {
  if (v === null || v === undefined || v === '') return false
  const n = Number(v)
  return Number.isInteger(n) && n > 0 && n <= MAX
}

// Precedence: the room's existing world wins, then the joiner's request,
// then a fresh one. The first player into a virgin room fixes its world.
export function roomSeed(requested, stored) {
  if (isValidSeed(stored)) return Number(stored)
  if (isValidSeed(requested)) return Number(requested)
  return Math.floor(Math.random() * MAX) + 1   // 1 .. 0xFFFFFFFF, never 0
}
