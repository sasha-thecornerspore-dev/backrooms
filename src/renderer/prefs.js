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
  grain:            true,   // film-grain overlay
  crosshair:        true,   // centre dot
  headBob:          true,   // walking view bob
  mouseSensitivity: 100,    // % — 100% == the classic 0.002 rad/px
  creatures:        true,   // do things spawn below level 0 at all
  damage:           true,   // can they hurt you (peaceful mode == false)
}

let cache = null
const listeners = new Set()

function load() {
  if (cache) return cache
  let stored = {}
  try { stored = JSON.parse(localStorage.getItem(KEY)) || {} } catch { stored = {} }
  cache = { ...PREF_DEFAULTS, ...stored }
  return cache
}

export function getPrefs() { return { ...load() } }
export function getPref(k) { return load()[k] }

export function setPref(k, v) {
  const p = load()
  if (p[k] === v) return
  p[k] = v
  try { localStorage.setItem(KEY, JSON.stringify(p)) } catch { /* non-browser / private mode */ }
  for (const cb of listeners) { try { cb(k, v, p) } catch { /* ignore */ } }
}

// Subscribe to changes; returns an unsubscribe fn.
export function onPrefChange(cb) { listeners.add(cb); return () => listeners.delete(cb) }
