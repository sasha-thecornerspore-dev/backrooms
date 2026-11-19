// block-hold.test.js — a run that starts on the block before the title has built all its tiles: the screen is held dark while the rest is
// built in frame-sized slices (gfx-textures.js finishPrebuild, game.js holdForTiles), then the veil lifts once the block has drawn its first
// frames (createFader lift). gfx-block-prebuild.test.js has the job itself, block-prebuild-wiring.test.js the title's side.
//   * the same bytes: whatever the title built before the click (nothing, a little, most), the TexSet the renderer then takes is the one
//     buildTextures gives, storey bands and shared tiles included; also when the renderer takes the job in the middle of a hold
//   * the frames: slices of HOLD_SLICE_MS, one per frame, and the answer in a frame of its own (the level build never shares the last slice's)
//   * cancel and failure: the hold always ends; the renderer then builds the TexSet in one go, as before, the same bytes
//   * the look absent (levels 0-3, '∅' without it) or the tiles ready: no hold, no veil, no frame waited for
//   * the veil: raised at once, lifted the way a level change lifts it, and a newer fade owns it
//   * the wiring in initGame
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { buildTextures, buildTexturesMemo, clearTexturesMemo, prebuildTextures, cancelPrebuilds, prebuildsPending, finishPrebuild,
  nextFrame, HOLD_SLICE_MS, HOLD_NOFRAME_MS, PREBUILD_SLICE_MS } from '../src/renderer/gfx-textures.js'
import { holdForTiles, createFader, SETTLE_FRAMES } from '../src/renderer/game.js'
import { resumeLevel, applyResume } from '../src/renderer/levelmem.js'
import { levelConfig } from '../src/renderer/levels.js'
import { BLOCK, LOBBY, entryLevel } from '../src/renderer/topology.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { levelKey } from '../src/renderer/gfx-util.js'

vi.setConfig({ testTimeout: 60000 })

