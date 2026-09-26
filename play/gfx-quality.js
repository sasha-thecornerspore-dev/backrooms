// gfx-quality.js — everything that keeps the new look safe and fast on every device. Pure and import-safe in Node
// (no document/window at module scope; the few functions that read the browser take navigator/window as arguments).
//
//   quality tiers            TIERS / qualityFor            what each tier switches on (the stages read fs.quality)
//   comfort                  comfortFor / effectiveFlicker  the whole-frame flicker clamp the renderer applies
//   flicker limiter          createFlickerState / stepFlicker   the game's flicker state machine, WCAG 2.3.1-safe
//   polaroid flash           flashFor                       peak / ramp / lockout of the #flash overlay
//   frame pacing             createFramePacer               fpsCap: skip frames on the raw rAF timestamp
//   device class             readDeviceEnv / deviceClass    a starting tier + pixel budget for `graphicsQuality: auto`
//   adaptive resolution      createAdaptiveController       raw frame time -> renderScale / tier (down fast, up slowly)
//   canvas + DPR             planCanvas / renderScaleFor    opt-in devicePixelRatio with a pixel budget
//   director                 createQualityDirector          composes the above for game.js (prefs -> renderOpts)
//   renderer selection       pickRenderer + crash-loop helpers   scaffolding for the WebGL milestone (no settings UI yet)
//
// The stages read the current tier through fs.quality; they must never hard-code these numbers:
//   scale        internal render scale (fraction of the visible canvas the world is raycast at)
//   texFilter    0 nearest | 1 mip-mapped (distance-filtered) texels | 2 mip-mapped plus the near-field 2-tap bilinear
//                (no tier sets 2 today: `high` gets the 2-tap through lightDetail 2; `medium` stays at 1)
//   lightDetail  0 classic shading (distance fog only, no light model) | 1 light pools + contact shading | 2 + dynamic lights
//                (the flashlight and glowstick light surfaces; per-panel spatial flicker)
//   bloom        0 off | 1 on (a low-res bright-pass composite)
//   particles    true | false
//
// `legacy` is the classic-shading tier: the old distance-fog shading with no light model, the cheapest and the
// fallback. It is NOT the pre-overhaul picture: the level-keyed surfaces, sky and post-processing are the new art at
// every tier (only hand-built configs with no level key get the byte-identical old textures). renderOpts.qualityTier
// (a live prefs key) selects one by name; unknown names fall back to legacy.

const T = (o) => Object.freeze(o)

export const TIERS = T({
  legacy: T({ scale: 0.6,  texFilter: 0, lightDetail: 0, bloom: 0, particles: true }),
  low:    T({ scale: 0.5,  texFilter: 0, lightDetail: 1, bloom: 0, particles: true }),
  medium: T({ scale: 0.6,  texFilter: 1, lightDetail: 1, bloom: 0, particles: true }),
  high:   T({ scale: 0.75, texFilter: 1, lightDetail: 2, bloom: 1, particles: true }),
})

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)      // 'constructor' / 'toString' are not tiers
export function qualityFor(name) { return typeof name === 'string' && has(TIERS, name) ? TIERS[name] : TIERS.legacy }

// the tiers the adaptive controller moves between, cheapest first (legacy is never chosen automatically)
export const TIER_ORDER = Object.freeze(['low', 'medium', 'high'])

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const q100 = (v) => Math.round(v * 100) / 100          // scales live on a 0.01 grid (steps are 0.05): no float drift

// ════════════════════════════════════ flicker comfort (the whole-frame clamp) ════════════════════════════════════
// The game's flicker scalar (1 = steady, ~0.14 = near black) used to dim the whole frame with no limit (Level 3
// reaches 92%). `maxGlobalDip` bounds how far the WHOLE-FRAME luminance may dip (1 = legacy, no clamp); localised,
// per-panel dips are governed by the light model instead. `reduceFlicker` is the user preference.
//
//   untouched `legacy` (no qualityTier, no maxGlobalDip)   1     no clamp, so the harness baseline is reproducible
//   any real tier, or an explicit opts.maxGlobalDip        0.5   the frame never dips below half brightness
//   reduceFlicker                                          0.25  gentler still (and min() of any explicit value)
// game.js always sets opts.maxGlobalDip, so the shipped game is bounded even when the player picks the legacy look.
export const DEFAULT_MAX_GLOBAL_DIP = 0.5
export const REDUCED_MAX_GLOBAL_DIP = 0.25

export function comfortFor(opts) {
  const reduceFlicker = !!(opts && opts.reduceFlicker)
  const explicit = opts && isNum(opts.maxGlobalDip) ? clamp(opts.maxGlobalDip, 0.1, 1) : null
  const tier = opts && opts.qualityTier
  const legacy = typeof tier !== 'string' || !has(TIERS, tier) || tier === 'legacy'
  let dip = explicit !== null ? explicit : (legacy ? 1 : DEFAULT_MAX_GLOBAL_DIP)
  if (reduceFlicker && dip > REDUCED_MAX_GLOBAL_DIP) dip = REDUCED_MAX_GLOBAL_DIP
  return { reduceFlicker, maxGlobalDip: dip }
}
export function effectiveFlicker(raw, comfort) {
  const floor = 1 - comfort.maxGlobalDip
  return raw < floor ? floor : raw
}

