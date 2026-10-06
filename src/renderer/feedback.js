// feedback.js — what a contact sounds like and says. Pure tables and rules; game.js plays the sound (audio.bump), shakes,
// spends the breath, makes the noise the things hear, and speaks the line.

// Which foley a body answers with. Every PROP_SPEC key, every sight, the machine and the lost soul appear exactly once.
export const BUMP_KIND = {
  thud:   ['cabinet', 'cabinet-e', 'crate', 'transformer', 'spool', 'valve', 'pipe', 'vent', 'plant', 'chairpile', 'tvwall', 'payphone', 'mannequin', 'box', 'toolbox', 'sign', 'couch'],
  hollow: ['drum', 'barrel', 'machine'],
  scrape: ['chair', 'cone', 'cart', 'trash', 'tire'],
  wood:   ['pallet'],
  murmur: ['npc'],
  silent: ['papers', 'weeds'],
}
const KIND_OF = {}
for (const [k, list] of Object.entries(BUMP_KIND)) for (const t of list) KIND_OF[t] = k

// bumpKindFor(kind, type): machines and souls are keyed by kind; anything unknown is a thud
export function bumpKindFor(kind, type) {
  const t = (kind === 'machine' || kind === 'npc') ? kind : type
  return KIND_OF[t] || 'thud'
}

// a 3.0 u/s walk is 0.3, a 5.4 u/s sprint is 1
export function bumpIntensity(speed) {
  const k = (speed - 2.0) / 3.4
  return k < 0.3 ? 0.3 : k > 1 ? 1 : k
}

// the sprint that hurts: an ENTER edge into a solid, fast and head-on, while the sprint key is held
export function isHardBump(report, wantSprint) {
  return !!(report && report.entered && wantSprint && report.enterSpeed > 4.0 && report.enterNormalDot > 0.7 && report.entered.cls === 'solid')
}

// hard bumps only; game.js says each once per type per level with a 30 s global cooldown
export const BUMP_LINES = {
  cabinet:     'it does not move.',
  transformer: 'it hums against your shoulder. you step back.',
  machine:     'the machine rocks, and settles, and says nothing.',
  npc:         'they do not look at you. "mind."',
  crate:       'it is heavier than it looks.',
  default:     'it does not move.',
}

// createBumpGate() -> { near(t), far(t) }: near at most once per 0.5 s, far once per 2 s, and never more than 8 of either
// in any 1 s. t is the game clock in seconds.
const NEAR_S = 0.5, FAR_S = 2, GLOBAL_N = 8, GLOBAL_S = 1
export function createBumpGate() {
  let lastNear = -Infinity, lastFar = -Infinity
  const ring = new Float64Array(GLOBAL_N).fill(-Infinity)       // the last 8 times anything passed
  let head = 0
  // the slot about to be overwritten holds the 8th most recent pass: within the window means 8 already went
  const globalOk = (t) => !(t - ring[head] < GLOBAL_S)
  const take = (t) => { ring[head] = t; head = (head + 1) % GLOBAL_N }
  function near(t) {
    if (t - lastNear < NEAR_S || !globalOk(t)) return false
    lastNear = t; take(t)
    return true
  }
  function far(t) {
    if (t - lastFar < FAR_S || !globalOk(t)) return false
    lastFar = t; take(t)
    return true
  }
  return { near, far }
}
