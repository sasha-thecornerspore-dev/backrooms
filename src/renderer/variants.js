// variants.js — one learnable rule per creature, built on the existing art. Pure: no DOM, no audio, no strings.
//
// hunt.js runs the shared machine (roam / alert / investigate / hunt / search / stagger / turning) and calls stepVariant(e, dt, ctx,
// helpers, threat) every frame for every gated creature. A variant step returns TRUE when it owned the creature this frame (it moved or
// held it and set its phase; hunt.stepAI skips its own move and transitions) and FALSE when the shared machine should run. Variant phases
// (freeze, windup, lunge, recover, retreat, shadow, still, arcCharge) are entirely the variant's; the shared ones it only intercepts.
//
// ctx is hunt's one aiCtx object: { flashlight, sprinting, dark, fog, radioOn, lures, t, hf, playerAngle, player, damage }; `player`
// (x, y, angle) is where the thing looks for you and `damage` is the floor's contact damage. helpers (hunt.js; stubbed in tests) =
// { moveToward(e, x, y, speed) -> blocked, moveAway(e, x, y, speed) -> blocked, los(e, x, y) -> boolean, dist(e, x, y), hashT(e, salt),
// event(kind, e, extra) }. Nothing here allocates per frame: the per-entity fields are added once, events go through helpers.event.
import { inViewCone } from './raycaster.js'
import { HF } from './gfx-frame.js'

export const CRAWLER_DMG = 10
export const TESLA_ARC_DMG = 8

// Every phase any creature can be in: hunt.deriveState must map each into gfx-sprites STATES (idle / chase / flee / stagger).
export const VARIANT_PHASES = ['roam', 'alert', 'investigate', 'hunt', 'search', 'stagger', 'turning',
  'freeze', 'windup', 'lunge', 'recover', 'retreat', 'shadow', 'still', 'arcCharge']

const CONTACT = 0.62          // the contact radius (> max creatureRadius + PLAYER_R), shared with hunt's generic hit

// Frozen while on your screen == drawn on your screen: EXACTLY the sprite cull, and the same LOS the pass uses.
export function watched(e, player, hf, fog, los) {
  return !!los && inViewCone(player.x, player.y, player.angle, e.x, e.y, hf, fog)
}

// Lit: the beam is on it (flashlight, on screen, within 9), or the floor itself is lit.
export function litAt(e, ctx, isWatched) {
  if (!ctx.dark) return true
  if (!(ctx.flashlight && isWatched)) return false
  const dx = e.x - ctx.player.x, dy = e.y - ctx.player.y
  return dx * dx + dy * dy < 81
}

// Sight range for perception: the tesla hears a carried playing radio and looks farther for it.
export function sightRange(spec, ctx) { return spec.sightK ? spec.sight * spec.sightK(ctx) : spec.sight }

// ── per-entity bookkeeping ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// hunt.js lazily initialises its own fields; these are the variants'. Added once so the entity's shape stays stable afterwards.
function init(e) {
  if (e.phaseT !== undefined) return
  e.ai ??= 'roam'; e.stagger ??= 0; e.pending ??= 0
  e.phaseT = 0            // seconds in the current variant phase
  e.litT = 0              // lurker: continuous seconds under the light
  e.arcCd = 0             // tesla: seconds until it may charge again
  e.unseenT = 0           // watcher: seconds since it last saw you while shadowing
  e.lockDir = 0; e.lockX = 0; e.lockY = 0   // hound: the heading and your position when it gathered itself
  e.told = false          // smiler: the freeze line went out this hunt; lurker: the hunt was announced
}
function enter(e, phase) { e.ai = phase; e.phaseT = 0 }
function face(e, x, y) { e.dir = Math.atan2(y - e.y, x - e.x) }
function raiseGaze(threat, rate) { threat.gaze = true; if (!(threat.gazeRate >= rate)) threat.gazeRate = rate }
function raiseDmg(threat, dmg, kind) { if (dmg > threat.dmg) { threat.dmg = dmg; threat.dmgKind = kind } }
function hf(ctx) { return ctx.hf ?? HF }