// ═══════════════════════════ the flicker state machine, rate-limited (WCAG 2.3.1) ═══════════════════════════
// game.js used to run this inline: every 0.04-0.16 s after a dip it could roll ANOTHER dip, so the whole frame could
// strobe ~8 times a second, and events (`lights-cascade`, sour water) wrote the target directly with no limit at all.
// WCAG 2.3.1 (level A): nothing may flash more than three times in any one second. This is the same machine with a
// limiter in front of every way a dip can begin:
//
//   * a "dip" is any dip-branch roll of the machine OR any external write of a target below DIP_LEVEL (events/items
//     set the target directly; the game copies its flickTgt/flickTimer in and out around each stepFlicker call, so
//     stepFlicker sees those writes and vets them);
//   * dip STARTS are at least `minGap` seconds apart AND at most 3 fall in any DIP_WINDOW (1.4 s) window (both are
//     checked). The visible output crosses the dip level a variable time (up to ~0.3 s at the slowest recovery
//     speeds) after a dip starts, so counting starts over 1.4 s rather than 1.0 s keeps the guarantee on what the
//     player SEES: no input sequence produces more than 3 dips in any one second (in practice <= 2.2/s). reduceFlicker
//     spaces starts 1 s apart;
//   * a refused machine roll becomes a quiet step that re-rolls as soon as a dip is allowed (the stutter of a dying
//     tube survives, but as a bounded burst); a refused external dip is held as `pending` and starts as soon as it is
//     allowed (it is dropped after 1.5 s: it would no longer belong to the moment that caused it);
//   * reduceFlicker also caps how deep a dip may go (target >= 0.75) and how fast the value may move (<= 5/s).
// The output `value` is what renderOpts/render() receive and what audio's setFlicker hears.
export const DIP_LEVEL = 0.9           // targets below this are dips
export const MAX_DIPS_PER_SEC = 3      // WCAG 2.3.1 general-flash ceiling (per second, as seen on screen)
export const DIP_WINDOW = 1.4          // seconds over which at most 3 dip STARTS may fall (see above)
const PENDING_TTL = 1.5                // seconds an external dip may wait for the limiter
const LIM_DEFAULT = Object.freeze({ minGap: 0.4, maxDepth: 1, maxSpeed: 60 })
const LIM_REDUCED = Object.freeze({ minGap: 1.0, maxDepth: 1 - 0.75, maxSpeed: 5 })

export function flickerLimits(reduce) { return reduce ? LIM_REDUCED : LIM_DEFAULT }

export function createFlickerState() {
  return {
    value: 1, target: 1, timer: 0,                 // the three numbers game.js owns (copied in and out each frame)
    lastTarget: 1, quiet: 0.96,                    // internal: the target we last wrote; the quiet level we last chose
    t: 0, starts: [-1e9, -1e9, -1e9], si: 0,       // internal: sim clock and the last three dip start times
    pendTarget: NaN, pendTimer: 0, pendAt: 0,      // internal: an external dip waiting for the limiter
  }
}

// seconds until a dip may start (0 = now)
function dipWait(st, lim) {
  let last = -1e9, oldest = 1e9
  for (let i = 0; i < 3; i++) { const s = st.starts[i]; if (s > last) last = s; if (s < oldest) oldest = s }
  const a = last + lim.minGap - st.t, b = oldest + DIP_WINDOW - st.t   // spacing rule; "3 starts inside DIP_WINDOW" rule
  const w = a > b ? a : b
  return w > 0 ? w + 1e-6 : 0
}
function startDip(st) { st.starts[st.si] = st.t; st.si = (st.si + 1) % 3 }

// Advance the machine by dt seconds. Mutates `st`. tune = the level's { rate, depth, recoverySpeed }; rand() -> [0,1);
// calm = the almond-water hold (no dips, steady 0.97); reduce = the reduceFlicker preference. Returns st.value.
export function stepFlicker(st, dt, tune, rand, calm, reduce) {
  const lim = reduce ? LIM_REDUCED : LIM_DEFAULT
  const floor = 1 - lim.maxDepth
  st.t += dt
  st.timer -= dt

  if (calm) {
    st.target = 0.97; st.pendTarget = NaN            // the calm overrides everything, as it always did
  } else {
    // (1) vet a target written from outside since our last step (events, items)
    if (st.target !== st.lastTarget) {
      if (st.target < DIP_LEVEL) {
        const wait = dipWait(st, lim)
        if (wait > 0) {                              // refused for now: keep the machine as it was, hold the request
          st.pendTarget = st.target; st.pendTimer = st.timer > 0.04 ? st.timer : 0.04; st.pendAt = st.t
          st.target = st.lastTarget; st.timer = wait < 0.05 ? 0.05 : wait
        } else {
          startDip(st)
          if (st.target < floor) st.target = floor
        }
      } else st.quiet = st.target > 1 ? 1 : st.target
    }
    // (2) an external dip that was waiting for the limiter
    if (st.pendTarget === st.pendTarget) {          // not NaN
      if (st.t - st.pendAt > PENDING_TTL) st.pendTarget = NaN
      else if (dipWait(st, lim) <= 0) {
        startDip(st)
        st.target = st.pendTarget < floor ? floor : st.pendTarget; st.timer = st.pendTimer
        st.pendTarget = NaN
      }
    }
    // (3) the machine's own decision (same branch structure, same random draws as the original)
    if (st.timer <= 0) {
      if (rand() < tune.rate) {
        const wait = dipWait(st, lim)
        if (wait <= 0) {
          let tgt = 1 - tune.depth * rand()
          if (tgt < floor) tgt = floor
          st.target = tgt; st.timer = 0.04 + rand() * 0.12
          startDip(st)
        } else {                                    // refused: stay quiet, come back when a dip is allowed
          st.target = st.quiet; st.timer = wait < 0.05 ? 0.05 : wait
        }
      } else {
        st.quiet = 0.92 + rand() * 0.08
        st.target = st.quiet; st.timer = 0.8 + rand() * 3
      }
    }
  }
  const speed = tune.recoverySpeed < lim.maxSpeed ? tune.recoverySpeed : lim.maxSpeed
  const k = dt * speed < 1 ? dt * speed : 1
  st.value += (st.target - st.value) * k
  if (st.value < floor) st.value = floor              // a dip already under way when reduceFlicker was switched on
  st.lastTarget = st.target
  return st.value
}

