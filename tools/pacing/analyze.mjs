// analyze.mjs — walks.json (+ the tree it walked) -> summary.json and summary.md: the 2.0.3-era tables, the Tier 1 measures and the
// drawer sweep over that tree's own containers table. Read-only on the tree.
//
//   node tools/pacing/analyze.mjs --walks <walks.json> --out <prefix> [--src <tree>/src/renderer]   (writes <prefix>.json, <prefix>.md)
//
// Tiers: A = something happens to you (a creature seen, a hunt line or sound, a hit, an event — the arrival's sound-only one too —,
// a haunting, your ward); B = a find worth walking to (an item, a page, a machine, a landmark, a soul, a way, the presence shimmer);
// C = texture (furniture and containers coming into view, a first step into a dressed room, a murmur actually shown). X = bookkeeping:
// tells, heartbeats, the light, reading — never a happening.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { loadTree, parseArgs, dist, r1, r2, pct, gaps, moments, quietStretches, repeats, preceded } from './lib.mjs'

const { val } = parseArgs(process.argv.slice(2), ['walks', 'out', 'src'])
const W = JSON.parse(readFileSync(path.resolve(val.walks), 'utf8'))
const T = await loadTree(val.src ?? W.src)
const OUT = path.resolve(val.out ?? 'summary')
const WALK_S = W.walkSeconds
const FLOORS = W.floors ?? [0, 1, 2, 3]
const nSeeds = W.seeds.length
const QUIET_S = 45
const TELL_KINDS = new Set(['tell', 'tell:seen', 'heartbeat'])
const SMILER = 'it stops when you look. do not look away.'

const murmurSet = new Map()
for (const i of [0, 1, 2, 3]) {
  const cfg = T.LV.levelConfig(T.W.DEFAULT_CONFIG, i)
  murmurSet.set(i, new Set([...(cfg.messages || []), cfg.exit?.hint, T.LV.LOST_LINE].filter(Boolean)))
}
function eventsOf(r, tiers) {
  const out = r.events.filter((e) => tiers.includes(e.tier)).map((e) => e.t)
  if (tiers.includes('C')) for (const l of r.linesShown) if (murmurSet.get(r.index).has(l.text)) out.push(l.t)
  return out.sort((a, b) => a - b)
}
function emptyWindows(ts, end, w = 10) {
  const n = Math.floor(end / w)
  if (n <= 0) return { n: 0, empty: 0 }
  const hit = new Uint8Array(n)
  for (const t of ts) { const k = Math.floor(t / w); if (k < n) hit[k] = 1 }
  let e = 0; for (let k = 0; k < n; k++) if (!hit[k]) e++
  return { n, empty: e }
}
const KINDS_B = ['find:item', 'find:scrap', 'find:machine', 'find:sight', 'find:npc', 'find:exit', 'find:stair-up', 'find:lift', 'presence']
const KINDS_A = ['creature-sighted', 'creature-again', 'hunt:seen-line', 'hunt:far-line', 'hunt:alert-footfall', 'hunt:lost', 'hunt:turning', 'hunt:turn', 'hunt:smiler-freeze',
  'hunt:hound-windup', 'hunt:hound-pass', 'hunt:lurker-hum-duck', 'hunt:crawler', 'hunt:close-line', 'hunt:arc', 'music:hunt', 'hit:contact', 'hit:arc', 'hit:lunge',
  'ward:hit', 'ward:dispel', 'ward:miss', 'dread:lights-cascade', 'dread:door-slam', 'dread:hum-stops', 'dread:cold-spot', 'dread:footsteps', 'dread:crosser',
  'dread:phone-rings', 'dread:chair-scrape', 'dread:pipe-knock', 'dread:breaker-trip',
  'haunt:standing-figure', 'haunt:chairs-moved', 'haunt:running-water', 'haunt:knock-inside', 'haunt:your-own-light', 'death']
const KINDS_C = ['find:container', 'find:prop', 'room:3x3', 'room:5x5', 'flicker-dip', 'distant-swell']
const KINDS_X = ['tell', 'tell:seen', 'heartbeat', 'light:off', 'light:on', 'read', 'speak']