const CFG = levelConfig(DEFAULT_CONFIG, BLOCK)
const args = (cfg = CFG) => [cfg.palette, cfg.materials, cfg.look, levelKey(cfg)]
function digest(tex) {
  const parts = [], ids = new Map(), order = []
  const walk = (v, path) => {
    if (v == null) { parts.push(path + '=null'); return }
    if (ArrayBuffer.isView(v)) {
      parts.push(path + '=' + createHash('sha256').update(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)).digest('hex'))
      if (!ids.has(v)) ids.set(v, ids.size)
      order.push(ids.get(v))
      return
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + '[' + i + ']')); return }
    if (typeof v === 'object') { for (const k of Object.keys(v).sort()) walk(v[k], path + '.' + k); return }
    parts.push(path + '=' + String(v))
  }
  walk(tex, 'tex')
  walk(tex.wallBands, 'bands')
  return { tiles: parts, identity: order.join(','), distinct: ids.size }
}
let SYNC = null
const sync = () => (SYNC ??= digest(buildTextures(...args())))
const same = (tex) => { const a = sync(), b = digest(tex); expect(b.tiles).toEqual(a.tiles); expect(b.identity).toBe(a.identity); expect(b.distinct).toBe(a.distinct) }
const fresh = () => { cancelPrebuilds(); clearTexturesMemo() }
// frames on demand: next(fn) queues fn; frame() runs what is queued (one frame); drain() runs frames until nothing is queued
function frames() {
  const q = []
  const F = { n: 0, next: (fn) => { q.push(fn) }, get queued() { return q.length },
    frame() { const due = q.splice(0); for (const f of due) f(); F.n++ },
    drain(max = 100000) { while (q.length && F.n < max) F.frame() } }
  return F
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('the same bytes, whatever the title built before the click', () => {
  // -1: the click came before the title started a job (finishPrebuild starts it); K: the title's idle job stepped K times (2 ms slices)
  for (const K of [-1, 0, 40, 400]) {
    it(K < 0 ? 'no job yet: the hold starts one, and the renderer takes the same TexSet' : `the title's job ${K} slices in: the hold finishes it, and the renderer takes the same TexSet`, async () => {
      fresh()
      if (K >= 0) { const job = prebuildTextures(...args()); for (let i = 0; i < K; i++) job.step(2); expect(job.done).toBe(false) }
      const F = frames()
      const wait = finishPrebuild(CFG, { next: F.next })
      expect(wait).toBeInstanceOf(Promise)
      expect(prebuildsPending()).toBe(1)
      F.drain()
      expect(await wait).toBe(true)
      expect(F.n).toBeGreaterThan(2)
      const tex = buildTexturesMemo(...args())                            // what the block's renderer then calls (gfx-cpu.js, gfx-gl.js)
      expect(prebuildsPending()).toBe(0)
      same(tex)
      fresh()
    })
  }

  it('the renderer takes the job in the middle of a hold: it finishes the rest, the hold ends, the same TexSet', async () => {
    fresh()
    const F = frames()
    const wait = finishPrebuild(CFG, { next: F.next, sliceMs: 5 })
    for (let i = 0; i < 6; i++) F.frame()
    const tex = buildTexturesMemo(...args())
    F.drain()
    expect(await wait).toBe(true)
    same(tex)
    fresh()
  })

  it('the title\'s idle slices may step the same job between the hold\'s slices: the same TexSet', async () => {
    fresh()
    const job = prebuildTextures(...args())
    const F = frames()
    const wait = finishPrebuild(CFG, { next: F.next, sliceMs: 20 })
    while (F.queued) { F.frame(); if (!job.done) job.step(PREBUILD_SLICE_MS) }   // an idle slice after every frame of the hold
    expect(await wait).toBe(true)
    same(buildTexturesMemo(...args()))
    fresh()
  })
})

describe('the frames', () => {
  it('one slice of HOLD_SLICE_MS per frame (bigger than the title\'s), and the answer only in the frame after the last slice', async () => {
    expect(HOLD_SLICE_MS).toBeGreaterThan(PREBUILD_SLICE_MS)
    expect(HOLD_SLICE_MS).toBeLessThanOrEqual(80)                       // far under the 200 ms a frame may take, with the slice's overrun
    fresh()
    const job = prebuildTextures(...args())
    const F = frames()
    const step = vi.spyOn(job, 'step')
    let answered = false
    const wait = finishPrebuild(CFG, { next: F.next }).then((v) => { answered = true; return v })
    expect(step).not.toHaveBeenCalled()                                   // nothing in the click's own task
    F.frame()
    expect(step).toHaveBeenCalledTimes(1)
    expect(step).toHaveBeenLastCalledWith(HOLD_SLICE_MS)
    F.frame()
    expect(step).toHaveBeenCalledTimes(2)
    while (!job.done) F.frame()                                           // the frame whose slice finished the job
    await flush()
    expect(answered).toBe(false)                                          // ... does not answer: the level build gets a frame of its own
    expect(F.queued).toBe(1)
    F.frame(); await flush()
    expect(answered).toBe(true)
    expect(await wait).toBe(true)
    expect(step.mock.calls.length).toBe(job.slices)
    fresh()
  })
})

describe('frames, or none', () => {
  it('nextFrame: the callback once, at the next animation frame, or after HOLD_NOFRAME_MS when no frame comes (a hidden window draws none)', () => {
    vi.useFakeTimers()
    const rafs = []
    vi.stubGlobal('requestAnimationFrame', (f) => { rafs.push(f); return rafs.length })
    try {
      const a = vi.fn(), b = vi.fn()
      nextFrame(a)
      expect(a).not.toHaveBeenCalled()
      rafs.shift()()                                                      // the frame comes: it runs there ...
      expect(a).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(HOLD_NOFRAME_MS * 2)                         // ... and only there
      expect(a).toHaveBeenCalledTimes(1)
      nextFrame(b)
      vi.advanceTimersByTime(HOLD_NOFRAME_MS - 1)
      expect(b).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)                                           // no frame: it runs anyway ...
      expect(b).toHaveBeenCalledTimes(1)
      rafs.splice(0).forEach((f) => f())                                  // ... and the late frame does not run it again
      expect(b).toHaveBeenCalledTimes(1)
      expect(HOLD_NOFRAME_MS).toBeGreaterThanOrEqual(50)
      expect(HOLD_NOFRAME_MS).toBeLessThanOrEqual(250)
    } finally { vi.unstubAllGlobals(); vi.useRealTimers() }
  })
  it('the default next with no animation frames at all (Node): the hold still ends, the same TexSet', async () => {
    fresh()
    expect(typeof globalThis.requestAnimationFrame).toBe('undefined')
    const wait = finishPrebuild(CFG)
    expect(await wait).toBe(true)
    same(buildTexturesMemo(...args()))
    fresh()
  })
})

