// mapcard.js — the sheet of paper over the lower view, and the pencil that draws the fog map on it.
//
// drawMap(ctx, view, opts) takes any object with fillRect / fillText / save / restore / translate / rotate / beginPath / moveTo / lineTo /
// fill: each walked cell one 7x7 ink rect at alpha 0.55, jittered ±0.6 px by a hash of the cell (a pencil hand, the same every time),
// faded chunks at 0.22 with their fresh cells drawn dark over them, pins as 11 px monospace glyphs (hollow when lost, a machine struck
// through once vended, a note faint until read), the player a 3-point arrow rotated by the view's angle. opts.layer 'cells' draws the
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

function drawCells(ctx, view, pitch, ink, color) {
  ctx.fillStyle = color
  const { cells, dim, ox, oy } = view
  for (let i = 0; i < view.n; i++) {
    const dx = cells[2 * i], dy = cells[2 * i + 1]
    ctx.globalAlpha = dim[i] ? 0.22 : 0.55
    ctx.fillRect(dx * pitch + jitter(ox + dx, oy + dy, 1), dy * pitch + jitter(ox + dx, oy + dy, 2), ink, ink)
  }
  ctx.globalAlpha = 0.55
  const fr = view.fresh
  for (let i = 0; i < view.nFresh; i++) {
    const dx = fr[2 * i], dy = fr[2 * i + 1]
    ctx.fillRect(dx * pitch + jitter(ox + dx, oy + dy, 1), dy * pitch + jitter(ox + dx, oy + dy, 2), ink, ink)
  }
}

function glyphFor(p) {
  if (p.lost) return LOST
  if (p.type === 'machine' && p.flag) return VENDED
  return GLYPHS[p.type] ?? '·'
}

function drawPins(ctx, view, pitch, color) {
  ctx.fillStyle = color
  ctx.font = '11px monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const half = pitch / 2
  for (let i = 0; i < view.pins.length; i++) {
    const p = view.pins[i]
    ctx.globalAlpha = p.lost ? 0.5 : (p.type === 'note' && !p.flag) ? 0.5 : 0.9
    ctx.fillText(glyphFor(p), (Math.floor(p.x) - view.ox) * pitch + half, (Math.floor(p.y) - view.oy) * pitch + half)
  }
}

function drawPlayer(ctx, view, pitch, color) {
  ctx.save()
  ctx.fillStyle = color
  ctx.globalAlpha = 0.95
  ctx.translate((view.px - view.ox) * pitch, (view.py - view.oy) * pitch)
  ctx.rotate(view.angle)
  ctx.beginPath()
  ctx.moveTo(5.5, 0)
  ctx.lineTo(-4, 3.8)
  ctx.lineTo(-4, -3.8)
  ctx.fill()
  ctx.restore()
}

export function drawMap(ctx, view, opts = {}) {
  const pitch = opts.pitch ?? PITCH, ink = opts.ink ?? INK_PX, color = opts.color ?? INK
  const layer = opts.layer ?? 'all'
  if (layer !== 'player') { drawCells(ctx, view, pitch, ink, color); drawPins(ctx, view, pitch, color) }
  if (layer !== 'cells') drawPlayer(ctx, view, pitch, color)
  ctx.globalAlpha = 1
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

  function levelName(lvl) { return lvl?.cfg?.levelName ?? lvl?.name ?? `level ${lvl?.index ?? '?'}` }

  // the arrow layer: the cells layer composited, then the player
  function composite() {
    if (!ctx || !view) return
    if (ctx.clearRect) ctx.clearRect(0, 0, W, W)
    if (off && ctx.drawImage) ctx.drawImage(off, 0, 0)
    drawMap(ctx, view, { layer: 'player' })
    lastAngle = view.angle
  }

  function redrawCells() {
    const lvl = getLevel(), player = getPlayer()
    if (!lvl || !player) return
    view = buildMapView(fog, lvl.index, player, { cells: CELLS, out: view })
    if (octx) {
      if (octx.clearRect) octx.clearRect(0, 0, W, W)
      drawMap(octx, view, { layer: 'cells' })
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
