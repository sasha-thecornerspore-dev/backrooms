// Track HC: the first-frame validation draws each side until its picture stops changing (settleFrame), because both renderers build sprite frames
// lazily under a per-call time budget: on a cold or busy device the first synthetic frame could lack a sprite and fail a healthy GPU for a day.
// (Found on the real Intel Iris Plus: the Level ∅ spawn failed with a worst block of 0.125 — the note's glow missing from the CPU reference.)
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { settleFrame, SETTLE_TRIES } from '../src/renderer/gfx-gl-g4-validate.js'

const frames = (...list) => { let i = 0; return () => ({ data: Uint8Array.from(list[Math.min(i++, list.length - 1)]), w: 1, h: 1 }) }

describe('settleFrame', () => {
  it('stops at the first draw that repeats the previous one', () => {
    const r = settleFrame(frames([1, 2], [3, 4], [3, 4], [9, 9]))
    expect(r).toMatchObject({ draws: 3, stable: true }); expect([...r.frame.data]).toEqual([3, 4])
    expect(settleFrame(frames([5], [5])).draws).toBe(2)
  })
  it('gives up after `tries` draws with the last picture (never loops forever on a frame that keeps changing)', () => {
    let n = 0
    const r = settleFrame(() => ({ data: Uint8Array.of(n++) }), 4)
    expect(r).toMatchObject({ draws: 4, stable: false }); expect(r.frame.data[0]).toBe(3)
    expect(SETTLE_TRIES).toBeGreaterThanOrEqual(3); expect(SETTLE_TRIES).toBeLessThanOrEqual(8)
  })
  it('copes with a reused read buffer (gl.readPixels into the same array every time)', () => {
    const buf = new Uint8Array(2); let n = 0
    const seq = [[1, 1], [2, 2], [2, 2]]
    const r = settleFrame(() => { buf.set(seq[Math.min(n++, 2)]); return { data: buf } })
    expect(r.draws).toBe(3); expect(r.stable).toBe(true)
  })
})

describe('gfx-gl.js settles both sides', () => {
  const gl = fs.readFileSync(new URL('../src/renderer/gfx-gl.js', import.meta.url), 'utf8')
  it('the CPU reference and the GPU readback both go through settleFrame', () => {
    expect(gl.match(/settleFrame\(/g).length).toBe(2)
    expect(gl).toMatch(/validationDraws/)
  })
})