const summary = { src: W.src, version: W.version, wiring: W.wiring, walkSeconds: WALK_S, seeds: nSeeds, lightOff: W.lightOff, legacy: W.legacy, floors: {} }
for (const index of FLOORS) {
  const lv = {}
  for (const mode of ['explore', 'seek']) {
    const rs = W.runs.filter((r) => r.index === index && r.mode === mode)
    if (!rs.length) continue
    const totalS = rs.reduce((s, r) => s + r.seconds, 0), totalCells = rs.reduce((s, r) => s + r.cellsWalked, 0)
    const per100 = {}, perMin = {}
    for (const k of [...KINDS_A, ...KINDS_B, ...KINDS_C, ...KINDS_X]) {
      const n = rs.reduce((s, r) => s + r.events.filter((e) => e.kind === k).length, 0)
      if (n) { per100[k] = r2(100 * n / totalCells); perMin[k] = r2(60 * n / totalS) }
    }
    const tierStats = {}
    for (const [name, tiers] of [['A', ['A']], ['AB', ['A', 'B']], ['ABC', ['A', 'B', 'C']]]) {
      const allGaps = [], firstT = []
      let wn = 0, we = 0, nMom = 0
      for (const r of rs) {
        const ts = moments(eventsOf(r, tiers))
        nMom += ts.length
        allGaps.push(...gaps(ts, r.seconds))
        firstT.push(ts.length ? ts[0] : Infinity)
        const ew = emptyWindows(ts, r.seconds)
        wn += ew.n; we += ew.empty
      }
      tierStats[name] = {
        momentsPerMinute: r2(60 * nMom / totalS), gapSeconds: dist(allGaps),
        gapsOver30s: r2(allGaps.filter((g) => g > 30).length / Math.max(1, allGaps.length)),
        gapsOver60s: r2(allGaps.filter((g) => g > 60).length / Math.max(1, allGaps.length)),
        firstMomentSeconds: dist(firstT.filter(Number.isFinite)), walksWithNone: firstT.filter((t) => !Number.isFinite(t)).length,
        pctEmpty10sWindows: r1(100 * we / Math.max(1, wn)),
      }
    }
    {
      let wn = 0, we = 0
      for (const r of rs) {
        const ts = r.events.filter((e) => (e.tier === 'A' || e.tier === 'B' || e.tier === 'C') && e.kind !== 'flicker-dip' && e.kind !== 'distant-swell').map((e) => e.t)
        for (const l of r.linesShown) if (murmurSet.get(r.index).has(l.text)) ts.push(l.t)
        const ew = emptyWindows(ts.sort((a, b) => a - b), r.seconds); wn += ew.n; we += ew.empty
      }
      tierStats.ABC_noFlickerNoSwell = { pctEmpty10sWindows: r1(100 * we / Math.max(1, wn)) }
    }
    const firstSeen = rs.map((r) => { const e = r.events.find((q) => q.kind === 'creature-sighted'); return e ? e.t : Infinity })
    const fin = (a) => a.filter(Number.isFinite)
    const fog = T.LV.levelConfig(T.W.DEFAULT_CONFIG, index).fogDistance
    const nearAll = rs.flatMap((r) => r.nearestCreatureEachSecond)
    const lines = rs.flatMap((r) => r.linesShown)
    const murm = lines.filter((l) => murmurSet.get(index).has(l.text)).length
    // ── Tier 1 measures ──
    let shown = 0, rep = 0, shownU = 0, repU = 0, quiet = 0, first45 = []
    for (const r of rs) {
      const a = repeats(r.linesShown); shown += a.shown; rep += a.repeats
      const u = repeats(r.linesShown.filter((l) => l.cls !== 'light' && l.cls !== 'floor')); shownU += u.shown; repU += u.repeats
      const ts = [...r.events.filter((e) => e.tier === 'A').map((e) => e.t), ...r.linesShown.filter((l) => l.cls !== 'light').map((l) => l.t)].sort((x, y) => x - y)
      quiet += quietStretches(ts, r.seconds, QUIET_S)
      first45.push(r.linesShown.filter((l) => l.t < 45).length)
    }
    // a beat is dread's own when the hunt's level alone (tension huntLevel) would not sound one; the rest are the hunt's, its slow fade
    // after a hunt ends included
    const beats = rs.flatMap((r) => r.events.filter((e) => e.kind === 'heartbeat'))
    const dreadBeat = (e) => !e.detail.h && e.detail.hl != null && T.TEN.heartbeatPeriod(e.detail.hl) === Infinity
    const isFar = (e) => e.detail.pd < 0 || e.detail.pd > 24
    const far = beats.filter(isFar)
    const sightings = [], cued = []
    for (const r of rs) {
      const st = r.events.filter((e) => e.kind === 'creature-sighted' || e.kind === 'creature-again').map((e) => e.t)
      const cues = r.events.filter((e) => TELL_KINDS.has(e.kind)).map((e) => e.t)
      const tellsOnly = r.events.filter((e) => e.kind === 'tell' || e.kind === 'tell:seen').map((e) => e.t)
      // the first 5 s of a visit: nothing can come 5 s before those, so they are also counted apart
      const late = st.filter((t) => t >= 5)
      sightings.push(st.length); cued.push([preceded(st, cues), preceded(st, tellsOnly), late.length, preceded(late, cues)])
    }
    lv[mode] = {
      walks: rs.length, secondsTotal: r1(totalS), cellsWalked: dist(rs.map((r) => r.cellsWalked)), distinctCells: dist(rs.map((r) => r.distinctCells)),
      chunksVisited: dist(rs.map((r) => r.chunksVisited)), maxDisplacement: dist(rs.map((r) => r.maxDisplacement)),
      firstCreatureSighting: { ...dist(fin(firstSeen)), walksWithNone: firstSeen.filter((t) => !Number.isFinite(t)).length },
      creatureSightingsPerHour: r1(3600 * rs.reduce((s, r) => s + r.events.filter((e) => e.kind === 'creature-sighted' || e.kind === 'creature-again').length, 0) / totalS),
      nearestCreature: index === 0 ? null : {
        medianDistance: r1(pct(nearAll.filter((v) => v !== null), 50)),
        pctSecondsWithinFog: r1(100 * nearAll.filter((v) => v !== null && v <= fog).length / Math.max(1, nearAll.length)),
        creaturesInWindow: dist(rs.flatMap((r) => r.creaturesInWindowEachSecond)),
      },
      huntedShare: r2(rs.reduce((s, r) => s + r.huntedS, 0) / totalS), gazeShare: r2(rs.reduce((s, r) => s + r.gazeS, 0) / totalS),
      heartbeatAudibleShare: r2(rs.reduce((s, r) => s + r.tensionAudibleS, 0) / totalS),
      hitsPer10Min: r2(600 * rs.reduce((s, r) => s + r.hits, 0) / totalS), deaths: rs.reduce((s, r) => s + r.deaths, 0), minHp: dist(rs.map((r) => r.minHp)),
      sanity: { mean: dist(rs.map((r) => r.meanSanity)), min: dist(rs.map((r) => r.minSanity)), end: dist(rs.map((r) => r.endSanity)) },
      linesShownPerMinute: r2(60 * lines.length / totalS), murmurShare: r2(murm / Math.max(1, lines.length)),
      per100CellsWalked: per100, perMinute: perMin, tiers: tierStats,
      tier1: {
        lightOffShare: r2(rs.reduce((s, r) => s + (r.lightOffS ?? 0), 0) / totalS),
        repeatShare: r2(rep / Math.max(1, shown)), repeatShareNoLight: r2(repU / Math.max(1, shownU)), linesShown: shown,
        quietStretchesPer5Min: r2(300 * quiet / totalS),
        happeningGapP90: tierStats.A.gapSeconds.p90, happeningGapP50: tierStats.A.gapSeconds.p50,
        linesFirst45s: dist(first45),
        sightings: sightings.reduce((s, v) => s + v, 0), sightingsCued: cued.reduce((s, v) => s + v[0], 0), sightingsTold: cued.reduce((s, v) => s + v[1], 0),
        sightingsAfter5s: cued.reduce((s, v) => s + v[2], 0), sightingsAfter5sCued: cued.reduce((s, v) => s + v[3], 0),
        heartbeats: beats.length, heartbeatsDread: beats.filter(dreadBeat).length,
        heartbeatsFar: far.length, heartbeatsFarDread: far.filter(dreadBeat).length,
        // a dread beat no creature is within 24 path cells of: the field saw one (dr > 0) the walker's own BFS does not, or the beat came
        // after dread had already gone (the level's slow fall)
        heartbeatsFarDreadSplit: { fieldDisagrees: far.filter((e) => dreadBeat(e) && e.detail.dr > 0).length, afterDreadGone: far.filter((e) => dreadBeat(e) && !(e.detail.dr > 0)).length },
        smilerLinesMaxPerWalk: Math.max(0, ...rs.map((r) => r.linesShown.filter((l) => l.text === SMILER).length)),
        smilerFreezesMaxPerWalk: Math.max(0, ...rs.map((r) => r.events.filter((e) => e.kind === 'hunt:smiler-freeze').length)),
        lightLinesMaxPerWalk: Math.max(0, ...rs.map((r) => r.linesShown.filter((l) => l.cls === 'light').length)),
        tells: rs.reduce((s, r) => s + r.events.filter((e) => e.kind === 'tell').length, 0),
        tellsSeen: rs.reduce((s, r) => s + r.events.filter((e) => e.kind === 'tell:seen').length, 0),
      },
    }
    if (mode === 'seek') {
      const capped = rs.map((r) => (r.reachedAt === null ? WALK_S : r.reachedAt))
      lv[mode].reach = {
        ...dist(rs.filter((r) => r.reachedAt !== null).map((r) => r.reachedAt)), censoredP50: r1(pct(capped, 50)), censoredP90: r1(pct(capped, 90)),
        reachedBy: Object.fromEntries(['down', 'lift', 'ring'].map((k) => [k, rs.filter((r) => r.reachedKind === k).length])), notReached: rs.filter((r) => r.reachedAt === null).length,
        compassMisledWalks: rs.filter((r) => r.misled > 0).length, sentUpWalks: rs.filter((r) => (r.sentUp ?? 0) > 0).length,
        cellsToReach: dist(rs.filter((r) => r.reachedAt !== null).map((r) => r.cellsWalked)),
        pullShownAt: dist(rs.filter((r) => r.pullAt !== null && r.pullAt !== undefined).map((r) => r.pullAt)), hintedWalks: rs.filter((r) => r.hinted).length,
      }
    }
  }
  summary.floors[index] = lv
}