// ═══════════════════════════════════════════════ the polaroid flash ═══════════════════════════════════════════════
// The #flash overlay was 90% white, instant on: a full-screen high-contrast flash on every photograph. Now a ramp up
// to a gentler, slightly warm peak and a long decay; a second flash inside minGapMs is skipped (so mashing the button
// cannot strobe the screen), and reduceFlicker lowers the peak again and slows the ramp.
export function flashFor(reduce) {
  return reduce
    ? { peak: 0.16, attackMs: 320, decayMs: 1700, minGapMs: 1500 }
    : { peak: 0.30, attackMs: 110, decayMs: 1300, minGapMs: 500 }
}
// The flash is a full-screen general flash too, so it shares the dip limiter's budget: it may only fire when a dip
// could start (flashWait -> seconds to hold it back, 0 = now) and then counts as a dip start (noteFlash), and it keeps
// FLASH_DIP_SPACING clear of the last dip start so a dip and a flash never land within ~0.7 s of each other. Together
// with the limiter's own rules the two sources can never exceed 3 general flashes in any one second.
export const FLASH_DIP_SPACING = 0.7
export function flashWait(st, reduce) {
  const lim = reduce ? LIM_REDUCED : LIM_DEFAULT
  let last = -1e9
  for (let i = 0; i < 3; i++) if (st.starts[i] > last) last = st.starts[i]
  const w = Math.max(dipWait(st, lim), last + FLASH_DIP_SPACING - st.t)
  return w > 0 ? w + 1e-6 : 0
}
export function noteFlash(st) { startDip(st) }

// ═══════════════════════════════════════════════════ frame pacing ═══════════════════════════════════════════════════
// fpsCap (0 | 30 | 60) by skipping animation frames on the raw rAF timestamp. The phase is kept (last += interval) so a
// 144 Hz display capped at 60 averages exactly 60 instead of the 48 that "skip until 16.7 ms have passed" gives; a
// stall (a gap of two intervals or more) resynchronises. `due(ts, cap)` -> true when this frame should be processed.
export function createFramePacer() {
  let last = NaN
  return {
    due(ts, capFps) {
      if (!(capFps > 0) || last !== last) { last = ts; return true }
      const interval = 1000 / capFps, d = ts - last
      if (d < interval - 1) return false                 // 1 ms of timestamp jitter slack
      last = d < interval * 2 ? last + interval : ts
      return true
    },
    reset() { last = NaN },
  }
}

// ═════════════════════════════════════════ device class -> starting tier ═════════════════════════════════════════
// Reads the browser through the navigator/window it is handed (so it stays testable and import-safe).
const posNum = (v) => (isNum(v) && v > 0 ? v : null)
export function readDeviceEnv(nav, win) {
  const n = nav || {}, w = win || {}
  const mm = (q) => { try { return !!(w.matchMedia && w.matchMedia(q).matches) } catch { return false } }
  return {
    deviceMemory: posNum(n.deviceMemory),               // GB, Chromium only (capped at 8); null elsewhere
    hardwareConcurrency: posNum(n.hardwareConcurrency),
    coarsePointer: mm('(pointer: coarse)'),
    reducedMotion: mm('(prefers-reduced-motion: reduce)'),
    saveData: !!(n.connection && n.connection.saveData),
    dpr: posNum(w.devicePixelRatio) || 1,
  }
}

// 'low' | 'mid' | 'high'. Unknown fields (Firefox/Safari expose no deviceMemory) never count against a device.
export function deviceClass(env) {
  const e = env || {}
  const mem = posNum(e.deviceMemory), cores = posNum(e.hardwareConcurrency), coarse = !!e.coarsePointer
  if (e.saveData) return 'low'
  if (mem !== null && mem <= 2) return 'low'
  if (cores !== null && cores <= 2) return 'low'
  if (coarse && mem !== null && mem <= 3) return 'low'
  if (!coarse && cores !== null && cores >= 6 && (mem === null || mem >= 8)) return 'high'
  return 'mid'
}
export const TIER_FOR_CLASS = Object.freeze({ low: 'low', mid: 'medium', high: 'high' })
export function startTierFor(env) { return TIER_FOR_CLASS[deviceClass(env)] }

// The internal (raycast) pixel budget per class, in pixels of the world buffer. Justification: the world pass costs
// ~linearly in pixels, and the legacy 0.6 scale is 332 k px at 720p, 746 k at 1080p, 1.33 M at 1440p. `mid` (0.8 M)
// keeps a 1080p window at its tier scale but pulls a 1440p/4K monitor down instead of quadrupling the cost; `low` (0.35 M)
// is one 720p-at-0.6 frame, what a 2-core Chromebook can be expected to fill; `high` (1.3 M) admits 1440p at 0.6.
export const INTERNAL_PX_BUDGET = Object.freeze({ low: 350000, mid: 800000, high: 1300000 })

// the largest css-relative scale whose internal pixel count fits the budget, snapped down to the 0.05 grid
export function budgetScale(cssW, cssH, budgetPx, minScale = 0.4, maxScale = 0.9) {
  const px = Math.max(1, cssW * cssH)
  const s = Math.floor(Math.sqrt(budgetPx / px) * 20 + 1e-9) / 20
  return q100(clamp(s, minScale, maxScale))
}

