// plaque.js — the plaque on the block's lightpost (wish #5). Pure: no DOM, no audio, no prefs, no net.
//
// "uh id like a big plaque on the wall with me and maddies name on it" — granted by the owner: "grant the wish. make it viewable on
// a lightpost at the 806 N Carey maze", and what it says is the owner's: "Mads n Dads were here". The lightpost stands in the park on
// Level ∅ (level-null-map.js NULL_LIGHTPOST; levels.js sightsAt draws it, gfx-sprites.js lightpostFrame, and makes it a body). Within
// PLAQUE_REACH of it the prompt reads PLAQUE_HINT and E lays the plaque on the paper card (game.js openPlaque): those words, as the
// owner wrote them, and nothing else.

export const PLAQUE_TEXT = 'Mads n Dads were here'
export const PLAQUE_REACH = 1.6
export const PLAQUE_HINT = 'e · read the plaque'

// the card's text: the plaque's words
export function plaqueText() { return PLAQUE_TEXT }

// is p within reach of the plaque at `at` (a level's cfg.plaque; none: never)?
export function nearPlaque(p, at, reach = PLAQUE_REACH) {
  if (!p || !at) return false
  const dx = p.x - at.x, dy = p.y - at.y
  return dx * dx + dy * dy <= reach * reach
}
