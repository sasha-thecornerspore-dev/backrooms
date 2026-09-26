// prefs.js — player-facing gameplay & audio-visual preferences.
//
// Renderer-only, persisted to localStorage. These are the knobs that make every
// added system optional: music, ambience, grain, crosshair, head-bob, mouse
// sensitivity, whether creatures spawn, and whether they can hurt you. The
// main-process settings.js keeps only the launch-critical flags (auto-update,
// software rendering) that must be read before the window exists.
//
// Everything is lazy + guarded so importing this in a non-browser (test) context
// never throws — localStorage access simply falls back to defaults.

const KEY = 'backrooms:prefs'

export const PREF_DEFAULTS = {
  music:            true,   // generative weirdcore music bed
  musicVolume:      60,     // % of each level's base music level (0–150)
  ambience:         true,   // fluorescent hum / drone / distant events
  ambienceVolume:   100,    // % of the environmental layer's base level (0–150)
  track:            -1,     // -1 = each floor's own mood; 0..n = an alternate from TRACKS (N cycles)
  grain:            true,   // film-grain overlay
  particles:        true,   // dust / steam / spark motes
  crosshair:        true,   // centre dot
  headBob:          true,   // walking view bob
  mouseSensitivity: 100,    // % — 100% == the classic 0.002 rad/px
  creatures:        true,   // do things spawn below level 0 at all
  damage:           true,   // can they hurt you (peaceful mode == false)
  beaconEffect:     'off',  // 'off' | 'ntfy' | 'discord' | 'custom' — what B fires
  beaconWebhook:    '',     // ntfy topic, or an https webhook url, per beaconEffect

  // ── graphics & comfort (track D) ──
  graphicsQuality:  'auto', // 'auto' (adapts to the device) | 'low' | 'medium' | 'high' | 'legacy' (classic shading: distance fog, no light model)
  reduceFlicker:    false,  // gentler light dips + camera flash; the DEFAULT follows prefers-reduced-motion (see deviceDefaults)
  fpsCap:           0,      // 0 = display rate | 30 | 60 — skips animation frames
  hiDpi:            false,  // opt-in: a canvas backing store sharper than css pixels on dpr > 1 (costs some speed)
  renderer:         'auto', // 'auto' | 'gpu' | 'cpu' — RESERVED: the WebGL kill switch; no settings UI yet (renderer.js honours an explicit 'gpu' only)
}

// The enumerated prefs. A value that is not on the list (a stale or hand-edited localStorage entry, a select that
// hands us the string '30') is coerced or replaced by the default, so nothing invalid can reach the renderer.
export const PREF_CHOICES = {
  graphicsQuality: ['auto', 'low', 'medium', 'high', 'legacy'],
  fpsCap:          [0, 30, 60],
  renderer:        ['auto', 'gpu', 'cpu'],
}
const BOOL_PREFS = ['reduceFlicker', 'hiDpi']

// Defaults that depend on the device rather than being constants. Guarded: importing this in Node (tests) or before
// matchMedia exists must never throw.
function reducedMotion() {
  try { return typeof globalThis.matchMedia === 'function' && !!globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}
function deviceDefaults() { return { reduceFlicker: reducedMotion() } }
export function defaultFor(k) { return k in deviceDefaults() ? deviceDefaults()[k] : PREF_DEFAULTS[k] }

// -> a valid value for k (the default when v is not acceptable); keys with no rule pass through untouched
export function normalizePref(k, v) {
  const choices = PREF_CHOICES[k]
  if (choices) {
    const x = typeof choices[0] === 'number' && typeof v === 'string' && v.trim() !== '' ? Number(v) : v
    return choices.includes(x) ? x : PREF_DEFAULTS[k]
  }
  if (BOOL_PREFS.includes(k)) return typeof v === 'boolean' ? v : defaultFor(k)
  return v
}

let cache = null
let overrides = {}            // ONLY what the player (or a stored save) set: device defaults are resolved at load, never persisted
let mqlHooked = false
const listeners = new Set()

function load() {
  if (cache) return cache
  let stored = {}
  try { stored = JSON.parse(localStorage.getItem(KEY)) || {} } catch { stored = {} }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {}
  overrides = { ...stored }
  cache = { ...PREF_DEFAULTS, ...deviceDefaults(), ...stored }
  for (const k of [...Object.keys(PREF_CHOICES), ...BOOL_PREFS]) {
    cache[k] = normalizePref(k, cache[k])
    if (k in overrides && overrides[k] !== cache[k]) delete overrides[k]       // an invalid stored value is no choice at all
  }
  hookMotionQuery()
  return cache
}

// A device default (reduceFlicker <- prefers-reduced-motion) follows the OS live while the player has not chosen it.
function hookMotionQuery() {
  if (mqlHooked) return
  mqlHooked = true
  try {
    if (typeof globalThis.matchMedia !== 'function') return
    const mql = globalThis.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => {
      if (!cache || 'reduceFlicker' in overrides) return
      const v = reducedMotion()
      if (cache.reduceFlicker === v) return
      cache.reduceFlicker = v
      for (const cb of listeners) { try { cb('reduceFlicker', v, cache) } catch { /* ignore */ } }
    }
    if (mql && typeof mql.addEventListener === 'function') mql.addEventListener('change', onChange)
    else if (mql && typeof mql.addListener === 'function') mql.addListener(onChange)
  } catch { /* no matchMedia: nothing to follow */ }
}

export function getPrefs() { return { ...load() } }
export function getPref(k) { return load()[k] }

export function setPref(k, v) {
  const p = load()
  v = normalizePref(k, v)
  const same = p[k] === v
  if (same && k in overrides) return
  overrides[k] = v                                     // an explicit choice, even one equal to today's default
  p[k] = v
  try { localStorage.setItem(KEY, JSON.stringify(overrides)) } catch { /* non-browser / private mode */ }
  if (same) return
  for (const cb of listeners) { try { cb(k, v, p) } catch { /* ignore */ } }
}

// Subscribe to changes; returns an unsubscribe fn.
export function onPrefChange(cb) { listeners.add(cb); return () => listeners.delete(cb) }
