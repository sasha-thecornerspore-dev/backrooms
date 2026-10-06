// input.js — the keydown gate: what the game's key map may take from a keydown, and whether the browser default goes with it.
//
// takeKey(e, { activeTag, isContentEditable, locked, settingsOpen }) -> 'ignore' | 'take' | 'take-prevent'
//   'ignore'        a text field has focus (typing a webhook into settings must not play the game), or a held edge-triggered verb repeats
//   'take-prevent'  Space always (the page must never scroll), Tab while the game owns focus (pointer locked, or nothing but the body /
//                   canvas focused) with the settings panel hidden — the panel's own tab order wins while it is open
//   'take'          everything else
const EDITABLE   = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
const NO_REPEAT  = new Set(['KeyF', 'KeyE', 'Space', 'Tab', 'KeyQ', 'KeyX'])   // verbs fire once per press, however long it is held
const GAME_FOCUS = new Set(['BODY', 'CANVAS'])
const NONE = {}

export function takeKey(e, state) {
  const s = state || NONE
  if (EDITABLE.has(s.activeTag) || s.isContentEditable) return 'ignore'
  if (e.repeat && NO_REPEAT.has(e.code)) return 'ignore'
  if (e.code === 'Space') return 'take-prevent'
  if (e.code === 'Tab' && !s.settingsOpen && (s.locked || s.activeTag == null || GAME_FOCUS.has(s.activeTag))) return 'take-prevent'
  return 'take'
}