describe('cancel and failure: the hold always ends, and the renderer then builds the same TexSet in one go', () => {
  it('cancelled during the hold (cancelPrebuilds): false, the job dropped, the memo builds afresh', async () => {
    fresh()
    const F = frames()
    const wait = finishPrebuild(CFG, { next: F.next, sliceMs: 5 })
    F.frame(); F.frame()
    cancelPrebuilds()
    F.drain()
    expect(await wait).toBe(false)
    expect(prebuildsPending()).toBe(0)
    same(buildTexturesMemo(...args()))
    fresh()
  })

  it('a slice that fails (the job drops itself): false, and the memo builds afresh', async () => {
    fresh()
    const job = prebuildTextures(...args())
    job.step(2)
    job.step = () => { job.cancel(); job.error = new Error('a slice failed'); return true }   // what step does when its slice throws
    const F = frames()
    const wait = finishPrebuild(CFG, { next: F.next })
    F.drain()
    expect(await wait).toBe(false)
    expect(prebuildsPending()).toBe(0)
    same(buildTexturesMemo(...args()))
    fresh()
  })

  it('a step that throws, or a frame that cannot be asked for: the hold ends (false); the renderer finishes the job, the same TexSet', async () => {
    fresh()
    const job = prebuildTextures(...args())
    const realStep = job.step
    job.step = () => { throw new Error('boom') }
    const F = frames()
    const a = finishPrebuild(CFG, { next: F.next })
    F.drain()
    expect(await a).toBe(false)
    job.step = realStep
    const b = finishPrebuild(CFG, { next: () => { throw new Error('no frames here') } })
    expect(await b).toBe(false)
    expect(prebuildsPending()).toBe(1)                                    // the job is still there: the renderer takes it and builds the rest
    same(buildTexturesMemo(...args()))
    fresh()
  })

  it('holdForTiles drops a job built for another config (world.json changed after the title started it): it would never be taken', async () => {
    fresh()
    const drifted = { ...CFG, materials: { ...CFG.materials, B: '#7A4A3A' } }
    const stale = prebuildTextures(...args(drifted))
    stale.step(2)
    const F = frames()
    const p = holdForTiles(CFG, null, { next: F.next })
    expect(stale.cancelled).toBe(true)                                    // dropped at once, before any frame
    F.drain()
    await p
    expect(prebuildsPending()).toBe(1)                                    // only the run's own job, done, for the renderer to take
    same(buildTexturesMemo(...args()))
    expect(prebuildsPending()).toBe(0)
    fresh()
  })

  it('holdForTiles: a hold that fails still returns, with the veil up for initGame to lift', async () => {
    fresh()
    const veil = { style: { opacity: '0', transition: '' } }
    const r = await holdForTiles(CFG, veil, { next: () => { throw new Error('no frames here') } })
    expect(r).toBe(true)
    expect(veil.style.opacity).toBe('1')
    fresh()
  })
})