// ══════════════════════════════════════════ canvas size and devicePixelRatio ══════════════════════════════════════════
// The canvas backing store used to be window.innerWidth x innerHeight and devicePixelRatio was ignored. With the
// opt-in `hiDpi` preference the backing store may be up to MAX_DPR_RATIO x larger (sharper overlays: nameplates,
// crosshair, vignette) while the INTERNAL world buffer keeps exactly the pixel count the tier / controller asked for:
// renderScale is expressed relative to the canvas, so renderScale = cssScale / ratio and (css x ratio x renderScale)
// stays css x cssScale. The extra cost of a bigger canvas is only the full-resolution compositing (drawImage upscale,
// vignette, grain fill, particles), which is capped by CANVAS_PX_BUDGET: 2.6 M px is 1080p plus a quarter, which the
// compositing stages handle on a Chromebook-class GPU; a Pixelbook (1200x800 css @2x = 3.8 M) gets ratio 1.64 -> 1.5.
export const CANVAS_PX_BUDGET = 2600000
export const MAX_DPR_RATIO = 1.5
export const RENDER_SCALE_FLOOR = 0.3   // gfx-cpu.js ignores a renderScale override below this

// -> { width, height, cssW, cssH, ratio }. minCssScale is the lowest css-relative scale the tier / controller may
// run at; the ratio is limited so renderScale never has to drop under the floor the renderer accepts.
export function planCanvas({ cssW, cssH, dpr = 1, hiDpi = false, minCssScale = 0.4, canvasBudgetPx = CANVAS_PX_BUDGET } = {}) {
  const w = Math.max(1, Math.round(isNum(cssW) ? cssW : 1)), h = Math.max(1, Math.round(isNum(cssH) ? cssH : 1))
  let ratio = 1
  if (hiDpi && isNum(dpr) && dpr > 1) {
    ratio = Math.min(dpr, MAX_DPR_RATIO, Math.sqrt(canvasBudgetPx / (w * h)), minCssScale / RENDER_SCALE_FLOOR)
    if (!(ratio > 1.01)) ratio = 1
  }
  const width = Math.round(w * ratio), height = Math.round(h * ratio)
  return { width, height, cssW: w, cssH: h, ratio: width / w }
}
// the renderOpts.renderScale that yields css-relative scale `cssScale` on a canvas `ratio` times the css size
export function renderScaleFor(cssScale, ratio) {
  return Math.round(clamp(cssScale / (ratio || 1), RENDER_SCALE_FLOOR, 1) * 1000) / 1000
}

// ═════════════════════════════════════════════ the adaptive controller ═════════════════════════════════════════════
// Fed the RAW frame time (the rAF interval between processed frames, NOT game.js's clamped dt) and, when known, the
// CPU time the frame's callback took (`workMs`). It moves (tier, scale) on two dials:
//
//   scale  the fast dial: 0.4..0.9 in 0.05 steps. Down is proportional (scale ~ sqrt(budget/frame), cost being
//          ~ pixels) after two over-budget windows, or one when the frame time is 1.6x the budget: ~1 s to react.
//   tier   the slow dial: only stepped DOWN once the scale is already at its floor and the frame is still 1.3x over
//          budget, and back UP only after the scale has climbed to its tier ceiling and stayed there for 30 s.
//
// Why it does not oscillate:
//   * the frame time it sees is quantised by vsync (a 60 Hz display reports 16.7 ms whether the work took 3 ms or
//     15 ms), so headroom is judged from `workMs` and PREDICTED: an up-step happens only if work x (new/old scale)^2
//     still leaves 30% headroom (no workMs: the frame time itself must show it, which only a >60 Hz display can);
//   * up-steps are one 0.05 step, need 8 s of unbroken headroom and 10 s since the last change;
//   * every down-step from a level penalises that level: the wait before stepping back up to it doubles (x2^n, n <= 5,
//     forgotten after 10 minutes);
//   * a per-session CEILING outlives the penalties: a down-step that follows an up-step within upFailMs is a failed
//     probe (a cost workMs cannot see, e.g. GPU fill), so the controller goes back to the pre-probe level (not the
//     proportional formula) and caps itself there. The cap is lifted by a resize (setBounds), force() or, failing
//     that, ceilLiftMs of session time, so a GPU-bound machine settles instead of pulsing;
//   * a THROTTLED display (30 Hz rAF, battery saver, an occluded window) is not overload: when a down-step was taken
//     although workMs showed headroom (< half the budget) and the frame time did not respond, the step is undone and
//     the budget follows the measured display period (the median of the fastest quarter of the last few seconds of
//     frame intervals) until the frames speed up again;
//   * stalls (an isolated frame over 250 ms: hidden tab, window drag, a level build, GC) are ignored, and each window
//     is winsorised at 3x the budget, so a burst of hitches cannot trigger a step. A RUN of long frames (3 in a row)
//     is not a stall but a machine that cannot keep up (2 fps), so from the third on they count as data;
//   * the first 0.75 s after any change (2 s at startup: cold JIT, the first level build) is ignored. Windows (0.5 s)
//     and warm-up are measured in TIME, not frames, so a machine at 15 fps reacts as fast as one at 60.
// Time is the sum of the frame times it was fed: no Date.now, fully deterministic under test.
const AD = Object.freeze({
  windowMs: 500, minWindowFrames: 6, warmupMs: 750, startupMs: 2000, stallMs: 250, stallRun: 3, slack: 1.25, winsor: 3,
  downStrikes: 2, severeFrac: 1.6, tierDropFrac: 1.3, safety: 0.94,
  upWorkFrac: 0.7, tierCostRatio: 1.35,
  upSustainMs: 8000, upCooldownMs: 10000, tierUpSustainMs: 30000, tierUpCooldownMs: 30000,
  penaltyCap: 5, penaltyDecayMs: 600000, ceilHeadroom: 0.15,
  upFailMs: 5000, ceilLiftMs: 3600000,
  headroomFrac: 0.5, noResponse: 0.92, regular: 0.85, periodSamples: 300, periodMin: 40,
})

