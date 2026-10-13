// mapcard.js — the sheet of paper over the lower view, and the pencil that draws the fog map on it.
//
// drawMap(ctx, view, opts) takes any object with fillRect / fillText / save / restore / translate / rotate / beginPath / moveTo / lineTo /
// fill: each walked cell one 7x7 ink rect at alpha 0.55, jittered ±0.6 px by a hash of the cell (a pencil hand, the same every time),
// faded chunks at 0.22 with their fresh cells drawn dark over them, pins as 11 px monospace glyphs (hollow when lost, faint when stale or
// lost, a machine struck through once vended, a note faint until read), the player a 3-point arrow rotated by the view's angle. opts.layer 'cells' draws the
// strokes and pins only (the offscreen layer), 'player' the arrow only (redrawn when the angle turns), unset draws all.
// createMapCard(doc, deps) is the thin DOM: a no-op card when #map-card is absent (openNoteCard's rule, game.js:468), otherwise redraws
// the cells layer only on cellsDirty() and the arrow only when |Δangle| > 0.05 rad, never per frame. HELD, NOT MODAL: the card never
// touches the pointer lock; the gates (half pace, verbs off, a hit folds it) are game.js's.
import { buildMapView } from './fogmap.js'

export const GLYPHS = Object.freeze({ down: '▽', up: '△', lift: '◇', ring: '▽', machine: '⊟', sight: '✶', note: '¶', arrived: '○', hurt: '×' })
const LOST = '◌'                                              // the hole is not where you drew it
const VENDED = '⊠'                                            // the machine, struck through
const INK = '#2b2418'
const CELLS = 56, PITCH = 8, INK_PX = 7
const KIND_ORDER = ['down', 'up', 'lift', 'ring']

// a deterministic ±0.6 px per cell, so the strokes sit the same way every redraw
function jitter(ix, iy, salt) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(salt, 1274126177)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return ((h & 0xFFFF) / 0xFFFF - 0.5) * 1.2
}

function drawCells(ctx, view, pitch, ink, color, tx, ty) {
  ctx.fillStyle = color
  const { cells, dim, ox, oy } = view
  for (let i = 0; i < view.n; i++) {
    const dx = cells[2 * i], dy = cells[2 * i + 1]
    ctx.globalAlpha = dim[i] ? 0.22 : 0.55
    ctx.fillRect(tx + dx * pitch + jitter(ox + dx, oy + dy, 1), ty + dy * pitch + jitter(ox + dx, oy + dy, 2), ink, ink)
  }
  ctx.globalAlpha = 0.55
  const fr = view.fresh
  for (let i = 0; i < view.nFresh; i++) {
    const dx = fr[2 * i], dy = fr[2 * i + 1]
    ctx.fillRect(tx + dx * pitch + jitter(ox + dx, oy + dy, 1), ty + dy * pitch + jitter(ox + dx, oy + dy, 2), ink, ink)
  }
}

function glyphFor(p) {
  if (p.lost) return LOST
  if (p.type === 'machine' && p.flag) return VENDED
  return GLYPHS[p.type] ?? '·'
}

function drawPins(ctx, view, pitch, color, tx, ty) {
  ctx.fillStyle = color
  ctx.font = `${Math.round(11 * pitch / PITCH)}px monospace`     // 11 px at the base pitch; glyphs grow with the zoom
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const half = pitch / 2
  for (let i = 0; i < view.pins.length; i++) {
    const p = view.pins[i]
    // faint: lost, or stale (the chunk under it faded: the building moved, the glyph may not be where you drew it), or a note unread
    ctx.globalAlpha = (p.lost || view.faded.has(p.chunkKey) || (p.type === 'note' && !p.flag)) ? 0.5 : 0.9
    ctx.fillText(glyphFor(p), tx + (Math.floor(p.x) - view.ox) * pitch + half, ty + (Math.floor(p.y) - view.oy) * pitch + half)
  }
}

function drawPlayer(ctx, view, pitch, color, tx, ty) {
  const s = pitch / PITCH
  ctx.save()
  ctx.fillStyle = color
  ctx.globalAlpha = 0.95
  ctx.translate(tx + (view.px - view.ox) * pitch, ty + (view.py - view.oy) * pitch)
  ctx.rotate(view.angle)
  ctx.beginPath()
  ctx.moveTo(5.5 * s, 0)
  ctx.lineTo(-4 * s, 3.8 * s)
  ctx.lineTo(-4 * s, -3.8 * s)
  ctx.fill()
  ctx.restore()
}

// opts: pitch (px per cell, default 8), ink (rect size, default 7), tx / ty (px offset of the whole drawing, default 0), layer, color
export function drawMap(ctx, view, opts = {}) {
  const pitch = opts.pitch ?? PITCH, ink = opts.ink ?? INK_PX, color = opts.color ?? INK
  const tx = opts.tx ?? 0, ty = opts.ty ?? 0
  const layer = opts.layer ?? 'all'
  if (layer !== 'player') { drawCells(ctx, view, pitch, ink, color, tx, ty); drawPins(ctx, view, pitch, color, tx, ty) }
  if (layer !== 'cells') drawPlayer(ctx, view, pitch, color, tx, ty)
  ctx.globalAlpha = 1
}

