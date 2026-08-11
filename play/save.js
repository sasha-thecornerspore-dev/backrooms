// save.js — local persistence of a solo run: which level you're on, where you
// stand, your hit points, and your whole inventory. Auto-saved as you play and
// on quit; "Continue" on the title screen drops you back exactly where you left.
// Renderer-only (localStorage); guarded so importing it in tests never throws.
const KEY = 'backrooms:save'

export function writeSave(state) {
  try { localStorage.setItem(KEY, JSON.stringify({ v: 1, ...state })) } catch { /* private mode / non-browser */ }
}

export function readSave() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY))
    return (s && s.v === 1) ? s : null
  } catch { return null }
}

export function clearSave() { try { localStorage.removeItem(KEY) } catch { /* ignore */ } }

export function hasSave() { return !!readSave() }