export function createAdaptiveController(o = {}) {
  const step = o.step || 0.05
  const minScale0 = isNum(o.minScale) ? o.minScale : 0.4
  let minScale = minScale0, maxScale = isNum(o.maxScale) ? o.maxScale : 0.9
  const idx = (name, dflt) => { const i = TIER_ORDER.indexOf(name); return i < 0 ? dflt : i }
  const minTierIdx = idx(o.minTier, 0), maxTierIdx = Math.max(minTierIdx, idx(o.maxTier, TIER_ORDER.length - 1))
  let tierIdx = clamp(idx(o.tier, 1), minTierIdx, maxTierIdx)
  const nominal = (i) => TIERS[TIER_ORDER[i]].scale
  const ceilFor = (i) => Math.max(minScale, Math.min(maxScale, q100(nominal(i) + AD.ceilHeadroom)))

  let baseBudget = 1000 / (o.targetFps || 60) * AD.slack, periodBudget = 0, budget = baseBudget
  const setBudget = () => { budget = Math.max(baseBudget, periodBudget) }
  let scale = q100(clamp(isNum(o.scale) ? o.scale : nominal(tierIdx), minScale, maxScale))

  // window / timing state
  let clock = 0, warm = AD.startupMs                 // the first 2 s (cold JIT, first level build) are not a fair sample
  let n = 0, sum = 0, wn = 0, wsum = 0, wt = 0, longRun = 0
  let strikes = 0, goodMs = 0, lastChange = -1e9
  let probe = null                                   // a down-step taken with workMs headroom: { ti, s, mean, pen, penAt, key }
  let lastUp = null                                  // the previous level of the latest up-step: { ti, s, at }
  let cap = null, capAt = 0                          // the highest level allowed this session: { ti, s }
  const iv = []                                      // recent raw frame intervals (post-warmup, stalls excluded)
  const pen = Object.create(null), penAt = Object.create(null)

  const ctl = { tier: TIER_ORDER[tierIdx], scale, reason: 'init', changes: 0, atFloor: false, stalls: 0, get budgetMs() { return budget }, get periodMs() { return period() } }

  const key = (ti, s) => ti * 1000 + Math.round(s * 100)
  const penOf = (k) => (pen[k] && clock - penAt[k] < AD.penaltyDecayMs ? pen[k] : 0)
  const resetWindow = () => { n = 0; sum = 0; wn = 0; wsum = 0; wt = 0 }

  // the display period: the median of the fastest quarter of the recent intervals (NaN until there are enough)
  function period() {
    if (iv.length < AD.periodMin) return NaN
    const a = iv.slice().sort((x, y) => x - y), q = Math.max(1, a.length >> 2)
    return a[q >> 1]
  }

  function commit(ti, s, reason) {
    tierIdx = ti; scale = q100(s)
    ctl.tier = TIER_ORDER[tierIdx]; ctl.scale = scale; ctl.reason = reason
    ctl.changes++; ctl.atFloor = false
    warm = AD.warmupMs; strikes = 0; goodMs = 0; lastChange = clock
    resetWindow()
    return true
  }

  function stepDown(mean, headroom) {
    const k = key(tierIdx, scale)
    const before = { ti: tierIdx, s: scale, mean, pen: pen[k], penAt: penAt[k], key: k }
    if (lastUp && clock - lastUp.at < AD.upFailMs) {   // the up-step we just took does not fit: back to before it, and cap there
      pen[k] = Math.min(AD.penaltyCap, penOf(k) + 1); penAt[k] = clock
      cap = { ti: lastUp.ti, s: lastUp.s }; capAt = clock
      const back = lastUp; lastUp = null
      return commit(back.ti, back.s, 'down-probe')
    }
    probe = headroom ? before : null
    if (scale > minScale + 1e-6) {
      let ns = q100(Math.floor(scale * Math.sqrt(budget / mean) * AD.safety * 20 + 1e-9) / 20)
      if (ns > q100(scale - step) + 1e-6) ns = q100(scale - step)      // at least one step
      if (ns < minScale) ns = minScale
      pen[k] = Math.min(AD.penaltyCap, penOf(k) + 1); penAt[k] = clock
      return commit(tierIdx, ns, 'down-scale')
    }
    if (tierIdx > minTierIdx && mean > budget * AD.tierDropFrac) {
      pen[k] = Math.min(AD.penaltyCap, penOf(k) + 1); penAt[k] = clock
      return commit(tierIdx - 1, scale, 'down-tier')
    }
    ctl.atFloor = true
    return false
  }

  // the level one rung up: { ti, s, tier } or null. Scale climbs to its tier ceiling before the tier does.
  function nextUp() {
    const ceil = ceilFor(tierIdx)
    let up = null
    if (scale < ceil - 1e-6) up = { ti: tierIdx, s: q100(Math.min(ceil, scale + step)), tier: false }
    else if (tierIdx < maxTierIdx) {
      const ti = tierIdx + 1
      up = { ti, s: q100(clamp(nominal(ti), minScale, ceilFor(ti))), tier: true }
    }
    if (up && cap && (up.ti > cap.ti || (up.ti === cap.ti && up.s > cap.s + 1e-6))) return null   // above the session ceiling
    return up
  }

  function evaluate(mean, wmean, spanMs) {
    if (cap && clock - capAt >= AD.ceilLiftMs) cap = null                // a long session: the machine may have changed
    const p = period()
    if (periodBudget > 0 && mean < periodBudget / AD.slack * 0.75) { periodBudget = 0; setBudget() }   // the throttle ended
    if (probe) {                                                          // was the last step-down a misread throttle?
      const pr = probe; probe = null
      if (mean > budget && mean > pr.mean * AD.noResponse && p === p && p >= mean * AD.regular) {
        periodBudget = p * AD.slack; setBudget()                          // frames do not respond to resolution: the display is the limit
        if (pr.pen === undefined) delete pen[pr.key]; else { pen[pr.key] = pr.pen; penAt[pr.key] = pr.penAt }
        return commit(pr.ti, pr.s, 'throttled')
      }
    }
    if (mean > budget) {
      goodMs = 0
      strikes++
      const headroom = isNum(wmean) && wmean < budget * AD.headroomFrac
      if (mean > budget * AD.severeFrac || strikes >= AD.downStrikes) return stepDown(mean, headroom)
      return false
    }
    strikes = 0
    ctl.atFloor = false
    const up = nextUp()
    if (!up) { goodMs = 0; return false }
    // predicted work after the step: pixels scale ~ s^2 (an upper bound: some cost is per-canvas-pixel and fixed)
    const load = isNum(wmean) ? wmean : mean
    const growth = (up.s / scale) * (up.s / scale) * (up.tier ? AD.tierCostRatio : 1)
    if (load * growth > AD.upWorkFrac * budget) { goodMs = 0; return false }
    goodMs += spanMs
    const mult = Math.pow(2, penOf(key(up.ti, up.s)))
    const sustain = (up.tier ? AD.tierUpSustainMs : AD.upSustainMs) * mult
    const cooldown = (up.tier ? AD.tierUpCooldownMs : AD.upCooldownMs) * mult
    if (goodMs >= sustain && clock - lastChange >= cooldown) {
      const from = { ti: tierIdx, s: scale, at: 0 }
      commit(up.ti, up.s, up.tier ? 'up-tier' : 'up-scale')
      from.at = clock; lastUp = from
      return true
    }
    return false
  }

  // Feed one processed frame. Returns true when (tier, scale) changed (read ctl.tier / ctl.scale).
  ctl.update = function update(frameMs, workMs) {
    if (!isNum(frameMs) || frameMs <= 0) return false
    clock += frameMs < 1000 ? frameMs : 1000
    if (frameMs > AD.stallMs) { if (++longRun < AD.stallRun) { ctl.stalls++; return false } } else longRun = 0
    if (warm > 0) { warm -= frameMs; return false }
    if (frameMs <= AD.stallMs) { iv.push(frameMs); if (iv.length > AD.periodSamples) iv.shift() }
    const wcap = budget * AD.winsor
    n++; wt += frameMs; sum += frameMs < wcap ? frameMs : wcap
    if (isNum(workMs) && workMs >= 0) { wn++; wsum += workMs < wcap ? workMs : wcap }
    if (wt < AD.windowMs || n < AD.minWindowFrames) return false
    const mean = sum / n, wmean = wn ? wsum / wn : NaN, span = wt
    resetWindow()
    return evaluate(mean, wmean, span)
  }
  ctl.setTargetFps = function (fps) {
    const b = 1000 / (fps > 0 ? fps : 60) * AD.slack
    if (b !== baseBudget) { baseBudget = b; setBudget(); resetWindow(); strikes = 0; goodMs = 0; probe = null }
  }
  // re-bound the scale range (the window was resized: the pixel budget scale changed). Returns true when the scale moved.
  ctl.setBounds = function (minS, maxS) {
    const oldMin = minScale, oldMax = maxScale
    minScale = isNum(minS) ? minS : minScale0; maxScale = Math.max(minScale, isNum(maxS) ? maxS : maxScale)
    if (minScale !== oldMin || maxScale !== oldMax) { cap = null; lastUp = null; probe = null }    // a resize: the ceiling was learned at another size
    const ns = q100(clamp(scale, minScale, maxScale))
    if (ns !== scale) { scale = ns; ctl.scale = ns; ctl.reason = 'bounds'; ctl.changes++; warm = AD.warmupMs; strikes = 0; goodMs = 0; resetWindow(); return true }
    return false
  }
  ctl.force = function (tier, s) {
    tierIdx = clamp(idx(tier, tierIdx), minTierIdx, maxTierIdx); scale = q100(clamp(isNum(s) ? s : nominal(tierIdx), minScale, maxScale))
    ctl.tier = TIER_ORDER[tierIdx]; ctl.scale = scale; ctl.reason = 'force'
    cap = null; lastUp = null; probe = null
    warm = AD.warmupMs; strikes = 0; goodMs = 0; resetWindow()
  }
  return ctl
}