// Fit the sheet to what you have drawn. A fixed 8 px pitch over the 56-cell window leaves a short walk as a smudge in the middle of the
// paper, so the pencil zooms to the bounds of the walked cells, the pins in the window and you, plus a margin of FIT_MARGIN cells, at the
// largest step of FIT_PITCHES that fits `size` px. Steps (not a continuous zoom) keep the drawing from swimming as you walk with the sheet
// up. At the base pitch the window already fills the sheet, so the layout is exactly the unzoomed one (tx = ty = 0).
export const FIT_PITCHES = Object.freeze([28, 24, 20, 16, 14, 12, 10, 8])
export const FIT_MARGIN = 2
export function fitView(view, size, out = { pitch: PITCH, ink: INK_PX, tx: 0, ty: 0 }) {
  let x0 = Math.floor(view.px) - view.ox, x1 = x0, y0 = Math.floor(view.py) - view.oy, y1 = y0
  const grow = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  for (let i = 0; i < view.n; i++) grow(view.cells[2 * i], view.cells[2 * i + 1])
  for (let i = 0; i < view.nFresh; i++) grow(view.fresh[2 * i], view.fresh[2 * i + 1])
  for (let i = 0; i < view.pins.length; i++) grow(Math.floor(view.pins[i].x) - view.ox, Math.floor(view.pins[i].y) - view.oy)
  const span = Math.max(x1 - x0 + 1, y1 - y0 + 1) + 2 * FIT_MARGIN
  let pitch = PITCH
  for (const p of FIT_PITCHES) if (p * span <= size) { pitch = p; break }
  out.pitch = pitch
  out.ink = pitch - 1
  if (pitch === PITCH) { out.tx = 0; out.ty = 0; return out }
  // centre the bounds on the sheet
  out.tx = Math.round(size / 2 - (x0 + x1 + 1) / 2 * pitch)
  out.ty = Math.round(size / 2 - (y0 + y1 + 1) / 2 * pitch)
  return out
}

// `level 1 — habitable zone · 212 cells walked · 3 down · 1 up`: only the kinds that are on the map
function footerText(name, counts) {
  let s = `${name} · ${counts.total} ${counts.total === 1 ? 'cell' : 'cells'} walked`
  for (const k of KIND_ORDER) if (counts[k] > 0) s += ` · ${counts[k]} ${k}`
  return s
}

const noop = () => {}
const NOOP_CARD = Object.freeze({ open: noop, close: noop, toggle: noop, isOpen: () => false, cellsDirty: noop, angleDirty: noop, setFooter: noop })

// createMapCard(doc, { fog, getLevel, getPlayer, onTap? }): onTap is called when the card itself is tapped (the game treats it like Tab);
// without one a tap folds the card directly.
export function createMapCard(doc, { fog, getLevel, getPlayer, onTap = null } = {}) {
  const card = doc && typeof doc.getElementById === 'function' ? doc.getElementById('map-card') : null
  if (!card) return NOOP_CARD
  const canvas = doc.getElementById('map-canvas')
  const foot = doc.getElementById('map-foot')
  const off = typeof doc.createElement === 'function' ? doc.createElement('canvas') : null
  const W = CELLS * PITCH
  if (off) { off.width = W; off.height = W }
  if (canvas) { canvas.width = canvas.width || W; canvas.height = canvas.height || W }
  const octx = off && typeof off.getContext === 'function' ? off.getContext('2d') : null
  const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
  let open = false
  let view = null
  let lastAngle = NaN
  const fit = { pitch: PITCH, ink: INK_PX, tx: 0, ty: 0, layer: 'cells' }

  function levelName(lvl) { return lvl?.cfg?.levelName ?? lvl?.name ?? `level ${lvl?.index ?? '?'}` }

  // the arrow layer: the cells layer composited, then the player at the same zoom
  function composite() {
    if (!ctx || !view) return
    if (ctx.clearRect) ctx.clearRect(0, 0, W, W)
    if (off && ctx.drawImage) ctx.drawImage(off, 0, 0)
    fit.layer = 'player'
    drawMap(ctx, view, fit)
    lastAngle = view.angle
  }

  function redrawCells() {
    const lvl = getLevel(), player = getPlayer()
    if (!lvl || !player) return
    view = buildMapView(fog, lvl.index, player, { cells: CELLS, out: view })
    fitView(view, W, fit)
    if (octx) {
      if (octx.clearRect) octx.clearRect(0, 0, W, W)
      fit.layer = 'cells'
      drawMap(octx, view, fit)
    }
    composite()
    setFooter(footerText(levelName(lvl), view.counts))
  }

  function setFooter(text) { if (foot) foot.textContent = text }
  function openCard() {
    if (open) return
    open = true
    card.style.display = 'flex'
    redrawCells()
  }
  function close() {
    if (!open) return
    open = false
    card.style.display = 'none'
  }
  function toggle() { if (open) close(); else openCard() }
  function isOpen() { return open }
  function cellsDirty() { if (open) redrawCells() }
  function angleDirty(angle) {
    if (!open || !view) return
    if (!(Math.abs(angle - lastAngle) > 0.05)) return
    view.angle = angle
    composite()
  }

  if (typeof card.addEventListener === 'function') {
    card.addEventListener('pointerdown', (e) => {
      if (e && e.preventDefault) e.preventDefault()
      if (!open) return
      if (onTap) onTap(); else close()
    })
  }

  return { open: openCard, close, toggle, isOpen, cellsDirty, angleDirty, setFooter }
}
