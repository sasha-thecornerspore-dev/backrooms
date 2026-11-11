// token.js — the way out token (wish #29, "what is the way out?!"). Pure: no DOM, no audio, no prefs, no net.
//
// A thing with no use anyone can see, that seems important not to throw away. It is kept like the deep-stack finds (items.js KEPT,
// death.js): it is never set down, never thrown, never lost in a fall, and using it spends nothing. What it is for is the owner's to
// decide in a later release; until then it only says what it is. A vending machine on any floor drops one, rarely, to someone who holds
// none: one is all a hand ever carries, so the token can never fill the six slots with something that will not leave them.

export const TOKEN = 'way-out-token'
export const TOKEN_LINE = 'a way out token. you do not know what it opens. it seems important not to throw it away.'
// one machine draw in this many is the token (when the hand holds none)
export const TOKEN_ODDS = 25

// does this machine draw give the token? inventory: the hand's slots ([{ type }]); roll: one Math.random() draw in [0, 1)
export function trayToken(inventory, roll) {
  if (Array.isArray(inventory) && inventory.some((it) => it && it.type === TOKEN)) return false
  return typeof roll === 'number' && roll >= 0 && roll < 1 / TOKEN_ODDS
}