// ═════════════════════════════════════════════ the quality director ═════════════════════════════════════════════
// The one object game.js talks to. It owns the preference -> (tier, scale, canvas size) policy:
//   graphicsQuality 'auto'    the adaptive controller, starting from the device class; scale limited by the class's
//                             internal pixel budget; the tier never rises above the class's tier
//   'low' | 'medium' | 'high' that tier at its own scale, no adaptation (the player chose)
//   'legacy'                  classic shading (no light model), scale 0.6, no DPR (the new art still applies)
// and writes the result into the shared renderOpts (qualityTier, renderScale, uiScale) for the renderer to read live.
export const GRAPHICS_CHOICES = Object.freeze(['auto', 'low', 'medium', 'high', 'legacy'])

export function createQualityDirector(o = {}) {
  const env = o.env || {}
  const cls = deviceClass(env)
  const classTier = TIER_FOR_CLASS[cls]
  let mode = GRAPHICS_CHOICES.includes(o.graphicsQuality) ? o.graphicsQuality : 'auto'
  let hiDpi = !!o.hiDpi
  let fpsCap = o.fpsCap === 30 || o.fpsCap === 60 ? o.fpsCap : 0
  let css = { w: 0, h: 0, dpr: 1 }
  let plan = { width: 0, height: 0, cssW: 0, cssH: 0, ratio: 1 }
  let ctl = null

  const targetFps = () => (fpsCap > 0 ? fpsCap : 60)
  const ready = () => { if (mode === 'auto' && !ctl) rebuild() }      // apply()/state before the first layout(): use an empty layout
  const tierName = () => { ready(); return mode === 'auto' ? ctl.tier : mode }
  const cssScale = () => { ready(); return mode === 'auto' ? ctl.scale : qualityFor(mode).scale }

  // (re)compute the canvas plan and the controller's scale bounds for the current size and preferences
  function rebuild() {
    const useDpr = hiDpi && mode !== 'legacy'
    const minCss = mode === 'auto' ? 0.4 : qualityFor(mode).scale
    plan = planCanvas({ cssW: css.w, cssH: css.h, dpr: css.dpr, hiDpi: useDpr, minCssScale: minCss })
    if (mode !== 'auto') { ctl = null; return }
    // the lowest css scale whose renderScale (= cssScale / ratio) is still >= 0.3; the 0.002 absorbs the width rounding
    // in planCanvas (1707/1280 is a hair over 4/3), so the spec's 0.4 floor stays reachable
    const lo = Math.max(0.4, q100(Math.ceil((RENDER_SCALE_FLOOR * plan.ratio - 0.002) * 20) / 20))
    const hi = budgetScale(plan.cssW, plan.cssH, INTERNAL_PX_BUDGET[cls], lo, 0.9)
    if (!ctl) {
      ctl = createAdaptiveController({ tier: classTier, maxTier: classTier, minScale: lo, maxScale: hi, scale: Math.min(TIERS[classTier].scale, hi), targetFps: targetFps() })
    } else ctl.setBounds(lo, hi)
  }

  const self = {
    deviceClass: cls,
    get mode() { return mode },
    // the window was resized / the pixel ratio changed -> the canvas plan to apply (width/height backing, cssW/cssH display)
    layout(cssW, cssH, dpr) { css = { w: cssW, h: cssH, dpr: isNum(dpr) && dpr > 0 ? dpr : 1 }; rebuild(); return plan },
    // a preference changed; returns true when the canvas plan may have changed (call layout again)
    setPrefs(p) {
      let relayout = false
      if (p.graphicsQuality !== undefined && GRAPHICS_CHOICES.includes(p.graphicsQuality) && p.graphicsQuality !== mode) { mode = p.graphicsQuality; ctl = null; relayout = true }
      if (p.hiDpi !== undefined && !!p.hiDpi !== hiDpi) { hiDpi = !!p.hiDpi; relayout = true }
      if (p.fpsCap !== undefined) { const c = p.fpsCap === 30 || p.fpsCap === 60 ? p.fpsCap : 0; if (c !== fpsCap) { fpsCap = c; if (ctl) ctl.setTargetFps(targetFps()) } }
      if (relayout && css.w > 0) rebuild()
      return relayout
    },
    // one processed frame; true when the tier / scale changed (call apply)
    frame(rawMs, workMs) { return mode === 'auto' && ctl ? ctl.update(rawMs, workMs) : false },
    apply(ro) {
      ro.qualityTier = tierName()
      ro.uiScale = plan.ratio                          // canvas px per css px: overlays with fixed pixel sizes should multiply by it
      if (mode === 'legacy' || (mode !== 'auto' && plan.ratio === 1)) delete ro.renderScale
      else ro.renderScale = renderScaleFor(cssScale(), plan.ratio)
      return ro
    },
    get state() { return { mode, tier: tierName(), cssScale: cssScale(), ratio: plan.ratio, width: plan.width, height: plan.height, deviceClass: cls, changes: ctl ? ctl.changes : 0, atFloor: ctl ? ctl.atFloor : false } },
  }
  return self
}

