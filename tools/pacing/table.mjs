// table.mjs — the Tier 1 acceptance table (plan §2, T1 acceptance), one measured column per tree, from the walker's summary (analyze.mjs
// <prefix>.json) and the bot's metrics (bot/stats.mjs metrics.json) of that tree. The target column follows the first measured column.
//
//   node tools/pacing/table.mjs --col "2.0.3 measured|<s203.json>|<bot203/metrics.json>[|frame-perf text]"
//                               --col "2.0.4 (as built) measured|<s204.json>|<bot204/metrics.json>[|frame-perf text]" [--col ...] [--out <file.md>]
// A column with a later label is added the same way (a fixed tree: one more --col). Prints the markdown table; --out writes it too.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const cols = []
let outFile = null
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--col') { const [label, walk, bot, perf] = argv[++i].split('|'); cols.push({ label, perf: perf ?? '—', W: JSON.parse(readFileSync(path.resolve(walk), 'utf8')), B: JSON.parse(readFileSync(path.resolve(bot), 'utf8')).metrics }) }
  else if (argv[i] === '--out') outFile = path.resolve(argv[++i])
}
if (!cols.length) { process.stderr.write('usage: node tools/pacing/table.mjs --col "label|<walker summary.json>|<bot metrics.json>" [--col ...] [--out file.md]\n'); process.exit(2) }

