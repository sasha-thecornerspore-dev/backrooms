// the pacing tools (tools/pacing, dev-only): the walker's library loads this tree and builds a floor the way game.js does, its statistics
// helpers count what RESULTS.md says they count, and the bot's instrumentation still finds every anchor in this tree's game.js (a game.js
// edit that moves one fails here, not in a three-minute Electron session). Imports nothing from Electron and writes nothing.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { loadTree, WIRING, repeats, quietStretches, preceded, gaps, moments, pathTo, replayQueue, queueBound, buildLevelClears, arrivalClears, matchSays } from '../tools/pacing/lib.mjs'
import { patchGame, patchAudio, patchWish, patchContainers } from '../tools/pacing/bot/patch.mjs'
import * as MSG from '../src/renderer/messages.js'
import { closingLines } from '../src/renderer/closings.js'
import { SIGHT_LINES } from '../src/renderer/sightpins.js'

const R = path.join(import.meta.dirname, '..', 'src', 'renderer')
const read = (f) => fs.readFileSync(path.join(R, f), 'utf8')

describe('pacing tools: the library', () => {
  it('loads this tree, reads its wiring, and builds a floor the walker can route on', async () => {
    const T = await loadTree(R)
    expect(Object.keys(T.has).sort()).toEqual(Object.keys(WIRING).sort())
    for (const v of Object.values(T.has)) expect(typeof v).toBe('boolean')
    const f = T.buildFloor(1, null, { cx: 0, cy: 0 })
    expect(f.grid.floor(Math.floor(f.spawn.x), Math.floor(f.spawn.y))).toBe(true)
    const field = T.bfs(f.grid, f.spawn.x, f.spawn.y, 0, 0, 1)
    let far = null
    for (let i = 0; i < field.dist.length; i++) if (field.dist[i] > 10) { far = i; break }
    expect(far).not.toBeNull()
    const p = pathTo(field, f.grid, field.ox + (far % field.Wd) + 0.5, field.oy + Math.floor(far / field.Wd) + 0.5)
    expect(p.length).toBe(field.dist[far] + 1)
    expect(p[0]).toEqual([Math.floor(f.spawn.x), Math.floor(f.spawn.y)])
  })
})

describe('pacing tools: the counts', () => {
  it('repeats: a line again within the window is a repeat, after it is not', () => {
    const l = (t, text) => ({ t, text })
    expect(repeats([l(0, 'a'), l(10, 'b'), l(20, 'a'), l(400, 'a')], 300)).toEqual({ shown: 4, repeats: 1 })
  })
  it('quiet stretches count the open ends too', () => {
    expect(gaps([10, 70], 300)).toEqual([10, 60, 230])
    expect(quietStretches([10, 70], 300, 45)).toBe(2)
    expect(quietStretches([], 40, 45)).toBe(0)
  })
  it('a sighting is cued only by something 5-25 s before it', () => {
    expect(preceded([30, 100], [3, 24, 99], 5, 25)).toBe(1)
  })
  it('moments merge a burst', () => { expect(moments([1, 2, 3.5, 10], 3)).toEqual([1, 10]) })
})

