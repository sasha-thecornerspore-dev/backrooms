// renderer.js — the public entry point. game.js calls createRenderer(canvas, config, renderOpts, worldHooks) and then
// render(player, isWallFn, flicker, entities, fogMul, lights, timing) every frame. It picks a backend:
//
//   'cpu'  gfx-cpu.js  the hand-written raycaster on Canvas2D — always available, always the fallback
//   'gpu'  gfx-gl.js   the WebGL2 backend (only ever chosen when a real GPU is probed; never software GL)
//
// Selection is pickRenderer() in gfx-quality.js (pure): the ?renderer=cpu|gpu URL override, the `renderer` pref (auto|gpu|cpu), the WebGL2 probe,
// and a crash-loop breaker (a marker in localStorage armed before the first GL frame and cleared after CRASH_HEALTHY_FRAMES healthy frames, or a
// few seconds of them; two starts in a row that never got there — and never unloaded cleanly — disable the GPU path). Any failure — creation,
// shader link, a GL error in the first frames, the first-frame validation, a lost context — swaps this object to the CPU renderer IN PLACE,
// mid-game, without the caller noticing, and remembers not to try again: for the rest of the session always, and across sessions (the persisted
// marker) unless the failure was a lost context or a slow-GPU verdict, which are session-only (transient by nature).
//
//   kind       'cpu' | 'gpu' (a getter: it changes if the GPU path is abandoned)
//   why        the reason string of the current choice (pickRenderer's, or gpu-failed-<stage>), for the log / a debug overlay
//   info       the backend's diagnostics (GPU: renderer string, caps, validation state) or null
//   capture()  a PNG data URL of the visible frame — the Polaroid reads the frame through this (a GL canvas is only readable when re-drawn);
//              if the GPU frame could not be read the renderer swaps to the CPU and the CPU draws the same frame for the capture
//   noteFrame(rawMs, { budgetMs, atFloor })   the game loop feeds the REAL frame interval; the GPU health monitor (gfx-quality.js) may downgrade
//   diagnostics()  one line for the console, logged once per level start
//   dispose()  release backend resources (idempotent); a disposed renderer's render() is a no-op
//
// createRendererWith(deps) builds a createRenderer with injectable dependencies (createCpu, createGl, probeGl, storage, search, now, warn,
// onPageHide) so the selection / fallback logic is unit-tested in Node against fakes (test/gfx-gl-core.test.js). createRenderer is the real one.
import { createCpuRenderer } from './gfx-cpu.js'
import { createGlRenderer } from './gfx-gl.js'
import { probeGl, isTestRun } from './gfx-gl-util.js'
import {
  pickRenderer, parseRendererOverride, armCrashMarker, tickCrashMarker, CRASH_HEALTHY_FRAMES, CRASH_LIMIT,
  createGpuHealth, shouldDowngradeGpu,
} from './gfx-quality.js'

// While the GPU backend is being built, `auto` means CPU: only an explicit `renderer: 'gpu'` pref or ?renderer=gpu reaches it. It flips to true
// once the GPU path has been verified against the CPU path and on real devices (see the design spec, M2).
export const GPU_AUTO = false

const MARKER_KEY = 'backrooms:gpu-marker'
// failure stages that are transient by nature: the GPU path is dropped for this session only, nothing is persisted
const SESSION_ONLY_STAGES = new Set(['context', 'health', 'disposed'])
// the marker is also cleared after this many healthy frames spread over at least this long (a slow GPU takes long to reach CRASH_HEALTHY_FRAMES)
const CRASH_HEALTHY_MIN_FRAMES = 30, CRASH_HEALTHY_MS = 5000

const defaultDeps = {
  createCpu: createCpuRenderer,
  createGl: createGlRenderer,
  probeGl,
  storage: () => { try { return globalThis.localStorage || null } catch { return null } },
  search: () => (typeof location !== 'undefined' ? location.search : ''),
  now: () => Date.now(),
  warn: (...a) => { if (typeof console !== 'undefined') console.warn(...a) },
  // a CLEAN unload (reload, navigation, closing the window) fires pagehide; a GPU-process crash or a hard freeze kills the page without it.
  // -> a function that removes the listener
  onPageHide: (fn) => {
    try { if (typeof globalThis.addEventListener !== 'function') return () => {}; globalThis.addEventListener('pagehide', fn); return () => { try { globalThis.removeEventListener('pagehide', fn) } catch { /* ignore */ } } } catch { return () => {} }
  },
}

