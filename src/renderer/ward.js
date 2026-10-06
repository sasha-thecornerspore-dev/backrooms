// ward.js — the ward as a verb with two weights: tap it and it is the shove you
// know; hold it and your steps slow while the air tightens, then a narrower,
// longer push throws the thing four units back.
//
// Pure. game.js owns the stamina, the keys and the messages; this module owns
// the timing. press / release are monotonically increasing EDGE COUNTS, not a
// held boolean: a touch tap that starts and ends inside one frame still shows
// up as both counts moving, so it still fires.
//
// createWardCharger() -> { tick(dt, press, release, stamina), forceRelease(), isCharging() }
//   tick -> null                                        nothing happened this frame
//        -> { charging: true, holdT, moveMul, drain }    latched: slow the player, drain stamina at `drain`/s
//        -> { charged, holdT, cost }                     fired: charge `cost`, ward with wardOpts(charged)
//        -> { denied: 'winded' }                         released without the legs for it; no cooldown
//   the hold caps at HOLD_MAX and auto-fires charged, dropping the latch, so a lost keyup can never hold it
//   forceRelease() drops a latch without firing (chat open, blur, pointer-lock exit)
// wardOpts(charged) -> WARD_TAP | WARD_CHARGED, the opts entitySys.ward takes
export const WARD_TAP     = Object.freeze({ range: 2.6, cone: 0.7 * Math.PI,  knockback: 1.7, hits: 1 })   // today's defaults
export const WARD_CHARGED = Object.freeze({ range: 4.0, cone: 0.39 * Math.PI, knockback: 3.2, hits: 2 })

export function wardOpts(charged) { return charged ? WARD_CHARGED : WARD_TAP }

const CHARGE_AT   = 0.4    // held this long → charged
const HOLD_MAX    = 1.0    // held this long → fires on its own
const MOVE_MUL    = 0.55
const DRAIN       = 6      // stamina per second while charging
const COST_TAP    = 20, COST_CHARGED = 35
const CD_TAP      = 0.65, CD_CHARGED  = 1.2
const DENIED      = Object.freeze({ denied: 'winded' })

export function createWardCharger() {
  let lastPress = 0, lastRelease = 0
  let latched = false, holdT = 0, cd = 0
  const charging = { charging: true, holdT: 0, moveMul: MOVE_MUL, drain: DRAIN }
  const fired    = { charged: false, holdT: 0, cost: 0 }

  function fire(charged, stamina) {
    latched = false
    const cost = charged ? COST_CHARGED : COST_TAP
    if (stamina < cost) return DENIED
    cd = charged ? CD_CHARGED : CD_TAP
    fired.charged = charged; fired.holdT = holdT; fired.cost = cost
    return fired
  }

  function tick(dt, press, release, stamina) {
    if (cd > 0) cd = Math.max(0, cd - dt)
    const pressed = press !== lastPress, released = release !== lastRelease
    lastPress = press; lastRelease = release
    if (latched) holdT += dt
    // a press during the cooldown never latches: the legs are still recovering,
    // and its release then falls on nothing
    else if (pressed && cd <= 0) { latched = true; holdT = 0 }
    if (!latched) return null
    if (released) return fire(holdT >= CHARGE_AT, stamina)
    if (holdT >= HOLD_MAX) return fire(true, stamina)
    charging.holdT = holdT
    return charging
  }

  function forceRelease() { latched = false; holdT = 0 }
  function isCharging() { return latched }

  return { tick, forceRelease, isCharging }
}
