// the pacing tools (tools/pacing, dev-only): the walker's library loads this tree and builds a floor the way game.js does, its statistics
// helpers count what RESULTS.md says they count, and the bot's instrumentation still finds every anchor in this tree's game.js (a game.js
// edit that moves one fails here, not in a three-minute Electron session). Imports nothing from Electron and writes nothing.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { loadTree, WIRING, repeats, quietStretches, preceded, gaps, moments, pathTo, queueWaitS, matchSays } from '../tools/pacing/lib.mjs'
import { patchGame, patchAudio, patchWish, patchContainers } from '../tools/pacing/bot/patch.mjs'
import * as MSG from '../src/renderer/messages.js'

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
  it('the window is the queue\'s longest wait, read off the queue itself: its discovery gap plus its hold', () => {
    expect(queueWaitS(made({ holdS: 1, discoveryGapS: 2 }))).toBeCloseTo(3, 2)
    expect(queueWaitS(made({ holdS: 3, discoveryGapS: 8 }))).toBeCloseTo(11, 2)
    // this tree's queue, as game.js builds it (no options), keeps the wait the bot measured on seed 604's L3 arrival
    expect(queueWaitS(MSG)).toBeGreaterThan(6.05)
  })
  it('seed 604, L3: the drawer\'s line that went up 6.05 s after its say, behind a held result, is still that say\'s plate', () => {
    const s = (t, text) => ({ t, text })
    const says = [s(167.67, 'a door humming with current — through it, the lobby waits again.'), s(167.85, 'empty. someone has been through here.'),
      s(167.85, 'something counts the drawers you open.')]
    const plates = [s(167.68, says[0].text), s(167.85, says[1].text), s(173.9, says[2].text)]
    expect(matchSays(plates, says, queueWaitS(MSG))).toEqual(says)
    expect(matchSays(plates, says, 6)[2]).toBeNull()                       // the old flat 6 s lost its cause
  })
  it('the latest say of its text that no earlier plate took, from the window before the plate to the log\'s frame after it', () => {
    const s = (t, text) => ({ t, text })
    const a0 = s(0, 'a'), a2 = s(2, 'a')
    expect(matchSays([s(3, 'a')], [a0, a2], 10)).toEqual([a2])                       // the latest
    expect(matchSays([s(0, 'a'), s(4, 'a')], [a0], 10)).toEqual([a0, null])         // one say puts up one plate
    expect(matchSays([s(1, 'a'), s(4, 'a')], [a2, a0], 10)).toEqual([a0, a2])       // in time order, whatever order the says come in
    expect(matchSays([s(10, 'a'), s(10.3, 'a')], [a0, s(0.2, 'a')], 10.2)).toEqual([s(0.2, 'a'), null])   // past the window: none
    expect(matchSays([s(4.9, 'c')], [s(5, 'c')], 10)).toEqual([null])                // said after it went up: not its say
    expect(matchSays([s(4.9, 'c')], [s(4.94, 'c')], 10)).toEqual([s(4.94, 'c')])     // ... but within the log's frame it is
    expect(matchSays([s(1, 'x y')], [s(0, ' x \n y ')], 10)).toEqual([s(0, ' x \n y ')])   // the text as #msg shows it
    expect(matchSays([s(1, 'b')], [a0], 10)).toEqual([null])
  })
  it('stats.mjs reads the wait off the measured tree\'s own messages.js and matches through matchSays: no flat window is left', () => {
    const stats = fs.readFileSync(path.join(import.meta.dirname, '..', 'tools', 'pacing', 'bot', 'stats.mjs'), 'utf8')
    expect(stats).toMatch(/queueWaitS\(await import\(pathToFileURL\(path\.join\(R, 'messages\.js'\)\)\.href\)\)/)
    expect(stats).toMatch(/matchSays\(plates, says, QUEUE_WAIT_S\)/)
    expect(stats).not.toMatch(/r\.t - s\.t < \d/)
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
