// the pacing tools (tools/pacing, dev-only): the walker's library loads this tree and builds a floor the way game.js does, its statistics
// helpers count what RESULTS.md says they count, and the bot's instrumentation still finds every anchor in this tree's game.js (a game.js
// edit that moves one fails here, not in a three-minute Electron session). Imports nothing from Electron and writes nothing.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { loadTree, WIRING, repeats, quietStretches, preceded, gaps, moments, pathTo } from '../tools/pacing/lib.mjs'
import { patchGame, patchAudio, patchWish, patchContainers } from '../tools/pacing/bot/patch.mjs'

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

describe('pacing tools: the bot instruments a copy, and every anchor is still where it was', () => {
  it('game.js: the expose block and every hook that every tree has', () => {
    const { text, applied } = patchGame(read('game.js'))
    for (const h of ['expose', 'travel', 'die', 'fireEvent', 'showMessage', 'startSearch', 'machine', 'use', 'haunt']) expect(applied).toContain(h)
    expect(text).toContain('globalThis.__pt = { player,')
  })
  it('audio.js, wish-post.js, containers.js', () => {
    expect(patchAudio(read('audio.js')).wrapped).toBeGreaterThan(10)
    expect(patchWish(read('wish-post.js'))).toContain("return { ok: false, reason: 'playtest' }")
    expect(patchContainers(read('containers.js'))).toContain("globalThis.__ptEv?.('roll'")
  })
})