describe('no hold where there is nothing to wait for', () => {
  it('without the look (levels 0-3, the lobby, \'∅\' without it): no job, no frame asked for, the veil untouched', async () => {
    fresh()
    const next = vi.fn()
    const cfgs = [{ ...CFG, look: null }, { ...CFG, look: { floor: 'yard' } }, ...[0, 1, 2, 3].map((i) => levelConfig(DEFAULT_CONFIG, i)), levelConfig(DEFAULT_CONFIG, LOBBY)]
    for (const cfg of cfgs) {
      expect(finishPrebuild(cfg, { next })).toBeNull()
      const veil = { style: { opacity: '0', transition: '' } }
      expect(await holdForTiles(cfg, veil, { next })).toBe(false)
      expect(veil.style).toEqual({ opacity: '0', transition: '' })
    }
    expect(finishPrebuild(null, { next })).toBeNull()
    expect(next).not.toHaveBeenCalled()
    expect(prebuildsPending()).toBe(0)
  })

  it('the tiles ready (the title\'s job done, or the memo holding them): no hold, no veil', async () => {
    fresh()
    const job = prebuildTextures(...args())
    while (!job.step(50)) { /* the title finished it */ }
    const next = vi.fn(), veil = { style: { opacity: '0', transition: '' } }
    expect(finishPrebuild(CFG, { next })).toBeNull()
    expect(await holdForTiles(CFG, veil, { next })).toBe(false)
    buildTexturesMemo(...args())                                          // the renderer took it: now the memo holds it
    expect(await holdForTiles(CFG, veil, { next })).toBe(false)
    expect(next).not.toHaveBeenCalled()
    expect(veil.style.opacity).toBe('0')
    fresh()
  })
})

describe('the veil', () => {
  it('holdForTiles raises it at once (no fade: the title is already gone), keeps it up until the tiles are done, and says so', async () => {
    fresh()
    const F = frames(), veil = { style: { opacity: '0', transition: 'opacity 0.55s' } }
    let done = null
    const p = holdForTiles(CFG, veil, { next: F.next }).then((v) => { done = v })
    expect(veil.style.opacity).toBe('1')
    expect(veil.style.transition).toBe('none')
    F.frame(); F.frame(); await flush()
    expect(done).toBe(null)
    F.drain(); await p
    expect(done).toBe(true)
    expect(veil.style.opacity).toBe('1')                                  // lifting it is initGame's (createFader lift), after the level is up
    expect(buildTexturesMemo(...args())).toBeTruthy()
    fresh()
  })

  it('without a #fade element it still waits for the tiles (and there is nothing to lift)', async () => {
    fresh()
    const F = frames()
    const p = holdForTiles(CFG, null, { next: F.next })
    F.drain()
    expect(await p).toBe(false)
    expect(prebuildsPending()).toBe(1)
    fresh()
  })

  // the fader as gfx-jc-game.test.js drives it: timeouts on a fake clock, raf callbacks run when a frame is drawn
  function sim() {
    let t = 0, n = 0, timers = [], rafs = []
    const el = { style: { opacity: '1', transition: 'none' } }               // up: holdForTiles raised it
    return {
      el, get t() { return t },
      deps: { el, frames: () => n, now: () => t, setTimeout: (f, ms) => { timers.push({ at: t + ms, f }) }, raf: (f) => { rafs.push(f) } },
      frame(ms = 16) { t += ms; const due = timers.filter((x) => x.at <= t); timers = timers.filter((x) => x.at > t); for (const x of due) x.f(); n++; const q = rafs; rafs = []; for (const f of q) f() },
      wait(ms) { t += ms; const due = timers.filter((x) => x.at <= t); timers = timers.filter((x) => x.at > t); for (const x of due) x.f() },
    }
  }
  it('lift: the veil fades out once the block has drawn SETTLE_FRAMES frames, the way a level change lifts it', () => {
    const s = sim(), f = createFader(s.deps)
    let shown = 0
    f.lift(() => { shown++ })
    expect(s.el.style.transition).toBe('opacity 0.55s')
    const seen = []
    for (let i = 0; i < SETTLE_FRAMES + 3; i++) { s.frame(); seen.push(s.el.style.opacity) }
    expect(seen.indexOf('0') + 1).toBe(SETTLE_FRAMES)
    s.wait(1000)
    expect(shown).toBe(1)
  })
  it('lift is sequenced like run: a fade that starts before the lift (a death in the first frames) owns the veil', () => {
    const s = sim(), f = createFader(s.deps)
    const log = []
    f.lift(() => log.push('arrival shown'))
    s.frame(); s.frame()
    f.run(() => log.push('respawn'), () => log.push('respawn shown'))
    const seen = []
    for (let i = 0; i < 200; i++) { s.frame(20); seen.push(s.el.style.opacity) }
    expect(log).toEqual(['respawn', 'respawn shown'])                   // the arrival's lift never lifted the respawn's veil, nor ended it
    expect(s.el.style.opacity).toBe('0')
  })
  it('without a #fade element, lift only ends the arrival', () => {
    const s = sim(), f = createFader({ ...s.deps, el: null })
    let shown = 0
    f.lift(() => { shown++ })
    s.wait(1000)
    expect(shown).toBe(1)
  })
})

