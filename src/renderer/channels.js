// channels.js — the registry of per-chunk hash channels: every placement pass reads its constants from here, so no two passes can ever
// share a stream and perturb each other (a new pass appended on fresh constants leaves every older placement byte-identical).
//
//   gate: [a, b]                    -> hash(cx + a + salt, cy + b + salt, seed)                    (does this chunk hold one?)
//   rng:  [mulX, addX, mulY, addY]  -> rngFrom(cx * mulX + salt + addX, cy * mulY + salt + addY, seed)  (where / which)
//   type / pick: [a, b]             -> a second gate-shaped hash that picks a variant
//
// props..sights are the constants decor.js already uses (test/channels.test.js pins the source to this table); the rest are reserved for
// the passes this release adds. Every gate `a`, every (a, b) pair and every (mulX, addX) pair is distinct across the table.
const C = (o) => Object.freeze(o)
export const CHANNELS = Object.freeze({
  props:         C({ rng: [131, 4242, 197, 8484] }),
  exits:         C({ gate: [5150, 6270], rng: [313, 99, 911, 77] }),
  npcs:          C({ gate: [2200, 3300], rng: [617, 41, 733, 23] }),
  scraps:        C({ gate: [4801, 9403], rng: [829, 53, 457, 67] }),
  machines:      C({ gate: [6101, 2027], rng: [541, 29, 907, 83] }),
  sights:        C({ gate: [3701, 5903], rng: [683, 37, 419, 71], type: [271, 613] }),
  upStair:       C({ gate: [9311, 4177], rng: [1013, 13, 569, 31] }),
  lift:          C({ gate: [8629, 1109], rng: [1033, 7, 751, 19] }),
  dress:         C({ gate: [7307, 1511], rng: [359, 19, 947, 61] }),
  containerSlot: C({ gate: [7489, 3251] }),
  containerRoll: C({ gate: [2113, 2251] }),
  haunts:        C({ gate: [9203, 1531], rng: [227, 43, 593, 89], pick: [467, 941] }),
})
