// block-facade-plan.test.js — Level ∅ (the block): the house plan (src/renderer/block-facade-plan.js): the grouping rule and the
// seeded attributes, the heights and storeys, the pole spots and the ground.
//   * the plan's facts: every fact of the plan for six seeds, and the grouping rule over fixed and fuzzed runs, one fact per line (about
//     330 kB, not vendored): its line count and sha256 are pinned, so any change to the plan shows here
//   * the attribute table for the stock seed, the grouping rule's coherence, and the sealed doors only in vacant houses
// The digest is written as ':'-separated hex bytes, so no digit run of the game text can appear in it.
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { planBlockFacade, splitRun, HOUSE_SEED, bayStatus, houseStatus } from '../src/renderer/block-facade-plan.js'
import { NULL_MAP } from '../src/renderer/level-null-map.js'

// ── the plan's facts, one a line ──
// digest: the whole list, its two '#' header lines included; facts: the 14,542 facts alone (the lines after the headers), so the facts
// keep one fingerprint whatever the headers say, and any other copy of the same facts can be checked against it.
const PLAN_V1 = { digest: '93:bf:f7:db:2e:4f:6f:95:80:92:0b:23:f3:f0:7f:58:63:f9:aa:18:c5:0d:a8:f8:1b:54:29:4f:51:5d:9a:a8', lines: 14544,
  facts: '47:ea:29:81:38:bf:b9:a2:37:6e:d0:36:6c:5e:11:cf:ac:01:f3:3a:66:d8:f2:d8:c7:0d:4d:5c:7f:b8:17:6d', factLines: 14542 }
