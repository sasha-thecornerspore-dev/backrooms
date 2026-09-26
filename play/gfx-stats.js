// gfx-stats.js — the ?gfxstats=1 diagnostics overlay: a small monospace panel beside the HUD's own plates that says, twice a second, which
// renderer is drawing and why, the GPU's name, the tier / render scale / canvas size / devicePixelRatio, the real display frame interval and the
// render() cost (p50 / p95 over the last few seconds), how many GPU -> CPU fallbacks happened, and what the last level start cost.
//
// It exists for the owner's device tests (docs/gfx-device-testing.md). It is enabled ONLY by the URL parameter (no pref, no UI to find it) and
// costs nothing when off: game.js creates it only when statsEnabled(location.search) is true, and it is the only thing that then adds a DOM
// element and a timer. Nothing here writes to storage.
//
//   statsEnabled(search)                 '?gfxstats=1' (or true / on / yes) -> true
//   createFrameStats(cap)                ring buffers of the last `cap` frames: note(intervalMs, renderMs), summary()
//   statsLines(snapshot, summary)        -> string[] (pure: what the panel shows)
//   createStatsOverlay({ doc, parent, read, periodMs, timers })   the DOM part: an aria-hidden, pointer-events:none <div>, refreshed every
//                                        periodMs from read() (the game's current state) -> { frame(intervalMs, renderMs), update(), dispose(), el }
//   STATS_CSS                            where the panel goes in the game (see there): it overlaps no HUD element on a desktop, a portrait phone
//                                        or a landscape phone (checked in the real page with tools/gfx/page.cjs --query '?gfxstats=1')
//
// Import-safe in Node: `document` is only touched inside createStatsOverlay().

export const STATS_SAMPLES = 240        // ~4 s at 60 Hz: long enough for a stable p95, short enough to follow a change of scene
export const STATS_PERIOD_MS = 500      // the panel's refresh (twice a second)

export function statsEnabled(search) {
  try {
    const p = typeof search === 'string' ? new URLSearchParams(search) : search
    const v = p && p.get ? p.get('gfxstats') : null
    return v !== null && v !== undefined && /^(1|true|on|yes)$/i.test(String(v).trim())
  } catch { return false }
}

// nearest-rank percentile of the first n values of an ascending array (n >= 1)
export function percentileOf(sorted, n, p) {
  if (!(n > 0)) return NaN
  const i = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))
  return sorted[i]
}

export function createFrameStats(cap = STATS_SAMPLES) {
  const iv = new Float64Array(cap), rv = new Float64Array(cap), sa = new Float64Array(cap), sb = new Float64Array(cap)
  let n = 0, head = 0
  return {
    // one processed frame: the real interval since the previous one (rAF timestamps) and what render() cost on the CPU
    note(intervalMs, renderMs) {
      if (!(intervalMs >= 0) || !(renderMs >= 0)) return
      iv[head] = intervalMs; rv[head] = renderMs
      head = (head + 1) % cap; if (n < cap) n++
    },
    reset() { n = 0; head = 0 },
    get count() { return n },
    // -> { n, frameP50, frameP95, renderP50, renderP95, over33 (fraction of frames slower than 33 ms) }. Sorting 240 numbers twice a second.
    summary() {
      if (n === 0) return { n: 0, frameP50: NaN, frameP95: NaN, renderP50: NaN, renderP95: NaN, over33: 0 }
      let slow = 0
      for (let i = 0; i < n; i++) { sa[i] = iv[i]; sb[i] = rv[i]; if (iv[i] > 33.4) slow++ }
      const a = sa.subarray(0, n).sort(), b = sb.subarray(0, n).sort()
      return { n, frameP50: percentileOf(a, n, 0.5), frameP95: percentileOf(a, n, 0.95), renderP50: percentileOf(b, n, 0.5), renderP95: percentileOf(b, n, 0.95), over33: slow / n }
    },
  }
}

const ms = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-')
const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s }

// snap = { kind, why, info, tier, scale, canvasW, canvasH, cssW, cssH, dpr, fallbacks, levelStart: { level, buildMs, gfxMs, firstMs, readyMs } | null }
// sum  = createFrameStats().summary()
export function statsLines(snap, sum) {
  const s = snap || {}, f = sum || {}
  const out = []
  out.push(`renderer ${s.kind || '?'} (${s.why || '?'}) · fallbacks ${s.fallbacks | 0}`)
  const i = s.info
  if (s.kind === 'gpu' && i) out.push(`gpu ${clip(i.renderer || '?', 58)}${i.software ? ' [software]' : ''} · validation ${i.validation || '-'}`)
  const scale = Number.isFinite(s.scale) ? s.scale.toFixed(2) : '-'
  const css = s.cssW && s.cssH && (s.cssW !== s.canvasW || s.cssH !== s.canvasH) ? ` (css ${s.cssW}x${s.cssH})` : ''
  out.push(`tier ${s.tier || '-'} · scale ${scale} · canvas ${s.canvasW | 0}x${s.canvasH | 0}${css} · dpr ${Number.isFinite(s.dpr) ? s.dpr.toFixed(2) : '-'}`)
  const fps = f.frameP50 > 0 ? ` (${Math.round(1000 / f.frameP50)} fps)` : ''
  out.push(`frame p50 ${ms(f.frameP50)} · p95 ${ms(f.frameP95)} ms${fps} · >33ms ${f.n ? Math.round((f.over33 || 0) * 100) : 0}%`)
  out.push(`render p50 ${ms(f.renderP50)} · p95 ${ms(f.renderP95)} ms`)
  const L = s.levelStart
  // two short lines, so a phone-width panel wraps nothing important away
  if (L) { out.push(`level ${L.level} start: build ${ms(L.buildMs)} (renderer ${ms(L.gfxMs)}) ms`); out.push(`  first frame ${ms(L.firstMs)} · ready ${ms(L.readyMs)} ms`) }
  return out
}