// ── smiler: it does not move while it is on your screen; look away and it is on you faster than you walk ──────────────────────────
function smilerStep(e, dt, ctx, H, threat) {
  if (e.ai !== 'hunt' && e.ai !== 'freeze') { e.told = false; return false }
  const p = ctx.player
  if (watched(e, p, hf(ctx), ctx.fog, H.los(e, p.x, p.y))) {
    if (e.ai !== 'freeze') { enter(e, 'freeze'); face(e, p.x, p.y) }
    e.phaseT += dt
    raiseGaze(threat, 1.5)                                      // a 20 s standoff costs 30 sanity
    if (!e.told) { const d = H.dist(e, p.x, p.y); if (d < 6) { e.told = true; H.event('smiler-freeze', e, d) } }
    return true
  }
  if (e.ai === 'freeze') { enter(e, 'hunt'); H.moveToward(e, p.x, p.y, SMILER.hunt); return true }   // the first step the moment you look away
  return false
}

// ── hound: it stops dead, gathers itself for half a second, then lunges along the line it fixed on ────────────────────────────────
function houndStep(e, dt, ctx, H, threat) {
  const p = ctx.player
  if (e.ai === 'hunt') {
    const d = H.dist(e, p.x, p.y)
    if (!(d < 7) || !H.los(e, p.x, p.y)) return false
    enter(e, 'windup')
    face(e, p.x, p.y); e.lockDir = e.dir; e.lockX = p.x; e.lockY = p.y
    H.event('hound-windup', e, d)
    return true
  }
  if (e.ai === 'windup') {
    e.phaseT += dt
    e.dir = e.lockDir                                           // the lock: strafing does not turn it
    if (e.phaseT >= 0.55) enter(e, 'lunge')
    return true
  }
  if (e.ai === 'lunge') {
    e.phaseT += dt
    const cs = Math.cos(e.lockDir), sn = Math.sin(e.lockDir)
    const blocked = H.moveToward(e, e.x + cs * 2, e.y + sn * 2, 6.5)
    if (H.dist(e, p.x, p.y) < CONTACT) raiseDmg(threat, (ctx.damage ?? 16) * 1.25, 'lunge')
    const past = (e.x - e.lockX) * cs + (e.y - e.lockY) * sn    // how far beyond where you stood when it gathered itself
    if (past > 0.3) { H.event('hound-pass', e, past); enter(e, 'recover') }
    else if (blocked || e.phaseT >= 0.6) enter(e, 'recover')
    return true
  }
  if (e.ai === 'recover') {
    e.phaseT += dt
    H.moveToward(e, e.x + Math.cos(e.dir) * 2, e.y + Math.sin(e.dir) * 2, 0.3)
    if (e.phaseT >= 1.1) enter(e, 'hunt')
    return true
  }
  return false
}

// ── lurker: it moves only when you are not lighting it; hold the light on it long enough and it goes ─────────────────────────────
function lurkerStep(e, dt, ctx, H, threat) {
  const p = ctx.player
  if (e.ai === 'hunt' || e.ai === 'freeze') {
    if (!e.told) { e.told = true; H.event('lurker-hunt', e, H.dist(e, p.x, p.y)) }
    if (litAt(e, ctx, watched(e, p, hf(ctx), ctx.fog, H.los(e, p.x, p.y)))) {
      e.litT += dt
      if (e.ai !== 'freeze') { enter(e, 'freeze'); face(e, p.x, p.y) }
      if (e.litT >= 1.2) { e.litT = 0; enter(e, 'retreat') }
      return true
    }
    e.litT = 0
    if (e.ai === 'freeze') { enter(e, 'hunt'); H.moveToward(e, p.x, p.y, LURKER.hunt); return true }
    return false
  }
  if (e.ai === 'retreat') {
    e.phaseT += dt
    H.moveAway(e, p.x, p.y, 2.0)
    if (e.phaseT >= 3.0) enter(e, 'search')
    return true
  }
  e.told = false; e.litT = 0
  return false
}