describe('pacing tools: a plate and the say that put it up (stats.mjs)', () => {
  // a queue built with these options, standing in for a tree's messages.js
  const made = (o) => ({ PRIO: MSG.PRIO, createMessageQueue: () => MSG.createMessageQueue(o) })
  const s = (t, text) => ({ t, text })
  const P = MSG.PRIO
  it('replayQueue feeds a tree\'s own queue as showMessage and the frame loop do, and logs what it put up as the bot does', () => {
    const { plates, says } = replayQueue(MSG, [[0, 'b', P.discovery], [0, 'a', P.discovery], [1, 'c', P.ambient]], { untilS: 20 })
    expect(says).toEqual([s(0, 'b'), s(0, 'a'), s(1, 'c')])                       // in time order, ties as given
    expect(plates.map((p) => p.text)).toEqual(['b', 'a'])                        // the ambient line found the queue busy: dropped
    expect(plates[1].t - plates[0].t).toBeCloseTo(6, 1)                         // the discovery gap
    // a clear (buildLevel, in the fade's timeout) comes after its frame's tick, and the says logged at its instant come after it (the
    // floor's line): what waited is dropped, and the floor's line goes up a frame later
    const c = replayQueue(MSG, [[0, 'x', P.discovery], [1, 'y', P.discovery], [2, 'z', P.combat]], { untilS: 20, clears: [2] })
    expect(c.plates.map((p) => p.text)).toEqual(['x', 'z'])
    expect(c.plates[1].t).toBeGreaterThan(2)
    expect(matchSays(c.plates, c.says, [2])).toEqual([c.says[0], c.says[2]])
  })
  it('no fixed window bounds a line\'s wait, read off the queue itself: it drops no discovery line, and only clear() ends a wait', () => {
    // this tree's queue, as game.js builds it (no options): the last of 40 discovery lines said together waits 39 gaps, longer than a session
    const q = queueBound(MSG)
    expect(q.clears).toBe(true)
    expect(q.keepsS).toBeGreaterThan(180)
    expect(q.keepsS).toBeCloseTo(39 * 6, -1)
    expect(queueBound(made({ discoveryGapS: 2 }), 10).keepsS).toBeCloseTo(9 * 2, 0)
    // a queue whose clear() kept what waits would not end a wait at the arrival
    const keeps = { PRIO: MSG.PRIO, createMessageQueue: () => ({ ...MSG.createMessageQueue(), clear() {} }) }
    expect(queueBound(keeps).clears).toBe(false)
  })
  it('the extension closes: three closing lines, a landmark\'s sight line 0.4 s after the last, and the sight line keeps its say after 12.05 s', () => {
    // game.js closeExtension: the closing's three lines at 0, 2.6 and 5.6 s, all discovery; walking up to a landmark just after says its
    // first-sight line (sightpins.js SIGHT_LINES), discovery too. stats.mjs counts a sight line as the player's once it finds its say
    const L = closingLines('extension'), sight = SIGHT_LINES.tvwall.line
    const { plates, says } = replayQueue(MSG, [[0, L[0], P.discovery], [2.6, L[1], P.discovery], [5.6, L[2], P.discovery], [6.0, sight, P.discovery]], { untilS: 30 })
    expect(plates.map((p) => p.text)).toEqual([...L, sight])
    expect(plates[3].t - says[3].t).toBeCloseTo(12.05, 1)
    expect(plates[3].t - says[3].t).toBeGreaterThan(6 + 4.2)                     // past review batch five's window (the gap plus the hold)
    expect(matchSays(plates, says)).toEqual(says)
  })
  it('seed 604, L3: the drawer\'s line that went up 6.05 s after its say, behind a held result, is still that say\'s plate', () => {
    const says = [s(167.67, 'a door humming with current — through it, the lobby waits again.'), s(167.85, 'empty. someone has been through here.'),
      s(167.85, 'something counts the drawers you open.')]
    const plates = [s(167.68, says[0].text), s(167.85, says[1].text), s(173.9, says[2].text)]
    expect(matchSays(plates, says, [163.9])).toEqual(says)
  })
  it('the latest say of its text that no earlier plate took, however long before the plate, and no later than the log\'s frame after it', () => {
    const a0 = s(0, 'a'), a2 = s(2, 'a')
    expect(matchSays([s(3, 'a')], [a0, a2])).toEqual([a2])                       // the latest
    expect(matchSays([s(0, 'a'), s(4, 'a')], [a0])).toEqual([a0, null])         // one say puts up one plate
    expect(matchSays([s(1, 'a'), s(4, 'a')], [a2, a0])).toEqual([a0, a2])       // in time order, whatever order the says come in
    expect(matchSays([s(10, 'a'), s(240, 'a')], [a0, s(0.2, 'a')])).toEqual([s(0.2, 'a'), a0])   // however long it waited
    expect(matchSays([s(4.9, 'c')], [s(5, 'c')])).toEqual([null])                // said after it went up: not its say
    expect(matchSays([s(4.9, 'c')], [s(4.94, 'c')])).toEqual([s(4.94, 'c')])     // ... but within the log's frame it is
    expect(matchSays([s(1, 'x y')], [s(0, ' x \n y ')])).toEqual([s(0, ' x \n y ')])   // the text as #msg shows it
    expect(matchSays([s(1, 'b')], [a0])).toEqual([null])
  })
  it('a say before an arrival never matches a plate after it: buildLevel cleared the queue', () => {
    const a0 = s(0, 'a')
    expect(matchSays([s(10, 'a')], [a0], [5])).toEqual([null])                  // said on the floor before
    expect(matchSays([s(10, 'a')], [a0, s(7, 'a')], [5])).toEqual([s(7, 'a')])  // said again on this one
    expect(matchSays([s(5.3, 'a')], [s(5, 'a')], [5])).toEqual([s(5, 'a')])     // said at the clear's instant: after it, as the floor's line is
    expect(matchSays([s(4.99, 'a')], [s(5.02, 'a')], [5])).toEqual([null])      // within the log's frame of the plate, but on the next floor
    // a plate logged at the clear's instant was up before it: the bot read #msg at the head of the frame, before the game's frame ticked
    // the queue (a bot that does not see the veil reads the old floor's line there)
    expect(matchSays([s(5, 'a')], [s(3, 'a')], [5])).toEqual([s(3, 'a')])
    expect(matchSays([s(5, 'a')], [s(5, 'a')], [5])).toEqual([null])
    expect(matchSays([s(2, 'a'), s(12, 'a')], [a0, s(11, 'a')], [10, 5])).toEqual([a0, s(11, 'a')])
    // the real queue agrees: a line still waiting at the clear never goes up, and what is said after it is matched to its own say
    const { plates, says } = replayQueue(MSG, [[0, 'x', P.discovery], [1, 'a', P.discovery], [5, 'next', P.combat], [12, 'a', P.discovery]], { untilS: 30, clears: [3] })
    expect(plates.map((p) => p.text)).toEqual(['x', 'next', 'a'])
    expect(matchSays(plates, says, [3])).toEqual([says[0], says[2], says[3]])
  })
  it('the clears are the bot\'s \'level\' rows but its first (its own first frame, on the floor the game started on)', () => {
    const r = (t, k, d = null) => ({ t, k, d })
    // a travel F turned away (the way still closing) logs 'travel' and builds nothing; a wake on the floor you died on builds nothing either
    expect(arrivalClears([{ k: 'start' }, r(0.07, 'level'), r(3, 'say'), r(83.1, 'travel'), r(83.68, 'say'), r(83.68, 'level'), r(84.1, 'travel'),
      r(100, 'die'), r(120, 'die'), r(121.3, 'level')])).toEqual([83.68, 121.3])
    expect(arrivalClears([r(0.1, 'say')])).toEqual([])
  })
  it('buildLevel clears the queue on this tree and on the bot\'s instrumented copy of it, the bound stats.mjs reads off the measured copy', () => {
    const g = read('game.js')
    expect(buildLevelClears(g)).toBe(true)
    expect(buildLevelClears(patchGame(g).text)).toBe(true)
    const body = /\n {2}function buildLevel\(/.exec(g).index
    const cut = g.indexOf('msgQ.clear()', body)
    expect(buildLevelClears(g.slice(0, cut) + 'void 0' + g.slice(cut + 'msgQ.clear()'.length))).toBe(false)
    expect(buildLevelClears('')).toBe(false)
  })
  it('stats.mjs reads the bound off the measured tree\'s own messages.js and game.js and matches within the arrival: no window is left', () => {
    const stats = fs.readFileSync(path.join(import.meta.dirname, '..', 'tools', 'pacing', 'bot', 'stats.mjs'), 'utf8')
    expect(stats).toMatch(/queueBound\(await import\(pathToFileURL\(path\.join\(R, 'messages\.js'\)\)\.href\)\)/)
    expect(stats).toMatch(/buildLevelClears\(readFileSync\(path\.join\(R, 'game\.js'\), 'utf8'\)\)/)
    expect(stats).toMatch(/matchSays\(plates, says, ARRIVAL_BOUND \? arrivalClears\(rows\) : \[\]\)/)
    expect(stats).not.toMatch(/r\.t - s\.t < \d|QUEUE_WAIT_S|queueWaitS/)
  })
})

describe('pacing tools: what the bot counts as on screen', () => {
  // a line the queue puts up while the travel's (or a death's) black veil is down is not a plate: nobody can read it. The bot reads the
  // veil (#fade, game.js createFader) and dims whatever stacks under it, as index.html stacks the base #msg under it
  it('the veil: #fade sits over the base #msg, and the bot reads it', () => {
    const html = read('index.html')
    expect(html).toContain('<div id="fade"></div>')
    expect(Number(/^\s*#fade\s*\{[^}]*z-index:\s*(\d+)/m.exec(html)?.[1])).toBeGreaterThan(0)
    for (const m of html.matchAll(/^\s*#msg\s*\{([^}]*)\}/gm)) expect(m[1]).not.toMatch(/z-index/)
    const bot = fs.readFileSync(path.join(import.meta.dirname, '..', 'tools', 'pacing', 'bot', 'bot.js'), 'utf8')
    expect(bot).toMatch(/getElementById\('fade'\)/)
    expect(bot).toMatch(/1 - veil/)
  })
})

describe('pacing tools: the bot instruments a copy, and every anchor is still where it was', () => {
  it('game.js: the expose block and every hook that every tree has', () => {
    const { text, applied } = patchGame(read('game.js'))
    for (const h of ['expose', 'travel', 'die', 'fireEvent', 'showMessage', 'startSearch', 'machine', 'use', 'haunt']) expect(applied).toContain(h)
    expect(text).toContain('globalThis.__pt = { player,')
  })
  it('game.js: a tree with the plate budget and the teller gets their hooks too (an optional anchor must not slip away unseen)', () => {
    const g = read('game.js')
    const { applied } = patchGame(g)
    if (/createPlateBudget\(\)/.test(g)) expect(applied).toContain('plate')
    if (/dreadFrom\(ents/.test(g)) expect(applied).toContain('tell')
  })
  it('audio.js, wish-post.js, containers.js', () => {
    expect(patchAudio(read('audio.js')).wrapped).toBeGreaterThan(10)
    expect(patchWish(read('wish-post.js'))).toContain("return { ok: false, reason: 'playtest' }")
    expect(patchContainers(read('containers.js'))).toContain("globalThis.__ptEv?.('roll'")
  })
})
