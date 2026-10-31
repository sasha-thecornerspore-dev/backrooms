// stats.mjs — read the bot's sessions (run.mjs output) and write, per session, digest.txt (a minute-by-minute account) and, across
// them, stats.txt (lines, drawers, finds, threats) and metrics.json (the Tier 1 numbers the RESULTS table quotes). Node only.
//
//   node tools/pacing/bot/stats.mjs --dir <run.mjs --out dir>
//
// How lines are told apart (the same rules on every tree, so 2.0.3 and 2.0.4 are measured alike):
//   a plate          a new text on #msg once it is visible (the HUD, not the queue; bot.js dims it by the travel's or a death's
//                    black veil, so a line put up while the screen is black is none)
//   player-caused    its showMessage came within 2.5 s after a key the bot pressed to act (E, F, Q, L, Space, C): a search's result,
//                    a soul's word, the light, an item; the plate budget never counts these
//   a warning        a hunt line ('it has seen you.', 'it has you.', ...): never budgeted either
//   budgeted         every other plate: the floor's line, the arrival lines, murmurs, events, haunts — what T1-4's budget governs
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, repeats, quietStretches, preceded, gaps, moments, dist, r1, r2 } from '../lib.mjs'

const { val } = parseArgs(process.argv.slice(2), ['dir'])
const DIR = path.resolve(val.dir)
// every session folder run.mjs left (repeats over seeds are <name>-s<seed>), grouped by the session they repeat
const SESSIONS = readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(path.join(DIR, d.name, 'log.jsonl'))).map((d) => d.name).sort()
const group = (name) => name.replace(/-s\d+$/, '')
const LIGHT_LINES = new Set(['flashlight on.', 'flashlight off — the dark leans in.'])
const SMILER = 'it stops when you look. do not look away.'
const RUMMAGE = 'you rummage.'
const WARNINGS = new Set(['it has seen you.', 'something has seen you.', 'it has you.', 'it is close.', 'the current finds you.', 'it gathers itself. push now.',
  'something takes your ankles.', 'you have lost it. it is still looking.', 'it stops. it turns.', 'it has nowhere to go. it turns.', 'it skids past.', 'it looks away first.',
  'something, far off, stops.', SMILER])
const ACT_KEYS = /^(KeyE|KeyF|KeyQ|KeyL|Space|KeyC|Tab) /
// the measured tree's own murmurs, exit hints and setting's line (from the instrumented copy run.mjs left beside the sessions): always
// unprompted, whatever key the bot happened to press just before
const UNPROMPTED = new Set()
// and its bump lines (feedback.js BUMP_LINES), the lines for edging through clutter (placement.js CLUTTER_LINES) and landmarks'
// first-sight lines (sightpins.js SIGHT_LINES): walking into furniture, through it or up to a landmark is yours, key or no key
const BUMPS = new Set()
{
  const R = path.join(DIR, 'src', 'renderer')
  const lv = path.join(R, 'levels.js'), wd = path.join(R, 'world.js'), fb = path.join(R, 'feedback.js'), sp = path.join(R, 'sightpins.js'), pl = path.join(R, 'placement.js')
  if (existsSync(sp)) { const SP = await import(pathToFileURL(sp).href); for (const v of Object.values(SP.SIGHT_LINES ?? {})) if (v?.line) BUMPS.add(v.line) }
  if (existsSync(pl)) { const PL = await import(pathToFileURL(pl).href); for (const v of Object.values(PL.CLUTTER_LINES ?? {})) BUMPS.add(v) }
  if (existsSync(lv) && existsSync(wd)) {
    const LV = await import(pathToFileURL(lv).href), WD = await import(pathToFileURL(wd).href)
    for (let i = 0; i < 4; i++) { const c = LV.levelConfig(WD.DEFAULT_CONFIG, i); for (const m of [...(c.messages || []), c.exit?.hint]) if (m) UNPROMPTED.add(m) }
    if (LV.LOST_LINE) UNPROMPTED.add(LV.LOST_LINE)
  }
  if (existsSync(fb)) { const FB = await import(pathToFileURL(fb).href); for (const v of Object.values(FB.BUMP_LINES ?? {})) BUMPS.add(v) }
}
// a line said within this long after a travel or a death, with no key pressed since, is the arrival's (the floor's line, the way's line,
// game.js later()'s delayed ones up to 11 s), though a key took you there
const ARRIVAL_S = 12
const HAS_PLATES = existsSync(path.join(DIR, 'patch.json')) && JSON.parse(readFileSync(path.join(DIR, 'patch.json'), 'utf8')).gameHooks.includes('plate')

