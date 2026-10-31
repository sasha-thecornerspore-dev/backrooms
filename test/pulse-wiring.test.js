// The pulse wiring, pass one (S6a w1): game.js plays your own steps on the edge of a step you actually took, the small sounds of your
// hands (a take, a machine, a page, the map) and the lights cascade's panels, lets the footsteps event keep your pace for real; says
// whether the thing that has seen you is on your screen, and plays its tell from where it is when it is not; lets E read a page
// before the presence, keeps the presence quiet while you are hunted and for the first moments of a fresh lobby, names what drops into
// the tray with its article; and hands the entity system the world seed. Pass two (S6a w2): the compass's faint pull waits for floor
// time or a hint, leans a little off true and never names a stair up, and on the first run's lobby waits for the thread; the setting's
// line is said only while nothing is known and the pull is hidden; the first run's note, soul and room; and the plate budget over the
// arrival and the unprompted lines, with the plates that go. game.js only boots in a page, so these are source guards plus the pieces
// lifted out of game.js and replayed against the real modules.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { STEP_MATERIAL, STEP_GAIN, CALL_SOUNDS } from '../src/renderer/audio.js'
import { FOOTSTEPS_ECHO } from '../src/renderer/events.js'
import { TELL, SEEN_TELL } from '../src/renderer/dread.js'
import { seenLine, SEEN_ON, SEEN_OFF, compassLines, compassText, pullVisible, pullWobble, lostDue, FAINT, PULL_WAIT_S, PULL_FRESH_S, PULL_WOBBLE, PULL_REDRAW_S } from '../src/renderer/compass.js'
import { PRESENCE_HUSH_S, FIRST_NOTE, FIRST_SOUL, FIRST_ROOM, createFirstRun, noteRecord } from '../src/renderer/firstrun.js'
import { createPlateBudget, arrivalPlate, DRAIN_S } from '../src/renderer/plates.js'
import { LOST_LINE, levelConfig } from '../src/renderer/levels.js'
import { searchingHint, CONTAINER_TYPES } from '../src/renderer/containers.js'
import { DEFAULT_CONFIG, CHUNK_SIZE, createChunkCache, createGridReader } from '../src/renderer/world.js'
import { createDecorSystem } from '../src/renderer/decor.js'
import { dressPass } from '../src/renderer/dress.js'
import { hauntsPass } from '../src/renderer/haunts.js'
import { inViewCone, lineOfSight } from '../src/renderer/raycaster.js'
import { HF } from '../src/renderer/gfx-frame.js'
import { whistlePan } from '../src/renderer/rollcall.js'
import { trayLean, standing, placementMods, applyPlacement } from '../src/renderer/docket.js'
import { PRIO } from '../src/renderer/messages.js'
import { BLOCK, LOBBY, waysFor, stairsPass } from '../src/renderer/topology.js'
import { SCRAPS } from '../src/renderer/scraps.js'
import { litOffLine } from '../src/renderer/lightshare.js'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const game = read('../src/renderer/game.js')
const sw = read('../src/sw.js')
const build = read('../tools/build-play.sh')
const at = (s, from = 0) => { const k = game.indexOf(s, from); expect(k, s).toBeGreaterThan(0); return k }
const slice = (from, to) => { const a = at(from), b = game.indexOf(to, a); expect(b, to).toBeGreaterThan(a); return game.slice(a, b) }
const count = (re) => (game.match(re) || []).length
const lift = (re) => { const m = game.match(re); expect(m, String(re)).not.toBeNull(); return m[0] }
const loopAt = game.indexOf('function loop(ts) {')
const OWN = 'const ownSounds = () => level.index >= 0 && level.index <= 3'

describe('the tables the wiring reads', () => {
  it('a walk steps at 0.5, a sprint at 0.9; the four floors have a material and the block none', () => {
    expect(STEP_GAIN).toEqual({ walk: 0.5, sprint: 0.9 }); expect(Object.isFrozen(STEP_GAIN)).toBe(true)
    expect(BLOCK).toBe(4)
    for (const i of [0, 1, 2, 3]) expect(typeof STEP_MATERIAL[i]).toBe('string')
    expect(STEP_MATERIAL[BLOCK]).toBeUndefined()
  })
  it('the footsteps echo: eight of your steps, 140 ms behind each, ended by 0.8 s standing still', () => {
    expect(FOOTSTEPS_ECHO).toEqual({ steps: 8, delay: 0.14, still: 0.8 }); expect(Object.isFrozen(FOOTSTEPS_ECHO)).toBe(true)
  })
  it('the seen tell plays at 0.6, panned at most 0.85 to a side; every tell is a call the audio knows', () => {
    expect(SEEN_TELL).toEqual({ gain: 0.6, pan: 0.85 }); expect(Object.isFrozen(SEEN_TELL)).toBe(true)
    for (const v of Object.keys(TELL)) expect(CALL_SOUNDS).toContain(TELL[v])
  })
  it('the presence hush is 40 s', () => { expect(PRESENCE_HUSH_S).toBe(40) })
})