// ── the drawers, over that tree's own table: the 20,000-key sweep (containers.test.js's: eight prop indices a chunk) and every container
//    actually placed in the 7x7 window round the arrival of each walked world ──
const KINDS = ['empty', 'item', 'note', 'trace', 'haunt']
const hist = (rolls) => { const h = Object.fromEntries(KINDS.map((k) => [k, 0])); for (const r of rolls) h[r.kind] = (h[r.kind] ?? 0) + 1; for (const k in h) h[k] = r2(100 * h[k] / Math.max(1, rolls.length)); h.n = rolls.length; return h }
summary.drawers = {}
for (const index of [0, 1, 2, 3]) {
  const salt = T.LV.levelConfig(T.W.DEFAULT_CONFIG, index).maze?.salt | 0
  const sweep = []
  for (let cx = -60; sweep.length < 20000; cx++) for (let cy = -60; cy < 60 && sweep.length < 20000; cy++) for (let i = 0; i < 8 && sweep.length < 20000; i++) sweep.push(T.CON.rollContainer(`${cx},${cy}:${i}`, cx, cy, index, 0, salt))
  const placed = []
  for (const seed of W.seeds) {
    const f = T.buildFloor(index, seed, { cx: 0, cy: 0 })
    const seen = new Set()
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      f.decor.update(dx, dy)
      for (const p of f.decor.getProps()) {
        if (T.CON.CONTAINER_TYPES[p.type] === undefined || seen.has(p.key)) continue
        seen.add(p.key)
        const [cx, cy] = String(p.key).split(':')[0].split(',').map(Number)
        placed.push(T.CON.rollContainer(p.key, cx, cy, index, seed | 0, salt))
      }
    }
  }
  summary.drawers[index] = { sweep: hist(sweep), placed: hist(placed) }
}

