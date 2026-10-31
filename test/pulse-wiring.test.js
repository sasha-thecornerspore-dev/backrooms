// The pulse wiring, pass one (S6a w1): game.js plays your own steps on the edge of a step you actually took, the small sounds of your
// hands (a take, a machine, a page, the map) and the lights cascade's panels, lets the footsteps event keep your pace for real; says
// whether the thing that has seen you is on your screen, and plays its tell from where it is when it is not; lets E read a page
// before the presence, keeps the presence quiet while you are hunted and for the first moments of a fresh lobby, names what drops into
// the tray with its article; and hands the entity system the world seed. game.js only boots in a page, so these are source guards plus
// the pieces lifted out of game.js and replayed against the real modules.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { STEP_MATERIAL, STEP_GAIN, CALL_SOUNDS } from '../src/renderer/audio.js'
import { FOOTSTEPS_ECHO } from '../src/renderer/events.js'
import { TELL, SEEN_TELL } from '../src/renderer/dread.js'
import { seenLine, SEEN_ON, SEEN_OFF } from '../src/renderer/compass.js'
import { PRESENCE_HUSH_S } from '../src/renderer/firstrun.js'
import { inViewCone, lineOfSight } from '../src/renderer/raycaster.js'
import { HF } from '../src/renderer/gfx-frame.js'
import { whistlePan } from '../src/renderer/rollcall.js'
import { trayLean } from '../src/renderer/docket.js'
import { PRIO } from '../src/renderer/messages.js'
import { BLOCK } from '../src/renderer/topology.js'

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
    expect(game).toMatch(/import \{ compassLines, compassText, arrivalSummary, seenLine \} from '\.\/compass\.js'/)
    expect(game).toMatch(/import \{ TELL, SEEN_TELL \} from '\.\/dread\.js'/)
    expect(game).toMatch(/import \{ PRESENCE_HUSH_S \} from '\.\/firstrun\.js'/)
  })
  it('the small sounds are the four floors\' (0-3), declared once outside the loop: the block keeps its silence', () => {
    expect(at(OWN)).toBeLessThan(loopAt)
    expect(count(/const ownSounds = /g)).toBe(1)
  })
  it('every new sound of yours is behind it, but the map\'s (never on the block) and the panels\' (an event, floors 0-3 only)', () => {
    expect(count(/\bstep\(STEP_MATERIAL/g)).toBe(1)
    expect(count(/\bpickup\(\)/g)).toBe(2); expect(count(/if \(ownSounds\(\)\) pickup\(\)/g)).toBe(2)
    expect(count(/paper\('page'\)/g)).toBe(1); expect(count(/if \(ownSounds\(\)\) paper\('page'\)/g)).toBe(1)
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
    const fe = slice('function fireEvent(id, prio = PRIO.ambient) {', 'function startSearch(p, th) {')
    expect(fe).toMatch(/\} else if \(id === 'footsteps'\) \{\r?\n\s*footfall\(\); echoSteps = FOOTSTEPS_ECHO\.steps; echoStill = 0[^\n]*\r?\n\s*showMessage\('footsteps\. not yours\. they keep your pace, and stop when you stop\.', prio\)/)
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
    expect(game).toMatch(/if \(id === 'lights-cascade'\) \{\r?\n\s*flickTgt = 0\.14; flickTimer = 0\.7[^\n]*\r?\n\s*panelsOut\(\)[^\n]*\r?\n\s*showMessage\('the lights go out ahead of you, one by one\. then, slowly, they come back\.', prio\)/)
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
    expect(e).toMatch(/if \(nearPresence && !scrapFirst\) openDialog\(\)\r?\n\s*else if \(nearScrap\) nearScrap\.form \? openForm\(\)/)
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
