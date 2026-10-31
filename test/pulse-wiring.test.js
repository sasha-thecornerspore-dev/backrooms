// The pulse wiring, pass one (S6a w1): game.js plays your own steps on the edge of a step you actually took, the small sounds of your
// hands (a take, a machine, a page, the map) and the lights cascade's panels, lets the footsteps event keep your pace for real; says
// whether the thing that has seen you is on your screen, and plays its tell from where it is when it is not; lets E read a page
// before the presence, keeps the presence quiet while you are hunted and for the first moments of a fresh lobby, names what drops into
// the tray with its article; and hands the entity system the world seed. Pass two (S6a w2): the compass's faint pull waits for floor
// time or a hint, leans a little off true and never names a stair up, and on the first run's lobby waits for the thread; the setting's
// line is said only while nothing is known and the pull is hidden; the first run's note, soul and room; and the plate budget over the
// arrival and the unprompted lines, with the plates that go. Pass three (S6a w3): the events that carry their own effect play it, the
// arrival's event comes early and is heard, not read, and the murmurs come from a bag; a drawer holds what your hands were too full
// for, its runners squeal for real, its floor plan pins one thing on your map, and an opened one says so; and dread, on its own 4 Hz
// clock through the path field, lifts the heartbeat and lets a creature's tell through before you see it. game.js only boots in a
// page, so these are source guards plus the pieces lifted out of game.js and replayed against the real modules.
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import { STEP_MATERIAL, STEP_GAIN, CALL_SOUNDS, CALL_LEN } from '../src/renderer/audio.js'
import { FOOTSTEPS_ECHO, FX_PLAY, EVENTS, eventFx, createBag, createEventScheduler } from '../src/renderer/events.js'
import { TELL, SEEN_TELL, DREAD_CLOCK, DREAD_R, dreadFrom, dreadNear, createTeller } from '../src/renderer/dread.js'
import { createPathField } from '../src/renderer/pathfield.js'
import { createTension } from '../src/renderer/tension.js'
import { createFogMap } from '../src/renderer/fogmap.js'
import { seenLine, SEEN_ON, SEEN_OFF, compassLines, compassText, arrivalSummary, pullVisible, pullWobble, lostDue, FAINT, PULL_WAIT_S, PULL_FRESH_S, PULL_WOBBLE, PULL_REDRAW_S, LOST_AFTER_S } from '../src/renderer/compass.js'
import { PRESENCE_HUSH_S, FIRST_NOTE, FIRST_SOUL, FIRST_ROOM, createFirstRun, noteRecord } from '../src/renderer/firstrun.js'
import { createPlateBudget, arrivalPlate, DRAIN_S, FREE_KINDS } from '../src/renderer/plates.js'
import { filingLine } from '../src/renderer/origin-intake.js'
import { LOST_LINE, levelConfig } from '../src/renderer/levels.js'
import { searchingHint, CONTAINER_TYPES, NOT_NOW_LINE, SEARCHED_HINT, SQUEAL_LINE, SQUEAL_NOISE, TRACE_LINES, HANDS_FULL_LINE, applyRoll, createSearchLog } from '../src/renderer/containers.js'
import { DEFAULT_CONFIG, CHUNK_SIZE, createChunkCache, createGridReader } from '../src/renderer/world.js'
import { createDecorSystem } from '../src/renderer/decor.js'
import { dressPass } from '../src/renderer/dress.js'
import { hauntsPass } from '../src/renderer/haunts.js'
import { inViewCone, lineOfSight } from '../src/renderer/raycaster.js'
import { HF } from '../src/renderer/gfx-frame.js'
import { whistlePan } from '../src/renderer/rollcall.js'
import { trayLean, standing, placementMods, applyPlacement } from '../src/renderer/docket.js'
import { PRIO, createMessageQueue } from '../src/renderer/messages.js'
import { BLOCK, LOBBY, waysFor, stairsPass, chunkMid, findOpenNear } from '../src/renderer/topology.js'
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
// the start's exit hint: held on the first run's lobby while the thread still holds it (a fresh start, or a resume before the soul), else a
// fresh start says it at 3.8 s
const BOOT_HINT = 'if (level.cfg.exit?.hint) { if (freshLobby() && !firstRun.unlocked()) hintHeld = true; else if (!resume) later(3800, level.cfg.exit.hint, PRIO.discovery) }'

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
    // (w3: CALL_LEN for an event's repeats; the bag, the data effects and their table; the dread clock, the reading and the teller)
    expect(game).toMatch(/import \{ initAudio, [^\n]*, humDuck, step, pickup, paper, panelsOut, call, STEP_MATERIAL, STEP_GAIN, CALL_LEN, drawerSlide, whistle, bump \} from '\.\/audio\.js'/)
    expect(game).toMatch(/import \{ createEventScheduler, EVENTS, FOOTSTEPS_ECHO, FX_PLAY, eventFx, createBag \} from '\.\/events\.js'/)
    expect(game).toMatch(/import \{ compassLines, compassText, arrivalSummary, seenLine, [^\n]* \} from '\.\/compass\.js'/)   // (w2: the pull's helpers)
    expect(game).toMatch(/import \{ TELL, SEEN_TELL, DREAD_CLOCK, dreadFrom, dreadNear, createTeller \} from '\.\/dread\.js'/)
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
    const h = at('if (lobbyFirst && deaths === 0 && playT - floorT0 < PRESENCE_HUSH_S) nearPresence = false', loopAt)
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
  const gate = (o) => new Function('o', 'isWishOpen', 'PRESENCE_HUSH_S', `let nearPresence = true\nconst { file, thA, huntMood, lobbyFirst, deaths, playT, floorT0 } = o\n${gates.slice(0, gates.indexOf('// ── items: pickup prompt'))}\nreturn nearPresence`)(
    { file: { closing: null }, thA: { hunted: false }, huntMood: false, lobbyFirst: false, deaths: 0, playT: 100, floorT0: 0, ...o }, (c) => c !== 'compliance', PRESENCE_HUSH_S)
  it('replayed: the hunt and the mood silence it, the hush holds only a first lobby visit with no deaths, its first 40 s', () => {
    expect(gate({})).toBe(true)
    expect(gate({ file: { closing: 'compliance' } })).toBe(false)
    expect(gate({ thA: { hunted: true } })).toBe(false)
    expect(gate({ huntMood: true })).toBe(false)
    expect(gate({ lobbyFirst: true, playT: 39.9 })).toBe(false)
    expect(gate({ lobbyFirst: true, playT: 40 })).toBe(true)
    expect(gate({ lobbyFirst: true, playT: 10, deaths: 1 })).toBe(true)
    expect(gate({ lobbyFirst: false, playT: 10 })).toBe(true)
  })
  it('replayed: the hush runs on the visit\'s clock, so the front door\'s lobby has its 40 s too, whatever the block took (review W8)', () => {
    expect(gate({ lobbyFirst: true, floorT0: 45, playT: 50 })).toBe(false)         // 45 s on the block, 5 s in the lobby: hushed
    expect(gate({ lobbyFirst: true, floorT0: 45, playT: 84.9 })).toBe(false)
    expect(gate({ lobbyFirst: true, floorT0: 45, playT: 85 })).toBe(true)
    expect(gate({ lobbyFirst: true, floorT0: 25, playT: 50 })).toBe(false)         // 25 s on the block: still the whole 40 s, not 15
    expect(gate({ lobbyFirst: true, floorT0: 45, playT: 50, deaths: 1 })).toBe(true)
  })
  const ITEM_NAMES = new Function(`return ${lift(/const ITEM_NAMES = \{[\s\S]*?\n\}/).replace(/^const ITEM_NAMES = /, '')}`)()
  const TRAY_NAMES = new Function(`return ${lift(/const TRAY_NAMES = \{[\s\S]*?\n\}/).replace(/^const TRAY_NAMES = /, '')}`)()
  it('TRAY_NAMES names every ITEM_NAMES key with its article (a, an or some), or a measure of it, lowercase, no digits', () => {
    expect(Object.keys(TRAY_NAMES).sort()).toEqual(Object.keys(ITEM_NAMES).sort())
    for (const [k, v] of Object.entries(TRAY_NAMES)) {
      const m = /^(a|an|some) (.+)$/.exec(v)
      // the item's own name, or a measure of it (Appendix A: 'a bottle of almond water')
      expect(m, v).not.toBeNull(); expect(m[2] === ITEM_NAMES[k] || m[2].endsWith(` of ${ITEM_NAMES[k]}`), v).toBe(true)
      if (m[1] === 'a') expect(m[2]).toMatch(/^[^aeiou]/)
      if (m[1] === 'an') expect(m[2]).toMatch(/^[aeiou]/)
      expect(v).toBe(v.toLowerCase()); expect(v).not.toMatch(/[0-9!]/)
    }
    expect(TRAY_NAMES['almond-water']).toBe('a bottle of almond water'); expect(TRAY_NAMES['extension-slip']).toBe('an extension slip')
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
const LATER = /function later\(ms, text, prio, keep = true, kind = 'arrival'\) \{[^\n]*\}/
// the faint pull's two lines, refilled before the map (a tenant's map reads the pull too)
const PULL = /pullAsk\.floorT = playT - floorT0;[^\n]*\r?\n\s*const pull = [^\n]*/
const LIGHT = /if \(K\['KeyL'\]\) \{[\s\S]*?\r?\n {6}\}/
const MURMUR = /const murmur = cfg\.map \? [^\n]*\r?\n[^\n]*/

describe('w2: the imports, the state, the shell', () => {
  it('imports the pull, the setting\'s line, the thread, the budget and the search hint by their real names', () => {
    expect(game).toMatch(/import \{ levelConfig, TRACKS, LOST_LINE \} from '\.\/levels\.js'/)
    expect(game).toMatch(/import \{ compassLines, compassText, arrivalSummary, seenLine, pullVisible, pullWobble, lostDue, PULL_REDRAW_S \} from '\.\/compass\.js'/)
    expect(game).toMatch(/import \{ PRESENCE_HUSH_S, FIRST_NOTE, createFirstRun, noteRecord \} from '\.\/firstrun\.js'/)
    expect(game).toMatch(/import \{ createPlateBudget, arrivalPlate \} from '\.\/plates\.js'/)
    // (w3: the refusal's line and the searched hint)
    expect(game).toMatch(/import \{ CONTAINER_TYPES, SEARCH_HOLD_S, DRAWER_COST, rollContainer, applyRoll, createSearchLog, searchingHint, NOT_NOW_LINE, SEARCHED_HINT \} from '\.\/containers\.js'/)
  })
  it('the visit\'s pull, the thread, the budget and the once-a-run lines are declared once, outside the loop', () => {
    for (const s of [
      'let floorT0 = 0, floorHinted = false, pullPhase = 0, lastCompassT = -Infinity, lostSaid = false, hintHeld = false',
      'const pullAsk = { floorT: 0, hinted: false, fresh: false, step: 0 }',
      'const roomPull = { rec: null, dist: null }',
      'const firstRun = createFirstRun({ fresh: resume ? Number.isInteger(resume.firstRun) : true, step: resume?.firstRun ?? 0, worldSeed, room: !!mpClient, docket: base.docket })',
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
    // (review batch five: the wake's plate only on a floor new to you, or on the block as 2.0.3; its lines are the wake's own kind)
    expect(d).toMatch(/persist\(true\)\r?\n\s*startVisit\(\)\r?\n(\s*\/\/[^\n]*\r?\n)*\s*if \(first \|\| level\.cfg\.map\) plate\('floor', arrivalPlate\(level\.cfg, first\), PRIO\.combat\)\r?\n\s*later\(2600, r\.message, PRIO\.discovery, true, 'wake'\)/)
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
  const src = () => slice('// ── the lobby\'s exit hint, held for the first run', 'netTimer += dt')
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
    const cfg = { map, exit: hint ? { hint } : undefined }
    const level = { index, decor, cfg }
    const D = {
      pullAsk: { floorT: 0, hinted: false, fresh: false, step: 0 }, freshLobby: () => level.index === 0 && firstRun.on(), firstRun,
      cfg, pullVisible, PRIO, msgQ: { idle: () => true }, compassEl: { textContent: '', style: { opacity: '' } },
      fog: { ways: () => known, arrivedPin: () => arrived }, level, player,
      compassState: { player, known: null, fallback: null, arrived: null, stale: null, pull: false, wobble: 0, skip: null },
      PULL_REDRAW_S, roomPull: { rec: null, dist: null }, pullWobble, compassLines: (s, o) => { calls.n++; return compassLines(s, o) }, compassOut: [],
      compassText, lostDue, LOST_LINE, plates, showMessage: (t, p) => said.push([t, p]),
    }
    const st = { playT: 0, floorT0: 0, floorHinted: false, hintHeld: false, cellChanged: true, lastCompassAngle: NaN, lastWayCount: -1,
      lastCompassT: -Infinity, lastCompassText: null, lostSaid: false, pullPhase: 0, nearExit: null, transitioning: false }
    const fn = new Function('st', 'D', `const { ${Object.keys(D).join(', ')} } = D\nlet { ${Object.keys(st).join(', ')} } = st\n${lift(PLATE)}\n${lift(PULL)}\n${src()}\n` +
      'Object.assign(st, { hintHeld, lastCompassAngle, lastWayCount, lastCompassT, lastCompassText, lostSaid })')
    const frame = (t, o = {}) => { Object.assign(st, { cellChanged: false }, o, { playT: t }); fn(st, D); return D.compassEl.textContent }
    return { st, D, said, calls, frame }
  }
  const fresh = () => { const f = createFirstRun({ fresh: true }); f.onLevel(LOBBY); return f }
  const ahead = { x: 10.5, y: 0.5, kind: 'down' }, upClose = { x: 0.5, y: 3.5, kind: 'up' }
  // the faint line the frame should draw the moment the wait ends: toward `ahead`, leaning by the wobble at PULL_WAIT_S (phase 0)
  const atWait = () => compassText(compassLines({ player: { x: 0.5, y: 0.5, angle: 0 }, known: [], fallback: { rec: ahead }, wobble: pullWobble(PULL_WAIT_S, 0) }, []))

  it('the faint pull waits PULL_WAIT_S of the visit, names no metres, and never a stair up', () => {
    const r = rig({ decor: fakeDecor([ahead, upClose]) })
    expect(r.frame(0, { cellChanged: true })).toBe('')
    expect(r.frame(PULL_WAIT_S - 0.1)).toBe('')
    expect(r.frame(PULL_WAIT_S)).toBe(atWait())                          // ahead, give or take the lean (at most 30°)
    expect(atWait()).toMatch(new RegExp(`^[↖↑↗]  ${FAINT}$`))
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
    expect(q.frame(PULL_WAIT_S)).toBe(atWait())
  })
  it('on the first run\'s lobby it waits for the thread instead (the soul\'s word, or 120 s), then leans toward the room the soul named', () => {
    const L = lobbyOnce(), fr = fresh()
    const soul = L.decor.getNpcs().find((n) => n.key === FIRST_SOUL.key)
    const r = rig({ index: LOBBY, decor: L.decor, firstRun: fr, player: { x: soul.x, y: soul.y, angle: 0 } })
    expect(r.frame(0, { cellChanged: true })).toBe('')
    expect(r.frame(PULL_WAIT_S + 10, { floorHinted: true })).toBe('')    // past the wait, and hinted: the lobby waits for the thread
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
  it('the setting\'s line: on the lobby only, while nothing is known and the pull is hidden, once the floor has had you a while, once a visit, through the budget', () => {
    const r = rig({ index: LOBBY, decor: fakeDecor([ahead]) })
    r.frame(0, { cellChanged: true }); r.frame(1); r.frame(30); r.frame(LOST_AFTER_S - 0.1)
    expect(r.said).toEqual([])                                           // never in the arrival: you are not lost yet, only new
    r.frame(LOST_AFTER_S)
    expect(r.said).toEqual([[LOST_LINE, PRIO.discovery]]); expect(r.st.lostSaid).toBe(true)
    r.frame(LOST_AFTER_S + 5); expect(r.said).toHaveLength(1)
    for (const o of [{ index: 1 }, { index: LOBBY, known: [{ type: 'down', x: 5.5, y: 0.5, target: 1 }] }]) {
      const q = rig({ decor: fakeDecor([ahead]), ...o }); q.frame(0, { cellChanged: true }); q.frame(LOST_AFTER_S)
      expect(q.said, JSON.stringify(o)).toEqual([])
    }
    const h = rig({ index: LOBBY, decor: fakeDecor([ahead]) }); h.frame(0, { cellChanged: true, floorHinted: true }); h.frame(LOST_AFTER_S, { floorHinted: true })
    expect(h.said).toEqual([])                                           // the pull shows at once: the compass names a way
    // the first run's lobby: a hint does not free the pull there, but it is a lead, and so is the note read: you are not lost
    const f = rig({ index: LOBBY, decor: fakeDecor([ahead]), firstRun: fresh() })
    f.frame(0, { cellChanged: true, floorHinted: true }); f.frame(LOST_AFTER_S + 10, { floorHinted: true })
    expect(f.D.compassEl.textContent).toBe(''); expect(f.said).toEqual([])
    const n = rig({ index: LOBBY, decor: fakeDecor([ahead]), firstRun: fresh() }); n.D.firstRun.onRead(FIRST_NOTE.key)
    n.frame(0, { cellChanged: true }); n.frame(LOST_AFTER_S + 10)
    expect(n.D.compassEl.textContent).toBe(''); expect(n.said).toEqual([])
    // never while the veil is down
    const v = rig({ index: LOBBY, decor: fakeDecor([ahead]) }); v.frame(0, { cellChanged: true }); v.frame(LOST_AFTER_S, { transitioning: true })
    expect(v.said).toEqual([])
    // a lobby arrival's exit hint at 3.8 s (a seeded world, a room) keeps the window's second plate: the line does not take it
    const w = rig({ index: LOBBY, decor: fakeDecor([ahead]) })
    w.D.plates.admit('floor', 0)
    for (let t = 0; t <= 3.8; t = Math.round((t + 0.1) * 10) / 10) w.frame(t, { cellChanged: t === 0 })
    expect(w.said).toEqual([]); expect(w.D.plates.admit('arrival', 3.8, 'the hint.')).toBe('show')
  })
  it('the block keeps its compass (the hold): the pull at once, true, with its metres as in 2.0.3, and never the setting\'s line', () => {
    expect(game).toContain('const s = compassText(compassOut, !!cfg.map)')
    const r = rig({ index: BLOCK, map: {}, decor: fakeDecor([{ x: 10.5, y: 0.5, kind: 'ring' }]) })
    expect(r.frame(0, { cellChanged: true, pullPhase: Math.PI / 2 })).toBe(`↑  ${FAINT}  ·  10m`)
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
    q.frame(LOST_AFTER_S); expect(q.said.map((s) => s[0])).toEqual([LOST_LINE])     // a minute in, nothing known, no lead: the setting's line
    q.frame(PULL_FRESH_S - 0.1); expect(q.said.map((s) => s[0])).not.toContain(hint)
    q.frame(PULL_FRESH_S); expect(q.said.at(-1)).toEqual([hint, PRIO.discovery])
  })
  it('travel and the start hold the lobby\'s hint for the first run (the visit begun first), and the murmurs leave it out meanwhile', () => {
    const t = slice('function travel(way) {', '// die(): death.js resolves it')
    expect(t).toContain('if (level.cfg.exit?.hint && !followed) { if (freshLobby()) hintHeld = true; else later(filing ? 7600 : 3800, level.cfg.exit.hint, PRIO.discovery) }')
    expect(t.indexOf('startVisit()')).toBeLessThan(t.indexOf('if (level.cfg.exit?.hint && !followed)'))
    const boot = slice('if (resume) {', 'if (bus) mpClient.onEv(bus.receive)')
    // (review D2: a resume mid-thread holds it too; only a fresh start says it at 3.8 s)
    expect(boot).toContain(BOOT_HINT)
    expect(boot.indexOf('startVisit()')).toBeLessThan(boot.indexOf(BOOT_HINT))
    expect(game).toMatch(/const murmur = [^\n]*level\.messages\[murmurBag\.next\(\)\]\r?\n\s*if \(!hintHeld \|\| murmur !== cfg\.exit\?\.hint\) plate\('murmur', murmur, PRIO\.ambient, false\)/)
  })
  it('replayed: the start holds the hint on the first run\'s lobby, a resume before the soul too; a fresh start elsewhere says it at 3.8 s; a resume past the soul or elsewhere never (review D2)', () => {
    const hint = 'the hint.'
    expect(slice('if (resume) {', 'if (bus) mpClient.onEv(bus.receive)')).toContain(BOOT_HINT)                 // the line replayed is the start's own
    const boot = ({ resume = null, index = LOBBY, fr = createFirstRun({ fresh: true }) } = {}) => {
      fr.onLevel(index)
      const later = []
      const held = new Function('level', 'freshLobby', 'firstRun', 'resume', 'later', 'PRIO', `let hintHeld = false\n${BOOT_HINT}\nreturn hintHeld`)(
        { index, cfg: { exit: { hint } } }, () => index === LOBBY && fr.on(), fr, resume, (ms, t, p) => later.push([ms, t, p]), PRIO)
      return { held, later }
    }
    expect(boot()).toEqual({ held: true, later: [] })                                                        // a fresh run's lobby
    for (const step of [0, 1]) {                                                                             // a resume mid-thread: held as at the start
      expect(boot({ resume: { firstRun: step }, fr: createFirstRun({ fresh: true, step }) }), String(step)).toEqual({ held: true, later: [] })
    }
    expect(boot({ resume: { firstRun: 2 }, fr: createFirstRun({ fresh: true, step: 2 }) })).toEqual({ held: false, later: [] })   // the soul has spoken
    expect(boot({ index: BLOCK })).toEqual({ held: false, later: [[3800, hint, PRIO.discovery]] })                 // the front door: the gap, at 3.8 s
    expect(boot({ resume: { level: 0 }, fr: createFirstRun({ fresh: false }) })).toEqual({ held: false, later: [] }) // an old save: no thread, no hint
    expect(boot({ resume: { level: 1 }, index: 1 })).toEqual({ held: false, later: [] })
  })
  it('what frees the pull: a page read, a soul\'s word and a pinned trace (w3: the drawers\' pass); the visit clears it', () => {
    expect(slice('function revealScrap() {', 'function redactScrap() {')).toContain('floorHinted = true')
    const e = slice("if (K['KeyE']) {", "if (K['Escape'] && dialogOpen)")
    expect(e).toMatch(/else \{\r?\n(\s*\/\/[^\n]*\r?\n)*\s*floorHinted = true\r?\n\s*const fl = firstRun\.onSoul\(nearNpc\.key\)/)
    expect(count(/floorHinted = true/g)).toBe(3)
    expect((slice('function traceOne() {', 'function resolveSearch(p) {').match(/floorHinted = true/g) || []).length).toBe(1)
  })
  it('the compass reads the ways that lead on, and the block it lifted allocates nothing', () => {
    expect(src()).toContain('compassState.fallback = level.decor.nearestWayOn(player.x, player.y, compassState.skip)')
    expect(src()).not.toContain('nearestWayAny')
    expect(src()).not.toMatch(/\{ [a-z]+:|=>|\bnew\b|\[\]/)
    expect(lift(PULL)).not.toMatch(/\{ [a-z]+:|=>|\bnew\b|\[\]/)
  })
  it('the pull is refilled once a frame, after the thread\'s step and before the map: the map reads it too', () => {
    const loop = game.slice(loopAt)
    expect(count(/const pull = /g)).toBe(1); expect(count(/pullAsk\.floorT = /g)).toBe(1)
    const pullAt = loop.indexOf(lift(PULL))
    expect(pullAt).toBeGreaterThan(loop.indexOf('if (cellChanged) { const rl = firstRun.onEnter(cix, ciy)'))
    expect(pullAt).toBeLessThan(loop.indexOf('const st = fog.step('))
    expect(pullAt).toBeLessThan(loop.indexOf('if (hintHeld && pull)'))
  })
  it('a tenant\'s map marks the loaded ways only once the pull is free, and not while the first run leans on its room (T1-2 holds for every column)', () => {
    const body = slice('function pinSeen(reach) {', 'const entityAsm = createEntityAssembler()')
    const REVEAL = /if \(rules\.wayReveal === 'loaded' && pullVisible\(pullAsk\) && !firstRun\.toward\(\)\) \{[^\n]*\}/
    expect(body).toMatch(REVEAL)
    const exits = [{ x: 3.5, y: 0.5, kind: 'down' }, { x: 40.5, y: 9.5, kind: 'lift' }]
    const run = (rules, pullAsk, firstRun = createFirstRun()) => {
      const pinned = []
      new Function('rules', 'pullVisible', 'pullAsk', 'firstRun', 'level', 'fog', 'L', 'epochOf', 'CHUNK_SIZE', body.match(REVEAL)[0])(
        rules, pullVisible, pullAsk, firstRun, { decor: { getExits: () => exits } }, { pinWay: (l, e) => pinned.push(e) }, 1, () => 0, CHUNK_SIZE)
      return pinned
    }
    const ask = (o) => ({ floorT: 0, hinted: false, fresh: false, step: 0, ...o })
    const tenant = { wayReveal: 'loaded' }
    expect(run(tenant, ask({ floorT: 0 }))).toEqual([])                                   // arrived: the map waits like everyone's
    expect(run(tenant, ask({ floorT: PULL_WAIT_S - 0.1 }))).toEqual([])
    expect(run(tenant, ask({ floorT: PULL_WAIT_S }))).toEqual(exits)                      // then the file's plans, every loaded way
    expect(run(tenant, ask({ floorT: 5, hinted: true }))).toEqual(exits)
    expect(run({ wayReveal: 'seen' }, ask({ floorT: 500 }))).toEqual([])
    const fr = createFirstRun({ fresh: true }); fr.onLevel(LOBBY); fr.onRead(FIRST_NOTE.key); fr.onSoul(FIRST_SOUL.key)
    expect(fr.toward()).toBe(FIRST_ROOM.way)
    expect(run(tenant, ask({ floorT: 30, fresh: true, step: fr.step() }), fr)).toEqual([])   // the room's pull leads while the thread waits on it
  })
})

describe('T1-3: the first run, authored', () => {
  const eBranch = () => slice("if (K['KeyE']) {", "if (K['Escape'] && dialogOpen)")
  it('one thread a run, built before the first floor from the run itself', () => {
    expect(at('const firstRun = createFirstRun(')).toBeLessThan(at('function buildLevel(index, at = null) {'))
    expect(at('const base = await loadConfig()')).toBeLessThan(at('const firstRun = createFirstRun('))   // the shipped docket it reads (review D1/C10)
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
    const mk = (resume, worldSeed = null, mpClient = null, docket = null) => new Function('createFirstRun', 'resume', 'worldSeed', 'mpClient', 'base', `return ${args}`)(createFirstRun, resume, worldSeed, mpClient, { docket })
    expect(mk(null).on()).toBe(true)
    const r1 = mk({ firstRun: 1 }); expect([r1.on(), r1.step()]).toEqual([true, 1])
    expect(mk({ level: 0 }).on()).toBe(false)                                 // a save from before the thread
    expect(mk(null, 1234).on()).toBe(false)                                    // a seeded world
    expect(mk(null, null, {}).on()).toBe(false)                                // a room
    // (review D1/C10) the shipped docket's lean: one that re-lays the lobby's souls turns the thread off, a fresh run and a resume alike
    const leaned = { '0': { extension: 0, compliance: 2, litigation: 0 } }
    expect(mk(null, null, null, leaned).on()).toBe(false)
    expect(mk({ firstRun: 1 }, null, null, leaned).on()).toBe(false)
    expect(mk(null, null, null, { '0': { extension: 2, compliance: 0, litigation: 0 } }).on()).toBe(true)
  })
})

// the wrapper, later(), startVisit and the frame's drain lifted together and run on a play clock with the real budget; with `queue`
// the real message queue too, ticked every frame, and what reaches #msg is recorded (else every line handed to showMessage is).
// `map`: the block's cfg.map; `cfg`: the floor's whole cfg (the floor's index follows it: the block's, else level 1's)
function arrival({ map = null, queue = false, cfg = { map } } = {}) {
  const said = [], timers = []
  let now = 0
  const msgQ = queue ? createMessageQueue() : { idle: () => true }
  const show = queue ? (t, p) => msgQ.push(t, p) : (t) => said.push([now, t])
  const drain = slice('const held = plates.drain(playT)', '// ── Living Atmosphere')
  // (w3: startVisit also starts the floor's events and its dread over: inert stand-ins here, replayed for real in the w3 section)
  const h = new Function('plates', 'showMessage', 'setTimeout', 'PRIO', 'msgQ', 'level',
    `let playT = 0, arrivalGen = 0, floorT0 = 0, floorHinted = false, pullPhase = 0, lostSaid = false, hintHeld = false\n` +
    'let dreadQuietT = 0, sanity = 100, fieldOn = false, fxLeft = 0\nconst eventSched = { arrive() {} }, teller = { reset() {} }, dreadOut = { dread: 0 }\n' +
    `${lift(PLATE)}\n` +
    `${lift(LATER)}\n${lift(VISIT)}\nfunction drainFrame() {\n${drain}\n}\n` +
    'return { plate, later, startVisit, drainFrame, set: (t) => { playT = t } }')(createPlateBudget(), show, (f, ms) => timers.push({ ms, f, done: false }), PRIO,
    msgQ, { index: cfg.map ? BLOCK : 1, cfg })
  const run = (to, events = {}) => {
    for (; now <= to + 1e-9; now = Math.round((now + 0.1) * 10) / 10) {
      h.set(now)
      for (const t of timers) if (!t.done && t.ms / 1000 <= now + 1e-9) { t.done = true; t.f() }
      if (events[now]) events[now]()
      h.drainFrame()
      if (queue) { const r = msgQ.tick(0.1); if (r?.show) said.push([now, r.text]) }
    }
  }
  return { h, said, run }
}

describe('T1-4: the plate budget, and the plates that go', () => {
  it('plate() wraps showMessage for the budgeted kinds: shown when admitted; a line held back is kept for later only when asked', () => {
    // (w3: no kind is a line not said at all — the arrival's event is heard, not read; the block keeps 2.0.3's lines, unbudgeted (the
    // hold); an ambient line the queue would drop is not shown, so it is never counted)
    expect(lift(PLATE)).toMatch(/if \(!kind \|\| !text\) return false\r?\n\s*if \(level\.cfg\.map\) \{ showMessage\(text, prio\); return true \}[^\n]*\r?\n\s*if \(prio === PRIO\.ambient && !msgQ\.idle\(\)\) return false[^\n]*\r?\n\s*if \(plates\.admit\(kind, playT, keep \? text : null\) !== 'show'\) return false\r?\n\s*showMessage\(text, prio\)\r?\n\s*return true/)
  })
  it('the arrival\'s delayed lines are its plates; the murmurs, the scheduled events and the placed haunts are let go when held back', () => {
    expect(game).toContain("function later(ms, text, prio, keep = true, kind = 'arrival') { const g = arrivalGen; setTimeout(() => { if (g === arrivalGen) plate(kind, text, prio, keep) }, ms) }")
    const fe = slice("function fireEvent(id, prio = PRIO.ambient, kind = 'event') {", 'function startSearch(p, th) {')
    expect(fe).not.toMatch(/showMessage\(/)
    expect((fe.match(/plate\(kind, '[^']+', (prio|PRIO\.interaction), false\)/g) || []).length).toBe(6)
    expect(game).toMatch(/if \(evId\) \{ fireEvent\(evId, PRIO\.ambient, eventSched\.soundOnly \? null : 'event'\); dreadQuietT = 12 \}/)   // the scheduler's: kind 'event' (w3: none for the arrival's)
    expect(game).toContain("fire: (id) => fireEvent(id, PRIO.interaction, 'search'),")                  // a drawer's is what you did
    expect(game).toContain("behindYou: () => { const fx = hauntEffects('standing-figure', hauntCtx()); if (fx) applyHaunt(fx, 'search'); else fireEvent('cold-spot', PRIO.interaction, 'search') },")
    expect(slice("function applyHaunt(fx, kind = 'haunt') {", 'function noteContact(')).toMatch(/plate\(kind, fx\.message, PRIO\.discovery, false\)\r?\n\s*clampSanity\(fx\.sanity\)/)
    expect(game).toMatch(/if \(fx\) \{ haunts\.fire\(h\.key\); applyHaunt\(fx\); dreadQuietT = 20;/)
  })
  it('a held plate comes back once the arrival has settled: drained every frame, right after the murmur', () => {
    expect(game.slice(loopAt)).toMatch(/plate\('murmur', murmur, PRIO\.ambient, false\)\r?\n\s*\}\r?\n(\s*\/\/[^\n]*\r?\n)*\s*const held = plates\.drain\(playT\)\r?\n\s*if \(held\) showMessage\(held, PRIO\.discovery\)/)
    expect(count(/plates\.drain\(/g)).toBe(1)
  })
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
  it('replayed with the real queue: a murmur the queue drops (the floor\'s plate still up) is never counted, so the hint keeps the window\'s second plate', () => {
    const { h, said, run } = arrival({ queue: true })
    const got = []
    h.startVisit()
    h.plate('floor', 'level one.', PRIO.combat)
    h.later(3800, 'the hint.', PRIO.discovery)
    run(44.9, { 1.5: () => got.push(h.plate('murmur', 'a murmur.', PRIO.ambient, false)) })
    expect(got).toEqual([false])
    expect(said.map((s) => s[1])).toEqual(['level one.', 'the hint.'])
    expect(said[1][0]).toBeGreaterThanOrEqual(3.8); expect(said[1][0]).toBeLessThan(5)
    // past the window too: a murmur dropped while a line shows does not start the 20 s gap, so the next unprompted line is not held off
    run(70, { 60: () => h.plate('search', 'in the drawer.', PRIO.interaction), 61: () => got.push(h.plate('murmur', 'a murmur.', PRIO.ambient, false)),
      70: () => got.push(h.plate('event', 'a door.', PRIO.ambient, false)) })
    expect(got).toEqual([false, false, true])
    expect(said.map((s) => s[1])).toEqual(['level one.', 'the hint.', 'in the drawer.', 'a door.'])
  })
  it('a line whose moment passes with the arrival (the way you came, the arrival summary) is let go when held back, not read 45 s on', () => {
    const t = slice('function travel(way) {', '// die(): death.js resolves it')
    // (review batch five: on a floor you come back to, the summary takes the second plate and the way line after it is let go)
    expect(t.match(/if \(wm\) later\(7500, wm, PRIO\.discovery, false\)/g)).toHaveLength(2)
    expect(t).toContain('if (s) later(3800, s, PRIO.discovery, false)')
    // what stays true when it is read late is kept: the hint, the filing line, the raised ceiling, the mercy line (the wake's lines are
    // free, never held)
    expect((t.match(/later\([^\n]*, false\)/g) || []).length).toBe(3)
    expect(slice('function die(d = null) {', '// ── input ──')).not.toMatch(/later\([^\n]*, false\)/)
    const { h, said, run } = arrival()
    h.startVisit()
    h.plate('floor', 'the floor.', PRIO.combat)
    h.later(3800, 'the form.', PRIO.discovery); h.later(7500, 'the way.', PRIO.discovery, false); h.later(7600, 'the hint.', PRIO.discovery)
    run(80)
    expect(said).toEqual([[0, 'the floor.'], [3.8, 'the form.'], [45, 'the hint.']])
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
    const L = lift(LIGHT)
    const run = new Function('K', 'kneel', 'litOffLine', 'showMessage', 'LIGHT_STAYS_LINE', 'cfg', 'st',
      `let { flashlight, lightToggles, litRec, lightSaid } = st\n${L}\nObject.assign(st, { flashlight, lightToggles, lightSaid })`)
    const said = [], press = (st) => run({ KeyL: true }, { st: null }, litOffLine, (m) => said.push(m), 'your light stays on them.', { map: null }, st)
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

// ── pass three (S6a w3) ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const FE = /function fireEvent\(id, prio = PRIO\.ambient, kind = 'event'\) \{[\s\S]*?\r?\n {2}\}/
const SAPI = /const searchApi = \{[\s\S]*?\r?\n {2}\}/
const RESOLVE = /function resolveSearch\(p\) \{[\s\S]*?\r?\n {2}\}/
const TRACE = /function traceOne\(\) \{[\s\S]*?\r?\n {2}\}/
const lcg = (s) => () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)

describe('w3: the tables the wiring reads', () => {
  it('a data event plays at 0.5 and holds the light down 0.6 s; the bell and the receiver sound 2 s before their quiet begins', () => {
    expect(FX_PLAY).toEqual({ gain: 0.5, flickS: 0.6 }); expect(Object.isFrozen(FX_PLAY)).toBe(true)
    expect(CALL_LEN).toEqual({ ring: 2, offhook: 2 }); expect(Object.isFrozen(CALL_LEN)).toBe(true)
    for (const k of Object.keys(CALL_LEN)) expect(CALL_SOUNDS).toContain(k)
    for (const e of EVENTS) if (e.fx) expect(CALL_SOUNDS, e.id).toContain(e.fx.sound)
  })
  it('dread is read at 4 Hz and its field flooded at most twice a second', () => {
    expect(DREAD_CLOCK).toEqual({ tick: 0.25, build: 0.5 }); expect(Object.isFrozen(DREAD_CLOCK)).toBe(true)
  })
  it('the drawer\'s words: the refusal names why, an opened one says so', () => {
    expect(NOT_NOW_LINE).toBe('not now. something is close.')
    expect(SEARCHED_HINT).toBe('searched.')
  })
})

describe('w3: the imports, the state, the shell', () => {
  it('imports the field by its real name', () => {
    expect(game).toMatch(/import \{ createPathField \} from '\.\/pathfield\.js'/)
  })
  it('the repeats, the bag, the dread\'s field, teller and record, the drawer being opened and the searched predicate: declared once, outside the loop', () => {
    for (const s of [
      "let fxSound = '', fxPan = 0, fxLeft = 0, fxEvery = 0, fxT = 0",
      'let murmurBag = createBag(0)',
      'const pathField = createPathField(), teller = createTeller()',
      'const dreadOut = { dread: 0, x: 0, y: 0, variant: null, d: -1, los: false }',
      'let dreadT = 0, fieldT = -Infinity, fieldOn = false',
      'let opening = null',
      'const searchedBox = (p) => CONTAINER_TYPES[p.type] !== undefined && searchLog.isSearched(p.key)',
    ]) { expect(at(s)).toBeLessThan(loopAt); expect(game.split(s).length - 1, s).toBe(1) }
  })
  it('pathfield.js is in src/sw.js and tools/build-play.sh', () => {
    expect(sw).toContain("'/renderer/pathfield.js'"); expect(build).toContain("'pathfield.js'")
  })
})

describe('T1-5: events that carry their own effect, the arrival\'s event, the murmur bag', () => {
  const EVB = () => slice('const evCanFire = ', '// running water (a haunt)')
  // fireEvent, startVisit and the frame's events block lifted together with the real catalogue, the real plate wrapper and budget
  // (its window long past: the gap alone decides); the sounds, the lines and the hand-wired effects recorded on a play clock
  function rig({ index = 1, sched = null, quiet = 0 } = {}) {
    const heard = [], said = [], other = [], arrived = []
    let now = 0
    const plates = createPlateBudget(); plates.arrive(-1000)
    const D = {
      PRIO, eventFx, evConfig: { events: EVENTS }, CALL_LEN, FX_PLAY, FOOTSTEPS_ECHO, plates, level: { index, cfg: { map: null } }, msgQ: { idle: () => true },
      call: (s, g, p) => heard.push([now, s, g, p]), showMessage: (t, p) => said.push([now, t, p]),
      panelsOut: () => other.push('panels'), doorSlam: () => other.push('slam'), humDuck: () => other.push('duck'), whisper: () => other.push('whisper'),
      footfall: () => other.push('footfall'), heartbeat: () => {}, spawnCrosser: () => other.push('crosser'),
      eventSched: sched ?? { tick: () => null, soundOnly: false, arrive: (l, s) => arrived.push([l, s]) },
      teller: { reset: () => other.push('teller') }, dreadOut: { dread: 0.4 },
    }
    const st = { playT: 0, dt: 0, flickTgt: 1, flickTimer: 0, shake: 0, sanity: 100, echoSteps: 0, echoStill: 0, transitioning: false, dialogOpen: false,
      chatOpen: false, noteOpen: false, searchT: 0, dreadQuietT: quiet, fxSound: '', fxPan: 0, fxLeft: 0, fxEvery: 0, fxT: 0,
      floorT0: 0, floorHinted: false, pullPhase: 0, lostSaid: false, hintHeld: false, fieldOn: true }
    const keys = Object.keys(st).join(', ')
    const fn = new Function('st', 'D', 'op', `const { ${Object.keys(D).join(', ')} } = D\nlet { ${keys} } = st\n${lift(PLATE)}\n${lift(FE)}\n${lift(VISIT)}\n` +
      `if (op.fire) fireEvent(...op.fire)\nelse if (op.visit) startVisit()\nelse {\n${EVB()}\n}\nObject.assign(st, { ${keys} })`)
    const fire = (...args) => fn(st, D, { fire: args })
    const visit = () => fn(st, D, { visit: true })
    const frames = (seconds) => { const n = Math.round(seconds * 60); for (let i = 0; i < n; i++) { now = Math.round((now + 1 / 60) * 1e6) / 1e6; st.playT = now; st.dt = 1 / 60; fn(st, D, {}) } }
    return { st, D, heard, said, other, arrived, fire, visit, frames }
  }

  it('the scheduler\'s event: kind \'event\', or none for the arrival\'s (heard, not read); the quiet; then the data event\'s repeats', () => {
    expect(game).toMatch(/const evId = eventSched\.tick\(dt, \{ level: level\.index, sanity, canFire: evCanFire \}\)\r?\n(\s*\/\/[^\n]*\r?\n)*\s*if \(evId\) \{ fireEvent\(evId, PRIO\.ambient, eventSched\.soundOnly \? null : 'event'\); dreadQuietT = 12 \}\r?\n\s*dreadQuietT = Math\.max\(0, dreadQuietT - dt\)\r?\n(\s*\/\/[^\n]*\r?\n)*\s*if \(fxLeft > 0 && !transitioning && \(fxT -= dt\) <= 0\) \{ fxLeft--; fxT \+= fxEvery; call\(fxSound, FX_PLAY\.gain, fxPan\) \}/)
    expect(count(/fireEvent\(evId/g)).toBe(1)
  })
  it('one generic branch, last, for the events that carry their effect as data (the six keep their own)', () => {
    const fe = lift(FE)
    expect(fe).toMatch(/\} else if \(id === 'crosser'\) \{[\s\S]*?\} else \{\r?\n(\s*\/\/[^\n]*\r?\n)*\s*const fx = eventFx\(id, evConfig\.events\)\r?\n\s*if \(fx\?\.sound\) \{/)
    expect(fe).toContain('plate(kind, fx.line, prio, false)')
    expect(fe).not.toMatch(/setTimeout/)                                                  // the repeats ride the play clock
  })
  it('replayed: the phone rings twice, 2 s on and 4 s quiet, from one side; its line once, through the budget', () => {
    const r = rig(); r.fire('phone-rings'); r.frames(14)
    expect(r.heard).toHaveLength(2)
    expect(r.heard.map((h) => h[1])).toEqual(['ring', 'ring'])
    expect(r.heard[0][0]).toBe(0); expect(r.heard[1][0]).toBeCloseTo(CALL_LEN.ring + eventFx('phone-rings').gap, 1)
    for (const h of r.heard) { expect(h[2]).toBe(FX_PLAY.gain); expect(Math.abs(h[3])).toBeCloseTo(eventFx('phone-rings').pan, 9) }
    expect(Math.sign(r.heard[0][3])).toBe(Math.sign(r.heard[1][3]))                        // the same side both times
    expect(r.said).toEqual([[0, eventFx('phone-rings').line, PRIO.ambient]])
    expect(r.st.fxLeft).toBe(0)
  })
  it('replayed: the pipe knocks four times half a second apart; the chair scrapes once; the breaker thuds once, dead centre, and holds the light down', () => {
    const k = rig(); k.fire('pipe-knock'); k.frames(4)
    expect(k.heard.map((h) => [h[1], Math.round(h[0] * 10) / 10])).toEqual([['thump', 0], ['thump', 0.5], ['thump', 1], ['thump', 1.5]])
    const c = rig(); c.fire('chair-scrape'); c.frames(4)
    expect(c.heard.map((h) => h[1])).toEqual(['scrape'])
    const b = rig(); b.fire('breaker-trip'); b.frames(0.25)
    expect(b.heard).toHaveLength(1); expect(b.heard[0][1]).toBe('thump'); expect(Math.abs(b.heard[0][3])).toBe(0)
    expect([b.st.flickTgt, b.st.flickTimer]).toEqual([eventFx('breaker-trip').flick, FX_PLAY.flickS])
    for (const x of [k, c, b]) expect(x.said).toHaveLength(1)
  })
  it('replayed: a death or a way taken stops the repeats under the veil, and the visit clears what was left (review W7)', () => {
    const k = rig({ index: 2 }); k.fire('pipe-knock'); k.frames(0.3)
    expect(k.heard).toHaveLength(1)
    k.st.transitioning = true; k.frames(1.5)                                                // the fade: three knocks would have come
    expect(k.heard).toHaveLength(1)
    k.visit(); k.st.transitioning = false; k.frames(3)                                     // the new floor hears none of the old one's
    expect(k.heard).toHaveLength(1); expect(k.st.fxLeft).toBe(0)
  })
  it('replayed: the six keep their own effects (no data sound); an unknown id does nothing at all', () => {
    const r = rig(); r.fire('door-slam'); r.fire('hum-stops'); r.frames(10)
    expect(r.heard).toEqual([]); expect(r.other).toEqual(['slam', 'duck']); expect(r.st.fxLeft).toBe(0)
    const u = rig(); u.fire('what'); u.frames(2)
    expect([u.heard, u.said, u.other]).toEqual([[], [], []])
  })
  it('plate(): no kind is a line not said at all, and the budget is never asked', () => {
    const asked = [], shown = []
    const plate = new Function('plates', 'showMessage', 'level', 'msgQ', 'PRIO', `let playT = 5\n${lift(PLATE)}\nreturn plate`)(
      { admit: (...a) => { asked.push(a); return 'show' } }, (t) => shown.push(t), { cfg: { map: null } }, { idle: () => true }, PRIO)
    expect(plate(null, 'a phone.', PRIO.ambient, false)).toBe(false)
    expect([asked, shown]).toEqual([[], []])
    expect(plate('event', 'a phone.', PRIO.ambient, false)).toBe(true); expect(shown).toEqual(['a phone.'])
  })
  it('replayed: the arrival\'s event is heard, not read, the hand-wired ones too; and the next one is read', () => {
    const r = rig(); r.fire('phone-rings', PRIO.ambient, null); r.fire('cold-spot', PRIO.ambient, null)
    expect(r.heard.map((h) => h[1])).toEqual(['ring']); expect(r.other).toEqual(['whisper']); expect(r.said).toEqual([])
    // the real scheduler: an rng of 0 makes the arrival's event certain, 16 s in
    const s = rig({ sched: createEventScheduler({ rng: () => 0 }), quiet: 20 })   // a haunt's 20 s quiet, left from the floor before
    s.visit()
    expect(s.st.dreadQuietT).toBe(0)
    s.frames(15.9); expect(s.heard.length + s.other.length).toBe(1)                          // (the teller's reset, at the visit)
    s.frames(0.2)
    expect(s.heard.length + s.other.length).toBeGreaterThan(1)                              // at 16 s: heard
    expect(s.said).toEqual([])                                                             // and not read
    expect(s.st.dreadQuietT).toBeGreaterThan(11)
    s.frames(120)
    expect(s.said.length).toBeGreaterThan(0)                                               // the next event says its line
  })
  it('a visit starts the floor\'s events over (the procedural floors only) inside no quiet, and dread and the repeats start fresh', () => {
    expect(lift(VISIT)).toMatch(/plates\.arrive\(playT\)\r?\n(\s*\/\/[^\n]*\r?\n)*\s*dreadQuietT = 0\r?\n\s*if \(level\.index >= 0 && level\.index <= 3\) eventSched\.arrive\(level\.index, sanity\)\r?\n\s*teller\.reset\(\); fieldOn = false; dreadOut\.dread = 0; fxLeft = 0/)
    for (const index of [0, 1, 2, 3]) {
      const r = rig({ index, quiet: 20 }); r.st.fxLeft = 3; r.st.sanity = 61; r.visit()
      expect(r.arrived).toEqual([[index, 61]])
      expect([r.st.dreadQuietT, r.st.fieldOn, r.D.dreadOut.dread, r.st.fxLeft]).toEqual([0, false, 0, 0])
      expect(r.other).toEqual(['teller'])
    }
    const b = rig({ index: BLOCK, quiet: 20 }); b.visit()
    expect(b.arrived).toEqual([]); expect(b.st.dreadQuietT).toBe(0)                       // the block has no events: nothing to start
    expect(count(/eventSched\.arrive\(/g)).toBe(1)                                          // only here: travel, the wake, the start, a resume
  })
  it('the murmurs come from a bag the floor builds with its lines: each once before any comes again, never twice running', () => {
    // (the block draws by its coin, as it did: the hold)
    expect(game).toMatch(/const murmur = cfg\.map \? level\.messages\[Math\.floor\(Math\.random\(\) \* level\.messages\.length\)\] : level\.messages\[murmurBag\.next\(\)\]\r?\n\s*if \(!hintHeld \|\| murmur !== cfg\.exit\?\.hint\) plate\('murmur', murmur, PRIO\.ambient, false\)/)
    expect(count(/level\.messages\[Math\.floor\(Math\.random\(\)/g)).toBe(1)
    const b0 = at('function buildLevel(index, at = null) {'), bagAt = at('murmurBag = createBag(messages.length)')
    expect(bagAt).toBeGreaterThan(at('].filter(Boolean)', b0))
    expect(bagAt).toBeLessThan(at('level = { index, cfg, cache, grid, bodies, decor, solid, entitySys, gfx, messages }'))
    expect(count(/murmurBag = createBag\(messages\.length\)/g)).toBe(1)
    const cfg = levelConfig(DEFAULT_CONFIG, 1)
    const messages = [...cfg.messages, cfg.exit?.hint].filter(Boolean)
    const draw = new Function('messages', 'createBag', 'plate', 'PRIO', 'cfg', 'hintHeld',
      `let murmurBag\n${lift(/murmurBag = createBag\(messages\.length\)/)}\nconst level = { messages }\n` +
      `return () => { ${lift(MURMUR)} }`)
    const said = []
    const next = draw(messages, createBag, (k, t) => { said.push(t); return true }, PRIO, cfg, false)
    for (let i = 0; i < messages.length; i++) next()
    expect(new Set(said).size).toBe(messages.length)
    for (let i = 0; i < 1300; i++) next()
    for (let i = 1; i < said.length; i++) expect(said[i]).not.toBe(said[i - 1])
  })
})

describe('T1-9: drawers that pay a little more', () => {
  // the api, the drawer being opened and resolveSearch lifted with the real applyRoll and search log; the roll, the hands and the
  // floor plan's pin stood in for
  function rig({ roll, grant = () => ({ ok: true }), trace = () => null } = {}) {
    const said = [], noise = [], gained = [], rolled = { n: 0 }
    const D = {
      searchLog: createSearchLog(), applyRoll, PRIO, DRAWER_COST: { minLevel: 2, sanity: 2, line: 'counted.' }, worldSeed: null,
      rollContainer: () => { rolled.n++; return typeof roll === 'function' ? roll() : roll },
      itemSys: { grant: (t, e) => grant(t, e) }, showMessage: (t) => said.push(t), clampSanity: (d) => gained.push(d),
      fireEvent: () => {}, hauntEffects: () => null, hauntCtx: () => null, applyHaunt: () => {},
      level: { index: 1, cfg: { maze: { salt: 0 } }, entitySys: { noise: (x, y, n) => noise.push([x, y, n]) } },
      mem: { noteSearched: () => {} }, renderHotbar: () => {}, traceOne: () => trace(),
    }
    const fn = new Function('D', `const { ${Object.keys(D).join(', ')} } = D\nlet sanity = 100, drawerCostSaid = false\n${lift(/let opening = null[^\n]*/)}\n${lift(SAPI)}\n${lift(RESOLVE)}\nreturn resolveSearch`)
    return { D, said, noise, gained, rolled, resolve: fn(D) }
  }
  const box = (n) => ({ key: `3,4:d${n}`, x: 70.5 + n, y: 90.5, type: 'cabinet' })

  it('the refusal says why: something is close', () => {
    expect(game).toMatch(/function startSearch\(p, th\) \{\r?\n\s*if \(th\.hunted \|\| th\.nearest <= 4\) \{ showMessage\(NOT_NOW_LINE, PRIO\.interaction\); return \}/)
    expect(game).not.toContain("'not now.'")
  })
  it('resolveSearch replays a held roll before it rolls, holds what your hands were too full for, and marks the drawer only when it gives up', () => {
    expect(lift(RESOLVE)).toMatch(/const roll = searchLog\.held\(p\.key\) \?\? rollContainer\(p\.key, cx, cy, level\.index, worldSeed \| 0, level\.cfg\.maze\?\.salt \| 0\)\r?\n\s*opening = p\r?\n\s*if \(!applyRoll\(roll, searchApi\)\) \{ searchLog\.hold\(p\.key, roll\); return \}/)
  })
  it('the api gains the squeal\'s noise at the drawer being opened, and the floor plan\'s pin', () => {
    expect(lift(SAPI)).toMatch(/noise: \(n\) => level\.entitySys\.noise\(opening\.x, opening\.y, n\), trace: traceOne,/)
  })
  it('replayed: hands full, the drawer keeps what it had; the next search gives that, not a new roll', () => {
    const rolls = [{ kind: 'item', type: 'bandage', extra: {} }, { kind: 'empty' }]
    let full = true
    const r = rig({ roll: () => rolls.shift(), grant: () => ({ ok: !full }) })
    const p = box(1)
    r.resolve(p)
    expect(r.said).toEqual([HANDS_FULL_LINE]); expect(r.D.searchLog.isSearched(p.key)).toBe(false); expect(r.D.searchLog.held(p.key)).toMatchObject({ kind: 'item', type: 'bandage' })
    full = false; r.resolve(p)
    expect(r.said[1]).toMatch(/^in the drawer: /); expect(r.rolled.n).toBe(1)
    expect(r.D.searchLog.isSearched(p.key)).toBe(true); expect(r.D.searchLog.held(p.key)).toBeNull()
  })
  it('replayed: the runners squeal for real, SQUEAL_NOISE at that drawer beside the search\'s own 4, and louder (the loudest is what is heard); the other empties only the 4', () => {
    const own = Number(lift(RESOLVE).match(/level\.entitySys\.noise\(p\.x, p\.y, (\d+)\)/)[1])
    expect(own).toBe(4); expect(SQUEAL_NOISE).toBeGreaterThan(own)                        // (review C12: a 3 beside the 4 was never heard)
    const r = rig({ roll: { kind: 'empty' } })
    for (let n = 0; n < 8; n++) r.resolve(box(n))
    const k = r.said.indexOf(SQUEAL_LINE)
    expect(k).toBeGreaterThanOrEqual(0)
    expect(r.noise.filter((x) => x[2] === SQUEAL_NOISE)).toEqual([[box(k).x, box(k).y, SQUEAL_NOISE]])
    expect(r.noise.filter((x) => x[2] === 4)).toHaveLength(8)
  })
  it('replayed: a floor plan that pins says so and steadies nothing; with nothing to pin it is read as its own note', () => {
    for (const got of ['content', 'way']) {
      const r = rig({ roll: { kind: 'trace', fallback: 'just paper.' }, trace: () => got }); r.resolve(box(1))
      expect(r.said).toEqual([TRACE_LINES[got]]); expect(r.gained).toEqual([])
    }
    const n = rig({ roll: { kind: 'trace', fallback: 'just paper.' } }); n.resolve(box(1))
    expect(n.said).toEqual(['just paper.']); expect(n.gained).toEqual([3])
  })

  // traceOne lifted with the real fog map
  function traceRig({ sights = [], scraps = [], exits = [], stairs = [], read = [] } = {}) {
    const fog = createFogMap()
    const D = { level: { index: 1, decor: { getSights: () => sights, getScraps: () => scraps, getExits: () => exits, getStairs: () => stairs } },
      fog, player: { x: 0.5, y: 0.5 }, readSet: new Set(read), epochOf: () => 0, CHUNK_SIZE }
    const st = { floorHinted: false }
    const fn = new Function('st', 'D', `const { ${Object.keys(D).join(', ')} } = D\nlet { floorHinted } = st\n${lift(TRACE)}\nconst got = traceOne()\nst.floorHinted = floorHinted\nreturn got`)
    return { fog, st, trace: () => fn(st, D) }
  }
  it('replayed: the floor plan pins what the floor holds first, nearest first, then a way on, never a stair up; then there is nothing left', () => {
    const page = { key: '1,0', x: 20.5, y: 0.5, frag: 3 }, sight = { key: '1,0', x: 30.5, y: 0.5, type: 'fountain' }
    const down = { key: '0,0', x: 5.5, y: 0.5, kind: 'down' }, up = { key: '0,0:up', x: 2.5, y: 0.5, kind: 'up' }
    const r = traceRig({ sights: [sight], scraps: [page], exits: [down], stairs: [up] })
    expect(r.trace()).toBe('content')
    expect(r.fog.pins(1).get('n:1,0')).toMatchObject({ type: 'note', flag: false, x: 20.5 }); expect(r.st.floorHinted).toBe(true)
    expect(r.trace()).toBe('content'); expect(r.fog.pins(1).get('s:1,0')).toMatchObject({ type: 'sight', x: 30.5 })
    expect(r.trace()).toBe('way'); expect(r.fog.ways(1).map((w) => w.key)).toEqual(['0,0'])
    expect(r.trace()).toBeNull()
    expect(r.fog.pins(1).has('0,0:up')).toBe(false)
  })
  it('replayed: a page read, a spot walked, the first run\'s note and a way already drawn are passed over; nothing pinned frees nothing', () => {
    const r = traceRig({
      scraps: [{ key: '0,1', x: 9.5, y: 0.5, frag: 2 }, { key: 'firstrun', x: 4.5, y: 0.5, frag: -1, firstrun: true }],
      sights: [{ key: '0,2', x: 3.5, y: 0.5, type: 'fountain' }], exits: [{ key: '0,0', x: 5.5, y: 0.5, kind: 'down' }], read: [2],
    })
    r.fog.step(1, 3.5, 0.5, 2, () => true)
    r.fog.pinWay(1, { key: '0,0', x: 5.5, y: 0.5, kind: 'down' })
    expect(r.trace()).toBeNull(); expect(r.st.floorHinted).toBe(false)
    expect(r.fog.pins(1).has('n:firstrun')).toBe(false)
  })
  it('replayed: walking by, the map pins a page with its read flag, and never the first run\'s note (no pin, as its card and the plan say; review W9)', () => {
    expect(slice('function pinSeen(reach) {', 'const entityAsm = createEntityAssembler()'))
      .toContain("if (sc && !sc.firstrun) fog.pinThing(L, 'n:' + sc.key, 'note', sc.x, sc.y, readSet.has(sc.frag))")
    const PIN = /const sc = level\.decor\.nearestScrap\(player\.x, player\.y, PROX_PIN\)\r?\n[^\n]*/
    const pin = (rec, read = []) => {
      const fog = createFogMap()
      new Function('level', 'player', 'PROX_PIN', 'fog', 'L', 'readSet', lift(PIN))(
        { decor: { nearestScrap: () => rec } }, { x: 33.5, y: 11.5 }, 4.5, fog, 0, new Set(read))
      return fog.pins(0)
    }
    expect(pin(noteRecord()).has('n:firstrun')).toBe(false)
    expect(pin(noteRecord()).size).toBe(0)
    expect(pin({ key: '1,0', x: 28.5, y: 11.5, frag: 3 }).get('n:1,0')).toMatchObject({ type: 'note', flag: false })
    expect(pin({ key: '1,0', x: 28.5, y: 11.5, frag: 3 }, [3]).get('n:1,0')).toMatchObject({ type: 'note', flag: true })
    expect(pin(null).size).toBe(0)
  })
  it('an opened drawer says so on the hint line, last in the ladder (never a plate, never over a prompt); not on the block', () => {
    expect(game).toMatch(/\} else if \(nearNpc\) \{\r?\n\s*itemHintEl\.textContent = 'e · speak to the lost soul'\r?\n\s*itemHintEl\.style\.opacity = '1'\r?\n\s*\} else if \(!cfg\.map && level\.decor\.nearestProp\(player\.x, player\.y, 1\.5, searchedBox\)\) \{\r?\n\s*itemHintEl\.textContent = SEARCHED_HINT[^\n]*\r?\n\s*itemHintEl\.style\.opacity = '1'\r?\n\s*\} else \{\r?\n\s*itemHintEl\.style\.opacity = '0'/)
    expect(count(/SEARCHED_HINT/g)).toBe(2)                                                  // the import, the hint
    const log = createSearchLog(); log.markSearched('a')
    const [un, done] = new Function('CONTAINER_TYPES', 'searchLog', `${lift(/const unsearchedBox = [^\n]*/)}\n${lift(/const searchedBox = [^\n]*/)}\nreturn [unsearchedBox, searchedBox]`)(CONTAINER_TYPES, log)
    expect([un({ type: 'cabinet', key: 'a' }), done({ type: 'cabinet', key: 'a' })]).toEqual([false, true])
    expect([un({ type: 'cabinet', key: 'b' }), done({ type: 'cabinet', key: 'b' })]).toEqual([true, false])
    expect(done({ type: 'chair', key: 'a' })).toBe(false)
  })
})

describe('T1-8: dread you hear before you see', () => {
  const DREAD = () => slice('// ── dread (dread.js)', '// ── the lobby\'s exit hint, held for the first run')
  // a real level 1 around its spawn, the chunks preload holds; the creatures are placed by a field of its own
  let world = null
  const L1 = () => world ?? (world = (() => {
    const cfg = levelConfig(DEFAULT_CONFIG, 1)
    const cache = createChunkCache(cfg, null); cache.preload(0, 0)
    const grid = createGridReader(cache, (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)); grid.setPlayerChunk(0, 0)
    const mid = chunkMid(0, 0), m = findOpenNear(mid.x, mid.y, grid.floor) ?? mid
    const probe = createPathField(); probe.build(m.x, m.y, cache)
    const near = { x: 0, y: 0, d: -1 }, close = { x: 0, y: 0, d: -1 }
    expect(probe.pick(9, 12, lcg(5), null, near)).toBe(true); expect(probe.pick(4, 5, lcg(9), null, close)).toBe(true)
    return { cache, player: { x: m.x, y: m.y, angle: 0 }, near, close }
  })())
  const thing = (p, o = {}) => ({ x: p.x, y: p.y, variant: 'shade', ai: 'roam', los: false, ...o })
  // the block lifted and run at 60 Hz with the real field, dreadNear, dreadFrom and a seeded teller
  function rig({ ents, live = true, map = null, transitioning = false } = {}) {
    const W = L1(), heard = [], builds = { n: 0 }, reads = { n: 0 }
    const pf = createPathField()
    const st = { playT: 0, dt: 1 / 60, dreadT: 0, fieldT: -Infinity, fieldOn: false }
    const D = {
      level: { entitySys: { getEntities: () => ents }, cache: W.cache }, creaturesLive: live, transitioning, cfg: { map }, player: W.player,
      pathField: { build: (x, y, c) => { builds.n++; return pf.build(x, y, c) }, dist: (x, y) => pf.dist(x, y) },
      teller: createTeller({ rng: lcg(3) }), dreadOut: { dread: 0, x: 0, y: 0, variant: null, d: -1, los: false },
      dreadNear, dreadFrom: (e, f, p, o) => { reads.n++; return dreadFrom(e, f, p, o) }, DREAD_CLOCK,
      call: (s, g, p) => heard.push([st.playT, s, g, p]),
    }
    const keys = Object.keys(st).join(', ')
    const fn = new Function('st', 'D', `const { ${Object.keys(D).join(', ')} } = D\nlet { ${keys} } = st\n${DREAD()}\nObject.assign(st, { ${keys} })`)
    const run = (seconds) => { const n = Math.round(seconds * 60); for (let i = 0; i < n; i++) { st.playT = Math.round((st.playT + 1 / 60) * 1e6) / 1e6; fn(st, D) } }
    return { W, D, st, heard, builds, reads, run }
  }

  it('runs after the frame\'s preload (the field reads only the chunks it holds) and before the compass; its block allocates nothing', () => {
    expect(at('// ── dread (dread.js)', loopAt)).toBeGreaterThan(at('level.cache.preload(pcx, pcy)', loopAt))
    expect(at('// ── dread (dread.js)', loopAt)).toBeLessThan(at('// ── the compass (compass.js)', loopAt))
    expect(DREAD()).toMatch(/const near = creaturesLive && !transitioning && !cfg\.map && dreadNear\(ents, player\)/)
    expect(DREAD()).toMatch(/const tell = teller\.tick\(DREAD_CLOCK\.tick, dreadOut, player\)\r?\n\s*if \(tell\) call\(tell\.sound, tell\.gain, tell\.pan\)/)
    expect(DREAD()).not.toMatch(/\{ [a-z]+:|=>|\bnew\b|\[\]/)
    expect(count(/pathField\.build\(/g)).toBe(1); expect(count(/teller\.tick\(/g)).toBe(1)
  })
  it('tension hears it, behind the same gate as the hunt: creatures off or a fade, no dread', () => {
    expect(game).toContain('const tn = tension.tick(dt, creaturesLive && !transitioning ? th : null, player.hp, creaturesLive && !transitioning ? dreadOut.dread : 0)')
  })
  it('replayed: something near through the maze is read at 4 Hz, its field flooded at most twice a second, and it weighs', () => {
    const W = L1(), r = rig({ ents: [thing(W.near)] })
    r.run(10)
    expect(Math.abs(r.reads.n - 10 / DREAD_CLOCK.tick)).toBeLessThanOrEqual(1)
    expect(r.builds.n).toBeGreaterThanOrEqual(1); expect(r.builds.n).toBeLessThanOrEqual(10 / DREAD_CLOCK.build + 1)
    expect(r.D.dreadOut.dread).toBeGreaterThan(0); expect(r.D.dreadOut.d).toBe(W.near.d); expect(r.D.dreadOut.variant).toBe('shade')
  })
  it('replayed: now and then its tell, from where it is: a call the audio knows, 0.25 to 0.75, at most 0.85 to a side, 3.5 s apart at least', () => {
    const r = rig({ ents: [thing(L1().near)] })
    r.run(120)
    expect(r.heard.length).toBeGreaterThan(0)
    for (const [, s, g, p] of r.heard) { expect(CALL_SOUNDS).toContain(s); expect(g).toBeGreaterThanOrEqual(0.25); expect(g).toBeLessThanOrEqual(0.75); expect(Math.abs(p)).toBeLessThanOrEqual(0.85) }
    for (let i = 1; i < r.heard.length; i++) expect(r.heard[i][0] - r.heard[i - 1][0]).toBeGreaterThanOrEqual(3.5 - 1e-9)
  })
  it('replayed: nothing within reach in a straight line, a thing hunting you, creatures off, a fade or the block: no flood, no dread, no tell', () => {
    const W = L1()
    const cases = { far: { ents: [thing({ x: W.player.x + DREAD_R + 30, y: W.player.y })] }, hunting: { ents: [thing(W.near, { ai: 'hunt' })] },
      off: { ents: [thing(W.near)], live: false }, fade: { ents: [thing(W.near)], transitioning: true }, block: { ents: [thing(W.near)], map: {} }, none: { ents: [] } }
    for (const [name, o] of Object.entries(cases)) {
      const r = rig(o); r.run(30)
      expect([r.builds.n, r.D.dreadOut.dread, r.heard.length], name).toEqual([0, 0, 0])
    }
  })
  it('replayed: the first read after the gate opens floods the field at once (never an old cell\'s)', () => {
    const W = L1(), ents = [thing({ x: W.player.x + DREAD_R + 30, y: W.player.y })], r = rig({ ents })
    r.run(3); expect(r.builds.n).toBe(0)
    ents[0].x = W.near.x; ents[0].y = W.near.y
    r.run(DREAD_CLOCK.tick + 1 / 60); expect(r.builds.n).toBe(1); expect(r.D.dreadOut.dread).toBeGreaterThan(0)
  })
  it('replayed: a hound a few cells off lifts the heartbeat before anything hunts you, and never into the hunt; none without it', () => {
    const r = rig({ ents: [thing(L1().close, { variant: 'hound' })] })
    r.run(2)
    const t = createTension(), calm = createTension()
    let tn = null, tc = null
    for (let i = 0; i < 600; i++) { tn = t.tick(1 / 60, null, 100, r.D.dreadOut.dread); tc = calm.tick(1 / 60, null, 100, 0) }
    expect(tn.beat).toBeLessThan(Infinity); expect(tn.mood).not.toBe('hunt'); expect(tn.huntLevel).toBe(0)
    expect(tc.beat).toBe(Infinity)
  })
})

// ── the hold: Level ∅ (the block) keeps 2.0.3. Nothing of this pass reaches it: its compass, its plates, its murmurs, its light ────────

describe('the hold: the block keeps 2.0.3', () => {
  const B = levelConfig(DEFAULT_CONFIG, BLOCK)
  it('the block is the one floor with a map of its own (cfg.map), the flag every guard below reads', () => {
    expect(B.map).toBeTruthy()
    for (const i of [0, 1, 2, 3]) expect(levelConfig(DEFAULT_CONFIG, i).map, String(i)).toBeFalsy()
  })
  it('its compass keeps the faint line\'s metres, as in 2.0.3; the four floors\' faint line names none', () => {
    expect(game).toContain('const s = compassText(compassOut, !!cfg.map)')
    const out = [{ arrow: '↗', text: FAINT, dist: 19 }]
    expect(compassText(out, !!B.map)).toBe(`↗  ${FAINT}  ·  19m`)
    expect(compassText(out, !!levelConfig(DEFAULT_CONFIG, 1).map)).toBe(`↗  ${FAINT}`)
  })
  it('plate() on the block goes straight to showMessage: the budget is never asked, the queue alone decides (as in 2.0.3)', () => {
    const asked = [], shown = []
    const plate = new Function('plates', 'showMessage', 'level', 'msgQ', 'PRIO', `let playT = 5\n${lift(PLATE)}\nreturn plate`)(
      { admit: (...a) => { asked.push(a); return 'queue' } }, (t, p) => shown.push([t, p]), { cfg: { map: B.map } }, { idle: () => false }, PRIO)
    expect(plate('floor', 'the block.', PRIO.combat)).toBe(true)
    expect(plate('arrival', 'the gap.', PRIO.discovery)).toBe(true)
    expect(plate('murmur', 'a window.', PRIO.ambient, false)).toBe(true)
    expect(plate(null, 'heard, not read.', PRIO.ambient)).toBe(false)
    expect(asked).toEqual([])
    expect(shown).toEqual([['the block.', PRIO.combat], ['the gap.', PRIO.discovery], ['a window.', PRIO.ambient]])
  })
  it('replayed with the real queue: the block\'s name, its gap\'s line at 3.8 s and a murmur at 30 s all reach the screen, as in 2.0.3', () => {
    const { h, said, run } = arrival({ map: B.map, queue: true })
    h.startVisit()
    h.plate('floor', 'the block.', PRIO.combat)
    h.later(3800, 'the gap.', PRIO.discovery)
    run(60, { 30: () => h.plate('murmur', 'a window.', PRIO.ambient, false) })
    expect(said.map((s) => s[1])).toEqual(['the block.', 'the gap.', 'a window.'])
    expect(said[2][0]).toBe(30)
  })
  it('its murmurs are drawn by the coin, as in 2.0.3, and the four floors\' bag is never asked', () => {
    const messages = ['one.', 'two.', 'three.'], said = []
    const bag = { n: 0, next() { this.n++; return 1 } }
    const draw = (map) => new Function('level', 'murmurBag', 'plate', 'PRIO', 'cfg', 'hintHeld', `${lift(MURMUR)}`)(
      { messages }, bag, (k, t) => { said.push(t); return true }, PRIO, { map }, false)
    const spy = vi.spyOn(Math, 'random')
    try { spy.mockReturnValue(0.99); draw(B.map); spy.mockReturnValue(0); draw(B.map); draw(B.map) } finally { spy.mockRestore() }
    expect(said).toEqual(['three.', 'one.', 'one.']); expect(bag.n).toBe(0)
    draw(null); expect(said.at(-1)).toBe('two.'); expect(bag.n).toBe(1)                        // below the block: the bag
  })
  it('every flashlight toggle on the block says its line, as in 2.0.3, and does not use up the run\'s first line below', () => {
    const run = new Function('K', 'kneel', 'litOffLine', 'showMessage', 'LIGHT_STAYS_LINE', 'cfg', 'st',
      `let { flashlight, lightToggles, litRec, lightSaid } = st\n${lift(LIGHT)}\nObject.assign(st, { flashlight, lightToggles, lightSaid })`)
    const said = [], st = { flashlight: true, lightToggles: 0, litRec: null, lightSaid: false }
    const press = (map) => run({ KeyL: true }, { st: null }, litOffLine, (m) => said.push(m), 'your light stays on them.', { map }, st)
    for (let i = 0; i < 4; i++) press(B.map)
    expect(said).toEqual([litOffLine(null), 'flashlight on.', litOffLine(null), 'flashlight on.'])
    expect(st.lightSaid).toBe(false)
    press(null); press(null)                                                                   // then below: the run's first line, then the light alone
    expect(said.slice(4)).toEqual([litOffLine(null)])
  })
})

// ── review batch five, two: the lines the budget lost ───────────────────────────────────────────────────────────────────────────────
// the wake's lines (the answer to your death) waited out the window as 'arrival' plates and were wiped by a travel; the filing line lost
// the arrival's second plate to the hint and waited too; a floor you came back to let its summary go behind the way line. The tails of
// die() and travel() are lifted from game.js and replayed with the real budget, so the order and the kinds below are the game's own
describe('review batch five, two: the wake, the filing and the floor you come back to say their lines again', () => {
  const dieBody = slice('function die(d = null) {', '// ── input ──')
  const travelBody = slice('function travel(way) {', '// die(): death.js resolves it')
  const WAKE = dieBody.slice(dieBody.indexOf('startVisit()'), dieBody.indexOf('bus?.here(hereFields())'))
  const TAIL = travelBody.slice(travelBody.indexOf('startVisit()'), travelBody.lastIndexOf('bus?.here(hereFields())'))
  const FILE = lift(/later\([0-9]+, filingLine\(origin, thin\), PRIO\.discovery\)/)
  const L = (i) => levelConfig(DEFAULT_CONFIG, i)
  const R = { message: 'you wake beside the hole you fell through.', dropped: 'almond-water', droppedLine: 'your hands opened.' }

  // die()'s lines from startVisit() on: the floor's plate, then the wake's three
  const wake = ({ cfg = L(LOBBY), first = true, r = R, d = { line: 'nobody came.' } } = {}) => {
    const { h, said, run } = arrival({ cfg })
    new Function('startVisit', 'plate', 'later', 'arrivalPlate', 'level', 'first', 'r', 'd', 'PRIO', WAKE)(
      h.startVisit, h.plate, h.later, arrivalPlate, { cfg }, first, r, d, PRIO)
    return { h, said, run }
  }
  // travel()'s lines from startVisit() on (the hint, the way line, the summary, the raised ceiling, the mercy line), and the filing line
  // before them when this way files you
  const land = ({ index = 1, first = true, filing = false, followed = 0, fresh = false, visits = first ? 1 : 2, down = 2, origin = 'tenant' } = {}) => {
    const cfg = L(index)
    const { h, said, run } = arrival({ cfg })
    const out = new Function('startVisit', 'plate', 'later', 'arrivalPlate', 'level', 'first', 'filing', 'followed', 'freshLobby', 'way', 'wayMessage',
      'partner', 'mem', 'fog', 'arrivalSummary', 'rec', 'player', 'hp0', 'origin', 'thin', 'filingLine', 'MERCY_LINE', 'PRIO',
      `let hintHeld = false\nif (filing) ${FILE}\n${TAIL}\nreturn { hintHeld }`)(
      h.startVisit, h.plate, h.later, arrivalPlate, { index, cfg }, first, filing, followed, () => fresh, { kind: 'down', target: index },
      () => 'the way you came.', null, { get: () => null }, { countWays: () => ({ down, up: 0, lift: 0, ring: 0 }) }, arrivalSummary, { visits },
      { maxHp: first ? 105 : 100 }, 100, origin, false, filingLine, 'the mercy.', PRIO)
    return { h, said, run, out }
  }

  it('the wake is a free kind: never held, never counted', () => {
    expect(FREE_KINDS).toContain('wake')
    const b = createPlateBudget()
    b.arrive(0); b.admit('floor', 0, 'f'); b.admit('arrival', 1, 'a')
    expect(b.admit('wake', 2, 'w')).toBe('show')
    for (let t = 45; t < 120; t++) expect(b.drain(t)).toBeNull()
  })
  it('the wake\'s lines are said at their moments, 2.6, 5.2 and 7.8 s, after the floor\'s own line on a floor new to you; the window keeps its second plate', () => {
    expect(WAKE).toMatch(/later\(2600, r\.message, PRIO\.discovery, true, 'wake'\)\r?\n\s*if \(r\.dropped\) later\(5200, r\.droppedLine, PRIO\.discovery, true, 'wake'\)\r?\n\s*if \(d\?\.line\) later\(7800, d\.line, PRIO\.discovery, true, 'wake'\)/)
    const { h, said, run } = wake()
    run(20, { 20: () => h.plate('arrival', 'the hint.', PRIO.discovery) })
    expect(said).toEqual([[0, L(LOBBY).levelSub], [2.6, R.message], [5.2, R.droppedLine], [7.8, 'nobody came.'], [20, 'the hint.']])
    run(80, { 21: () => h.plate('arrival', 'one more.', PRIO.discovery) })
    expect(said.slice(5)).toEqual([[45, 'one more.']])
  })
  it('on a floor you have been on, the wake puts up no plate of its own (the HUD carries the name): its lines alone, at their moments', () => {
    const { said, run } = wake({ first: false })
    run(80)
    expect(said).toEqual([[2.6, R.message], [5.2, R.droppedLine], [7.8, 'nobody came.']])
    const bare = wake({ first: false, r: { ...R, dropped: null, droppedLine: null }, d: null })     // LEGACY's death, nothing dropped
    bare.run(80)
    expect(bare.said).toEqual([[2.6, R.message]])
  })
  it('the block\'s wake is 2.0.3\'s: its name always, and every line at its moment', () => {
    const B = L(BLOCK)
    for (const first of [true, false]) {
      const { said, run } = wake({ cfg: B, first })
      run(80)
      expect(said, String(first)).toEqual([[0, B.levelName], [2.6, R.message], [5.2, R.droppedLine], [7.8, 'nobody came.']])
    }
  })
  it('the way that files you: the filing line takes the second plate at 3.8 s, the way line is let go, the hint waits (7.6 s, kept) and comes after', () => {
    expect(travelBody).toMatch(/const filing = !filed\r?\n\s*if \(filing\) \{/)
    expect(FILE).toBe('later(3800, filingLine(origin, thin), PRIO.discovery)')
    expect(TAIL).toContain('if (level.cfg.exit?.hint && !followed) { if (freshLobby()) hintHeld = true; else later(filing ? 7600 : 3800, level.cfg.exit.hint, PRIO.discovery) }')
    const { said, run } = land({ filing: true })
    run(80)
    expect(said).toEqual([[0, L(1).levelSub], [3.8, filingLine('tenant', false)], [45, L(1).exit.hint], [45 + DRAIN_S, 'the floor remembers you less.']])
    // an anchored filing: the mercy line waits with the hint, in the order they were said
    const pin = land({ filing: true, origin: 'anchored' })
    pin.run(80)
    expect(pin.said.map((s) => s[1])).toEqual([L(1).levelSub, filingLine('anchored', false), L(1).exit.hint, 'the mercy.', 'the floor remembers you less.'])
    expect(pin.said[1][0]).toBe(3.8)
  })
  it('the front door\'s way into the first run\'s lobby: the hint is held for the thread as before, and the filing line still says itself at 3.8 s', () => {
    const { said, run, out } = land({ index: LOBBY, filing: true, fresh: true })
    run(80)
    expect(out.hintHeld).toBe(true)
    expect(said).toEqual([[0, L(LOBBY).levelSub], [3.8, filingLine('tenant', false)], [45, 'the floor remembers you less.']])
  })
  it('a first visit that files nothing keeps its ladder: the hint at 3.8 s, the way line let go', () => {
    const { said, run } = land({ index: 2 })
    run(80)
    expect(said).toEqual([[0, L(2).levelSub], [3.8, L(2).exit.hint], [45, 'the floor remembers you less.']])
  })
  it('a floor you come back to says so at 3.8 s, with the ways down on your map; the way line after it is let go', () => {
    expect(TAIL).toMatch(/\} else \{\r?\n(\s*\/\/[^\n]*\r?\n)*\s*const s = arrivalSummary\(fog\.countWays\(way\.target\), rec\.visits\)\r?\n\s*if \(s\) later\(3800, s, PRIO\.discovery, false\)\r?\n\s*if \(wm\) later\(7500, wm, PRIO\.discovery, false\)\r?\n\s*\}/)
    const { said, run } = land({ first: false })
    run(80)
    expect(said).toEqual([[0, L(1).levelName], [3.8, arrivalSummary({ down: 2 }, 2)]])
    expect(said[1][1]).toBe('you have been on this floor before. two ways down are on your map.')
  })
})