describe('game.js: the imports and the one predicate for the small sounds', () => {
  it('imports the new names by their real names (the audio tail stays drawerSlide, whistle, bump)', () => {
    expect(game).toMatch(/import \{ initAudio, [^\n]*, humDuck, step, pickup, paper, panelsOut, call, STEP_MATERIAL, STEP_GAIN, drawerSlide, whistle, bump \} from '\.\/audio\.js'/)
    expect(game).toMatch(/import \{ createEventScheduler, EVENTS, FOOTSTEPS_ECHO \} from '\.\/events\.js'/)
    expect(game).toMatch(/import \{ compassLines, compassText, arrivalSummary, seenLine, [^\n]* \} from '\.\/compass\.js'/)   // (w2: the pull's helpers)
    expect(game).toMatch(/import \{ TELL, SEEN_TELL \} from '\.\/dread\.js'/)
    expect(game).toMatch(/import \{ PRESENCE_HUSH_S, [^\n]* \} from '\.\/firstrun\.js'/)                                   // (w2: the thread)
  })
  it('the small sounds are the four floors\' (0-3), declared once outside the loop: the block keeps its silence', () => {
    expect(at(OWN)).toBeLessThan(loopAt)
    expect(count(/const ownSounds = /g)).toBe(1)
  })
  it('every new sound of yours is behind it, but the map\'s (never on the block) and the panels\' (an event, floors 0-3 only)', () => {
    expect(count(/\bstep\(STEP_MATERIAL/g)).toBe(1)
    expect(count(/\bpickup\(\)/g)).toBe(2); expect(count(/if \(ownSounds\(\)\) pickup\(\)/g)).toBe(2)
    expect(count(/paper\('page'\)/g)).toBe(2); expect(count(/if \(ownSounds\(\)\) paper\('page'\)/g)).toBe(2)   // a page, and the first run's note (w2)
    expect(count(/if \(!onScreen && ownSounds\(\)\) call\(/g)).toBe(1)
    expect(count(/paper\('map'\)/g)).toBe(1)
    expect(game).toMatch(/if \(!transitioning && !dialogOpen && !chatOpen && !noteOpen && !cfg\.map && settingsHidden\(\)\) \{\r?\n\s*mapCard\.open\(\);[^\n]*paper\('map'\)/)
  })
})

describe('T1-1: your own steps, and the small sounds', () => {
  const stepSrc = slice('if (echoT > 0 && (echoT -= dt) <= 0) footfall(1)', '// the walk\'s bob, plus the clutter step')
  it('the creatures still hear the held key (moved); your own step is on the stepped edge, right after the edge is read', () => {
    expect(game).toMatch(/const stepN = Math\.floor\(player\.bob \/ Math\.PI\)\r?\n\s*const footstep = moved && stepN !== lastStepN\r?\n\s*lastStepN = stepN\r?\n(\s*\/\/[^\n]*\r?\n)*\s*if \(echoT > 0 && \(echoT -= dt\) <= 0\) footfall\(1\)\r?\n\s*if \(footstep && stepped && ownSounds\(\)\) \{\r?\n\s*step\(STEP_MATERIAL\[level\.index\], wantSprint \? STEP_GAIN\.sprint : STEP_GAIN\.walk\)\r?\n\s*if \(echoSteps > 0\) \{ echoSteps--; echoT = FOOTSTEPS_ECHO\.delay \}\r?\n\s*\}\r?\n\s*if \(stepped\) echoStill = 0\r?\n\s*else if \(echoSteps > 0 && \(echoStill \+= dt\) >= FOOTSTEPS_ECHO\.still\) echoSteps = 0/)
    expect(game).toMatch(/if \(footstep && creaturesLive\) level\.entitySys\.noise\(player\.x, player\.y, \(aiCtx\.sprinting \? 7 : 3\) \* quiet\(quietTimer\)\)/)
  })
  it('the echo state is declared once, outside the loop; the footsteps event sets it', () => {
    const s = 'let echoSteps = 0, echoT = 0, echoStill = 0'
    expect(at(s)).toBeLessThan(loopAt); expect(count(/let echoSteps = /g)).toBe(1)
    const fe = slice("function fireEvent(id, prio = PRIO.ambient, kind = 'event') {", 'function startSearch(p, th) {')   // (w2: the line through the plate budget)
    expect(fe).toMatch(/\} else if \(id === 'footsteps'\) \{\r?\n\s*footfall\(\); echoSteps = FOOTSTEPS_ECHO\.steps; echoStill = 0[^\n]*\r?\n\s*plate\(kind, 'footsteps\. not yours\. they keep your pace, and stop when you stop\.', prio, false\)/)
  })
  // the step block lifted and run frame by frame with the real tables: steps every 0.44 s at 60 Hz
  const run = (frames, st) => {
    const fn = new Function('st', 'step', 'footfall', 'STEP_MATERIAL', 'STEP_GAIN', 'FOOTSTEPS_ECHO',
      `let { footstep, stepped, wantSprint, dt, echoSteps, echoT, echoStill, level } = st\n${OWN}\n${stepSrc}\nObject.assign(st, { echoSteps, echoT, echoStill })`)
    const out = { steps: [], falls: [] }
    for (let f = 0; f < frames.length; f++) {
      Object.assign(st, frames[f])
      fn(st, (m, g) => out.steps.push([f, m, g]), (n) => out.falls.push([f, n]), STEP_MATERIAL, STEP_GAIN, FOOTSTEPS_ECHO)
    }
    return out
  }
  const walk = (n, { stepped = true, sprint = false } = {}) => Array.from({ length: n }, (_, f) => ({ footstep: f % 26 === 0, stepped, wantSprint: sprint, dt: 1 / 60 }))
  const still = (n) => Array.from({ length: n }, () => ({ footstep: false, stepped: false, wantSprint: false, dt: 1 / 60 }))
  it('a walk steps at the floor\'s material, a sprint louder; a key held into a wall, or the block, makes none', () => {
    for (const i of [0, 1, 2, 3]) {
      const o = run(walk(60), { level: { index: i }, echoSteps: 0, echoT: 0, echoStill: 0 })
      expect(o.steps.map((s) => s[0])).toEqual([0, 26, 52])
      for (const s of o.steps) expect([s[1], s[2]]).toEqual([STEP_MATERIAL[i], 0.5])
      expect(o.falls).toEqual([])
    }
    expect(run(walk(30, { sprint: true }), { level: { index: 2 }, echoSteps: 0, echoT: 0, echoStill: 0 }).steps[0]).toEqual([0, 'grate', 0.9])
    expect(run(walk(60, { stepped: false }), { level: { index: 1 }, echoSteps: 0, echoT: 0, echoStill: 0 }).steps).toEqual([])
    expect(run(walk(60), { level: { index: BLOCK }, echoSteps: 0, echoT: 0, echoStill: 0 }).steps).toEqual([])
  })
  it('after the event, each of your next eight steps is echoed by one footfall 140 ms later, and no more', () => {
    const st = { level: { index: 1 }, echoSteps: FOOTSTEPS_ECHO.steps, echoT: 0, echoStill: 0 }
    const o = run(walk(26 * 12), st)
    expect(o.steps).toHaveLength(12)
    expect(o.falls).toHaveLength(8)
    for (let k = 0; k < 8; k++) { expect(o.falls[k][1]).toBe(1); expect(o.falls[k][0] - 26 * k).toBe(Math.ceil(0.14 * 60)) }   // the first frame 140 ms on, at 60 Hz
    expect(st.echoSteps).toBe(0)
  })
  it('and they stop when you stop: 0.8 s still ends the echo (pressing into a wall is standing still)', () => {
    const st = { level: { index: 2 }, echoSteps: FOOTSTEPS_ECHO.steps, echoT: 0, echoStill: 0 }
    const a = run([...walk(52), ...still(45)], st)
    expect(st.echoSteps).toBe(6); expect(a.falls).toHaveLength(2)    // two steps, two echoes; 0.75 s still is not yet 0.8
    const o = run([...still(6), ...walk(60)], st)
    expect(st.echoSteps).toBe(0); expect(o.falls).toEqual([])         // the 0.8 s ran out: walking on, nothing keeps your pace
    const st2 = { level: { index: 2 }, echoSteps: FOOTSTEPS_ECHO.steps, echoT: 0, echoStill: 0 }
    run(walk(60, { stepped: false }), st2); expect(st2.echoSteps).toBe(0)   // W held into a wall the whole time
  })
  it('the frame block allocates nothing: no literal, no closure, no new', () => {
    expect(stepSrc).not.toMatch(/\{ [a-z]+:|=>|\bnew\b|\[\]/)
  })
  it('a take and a machine\'s dispense tick in your hand; a page rustles as it opens, the map as it unfolds; the panels go as the lights do', () => {
    expect(game).toMatch(/if \(res\.ok\) \{ if \(ownSounds\(\)\) pickup\(\); showMessage\(`you take the \$\{ITEM_NAMES\[res\.item\.type\] \?\? res\.item\.type\}\.`\); if \(!nearItem\.key\.startsWith\('d:'\)\) mem\.noteTaken\(level\.index, nearItem\.key\) \}/)
    expect(slice('function dispenseFromMachine(m) {', '// ── snapshot + persistence')).toContain('renderHotbar(); blip(); if (ownSounds()) pickup()')
    expect(game).toMatch(/function openNoteCard\(scrap\) \{\r?\n\s*if \(!scrap \|\| !openCard\('page', \{ text: SCRAPS\[scrap\.frag\] \?\? '' \}, scrap\)\) return\r?\n\s*revealScrap\(\)\r?\n\s*if \(ownSounds\(\)\) paper\('page'\)\r?\n\s*\}/)
    expect(game).toContain("mapCard.open(); mapOpen = true; document.body.classList.add('map-open'); paper('map')")
    expect(game).toMatch(/if \(id === 'lights-cascade'\) \{\r?\n\s*flickTgt = 0\.14; flickTimer = 0\.7[^\n]*\r?\n\s*panelsOut\(\)[^\n]*\r?\n\s*plate\(kind, 'the lights go out ahead of you, one by one\. then, slowly, they come back\.', prio, false\)/)
  })
})

describe('T1-6: seen on screen, or heard', () => {
  const seenSrc = slice("case 'seen':", "case 'lost':")
  it('the line is seenLine(onScreen) at combat behind the same 8 s gate; off screen the tell plays toward its bearing; far is as it was', () => {
    expect(seenSrc).toMatch(/case 'seen':\r?\n\s*turningSaid\.delete\(ev\.id\)\r?\n\s*if \(ev\.d <= fog \* 1\.1\) \{\r?\n\s*if \(playT - lastSeenLine > 8\) \{/)
    expect(seenSrc).toContain('const onScreen = inViewCone(player.x, player.y, player.angle, ev.x, ev.y, HF, fog * 1.1) && lineOfSight(player.x, player.y, ev.x, ev.y, level.grid.floor)')
    expect(seenSrc).toContain('lastSeenLine = playT; showMessage(seenLine(onScreen), PRIO.combat)')
    expect(seenSrc).toContain('if (!onScreen && ownSounds()) call(TELL[ev.variant] ?? TELL.shade, SEEN_TELL.gain, whistlePan(ev.x - player.x, ev.y - player.y, player.angle) * SEEN_TELL.pan)')
    expect(seenSrc).toMatch(/else if \(playT - lastFarLine > 30\) \{ lastFarLine = playT; showMessage\('something, far off, stops\.', PRIO\.ambient\) \}/)
    expect(game).not.toContain("showMessage('it has seen you.'")       // the line is compass.js's now
  })
  // the case lifted into a switch and run on an open room (and a wall), with the real cone, line of sight and pan
  const open = (ix, iy) => !(ix === 14 && iy >= 8 && iy <= 12)    // one wall, x 14, y 8..12; everything else floor
  const mk = () => {
    const st = { said: [], calls: [], lastSeenLine: -Infinity, lastFarLine: -Infinity, playT: 100, index: 1 }
    const fn = new Function('ev', 'st', 'turningSaid', 'player', 'showMessage', 'PRIO', 'inViewCone', 'lineOfSight', 'HF', 'seenLine', 'call', 'TELL', 'SEEN_TELL', 'whistlePan', 'floor',
      `let { lastSeenLine, lastFarLine, playT } = st\nconst level = { index: st.index, cfg: { fogDistance: 10 }, grid: { floor } }\n${OWN}\nconst fog = level.cfg.fogDistance\nswitch (ev.kind) {\n${seenSrc}\n}\nObject.assign(st, { lastSeenLine, lastFarLine })`)
    const player = { x: 10.5, y: 10.5, angle: 0 }                     // facing +x; +y is to your right
    const go = (ev) => fn({ kind: 'seen', id: 3, d: Math.hypot(ev.x - player.x, ev.y - player.y), ...ev }, st, new Set(), player,
      (m, p) => st.said.push([m, p]), PRIO, inViewCone, lineOfSight, HF, seenLine, (s, g, p) => st.calls.push([s, g, p]), TELL, SEEN_TELL, whistlePan, open)
    return { st, go, player }
  }
  it('in front of you, in sight: it has seen you. and no sound', () => {
    const { st, go } = mk()
    go({ x: 13.5, y: 10.0, variant: 'hound' })
    expect(st.said).toEqual([[SEEN_ON, PRIO.combat]]); expect(st.calls).toEqual([])
  })
  it('behind you: something has seen you. and its tell from where it is (right pans right, left pans left)', () => {
    const { st, go } = mk()
    go({ x: 7.5, y: 12.5, variant: 'smiler' })                        // behind, to the right
    expect(st.said).toEqual([[SEEN_OFF, PRIO.combat]])
    expect(st.calls).toHaveLength(1)
    const [s, g, p] = st.calls[0]
    expect([s, g]).toEqual([TELL.smiler, SEEN_TELL.gain])
    expect(p).toBeGreaterThan(0); expect(p).toBeLessThanOrEqual(SEEN_TELL.pan)
    st.playT += 9; go({ x: 10.5, y: 4.5, variant: 'lurker' })         // straight to the left
    expect(st.calls[1]).toEqual([TELL.lurker, SEEN_TELL.gain, -SEEN_TELL.pan])
  })
  it('in the cone but behind a wall is off screen; a thing with no kind is a shade', () => {
    const { st, go } = mk()
    go({ x: 16.5, y: 10.5, variant: 'nothing-known' })
    expect(st.said).toEqual([[SEEN_OFF, PRIO.combat]]); expect(st.calls[0][0]).toBe(TELL.shade)
  })
  it('the same 8 s gate holds the line and the sound together; the far line is untouched', () => {
    const { st, go } = mk()
    go({ x: 7.5, y: 10.5, variant: 'hound' }); st.playT += 4; go({ x: 7.5, y: 10.5, variant: 'hound' })
    expect(st.said).toHaveLength(1); expect(st.calls).toHaveLength(1)
    st.playT += 5; go({ x: 7.5, y: 10.5, variant: 'hound' })
    expect(st.said).toHaveLength(2); expect(st.calls).toHaveLength(2)
    go({ x: 30.5, y: 10.5, variant: 'hound' })                         // past the fog: the far line, no tell
    expect(st.said[2]).toEqual(['something, far off, stops.', PRIO.ambient]); expect(st.calls).toHaveLength(2)
  })
  it('the block keeps its silence: the line, never the sound', () => {
    const { st, go } = mk(); st.index = BLOCK
    go({ x: 7.5, y: 10.5, variant: 'shade' })
    expect(st.said).toEqual([[SEEN_OFF, PRIO.combat]]); expect(st.calls).toEqual([])
  })
})

describe('T1-10: frictions', () => {
  it('a page you have not read comes before the presence, on E and on the hint; not on the block (its form keeps its place)', () => {
    expect(game).toContain('const scrapFirst = !cfg.map && nearScrap !== null && !readSet.has(nearScrap.frag)')
    expect(at('const scrapFirst = ', loopAt)).toBeGreaterThan(at('const nearScrap = level.decor.nearestScrap(player.x, player.y, 1.8)', loopAt))
    const hint = at("const hintEl = document.getElementById('presence-hint')", loopAt)
    expect(hint).toBeGreaterThan(at('const scrapFirst = ', loopAt))
    expect(game).toMatch(/const hintEl = document\.getElementById\('presence-hint'\)\r?\n\s*if \(hintEl\) hintEl\.style\.opacity = nearPresence && !scrapFirst \? '1' : '0'/)
    const e = slice("if (K['KeyE']) {", "if (K['Escape'] && dialogOpen)")
    // (w2: the first run's note takes its turn right after the presence, before the form, the sealed page and the page)
    expect(e).toMatch(/if \(nearPresence && !scrapFirst\) openDialog\(\)\r?\n\s*else if \(nearScrap\?\.firstrun\) openFirstNote\(nearScrap\)\r?\n\s*else if \(nearScrap\) nearScrap\.form \? openForm\(\)/)
    expect(e).not.toMatch(/if \(nearPresence\) openDialog\(\)/)
  })
  it('hunted, the presence keeps quiet; a fresh run\'s first lobby visit hushes it for PRESENCE_HUSH_S; both before the hint and E', () => {
    const k = at('if (thA.hunted || huntMood) nearPresence = false', loopAt)
    const h = at('if (lobbyFirst && deaths === 0 && playT < PRESENCE_HUSH_S) nearPresence = false', loopAt)
    expect(k).toBeGreaterThan(at('if (!isWishOpen(file.closing)) nearPresence = false', loopAt))
    for (const x of [k, h]) { expect(x).toBeLessThan(at("const hintEl = document.getElementById('presence-hint')", loopAt)); expect(x).toBeLessThan(at("if (K['KeyE']) {", loopAt)) }
    expect(at('const thA = level.entitySys.getThreat()', loopAt)).toBeLessThan(k)              // last frame's record: this frame's update is below
    expect(k).toBeLessThan(at('const th = creaturesOn ? level.entitySys.update(', loopAt))
  })
  it('lobbyFirst: declared once outside the loop, written by buildLevel before the arrival is counted', () => {
    expect(at('let lobbyFirst = false')).toBeLessThan(loopAt); expect(count(/let lobbyFirst/g)).toBe(1)
    const b = slice('function buildLevel(index, at = null) {', 'const fader = createFader(')
    expect(b).toContain('lobbyFirst  = index === 0 && !mem.get(0)?.visits')
    expect(count(/(?<!let )lobbyFirst +=/g)).toBe(1)                                         // its one writer
    // a fresh run and a travel build the floor before mem.arrive counts it; a resume imports the memory first, so it is never hushed
    expect(game).toMatch(/buildLevel\(entryLevel\(\{ online: !!mpClient, frontDoor \}\)\); mem\.arrive\(level\.index, spawnChunk, playT\)/)
    const t = slice('function travel(way) {', '// die(): death.js resolves it')
    expect(t.indexOf('buildLevel(way.target, fromC)')).toBeLessThan(t.indexOf('mem.arrive(way.target, spawnChunk, playT)'))
  })
  // the gates lifted and run
  const gates = slice('if (!isWishOpen(file.closing)) nearPresence = false', "const hintEl = document.getElementById('presence-hint')")
  const gate = (o) => new Function('o', 'isWishOpen', 'PRESENCE_HUSH_S', `let nearPresence = true\nconst { file, thA, huntMood, lobbyFirst, deaths, playT } = o\n${gates.slice(0, gates.indexOf('// ── items: pickup prompt'))}\nreturn nearPresence`)(
    { file: { closing: null }, thA: { hunted: false }, huntMood: false, lobbyFirst: false, deaths: 0, playT: 100, ...o }, (c) => c !== 'compliance', PRESENCE_HUSH_S)
  it('replayed: the hunt and the mood silence it, the hush holds only a first lobby visit with no deaths, under 40 s', () => {
    expect(gate({})).toBe(true)
    expect(gate({ file: { closing: 'compliance' } })).toBe(false)
    expect(gate({ thA: { hunted: true } })).toBe(false)
    expect(gate({ huntMood: true })).toBe(false)
    expect(gate({ lobbyFirst: true, playT: 39.9 })).toBe(false)
    expect(gate({ lobbyFirst: true, playT: 40 })).toBe(true)
    expect(gate({ lobbyFirst: true, playT: 10, deaths: 1 })).toBe(true)
    expect(gate({ lobbyFirst: false, playT: 10 })).toBe(true)
  })
  const ITEM_NAMES = new Function(`return ${lift(/const ITEM_NAMES = \{[\s\S]*?\n\}/).replace(/^const ITEM_NAMES = /, '')}`)()
  const TRAY_NAMES = new Function(`return ${lift(/const TRAY_NAMES = \{[\s\S]*?\n\}/).replace(/^const TRAY_NAMES = /, '')}`)()
  it('TRAY_NAMES names every ITEM_NAMES key with its article (a, an or some), lowercase, no digits', () => {
    expect(Object.keys(TRAY_NAMES).sort()).toEqual(Object.keys(ITEM_NAMES).sort())
    for (const [k, v] of Object.entries(TRAY_NAMES)) {
      const m = /^(a|an|some) (.+)$/.exec(v)
      expect(m, v).not.toBeNull(); expect(m[2]).toBe(ITEM_NAMES[k])
      if (m[1] === 'a') expect(m[2]).toMatch(/^[^aeiou]/)
      if (m[1] === 'an') expect(m[2]).toMatch(/^[aeiou]/)
      expect(v).toBe(v.toLowerCase()); expect(v).not.toMatch(/[0-9!]/)
    }
    expect(TRAY_NAMES['almond-water']).toBe('some almond water'); expect(TRAY_NAMES['extension-slip']).toBe('an extension slip')
  })
  it('the tray says it with the article, for everything the machine can drop (the pool, the deep stacks, every lean)', () => {
    const vend = slice('function dispenseFromMachine(m) {', '// ── snapshot + persistence')
    expect(vend).toContain("const clunk = `the machine clunks, and ${TRAY_NAMES[type] ?? type} drops into the tray.${lean.stamp ? ` the tray is stamped ${lean.stamp}.` : ''}`")
    const pool = [...vend.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).filter((t) => t in ITEM_NAMES)
    for (const lead of ['extension', 'compliance', 'litigation']) pool.push(trayLean({ lead }).item)
    expect(pool.length).toBeGreaterThan(8)
    for (const t of pool) expect(TRAY_NAMES[t], t).toBeTruthy()
  })
})

describe('T1-11: the creatures take the world seed', () => {
  it('buildLevel hands worldSeed to the entity system (null is the unseeded world)', () => {
    expect(game).toContain('const entitySys = createEntitySystem(cfg, isWall, { obstacles: solid.forEntities, grid, now: () => playT, seed: worldSeed })')
    expect(count(/createEntitySystem\(/g)).toBe(1)
  })
})

describe('the offline shell lists', () => {
  it('dread.js and firstrun.js are in src/sw.js and tools/build-play.sh, and the cache name moved on', () => {
    for (const f of ['dread.js', 'firstrun.js']) { expect(sw).toContain(`'/renderer/${f}'`); expect(build).toContain(`'${f}'`) }
    expect(Number(/backrooms-pwa-v(\d+)/.exec(sw)[1])).toBeGreaterThanOrEqual(12)
  })
})

// ── pass two (S6a w2) ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// the lobby as buildLevel builds it on the fixed first world (firstrun-world.test.js's recipe: the shipped world.json, the docket's lean,
// the ways, the game's passes), with the first run's note pass lifted out of game.js when asked
const notePass = () => new Function('FIRST_NOTE', 'CHUNK_SIZE', 'noteRecord',
  `${lift(/const NOTE_CHUNK = [^\n]*\r?\n\s*const firstNotePass = [^\n]*/)}\nreturn firstNotePass`)(FIRST_NOTE, CHUNK_SIZE, noteRecord)
function lobby(withNote) {
  const base = { ...DEFAULT_CONFIG, ...JSON.parse(read('../src/renderer/world.json')) }
  const cfg = levelConfig(base, LOBBY)
  applyPlacement(cfg, placementMods(standing(base.docket, 0)))
  cfg.ways = waysFor(LOBBY)
  const cache = createChunkCache(cfg, null)
  const isWall = (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)
  const grid = createGridReader(cache, isWall)
  const decor = createDecorSystem(cfg, isWall, null, { passes: [stairsPass(cfg, cfg.ways), dressPass(cfg), hauntsPass(cfg), withNote ? notePass() : null].filter(Boolean) })
  grid.setPlayerChunk(0, 0); decor.update(0, 0)
  return { cfg, grid, decor }
}
let lobbyW = null
const lobbyOnce = () => lobbyW ?? (lobbyW = lobby(true))
const PLATE = /function plate\(kind, text, prio, keep = true\) \{[\s\S]*?\r?\n {2}\}/
const VISIT = /function startVisit\(\) \{[\s\S]*?\r?\n {2}\}/

describe('w2: the imports, the state, the shell', () => {
  it('imports the pull, the setting\'s line, the thread, the budget and the search hint by their real names', () => {
    expect(game).toMatch(/import \{ levelConfig, TRACKS, LOST_LINE \} from '\.\/levels\.js'/)
    expect(game).toMatch(/import \{ compassLines, compassText, arrivalSummary, seenLine, pullVisible, pullWobble, lostDue, PULL_REDRAW_S \} from '\.\/compass\.js'/)
    expect(game).toMatch(/import \{ PRESENCE_HUSH_S, FIRST_NOTE, createFirstRun, noteRecord \} from '\.\/firstrun\.js'/)
    expect(game).toMatch(/import \{ createPlateBudget, arrivalPlate \} from '\.\/plates\.js'/)
    expect(game).toMatch(/import \{ CONTAINER_TYPES, SEARCH_HOLD_S, DRAWER_COST, rollContainer, applyRoll, createSearchLog, searchingHint \} from '\.\/containers\.js'/)
  })
  it('the visit\'s pull, the thread, the budget and the once-a-run lines are declared once, outside the loop', () => {
    for (const s of [
      'let floorT0 = 0, floorHinted = false, pullPhase = 0, lastCompassT = -Infinity, lostSaid = false, hintHeld = false',
      'const pullAsk = { floorT: 0, hinted: false, fresh: false, step: 0 }',
      'const roomPull = { rec: null, dist: null }',
      'const firstRun = createFirstRun({ fresh: resume ? Number.isInteger(resume.firstRun) : true, step: resume?.firstRun ?? 0, worldSeed, room: !!mpClient })',
      'const freshLobby = () => level.index === 0 && firstRun.on()',
      'const plates = createPlateBudget()',
      'let turnSaid = false, houndTold = false, passTold = false, smilerTold = false',
      'let dreadQuietT = 0, lightToggles = 0, lightSaid = false',
    ]) { expect(at(s)).toBeLessThan(loopAt); expect(game.split(s).length - 1, s).toBe(1) }
    expect(game).toContain('const compassState = { player, known: null, fallback: null, arrived: null, stale: (p) => fog.isStale(level.index, p.chunkKey, epochOf), pull: false, wobble: 0, skip: null }')
  })
  it('the faint arrow\'s slow redraw is the compass\'s own number: short against the wobble\'s swing, never every frame', () => {
    expect(PULL_REDRAW_S).toBeGreaterThan(1 / 60); expect(PULL_REDRAW_S).toBeLessThanOrEqual(1)
  })
  it('plates.js is in src/sw.js and tools/build-play.sh (firstrun.js already is)', () => {
    expect(sw).toContain("'/renderer/plates.js'"); expect(build).toContain("'plates.js'")
  })
})

describe('w2: a visit begins', () => {
  it('startVisit restarts the visit\'s clock, its hint, the lean and the once-a-visit lines, and opens the plate budget\'s window', () => {
    expect(lift(VISIT)).toMatch(/floorT0 = playT; floorHinted = false; pullPhase = Math\.random\(\) \* Math\.PI \* 2; lostSaid = false; hintHeld = false\r?\n\s*plates\.arrive\(playT\)/)
    expect(count(/startVisit\(\)/g)).toBe(4)                               // its declaration, travel, the wake, the start (a resume's too)
  })
  it('travel, the wake and the start begin the visit, then say the floor\'s own plate through the budget (the lift\'s line first)', () => {
    const t = slice('function travel(way) {', '// die(): death.js resolves it')
    expect(t).toMatch(/persist\(true\)[^\n]*\r?\n\s*startVisit\(\)\r?\n(\s*\/\/[^\n]*\r?\n)*\s*if \(way\.kind === 'lift'\) plate\('arrival', wayMessage\(way, \{ before: true \}\), PRIO\.combat\)\r?\n\s*plate\('floor', arrivalPlate\(level\.cfg, first\), PRIO\.combat\)\r?\n\s*const wm = wayMessage\(way, \{ partner, mem: mem\.get\(way\.target\) \}\)/)
    const d = slice('function die(d = null) {', '// ── input ──')
    expect(d).toContain('const first = mem.arrive(level.index, spawnChunk, playT).visits === 1')
    expect(d).toMatch(/persist\(true\)\r?\n\s*startVisit\(\)\r?\n\s*plate\('floor', arrivalPlate\(level\.cfg, first\), PRIO\.combat\)\r?\n\s*later\(2600, r\.message, PRIO\.discovery\)/)
    const boot = slice('if (resume) {', 'if (bus) mpClient.onEv(bus.receive)')
    expect(boot).toMatch(/startVisit\(\)\r?\n\s*plate\('floor', arrivalPlate\(level\.cfg, !resume\), PRIO\.combat\)/)
    expect(game).not.toContain('showMessage(level.cfg.levelName')
    expect(count(/plate\('floor', /g)).toBe(3)
  })
  it('the first visit\'s plate is the floor\'s own line; after that, and always on the block, its name', () => {
    const L0 = levelConfig(DEFAULT_CONFIG, LOBBY), B = levelConfig(DEFAULT_CONFIG, BLOCK)
    expect(arrivalPlate(L0, true)).toBe('the hum of fluorescent light. damp carpet. you are here.')
    expect(arrivalPlate(L0, false)).toBe(L0.levelName)
    expect(arrivalPlate(B, true)).toBe(B.levelName)
  })
})

describe('T1-2: the compass earns its pull', () => {
  const src = () => slice('// ── the faint pull', 'netTimer += dt')
  // decor.js nearestWayOn over a list: never a stair up, one reused record
  const fakeDecor = (ways) => {
    const any = { rec: null, dist: 0 }
    return {
      nearestWayOn: (x, y, skip) => {
        let best = null, bd = Infinity
        for (const w of ways) { if (w.kind === 'up' || (skip && skip(w.kind))) continue; const d = (w.x - x) ** 2 + (w.y - y) ** 2; if (d < bd) { bd = d; best = w } }
        if (!best) return null
        any.rec = best; any.dist = Math.sqrt(bd); return any
      },
    }
  }
  // the block lifted and run frame by frame with the real compass and the real plate budget (its window opened at 0)
  function rig({ index = 1, map = null, decor, known = [], arrived = null, firstRun = createFirstRun(), hint = null, player = { x: 0.5, y: 0.5, angle: 0 } } = {}) {
    const said = [], calls = { n: 0 }
    const plates = createPlateBudget(); plates.arrive(0)
    const level = { index, decor }
    const D = {
      pullAsk: { floorT: 0, hinted: false, fresh: false, step: 0 }, freshLobby: () => level.index === 0 && firstRun.on(), firstRun,
      cfg: { map, exit: hint ? { hint } : undefined }, pullVisible, PRIO, compassEl: { textContent: '', style: { opacity: '' } },
      fog: { ways: () => known, arrivedPin: () => arrived }, level, player,
      compassState: { player, known: null, fallback: null, arrived: null, stale: null, pull: false, wobble: 0, skip: null },
      PULL_REDRAW_S, roomPull: { rec: null, dist: null }, pullWobble, compassLines: (s, o) => { calls.n++; return compassLines(s, o) }, compassOut: [],
      compassText, lostDue, LOST_LINE, plates, showMessage: (t, p) => said.push([t, p]),
    }
    const st = { playT: 0, floorT0: 0, floorHinted: false, hintHeld: false, cellChanged: true, lastCompassAngle: NaN, lastWayCount: -1,
      lastCompassT: -Infinity, lastCompassText: null, lostSaid: false, pullPhase: 0, nearExit: null }
    const fn = new Function('st', 'D', `const { ${Object.keys(D).join(', ')} } = D\nlet { ${Object.keys(st).join(', ')} } = st\n${lift(PLATE)}\n${src()}\n` +
      'Object.assign(st, { hintHeld, lastCompassAngle, lastWayCount, lastCompassT, lastCompassText, lostSaid })')
    const frame = (t, o = {}) => { Object.assign(st, { cellChanged: false }, o, { playT: t }); fn(st, D); return D.compassEl.textContent }
    return { st, D, said, calls, frame }
  }
  const fresh = () => { const f = createFirstRun({ fresh: true }); f.onLevel(LOBBY); return f }
  const ahead = { x: 10.5, y: 0.5, kind: 'down' }, upClose = { x: 0.5, y: 3.5, kind: 'up' }

  it('the faint pull waits 90 s of the visit, names no metres, and never a stair up', () => {
    const r = rig({ decor: fakeDecor([ahead, upClose]) })
    expect(r.frame(0, { cellChanged: true })).toBe('')
    expect(r.frame(PULL_WAIT_S - 0.1)).toBe('')
    expect(r.frame(PULL_WAIT_S)).toBe(`↑  ${FAINT}`)                     // straight ahead (the lean is small this early in its swing)
    expect(r.D.compassState.fallback.rec).toBe(ahead)                   // the stair up is nearer, and passed over
    expect(r.D.compassEl.textContent).not.toMatch(/\d/)
  })
  it('a hint from the floor frees it at once; the next visit (a new floorT0, the hint cleared) waits again', () => {
    const r = rig({ decor: fakeDecor([ahead]) })
    expect(r.frame(5, { cellChanged: true, floorHinted: true })).toBe(`↑  ${FAINT}`)
    expect(r.frame(200, { floorHinted: false, floorT0: 150 })).toBe('')
  })
  it('a known way is exact, with its metres; the pull and its lean never touch it', () => {
    const known = [{ type: 'down', x: 0.5, y: 20.5, label: 'descend', target: 2, lost: false }]
    const r = rig({ decor: fakeDecor([ahead]), known })
    const want = compassText(compassLines({ player: r.D.player, known, fallback: null }, []))
    expect(want).toMatch(/·  20m$/)
    expect(r.frame(0, { cellChanged: true, pullPhase: Math.PI / 2 })).toBe(want)
  })
  it('it leans a little off true on a slow sine of the visit: the faint arrow only, never more than 30°', () => {
    for (const [phase, arrow] of [[0, '↑'], [Math.PI / 2, '↗'], [-Math.PI / 2, '↖']]) {
      const r = rig({ decor: fakeDecor([ahead]) })
      expect(r.frame(0, { cellChanged: true, floorHinted: true, pullPhase: phase }), String(phase)).toBe(`${arrow}  ${FAINT}`)
    }
    const r = rig({ decor: fakeDecor([ahead]) })
    for (let t = 0; t < 120; t += 0.5) { r.frame(t, { floorHinted: true, pullPhase: 1.3 }); expect(Math.abs(r.D.compassState.wobble)).toBeLessThanOrEqual(PULL_WOBBLE + 1e-12) }
  })
  it('redrawn on a slow clock while you stand still (the lean moves with floor time), and in the frame the pull frees', () => {
    const r = rig({ decor: fakeDecor([ahead]) })
    r.frame(0, { cellChanged: true, floorHinted: true })
    const n0 = r.calls.n
    for (let f = 1; f <= 60; f++) r.frame(f / 60, { floorHinted: true })
    expect(r.calls.n - n0).toBeGreaterThanOrEqual(1); expect(r.calls.n - n0).toBeLessThanOrEqual(Math.ceil(1 / PULL_REDRAW_S) + 1)
    let s = ''
    for (let f = 61; f <= 60 * 8; f++) s = r.frame(f / 60, { floorHinted: true })
    expect(s).toBe(`↗  ${FAINT}`)                                      // 30° x sin(8 / 7): about 27°, over the sector line
    const q = rig({ decor: fakeDecor([ahead]) })
    q.frame(PULL_WAIT_S - 0.05, { cellChanged: true }); q.st.lastCompassT = PULL_WAIT_S - 0.05
    expect(q.frame(PULL_WAIT_S)).toBe(`↑  ${FAINT}`)
  })
  it('on the first run\'s lobby it waits for the thread instead (the soul\'s word, or 120 s), then leans toward the room the soul named', () => {
    const L = lobbyOnce(), fr = fresh()
    const soul = L.decor.getNpcs().find((n) => n.key === FIRST_SOUL.key)
    const r = rig({ index: LOBBY, decor: L.decor, firstRun: fr, player: { x: soul.x, y: soul.y, angle: 0 } })
    expect(r.frame(0, { cellChanged: true })).toBe('')
    expect(r.frame(PULL_WAIT_S + 10, { floorHinted: true })).toBe('')    // past 90 s, and hinted: the lobby waits for the thread
    expect(fr.onRead(FIRST_NOTE.key)).toBe(true)
    expect(r.frame(PULL_WAIT_S + 11, { floorHinted: true })).toBe('')
    expect(fr.onSoul(FIRST_SOUL.key)).toBe(FIRST_SOUL.line)
    const s = r.frame(PULL_WAIT_S + 12, { floorHinted: true })
    expect(r.D.compassState.fallback.rec).toBe(FIRST_ROOM.way)
    expect(s).toBe(compassText(compassLines({ player: r.D.player, known: [], fallback: { rec: FIRST_ROOM.way }, wobble: pullWobble(PULL_WAIT_S + 12, 0) }, [])))
    expect(L.decor.nearestWayOn(soul.x, soul.y).rec.key).not.toBe(FIRST_ROOM.way.key)   // by the soul the nearest way is another: the lean is the thread's
  })
  it('a fresh lobby\'s 120 s free it without the thread, toward the nearest way on', () => {
    const L = lobbyOnce()
    const r = rig({ index: LOBBY, decor: L.decor, firstRun: fresh(), player: { x: 11.5, y: 11.5, angle: 0 } })
    expect(r.frame(PULL_FRESH_S - 0.1, { cellChanged: true })).toBe('')
    expect(r.frame(PULL_FRESH_S)).toMatch(new RegExp(`  ${FAINT}$`))
    expect(r.D.compassState.fallback).not.toBe(r.D.roomPull)                     // no thread to lean on yet
    const k = r.D.compassState.fallback.rec.key
    expect(k).toBe(L.decor.nearestWayOn(11.5, 11.5).rec.key); expect(k).toBe(FIRST_ROOM.way.key)   // from the spawn the nearest is the room's own
  })
  it('the setting\'s line: on the lobby only, while nothing is known and the pull is hidden, once a visit, through the budget', () => {
    const r = rig({ index: LOBBY, decor: fakeDecor([ahead]) })
    r.frame(0, { cellChanged: true }); r.frame(1); r.frame(30)
    expect(r.said).toEqual([[LOST_LINE, PRIO.discovery]]); expect(r.st.lostSaid).toBe(true)
    for (const o of [{ index: 1 }, { index: LOBBY, known: [{ type: 'down', x: 5.5, y: 0.5, target: 1 }] }]) {
      const q = rig({ decor: fakeDecor([ahead]), ...o }); q.frame(0, { cellChanged: true }); q.frame(60)
      expect(q.said, JSON.stringify(o)).toEqual([])
    }
    const h = rig({ index: LOBBY, decor: fakeDecor([ahead]) }); h.frame(0, { cellChanged: true, floorHinted: true })
    expect(h.said).toEqual([])                                           // the pull shows at once: the compass names a way
    // the arrival's two plates already up: it waits out the window, then is said the moment the budget lets it (it is still true)
    const w = rig({ index: LOBBY, decor: fakeDecor([ahead]) })
    w.D.plates.admit('floor', 0); w.D.plates.admit('arrival', 0.1)
    for (let t = 0; t < 45; t += 0.5) w.frame(t, { cellChanged: t === 0 })
    expect(w.said).toEqual([])
    w.frame(45); expect(w.said).toEqual([[LOST_LINE, PRIO.discovery]])
  })
  it('the block keeps its compass (the hold): the pull at once, true, and never the setting\'s line', () => {
    const r = rig({ index: BLOCK, map: {}, decor: fakeDecor([{ x: 10.5, y: 0.5, kind: 'ring' }]) })
    expect(r.frame(0, { cellChanged: true, pullPhase: Math.PI / 2 })).toBe(`↑  ${FAINT}`)
    expect(r.D.compassState.wobble).toBe(0); expect(r.said).toEqual([])
  })
  it('the lobby\'s exit hint, held for the first run, is said the moment the pull frees, and not before', () => {
    const L = lobbyOnce(), fr = fresh(), hint = L.cfg.exit.hint
    const r = rig({ index: LOBBY, decor: L.decor, firstRun: fr, hint, player: { x: 11.5, y: 11.5, angle: 0 } })
    r.frame(0, { cellChanged: true, hintHeld: true })
    for (let t = 1; t < 100; t++) r.frame(t)
    expect(r.said.map((s) => s[0])).toEqual([LOST_LINE])
    fr.onRead(FIRST_NOTE.key); fr.onSoul(FIRST_SOUL.key)
    r.frame(100)
    expect(r.said.at(-1)).toEqual([hint, PRIO.discovery]); expect(r.st.hintHeld).toBe(false)
    const q = rig({ index: LOBBY, decor: L.decor, firstRun: fresh(), hint, player: { x: 11.5, y: 11.5, angle: 0 } })
    q.frame(0, { cellChanged: true, hintHeld: true })
    q.frame(PULL_FRESH_S - 0.1); expect(q.said.map((s) => s[0])).not.toContain(hint)
    q.frame(PULL_FRESH_S); expect(q.said.at(-1)).toEqual([hint, PRIO.discovery])
  })
  it('travel and the start hold the lobby\'s hint for the first run (the visit begun first), and the murmurs leave it out meanwhile', () => {
    const t = slice('function travel(way) {', '// die(): death.js resolves it')
    expect(t).toContain('if (level.cfg.exit?.hint && !followed) { if (freshLobby()) hintHeld = true; else later(3800, level.cfg.exit.hint, PRIO.discovery) }')
    expect(t.indexOf('startVisit()')).toBeLessThan(t.indexOf('if (level.cfg.exit?.hint && !followed)'))
    const boot = slice('if (resume) {', 'if (bus) mpClient.onEv(bus.receive)')
    expect(boot).toContain('if (!resume && level.cfg.exit?.hint) { if (freshLobby()) hintHeld = true; else later(3800, level.cfg.exit.hint, PRIO.discovery) }')
    expect(boot.indexOf('startVisit()')).toBeLessThan(boot.indexOf('if (!resume && level.cfg.exit?.hint)'))
    expect(game).toMatch(/const murmur = level\.messages\[[^\n]*\]\r?\n\s*if \(!hintHeld \|\| murmur !== cfg\.exit\?\.hint\) plate\('murmur', murmur, PRIO\.ambient, false\)/)
  })
  it('what frees the pull: a page read and a soul\'s word (a pinned trace comes with the drawers\' pass); the visit clears it', () => {
    expect(slice('function revealScrap() {', 'function redactScrap() {')).toContain('floorHinted = true')
    const e = slice("if (K['KeyE']) {", "if (K['Escape'] && dialogOpen)")
    expect(e).toMatch(/else \{\r?\n(\s*\/\/[^\n]*\r?\n)*\s*floorHinted = true\r?\n\s*const fl = firstRun\.onSoul\(nearNpc\.key\)/)
    expect(count(/floorHinted = true/g)).toBe(2)
  })
  it('the compass reads the ways that lead on, and the block it lifted allocates nothing', () => {
    expect(src()).toContain('compassState.fallback = level.decor.nearestWayOn(player.x, player.y, compassState.skip)')
    expect(src()).not.toContain('nearestWayAny')
    expect(src()).not.toMatch(/\{ [a-z]+:|=>|\bnew\b|\[\]/)
  })
})

describe('T1-3: the first run, authored', () => {
  const eBranch = () => slice("if (K['KeyE']) {", "if (K['Escape'] && dialogOpen)")
  it('one thread a run, built before the first floor from the run itself', () => {
    expect(at('const firstRun = createFirstRun(')).toBeLessThan(at('function buildLevel(index, at = null) {'))
    expect(count(/createFirstRun\(/g)).toBe(1)
  })
  it('buildLevel tells the thread the floor before the decor is built, and lays the note on the lobby while the thread can still advance', () => {
    const b = slice('function buildLevel(index, at = null) {', 'const fader = createFader(')
    expect(b.indexOf('firstRun.onLevel(index)')).toBeGreaterThan(0)
    expect(b.indexOf('firstRun.onLevel(index)')).toBeLessThan(b.indexOf('createDecorSystem('))
    expect(b).toContain('passes: cfg.map ? [] : [stairsPass(cfg, cfg.ways), dressPass(cfg), hauntsPass(cfg), index === 0 && firstRun.on() ? firstNotePass : null].filter(Boolean),')
    expect(game).toMatch(/const NOTE_CHUNK = `\$\{Math\.floor\(FIRST_NOTE\.x \/ CHUNK_SIZE\)\},\$\{Math\.floor\(FIRST_NOTE\.y \/ CHUNK_SIZE\)\}`\r?\n\s*const firstNotePass = \(ctx\) => \{ if \(ctx\.key === NOTE_CHUNK\) ctx\.add\('scrap', noteRecord\(\)\) \}/)
    expect(at('const firstNotePass = ')).toBeLessThan(loopAt)
  })
  it('decor keeps a scrap a pass hands it under its own key (never a chunk\'s), so the page of that chunk stays', () => {
    expect(read('../src/renderer/decor.js')).toMatch(/else if \(kind === 'scrap'\) scraps\.set\(record\.key, record\)/)
  })
  it('on the fixed lobby the note lies where firstrun.js says, a record of its own, and nothing else moved', () => {
    const a = lobby(false), b = lobbyOnce()
    const note = b.decor.getScraps().find((s) => s.key === FIRST_NOTE.key)
    expect(note).toEqual(noteRecord())
    expect(b.decor.nearestScrap(FIRST_NOTE.x, FIRST_NOTE.y + 0.5, 1.8)).toBe(note)
    const page = b.decor.getScraps().find((s) => s.key === '1,0')
    expect([page.x, page.y]).toEqual([28.5, 11.5]); expect(SCRAPS[page.frag]).toMatch(/^the radio in the wall counts/)
    const rows = (d) => JSON.stringify({ s: d.getScraps().filter((s) => s.key !== FIRST_NOTE.key), p: d.getProps(), e: d.getExits(), n: d.getNpcs(), m: d.getMachines(), g: d.getSights(), w: d.getStairs(), h: d.getHaunts() })
    expect(rows(b.decor)).toBe(rows(a.decor))
  })
  it('E: the note right after the presence, before the form, the sealed page and the page; read on a page\'s card, but no page', () => {
    expect(eBranch()).toMatch(/if \(nearPresence && !scrapFirst\) openDialog\(\)\r?\n\s*else if \(nearScrap\?\.firstrun\) openFirstNote\(nearScrap\)\r?\n\s*else if \(nearScrap\) nearScrap\.form/)
    const f = lift(/function openFirstNote\(scrap\) \{[\s\S]*?\r?\n {2}\}/)
    expect(f).toMatch(/if \(!openCard\('page', \{ text: FIRST_NOTE\.text \}, scrap\)\) return\r?\n\s*firstRun\.onRead\(scrap\.key\)\r?\n\s*if \(ownSounds\(\)\) paper\('page'\)/)
    expect(f).not.toMatch(/revealScrap|readSet|sanity/)
  })
  it('replayed: reading the note is the thread\'s first step, once; its card is the note\'s own text, with no page count', () => {
    const f = lift(/function openFirstNote\(scrap\) \{[\s\S]*?\r?\n {2}\}/)
    const cards = [], sounds = [], fr = createFirstRun({ fresh: true })
    const open = new Function('openCard', 'FIRST_NOTE', 'firstRun', 'ownSounds', 'paper', `${f}\nreturn openFirstNote`)(
      (m, o, s) => { cards.push([m, o, s.key]); return {} }, FIRST_NOTE, fr, () => true, (k) => sounds.push(k))
    open(noteRecord())
    expect(cards).toEqual([['page', { text: FIRST_NOTE.text }, FIRST_NOTE.key]]); expect(sounds).toEqual(['page'])
    expect(fr.step()).toBe(1)
    open(noteRecord()); expect(fr.step()).toBe(1)
  })
  // the soul's branch lifted and run with the real thread
  const soul = (fr, { npcLine = () => null, key = FIRST_SOUL.key } = {}) => {
    const said = [], st = { sanity: 50, floorHinted: false }
    const src = eBranch().match(/else if \(nearNpc\) \{[\s\S]*?\r?\n {8}\}/)[0]
    new Function('nearNpc', 'rules', 'firstRun', 'NPC_LINES', 'npcLines', 'file', 'showMessage', 'st',
      `let { sanity, floorHinted } = st\nif (false) {}\n${src}\nObject.assign(st, { sanity, floorHinted })`)(
      { key }, { npcLine }, fr, ['a pool line.'], () => [], { status: 'notice-mailed' }, (m) => said.push(m), st)
    return { said, hinted: st.floorHinted }
  }
  it('the soul: its own line once the note has named it, then its line asked again; before the note, and any other soul, the pool', () => {
    const fr = createFirstRun({ fresh: true })
    expect(soul(fr)).toEqual({ said: ['a pool line.'], hinted: true })
    fr.onRead(FIRST_NOTE.key)
    expect(soul(fr, { key: '5,5' }).said).toEqual(['a pool line.'])
    expect(soul(fr)).toEqual({ said: [FIRST_SOUL.line], hinted: true })
    expect(fr.step()).toBe(2)
    expect(soul(fr).said).toEqual([FIRST_SOUL.again])
    const fr2 = createFirstRun({ fresh: true }); fr2.onRead(FIRST_NOTE.key)
    expect(soul(fr2, { npcLine: () => ({ text: 'it will not talk.', sanity: -1 }) })).toEqual({ said: ['it will not talk.'], hinted: false })   // the refusal first
    expect(fr2.step()).toBe(1)
  })
  it('the room: its line the moment you step into it, on the cell change; the thread\'s lobby clock runs every frame', () => {
    expect(game.slice(loopAt)).toMatch(/lastCellIx = cix; lastCellIy = ciy\r?\n(\s*\/\/[^\n]*\r?\n)*\s*firstRun\.tick\(dt\)\r?\n\s*if \(cellChanged\) \{ const rl = firstRun\.onEnter\(cix, ciy\); if \(rl\) showMessage\(rl, PRIO\.discovery\) \}/)
    expect(count(/firstRun\.tick\(/g)).toBe(1)
  })
  it('the save keeps the step while the thread can still advance; a resume takes it up there; an old save, a seed or a room run without', () => {
    expect(slice('function snapshot(full = false) {', 'let saveTimer = 0')).toContain('if (firstRun.on()) s.firstRun = firstRun.step()')
    const args = lift(/createFirstRun\(\{ fresh: resume[^\n]*?\}\)/)
    const mk = (resume, worldSeed = null, mpClient = null) => new Function('createFirstRun', 'resume', 'worldSeed', 'mpClient', `return ${args}`)(createFirstRun, resume, worldSeed, mpClient)
    expect(mk(null).on()).toBe(true)
    const r1 = mk({ firstRun: 1 }); expect([r1.on(), r1.step()]).toEqual([true, 1])
    expect(mk({ level: 0 }).on()).toBe(false)                                 // a save from before the thread
    expect(mk(null, 1234).on()).toBe(false)                                    // a seeded world
    expect(mk(null, null, {}).on()).toBe(false)                                // a room
  })
})

describe('T1-4: the plate budget, and the plates that go', () => {
  it('plate() wraps showMessage for the budgeted kinds: shown when admitted; a line held back is kept for later only when asked', () => {
    expect(lift(PLATE)).toMatch(/if \(!text \|\| plates\.admit\(kind, playT, keep \? text : null\) !== 'show'\) return false\r?\n\s*showMessage\(text, prio\)\r?\n\s*return true/)
  })
  it('the arrival\'s delayed lines are its plates; the murmurs, the scheduled events and the placed haunts are let go when held back', () => {
    expect(game).toContain("function later(ms, text, prio) { const g = arrivalGen; setTimeout(() => { if (g === arrivalGen) plate('arrival', text, prio) }, ms) }")
    const fe = slice("function fireEvent(id, prio = PRIO.ambient, kind = 'event') {", 'function startSearch(p, th) {')
    expect(fe).not.toMatch(/showMessage\(/)
    expect((fe.match(/plate\(kind, '[^']+', (prio|PRIO\.interaction), false\)/g) || []).length).toBe(6)
    expect(game).toMatch(/if \(evId\) \{ fireEvent\(evId\); dreadQuietT = 12 \}/)                     // the scheduler's: kind 'event'
    expect(game).toContain("fire: (id) => fireEvent(id, PRIO.interaction, 'search'),")                  // a drawer's is what you did
    expect(game).toContain("behindYou: () => { const fx = hauntEffects('standing-figure', hauntCtx()); if (fx) applyHaunt(fx, 'search'); else fireEvent('cold-spot', PRIO.interaction, 'search') },")
    expect(slice("function applyHaunt(fx, kind = 'haunt') {", 'function noteContact(')).toMatch(/plate\(kind, fx\.message, PRIO\.discovery, false\)\r?\n\s*clampSanity\(fx\.sanity\)/)
    expect(game).toMatch(/if \(fx\) \{ haunts\.fire\(h\.key\); applyHaunt\(fx\); dreadQuietT = 20;/)
  })
  it('a held plate comes back once the arrival has settled: drained every frame, right after the murmur', () => {
    expect(game.slice(loopAt)).toMatch(/plate\('murmur', murmur, PRIO\.ambient, false\)\r?\n\s*\}\r?\n(\s*\/\/[^\n]*\r?\n)*\s*const held = plates\.drain\(playT\)\r?\n\s*if \(held\) showMessage\(held, PRIO\.discovery\)/)
    expect(count(/plates\.drain\(/g)).toBe(1)
  })
  // the wrapper, later(), startVisit and the frame's drain lifted together and run on a play clock with the real budget
  function arrival() {
    const said = [], timers = []
    let now = 0
    const drain = slice('const held = plates.drain(playT)', '// ── Living Atmosphere')
    const h = new Function('plates', 'showMessage', 'setTimeout', 'PRIO',
      `let playT = 0, arrivalGen = 0, floorT0 = 0, floorHinted = false, pullPhase = 0, lostSaid = false, hintHeld = false\n${lift(PLATE)}\n` +
      `${lift(/function later\(ms, text, prio\) \{[^\n]*\}/)}\n${lift(VISIT)}\nfunction drainFrame() {\n${drain}\n}\n` +
      'return { plate, later, startVisit, drainFrame, set: (t) => { playT = t } }')(createPlateBudget(), (t) => said.push([now, t]), (f, ms) => timers.push({ ms, f, done: false }), PRIO)
    const run = (to, events = {}) => {
      for (; now <= to + 1e-9; now = Math.round((now + 0.1) * 10) / 10) {
        h.set(now)
        for (const t of timers) if (!t.done && t.ms / 1000 <= now + 1e-9) { t.done = true; t.f() }
        if (events[now]) events[now]()
        h.drainFrame()
      }
    }
    return { h, said, run }
  }
  it('replayed: two plates at most in an arrival\'s first 45 s; the kept ones after, one a while; the let-go ones never; what you do always', () => {
    const { h, said, run } = arrival()
    h.startVisit()
    h.plate('floor', 'the floor.', PRIO.combat)
    h.later(3800, 'the hint.', PRIO.discovery); h.later(7500, 'the way.', PRIO.discovery); h.later(7600, 'the form.', PRIO.discovery); h.later(11000, 'the floor remembers.', PRIO.discovery)
    run(44.9, { 20: () => h.plate('murmur', 'a murmur.', PRIO.ambient, false), 25: () => h.plate('search', 'in the drawer.', PRIO.interaction), 30: () => h.plate('event', 'a door.', PRIO.ambient, false) })
    expect(said).toEqual([[0, 'the floor.'], [3.8, 'the hint.'], [25, 'in the drawer.']])
    run(80)
    expect(said.slice(3)).toEqual([[45, 'the way.'], [45 + DRAIN_S, 'the form.'], [45 + 2 * DRAIN_S, 'the floor remembers.']])
    // past the window: an unprompted line once per 20 s at most
    run(111, { 90: () => h.plate('murmur', 'one.', PRIO.ambient, false), 100: () => h.plate('murmur', 'two.', PRIO.ambient, false), 111: () => h.plate('event', 'three.', PRIO.ambient, false) })
    expect(said.slice(6).map((s) => s[1])).toEqual(['one.', 'three.'])
    // the next arrival lets go of what waited on the old floor, and opens its own window
    run(112, { 112: () => h.plate('arrival', 'too late.', PRIO.discovery) })
    run(113, { 113: () => { h.startVisit(); h.plate('floor', 'the next floor.', PRIO.combat) } })
    run(200)
    expect(said.slice(8).map((s) => s[1])).toEqual(['the next floor.'])
  })
  it('you rummage. is no plate any more: the scrape alone, and the hint says what you search while the hold runs', () => {
    expect(game).not.toContain('you rummage.')
    expect(game).toMatch(/function startSearch\(p, th\) \{\r?\n\s*if \(th\.hunted \|\| th\.nearest <= 4\) \{ showMessage\([^\n]*\); return \}\r?\n\s*searchTarget = p; searchT = SEARCH_HOLD_S; searchHint = searchingHint\(p\.type\)\r?\n\s*drawerSlide\(\)/)
    // the line is made once, as the hold starts: the frame only writes it
    expect(game).toMatch(/\} else if \(searchT > 0 && searchTarget\) \{\r?\n\s*itemHintEl\.textContent = searchHint\b[^\n]*\r?\n\s*itemHintEl\.style\.opacity = '1'\r?\n\s*\} else if \(boxFirst\) \{/)
    expect(at("let searchT = 0, searchTarget = null, drawerCostSaid = false, searchHint = ''")).toBeLessThan(loopAt)
    expect(searchingHint('cabinet')).toBe(`searching ${CONTAINER_TYPES.cabinet}`)
  })
  it('the flashlight\'s plain lines once a run, then the light alone; going dark in a friend\'s light always names them', () => {
    const L = lift(/if \(K\['KeyL'\]\) \{[\s\S]*?\r?\n {6}\}/)
    const run = new Function('K', 'kneel', 'litOffLine', 'showMessage', 'LIGHT_STAYS_LINE', 'st',
      `let { flashlight, lightToggles, litRec, lightSaid } = st\n${L}\nObject.assign(st, { flashlight, lightToggles, lightSaid })`)
    const said = [], press = (st) => run({ KeyL: true }, { st: null }, litOffLine, (m) => said.push(m), 'your light stays on them.', st)
    const st = { flashlight: true, lightToggles: 0, litRec: null, lightSaid: false }
    press(st); press(st); press(st)
    expect(said).toEqual([litOffLine(null)])
    expect([st.flashlight, st.lightToggles]).toEqual([false, 3])
    st.litRec = { name: 'maddie' }; press(st); press(st)                    // on: nothing; off in maddie's light: named
    expect(said).toEqual([litOffLine(null), litOffLine('maddie')])
    const st2 = { flashlight: false, lightToggles: 0, litRec: null, lightSaid: false }
    press(st2); expect(said.at(-1)).toBe('flashlight on.')
  })
  it('the smiler\'s lesson once a run, then its whisper alone', () => {
    expect(game).toContain("case 'smiler-freeze': whisper(); if (!smilerTold) { smilerTold = true; showMessage('it stops when you look. do not look away.', PRIO.discovery) } break")
  })
})