const pc = (v) => (Number.isFinite(v) ? `${Math.round(100 * v)}%` : '—')
const F = (W, i, mode = 'explore') => W.floors[i]?.[mode]
const deep = (W) => W.wiring?.dread                        // tells and dread heartbeats exist only where the tree wires dread
const sum = (W, i, k) => (F(W, i)?.tier1[k] ?? 0) + (F(W, i, 'seek')?.tier1[k] ?? 0)
const ROWS = [
  { metric: 'seek-walk (compass follower) time on a floor, p50 (walker, L0 · L1 · L2 · L3)', target: '45–90 s',
    get: ({ W }) => [0, 1, 2, 3].map((i) => `${Math.round(F(W, i, 'seek').reach.censoredP50)}`).join(' · ') + ' s',
    met: ({ W }) => [0, 1, 2, 3].every((i) => { const v = F(W, i, 'seek').reach.censoredP50; return v >= 45 && v <= 90 }) },
  { metric: 'fresh run: time in the lobby, for a bot that follows the thread (p50, min–max of n runs)', target: '90–150 s',
    get: ({ B }) => B.freshLobbyS ? `${Math.round(B.freshLobbyS.p50)} s (${Math.round(B.freshLobbyS.min)}–${Math.round(B.freshLobbyS.max)}${B.freshLobbyS.runs.includes(null) ? ', one never left in 180' : ''}; n ${B.freshLobbyS.runs.length})` : '—',
    met: ({ B }) => !!B.freshLobbyS && B.freshLobbyS.p50 >= 90 && B.freshLobbyS.p50 <= 150 },
  { metric: 'plates in the first 45 s of an arrival, any floor (bot, most in one arrival: arrival + unprompted / every plate)', target: '≤ 2',
    get: ({ B }) => `${B.budgetedFirst45Max} / ${B.platesFirst45Max}`, met: ({ B }) => B.budgetedFirst45Max <= 2 },
  { metric: 'plate on screen (bot, range over sessions)', target: '≤ 40%',
    get: ({ B }) => `${pc(B.plateOnScreen.min)}–${pc(B.plateOnScreen.max)}`, met: ({ B }) => B.plateOnScreen.max <= 0.4 },
  { metric: '`you rummage.` plates / flashlight plates per run / smiler teaching lines per run (bot; smiler: walker, most in one walk)', target: '0 / ≤ 2 / ≤ 1',
    get: ({ W, B }) => `${B.rummage} / ${B.lightLinesMaxPerRun} / ${Math.max(...[0, 1, 2, 3].map((i) => F(W, i).tier1.smilerLinesMaxPerWalk))}`,
    met: ({ W, B }) => B.rummage === 0 && B.lightLinesMaxPerRun <= 2 && Math.max(...[0, 1, 2, 3].map((i) => F(W, i).tier1.smilerLinesMaxPerWalk)) <= 1 },
  { metric: 'compass followers sent to a stair up first (walker, L1 · L2 · L3, of n worlds)', target: '0',
    get: ({ W }) => [1, 2, 3].map((i) => F(W, i, 'seek').reach.sentUpWalks).join(' · ') + ` of ${W.seeds}`, met: ({ W }) => [1, 2, 3].every((i) => F(W, i, 'seek').reach.sentUpWalks === 0) },
  { metric: 'repeated lines within 5 min (walker, explore, L0 · L1 · L2 · L3; in brackets without the flashlight\'s lines)', target: '≤ 10%',
    get: ({ W }) => [0, 1, 2, 3].map((i) => pc(F(W, i).tier1.repeatShare)).join(' · ') + ' (' + [0, 1, 2, 3].map((i) => pc(F(W, i).tier1.repeatShareNoLight)).join(' · ') + ')',
    met: ({ W }) => [0, 1, 2, 3].every((i) => F(W, i).tier1.repeatShare <= 0.1) },
  { metric: 'drawer item / empty share (sweep of the tree\'s table, L1–3; bot rolls, n)', target: '8–10% / ≤ 35%',
    get: ({ W, B }) => {
      const d = [1, 2, 3].map((i) => W.drawers[i].sweep), f = (v) => (Math.round(v * 10) / 10).toFixed(1)
      const lo = (k) => f(Math.min(...d.map((x) => x[k]))), hi = (k) => f(Math.max(...d.map((x) => x[k])))
      return `sweep ${lo('item')}–${hi('item')}% / ${lo('empty')}–${hi('empty')}%; bot ${f(B.drawers.item ?? 0)}% / ${f(B.drawers.empty ?? 0)}% (n ${B.drawers.rolls})`
    },
    met: ({ W }) => [1, 2, 3].every((i) => W.drawers[i].sweep.item >= 8 && W.drawers[i].sweep.item <= 10 && W.drawers[i].sweep.empty <= 35) },
  { metric: 'L1–L2 sightings preceded by a tell or the heartbeat 5–25 s earlier (walker, both walkers)', target: '≥ 80%',
    get: ({ W }) => {
      if (!deep(W)) return '—'
      const c = sum(W, 1, 'sightingsCued') + sum(W, 2, 'sightingsCued'), n = sum(W, 1, 'sightings') + sum(W, 2, 'sightings')
      const c5 = sum(W, 1, 'sightingsAfter5sCued') + sum(W, 2, 'sightingsAfter5sCued'), n5 = sum(W, 1, 'sightingsAfter5s') + sum(W, 2, 'sightingsAfter5s')
      return `${pc(c / n)} (${c}/${n}); ${pc(c5 / n5)} (${c5}/${n5}) leaving out a visit's first 5 s`
    },
    met: ({ W }) => deep(W) && (sum(W, 1, 'sightingsCued') + sum(W, 2, 'sightingsCued')) / (sum(W, 1, 'sightings') + sum(W, 2, 'sightings')) >= 0.8 },
  { metric: 'heartbeats with no creature within 24 path cells (walker, dread\'s own beats, L1 · L2 · L3; of all dread beats)', target: '0',
    get: ({ W }) => (deep(W) ? [1, 2, 3].map((i) => sum(W, i, 'heartbeatsFarDread')).join(' · ') + ` (of ${[1, 2, 3].reduce((s, i) => s + sum(W, i, 'heartbeatsDread'), 0)})` : '—'),
    met: ({ W }) => deep(W) && [1, 2, 3].every((i) => sum(W, i, 'heartbeatsFarDread') === 0) },
  { metric: 'quiet stretches ≥ 45 s (no happening, no unprompted text) per 5 min (walker, explore, L0 · L1 · L2 · L3)', target: '≥ 1',
    get: ({ W }) => [0, 1, 2, 3].map((i) => F(W, i).tier1.quietStretchesPer5Min).join(' · '), met: ({ W }) => [0, 1, 2, 3].every((i) => F(W, i).tier1.quietStretchesPer5Min >= 1) },
  { metric: 'gap between happenings, p90 (walker, explore, L0 · L1 · L2 · L3; no Tier 1 target)', target: '—',
    get: ({ W }) => [0, 1, 2, 3].map((i) => Math.round(F(W, i).tier1.happeningGapP90)).join(' · ') + ' s', met: null },
  { metric: 'frame-perf, 600 frames (test/frame-perf.test.js, not these tools: the 4th field of --col)', target: '< 150 ms, identities held, path field zero-allocation',
    get: ({ perf }) => perf, met: null },
  { metric: 'light-off share (walker setting, measured)', target: '—',
    get: ({ W }) => pc(Math.max(...[0, 1, 2, 3].map((i) => F(W, i).tier1.lightOffShare))), met: null },
]

const head = ['metric', cols[0].label, 'Tier 1 target', ...cols.slice(1).map((c) => c.label)]
const md = ['| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|']
const verdict = cols.map(() => ({ met: [], missed: [] }))
for (const r of ROWS) {
  const cells = cols.map((c, k) => {
    const v = r.get(c)
    if (r.met && k > 0) { const ok = !!r.met(c); verdict[k][ok ? 'met' : 'missed'].push(r.metric) }
    return v
  })
  md.push('| ' + [r.metric, cells[0], r.target, ...cells.slice(1)].join(' | ') + ' |')
}
const text = md.join('\n') + '\n'
if (outFile) writeFileSync(outFile, text)
console.log(text)
for (let k = 1; k < cols.length; k++) console.log(`${cols[k].label}: ${verdict[k].met.length} met, ${verdict[k].missed.length} missed${verdict[k].missed.length ? ':\n  - ' + verdict[k].missed.join('\n  - ') : ''}`)