function planFacts() {
  const SEEDS = [HOUSE_SEED, 0, 1, 0x9E3779B9, 0xDEADBEEF, 0x7FFFFFFF]
  const fmt = (v) => v === null || v === undefined ? '-' : v === true ? '1' : v === false ? '0' : String(v)
  const lines = [
    '# the house plan, v1: planBlockFacade(NULL_MAP, seed) for six seeds, and splitRun over fixed and fuzzed runs',
    '# runs, houses, attributes; heights (m and cells); pole spots; ground. One fact per line, value last.',
  ]
  const put = (...t) => lines.push(t.map(fmt).join(' '))
  const putH = (key, h) => {
    if (h === null) { put(...key, '-'); return }
    put(...key, 'm', h.m); put(...key, 'cells', h.cells)
  }
  function emitHouse(h) {
    const k = ['house', h.id]
    put(...k, 'index', h.index); put(...k, 'run', h.run); put(...k, 'face', h.face)
    put(...k, 'bays', h.bays); put(...k, 'codes', h.codes); put(...k, 'status', h.status); put(...k, 'type', h.type)
    put(...k, 'cells', h.cells.length)
    h.cells.forEach((c, i) => { put(...k, 'cell', i, 'x', c.x); put(...k, 'cell', i, 'y', c.y); put(...k, 'cell', i, 'code', c.code) })
    put(...k, 'backStoreys', h.backStoreys); put(...k, 'cladding', h.cladding); put(...k, 'paint', h.paint)
    put(...k, 'peelPermille', h.peelPermille); put(...k, 'peel', h.peel); put(...k, 'pargeShare', h.pargeShare)
    for (const a of ['gutterMissing', 'copingSagging', 'roofless', 'ailanthus', 'vine', 'ac', 'serviceDrop', 'meter', 'dish', 'mortarStriped', 'placard']) put(...k, a, h[a])
    const t = h.heights, hk = [...k, 'h']
    put(...hk, 'storeys', t.storeys); put(...hk, 'floors', t.floors.length)
    t.floors.forEach((f, i) => putH([...hk, 'floor', i], f))
    putH([...hk, 'roof'], t.roof); putH([...hk, 'top'], t.top); put(...hk, 'topKind', t.topKind)
    put(...hk, 'behind', t.behind !== null)
    if (t.behind !== null) {
      const b = t.behind, bk = [...hk, 'behind']
      putH([...bk, 'offset'], b.offset); put(...bk, 'storeys', b.storeys); put(...bk, 'floors', b.floors.length)
      b.floors.forEach((f, i) => putH([...bk, 'floor', i], f))
      putH([...bk, 'eave'], b.eave)
    }
    putH([...hk, 'basement'], t.basement); putH([...hk, 'backEave'], t.backEave); putH([...hk, 'depth'], t.depth)
    put(...k, 'jut', h.jut !== null)
    if (h.jut !== null) {
      const j = h.jut, jk = [...k, 'jut']
      put(...jk, 'name', j.name); put(...jk, 'doorSide', j.doorSide); put(...jk, 'doorX', j.doorX)
      put(...jk, 'frontCladding', j.frontCladding); put(...jk, 'frontY', j.frontY)
      for (const [row, cells] of [['back', j.back], ['front', j.front]]) {
        put(...jk, row, cells.length)
        cells.forEach((c, i) => { put(...jk, row, i, 'x', c.x); put(...jk, row, i, 'y', c.y); put(...jk, row, i, 'code', c.code) })
      }
      j.ends.forEach((e, i) => { put(...jk, 'end', i, 'side', e.side); put(...jk, 'end', i, 'x', e.x); put(...jk, 'end', i, 'y0', e.y0); put(...jk, 'end', i, 'y1', e.y1) })
    }
  }
  let fz = 0x5A17C0DE
  const fuzz = () => { fz ^= fz << 13; fz ^= fz >>> 17; fz ^= fz << 5; return (fz >>> 0) / 4294967296 }
  const splits = ['B', 'O', 'BB', 'OC', 'BBBB', 'BBBBB', 'BBBBBBB', 'BOCB', 'OCPW', 'OCPWO', 'OCO', 'BBOCOBBB', 'FFFMMM', 'OOOMMM']
  for (let i = 0; i < 600; i++) {
    const n = 1 + Math.floor(fuzz() * 14)
    let s = ''
    for (let j = 0; j < n; j++) s += 'OCPWFBM'[Math.floor(fuzz() * 7)]
    splits.push(s)
  }
  for (const s of splits) {
    let r
    try { r = splitRun(s).join(',') } catch { r = '-' }
    lines.push(`SPLIT ${s} ${r}`)
  }
  for (const seed of SEEDS) {
    const p = planBlockFacade(NULL_MAP, seed)
    lines.push(`SEED ${p.seed}`)
    put('width', p.width); put('height', p.height)
    put('runs', p.runs.length)
    for (const r of p.runs) {
      const k = ['run', r.side]
      put(...k, 'face', r.face); put(...k, 'bays', r.cells.length); put(...k, 'codes', r.codes)
      r.cells.forEach((c, i) => { put(...k, 'cell', i, 'x', c.x); put(...k, 'cell', i, 'y', c.y); put(...k, 'cell', i, 'code', c.code) })
      put(...k, 'houses', r.houses.length)
      r.houses.forEach((id, i) => put(...k, 'house', i, id))
    }
    put('houses', p.houses.length); put('juts', p.juts.length)
    for (const h of [...p.houses, ...p.juts]) emitHouse(h)
    const G = p.ground, A = G.alley, F = G.footings, S = G.scorch
    for (const n of ['x0', 'y0', 'x1', 'y1', 'gutterX', 'curbShare']) put('ground', 'alley', n, A[n])
    putH(['ground', 'alley', 'curbReveal'], A.curbReveal)
    put('ground', 'alley', 'curbs', A.curbs.length)
    for (const c of A.curbs) {
      const ck = ['ground', 'alley', 'curb', c.edge, c.k]
      put(...ck, 'x', c.x); put(...ck, 'y0', c.y0); put(...ck, 'y1', c.y1); put(...ck, 'present', c.present)
    }
    for (const n of ['x0', 'y0', 'x1', 'y1']) put('ground', 'court', n, G.court[n])
    for (const n of ['x0', 'y0', 'x1', 'y1']) put('ground', 'footings', n, F[n])
    put('ground', 'footings', 'posts', F.posts.length)
    F.posts.forEach((q, i) => { put('ground', 'footings', 'post', i, 'x', q.x); put('ground', 'footings', 'post', i, 'y', q.y) })
    putH(['ground', 'footings', 'postMax'], F.postMax)
    for (const n of ['cellX', 'cellY', 'cx', 'cy', 'r']) put('ground', 'scorch', n, S[n])
    put('ground', 'plain', G.plain.length)
    G.plain.forEach((q, i) => { put('ground', 'plain', i, 'what', q.what); put('ground', 'plain', i, 'x', q.x); put('ground', 'plain', i, 'y', q.y) })
    put('poles', p.poles.length)
    for (const q of p.poles) {
      const k = ['pole', q.corner]
      put(...k, 'cellX', q.cellX); put(...k, 'cellY', q.cellY); put(...k, 'x', q.x); put(...k, 'y', q.y); put(...k, 'heightDm', q.heightDm)
      putH([...k, 'height'], q.height); putH([...k, 'cobra'], q.cobra); putH([...k, 'drop'], q.drop)
    }
    const count = (f) => p.houses.filter(f).length
    put('count', 'ring', p.houses.length)
    for (const [bays, name] of [[3, 'threeBay'], [2, 'twoBay'], [1, 'single']]) {
      put('count', name, count((h) => h.bays === bays))
      for (const st of ['occupied', 'vacant', 'neutral']) put('count', name, st, count((h) => h.bays === bays && h.status === st))
    }
  }
  return lines
}
const colonHex = (s) => createHash('sha256').update(s).digest('hex').match(/../g).join(':')

