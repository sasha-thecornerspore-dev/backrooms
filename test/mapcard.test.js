// mapcard.js — the pencil drawing of the fog map and the thin DOM card that holds it (held, not modal).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { GLYPHS, drawMap, createMapCard, fitView, FIT_PITCHES } from '../src/renderer/mapcard.js'
import { createFogMap, buildMapView } from '../src/renderer/fogmap.js'
import { WAY_KINDS } from '../src/renderer/topology.js'

const open = () => true
const at = (x, y, angle = 0) => ({ x, y, angle })

// a context that records every call the drawer may make
function recorder() {
  const calls = []
  const rec = (name) => (...args) => { calls.push([name, ...args]) }
  const ctx = { calls }
  for (const m of ['fillRect', 'fillText', 'save', 'restore', 'translate', 'rotate', 'beginPath', 'moveTo', 'lineTo', 'fill']) ctx[m] = rec(m)
  ctx.count = (name) => calls.filter((c) => c[0] === name).length
  // the alpha each glyph was drawn with: [text, x, y, alpha]
  let alpha = 1
  Object.defineProperty(ctx, 'globalAlpha', { get: () => alpha, set: (v) => { alpha = v } })
  ctx.glyphs = []
  const fillText = ctx.fillText
  ctx.fillText = (text, x, y) => { ctx.glyphs.push([text, x, y, alpha]); fillText(text, x, y) }
  return ctx
}

function fogWithPins() {
  const fog = createFogMap()
  fog.step(0, 50.5, 50.5, 2, open)                                 // 25 cells
  fog.pinWay(0, { key: '2,2', kind: 'down', x: 53.5, y: 50.5, target: 1, label: 'descend' })
  fog.pinWay(0, { key: '2,2:up', kind: 'up', x: 47.5, y: 50.5, target: 0, label: 'stairwell up' })
  fog.pinThing(0, 'm', 'machine', 50.5, 47.5, false)
  fog.pinThing(0, 'n', 'note', 50.5, 53.5, true)
  fog.pinThing(0, 'arrived:0', 'arrived', 48.5, 48.5)
  return fog
}

describe('GLYPHS', () => {
  it('covers every WAY_KINDS entry and the things', () => {
    for (const k of WAY_KINDS) expect(typeof GLYPHS[k]).toBe('string')
    expect(GLYPHS).toEqual({ down: '▽', up: '△', lift: '◇', ring: '▽', machine: '⊟', sight: '✶', note: '¶', arrived: '○', hurt: '×' })
  })
})

