// creature-diag.mjs — for one tree: how far the things are from a player standing at a floor's origin, how much they move, what phase
// they are in. The player stands for 120 s (footsteps off), the creatures update at 60 Hz on the hunt path. Prints, per creature, the
// distance moved and its phase histogram, and the nearest any came.
//
//   node tools/pacing/creature-diag.mjs [--src <tree>/src/renderer] [--level 1..3] [--seed N|null]
import { loadTree, parseArgs } from './lib.mjs'
const { val } = parseArgs(process.argv.slice(2), ['src', 'level', 'seed'])
const T = await loadTree(val.src)
const lv = Number(val.level ?? 1), seed = val.seed === undefined || val.seed === 'null' ? null : Number(val.seed)
let t = 0
const f = T.buildFloor(lv, seed, { cx: 0, cy: 0 }, { clock: () => t })
const p = { x: f.spawn.x, y: f.spawn.y, angle: 0 }
const ai = { flashlight: true, sprinting: false, dark: !f.cfg.lights, fog: f.cfg.fogDistance, radioOn: false, lures: [], t: 0, hf: T.FRM.HF, playerAngle: 0, player: p, damage: 14, sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1 }
const start = new Map(), moved = new Map(), phase = new Map(), last = new Map()
let nearestMin = Infinity
for (let i = 0; i < 120 * 60; i++) {
  t += 1 / 60; ai.t = t
  f.entitySys.update(1 / 60, p, 0, 0, ai)
  for (const e of f.entitySys.getEntities()) {
    if (!start.has(e.id)) { start.set(e.id, [e.x, e.y, e.variant, e.type]); moved.set(e.id, 0); phase.set(e.id, {}) }
    const l = last.get(e.id); if (l) moved.set(e.id, moved.get(e.id) + Math.hypot(e.x - l[0], e.y - l[1]))
    last.set(e.id, [e.x, e.y])
    const ph = phase.get(e.id); ph[e.ai] = (ph[e.ai] ?? 0) + 1 / 60
    const d = Math.hypot(e.x - p.x, e.y - p.y); if (d < nearestMin) nearestMin = d
  }
}
console.log(`L${lv} (${T.dir}): ${f.entitySys.getEntities().length} creatures in the window; nearest ever ${nearestMin.toFixed(1)} u from a player standing at the arrival`)
for (const [id, s] of start) {
  const e = f.entitySys.getEntities().find((q) => q.id === id)
  if (!e) continue
  const ph = Object.entries(phase.get(id)).map(([k, v]) => `${k}:${v.toFixed(0)}s`).join(' ')
  console.log(`  ${s[2]}/${s[3]} spawn ${s[0].toFixed(1)},${s[1].toFixed(1)} -> ${e.x.toFixed(1)},${e.y.toFixed(1)}  path ${moved.get(id).toFixed(1)} u in 120 s, net ${Math.hypot(e.x - s[0], e.y - s[1]).toFixed(1)} u; ${ph}`)
}
