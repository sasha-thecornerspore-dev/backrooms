// Fixer JP / HS-1: the sprite warm queue is module state shared by both backends, but its jobs belong to one level. A renderer created for a
// DIFFERENT level (prewarmSprites / queueLevelSprites, CPU and GPU alike) starts from a fresh queue: the old level's unbuilt tail is dropped, so the
// next background step builds a job of the new level; only jobs for sprites the new level lists too are kept, behind the new level's own list.
// The same level queued again keeps everything. (Timing only: frames are built on demand anyway, the harness shows the pictures unchanged.)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { prewarmSprites, queueLevelSprites, warmQueue, planSprites, getFrame, atlasStats, resetAtlas, FACING_FRONT } from '../src/renderer/gfx-sprites.js'
import { createSpritePlanner } from '../src/renderer/gfx-gl-sprites-plan.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { levelConfig } from '../src/renderer/levels.js'

const frozen = (fn) => { const spy = vi.spyOn(performance, 'now').mockReturnValue(0); try { return fn() } finally { spy.mockRestore() } }
const FOV = Math.PI / 2.4
const L1 = levelConfig(DEFAULT_CONFIG, 1), L2 = levelConfig(DEFAULT_CONFIG, 2)
// names level 1 can show and level 2 cannot (props, the cast, items)
const ONLY_L1 = ['pallet', 'barrel', 'couch', 'cart', 'smiler', 'watcher', 'polaroid']
const L2_NAMES = new Set(['portal', 'unread', 'read', 'lit', 'spent', ...L2.entities.stalkerVariants, ...L2.entities.wandererVariants, ...L2.props.types, ...L2.items.types])
const key = (a) => a.join('|')
const built = (a) => { const n = atlasStats().frames; getFrame(...a); return atlasStats().frames === n }   // (builds it if it was not)
// one background step: a draw call with nothing in view (a far prop beyond the fog), under a frozen clock so the step always runs
function backgroundStep(levelKey) {
  const fs = { W: 120, H: 72, HH: 36, fog: 16, fogRgb: [90, 80, 60], flicker: 1, t: 1, dt: 1 / 60, hf: FOV / 2, player: { x: 0, y: 0, angle: 0 }, opts: {}, lights: {}, comfort: {}, levelKey }
  frozen(() => planSprites(fs, [{ kind: 'prop', type: 'crate', x: 40, y: 0, rot: 1, key: 'far' }]))
}

describe('HS-1: a new level starts with a fresh warm queue', () => {
  beforeEach(() => resetAtlas())

  it('queue level 1, prewarm level 2 (a tiny cap): level 1 jobs are gone and the next background step builds a level-2 job', { timeout: 60000 }, () => {
    queueLevelSprites(L1)
    const q1 = warmQueue()
    expect(q1.some((a) => a[1] === 'pallet')).toBe(true); expect(q1.some((a) => a[1] === 'smiler')).toBe(true)
    prewarmSprites(L2, -1)                                                  // builds only the first job (the exit), queues the rest
    const q2 = warmQueue()
    expect(q2.length).toBeGreaterThan(5)
    expect(q2.filter((a) => ONLY_L1.includes(a[1]))).toEqual([])
    const head = q2[0]
    expect(L2_NAMES.has(head[1]) || head[0] === 'sight').toBe(true)
    const n = atlasStats().frames
    backgroundStep('2')
    expect(atlasStats().frames).toBe(n + 1)
    expect(built(head)).toBe(true)                                           // the step built the level-2 head job
    for (let i = 0; i < 12; i++) backgroundStep('2')
    expect(built(['creature', 'smiler', 0, 0, 0, FACING_FRONT])).toBe(false)  // no time spent on level 1's cast
  })

  it('prewarm level 1, then the GPU planner queues level 2: the same drop (the queue is shared by both backends)', () => {
    prewarmSprites(L1, -1)
    expect(warmQueue().some((a) => ONLY_L1.includes(a[1]))).toBe(true)
    createSpritePlanner({ rectFor: () => null }, { config: L2 })
    const q = warmQueue()
    expect(q.filter((a) => ONLY_L1.includes(a[1]))).toEqual([])
    expect(q.some((a) => a[1] === 'lurker')).toBe(true)
  })

  it('a sprite both levels show keeps its queued poses, behind the new level\'s own list', { timeout: 60000 }, () => {
    queueLevelSprites(L1)
    getFrame('creature', 'hound', 0, 0, 0, FACING_FRONT)                    // first sight on level 1: its other poses are queued
    const gait = [['creature', 'hound', 0, 1, 1, FACING_FRONT], ['creature', 'hound', 0, 3, 1, FACING_FRONT]]     // (not on any level list)
    for (const g of gait) expect(warmQueue().map(key)).toContain(key(g))
    queueLevelSprites(L2)
    const q = warmQueue().map(key)
    for (const g of gait) expect(q).toContain(key(g))
    const lastOwn = q.lastIndexOf(q.filter((k) => k.startsWith('sight|')).pop())
    for (const g of gait) expect(q.indexOf(key(g))).toBeGreaterThan(lastOwn)
    expect(q.filter((k) => ONLY_L1.includes(k.split('|')[1]))).toEqual([])
  })

  it('the same level queued again (both creation paths, a re-run) keeps the whole queue', () => {
    queueLevelSprites(L2)
    getFrame('creature', 'lurker', 0, 0, 0, FACING_FRONT)
    const q = warmQueue().map(key)
    prewarmSprites(L2, -1)
    createSpritePlanner({ rectFor: () => null }, { config: L2 })
    const after = warmQueue().map(key)
    for (const k of q) if (!built(k.split('|').map((v, i) => (i < 2 ? v : Number(v))))) expect(after).toContain(k)
  })

  it('a level with nothing queued before is not affected (the first level of a session)', () => {
    prewarmSprites(L1, -1)
    expect(warmQueue().some((a) => a[1] === 'smiler')).toBe(true)
  })
})