// ══════════════════════════════════════════════ renderer selection ══════════════════════════════════════════════
// SCAFFOLDING for the WebGL milestone: pure functions taking every input as an argument, wired to nothing yet.
// The CPU raycaster is always the fallback and is NEVER replaced by software GL (SwiftShader & co. are slower than the
// raycaster). Kill switches: pref `renderer: auto|gpu|cpu` and the ?renderer=cpu URL override.
const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|\bwarp\b|mesa offscreen/i
export function isSoftwareGl(unmaskedRenderer) {
  return typeof unmaskedRenderer === 'string' && SOFTWARE_GL.test(unmaskedRenderer)
}
// '?renderer=cpu' / '?renderer=gpu' (a query string or a URLSearchParams) -> 'cpu' | 'gpu' | null
export function parseRendererOverride(search) {
  try {
    const p = typeof search === 'string' ? new URLSearchParams(search) : search
    const v = p && p.get ? String(p.get('renderer') || '').toLowerCase() : ''
    return v === 'cpu' || v === 'gpu' ? v : null
  } catch { return null }
}

// env = { pref: 'auto'|'gpu'|'cpu', urlOverride: 'cpu'|'gpu'|null, softwareRender: boolean (the Electron "software
//         rendering" setting), probe: null | { webgl2: boolean, majorPerformanceCaveat?: boolean },
//         unmaskedRenderer: string|null, crashMarker: null | { armedAt, count }, now: ms,
//         allowSoftware: boolean (TEST HARNESS ONLY: skip rule 4 so the GL path can be exercised on SwiftShader) }
// -> { backend: 'cpu' | 'gpu', reason }. First matching rule wins:
//   1 ?renderer=cpu  2 pref cpu  3 not probed / no WebGL2  4 software GL (caveat flag or UNMASKED_RENDERER)
//   5 softwareRender setting  6 crash loop (unless ?renderer=gpu)  7 forced gpu  8 auto -> gpu
export function pickRenderer(env = {}) {
  const pref = env.pref === 'gpu' || env.pref === 'cpu' ? env.pref : 'auto'
  const url = env.urlOverride === 'cpu' || env.urlOverride === 'gpu' ? env.urlOverride : null
  const cpu = (reason) => ({ backend: 'cpu', reason })
  if (url === 'cpu') return cpu('url-cpu')
  if (pref === 'cpu') return cpu('pref-cpu')
  const probe = env.probe
  if (!probe) return cpu('not-probed')
  if (!probe.webgl2) return cpu('no-webgl2')
  if (!env.allowSoftware && (probe.majorPerformanceCaveat || isSoftwareGl(env.unmaskedRenderer))) return cpu('software-gl')
  if (env.softwareRender) return cpu('software-render-setting')
  if (url !== 'gpu' && crashLoopTripped(env.crashMarker, env.now)) return cpu('crash-loop')
  if (url === 'gpu' || pref === 'gpu') return { backend: 'gpu', reason: 'forced' }
  return { backend: 'gpu', reason: 'auto' }
}