mkdirSync(path.dirname(OUT), { recursive: true })
writeFileSync(OUT + '.json', JSON.stringify(summary, null, 1))

// ── the markdown ──
const md = []
const row = (...c) => md.push('| ' + c.join(' | ') + ' |')
const F = FLOORS
md.push(`# pacing walker: ${summary.version} at ${W.src}\n`)
md.push(`${nSeeds} worlds x ${WALK_S} s per floor and walker; light off ${W.lightOff * 100}% of the time${W.legacy ? ' (legacy: the 2.0.3-era walker)' : ''}.\n`)
md.push('## Tier 1 measures\n')
row('measure', ...F.map((i) => 'L' + i)); row('---', ...F.map(() => '---'))
const ex = (i) => summary.floors[i].explore, sk = (i) => summary.floors[i].seek
if (F.every((i) => sk(i))) {
  row('seek-walk time to a way on, p50 / p90 (s; not reached counts as the cap)', ...F.map((i) => `${sk(i).reach.censoredP50} / ${sk(i).reach.censoredP90}`))
  row(`seek walkers reaching a way on (of ${nSeeds})`, ...F.map((i) => `${nSeeds - sk(i).reach.notReached}`))
  row(`seek walkers sent to a stair up first by the compass (of ${nSeeds})`, ...F.map((i) => sk(i).reach.sentUpWalks))
  row(`seek walkers that met a stair up first at all (of ${nSeeds})`, ...F.map((i) => sk(i).reach.compassMisledWalks))
}
if (F.every((i) => ex(i))) {
  row('light-off share (explore)', ...F.map((i) => ex(i).tier1.lightOffShare))
  row('repeated lines within 5 min (explore, all lines / without the light\'s)', ...F.map((i) => `${r1(100 * ex(i).tier1.repeatShare)}% / ${r1(100 * ex(i).tier1.repeatShareNoLight)}%`))
  row('lines shown in the first 45 s (walker, max)', ...F.map((i) => ex(i).tier1.linesFirst45s.max))
  row('quiet stretches >= 45 s per 5 min (explore)', ...F.map((i) => ex(i).tier1.quietStretchesPer5Min))
  row('gap between happenings p50 / p90 (s, explore)', ...F.map((i) => `${ex(i).tier1.happeningGapP50} / ${ex(i).tier1.happeningGapP90}`))
  const both = (i, k) => (ex(i).tier1[k] ?? 0) + (sk(i)?.tier1[k] ?? 0)
  row('sightings preceded by a tell or heartbeat 5-25 s earlier (both walkers)', ...F.map((i) => `${both(i, 'sightingsCued')}/${both(i, 'sightings')}`))
  row('heartbeats / of them dread\'s own (both walkers)', ...F.map((i) => `${both(i, 'heartbeats')} / ${both(i, 'heartbeatsDread')}`))
  row('heartbeats with no creature within 24 path cells: dread\'s own / all (both walkers)', ...F.map((i) => `${both(i, 'heartbeatsFarDread')} / ${both(i, 'heartbeatsFar')}`))
  row('tells / seen-tells (both walkers)', ...F.map((i) => `${both(i, 'tells')} / ${both(i, 'tellsSeen')}`))
  row('smiler teaching lines / freezes, most in one walk (explore)', ...F.map((i) => `${ex(i).tier1.smilerLinesMaxPerWalk} / ${ex(i).tier1.smilerFreezesMaxPerWalk}`))
  row('flashlight lines, most in one walk (explore)', ...F.map((i) => ex(i).tier1.lightLinesMaxPerWalk))
}
md.push('\n## drawers (this tree\'s containers table)\n')
row('floor', 'sweep: item / empty / note / trace / haunt (%)', 'placed: item / empty / note / trace / haunt (%)', 'placed n')
row('---', '---', '---', '---')
for (const i of [0, 1, 2, 3]) { const d = summary.drawers[i]; row(i, `${d.sweep.item} / ${d.sweep.empty} / ${d.sweep.note} / ${d.sweep.trace} / ${d.sweep.haunt}`, `${d.placed.item} / ${d.placed.empty} / ${d.placed.note} / ${d.placed.trace} / ${d.placed.haunt}`, d.placed.n) }
md.push(`\n## explore walks\n`)
row('floor', `first creature seen (median s, n/${nSeeds})`, 'creature sightings / h', 'A moments / min', 'A gap p50 / p90 / max (s)', '% 10 s windows: no A', 'no A or B', 'no A, B or C', 'no A-C (flicker, swell excluded)')
row('---', '---', '---', '---', '---', '---', '---', '---', '---')
for (const i of F) {
  const e = ex(i); if (!e) continue
  row(i, i === 0 ? 'none (off)' : `${e.firstCreatureSighting.p50 ?? '-'} (${nSeeds - e.firstCreatureSighting.walksWithNone}/${nSeeds})`, e.creatureSightingsPerHour, e.tiers.A.momentsPerMinute,
    `${e.tiers.A.gapSeconds.p50} / ${e.tiers.A.gapSeconds.p90} / ${e.tiers.A.gapSeconds.max}`, e.tiers.A.pctEmpty10sWindows, e.tiers.AB.pctEmpty10sWindows, e.tiers.ABC.pctEmpty10sWindows, e.tiers.ABC_noFlickerNoSwell.pctEmpty10sWindows)
}
if (F.every((i) => sk(i))) {
  md.push(`\n## seek walks (compass-following to the way on, cap ${WALK_S} s)\n`)
  row('floor', 'reached', 'time p50 / p90 / max of those reached (s)', 'cells p50', 'by kind', 'sent to a stair up / met one', 'pull first shown p50 (s)', 'walks with a hint')
  row('---', '---', '---', '---', '---', '---', '---', '---')
  for (const i of F) { const s = sk(i); row(i, `${nSeeds - s.reach.notReached}/${nSeeds}`, `${s.reach.p50} / ${s.reach.p90} / ${s.reach.max}`, s.reach.cellsToReach.p50, JSON.stringify(s.reach.reachedBy), `${s.reach.sentUpWalks} / ${s.reach.compassMisledWalks}`, s.reach.pullShownAt.p50 ?? '-', s.reach.hintedWalks) }
}
md.push('\n## per 100 cells walked (explore)\n')
const keys = [...new Set(F.flatMap((i) => Object.keys(ex(i)?.per100CellsWalked ?? {})))].sort()
row('kind', ...F.map((i) => 'L' + i)); row('---', ...F.map(() => '---'))
for (const k of keys) row(k, ...F.map((i) => ex(i)?.per100CellsWalked[k] ?? 0))
md.push('\n## pressure (explore)\n')
row('floor', 'hunted share', 'heartbeat audible share', 'hits / 10 min', 'min HP p50', 'sanity mean p50', 'sanity min p10', 'nearest creature p50 (u)', '% s a creature within fog', 'creatures in window p50', 'lines shown / min', 'murmur share of lines')
row('---', '---', '---', '---', '---', '---', '---', '---', '---', '---', '---', '---')
for (const i of F) {
  const e = ex(i); if (!e) continue
  const n = e.nearestCreature
  row(i, e.huntedShare, e.heartbeatAudibleShare, e.hitsPer10Min, e.minHp.p50, e.sanity.mean.p50, e.sanity.min.p10, n ? n.medianDistance : '-', n ? n.pctSecondsWithinFog : '-', n ? n.creaturesInWindow.p50 : '-', e.linesShownPerMinute, e.murmurShare)
}
writeFileSync(OUT + '.md', md.join('\n') + '\n')
console.log(md.join('\n'))