export function createRendererWith(overrides = {}) {
  const D = { ...defaultDeps, ...overrides }
  let sessionOff = null            // once set, no renderer built by this factory tries the GPU again (a lost context, a slow GPU, any failure)
  let probeMemo = null             // the WebGL probe runs at most once per session (each run creates and releases a throwaway context)

  const readMarker = () => { try { const s = D.storage(); return s ? JSON.parse(s.getItem(MARKER_KEY) || 'null') : null } catch { return null } }
  const writeMarker = (m) => { try { const s = D.storage(); if (!s) return; if (m) s.setItem(MARKER_KEY, JSON.stringify(m)); else s.removeItem(MARKER_KEY) } catch { /* private mode: no breaker, the try/catch fallbacks still hold */ } }
  // a definitive verdict is kept for the session; a lost / failed probe context is transient, so the next level may probe again
  function getProbe(doc, allowSoftware) {
    if (probeMemo && probeMemo.allow === allowSoftware) return probeMemo.probe
    const probe = D.probeGl(() => doc.createElement('canvas'), { allowSoftware })
    if (probe && probe.reason !== 'context-lost' && probe.reason !== 'probe-failed') probeMemo = { allow: allowSoftware, probe }
    return probe
  }

  return function createRenderer(canvas, config, renderOpts = {}, worldHooks = {}) {
    const doc = canvas.ownerDocument || (typeof document !== 'undefined' ? document : null)
    const now = D.now()
    const urlOverride = parseRendererOverride(D.search())
    const pref = renderOpts.renderer === 'gpu' || renderOpts.renderer === 'cpu' ? renderOpts.renderer : (GPU_AUTO ? 'auto' : 'cpu-until-verified')
    // the title's attract mode draws on its own #attract canvas (fixed, object-fit: cover): it is always the CPU renderer
    const gpuAllowed = canvas.id !== 'attract' && renderOpts.gpu !== false
    // software GL is a harness-only escape hatch: honoured only when the harness marked the page as a test run before the game script ran
    const allowSoftware = isTestRun() && !!renderOpts.allowSoftwareGl

    let impl = null, kind = 'cpu', healthy = 0, marker = null, armedPrev = null, disposed = false, health = null, lastArgs = null, firstOkAt = 0, unhook = null
    let why = urlOverride === 'cpu' ? 'url-cpu' : renderOpts.renderer === 'cpu' ? 'pref-cpu' : 'auto-cpu-until-verified'
    const explicit = urlOverride === 'gpu' ? 'gpu' : (pref === 'gpu' || pref === 'auto' ? pref : null)

    const clearMarker = () => { marker = null; if (unhook) { unhook(); unhook = null } }
    // Abandon the GPU path: forget the failure quietly for the player, loudly for the log. Persisted (the crash marker) unless transient.
    function giveUp(err, stage) {
      const lostCtx = !!((err && err.stage === 'context') || (impl && impl.lost) || stage === 'context')
      D.warn(lostCtx ? '[renderer] the WebGL context was lost: this session stays on the CPU renderer' : `[renderer] GPU path abandoned (${stage}):`, err && err.message ? err.message : err)
      const transient = lostCtx || SESSION_ONLY_STAGES.has((err && err.stage) || stage) || (err && err.name === 'GpuUnavailable')
      sessionOff = why = `gpu-failed-${lostCtx ? 'context' : stage}`
      if (!transient) writeMarker({ armedAt: now, count: CRASH_LIMIT })
      else if (marker) writeMarker(armedPrev)                 // this instance armed the marker but the failure is not a crash: put it back
      clearMarker()
      if (kind === 'gpu' && impl) { try { impl.dispose() } catch { /* ignore */ } }
      impl = null; kind = 'cpu'
    }
    // The CPU renderer, or — if even that cannot be built (an out-of-memory texture build right after a GPU allocation failure) — a last-resort
    // stand-in that keeps a visible, non-black #c (the fog colour), retries the CPU renderer now and then, and never leaves `impl` null.
    function swapToCpu() {
      kind = 'cpu'
      try { impl = D.createCpu(canvas, config, renderOpts, worldHooks); return } catch (e) { D.warn('[renderer] the CPU renderer could not be created:', e && e.message ? e.message : e) }
      let n = 0
      impl = {
        render(...args) {
          if (n++ % 30 === 0) { try { const r = D.createCpu(canvas, config, renderOpts, worldHooks); impl = r; return r.render(...args) } catch { /* still failing */ } }
          try { const g = canvas.getContext('2d'); if (g) { g.fillStyle = (config && config.palette && config.palette.fog) || '#1a1808'; g.fillRect(0, 0, canvas.width, canvas.height) } } catch { /* nothing left to draw with */ }
        },
        dispose() {},
      }
    }

    // ── try the GPU ──
    const wantsProbe = gpuAllowed && !sessionOff && urlOverride !== 'cpu' && (pref === 'gpu' || urlOverride === 'gpu' || pref === 'auto') && !!doc
    if (sessionOff && gpuAllowed && urlOverride !== 'cpu' && pref !== 'cpu') why = `session-${sessionOff}`
    if (wantsProbe) {
      try {
        const probe = getProbe(doc, allowSoftware)
        const pick = pickRenderer({
          pref: pref === 'gpu' ? 'gpu' : 'auto', urlOverride, softwareRender: false, probe, unmaskedRenderer: probe.unmaskedRenderer,
          allowSoftware, crashMarker: readMarker(), now,
        })
        why = pick.reason
        if (pick.backend === 'gpu') {
          armedPrev = readMarker()
          marker = armCrashMarker(armedPrev, now); writeMarker(marker)     // armed BEFORE the first GL frame
          unhook = D.onPageHide(() => { if (marker) { writeMarker(armedPrev); clearMarker() } })      // a clean unload is not a crash
          impl = D.createGl(canvas, config, renderOpts, worldHooks, { probe })
          kind = 'gpu'
          why = pick.reason
        }
      } catch (e) {
        giveUp(e, 'creation')
      }
    }
    if (!impl) swapToCpu()

    function render(...args) {
      if (disposed) return
      lastArgs = args
      if (kind === 'gpu') {
        try {
          impl.render(...args)
          if (marker) {
            if (!firstOkAt) firstOkAt = D.now()
            healthy++
            if (healthy >= CRASH_HEALTHY_FRAMES || (healthy >= CRASH_HEALTHY_MIN_FRAMES && D.now() - firstOkAt >= CRASH_HEALTHY_MS)) {
              if (!tickCrashMarker(marker, CRASH_HEALTHY_FRAMES)) writeMarker(null)
              clearMarker()
            }
          }
          return
        } catch (e) {
          giveUp(e, (e && e.stage) === 'context' ? 'context' : 'runtime')
          swapToCpu()
        }
      }
      impl.render(...args)
    }

    // The game loop's real frame interval: the health monitor (only while the GPU path is live) may decide the GPU is hopeless here.
    function noteFrame(rawMs, o = {}) {
      if (kind !== 'gpu' || disposed || renderOpts.gpuHealth === false) return
      if (!health) health = createGpuHealth()
      const verdict = health.update(rawMs, o.budgetMs > 0 ? o.budgetMs : 1000 / 60, !!o.atFloor)
      if (shouldDowngradeGpu({ verdict, kind, pref: explicit })) {
        giveUp(Object.assign(new Error('the frame time stayed above twice the budget at the minimum render scale'), { stage: 'health' }), 'health')
        swapToCpu()
      }
    }

    const self = {
      render, noteFrame,
      get kind() { return kind },
      get why() { return why },
      get info() { return impl && impl.info ? impl.info : null },
      capture() {
        if (disposed) return null
        if (kind === 'gpu' && impl.capture) {
          try { return impl.capture() } catch (e) {
            giveUp(e, (e && e.stage) === 'context' ? 'context' : 'runtime'); swapToCpu()
            // #c was never drawn while the GL path ran: let the CPU draw the frame the player is looking at, so the capture is real and #c is not blank
            if (lastArgs) { try { impl.render(...lastArgs) } catch { /* fall through to whatever #c holds */ } }
          }
        }
        try { return canvas.toDataURL('image/png') } catch { return null }
      },
      diagnostics() {
        const i = self.info
        return `[renderer] kind=${kind} why=${why}` + (i ? ` gpu=${i.renderer || '?'} software=${!!i.software} validation=${i.validation || '-'}` : '')
      },
      dispose() {
        if (disposed) return
        disposed = true
        // a GPU renderer torn down before its healthy frames (a level change) is not a crash: give the breaker its previous state back
        if (kind === 'gpu' && marker) writeMarker(armedPrev)
        clearMarker()
        try { if (impl && impl.dispose) impl.dispose() } catch { /* ignore */ }
      },
    }
    return self
  }
}

export const createRenderer = createRendererWith()