describe('drawMap', () => {
  it('issues exactly one fillRect per walked cell, one fillText per pin and one player path', () => {
    const fog = fogWithPins()
    const view = buildMapView(fog, 0, at(50.5, 50.5, 0.7), { cells: 56 })
    const ctx = recorder()
    drawMap(ctx, view, {})
    expect(ctx.count('fillRect')).toBe(25)
    expect(ctx.count('fillText')).toBe(5)
    expect(ctx.count('beginPath')).toBe(1)
    expect(ctx.count('moveTo')).toBe(1)
    expect(ctx.count('lineTo')).toBe(2)
    expect(ctx.count('fill')).toBe(1)
    expect(ctx.count('rotate')).toBe(1)
    expect(ctx.calls.find((c) => c[0] === 'rotate')[1]).toBeCloseTo(0.7, 9)
    expect(ctx.count('save')).toBe(ctx.count('restore'))
    const glyphs = ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1])
    expect(glyphs.sort()).toEqual(['△', '○', '¶', '▽', '⊟'].sort())
  })

  it('draws a 7x7 ink rect per cell with a deterministic jitter of at most 0.6 px', () => {
    const fog = createFogMap()
    fog.step(0, 10.5, 10.5, 1, open)
    const view = buildMapView(fog, 0, at(10.5, 10.5), { cells: 56 })
    const a = recorder(), b = recorder()
    drawMap(a, view, { pitch: 8 }); drawMap(b, view, { pitch: 8 })
    const ra = a.calls.filter((c) => c[0] === 'fillRect'), rb = b.calls.filter((c) => c[0] === 'fillRect')
    expect(ra).toEqual(rb)                                           // the pencil hand is deterministic
    let jittered = 0
    for (let i = 0; i < ra.length; i++) {
      const [, x, y, w, h] = ra[i]
      expect(w).toBe(7); expect(h).toBe(7)
      const dx = view.cells[2 * i], dy = view.cells[2 * i + 1]
      expect(Math.abs(x - dx * 8)).toBeLessThanOrEqual(0.6 + 1e-9)
      expect(Math.abs(y - dy * 8)).toBeLessThanOrEqual(0.6 + 1e-9)
      if (x !== dx * 8 || y !== dy * 8) jittered++
    }
    expect(jittered).toBeGreaterThan(0)
  })

  it('draws lost pins hollow, a vended machine struck through, and faded chunks dim with fresh cells over them', () => {
    const fog = createFogMap()
    let epoch = 0
    const epochOf = () => epoch
    fog.step(0, 5.5, 5.5, 1, open, epochOf)
    fog.pinWay(0, { key: '0,0', kind: 'down', x: 5.5, y: 5.5, target: 1, label: 'descend' })
    fog.pinThing(0, 'm', 'machine', 7.5, 7.5, true)
    epoch = 1
    fog.step(0, 5.5, 9.5, 1, open, epochOf)
    fog.markLost(0, '0,0')
    const view = buildMapView(fog, 0, at(5.5, 9.5), { cells: 56 })
    const ctx = recorder()
    drawMap(ctx, view, {})
    const texts = ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1])
    expect(texts).toContain('◌')                                     // hollow: the hole is not where you drew it
    expect(texts).not.toContain('▽')
    expect(texts).toContain('⊠')                                     // struck through once vended
    expect(ctx.count('fillRect')).toBe(view.n + view.nFresh)          // dim strokes, then the fresh ones over them
  })

  it('a stale pin (its chunk faded under it) stays on the map, faded like a lost one; a pin in a live chunk draws full', () => {
    const fog = createFogMap()
    let epoch = 0
    const epochOf = () => epoch
    fog.step(0, 5.5, 5.5, 1, open, epochOf)
    fog.pinWay(0, { key: '0,0', kind: 'down', x: 5.5, y: 5.5, target: 1, label: 'descend' })      // the chunk that will fade
    fog.pinThing(0, 'm', 'machine', 7.5, 7.5, false)                                              // same chunk
    fog.pinWay(0, { key: '1,0', kind: 'down', x: 25.5, y: 5.5, target: 1, label: 'descend' })     // a live chunk, never walked
    fog.pinThing(0, 'n', 'note', 26.5, 5.5, true)
    fog.pinThing(0, 'u', 'note', 27.5, 5.5, false)                                                 // unread: faint until read
    epoch = 1
    fog.step(0, 5.5, 9.5, 1, open, epochOf)
    const view = buildMapView(fog, 0, at(5.5, 9.5), { cells: 56 })
    expect(view.faded.has('0,0')).toBe(true); expect(view.faded.has('1,0')).toBe(false)
    const ctx = recorder()
    drawMap(ctx, view, {})
    const alphaAt = (wx, wy) => ctx.glyphs.find((g) => g[1] === (Math.floor(wx) - view.ox) * 8 + 4 && g[2] === (Math.floor(wy) - view.oy) * 8 + 4)
    expect(alphaAt(5.5, 5.5)).toEqual(['▽', expect.any(Number), expect.any(Number), 0.5])     // stale: still drawn, not hollow, faded
    expect(alphaAt(7.5, 7.5)[3]).toBe(0.5)
    expect(alphaAt(25.5, 5.5)).toEqual(['▽', expect.any(Number), expect.any(Number), 0.9])
    expect(alphaAt(26.5, 5.5)[3]).toBe(0.9)
    expect(alphaAt(27.5, 5.5)[3]).toBe(0.5)
    fog.markLost(0, '0,0')
    const ctx2 = recorder()
    drawMap(ctx2, buildMapView(fog, 0, at(5.5, 9.5), { cells: 56 }), {})
    expect(ctx2.glyphs.find((g) => g[0] === '◌')[3]).toBe(0.5)                                  // lost: hollow, and faded
  })

  it('layers: cells draws no arrow, player draws only the arrow', () => {
    const fog = fogWithPins()
    const view = buildMapView(fog, 0, at(50.5, 50.5), { cells: 56 })
    const c = recorder(), p = recorder()
    drawMap(c, view, { layer: 'cells' })
    drawMap(p, view, { layer: 'player' })
    expect(c.count('fillRect')).toBe(25); expect(c.count('fillText')).toBe(5); expect(c.count('beginPath')).toBe(0)
    expect(p.count('fillRect')).toBe(0); expect(p.count('fillText')).toBe(0); expect(p.count('beginPath')).toBe(1)
  })
})