describe('the house plan is pinned, fact for fact', () => {
  it('its facts have the pinned line count and sha256', () => {
    const lines = planFacts()
    expect(lines.length).toBe(PLAN_V1.lines)
    expect(colonHex(lines.join('\n') + '\n')).toBe(PLAN_V1.digest)
  })
  it('its facts alone (the lines after the two headers) have the pinned line count and sha256', () => {
    const lines = planFacts()
    expect(lines.slice(0, 2).every((l) => l.startsWith('#'))).toBe(true)
    const facts = lines.slice(2)
    expect(facts.some((l) => l.startsWith('#'))).toBe(false)
    expect(facts.length).toBe(PLAN_V1.factLines)
    expect(colonHex(facts.join('\n') + '\n')).toBe(PLAN_V1.facts)
  })
  it('spot facts read as the plan says (the runs, the house counts, the grouping rule)', () => {
    const lines = new Set(planFacts())
    for (const l of ['SEED 1213202433', 'run N codes OCPWBOFCPWBOFCPWBOFCPW', 'run E codes BWPCOFBWPCOFBWPC', 'run S codes OCPWBFOCPWBFOCPWBFOCPW',
      'run W codes PCOFBWPCOFBWPCOF', 'count ring 28', 'count threeBay 22', 'count twoBay 4', 'count single 2', 'SPLIT OCPW 1,3', 'SPLIT OCO -'])
      expect(lines.has(l), l).toBe(true)
  })
})