// Where the panel goes in the game (it is a child of #hud-cluster there; index.html's HUD rules are the ones it must stay clear of):
//   desktop                      fixed in the top-right corner, under the settings gear — nothing else of the HUD lives there
//   portrait phone (<= 700 wide) in the cluster's flow under the gauges / item dock / compass, full width; lines wrap instead of being cut off
//   short screen (<= 460 high: a landscape phone)   fixed at the top, between the cluster (its right edge, which grows with the level
//                                name, is published as --gfx-stats-left) and the right-hand touch controls
// and, wherever it lands, the centre message (#msg: the level-name plate, the building's notices) is never above the panel's bottom edge: the
// panel publishes that edge as --gfx-stats-clear and #msg's top becomes max(its own top, that edge) while the panel exists (body.gfx-stats-on).
// The 34% / 30% are #msg's own tops in index.html (a test keeps them in step).
export const STATS_CSS = `
#gfx-stats { font: 11px/1.35 "Courier New", monospace; white-space: pre-wrap; overflow-wrap: anywhere; box-sizing: border-box; }
#hud-cluster > #gfx-stats { position: fixed; top: calc(max(12px, env(safe-area-inset-top)) + 46px); right: max(12px, env(safe-area-inset-right));
  left: auto; max-width: min(620px, calc(100vw - 300px)); z-index: 48; }
body.gfx-stats-on #msg { top: max(34%, var(--gfx-stats-clear, 0px)); }
@media (max-width: 700px) {
  #hud-cluster > #gfx-stats { position: static; max-width: calc(100vw - 24px); font-size: 10px; line-height: 1.3; }
  body.gfx-stats-on #msg { top: max(30%, var(--gfx-stats-clear, 0px)); }
}
@media (max-height: 460px) {
  #hud-cluster > #gfx-stats { position: fixed; top: max(10px, env(safe-area-inset-top)); right: auto; left: var(--gfx-stats-left, 276px);
    max-width: calc(100vw - var(--gfx-stats-left, 276px) - 116px); font-size: 10px; line-height: 1.3; }
}
`

// The DOM part. `parent` is where the panel goes (game.js: the HUD cluster; STATS_CSS places it so it overlaps none of the HUD's plates);
// without one it is fixed to the top-left corner. read() -> the snapshot statsLines() takes. `timers` = { setInterval, clearInterval } (tests).
export function createStatsOverlay({ doc, parent = null, read, periodMs = STATS_PERIOD_MS, timers = globalThis, samples = STATS_SAMPLES } = {}) {
  const stats = createFrameStats(samples)
  const el = doc.createElement('div')
  el.id = 'gfx-stats'
  el.setAttribute('aria-hidden', 'true')
  const st = el.style
  st.pointerEvents = 'none'; st.letterSpacing = '0'
  st.color = '#eef0e6'; st.background = 'rgba(0,0,0,0.74)'; st.padding = '4px 7px'; st.border = '1px solid rgba(255,255,255,0.18)'
  st.textShadow = 'none'; st.textTransform = 'none'
  if (!parent) { st.position = 'fixed'; st.left = '12px'; st.top = '12px'; st.zIndex = '48'; st.maxWidth = 'calc(100vw - 24px)' }
  // the placement rules (only while the panel exists: nothing is added to the page when it is off)
  let css = null
  if (parent && doc.head && typeof doc.head.appendChild === 'function') {
    css = doc.createElement('style'); css.id = 'gfx-stats-css'; css.textContent = STATS_CSS; doc.head.appendChild(css)
    try { doc.body.classList.add('gfx-stats-on') } catch { /* ignore */ }
  }
  ;(parent || doc.body).appendChild(el)
  const rootStyle = doc.documentElement && doc.documentElement.style
  let clearPx = -1, leftPx = -1
  // the panel's bottom edge (css px) for #msg, and the cluster's right edge for the short-screen slot: re-published whenever they move (a refresh
  // that adds a line, a rotation, a longer level name). A fixed panel is not part of the cluster's box, so the cluster edge is the plates' own.
  function publishEdge() {
    if (!css || !rootStyle || typeof el.getBoundingClientRect !== 'function') return
    const l = Math.ceil(parent.getBoundingClientRect().right + 12)
    if (l !== leftPx) { leftPx = l; rootStyle.setProperty('--gfx-stats-left', `${l}px`) }
    const b = Math.ceil(el.getBoundingClientRect().bottom + 8)
    if (b !== clearPx) { clearPx = b; rootStyle.setProperty('--gfx-stats-clear', `${b}px`) }
  }
  let disposed = false
  function update() {
    if (disposed) return
    let snap = null
    try { snap = read ? read() : null } catch { snap = null }
    el.textContent = statsLines(snap, stats.summary()).join('\n')
    try { publishEdge() } catch { /* ignore */ }
  }
  const timer = timers.setInterval(update, periodMs)
  update()
  return {
    el, stats,
    frame(intervalMs, renderMs) { stats.note(intervalMs, renderMs) },
    update,
    dispose() {
      if (disposed) return
      disposed = true; timers.clearInterval(timer)
      try { el.remove() } catch { /* ignore */ }
      if (css) {
        try { css.remove() } catch { /* ignore */ }
        try { doc.body.classList.remove('gfx-stats-on') } catch { /* ignore */ }
        try { if (rootStyle) { rootStyle.removeProperty('--gfx-stats-clear'); rootStyle.removeProperty('--gfx-stats-left') } } catch { /* ignore */ }
      }
    },
  }
}