function readSession(name) {
  const dir = path.join(DIR, name)
  const rows = readFileSync(path.join(dir, 'log.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  const summary = existsSync(path.join(dir, 'summary.json')) ? JSON.parse(readFileSync(path.join(dir, 'summary.json'), 'utf8')) : {}
  return { name, dir, rows, summary }
}

function measure(S) {
  const { rows, summary } = S
  const end = summary.gameS ?? Math.max(...rows.filter((r) => r.t != null).map((r) => r.t))
  const keys = rows.filter((r) => r.k === 'key' && ACT_KEYS.test(String(r.d))).map((r) => r.t)
  // a line said in the same instant as an event or a haunt fired is that happening's (unless a search rolled it: then it is yours)
  const marks = rows.filter((r) => r.k === 'event' || r.k === 'haunt' || r.k === 'roll').map((r) => ({ t: r.t, k: r.k }))
  const says = rows.filter((r) => r.k === 'say').map((r) => {
    const near = marks.filter((m) => Math.abs(m.t - r.t) <= 0.05)
    return { t: r.t, text: r.d[0], prio: r.d[1], happening: near.some((m) => m.k !== 'roll') && !near.some((m) => m.k === 'roll') }
  })
  const msgRows = rows.filter((r) => r.k === 'dom:msg')
  // '(veiled)' (bot.js): the text is up, but the black veil of a travel or a death covers it. It hides like '(hidden)', and the same text
  // given back just after it (the old line still fading as the veil lifts) is the plate it was, going on, not a new one
  const hid = (d) => d === '(hidden)' || d === '(veiled)'
  const goesOn = (i) => i >= 2 && msgRows[i - 1].d === '(veiled)' && msgRows[i - 2].d === msgRows[i].d
  const moves = rows.filter((r) => r.k === 'travel' || r.k === 'die').map((r) => r.t)
  // the plates, each classified
  const shows = []
  for (let i = 0; i < msgRows.length; i++) {
    const r = msgRows[i]
    if (hid(r.d) || goesOn(i)) continue
    const say = [...says].reverse().find((s) => s.t <= r.t + 0.05 && r.t - s.t < 6 && s.text.replace(/\s+/g, ' ').trim().slice(0, 400) === r.d)
    // whichever came last decides: a key you pressed after you arrived (the map's first opening) is yours; the travel your F started is not
    const before = (list) => { let b = -Infinity; if (say) for (const x of list) if (x <= say.t + 0.05 && x > b) b = x; return b }
    const lastKey = before(keys), lastMove = before(moves)
    const arrival = !!say && lastMove >= lastKey && say.t - lastMove <= ARRIVAL_S
    const player = !!say && (BUMPS.has(say.text) || (!arrival && !say.happening && !UNPROMPTED.has(say.text) && say.t - lastKey <= 2.5))
    shows.push({ t: r.t, text: r.d, cls: WARNINGS.has(r.d) ? 'warning' : player ? 'player' : 'budgeted' })
  }
  // on screen: from each shown text to the next text, '(hidden)' or '(veiled)', and whose time it was
  let onS = 0, since = null, cur = null, si = 0
  const onBy = { budgeted: 0, player: 0, warning: 0 }
  const close = (t) => { if (since !== null) { onS += t - since; onBy[cur] += t - since } }
  for (let i = 0; i < msgRows.length; i++) {
    const r = msgRows[i]
    close(r.t)
    if (hid(r.d)) since = null
    else { since = r.t; if (!goesOn(i)) cur = shows[si++].cls }
  }
  close(end)
  // arrivals and the first 45 s of each
  // (a window ends early at the next arrival: each arrival has its own budget). The first arrival is the game's start, play clock 0: the bot
  // logs it at its own first frame, a few frames later
  const arrivals = rows.filter((r) => r.k === 'level').map((r, i) => (i === 0 && r.t < 0.5 ? 0 : r.t))
  const firstWin = arrivals.map((a, i) => {
    const hi = Math.min(a + 45, arrivals[i + 1] ?? Infinity), inWin = shows.filter((s) => s.t >= a && s.t < hi)
    return { at: a, span: r1(Math.min(45, hi - a)), all: inWin.length, budgeted: inWin.filter((s) => s.cls === 'budgeted').length, lines: inWin.map((s) => [r1(s.t - a), s.text.slice(0, 60), s.cls]) }
  })
  // drawers: what each search rolled (containers.applyRoll, patched)
  const rolls = rows.filter((r) => r.k === 'roll').map((r) => String(r.d).split(':')[0])
  const rollHist = {}; for (const k of rolls) rollHist[k] = (rollHist[k] ?? 0) + 1
  // the creatures: first sight of each (the bot's own cone + line of sight), and the cues before
  const sightings = rows.filter((r) => r.k === 'seen' && /^thing:/.test(String(r.d))).map((r) => r.t)
  const tells = rows.filter((r) => r.k === 'tell').map((r) => r.t)
  const seenTells = says.filter((s) => s.text === 'something has seen you.').map((s) => s.t)
  const beats = rows.filter((r) => r.k === 'audio' && /^heartbeat/.test(String(r.d))).map((r) => r.t)
  const happen = [...rows.filter((r) => ['event', 'haunt', 'die'].includes(r.k)).map((r) => r.t), ...sightings, ...shows.filter((s) => s.cls === 'warning').map((s) => s.t)].sort((a, b) => a - b)
  const quietMarks = [...happen, ...shows.filter((s) => s.cls !== 'player').map((s) => s.t)].sort((a, b) => a - b)
  const travel = rows.find((r) => r.k === 'travel')
  const rep = repeats(shows), repNoPlayer = repeats(shows.filter((s) => s.cls !== 'player'))
  const plateRows = rows.filter((r) => r.k === 'plate')
  return {
    gameS: r2(end), frames: summary.frames ?? null, wallS: summary.wallS ? Math.round(summary.wallS) : null,
    plates: shows.length, platesPerMin: r2(60 * shows.length / end), plateOnScreenShare: r2(onS / end),
    plateOnScreenBy: Object.fromEntries(Object.entries(onBy).map(([k, v]) => [k, r2(v / end)])),
    arrivals: firstWin, platesFirst45Max: Math.max(0, ...firstWin.map((w) => w.all)), budgetedFirst45Max: Math.max(0, ...firstWin.map((w) => w.budgeted)),
    repeatShare: r2(rep.repeats / Math.max(1, rep.shown)), repeatShareNoPlayer: r2(repNoPlayer.repeats / Math.max(1, repNoPlayer.shown)),
    rummage: shows.filter((s) => s.text === RUMMAGE).length, lightLines: shows.filter((s) => LIGHT_LINES.has(s.text)).length, smilerLines: shows.filter((s) => s.text === SMILER).length,
    searches: rows.filter((r) => r.k === 'search').length, rolls: rolls.length, rollHist,
    freshLobbyS: group(S.name) === 'fresh-takes-way' ? (travel ? travel.t : null) : undefined,
    events: rows.filter((r) => r.k === 'event').map((r) => [Math.round(r.t), r.d]), haunts: rows.filter((r) => r.k === 'haunt').length,
    sightings: sightings.length, sightingsCued: preceded(sightings, [...tells, ...seenTells, ...beats]), tells: tells.length, seenTells: seenTells.length, heartbeats: beats.length,
    quietStretchesPer5Min: r2(300 * quietStretches(quietMarks, end, 45) / end), happeningGapP90: dist(gaps(moments(happen), end)).p90,
    plateDecisions: HAS_PLATES ? Object.fromEntries(['show', 'queue', 'none'].map((d) => [d, plateRows.filter((r) => r.d[2] === d).length])) : null,
    pagesRead: rows.filter((r) => r.k === 'dom:note-text' && !hid(r.d)).map((r) => Math.round(r.t)),
    taken: shows.filter((s) => /^you take the/.test(s.text)).map((s) => [Math.round(s.t), s.text]),
    consoleErrors: rows.filter((r) => r.k === 'console-error').length,
    shows,
  }
}

// ── digest.txt: what the session was like, minute by minute ──
function digest(S, M) {
  const { rows, summary } = S
  const out = []
  const P = (...a) => out.push(a.join(' '))
  P('# session', S.name)
  P('frames', summary.frames, 'game s', summary.gameS, 'wall s', summary.wallS)
  P('cells visited', summary.cells, 'things seen', summary.seenCount, JSON.stringify(summary.seenKinds))
  P('audio calls', JSON.stringify(summary.audio))
  const ticks = rows.filter((r) => r.k === 'tick')
  let walked = 0
  for (let i = 1; i < ticks.length; i++) if (ticks[i].d.lvl === ticks[i - 1].d.lvl) walked += Math.hypot(ticks[i].d.x - ticks[i - 1].d.x, ticks[i].d.y - ticks[i - 1].d.y)
  P('distance walked (cells)', r1(walked))
  P('plates shown', M.plates, '(budgeted', M.shows.filter((s) => s.cls === 'budgeted').length + ', player-caused', M.shows.filter((s) => s.cls === 'player').length + ', warnings', M.shows.filter((s) => s.cls === 'warning').length + ')',
    ' on screen', Math.round(100 * M.plateOnScreenShare) + '%', ' repeats', Math.round(100 * M.repeatShare) + '%')
  for (const a of M.arrivals) P(`arrival at ${r1(a.at)} s: ${a.all} plates in ${a.span} s (${a.budgeted} budgeted): ${a.lines.map((l) => `${l[0]}s "${l[1]}" [${l[2]}]`).join('; ')}`)
  const wins = summary.windows || []
  const interesting = /^(item|scrap|form|machine|soul|way|box|sight|thing)/
  const empty = wins.filter(([, ks]) => !ks.some((k) => interesting.test(k)))
  P('6-s windows:', wins.length, ' with nothing interactable/alive in view:', empty.length, JSON.stringify(empty.map(([w]) => w * 6).slice(0, 40)))
  for (let mi = 0; mi < 4; mi++) {
    const tk = ticks.filter((r) => Math.floor(r.t / 60) === mi)
    if (!tk.length) continue
    P(`\n## minute ${mi} (${mi * 60}-${mi * 60 + 60} s)`)
    const f = (k) => tk.map((r) => r.d[k])
    P(`hp ${Math.min(...f('hp'))}-${Math.max(...f('hp'))}  san ${Math.min(...f('san'))}-${Math.max(...f('san'))}  legs ${Math.min(...f('st'))}-${Math.max(...f('st'))}  cells ${tk[0].d.cells}->${tk[tk.length - 1].d.cells}  level ${[...new Set(f('lvl'))].join(',')}`)
    const near = tk.filter((r) => r.d.near !== null)
    if (near.length) P('nearest creature', Math.min(...near.map((r) => r.d.near)), 'kinds', [...new Set(near.map((r) => r.d.nearKind))].join(','), 'hunted s', tk.filter((r) => r.d.hunted).length, 'max dread', Math.max(0, ...tk.map((r) => r.d.dread ?? 0)))
    for (const r of rows) {
      if (r.t == null || Math.floor(r.t / 60) !== mi || ['tick', 'audio', 'frame', 'say'].includes(r.k)) continue
      if (r.k.startsWith('dom:') && !['dom:msg', 'dom:item-hint', 'dom:presence-hint', 'dom:note-text', 'dom:wish-dialog', 'dom:hud', 'dom:exit-compass'].includes(r.k)) continue
      P(`  ${r.t.toFixed(2).padStart(7)} ${r.k.padEnd(16)} ${JSON.stringify(r.d).slice(0, 200)}`)
    }
    const aud = {}
    for (const r of rows) if (r.k === 'audio' && r.t != null && Math.floor(r.t / 60) === mi) { const n = String(r.d).split('(')[0]; aud[n] = (aud[n] ?? 0) + 1 }
    P('  audio:', JSON.stringify(aud))
  }
  writeFileSync(path.join(S.dir, 'digest.txt'), out.join('\n'))
}

const per = {}
const all = []
const lineCount = new Map()
for (const name of SESSIONS) {
  const S = readSession(name)
  const M = measure(S)
  digest(S, M)
  per[name] = M
  for (const s of M.shows) lineCount.set(s.text, (lineCount.get(s.text) ?? 0) + 1)
  const rh = M.rollHist
  all.push(`\n== ${name} (${M.gameS} s, ${M.frames} frames, wall ${M.wallS} s${M.consoleErrors ? ', ' + M.consoleErrors + ' console errors' : ''})`,
    `  plates ${M.plates} (${M.platesPerMin}/min), on screen ${Math.round(100 * M.plateOnScreenShare)}% (${Object.entries(M.plateOnScreenBy).map(([k, v]) => `${k} ${Math.round(100 * v)}%`).join(', ')}), repeats ${Math.round(100 * M.repeatShare)}% (${Math.round(100 * M.repeatShareNoPlayer)}% without the player's own)`,
    `  first 45 s of each arrival: ${M.arrivals.map((a) => `${a.all} (${a.budgeted} budgeted) at ${r1(a.at)} s`).join('; ')}`,
    `  drawers searched ${M.searches}, rolled ${JSON.stringify(rh)}; 'you rummage.' ${M.rummage}; flashlight lines ${M.lightLines}; smiler lines ${M.smilerLines}`,
    `  pages read at ${JSON.stringify(M.pagesRead)}; taken ${JSON.stringify(M.taken)}; events ${JSON.stringify(M.events)}; haunts ${M.haunts}`,
    `  creatures sighted ${M.sightings} (${M.sightingsCued} with a tell or heartbeat 5-25 s before); tells ${M.tells}, seen-tells ${M.seenTells}, heartbeats ${M.heartbeats}`,
    `  quiet stretches >= 45 s per 5 min ${M.quietStretchesPer5Min}; happening gap p90 ${M.happeningGapP90} s${M.freshLobbyS !== undefined ? `; left the lobby at ${M.freshLobbyS} s` : ''}`,
    M.plateDecisions ? `  plate budget decisions ${JSON.stringify(M.plateDecisions)}` : '  (no plate budget in this tree)')
}
all.push('\n== lines shown across all sessions, most frequent')
for (const [s, c] of [...lineCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) all.push(`  x${String(c).padStart(2)}  ${s.slice(0, 110)}`)
writeFileSync(path.join(DIR, 'stats.txt'), all.join('\n') + '\n')

// ── metrics.json: the cross-session numbers ──
const vals = (k) => SESSIONS.map((n) => per[n][k]).filter((v) => v !== undefined && v !== null)
const rollsAll = {}; let nRolls = 0
for (const n of SESSIONS) for (const [k, v] of Object.entries(per[n].rollHist)) { rollsAll[k] = (rollsAll[k] ?? 0) + v; nRolls += v }
const deep = SESSIONS.filter((n) => group(n) === 'level1' || group(n) === 'level2')
const fresh = SESSIONS.filter((n) => group(n) === 'fresh-takes-way').map((n) => per[n].freshLobbyS)
const freshT = fresh.map((t) => t ?? 180).sort((a, b) => a - b)   // a run that never left counts as the session's length
const metrics = {
  sessions: SESSIONS, gameS: Object.fromEntries(SESSIONS.map((n) => [n, per[n].gameS])),
  platesFirst45Max: Math.max(...vals('platesFirst45Max')), budgetedFirst45Max: Math.max(...vals('budgetedFirst45Max')),
  platesFirst45: Object.fromEntries(SESSIONS.map((n) => [n, per[n].arrivals.map((a) => [a.all, a.budgeted])])),
  plateOnScreen: { min: Math.min(...vals('plateOnScreenShare')), max: Math.max(...vals('plateOnScreenShare')), per: Object.fromEntries(SESSIONS.map((n) => [n, per[n].plateOnScreenShare])),
    by: Object.fromEntries(SESSIONS.map((n) => [n, per[n].plateOnScreenBy])) },
  repeatShare: { min: Math.min(...vals('repeatShare')), max: Math.max(...vals('repeatShare')) },
  rummage: vals('rummage').reduce((s, v) => s + v, 0), lightLinesMaxPerRun: Math.max(...vals('lightLines')), smilerLinesMaxPerRun: Math.max(...vals('smilerLines')),
  smilerLinesTotal: vals('smilerLines').reduce((s, v) => s + v, 0), lightLinesTotal: vals('lightLines').reduce((s, v) => s + v, 0),
  drawers: { rolls: nRolls, ...Object.fromEntries(Object.entries(rollsAll).map(([k, v]) => [k, r2(100 * v / Math.max(1, nRolls))])) },
  freshLobbyS: fresh.length ? { runs: fresh, p50: freshT[Math.floor((freshT.length - 1) / 2)], min: freshT[0], max: freshT[freshT.length - 1] } : null,
  sightingsL1L2: deep.reduce((s, n) => s + per[n].sightings, 0), sightingsCuedL1L2: deep.reduce((s, n) => s + per[n].sightingsCued, 0),
  heartbeats: vals('heartbeats').reduce((s, v) => s + v, 0), tells: vals('tells').reduce((s, v) => s + v, 0),
  quietPer5Min: Object.fromEntries(SESSIONS.map((n) => [n, per[n].quietStretchesPer5Min])),
  consoleErrors: vals('consoleErrors').reduce((s, v) => s + v, 0),
}
writeFileSync(path.join(DIR, 'metrics.json'), JSON.stringify({ metrics, per: Object.fromEntries(SESSIONS.map((n) => [n, { ...per[n], shows: undefined }])) }, null, 1))
console.log(all.join('\n'))
console.log('\n' + JSON.stringify(metrics, null, 1))