// ── watcher: it never touches you; watching it back costs you; it keeps its distance and faces the camera ─────────────────────────
function watcherStep(e, dt, ctx, H, threat) {
  const p = ctx.player
  const d = H.dist(e, p.x, p.y)
  const seen = d <= WATCHER.sight && H.los(e, p.x, p.y)
  if (d < 12 && watched(e, p, hf(ctx), ctx.fog, seen)) raiseGaze(threat, 3)
  if (e.ai === 'shadow') {
    e.phaseT += dt
    if (seen) e.unseenT = 0
    else if ((e.unseenT += dt) > WATCHER.loseTrack) { e.unseenT = 0; enter(e, 'roam'); return true }
    if (d < 4.5) { enter(e, 'retreat'); H.moveAway(e, p.x, p.y, 1.4); return true }
    if (d < 6) H.moveAway(e, p.x, p.y, 1.4)
    else if (d > 9) H.moveToward(e, p.x, p.y, 1.4)
    face(e, p.x, p.y)
    return true
  }
  if (e.ai === 'retreat') {
    e.phaseT += dt
    H.moveAway(e, p.x, p.y, 1.4)
    if (d >= 6 || e.phaseT > 4) enter(e, 'shadow')
    return true
  }
  if (seen) { enter(e, 'shadow'); e.unseenT = 0; face(e, p.x, p.y); return true }
  return false
}

// ── crawler: it lies still in the dark and takes your ankles when the beam leaves it ──────────────────────────────────────────────
function crawlerStep(e, dt, ctx, H, threat) {
  const p = ctx.player
  if (e.ai === 'lunge') {
    e.phaseT += dt
    H.moveToward(e, p.x, p.y, 4.5)
    if (H.dist(e, p.x, p.y) < CONTACT) { raiseDmg(threat, CRAWLER_DMG, 'contact'); H.event('crawler', e, 0); enter(e, 'retreat') }
    else if (e.phaseT >= 1.0) enter(e, 'retreat')
    return true
  }
  if (e.ai === 'retreat') {
    e.phaseT += dt
    H.moveAway(e, p.x, p.y, 1.6)
    if (e.phaseT >= 4) enter(e, 'still')
    return true
  }
  if (e.ai !== 'still') enter(e, 'still')                       // whatever the shared machine decided, it lies still
  const d = H.dist(e, p.x, p.y)
  if (d < 3.0) {
    const seen = H.los(e, p.x, p.y)
    if (seen && !litAt(e, ctx, watched(e, p, hf(ctx), ctx.fog, seen))) { enter(e, 'lunge'); face(e, p.x, p.y) }
  }
  return true
}

// ── tesla: a turret that hums at range; a dropped radio draws it; a wall between you cancels the jolt ─────────────────────────────
function nearestLure(e, lures) {
  if (!lures || lures.length === 0) return null
  let best = null, bd = Infinity
  for (let i = 0; i < lures.length; i++) {
    const l = lures[i], dx = l.x - e.x, dy = l.y - e.y, d2 = dx * dx + dy * dy
    if (d2 < bd) { bd = d2; best = l }
  }
  return best
}
function teslaStep(e, dt, ctx, H, threat) {
  if (e.arcCd > 0) e.arcCd -= dt
  const p = ctx.player
  if (e.ai === 'hunt') {
    const d = H.dist(e, p.x, p.y)
    const seen = H.los(e, p.x, p.y)
    if (seen && d < 4.5 && e.arcCd <= 0) { enter(e, 'arcCharge'); face(e, p.x, p.y); threat.arcPending = true; return true }
    const lure = nearestLure(e, ctx.lures)
    if (lure) { H.moveToward(e, lure.x, lure.y, TESLA.hunt); return true }   // the radio over you: setting it down is the play
    if (seen) { H.moveToward(e, p.x, p.y, TESLA.hunt); return true }
    return false                                                // out of sight: the shared machine keeps its last-seen logic
  }
  if (e.ai === 'arcCharge') {
    e.phaseT += dt
    if (!H.los(e, p.x, p.y)) { enter(e, 'hunt'); return true }  // breaking LOS cancels
    if (e.phaseT < 0.5) { threat.arcPending = true; return true }
    const d = H.dist(e, p.x, p.y)
    if (d < 4.5) { raiseDmg(threat, TESLA_ARC_DMG, 'arc'); H.event('arc', e, d) }
    e.arcCd = 1.4
    enter(e, 'hunt')
    return true
  }
  return false
}