describe('the stock plan (the attribute table)', () => {
  const p = planBlockFacade(NULL_MAP)
  const housesOf = (side) => p.runs.find((r) => r.side === side).houses.map((id) => p.houses.find((h) => h.id === id).codes)
  it('the runs split as the table says', () => {
    expect(p.seed).toBe(HOUSE_SEED)
    expect(housesOf('N')).toEqual(['O', 'CPW', 'BOF', 'CPW', 'BOF', 'CPW', 'BOF', 'CPW'])
    expect(housesOf('E')).toEqual(['BW', 'PC', 'OFB', 'WPC', 'OFB', 'WPC'])
    expect(housesOf('S')).toEqual(['O', 'CPW', 'BFO', 'CPW', 'BFO', 'CPW', 'BFO', 'CPW'])
    expect(housesOf('W')).toEqual(['PC', 'OFB', 'WPC', 'OFB', 'WPC', 'OF'])
  })
  it('28 ring houses: 22 three-bay (12 vacant, 10 occupied), 4 two-bay (3 vacant, 1 occupied), 2 corner singles, both lit', () => {
    const n = (f) => p.houses.filter(f).length
    expect(p.houses).toHaveLength(28)
    expect([n((h) => h.bays === 3), n((h) => h.bays === 3 && h.status === 'vacant'), n((h) => h.bays === 3 && h.status === 'occupied')]).toEqual([22, 12, 10])
    expect([n((h) => h.bays === 2), n((h) => h.bays === 2 && h.status === 'vacant'), n((h) => h.bays === 2 && h.status === 'occupied')]).toEqual([4, 3, 1])
    expect(p.houses.filter((h) => h.bays === 1).map((h) => h.codes)).toEqual(['O', 'O'])
  })
  it('every exposed ring cell is in exactly one house, the corners in none, and no house mixes occupied and vacant bays', () => {
    const seen = new Map()
    for (const h of p.houses) for (const c of h.cells) { const k = c.x + ',' + c.y; expect(seen.has(k), k).toBe(false); seen.set(k, h) }
    const W = NULL_MAP[0].length, H = NULL_MAP.length
    let ring = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1, corner = (x === 0 || x === W - 1) && (y === 0 || y === H - 1)
      if (edge && !corner) { ring++; expect(seen.has(x + ',' + y), `${x},${y}`).toBe(true); expect(seen.get(x + ',' + y).cells.find((c) => c.x === x && c.y === y).code).toBe(NULL_MAP[y][x]) }
      if (corner) expect(seen.has(x + ',' + y)).toBe(false)
    }
    expect(seen.size).toBe(ring)
    for (const h of p.houses) { const st = new Set(Array.from(h.codes, bayStatus)); expect(st.has('occupied') && st.has('vacant'), h.codes).toBe(false) }
  })
  it('every sealed door (C, P) is in a vacant house and every lit window (O) in an occupied one', () => {
    let doors = 0, lit = 0
    for (const h of p.houses) for (const c of h.cells) {
      if (c.code === 'C' || c.code === 'P') { doors++; expect(h.status, `${c.x},${c.y}`).toBe('vacant') }
      if (c.code === 'O') { lit++; expect(h.status, `${c.x},${c.y}`).toBe('occupied') }
    }
    expect(doors).toBe(28)
    expect(lit).toBe(13)
  })
  it('the two juts: J-west (FFF back, door bay west) and J-east (OOO back, lit, door bay east), marble fronts', () => {
    expect(p.juts.map((j) => [j.jut.name, j.codes, j.status, j.jut.doorSide, j.jut.frontCladding])).toEqual([
      ['J-west', 'FFFMMM', 'neutral', 'W', 'formstone'], ['J-east', 'OOOMMM', 'occupied', 'E', 'pressed']])
  })
  it('the vacant houses carry the placard draw, the occupied ones never', () => {
    expect(p.houses.some((h) => h.placard)).toBe(true)
    for (const h of p.houses) if (h.status !== 'vacant') expect(h.placard).toBe(false)
  })
})

describe('purity', () => {
  it('the same (map, seed) gives the same plan; the map is not touched; Math.random is never used', () => {
    const before = JSON.stringify(NULL_MAP)
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Math.random used') })
    try { expect(JSON.stringify(planBlockFacade(NULL_MAP, 7))).toBe(JSON.stringify(planBlockFacade(NULL_MAP, 7))) } finally { spy.mockRestore() }
    expect(JSON.stringify(NULL_MAP)).toBe(before)
    expect(JSON.stringify(planBlockFacade(NULL_MAP, 7))).not.toBe(JSON.stringify(planBlockFacade(NULL_MAP, 8)))
  })
  it('houseStatus refuses a mixed house; splitRun refuses a run with no valid split', () => {
    expect(() => houseStatus('OC')).toThrow()
    expect(() => splitRun('OCO')).toThrow()
    expect(houseStatus('BFM')).toBe('neutral')
  })
})