describe('the wiring', () => {
  const game = readFileSync(new URL('../src/renderer/game.js', import.meta.url), 'utf8')
  it('initGame holds a start on the block, fresh (the front door) or resumed (CONTINUE), before anything of the game is made, and lifts the veil once the loop runs', () => {
    expect(game).toMatch(/const base = await loadConfig\(\)\r?\n\s*runStarted = true[^\n]*\r?\n(\s*\/\/[^\n]*\r?\n)*\s*const heldDark = \(resume \? resumeLevel\(resume\) : entryLevel\(\{ online: !!mpClient, frontDoor \}\)\) === BLOCK\r?\n\s*&& await holdForTiles\(levelConfig\(base, BLOCK\), typeof document !== 'undefined' \? document\.getElementById\('fade'\) : null\)/)
    // the boot builds the very level that was held for (applyResume reads resumeLevel; a fresh start builds entryLevel(...))
    expect(game).toContain('buildLevel(entryLevel({ online: !!mpClient, frontDoor }))')
    expect(game).toMatch(/\n  requestAnimationFrame\(loop\)\r?\n  if \(heldDark\) fader\.lift\(\)/)
    expect(game.indexOf('const heldDark')).toBeLessThan(game.indexOf('initAudio(base)'))   // nothing (no audio, no listener) before the hold
  })
  it('resumeLevel is the floor applyResume builds; the front door\'s is the block, every other way in is not', () => {
    const built = []
    const deps = { mem: { import() {}, get: () => null }, buildLevel: (l) => built.push(l), applyPlayer: () => ({ x: 0, y: 0 }), updateAt() {}, settlePlayer() {} }
    for (const save of [{ level: BLOCK }, { level: 2 }, {}, null, { level: 0 }]) {
      built.length = 0
      applyResume(save, deps)
      expect(built).toEqual([resumeLevel(save)])
    }
    expect(resumeLevel({ level: BLOCK })).toBe(BLOCK)
    expect(resumeLevel(null)).toBe(0)
    expect(entryLevel({ frontDoor: true })).toBe(BLOCK)
    expect(entryLevel({ frontDoor: true, online: true })).not.toBe(BLOCK)
    expect(entryLevel({})).not.toBe(BLOCK)
  })
  it('the block\'s config the hold builds for is the one buildLevel builds, so the renderer\'s memo key is the job\'s', () => {
    expect(game).toMatch(/function buildLevel\(index, at = null\) \{[\s\S]{0,400}const cfg\s+= levelConfig\(base, index\)/)
    expect(game).toContain("import { finishPrebuild } from './gfx-textures.js'")
  })
})