// ── crash-loop breaker ── the caller persists the marker (a small JSON blob in localStorage). Lifecycle:
//   start:  marker = armCrashMarker(stored, now)  ->  persist  ->  first GL frame
//   frames: after each healthy frame, marker = tickCrashMarker(marker, healthyFrames); a null result = clear storage
//   next start: crashLoopTripped(stored, now) is pickRenderer's rule 6
// A marker that is never cleared means the page died before N healthy frames (a GPU process crash, a hard freeze).
// After CRASH_LIMIT such starts in a row (so: the start AFTER the second one) the GPU path is disabled; a marker older than a day is ignored. renderer.js
// gives the marker back on a clean unload (pagehide) and on a level change, and also clears it after a few seconds of healthy frames on a slow GPU.
export const CRASH_LIMIT = 2
export const CRASH_HEALTHY_FRAMES = 120
export const CRASH_EXPIRY_MS = 24 * 3600 * 1000
const markerValid = (m, now) => !!m && isNum(m.count) && m.count > 0 && isNum(m.armedAt) && !(isNum(now) && now - m.armedAt > CRASH_EXPIRY_MS)
export function armCrashMarker(prev, now) {
  return { armedAt: isNum(now) ? now : 0, count: (markerValid(prev, now) ? prev.count : 0) + 1 }
}
export function tickCrashMarker(marker, healthyFrames) {
  return healthyFrames >= CRASH_HEALTHY_FRAMES ? null : marker
}
export function crashLoopTripped(marker, now, limit = CRASH_LIMIT) {
  return markerValid(marker, now) && marker.count >= limit
}

// ══════════════════════════════════════════ GPU health monitor (policy) ══════════════════════════════════════════
// The eventual `auto` mode (and an explicit gpu choice) needs a way to notice that the GL path is unusably slow on a device we cannot test.
// A CPU-side timer around render() cannot see GPU time (WebGL is asynchronous), so the monitor is fed the REAL interval between processed
// animation frames (game.js: rawMs). It reports 'healthy' | 'slow'. 'slow' means: the frame interval stayed above slowFactor x the frame budget
// for several seconds (consecutive windows) while the adaptive resolution was already at its FLOOR (it cannot help any more). Whether the CPU
// path would be faster is NOT knowable, so the policy is conservative: it only ever fires from that combination, never while the scale can
// still drop, and never for a stall (a hidden tab, a debugger pause: frames over stallMs are ignored). Pure state machine, no clocks or timers.
export const GPU_HEALTH = Object.freeze({
  slowFactor: 2,        // a window is slow when its mean frame interval is above this x the budget
  windowMs: 3000,       // window length (accumulated frame time)
  windows: 2,           // consecutive slow windows before 'slow' is reported (>= 6 s in all)
  warmupMs: 3000,       // ignore the start (shader warm-up, texture uploads, first-frame hitches)
  stallMs: 1000,        // a longer interval is a stall (tab in the background), not evidence
  minFrames: 20,        // a window needs this many frames to count
})

export function isSlowWindow(meanMs, budgetMs, atFloor, factor = GPU_HEALTH.slowFactor) {
  return !!atFloor && isNum(meanMs) && isNum(budgetMs) && budgetMs > 0 && meanMs > factor * budgetMs
}

export function createGpuHealth(cfg = {}) {
  const C = { ...GPU_HEALTH, ...cfg }
  let clock = 0, wt = 0, wn = 0, wsum = 0, floorAll = true, strikes = 0, verdict = 'healthy'
  const resetWindow = () => { wt = 0; wn = 0; wsum = 0; floorAll = true }
  const self = {
    // one processed frame: the real interval, the budget for the display/cap rate (ms), whether the render scale is at its minimum.
    update(frameMs, budgetMs, atFloor) {
      if (verdict === 'slow' || !isNum(frameMs) || frameMs <= 0) return verdict
      if (frameMs > C.stallMs) { resetWindow(); strikes = 0; return verdict }
      clock += frameMs
      if (clock < C.warmupMs) return verdict
      wt += frameMs; wn++; wsum += frameMs; if (!atFloor) floorAll = false
      if (wt < C.windowMs || wn < C.minFrames) return verdict
      const slow = isSlowWindow(wsum / wn, budgetMs, floorAll, C.slowFactor)
      resetWindow()
      strikes = slow ? strikes + 1 : 0
      if (strikes >= C.windows) verdict = 'slow'
      return verdict
    },
    get verdict() { return verdict },
    get strikes() { return strikes },
    reset() { clock = 0; strikes = 0; verdict = 'healthy'; resetWindow() },
  }
  return self
}

// May the selector abandon the GL path for this verdict? Only from an EXPLICIT choice ('auto' or 'gpu' — never a state the player did not opt into
// or that is already CPU) and only for 'slow'. The abandonment lasts for the session (no persisted marker: a slow machine may be a busy machine).
export function shouldDowngradeGpu({ verdict, kind, pref }) {
  return verdict === 'slow' && kind === 'gpu' && (pref === 'auto' || pref === 'gpu')
}