describe('fitView — the pencil zooms to what you have drawn', () => {
  const SIZE = 448

  it('a short walk is drawn large and centred on the sheet, not as a smudge in the middle', () => {
    const fog = createFogMap()
    fog.step(0, 50.5, 50.5, 2, open)                                 // a 5x5 patch
    const view = buildMapView(fog, 0, at(50.5, 50.5), { cells: 56 })
    const f = fitView(view, SIZE)
    expect(f.pitch).toBe(28)                                          // (5 + 2*FIT_MARGIN) * 28 = 252 <= 448
    expect(f.ink).toBe(27)
    const ctx = recorder()
    drawMap(ctx, view, f)
    const rects = ctx.calls.filter((c) => c[0] === 'fillRect')
    const xs = rects.map((r) => r[1]), ys = rects.map((r) => r[2])
    const cx = (Math.min(...xs) + Math.max(...xs) + f.ink) / 2, cy = (Math.min(...ys) + Math.max(...ys) + f.ink) / 2
    expect(Math.abs(cx - SIZE / 2)).toBeLessThan(2)                   // centred
    expect(Math.abs(cy - SIZE / 2)).toBeLessThan(2)
    expect(Math.max(...xs) - Math.min(...xs) + f.ink).toBeGreaterThan(SIZE / 4)   // a real part of the sheet (5 cells at the 28 px cap = 140 px; was 39 px)
    for (const [, x, y, w, h] of rects) {                             // nothing falls off the paper
      expect(x).toBeGreaterThanOrEqual(-1); expect(y).toBeGreaterThanOrEqual(-1)
      expect(x + w).toBeLessThanOrEqual(SIZE + 1); expect(y + h).toBeLessThanOrEqual(SIZE + 1)
    }
  })

  it('pins and the player widen the bounds; the glyphs and the arrow grow with the pitch', () => {
    const fog = fogWithPins()                                        // cells 48..52, pins out to 47..53
    const view = buildMapView(fog, 0, at(50.5, 50.5), { cells: 56 })
    const f = fitView(view, SIZE)
    expect(f.pitch).toBe(28)                                          // (7 + 4) * 28 = 308 <= 448
    const ctx = recorder()
    let font = null
    Object.defineProperty(ctx, 'font', { get: () => font, set: (v) => { font = v } })
    drawMap(ctx, view, f)
    expect(font).toBe(`${Math.round(11 * 28 / 8)}px monospace`)
    for (const [, x, y] of ctx.glyphs) { expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(SIZE); expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(SIZE) }
    expect(ctx.calls.find((c) => c[0] === 'moveTo')[1]).toBeCloseTo(5.5 * 28 / 8, 9)
  })

  it('steps down as the drawing grows, and a full window keeps the unzoomed layout exactly', () => {
    const small = createFogMap(); small.step(0, 50.5, 50.5, 2, open)
    const mid = createFogMap()
    for (let x = 38.5; x <= 62.5; x += 1) mid.step(0, x, 50.5, 1, open)   // a hall 27 cells long (the flood reaches one past each end)
    const big = createFogMap()
    for (let x = 10.5; x <= 90.5; x += 1) big.step(0, x, 50.5, 1, open)   // wider than the 56-cell window
    const p = (fog) => fitView(buildMapView(fog, 0, at(50.5, 50.5), { cells: 56 }), SIZE).pitch
    expect(p(small)).toBe(28)
    expect(p(mid)).toBe(14)                                           // (27 + 2*2) * 14 = 434 <= 448 < 31 * 16
    const fBig = fitView(buildMapView(big, 0, at(50.5, 50.5), { cells: 56 }), SIZE)
    expect(fBig).toEqual({ pitch: 8, ink: 7, tx: 0, ty: 0 })
  })

  it('reuses the out object', () => {
    const fog = createFogMap(); fog.step(0, 5.5, 5.5, 1, open)
    const out = { pitch: 0, ink: 0, tx: 0, ty: 0 }
    expect(fitView(buildMapView(fog, 0, at(5.5, 5.5), { cells: 56 }), SIZE, out)).toBe(out)
  })

  it('FIT_PITCHES descends to the base pitch', () => {
    expect([...FIT_PITCHES].sort((a, b) => b - a)).toEqual([...FIT_PITCHES])
    expect(FIT_PITCHES[FIT_PITCHES.length - 1]).toBe(8)
  })
})

