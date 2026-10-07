// save-shape — the resume order (levelmem.applyResume): memory + clock + deaths before buildLevel, buildLevel at the remembered arrival chunk,
// then the player fields, the decor / item scan at the resumed chunk, the dispelled list, the fog, and the settle. A v:1 save missing
// every new field loads to today's behaviour.
import { describe, it, expect } from 'vitest'
import { createLevelMemory, applyResume } from '../src/renderer/levelmem.js'
import { CHUNK_SIZE } from '../src/renderer/world.js'

function fakeDeps(over = {}) {
  const calls = []
  const mem = createLevelMemory()
  const imp = mem.import
  mem.import = (o) => { calls.push(['mem.import', o]); return imp(o) }
  const deps = {
    mem,
    buildLevel: (level, at) => calls.push(['buildLevel', level, at]),
    applyPlayer: (r) => { calls.push(['applyPlayer', r]); return { x: r.x ?? 11.5, y: r.y ?? 11.5 } },
    updateAt: (pcx, pcy) => calls.push(['updateAt', pcx, pcy]),
    restoreDispelled: (list, now) => calls.push(['restoreDispelled', list, now]),
    fogImport: (fog) => calls.push(['fogImport', fog]),
    settlePlayer: () => calls.push(['settlePlayer']),
    ...over,
  }
  return { calls, mem, deps }
}
const V1 = { v: 1, level: 2, x: 30.5, y: 40.5, angle: 1, hp: 80, maxHp: 100, inventory: [{ type: 'radio', on: true }], selected: 0, pagesRead: [1], worldSeed: null, anchor: null }

describe('applyResume', () => {
  it('a v:1 save lacking memory / playT / deaths / dispelled / fog yields fresh memory, playT 0, deaths 0 and no spawn override', () => {
    const { calls, mem, deps } = fakeDeps()
    const r = applyResume(V1, deps)
    expect(r).toEqual({ level: 2, spawnChunk: null, playT: 0, deaths: 0, pcx: 1, pcy: 1 })
    expect(mem.export()).toEqual({})
    expect(calls.map((c) => c[0])).toEqual(['mem.import', 'buildLevel', 'applyPlayer', 'updateAt', 'restoreDispelled', 'fogImport', 'settlePlayer'])
    expect(calls[1]).toEqual(['buildLevel', 2, null])
    expect(calls[2][1]).toBe(V1)
    expect(calls[3]).toEqual(['updateAt', Math.floor(30.5 / CHUNK_SIZE), Math.floor(40.5 / CHUNK_SIZE)])
    expect(calls[4]).toEqual(['restoreDispelled', [], 0])
    expect(calls[5]).toEqual(['fogImport', undefined])
  })

  it('a save with memory restores takenFor / searchedFor / droppedFor and spawns at the arrived chunk; playT and deaths come back', () => {
    const { calls, mem, deps } = fakeDeps()
    const save = {
      ...V1,
      memory: {
        2: { x: 30.5, y: 40.5, angle: 1, cx: 1, cy: 1, visits: 2, lastT: 90, arrived: { cx: 4, cy: -1 }, taken: ['1,1:0', '2,2:0'], vended: [['3,3', 50, 1]], searched: ['c:9'], dropped: [{ x: 5, y: 6, type: 'glowstick', t0: 3 }] },
        0: { x: null, y: null, angle: 0, cx: 0, cy: 0, visits: 1, lastT: 0, arrived: { cx: 0, cy: 0 }, taken: [], vended: [], searched: [], dropped: [] },
      },
      playT: 123.5, deaths: 2, dispelled: [[1, 2, 30]], fog: { map: 'x' },
    }
    const r = applyResume(save, deps)
    expect(r).toEqual({ level: 2, spawnChunk: { cx: 4, cy: -1 }, playT: 123.5, deaths: 2, pcx: 1, pcy: 1 })
    expect(mem.takenFor(2)).toEqual(new Set(['1,1:0', '2,2:0']))
    expect(mem.searchedFor(2)).toEqual(new Set(['c:9']))
    expect(mem.droppedFor(2)).toEqual([{ x: 5, y: 6, type: 'glowstick', t0: 3 }])
    expect(mem.vendedFor(2, 123.5)).toEqual(new Set(['3,3']))
    expect(mem.get(0).visits).toBe(1)
    expect(calls.map((c) => c[0])).toEqual(['mem.import', 'buildLevel', 'applyPlayer', 'updateAt', 'restoreDispelled', 'fogImport', 'settlePlayer'])
    expect(calls[0][1]).toBe(save.memory)
    expect(calls[1]).toEqual(['buildLevel', 2, { cx: 4, cy: -1 }])
    expect(calls[4]).toEqual(['restoreDispelled', [[1, 2, 30]], 0])
    expect(calls[5]).toEqual(['fogImport', { map: 'x' }])
  })

  it('garbage clocks and counts fall back; a missing level is the lobby; the resumed chunk follows the applied player', () => {
    const { calls, deps } = fakeDeps({ applyPlayer: (r) => { calls.push(['applyPlayer', r]); return { x: -0.5, y: 100 } } })
    const r = applyResume({ playT: 'soon', deaths: -3, dispelled: 'no', memory: 'junk' }, deps)
    expect(r).toEqual({ level: 0, spawnChunk: null, playT: 0, deaths: 0, pcx: -1, pcy: 4 })
    expect(calls.find((c) => c[0] === 'updateAt')).toEqual(['updateAt', -1, 4])
    expect(calls.find((c) => c[0] === 'restoreDispelled')).toEqual(['restoreDispelled', [], 0])
    expect(applyResume(null, fakeDeps().deps)).toEqual({ level: 0, spawnChunk: null, playT: 0, deaths: 0, pcx: 0, pcy: 0 })
  })

  it('deps that a later integration step provides (restoreDispelled, fogImport) may be absent', () => {
    const { calls, deps } = fakeDeps({ restoreDispelled: undefined, fogImport: undefined })
    expect(() => applyResume(V1, deps)).not.toThrow()
    expect(calls.map((c) => c[0])).toEqual(['mem.import', 'buildLevel', 'applyPlayer', 'updateAt', 'settlePlayer'])
  })
})