// ── the table ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// roam / hunt: speeds (u/s); sight: perception range (hunt.js halves it in the dark unless the variant ignores the dark); hearK:
// hearing multiplier; loseTrack: seconds without LOS before a hunt becomes a search; dispelAt / staggerT / wardMul: what a ward does
// to it; hostilePhases: where contact (< 0.62) hits; step: the variant hook or null; dispelEvent: pushed by ward() when it dispels
// one; sightK(ctx): a sight multiplier read through sightRange().
function spec(o) {
  return { roam: 0.5, hunt: 3.3, sight: 12, hearK: 1, loseTrack: 3.5, dispelAt: 3, staggerT: 2.6, wardMul: 1,
    hostilePhases: new Set(['hunt']), step: null, dispelEvent: null, sightK: null, ...o }
}
const SHADE   = spec({})
const SMILER  = spec({ roam: 0.4, hunt: 3.6, sight: 13, hostilePhases: new Set(['hunt', 'freeze']), step: smilerStep })
const HOUND   = spec({ roam: 0.8, hunt: 2.0, sight: 10, hearK: 1.6, loseTrack: 6, dispelAt: 2, staggerT: 2.0, wardMul: 2,
  hostilePhases: new Set(['hunt', 'lunge']), step: houndStep })
const LURKER  = spec({ roam: 0.3, hunt: 3.4, sight: 18, step: lurkerStep })
// the watcher's hunt speed is never walked (shadow intercepts the hunt); it sits in the walk..sprint band so a fallthrough is still a chase
const WATCHER = spec({ roam: 0.6, hunt: 3.2, sight: 16, dispelAt: 1, staggerT: 1.5, hostilePhases: new Set(), step: watcherStep,
  dispelEvent: 'watcher-dispelled' })
// the crawler's roam is lying still; its hunt speed is the lunge
const CRAWLER = spec({ roam: 0, hunt: 4.5, sight: 3, hearK: 0.5, dispelAt: 2, staggerT: 2.0, hostilePhases: new Set(['lunge']), step: crawlerStep })
const TESLA   = spec({ roam: 0.5, hunt: 1.1, sight: 11, dispelAt: 2, staggerT: 1.3, hostilePhases: new Set(['hunt', 'arcCharge']),
  step: teslaStep, sightK: ctx => (ctx.radioOn ? 1.5 : 1) })

export const VARIANT_SPEC = { shade: SHADE, smiler: SMILER, hound: HOUND, lurker: LURKER, watcher: WATCHER, crawler: CRAWLER, tesla: TESLA }

export function specFor(variant) { return VARIANT_SPEC[variant] || SHADE }

// Dispatch. Reeling, turning and still-arriving creatures belong to hunt.js whatever their variant.
export function stepVariant(e, dt, ctx, helpers, threat) {
  const s = specFor(e.variant)
  if (!s.step) return false
  init(e)
  if (e.stagger > 0 || e.pending > 0 || e.ai === 'stagger' || e.ai === 'turning') return false
  return s.step(e, dt, ctx, helpers, threat) === true
}