// a document with just enough DOM for the card
function fakeDoc(withCard = true) {
  const els = {}
  const el = (id) => {
    const ctx = recorder()
    ctx.clearRect = () => {}; ctx.drawImage = () => {}
    const e = { id, style: {}, textContent: '', listeners: {}, width: 0, height: 0, ctx,
      addEventListener(t, fn) { this.listeners[t] = fn }, getContext() { return ctx } }
    els[id] = e
    return e
  }
  if (withCard) { el('map-card'); el('map-canvas'); el('map-foot'); el('map-hint') }
  return { els, getElementById: (id) => els[id] ?? null, createElement: (tag) => el('off-' + tag), exitPointerLock() { this.unlocked = true } }
}

describe('createMapCard', () => {
  it('returns no-ops when #map-card is absent', () => {
    const card = createMapCard(fakeDoc(false), { fog: createFogMap(), getLevel: () => ({ index: 0 }), getPlayer: () => at(0.5, 0.5) })
    expect(card.isOpen()).toBe(false)
    expect(() => { card.open(); card.toggle(); card.cellsDirty(); card.angleDirty(1); card.setFooter('x'); card.close() }).not.toThrow()
    expect(card.isOpen()).toBe(false)
    expect(Object.keys(card).sort()).toEqual(['angleDirty', 'cellsDirty', 'close', 'isOpen', 'open', 'setFooter', 'toggle'])
    expect(createMapCard(null, {}).isOpen()).toBe(false)
  })

  it('opens without releasing the pointer lock, draws the cells once and the arrow only past 0.05 rad', () => {
    const fog = fogWithPins()
    const doc = fakeDoc()
    const player = at(50.5, 50.5, 0)
    const level = { index: 0, cfg: { levelName: 'level 0 — the lobby' } }
    const card = createMapCard(doc, { fog, getLevel: () => level, getPlayer: () => player })
    expect(card.isOpen()).toBe(false)
    card.open()
    expect(card.isOpen()).toBe(true)
    expect(doc.unlocked).toBeUndefined()
    expect(doc.els['map-card'].style.display).toBe('flex')
    const off = doc.els['off-canvas'], vis = doc.els['map-canvas']
    expect(off.width).toBe(448); expect(off.height).toBe(448)
    expect(off.ctx.count('fillRect')).toBe(25)
    expect(vis.ctx.count('beginPath')).toBe(1)
    expect(doc.els['map-foot'].textContent).toBe('level 0 — the lobby · 25 cells walked · 1 down · 1 up')
    card.angleDirty(0.03)
    expect(vis.ctx.count('beginPath')).toBe(1)
    card.angleDirty(0.2)
    expect(vis.ctx.count('beginPath')).toBe(2)
    expect(off.ctx.count('fillRect')).toBe(25)                      // the cells layer did not redraw for a turn
    player.x = 51.5
    fog.step(0, 51.5, 50.5, 2, open)
    card.cellsDirty()
    expect(off.ctx.count('fillRect')).toBe(25 + 30)
    expect(doc.els['map-foot'].textContent).toBe('level 0 — the lobby · 30 cells walked · 1 down · 1 up')
    card.setFooter('folded')
    expect(doc.els['map-foot'].textContent).toBe('folded')
    card.toggle()
    expect(card.isOpen()).toBe(false)
    expect(doc.els['map-card'].style.display).toBe('none')
    card.cellsDirty(); card.angleDirty(3)
    expect(off.ctx.count('fillRect')).toBe(55)                      // closed: nothing is drawn
    card.toggle()
    expect(card.isOpen()).toBe(true)
  })

  it('a tap on the card asks the game to fold it (onTap), or folds it itself without one', () => {
    const fog = fogWithPins()
    const doc = fakeDoc()
    let taps = 0
    const card = createMapCard(doc, { fog, getLevel: () => ({ index: 0, cfg: { levelName: 'level 0' } }), getPlayer: () => at(50.5, 50.5), onTap: () => { taps++ } })
    card.open()
    doc.els['map-card'].listeners.pointerdown({ preventDefault() {} })
    expect(taps).toBe(1)
    expect(card.isOpen()).toBe(true)
    const doc2 = fakeDoc()
    const card2 = createMapCard(doc2, { fog, getLevel: () => ({ index: 0, cfg: { levelName: 'level 0' } }), getPlayer: () => at(50.5, 50.5) })
    card2.open()
    doc2.els['map-card'].listeners.pointerdown({ preventDefault() {} })
    expect(card2.isOpen()).toBe(false)
  })

  it('the footer names only the kinds on the map', () => {
    const fog = createFogMap()
    fog.step(1, 0.5, 0.5, 0, open)
    const doc = fakeDoc()
    const card = createMapCard(doc, { fog, getLevel: () => ({ index: 1, cfg: { levelName: 'level 1 — habitable zone' } }), getPlayer: () => at(0.5, 0.5) })
    card.open()
    expect(doc.els['map-foot'].textContent).toBe('level 1 — habitable zone · 1 cell walked')
    fog.pinWay(1, { key: 'a', kind: 'lift', x: 3.5, y: 3.5, target: 3, label: 'the lift' })
    fog.pinWay(1, { key: 'b', kind: 'down', x: 4.5, y: 3.5, target: 2, label: 'descend' })
    fog.pinWay(1, { key: 'c', kind: 'down', x: 5.5, y: 3.5, target: 2, label: 'descend' })
    card.cellsDirty()
    expect(doc.els['map-foot'].textContent).toBe('level 1 — habitable zone · 1 cell walked · 2 down · 1 lift')
  })
})

// the map opens from Tab on a keyboard and from #map-tab on a phone: the five touch action buttons stay five, none of them Tab
describe('touch.js ACTIONS (source guard)', () => {
  it('has exactly five entries and none is Tab', () => {
    const src = readFileSync(new URL('../src/renderer/touch.js', import.meta.url), 'utf8')
    const m = src.match(/const ACTIONS = \[([\s\S]*?)\n\]/)
    expect(m).not.toBeNull()
    const codes = [...m[1].matchAll(/code:\s*'([^']+)'/g)].map((x) => x[1])
    expect(codes).toHaveLength(5)
    expect(codes).not.toContain('Tab')
  })
})
