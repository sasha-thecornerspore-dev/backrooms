import { loadConfig, CHUNK_SIZE, createChunkCache, createGridReader } from './world.js'
import { createFixedMap } from './fixedmap.js'
import { levelConfig, TRACKS } from './levels.js'
import { createEntitySystem } from './entities.js'
import { createItemSystem, KEPT } from './items.js'
import { createDecorSystem } from './decor.js'
import { createRenderer } from './renderer.js'
import { initAudio, setFlicker, setRadio, setMusic, setMood, setMusicEnabled, setMusicVolume, setAmbience, setAmbienceVolume, blip, heartbeat, whisper, wardPulse, doorSlam, footfall, humDuck, drawerSlide, whistle, bump } from './audio.js'
import { getPref, setPref, onPrefChange } from './prefs.js'
import { readDeviceEnv, createQualityDirector, createFramePacer, createFlickerState, stepFlicker, flashFor, flashWait, noteFlash, DEFAULT_MAX_GLOBAL_DIP, qualityFor } from './gfx-quality.js'
import { statsEnabled, createStatsOverlay } from './gfx-stats.js'
import { writeSave } from './save.js'
import { formatAnchor, driftMeters, anchorSeed } from './anchor.js'
import { initTouchControls, isTouchDevice } from './touch.js'
import { SCRAPS } from './scraps.js'
import { createEventScheduler, EVENTS } from './events.js'
import { createMessageQueue, PRIO } from './messages.js'
import { takeKey } from './input.js'
import { createSolidWorld, createColliderIndex, movePoint, PLAYER_R } from './collide.js'
import { bumpKindFor, bumpIntensity, isHardBump, createBumpGate, BUMP_LINES } from './feedback.js'
import { CLUTTER_LINES } from './placement.js'
import { hostile, solidCreature } from './hunt.js'
import { quiet, lureWithin, createCommit, QUIET_SECONDS } from './tactics.js'
import { createWardCharger, wardOpts, WARD_TAP } from './ward.js'
import { createTension, huntDelta, calmDelta } from './tension.js'
import { FOV, HF } from './gfx-frame.js'
import { waysFor, stairsPass, chunkMid, findOpenNear, arrivalFor, wayMessage, wayLabel } from './topology.js'
import { createLevelMemory, applyResume } from './levelmem.js'
import { resolveDeath, onArrive, wakeSpot } from './death.js'
import { createFogMap, revealRadius } from './fogmap.js'
import { visibleWays, SIGHT_LINES, PROX_PIN } from './sightpins.js'
import { createMapCard } from './mapcard.js'
import { compassLines, compassText, arrivalSummary } from './compass.js'
import { lineOfSight, inViewCone } from './raycaster.js'
import { dressPass } from './dress.js'
import { CONTAINER_TYPES, SEARCH_HOLD_S, DRAWER_COST, rollContainer, applyRoll, createSearchLog } from './containers.js'
import { hauntsPass, createHauntTracker, hauntEffects } from './haunts.js'
import { createCard, CARD_KEYS, readText } from './papercard.js'
import { createEvBus } from '../net/evbus.js'
import { intake, filingLine, formText, FORM_FOOT, parseIntakeCommand, normaliseIntakeCtx, identityOut, identityIn } from './origin-intake.js'
import { rulesFor, LEGACY } from './origin-rules.js'
import { DOOR_SANITY, isSealedMaterial, doorLine, facingCell } from './origin-tenant.js'
import { MERCY_LINE, leashDebtStep } from './origin-anchored.js'
import { floorKey } from './origin-processed.js'
import { spellCard, refileWithName, spelledLine, ONLINE_LINE } from './origin-unnamed.js'
import { RECOIL_DIST, RECOIL_SHAKE, RECOIL_LINE, CURE_LINE } from './origin-thin.js'
import { perceptionFor } from './compose-perception.js'
import { createStillness, HUNTS_MOVEMENT_LINE } from './stillness.js'
import { sanityStep, EXHAUSTED_LINE, DISAGREE_LINE } from './compose-sanity.js'
import { createCompany, createRollCall, evKinds, whistlePitch, bearingLabel, whistleGain, whistlePan, countLine, WHISTLE_COOLDOWN_MS, WHISTLE_NOISE, QUIET_SANITY, SOLO_SANITY, FAR_BONUS, ECHO, NO_ANSWER_LINE, ECHO_LINE } from './rollcall.js'
import { createDownState, createKneel, downedInFront, DOWN_LINE, KNEEL_HINT, HANDS_LINE, LIGHT_STAYS_LINE, WOKEN_LINE, KNEELER_LINE, WAKE, KNEELER_SANITY, DOWN_BEAT } from './downed.js'
import { depthOf, loadFile, saveFile, statusMods, canFile, canRefile, wishPrompt } from './status.js'
import { closingOverlay, closingLines, isWishOpen, CLOSED_OFFICE } from './closings.js'
import { standing, placementMods, applyPlacement, ambientMods, trayLean, rollCall } from './docket.js'
import { polaroidCaption } from './compose-polaroid.js'
import { radioLine, RADIO_GROUPS } from './compose-radio.js'
import { wishRoute } from './compose-wish.js'
import { finaleGate, beaconDecision, deathDecision } from './compose-gates.js'
import { SUBJECT_RANGE, SOUL_RANGE, inFrame, subjectInFrame, createEvidence, photoOutcome, EVIDENCE_FLOOR, EVIDENCE_LINE, COUNTED_LINE } from './evidence.js'
import { PHRASES, NOTE_NONE, menuFor, cacheKey, octOf, arrowFor, isCachePayload, isTakePayload, extraFor, createCacheLedger } from './caches.js'
import { LIT_RANGE, litFriendNear, inCone, wardOutcome, wardLine, litOffLine } from './lightshare.js'
// the descent compass's arrow table lives in compass.js now (byte-identical), the resume order in levelmem.js: both re-exported from here
export { exitArrow } from './compass.js'
export { applyResume } from './levelmem.js'

// Presence: 1 in 12 chunks has a spirit at its midpoint
function chunkHasPresence(cx, cy) {
  let h = (Math.imul(cx, 374761393) + Math.imul(cy, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) & 0xFF) % 12 === 0
}

const ITEM_NAMES = {
  'almond-water':   'almond water',
  'glowstick':      'glowstick',
  'bandage':        'bandage',
  'polaroid':       'polaroid camera',
  'radio':          'radio',
  'plumb':          'survey plumb',
  'ballast':        'ballast',
  'extension-slip': 'extension slip',
}

// The numbers station in the deep stacks reads the ledger aloud — the count that decodes (subtract the drift 3, then A=1..Z=26) to the
// counter-claim you type at the presence, as readable groups (compose-radio.js RADIO_GROUPS). The claim itself ('i was here', letters
// only) is the wish router's to recognise (compose-wish.js).

// Things a lost soul might tell you — lore, warnings, and the odd real hint.
const NPC_LINES = [
  'i have been here longer than you have been alive.',
  "don't trust the almond water on the deeper floors.",
  'if the lights go out, stop moving. it hunts movement.',
  'the way down is near the torn wallpaper. never a way up.',
  'you hear the smiler before you see it. that grin.',
  'the humming is a language. i almost understand it now.',
  'have you seen my daughter? she was right behind me.',
  'the walls are thin where the carpet is wet. clip through.',
  'stay away from the ones that walk on all fours.',
  'we are not lost. we are exactly where it wants us.',
  'bring a light to the pipes. the dark there is not empty.',
  "if you make it out, don't tell them about me.",
]

// ── per-frame plumbing that must not allocate (pure, exported for test/gfx-hc-game.test.js) ──

// The sprite list handed to render() every frame, assembled WITHOUT fresh objects: each category keeps a pool of records that are
// overwritten in place (index i of a category always goes through the same fill function, so every record keeps one shape and its fields in
// the literal's order), and the output array itself is reused. What the renderer receives is exactly what the old per-frame .map() built —
// same fields, same values, same order. Safe because no renderer stage keeps an entity across frames or keys anything on its identity
// (the sprite passes key motion on id/key/name, the GL atlas on its own mips).
//   const A = createEntityAssembler()
//   A.begin(); A.pass(list) (objects handed through as-is); A.add('prop', list, fill, ctx) ...; const all = A.end()
export function createEntityAssembler() {
  const out = []
  const pools = Object.create(null)
  let n = 0
  return {
    begin() { n = 0 },
    // objects that are already what the renderer wants (the entity system's enemies): handed through untouched
    pass(list) { for (let i = 0; i < list.length; i++) out[n++] = list[i] },
    // one pooled record per element of `list`, written by fill(record, element, ctx)
    add(cat, list, fill, ctx) {
      const pool = pools[cat] || (pools[cat] = [])
      for (let i = 0; i < list.length; i++) {
        let r = pool[i]
        if (r === undefined) r = pool[i] = {}
        fill(r, list[i], ctx)
        out[n++] = r
      }
    },
    end() { if (out.length !== n) out.length = n; return out },
    poolSize(cat) { return pools[cat] ? pools[cat].length : 0 },
  }
}
// the record fills: field for field (and in the order of) the object literals game.js used to build every frame. A remote player's six
// trailing fields are the friend's heartbeat as the event bus merged it onto the record (evbus.js mergeRemote; blanked for a stale one,
// absent for a legacy peer) — gfx-sprites planPerson draws them: faint when thin and unseen, halved and 'name · down' when down, warm when lit
export const ENTITY_FILLS = Object.freeze({
  player:  (r, p) => { r.x = p.x; r.y = p.y; r.kind = 'player'; r.name = p.name || 'wanderer'; r.angle = p.angle; r.chatText = p.chatText; r.hp = p.hp; r.st = p.st; r.lit = p.lit; r.thin = !!p.thin; r.origin = p.origin; r.status = p.status; r.seen = !!p.seen },
  npc:     (r, n) => { r.x = n.x; r.y = n.y; r.kind = 'npc'; r.name = 'a lost soul'; r.key = n.key },
  prop:    (r, p) => { r.x = p.x; r.y = p.y; r.kind = 'prop'; r.type = p.type; r.rot = p.rot; r.key = p.key },
  exit:    (r, e) => { r.x = e.x; r.y = e.y; r.kind = 'exit'; r.target = e.target; r.key = e.key },
  item:    (r, it) => { r.x = it.x; r.y = it.y; r.kind = 'item'; r.itemType = it.type; r.key = it.key },
  note:    (r, s, readSet) => { r.x = s.x; r.y = s.y; r.kind = 'note'; r.read = readSet.has(s.frag); r.frag = s.frag; r.key = s.key },
  machine: (r, m, vendedSet) => { r.x = m.x; r.y = m.y; r.kind = 'machine'; r.vended = vendedSet.has(m.key); r.key = m.key },
  sight:   (r, s) => { r.x = s.x; r.y = s.y; r.kind = 'sight'; r.sightType = s.type; r.key = s.key },
  apparition: (r, a) => { r.x = a.x; r.y = a.y; r.variant = a.variant; r.vx = a.vx; r.vy = a.vy },
})

// Window resizes come in storms (a drag fires dozens a second, each used to reallocate the canvas and the renderer's buffers). They only
// raise a flag; the game loop takes it at most once per animation frame, before it draws.
export function createResizeGate() {
  let pending = false
  return { request() { pending = true }, take() { const p = pending; pending = false; return p }, get pending() { return pending } }
}
// Call onChange once when window.devicePixelRatio changes (the window moved to another display, the browser zoom changed). A
// `(resolution: Xdppx)` media query fires when the ratio leaves X; it is re-armed for the new ratio each time. -> stop()
export function watchDpr(win, onChange) {
  let mql = null, stopped = false
  const arm = () => {
    if (stopped) return
    try {
      mql = win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`)
      mql.addEventListener('change', fire, { once: true })
    } catch { mql = null }       // no matchMedia / an old engine: the loop's periodic check still catches it
  }
  function fire() { if (stopped) return; try { onChange() } finally { arm() } }
  arm()
  return () => { stopped = true; try { if (mql) mql.removeEventListener('change', fire) } catch { /* ignore */ } }
}

// After a level change the screen stays black until the new level has drawn this many frames (its first frames carry the one-time costs:
// lazily built sprites, the GPU's first-frame validation on the 4th render), or until SETTLE_MAX_MS, whichever comes first — so those costs
// land under the fade, not as a visible stutter after it.
export const SETTLE_FRAMES = 5
export const SETTLE_MAX_MS = 1500

// The level-change / respawn fade. run(cb, onShown): the veil goes black (FADE_OUT_MS), cb() swaps the level or respawns under it, and the veil
// lifts only once the NEW picture has drawn settleFrames frames (or settleMaxMs passed); onShown() runs graceMs AFTER the veil starts to lift.
// game.js ends its transition in onShown, so movement, events and contact damage stay frozen for as long as the screen is black — never
// released on a fixed timer while the veil still holds. Fades are SEQUENCED: each run() is a new generation, and the pending reveal / onShown
// of an older run does nothing once a newer run has started (an older fade can never lift the veil in the middle of a newer — a death — fade,
// nor end the newer transition). cb itself always runs: it is the state change the caller asked for.
//   deps: el (the #fade element, or null: no veil — cb, then onShown after graceMs), frames() (frames drawn so far), now(), setTimeout, raf
export const FADE_OUT_MS = 580, FADE_GRACE_MS = 150
export function createFader({
  el, frames, now = () => performance.now(), setTimeout: later = (f, ms) => setTimeout(f, ms), raf = (f) => requestAnimationFrame(f),
  fadeMs = FADE_OUT_MS, graceMs = FADE_GRACE_MS, settleFrames = SETTLE_FRAMES, settleMaxMs = SETTLE_MAX_MS,
} = {}) {
  let gen = 0
  return {
    get gen() { return gen },
    run(cb, onShown) {
      const g = ++gen
      const shown = () => { if (onShown) later(() => { if (g === gen) onShown() }, graceMs) }
      if (!el) { cb(); shown(); return }
      el.style.transition = 'opacity 0.55s'
      el.style.opacity = '1'
      later(() => {
        cb()
        if (g !== gen) return                        // a newer fade started meanwhile: it owns the veil and the transition
        const f0 = frames(), s0 = now()
        const reveal = () => {
          if (g !== gen) return
          if (frames() - f0 >= settleFrames || now() - s0 >= settleMaxMs) { el.style.opacity = '0'; shown() }
          else raf(reveal)
        }
        raf(reveal)
      }, fadeMs)
    },
  }
}

// The head of every animation frame: the fpsCap pacer FIRST, then the pending layout. A layout assigns #c's width/height, which clears it; a
// frame the pacer skips draws nothing, so a layout taken there would be PRESENTED as a cleared, transparent canvas — with a window drag or a
// pinch firing resizes every frame and fpsCap 30 (or 60 on a 120/144 Hz display) that is a scene / blank strobe. A pending layout therefore
// waits (the gate keeps it) for the next callback that goes on to draw. -> true when this frame draws.
export function frameDue(ts, pacer, fpsCap, gate, relayout) {
  if (!pacer.due(ts, fpsCap)) return false
  if (gate.take()) relayout()
  return true
}

export async function initGame(canvas, { worldSeed = null, mpClient = null, anchor = null, resume = null, intakeCtx = null } = {}) {
  const base = await loadConfig()

  // ── player state — PERSISTS across level transitions (hp + inventory carry) ──
  const HALF = CHUNK_SIZE / 2
  const player = {
    x: HALF + 0.5, y: HALF + 0.5,
    angle: 0, bob: 0, bobOffset: 0, moving: false,
    hp: 100, maxHp: 100,
  }
  let spawnX = player.x, spawnY = player.y

  // inventory lives in itemSys and persists; its wall test reads the CURRENT level
  const itemSys = createItemSystem(base, (wx, wy, pcx, pcy) => level.cache.isWall(wx, wy, pcx, pcy), worldSeed)
  // ── the caches (caches.js): a thing set down with one of m.'s phrases is a dropped item carrying a note (items.js keeps it, levelmem
  //    remembers it per floor, the save carries it). The ledger is only the INDEX — whose each cache is, which 'd:' key holds it on this
  //    residency, the per-owner caps, and a friend's cache waiting for its floor. The outbox keeps a 'cache' / 'take' the bus's outgoing
  //    gap refused (3 s / 0.5 s), flushed in order beside its tick: a second cache in a breath reaches the room late, never not at all.
  //    Solo there is no id: every cache on the floor is yours ──
  const ledger = createCacheLedger()
  const evOutbox = []
  const myId = () => (mpClient ? mpClient.id ?? null : null)
  const myName = () => (mpClient ? mpClient.getName() : (String(getPref('playerName') ?? '').trim().slice(0, 24) || 'wanderer'))
  const isMine = (rec) => (rec.byId ?? null) === myId()

  // persistent effect / combat timers
  let stamina    = 100
  let calmTimer  = 0    // almond water — lights hold steady
  let fogTimer   = 0    // glowstick — fog pushed back
  let radioWasOn = false
  let invuln     = 0    // i-frames after a hit
  let hurt       = 0    // red-flash intensity
  let regenDelay = 0    // seconds before hp regen resumes
  let netTimer   = 0    // throttles position updates to the server (~20Hz)
  let flashlight = true // the player's own light (toggle with L)
  let sanity     = 100  // the dark and the things eat at it; light + friends restore it
  let sanWhisperT = 0
  let heartT     = 0
  let shake      = 0    // screen-shake magnitude, decays each frame
  let wantSprint = false // the sprint key held this frame (the mover's report and the hard-bump rule read it)
  let lastDt     = 1 / 60 // the step the mover measures the enter speed against
  let bobPulse   = 0    // seconds left of the clutter step: a 0.35 s rise-and-settle on the bob
  let playT      = 0    // seconds of play this run (the clamped simulation step): saved in snapshot(), restored on resume
  let lastHitT   = -Infinity // when a thing last reached you (stamped by the hit block; the haunts' calm gate reads it)
  let quietTimer = 0    // sweet almond water sets it (QUIET_SECONDS): footsteps at half loudness while it runs (tactics.quiet)
  // ── the floors (topology.js / levelmem.js / death.js): the one memory of what every floor keeps of you (what you took, emptied,
  //    searched, set down; where you stood), the chunk you arrived in, the way you came by (still closing behind you for 5 s), the
  //    deaths, and the trays locked after one until the next travel ──
  const mem = createLevelMemory()
  let spawnChunk = { cx: 0, cy: 0 }
  let closing    = null   // { key, until }: the way you just arrived by does not take you straight back
  let deaths     = 0
  let vendLocked = false  // after a death: 'the tray is empty.' until the next travel()
  // ── the map (fogmap.js / sightpins.js / mapcard.js / compass.js): the pencil sheet of what you walked and saw, held not modal ──
  const fog = createFogMap()
  let mapOpen = false, mapEverOpened = false, lastLostMsg = -Infinity
  const compassOut = []                       // compassLines' reused two-slot output (its line objects live on compassOut.slots)
  let lastCompassAngle = NaN, lastWayCount = -1, lastCompassText = null, lastCellIx = NaN, lastCellIy = NaN
  const seenWays = [], seenSights = []        // visibleWays' reused out arrays
  const sightSaid = new Set()                 // 'level:key' of the sights whose first-sight line was said
  let arcWas     = false // the tesla's charge last frame (the lights drop once per charge, not every frame of it)
  let lastStepN  = 0    // the footstep count (floor(bob / PI)) the noise emitter last saw
  let lureT      = 0.5  // seconds since the lures (dropped talking radios) were last recomputed
  let lureNoiseT = 0    // seconds since the dropped radios last made the noise the things hear (8 every 0.5 s)

  // ── the fight verbs (ward.js / tactics.js / tension.js): the charger owns the ward's hold, cost and cooldown and reads press /
  //    release EDGE COUNTS (a touch tap inside one frame still lands); the commit is the 1.2 s bandage wrap a hit interrupts; the
  //    tension is the hunted state as heartbeat and music. All three are ticked every frame and never rebuilt. ──
  const charger   = createWardCharger()
  const wardInput = { press: 0, release: 0 }
  const EMPTY_WARD = { hit: 0, dispelled: 0, opening: 0 }     // what a ward meets with creatures switched off
  const commit    = createCommit(1.2)
  // drop the wrap where it stands (the bandage stays in your hand); with a line when something took you mid-wrap
  function cancelCommit(msg) { if (commit.active) { commit.cancel(); if (msg) showMessage(msg) } }
  const tension   = createTension()
  let huntMood    = false  // tension's mood last frame: a track cycled mid-chase keeps the hunt's delta

  // ── the numbers station + the counter-claim (the reality-tunneling arc) ──
  let stationIdx  = 0     // which group of the ledger-count the radio reads next
  let photoIdx    = 0     // the polaroid develops one glyph of the claim per clean shot
  let claimFiled  = false // the wish was typed as a claim ("i was here")
  let beaconFired = false // the beacon was fired carrying the EXTENSION-30150A claim
  let seamHeld    = false // the counter-claim resolved — fire the finale only once
  let firstDeepHearing = true   // the processed hear the station's key once a run (rules.radio; radioLine's keyLineNow spends it)
  let shotOnLevel = false       // a photo taken on this floor yet (the anchored pin develops on a floor's first; buildLevel clears it)

  // ── the file (origin-*.js): nobody chooses a column. The first way you take files you by how you arrived (travel()); until then — Level ∅,
  //    the lobby before the first way — rules is LEGACY and the game is what it always was. intakeCtx holds the title screen's facts (the
  //    route, the pin, the name; the arrival is written at the filing); thin is the layer (dropped in, or back from the dark); filedFloors
  //    are the floors a processed beacon filed (they never restock); leashDebt / leashCalm are the anchored pull. Every read of a number or
  //    a line the file could change is `rules.<key>`; rules is reassigned only through rulesFor (the filing, the cure, a re-file, a resume) ──
  let origin = null, thin = false, filed = false, filedFloors = new Set(), leashDebt = 0, leashCalm = 0
  let rules = LEGACY
  // the thin layer's first photograph shows the wall through your hand (rules.polaroid): a shot taken while thin spends it; a layer minted
  // again (a death, die(d)) sets it again
  let thinFirstShot = true
  intakeCtx = normaliseIntakeCtx(intakeCtx, { route: 'solo', arrival: null, anchor, name: '' })
  const doorsSaid = new Set()   // the ∅ doors whose +3 was taken this session ('ix,iy')
  // ∅ is one-way, so a column that only exists there could never meet a filed player: the doors and the form read the column the filing
  // WILL write (a pure function of the title screen's facts); nothing else reads it, and the rules stay LEGACY until the filing
  const provisionalOrigin = () => filed ? origin : intake(intakeCtx)
  // the ONE drift helper: whole metres from where this floor set you down, plus the leash debt a death leaves an anchored player (0 without
  // a pin) — the HUD, the leash row, the film's pin caption and the death read it
  const driftD = () => anchor ? Math.round(driftMeters(player.x, player.y, spawnX, spawnY) + leashDebt) : 0
  // ── stillness (stillness.js): how long you have stood still and how long since you made a sound, on the play clock. The file's perception
  //    reads it ('it hunts movement.': two still, silent seconds with the light and the radio off and the things cannot see you; thin's 0.6 s;
  //    LEGACY never). The loop notes every step through one reused report; your own ward and a sprint are sounds, a friend's ward and the
  //    lures are not. The line that teaches it is said once a run, the first time it hides you with something close ──
  const stillness = createStillness({ now: () => playT })
  const stillNote = { moving: false, flashlight: true, radioOn: false, t: 0 }
  let wasHidden = false, huntsMovementSaid = false
  let standHeld = 0   // TODO(integrate:W3) I13: the stand tick writes it (closings.js standTick); buildLevel, the ward and the whistle reset it already — the hunts line keeps quiet while it runs
  // ── company (rollcall.js): the pool a fresh friend within 6 steadies you out of — it drains while you stand together and stops helping
  //    when it is empty, then refills while you are apart; sanityStep says how it moves each frame. The two files' disagreement is said once ──
  const company = createCompany()
  let disagreeSaid = false
  // the roll call (rollcall.js): who has answered a whistle lately, on its own ms clock (performance.now(), never playT). The radio's last
  // group counts them ('those were yours — three of you.'); alone it reads one, today's line. A friend's whistle hears into it, a chat line
  // or a friend beside you touches it, and the loop asks it who has gone quiet
  const rollcall = createRollCall({ now: () => performance.now() })
  let lastWhistleAt = -Infinity   // your own last whistle (the same ms clock): one per WHISTLE_COOLDOWN_MS, a second inside it is swallowed
  // ── down, not dead (downed.js): with a friend fresh on your floor a fatal hit lays you down instead (compose-gates.js deathDecision) —
  //    25 s in the dark for one of them to kneel beside you, light on, and count you back; nobody comes and it is a death. The kneel is
  //    the other side of it: yours, beside a friend who is down. Both on performance.now() ms like the roll call (a kneel arrives from the
  //    socket outside the loop; a hidden tab must not stop the 25 s) — never playT, and game.js never hands them a clock. savedLight is
  //    your own light while one of them forces it (off lying down, on kneeling), put back when that ends ──
  const down = createDownState({ now: () => performance.now() })
  const kneel = createKneel({ now: () => performance.now() })
  let savedLight = true

  // ── Living Atmosphere — occasional ambient dread events. evConfig is the scheduler's ONE mutable config, read at every tick: the filing
  //    writes the file's weights into it (a tenant sees the far crosser twice as often), retension() is the one writer of its tension ──
  const evConfig = { events: EVENTS, tension: 0 }
  const eventSched = createEventScheduler({ config: evConfig })
  // the file the presence keeps (status.js / closings.js): the status, the closing, the ledger heard, the pages left unread — in prefs (one
  // file for every run and every room), never in the save. A missing or garbled pref is the notice nobody answered
  let file = loadFile(getPref('file'))
  // what the status and a closing do to the numbers the loop reads (status.js statusMods / closings.js closingOverlay): pure functions of
  // the file, so re-derived with every write of it — notice-mailed and no closing are today's (the sanity's depth drain, ∅ none)
  let mods = statusMods(file.status), co = closingOverlay(file.closing)
  // the closing's delayed lines (a compliance close, a re-filing): a new floor drops them with the old one (buildLevel)
  const closingTimers = []
  // THE one write of the file: always a fresh object (applyFile({ ...file, ledgerHeard: true }), never a change in place), so mods / co are
  // re-derived from the new reference, saveFile hands prefs a fresh copy (a same-reference write would be dropped), the events' tension
  // follows the closing and the room hears the status at once
  function applyFile(f) { file = f; mods = statusMods(file.status); co = closingOverlay(file.closing); saveFile(file); retension(); bus?.here(hereFields()) }
  // the ONE writer of evConfig.tension: the room's standing on this floor (W8 ambientMods) and the closing's (compliance's calm)
  function retension() { evConfig.tension = (level?.amb?.tension ?? 0) + (closingOverlay(file.closing).tension ?? 0) }
  const ephemera   = []   // transient event-spawned apparitions (render-only, no collision; a haunt's figure carries vanishAt)

  // ── the drawers (containers.js) and the placed hauntings (haunts.js): the hold-to-search state, the keys opened on this floor
  //    (levelmem keeps them across visits and saves), the haunt cooldowns on the play clock, and dreadQuietT — the ONE quiet shared by
  //    the scheduled events and the haunts (20 s after a haunt, 12 s after an event), so the two dread layers never stack ──
  const searchLog = createSearchLog()
  let searchT = 0, searchTarget = null, drawerCostSaid = false
  const unsearchedBox = (p) => CONTAINER_TYPES[p.type] !== undefined && !searchLog.isSearched(p.key)   // hoisted: no closure per frame
  const hauntTrackers = new Map()   // level index -> its tracker (buildLevel picks this floor's)
  let haunts = null
  let dreadQuietT = 0, lightToggles = 0
  let waterT = 0, waterStepT = 0   // running water: footfall(8) now and every ~3 s while its 12 s timer runs

  // vending machines dispense once; the keys still spent on this floor at this visit (levelmem.vendedFor: a key expires only after
  // VEND_RESTOCK_S away from the floor, so a machine never refills while you watch). Replaced per buildLevel; noteVended writes mem.
  let vendedSet = new Set()

  // contact (collide.js): the lines a body says are said once per type per level (hard bumps, clutter), cleared next to vendedSet;
  // the gate keeps the foley to one near bump per 0.5 s
  const bumpSaid = new Set(), clutterSeen = new Set()
  let lastBumpLine = -Infinity, lastLetThrough = -Infinity
  const bumpGate = createBumpGate()

  // ── the things' events (hunt.js / variants.js), drained once per frame into one reused array; the event objects are pooled
  //    (32), so each is read in the frame it arrives and never kept. The lines that must not repeat keep their own gates here:
  //    'it has seen you.' 8 s, the far line 30 s, the cornered turn once per level, the turning cue once per creature per hunt
  //    (a new sighting clears it), the hound's two tells once per run. ──
  const entEvents = []
  let lastSeenLine = -Infinity, lastFarLine = -Infinity, lastDuck = -Infinity
  let turnSaid = false, houndTold = false, passTold = false
  const turningSaid = new Set()
  function onEntityEvent(ev) {
    const fog = level.cfg.fogDistance
    switch (ev.kind) {
      case 'seen':
        turningSaid.delete(ev.id)
        if (ev.d <= fog * 1.1) { if (playT - lastSeenLine > 8) { lastSeenLine = playT; showMessage('it has seen you.', PRIO.combat) } }
        else if (playT - lastFarLine > 30) { lastFarLine = playT; showMessage('something, far off, stops.', PRIO.ambient) }
        break
      case 'lost': showMessage('you have lost it. it is still looking.', PRIO.discovery); break
      case 'alert': if (ev.d <= fog) footfall(1); break
      case 'turn': if (!turnSaid) { turnSaid = true; showMessage('it has nowhere to go. it turns.', PRIO.interaction) } break
      case 'turning': if (ev.d <= fog && !turningSaid.has(ev.id)) { turningSaid.add(ev.id); showMessage('it stops. it turns.', PRIO.interaction) } break
      case 'smiler-freeze': whisper(); showMessage('it stops when you look. do not look away.', PRIO.discovery); break
      // the one teaching beat for the ward's timing: urgent, so it replaces 'it has seen you.' (said a frame before) instead of waiting out its dwell
      case 'hound-windup': footfall(2); if (!houndTold) { houndTold = true; showMessage('it gathers itself. push now.', PRIO.urgent) } break
      case 'hound-pass': if (!passTold) { passTold = true; showMessage('it skids past.', PRIO.interaction) } break
      case 'lurker-hunt': if (playT - lastDuck > 1.4) { lastDuck = playT; humDuck(1.4) } break
      case 'crawler': sanity = Math.max(0, sanity - 8); showMessage('something takes your ankles.', PRIO.urgent); break
      case 'watcher-dispelled': sanity = Math.min(100, sanity + 12); showMessage('it looks away first.', PRIO.interaction); break
      // 'arc': the jolt itself lands through th.dmg / th.dmgKind ('the current finds you.')
    }
  }

  // Flicker state (persists; retuned per level via level.cfg.flicker)
  let flicker    = 1.0
  let flickTgt   = 1.0
  let flickTimer = 0
  const fk = createFlickerState()   // the rate limiter's bookkeeping (gfx-quality.js stepFlicker); flicker/flickTgt/flickTimer stay ours

  initAudio(base)

  // shared, live-mutable render options (toggled from the settings panel). maxGlobalDip bounds how far the WHOLE frame
  // may dim in a flicker (0.5; reduceFlicker tightens it to 0.25) whatever quality tier is chosen.
  const renderOpts = {
    grain: getPref('grain'), particles: getPref('particles'), crosshair: getPref('crosshair'),
    reduceFlicker: getPref('reduceFlicker'), maxGlobalDip: DEFAULT_MAX_GLOBAL_DIP,
    renderer: getPref('renderer'),     // 'auto' | 'gpu' | 'cpu' — read by createRenderer() (renderer.js); 'auto' is still the CPU path until the GPU is verified
  }
  // Test / harness hook: a page that sets globalThis.__backroomsRenderOpts BEFORE the game boots (tools/gfx/page.cjs --ropts) can add renderOpts such as
  // { allowSoftwareGl: true } (WebGL on SwiftShader, never used in production) or { __failGl: 'frame' }. It is read ONLY when the harness has also marked
  // the page as a test run (globalThis.__backroomsTestRun === true, set by page.cjs' preload) — nothing in the shipped page or the URL sets either,
  // and gfx-gl.js / renderer.js re-check the marker before honouring allowSoftwareGl, __failGl and gpuValidate.
  try { const dbg = globalThis.__backroomsRenderOpts; if (dbg && typeof dbg === 'object' && globalThis.__backroomsTestRun === true) Object.assign(renderOpts, dbg) } catch { /* ignore */ }
  // The quality director turns the graphicsQuality / hiDpi / fpsCap prefs plus the frame times it is fed into
  // renderOpts.qualityTier / renderScale / uiScale and the canvas size (gfx-quality.js). resize() below lays it out.
  const qd = createQualityDirector({
    env: readDeviceEnv(navigator, window),
    graphicsQuality: getPref('graphicsQuality'), hiDpi: getPref('hiDpi'), fpsCap: getPref('fpsCap'),
  })
  let fpsCap = getPref('fpsCap')

  // ── per-level state, rebuilt on every transition ──
  let level = null
  let transitioning = false
  // what the last level start cost (buildLevel, the renderer inside it, the first frame): the ?gfxstats=1 panel shows it
  let levelStart = null
  const fadeEl = document.getElementById('fade')
  const downEl = document.getElementById('down')   // lying down: its own veil (the fader owns #fade's inline opacity), lifting as you are counted
  let downVeil = '0'                               // the veil's opacity as last written (the loop writes it on a change only)

  // ── track selection (N) ──
  // -1 means "this floor's own mood"; 0..n-1 index TRACKS. The choice persists
  // across descents (see buildLevel) so a track you like isn't torn away the
  // moment you fall through a floor. Declared HERE, above buildLevel, because
  // buildLevel reads it and runs before this point in initGame — a `let` further
  // down would be in the temporal dead zone and throw on boot.
  let trackIdx = getPref('track')
  if (!Number.isInteger(trackIdx) || trackIdx < -1 || trackIdx >= TRACKS.length) trackIdx = -1

  // The song the floor (or the chosen track) plays. setMusic is handed a COPY of the base mood: tension's setMood patches the live
  // object in place (the hunt thickens it, calm restores it from the base), so the base itself — cfg.music, a TRACKS constant — stays
  // pristine. A song started mid-chase takes the hunt's delta at once, so the hunt does not drop out when a track is cycled.
  function playSong(base) {
    setMusic({ ...base })
    if (huntMood) setMood(huntDelta(base))
  }
  function cycleTrack() {
    trackIdx = trackIdx + 1 >= TRACKS.length ? -1 : trackIdx + 1
    setPref('track', trackIdx)
    if (trackIdx < 0) {
      playSong(level.cfg.music)
      showMessage('the building resumes its own song.')
    } else {
      const t = TRACKS[trackIdx]
      playSong(t.mood)
      showMessage(t.hint)
    }
  }

  // one renderer for a level (buildLevel; and a live change of the renderer pref). Logs one hidden diagnostics line: kind / why / GPU info.
  function makeGfx(cfg, cache) {
    const g = createRenderer(canvas, cfg, renderOpts, cfg.map ? { materialAt: (wx, wy) => cache.materialAt(wx, wy) } : {})
    try { console.info(g.diagnostics()) } catch { /* a console-less host */ }
    return g
  }

  // buildLevel(index, at): the level, streamed around chunk `at` (the chunk you arrive in; the origin when none). cfg.ways is the level's
  // graph (topology.waysFor): [0] is today's exit (decor reads its kind / label), the rest the stairs up / the lift stairsPass places.
  function buildLevel(index, at = null) {
    const tb    = performance.now()
    const cfg   = levelConfig(base, index)
    // the floor's file (docket.js): the release's tally of open files on this floor leans what it leaves out — pages, machines, souls, the
    // things in the halls — once, from base.docket, never from who is in the room (a zero docket and the block: cfg as it was). Then the
    // closing LAST, so a compliance file's 'no more pages' wins over any lean
    const st = standing(base.docket, cfg.map ? null : depthOf(index))
    applyPlacement(cfg, placementMods(st))
    if (closingOverlay(file.closing).scrapsDenom === 0) cfg.scraps = { ...cfg.scraps, denom: 0 }
    cfg.ways    = waysFor(index)
    spawnChunk  = at ?? { cx: 0, cy: 0 }
    // HUD theme hook: index.html restyles body[data-level] ('0'..'3' | '∅') — light ink on dark plates below the lobby
    if (typeof document !== 'undefined' && document.body) document.body.dataset.level = String(cfg.levelIndex)
    // Level ∅ is a hand-authored fixed grid; the rest are procedural chunk worlds.
    // Both expose the same isWall(wx,wy,pcx,pcy); the fixed map adds materialAt.
    const cache = cfg.map ? createFixedMap(cfg.map) : createChunkCache(cfg, worldSeed)
    cache.preload(spawnChunk.cx, spawnChunk.cy)
    const isWall = (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)
    // the grid the hot paths read (LOS, perception, fog): cell-indexed, no key string per ask (world.js createGridReader). A fixed map
    // (Level ∅) has no getChunk, so the reader wraps isWall at the cell centre instead
    const grid      = createGridReader(cfg.map ? null : cache, isWall)
    grid.setPlayerChunk(spawnChunk.cx, spawnChunk.cy)
    // the bodies: a per-chunk collider index that decor fills as it scans (placement.js settles each chunk's props / machine / sight /
    // soul against the real walls and hands the same records to onChunk), and the solid world the mover and the creatures read it through.
    // Order: cache -> grid -> bodies -> decor(hooks) -> solid -> entitySys -> gfx
    const bodies    = createColliderIndex()
    const decor     = createDecorSystem(cfg, isWall, worldSeed, {
      // the passes after the sights block, in the fixed order: the stairs up / the lift (topology.js; null on L0 and the block), the
      // room dressing (dress.js; null on the block), then the hauntings (haunts.js; AFTER the dressing, so its ctx.props sees the cabinets)
      passes: cfg.map ? [] : [stairsPass(cfg, cfg.ways), dressPass(cfg), hauntsPass(cfg)].filter(Boolean),
      onChunk: (k, bundle) => bodies.setChunk(k, bundle.colliders),
      onEvict: (k) => bodies.dropChunk(k),
    })
    const solid     = createSolidWorld({ index: bodies, floorFn: grid.floor, solidCreature })
    // the creatures step around the same bodies, read the same grid, and count their dispels on the play clock (hunt.js)
    const entitySys = createEntitySystem(cfg, isWall, { obstacles: solid.forEntities, grid, now: () => playT })
    // The previous level's renderer is disposed BEFORE the next one is created: a GPU backend owns a WebGL context on a sibling canvas, and
    // browsers cap live contexts (~16), so a level change must not leave one behind.
    if (level && level.gfx) { try { level.gfx.dispose() } catch { /* a half-torn-down renderer must never block a level change */ } level.gfx = null }
    const tg        = performance.now()
    const gfx       = makeGfx(cfg, cache)
    const gfxMs     = performance.now() - tg
    bumpSaid.clear(); clutterSeen.clear(); turningSaid.clear(); turnSaid = false   // and says its contact / turning lines afresh
    // the drawers this floor remembers you opening (levelmem); a hold does not survive the fall, nor the deep floors' line
    searchLog.clear(); searchLog.seed(mem.searchedFor(index)); drawerCostSaid = false; searchT = 0; searchTarget = null; waterT = 0
    cancelCommit()                  // a wrap does not survive the fall (the bandage stays); the new floor's song starts calm
    tension.reset(); huntMood = false
    // the closing's lines and a stand do not follow you down; a new floor's first photo is its first
    for (const t of closingTimers) clearTimeout(t); closingTimers.length = 0; standHeld = 0; shotOnLevel = false
    // a kneel does not survive a floor (your light comes back to you); lying down is not touched here — travel refuses while down, die resets it
    if (kneel.st) { kneel.stop(); flashlight = savedLight }

    // fixed maps spawn at their authored point; procedural at the arrival chunk's hall crossing (the origin's is today's HALF + 0.5
    // spawn, carved open) or the nearest open cell to it
    if (cfg.spawn) { player.x = cfg.spawn.x; player.y = cfg.spawn.y }
    else { const mid = chunkMid(spawnChunk.cx, spawnChunk.cy), m = findOpenNear(mid.x, mid.y, grid.floor) ?? mid; player.x = m.x; player.y = m.y }
    spawnX = player.x; spawnY = player.y

    const messages = [
      ...(cfg.messages || []),
      cfg.exit?.hint,
      ...(anchor ? [`your body remains at ${formatAnchor(anchor)}.`, 'you are very far from your body now.'] : []),
    ].filter(Boolean)

    // Assign `level` BEFORE warming up subsystems — itemSys reads level.cache
    // through a proxy, so the object must exist first.
    level = { index, cfg, cache, grid, bodies, decor, solid, entitySys, gfx, messages }
    // what this floor remembers of you (levelmem): the keys you took never respawn, what you set down lies where you left it (each record
    // wall-tested through the proxy, so only now: before this, `level` is null on a resume and the floor you left on a travel), and the
    // machines you emptied stay empty until you have been away long enough (the block keeps nothing)
    itemSys.enterLevel(cfg, cfg.map ? null : mem.takenFor(index), cfg.map ? null : mem.droppedFor(index))
    // the caches a friend set down here while you were on another floor (or the relay handed you at the welcome) are laid down now — on the
    // nearest open cell when the floor has moved under one, gone when nothing is open within three; then the ledger learns this residency's
    // 'd:' keys for every cache the floor remembers, yours and theirs, and adopts the ones it did not know
    for (const c of ledger.pendingFor(index)) {
      const open = grid.floor(Math.floor(c.pending.x), Math.floor(c.pending.y)) ? c.pending : findOpenNear(c.pending.x, c.pending.y, grid.floor)
      if (open) itemSys.dropAt(open.x, open.y, c.pending.type, c.pending.extra, null); else ledger.take(c.key)
    }
    ledger.clearPending(index); ledger.rebind(index, itemSys.getWorldItems())
    // the keys still spent at this visit (travel / die re-read it once the visit is counted); a floor the file has filed never restocks
    vendedSet = mem.vendedFor(index, filedFloors.has(floorKey(worldSeed, index)) ? -Infinity : playT)
    // the haunt cooldowns are this floor's own: the chunk keys repeat on every floor (one coordinate system)
    haunts = hauntTrackers.get(index) ?? hauntTrackers.set(index, createHauntTracker({ now: () => playT })).get(index)
    decor.update(spawnChunk.cx, spawnChunk.cy); itemSys.update(spawnChunk.cx, spawnChunk.cy)
    msgQ.clear()                    // the old floor's lines do not follow you down (one fade if one was up)
    ephemera.length = 0             // nor its apparitions: a haunt's standing figure would otherwise stand on the new floor at its old x,y
    lastCellIx = NaN                // the compass recomputes on the floor's first frame
    // the floor's depth (∅ reads as 0), its file's standing (the tray, the radio's roll call) and what the room's files make of it now (the
    // tension, the far crosser's thinness, the stand's floor: re-read when the room changes); the literal above gains nothing
    level.depth = depthOf(index); level.st = st; level.amb = ambientMods(st, bus ? bus.roomStanding() : null); retension()
    // Morph the bed into this level's mood — unless the player has chosen an
    // alternate track with N, in which case their choice follows them down.
    playSong(trackIdx < 0 ? cfg.music : TRACKS[trackIdx].mood)

    updateHud()
    renderHotbar()
    levelStart = { level: cfg.levelIndex, t0: tb, buildMs: performance.now() - tb, gfxMs, firstMs: NaN, readyMs: NaN, frames: 0 }
    return level
  }

  // lift the veil only once the (new) level has drawn its first frames, so their one-time costs stay under it (SETTLE_FRAMES); the transition
  // (frozen movement, events, contact damage) ends a moment after the veil lifts, not while it is still black (createFader)
  const fader = createFader({ el: fadeEl, frames: () => frameCount })
  function fadeThen(cb) { fader.run(cb, () => { transitioning = false }) }

  // the chunk under the player (travel / die run outside the loop, where its pcx / pcy are not in scope)
  const chunkUnder = () => ({ cx: Math.floor(player.x / CHUNK_SIZE), cy: Math.floor(player.y / CHUNK_SIZE) })
  // the arrival's delayed lines belong to that arrival: a travel or a death in between (arrivalGen moved on) drops them, so the old way's
  // line never reads on the next floor
  let arrivalGen = 0
  function later(ms, text, prio) { const g = arrivalGen; setTimeout(() => { if (g === arrivalGen) showMessage(text, prio) }, ms) }
  // the nearest record of a list (die: the holes loaded), or null
  function nearestOf(list, x, y) {
    let best = null, bd = Infinity
    for (const r of list) { const d = (r.x - x) ** 2 + (r.y - y) ** 2; if (d < bd) { bd = d; best = r } }
    return best
  }

  // travel(way): the one way between floors — a hole down, a stairwell up, the lift, the ring back — in ONE coordinate system (topology.js),
  // so you land beside the partner of the way you took (the stair under the hole, the hole over the stair), where you last stood on a ring
  // floor, or at the from-chunk's hall crossing. The floor you leave remembers you (levelmem); the way you arrive by is still closing for 5 s.
  function travel(way) {
    if (transitioning || down.st === 'down') return   // lying down, you go nowhere
    if (closing && closing.key === way.key && playT < closing.until) return
    transitioning = true
    arrivalGen++
    document.exitPointerLock()
    if (mapOpen) closeMap()
    const fromC = chunkUnder()
    // the stalkers on your heels follow you down: read now, placed once the new floor's bodies stand, arriving a few beats after you
    // (inject returns 0 where entities are disabled: the lobby, the block; nothing follows you into the lift)
    const followers = (creaturesOn && way.kind !== 'lift') ? level.entitySys.snapshotChasers(player, 10, 3) : []
    mem.leave(level.index, player, fromC, playT)
    mem.setDropped(level.index, itemSys.getDropped())
    fadeThen(() => {
      buildLevel(way.target, fromC)
      // the first way of a run files you (∅ -> the lobby solo; the lobby -> 1 online, where the form reaches you as this line): the arrival
      // is the client's (fixed at join; 'walked' solo), the column is intake's, the layer is thin when you dropped into a room already live
      if (!filed) {
        intakeCtx.arrival = mpClient ? mpClient.arrival() : 'walked'
        filed = true; origin = intake(intakeCtx); thin = intakeCtx.arrival === 'dropped'; rules = rulesFor(origin, thin)
        evConfig.events = rules.eventWeights()
        bus?.here(hereFields())
        later(7600, filingLine(origin, thin), PRIO.discovery)   // after the level name, the hint (3.8 s) and the way line (7.5 s); it belongs to this arrival
      }
      const partner = way.kind === 'down' ? level.decor.wayAt(fromC.cx, fromC.cy, 'up') : way.kind === 'up' ? level.decor.exitAt(fromC.cx, fromC.cy) : null
      const m = way.kind === 'ring' ? mem.get(way.target) : null
      // a ring floor remembers where you stood: stream that chunk first, so the arrival is validated against the right walls
      if (m?.x != null) { level.cache.preload(m.cx, m.cy); level.grid.setPlayerChunk(m.cx, m.cy) }
      const a = arrivalFor({ way, fromCx: fromC.cx, fromCy: fromC.cy, partner, mem: m, floorFn: level.grid.floor, angle: player.angle })
      player.x = a.x; player.y = a.y
      spawnChunk = chunkUnder()         // where you actually stand (a.chunk is the from-chunk; a ring arrival or the offset can land you one over)
      invuln = 1.6
      closing = { key: partner?.key ?? null, until: playT + 5 }
      level.grid.setPlayerChunk(spawnChunk.cx, spawnChunk.cy); level.cache.preload(spawnChunk.cx, spawnChunk.cy)
      level.decor.update(spawnChunk.cx, spawnChunk.cy); itemSys.update(spawnChunk.cx, spawnChunk.cy)
      level.solid.settlePlayer(player)
      const rec = mem.arrive(way.target, spawnChunk, playT)
      vendedSet = mem.vendedFor(level.index, filedFloors.has(floorKey(worldSeed, level.index)) ? -Infinity : playT)   // read again now the visit is counted: an absence long enough restocks (a filed floor never)
      const first = rec.visits === 1
      const hp0 = player.maxHp
      player.maxHp = onArrive(player.maxHp, first)           // a first visit gives five back (death.js: the one owner of maxHp)
      vendLocked = false
      const followed = followers.length ? level.entitySys.inject(followers, player.x, player.y, 7, 10, 3 + Math.random() * 2, (x, y) => level.solid.forEntities.blocked(x, y, 0.2)) : 0
      if (!level.cfg.map) fog.pinThing(way.target, 'arrived:' + (playT | 0), 'arrived', player.x, player.y)
      persist(true)                     // save on every travel, with the map
      // the lift's line is said under the veil, past buildLevel's msgQ.clear() (which would drop it before the fade): at combat it is never
      // queued behind a prompt result, and combat queues FIFO, so it reads before the level name
      if (way.kind === 'lift') showMessage(wayMessage(way, { before: true }), PRIO.combat)
      showMessage(level.cfg.levelName, PRIO.combat)
      const wm = wayMessage(way, { partner, mem: mem.get(way.target) })
      if (first) {
        // with followers on the way, the hint gives its slot to 'it followed you down.' (it is still a floor murmur in level.messages)
        if (level.cfg.exit?.hint && !followed) later(3800, level.cfg.exit.hint, PRIO.discovery)
        if (wm) later(7500, wm, PRIO.discovery)
      } else {
        if (wm) later(3800, wm, PRIO.discovery)
        const s = arrivalSummary(fog.countWays(way.target), rec.visits)
        if (s) later(7500, s, PRIO.discovery)
      }
      if (player.maxHp > hp0) later(11000, 'the floor remembers you less.', PRIO.discovery)
      // a new floor sets you down beside the pin's drift origin again (buildLevel resets spawnX / spawnY): a mercy, said once per descent
      if (origin === 'anchored') later(9500, MERCY_LINE, PRIO.discovery)
      bus?.here(hereFields())           // the room learns your new floor at once (a friend's chat says 'no-clipped deeper.')
    })
  }

  // die(): death.js resolves it — you wake a floor above (the lobby and the block where they are) beside the hole you fell through, facing
  // it: whatever was in your hand is gone (a tool, the ballast and the slip stay), the ceiling five lower (never below 60), the trays
  // empty until the next travel. The floor you died on remembers where you fell. d is the file's reading of the death (compose-gates.js
  // deathDecision: a layer minted, the pin's debt, the timeout's cost, a third line) — null, or LEGACY's, and it is today's death exactly
  function die(d = null) {
    if (transitioning) return
    transitioning = true
    arrivalGen++
    document.exitPointerLock()
    if (mapOpen) closeMap()
    cancelCommit('the bandage slips.')   // it took you in the second you held still
    showMessage('everything goes dark.', PRIO.combat)
    const C = chunkUnder()
    mem.leave(level.index, player, C, playT)
    mem.setDropped(level.index, itemSys.getDropped())
    fadeThen(() => {
      const r = resolveDeath({ level: level.index, inventory: itemSys.inventory, selected: itemSys.selected, maxHp: player.maxHp, deaths, names: ITEM_NAMES })
      if (r.wakeLevel !== level.index) buildLevel(r.wakeLevel, C)
      const mid = chunkMid(C.cx, C.cy)
      // the line says the hole you fell through: the nearest loaded hole first, any way only when no hole is loaded
      const exit = level.decor.exitAt(C.cx, C.cy) ?? nearestOf(level.decor.getKind('down'), mid.x, mid.y) ?? level.decor.nearestWayAny(mid.x, mid.y)?.rec ?? null
      const spot = exit ? wakeSpot(exit, level.grid.floor) : null
      if (spot) { player.x = spot.x; player.y = spot.y; player.angle = spot.angle }
      else { const m = findOpenNear(mid.x, mid.y, level.grid.floor) ?? mid; player.x = m.x; player.y = m.y }
      spawnChunk = chunkUnder()
      closing = { key: exit?.key ?? null, until: playT + 5 }
      itemSys.inventory.length = 0
      itemSys.inventory.push(...r.inventory)
      itemSys.select(r.selected)
      player.maxHp = r.maxHp; player.hp = r.maxHp
      deaths = r.deaths
      vendLocked = r.vendLocked
      invuln = 1.6; regenDelay = 0; hurt = 0
      // lying down ends here either way (a timeout is a death; your light comes back with you), and so does a kneel; then what the file
      // makes of the death — after the reset above, so the timeout's regenDelay wins
      if (down.st === 'down') flashlight = savedLight
      down.reset(); if (kneel.st) { kneel.stop(); flashlight = savedLight }
      if (d) { if (d.mintThin && filed) { thin = true; rules = rulesFor(origin, thin); thinFirstShot = true } if (d.leashDebt > 0) leashDebt = d.leashDebt; if (d.sanity) sanity = Math.max(0, Math.min(100, sanity + d.sanity)); if (d.regenDelay) regenDelay = d.regenDelay }
      if (downEl) downEl.style.opacity = '0'
      document.body.classList.remove('down')
      level.grid.setPlayerChunk(spawnChunk.cx, spawnChunk.cy); level.cache.preload(spawnChunk.cx, spawnChunk.cy)
      level.decor.update(spawnChunk.cx, spawnChunk.cy); itemSys.update(spawnChunk.cx, spawnChunk.cy)
      level.solid.settlePlayer(player)
      mem.arrive(level.index, spawnChunk, playT)
      vendedSet = mem.vendedFor(level.index, filedFloors.has(floorKey(worldSeed, level.index)) ? -Infinity : playT)   // the visit is counted (the trays stay locked through vendLocked anyway)
      renderHotbar()
      persist(true)
      showMessage(level.cfg.levelName, PRIO.combat)
      later(2600, r.message, PRIO.discovery)
      if (r.dropped) later(5200, r.droppedLine, PRIO.discovery)
      if (d?.line) later(7800, d.line, PRIO.discovery)   // the column's word on it ('nobody came.' first when nobody did); LEGACY has none
      bus?.here(hereFields())           // woken a floor above: the room learns it at once
    })
  }

  // ── input ──
  const K = Object.create(null)
  let locked = false
  // input.js takeKey decides what the key map takes: text fields are ignored (typing a webhook into settings must not play the game),
  // the edge-triggered verbs (F/E/Space/Tab/Q/X/C) fire once per press however long they are held, Space never scrolls the page and Tab
  // stays with the game while it owns focus and the settings panel is hidden (the panel's own tab order wins while it is open)
  const settingsHidden = () => { const sm = document.getElementById('settings-modal'); return !sm || sm.style.display === 'none' }
  window.addEventListener('keydown', e => {
    const r = takeKey(e, { activeTag: e.target?.tagName, isContentEditable: !!e.target?.isContentEditable, locked, settingsOpen: settingsHidden() === false })
    if (r === 'ignore') return
    if (r === 'take-prevent') e.preventDefault()
    K[e.code] = true
    if (e.code === 'Space') wardInput.press++       // the ward counts edges (takeKey already dropped the held repeats)
  })
  window.addEventListener('keyup',   e => { K[e.code] = false; if (e.code === 'Space') wardInput.release++ })
  // a key held while the window loses focus never gets its keyup: sweep the map so the player does not walk on alone, and drop a
  // ward latch without firing it (a stray release++ later falls on nothing)
  window.addEventListener('blur', () => { for (const k in K) K[k] = false; charger.forceRelease() })
  document.addEventListener('visibilitychange', () => { if (document.hidden) { for (const k in K) K[k] = false; charger.forceRelease() } })
  // Pointer-lock mouse-look is desktop only; on touch the on-screen controls
  // drive movement + look instead (initTouchControls, below).
  if (!isTouchDevice()) canvas.addEventListener('click', () => canvas.requestPointerLock())
  document.addEventListener('pointerlockchange', () => { locked = document.pointerLockElement === canvas; if (!locked) charger.forceRelease() })
  document.addEventListener('mousemove', e => { if (locked) player.angle += e.movementX * 0.002 * (getPref('mouseSensitivity') / 100) })

  // ── touch controls (phones / ChromeOS tablets) — feeds K + player.angle, and the WARD button feeds the ward's edge counters;
  //    a no-op on desktop, so keyboard play is unchanged. CALL is a plain key button: it sets K['KeyC'] and the loop edge-consumes the
  //    whistle exactly as it does the key (never an edge counter here) ──
  initTouchControls({ canvas, K, player, getPref, edges: { Space: wardInput } })

  // ── wish dialog ──
  let dialogOpen = false
  const dialogEl = document.getElementById('wish-dialog')
  const wishText = document.getElementById('wish-text')
  const wishResp = document.getElementById('wish-response')
  const wishSubEl = document.getElementById('wish-sub')
  // what the file will hear from you today (status.js canFile): the station's last group heard, five pages read, or the deep floors
  const fileable = () => canFile({ ledgerHeard: file.ledgerHeard, pagesRead: readSet.size, depth: level.depth })
  // the faint lines under the request (status.js wishPrompt): the notice nobody answered, the three stamps you may file under — a tap types
  // the word before ' · ' and submits it — or the office closed until tomorrow. The other lines are only read
  function renderWishSub(lines) {
    if (!wishSubEl) return
    wishSubEl.textContent = ''
    for (const line of lines) {
      const s = document.createElement('span')
      s.className = 'wish-line'; s.textContent = line
      const cut = line.indexOf(' · ')
      if (cut > 0) {
        s.classList.add('stamp')
        s.addEventListener('pointerdown', (e) => {
          e.preventDefault()
          const sub = document.getElementById('wish-submit')
          if (!wishText || wishText.disabled || !sub || sub.disabled) return
          wishText.value = line.slice(0, cut); sub.click()
        })
      }
      wishSubEl.appendChild(s)
    }
  }
  function openDialog() {
    if (dialogOpen) return
    if (!isWishOpen(file.closing)) { showMessage(CLOSED_OFFICE); return }   // a file closed in compliance: there is no one left to ask
    dialogOpen = true
    document.exitPointerLock()
    if (dialogEl) {
      dialogEl.style.display = 'flex'; wishText.value = ''; wishResp.textContent = ''
      const wp = wishPrompt({ origin, status: file.status, closing: file.closing, canFile: fileable(), canRefile: canRefile(file.at, Date.now()) })
      wishText.placeholder = wp.placeholder; renderWishSub(wp.sub)
      wishText.focus()
    }
  }
  function closeDialog() { dialogOpen = false; if (dialogEl) dialogEl.style.display = 'none' }
  // the naming re-file (origin-unnamed.js): an unnamed player tells the presence 'call me ada'. The dialog closes at once and a card asks how
  // it is spelled; only a confirm writes the name into the form and files you again (a tenant now, or anchored with a pin — never processed).
  // Esc, or any forced close (a hit, a travel), leaves you unnamed and submits nothing. A re-file, not a filing: filed, thin and the file stay
  function refileName(name) {
    closeDialog(); if (wishText) wishText.disabled = false; const sub = document.getElementById('wish-submit'); if (sub) sub.disabled = false
    document.activeElement?.blur?.()   // the hidden textarea / button must not keep the keys the card reads
    openCard('confirm', { ...spellCard(name), onConfirm: () => {
      intakeCtx = refileWithName(intakeCtx, name); origin = intake(intakeCtx); rules = rulesFor(origin, thin)
      setPref('playerName', name)
      showMessage(spelledLine(name, origin), PRIO.discovery)
      if (mpClient) setTimeout(() => showMessage(ONLINE_LINE, PRIO.discovery), 2600)   // the server-attached name stays this session's
      bus?.here(hereFields())
    } })
  }
  // compliance closes the file mid-floor: the floors stop leaving pages out from now on — this one is re-read without them at once (decor
  // re-scans the resident chunks: the bodies, the stairs, the dressing and the haunts re-place identically, hashed; the pencil keeps its
  // pins), and the closing's calm reaches the events
  function applyCompliance() {
    level.cfg.scraps = { ...level.cfg.scraps, denom: 0 }
    level.decor.enterLevel(level.cfg)
    const c = chunkUnder(); level.decor.update(c.cx, c.cy)
    retension()
  }
  document.getElementById('wish-cancel')?.addEventListener('click', closeDialog)
  // what you typed is routed (compose-wish.js wishRoute), in this order: closing the file (compliance), a name (the unnamed), a status word,
  // the claim, an ordinary wish. The first three are the file's own business and never leave the room; the claim and the wish are sent
  // with the status's trailer and the column's meta (a notice nobody answered sends the text byte for byte, as it always did)
  document.getElementById('wish-submit')?.addEventListener('click', async () => {
    const text = wishText?.value.trim()
    if (!text) return
    const r = wishRoute({ text, origin, rules, file, canFile: fileable(), now: Date.now(), depth: level.depth })
    if (r.kind === 'name') { refileName(r.name); return }       // the naming re-file: the dialog closes now and a card asks the spelling
    if (wishResp) wishResp.textContent = r.reply ?? ''
    wishText.disabled = true
    document.getElementById('wish-submit').disabled = true
    if (r.kind === 'close') {
      if (r.closed) {
        applyFile(r.file); applyCompliance()
        const L = closingLines('compliance')                    // [0] is the dialog's reply; the other two once it has closed
        closingTimers.push(setTimeout(() => showMessage(L[1], PRIO.discovery), 3000 + 2600), setTimeout(() => showMessage(L[2], PRIO.discovery), 3000 + 5200))
      }
    } else if (r.kind === 'status') {
      if (r.file !== file) {                                    // filed: the claim's letters, the station and the claim start over
        applyFile(r.file)
        if (r.resets.includes('photoIdx')) photoIdx = 0
        if (r.resets.includes('stationIdx')) stationIdx = 0
        if (r.resets.includes('claimFiled')) claimFiled = false
      }
      if (r.line) closingTimers.push(setTimeout(() => showMessage(r.line, PRIO.discovery), 3000))
    } else {
      // a claim re-files a filed claimant as processed (the anchored released first) before the seam is tried; an unfiled one — the block,
      // the lobby before the first way — has no file to re-file, and claims as it always did
      if (r.kind === 'claim' && r.refile && filed) {
        origin = r.refile.origin; rules = rulesFor(origin, thin); evConfig.events = rules.eventWeights()
        for (let i = 0; i < r.refile.lines.length; i++) { const l = r.refile.lines[i]; setTimeout(() => showMessage(l, PRIO.discovery), 3000 + 2600 * i) }
        bus?.here(hereFields())
      }
      try { if (window.backrooms?.submitWish) await window.backrooms.submitWish(r.submit.text, r.submit.meta) } catch (e) { /* silent */ }
      if (r.kind === 'claim') { claimFiled = true; tryFinale() }
    }
    setTimeout(() => {
      wishText.disabled = false
      document.getElementById('wish-submit').disabled = false
      closeDialog()
    }, 3000)
  })

  // ── found scraps: notes left by earlier wanderers, read on the paper card. papercard.js is the one state machine for every card laid over
  //    the maze (page, form, confirm, sealed, choose, read): it only decides what a key does; this adapter owns the DOM, the readSet, sanity
  //    and the map pin. noteOpen === (card.state !== null) — kept by openCard / closeNoteCard — so the movement gate, `modal`, the map gate
  //    and the verbs gate hold for every mode. cardScrap is the scrap the card shows (the card's state keeps only its own keys). ──
  const readSet = new Set()          // distinct frag indices the player has read
  let noteOpen = false
  const card = createCard()
  let cardScrap = null
  const noteCardEl = document.getElementById('note-card')
  const noteTextEl = document.getElementById('note-text')
  const noteFootEl = document.getElementById('note-foot')
  const noteLinesEl = document.getElementById('note-lines')
  const noteHintEl = document.getElementById('note-hint')
  // the card as its state says: the text, the foot, and the option lines (a sealed page's read / leave, the cache menu) — each line its own
  // tap target that never reaches the card body; while there are lines they ARE the prompt, so the foot and the put-it-back hint step aside
  function renderCard(s) {
    noteTextEl.textContent = s.text
    noteFootEl.textContent = s.foot
    const lines = s.lines
    noteFootEl.style.display = lines.length ? 'none' : ''
    // (a confirm's foot is its own prompt — 'e · yes      esc · no' — so the put-it-back hint steps aside there too)
    if (noteHintEl) noteHintEl.style.display = lines.length || s.mode === 'confirm' ? 'none' : ''
    if (!noteLinesEl) return
    noteLinesEl.textContent = ''
    for (let i = 0; i < lines.length; i++) {
      const p = document.createElement('p')
      p.className = 'note-line'; p.textContent = lines[i]
      p.addEventListener('pointerdown', (e) => { e.stopPropagation(); cardInput('tapLine:' + i) })
      noteLinesEl.appendChild(p)
    }
  }
  // openCard(mode, opts, scrap): lays a card over the maze (papercard.js open's opts: text, foot, menu, onPick, onConfirm, onClose, ...);
  // refused while one is up, and without the card's DOM (never freeze invisibly). -> the card's state, or null
  function openCard(mode, opts, scrap = null) {
    if (noteOpen || !noteCardEl) return null
    const s = card.open(mode, opts)
    cardScrap = scrap
    noteOpen = true
    document.exitPointerLock()
    renderCard(s)
    noteCardEl.style.display = 'flex'
    return s
  }
  // every way a card leaves: a key or a tap that closed it (cardInput), a hit, a travel. A forced close is an Esc to the card — a choose
  // card drops nothing, a confirm card stays unconfirmed — and its onClose runs, as on every close
  function closeNoteCard() {
    const s = card.state
    if (s) { card.step(s, 'Escape'); if (s.onClose) s.onClose() }
    card.state = null; cardScrap = null; noteOpen = false
    if (noteCardEl) noteCardEl.style.display = 'none'
  }
  // one card key (CARD_KEYS from the loop's card branch), a tap on the card body ('tap') or on option line i ('tapLine:i')
  function cardInput(key) {
    const s = card.state
    if (!s) return
    const { state, action } = card.step(s, key)
    if (state === null) closeNoteCard()                 // closed by this key: the DOM and noteOpen follow the card
    else if (state !== s) renderCard(state)
    if (!action) return
    if (action.type === 'close') { if (action.confirmed && s.onConfirm) s.onConfirm() }
    else if (action.type === 'pick') { if (s.onPick) s.onPick(action.pick) }
    else if (action.type === 'reveal') revealScrap()    // the sealed page read: the card is a page now
    else if (action.type === 'redact') redactScrap()
    else if (action.type === 'refuse') showMessage(action.line)
    if (state === null && s.onClose) s.onClose()
  }
  noteCardEl?.addEventListener('pointerdown', () => cardInput('tap'))   // tap / click the card to put it back (a sealed or a choose card waits for a line)
  // a page read — a plain page on open, a sealed one when you choose to read it: counted once (the first time it steadies you), filled in
  // on the map, and the foot counts the pages
  function revealScrap() {
    const scrap = cardScrap
    if (!scrap || !card.state) return
    if (!readSet.has(scrap.frag)) { readSet.add(scrap.frag); sanity = Math.min(100, sanity + rules.scrapSanity) }   // not alone, for a moment (+6; the file's column changes it)
    if (!level.cfg.map) fog.pinThing(level.index, 'n:' + scrap.key, 'note', scrap.x, scrap.y, true)       // on the map, filled in: read
    renderCard(card.setFoot(card.state, `${readSet.size} of ${SCRAPS.length} pages found`))
  }
  // a sealed page left unread: the file notes it (compliance counts it); it still goes on the map
  function redactScrap() {
    const scrap = cardScrap
    if (!scrap) return
    // TODO(integrate:W3) I13: applyFile({ ...file, redacted: [...file.redacted, scrap.frag] }) — W3's one write seam (sealed cards open only once W3 lands)
    if (!level.cfg.map) fog.pinThing(level.index, 'n:' + scrap.key, 'note', scrap.x, scrap.y, true)
  }
  // E at a scrap: m.'s page, revealed as it opens (today's card byte for byte: the text, '{n} of 26 pages found', +6 the first time, the pin)
  function openNoteCard(scrap) {
    if (!scrap || !openCard('page', { text: SCRAPS[scrap.frag] ?? '' }, scrap)) return
    revealScrap()
  }
  // E at ∅'s form on the counter (decor's authored note, frag -1), and /intake: the file's view of you, read-only — no page count, no
  // sanity, no pin; it closes on any close key like a page
  function openForm() { openCard('form', { text: formText(intakeCtx, file.status).join('\n'), foot: FORM_FOOT }) }
  // ∅'s sealed doors (origin-tenant.js): the cell an arm's length ahead, when it is block or plywood on the FIXED map (materialAt exists only
  // there: callers check cfg.map). -> { ix, iy } or null
  function doorAhead() {
    const c = facingCell(player, 1.2)
    return isSealedMaterial(level.cache.materialAt(c.ix + 0.5, c.iy + 0.5)) ? c : null
  }
  // the system's claim about an address, read off the door; the first time at each door steadies you
  function knockDoor(c) {
    showMessage(doorLine(c.ix, c.iy), PRIO.discovery)
    const k = c.ix + ',' + c.iy
    if (!doorsSaid.has(k)) { doorsSaid.add(k); sanity = Math.min(100, sanity + DOOR_SANITY) }
  }

  // ── the map card (mapcard.js): the pencil sheet over the lower view. HELD, NOT MODAL — the pointer lock stays, the loop gates the pace
  //    and the verbs, a hit folds it. A tap on the card (touch) or on the paper corner #map-tab reads as Tab, so every way of folding it
  //    runs through the one K['Tab'] edge in the loop; touchstart's preventDefault keeps the synthesized click from firing a second one. ──
  const mapCard = createMapCard(document, { fog, getLevel: () => level, getPlayer: () => player, onTap: () => { K['Tab'] = true } })
  // body.map-open lifts the centre message over the sheet (index.html): #msg sits at 34%, the card rises from 38vh, so a line said while
  // you read the map ('you start drawing...', 'the hole is not where you drew it.') was cut in half by the paper
  function closeMap() { mapCard.close(); mapOpen = false; document.body.classList.remove('map-open') }
  const mapTabEl = document.getElementById('map-tab')
  mapTabEl?.addEventListener('touchstart', (e) => { e.preventDefault(); K['Tab'] = true }, { passive: false })
  mapTabEl?.addEventListener('click', () => { K['Tab'] = true })

  // ── resize ──
  // The backing store is the css size (today's behaviour) unless the player opted into hi-DPI, in which case the
  // director may make it up to 1.5x larger within a pixel budget; the INTERNAL render size is unaffected (renderScale
  // is scaled down to match), so a HiDPI Chromebook or phone does not silently fill more pixels.
  let lastDpr = window.devicePixelRatio
  function resize() {
    lastDpr = window.devicePixelRatio
    const p = qd.layout(window.innerWidth, window.innerHeight, lastDpr)
    if (canvas.width !== p.width || canvas.height !== p.height) { canvas.width = p.width; canvas.height = p.height }
    canvas.style.width  = p.ratio === 1 ? '' : `${p.cssW}px`
    canvas.style.height = p.ratio === 1 ? '' : `${p.cssH}px`
    qd.apply(renderOpts)
  }
  // every source of a new size only raises the flag; the loop lays out at most once per animation frame (createResizeGate)
  const resizeGate = createResizeGate()
  const queueResize = () => resizeGate.request()
  window.addEventListener('resize', queueResize)
  window.addEventListener('orientationchange', queueResize)
  watchDpr(window, queueResize)
  resize()

  const SPEED = 0.05
  const RECOIL_STEPS = 4   // the thin ward's recoil (origin-thin.js RECOIL_DIST 1.7) marches 0.425 u a step: under a cell, so it never skips a wall
  // ONE mover call per frame from the movement block (it sums W/S/A/D into one step); the thin ward's recoil is the only other caller. Solid furniture on: collide.js resolves the step against the
  // 0.12 wall box, the bodies and the creatures, and reports the contacts (noteContact). Off: the old point-vs-wall mover, verbatim.
  // movePlayer writes player.x/y itself and hands back ONE reused report; movePoint's result is reused too — read and drop.
  const EMPTY = []
  let lastReport = null
  let creaturesOn = getPref('creatures')     // read live each frame, at the top of the loop
  function tryMove(nx, ny) {
    if (!getPref('solidBodies')) {
      const pcx = Math.floor(player.x / CHUNK_SIZE)
      const pcy = Math.floor(player.y / CHUNK_SIZE)
      const r = movePoint(player.x, player.y, nx, ny, level.cache.isWall, pcx, pcy)
      player.x = r.x; player.y = r.y
      return
    }
    lastReport = level.solid.movePlayer(player, nx, ny, lastDt, wantSprint, creaturesOn ? level.entitySys.getEntities() : EMPTY)
    noteContact(lastReport)
  }

  // ── HUD (decluttered: level name only, plus optional anchor drift) ──
  const hudEl = document.getElementById('hud')
  const leashEl = document.getElementById('leash-line')   // the settings panel's locate row: how far the pin is pulling (anchored only)
  let leashText = ''
  function updateHud() {
    if (!hudEl || !level) return
    let text = level.cfg.levelName
    if (anchor) text += `   ·   drift ${driftD()}m`
    hudEl.textContent = text
    const lt = rules.leash ? `leash ${driftD()} m` : ''
    if (leashEl && lt !== leashText) { leashText = lt; leashEl.textContent = lt }   // written only when it changes (the panel is mostly hidden)
  }

  // ── HP bar ──
  const hpFill = document.getElementById('hp-fill')
  function updateHp() {
    if (!hpFill) return
    const pct = Math.max(0, Math.min(100, player.hp))
    hpFill.style.width = pct + '%'
    hpFill.style.background = pct > 50 ? 'rgba(60,150,70,0.85)'
                            : pct > 25 ? 'rgba(200,165,40,0.9)'
                            :            'rgba(205,55,45,0.95)'
  }

  // ── sanity bar + the low-sanity screen wash ──
  const sanFill  = document.getElementById('san-fill')
  const insaneEl = document.getElementById('insanity')
  function updateSanity() {
    if (!sanFill) return
    const pct = Math.max(0, Math.min(100, sanity))
    sanFill.style.width = pct + '%'
    sanFill.style.background = pct > 50 ? 'rgba(120,112,185,0.82)'
                             : pct > 25 ? 'rgba(150,92,182,0.86)'
                             :            'rgba(184,60,140,0.92)'
  }

  // ── stamina bar ──
  const stamWrap = document.getElementById('stamina-wrap')
  const stamFill = document.getElementById('stamina-fill')
  function updateStamina() {
    if (!stamWrap || !stamFill) return
    stamWrap.style.opacity = stamina < 99.5 ? '1' : '0'
    stamFill.style.width = `${Math.max(0, Math.min(100, stamina))}%`
  }

  // ── hotbar (click a slot to select; discard button drops the selected item) ──
  const hotbarEl = document.getElementById('hotbar')
  function renderHotbar() {
    if (!hotbarEl) return
    let html = ''
    for (let i = 0; i < 6; i++) {
      const item = itemSys.inventory[i]
      const sel = i === itemSys.selected ? ' sel' : ''
      const full = item ? (ITEM_NAMES[item.type] ?? item.type) : ''
      const words = full.split(' ')
      // provisions read by their first word (almond, radio); a tool reads by what it is (a survey plumb is a plumb)
      const label = item ? (item.tool ? words[words.length - 1] : words[0]) + (item.on ? ' ♪' : '') : ''
      html += `<div class="slot${sel}" data-slot="${i}" title="${full}"><span class="num">${i + 1}</span>${label}</div>`
    }
    hotbarEl.innerHTML = html
    for (const el of hotbarEl.querySelectorAll('.slot')) {
      el.addEventListener('click', () => { cancelCommit(); itemSys.select(+el.dataset.slot); renderHotbar() })   // a slot change ends a wrap
    }
  }
  // X and the dock's ✕: set the selected item down. setDown asks first, on the paper card, whether to leave a word with it — six of m.'s
  // twelve phrases (caches.js menuFor: the same six for this floor and this kind of thing, whoever holds it), or nothing. Nothing (0, Esc)
  // is today's plain drop; the thing stays in your hand until you pick, and a hit that folds the card sets nothing down. The deep-stack
  // finds are refused before anything is offered. No card to ask on: today's X exactly
  function setDown() {
    const it = itemSys.peekSelected()
    if (!it || !noteCardEl) { throwSelected(null); return }
    if (KEPT.has(it.type) || it.tool) { showMessage('you do not put that down.'); return }
    const menu = menuFor(level.index, it.type)
    openCard('choose', { text: `leave a word with the ${ITEM_NAMES[it.type] ?? it.type}, for whoever finds it.`, menu: menu.map((i) => PHRASES[i]),
      onPick: (i) => throwSelected(i == null ? NOTE_NONE : { ph: menu[i], oct: octOf(player.angle), by: myName(), byId: myId() ?? undefined }) })
  }
  // items.js throwSelected — 1.2 u ahead, or at your feet against a wall. A radio keeps talking where it lies (the things go to it), a
  // glowstick is a breadcrumb. With a note it is a cache: its key is the cell it LANDED in (one live cache a cell — a second replaces the
  // first), the ledger counts it as yours (the oldest of seven goes), and the room is told — the relay keeps it for whoever comes later
  function throwSelected(note = null) {
    const r = itemSys.throwSelected(player.x, player.y, player.angle, playT, note)
    if (!r.ok) { if (r.reason === 'kept') showMessage('you do not put that down.') }
    else {
      cancelCommit()                                          // the bandage you were wrapping is on the floor now
      const t = r.item.type
      if (note) {
        const cx = Math.floor(r.x), cy = Math.floor(r.y), ck = cacheKey(level.index, cx, cy)
        r.item.cacheKey = ck                                  // the live record: getDropped exports it, levelmem keeps it
        const old = ledger.place({ key: ck, lvl: level.index, cx, cy, id: myId(), name: myName(), t: playT })
        if (old.replaced) removeCache(old.replaced)
        for (const e of old.evicted) removeCache(e)
        ledger.bind(ck, r.item.key)
        relayLater('cache', { lvl: level.index, cx, cy, x: r.x, y: r.y, type: t, ex: exOf(r.item), ph: note.ph, oct: note.oct }, { keep: ck })
      }
      showMessage(t === 'radio' && r.item.on ? 'you set the radio down, still talking. let it talk.'
                : t === 'glowstick'          ? 'you leave the green light where it lies.'
                : note                       ? 'you set it down.'
                :                              `you drop the ${ITEM_NAMES[t] ?? t}.`)
    }
    renderHotbar()
    // (the floor's memory of what lies here is written by the loop on its one itemsDirty read: mem.setDropped)
  }
  // a cache leaves the world wherever it lies: on this floor through items.js (dirty -> the loop's one memory write), on another floor out
  // of that floor's memory, so it is not there when you go back; one still waiting for its floor was never laid down
  function removeCache(e) {
    if (e.pending) return
    if (e.lvl === level.index) { if (e.localKey) itemSys.takeDropped(e.localKey) }
    else if (mem.get(e.lvl)) mem.setDropped(e.lvl, mem.droppedFor(e.lvl).filter((r) => r.cacheKey !== e.key))
  }
  // the room hears a cache or a take now — or, inside the kind's outgoing gap, from the outbox, behind whatever is already waiting (in order:
  // a take never overtakes the cache it takes). Solo: nobody to tell
  function relayLater(kind, payload, opts) { if (!bus) return; if (evOutbox.length || !bus.emit(kind, payload, opts)) evOutbox.push([kind, payload, opts]) }
  // the flags a cache carries on the wire (a relayed radio arrives silent; the clocks stay with whoever set it down)
  const exOf = (it) => ({ ...(it.sour && { sour: true }), ...(it.tool && { tool: true }) })
  document.getElementById('btn-discard')?.addEventListener('click', setDown)

  // ── multiplayer chat ──
  const chatLogEl    = document.getElementById('chat-log')
  const chatInputEl  = document.getElementById('chat-input')
  const chatTypingEl = document.getElementById('chat-typing')
  let chatOpen = false
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const nameColor = (n) => { let h = 0; for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0; return `hsl(${h % 360} 72% 68%)` }
  const chatLines = []
  function renderChat() {
    if (!chatLogEl) return
    chatLogEl.innerHTML = chatLines.map(l => {
      if (l.sys) return `<div class="chat-sys">— ${escapeHtml(l.from)} ${escapeHtml(l.text)}</div>`
      if (l.text.startsWith('/me ')) return `<div class="chat-me" style="color:${nameColor(l.from)}">✦ ${escapeHtml(l.from)} ${escapeHtml(l.text.slice(4))}</div>`
      return `<div class="chat-line"><b style="color:${nameColor(l.from)}">${escapeHtml(l.from)}</b> ${escapeHtml(l.text)}</div>`
    }).join('')
    chatLogEl.style.opacity = '1'
    clearTimeout(renderChat._t)
    renderChat._t = setTimeout(() => { if (!chatOpen) chatLogEl.style.opacity = '0.3' }, 7000)
  }
  const JOINED_LINE = 'entered the level.', JOIN_SAY_MS = 2000
  const joinedLine = (id) => {
    const p = bus.peers.get(id)
    return p && bus.fresh(id) && p.status !== 'notice-mailed' ? `entered the level, filed under ${p.status}.` : JOINED_LINE
  }
  // (from, text, isSystem, id): the client hands the speaker's id as a 4th argument (a chat, a join, a leave). A friend walking in is said
  // once their heartbeat has had JOIN_SAY_MS to name the file they are under — 'entered the level, filed under extension.'; no heartbeat by
  // then (an old client) or an unanswered notice, today's 'entered the level.'. A friend who speaks is not a quiet one (the roll call's touch)
  function addChatLine(from, text, isSystem, id) {
    if (isSystem && id && bus && text === JOINED_LINE) { setTimeout(() => addChatLine(from, joinedLine(id), true), JOIN_SAY_MS); return }
    if (id && !isSystem && mpClient && id !== mpClient.id) rollcall.touch(id, performance.now())
    chatLines.push({ from, text, sys: isSystem })
    if (chatLines.length > 8) chatLines.shift()
    renderChat()
    if (!isSystem && mpClient && from !== mpClient.getName()) blip()   // ping on others' messages
  }
  // incoming "is typing…"
  let typingHideT = null
  function showTyping(name, on) {
    if (!chatTypingEl) return
    clearTimeout(typingHideT)
    if (on) { chatTypingEl.textContent = `${name} is typing…`; chatTypingEl.style.opacity = '1'; typingHideT = setTimeout(() => { chatTypingEl.style.opacity = '0' }, 4000) }
    else { chatTypingEl.style.opacity = '0' }
  }
  // outgoing typing signal (debounced)
  let typingSent = false, typingStopT = null
  function noteTyping() {
    if (!mpClient) return
    if (!typingSent) { typingSent = true; mpClient.sendTyping(true) }
    clearTimeout(typingStopT)
    typingStopT = setTimeout(() => { typingSent = false; mpClient.sendTyping(false) }, 1800)
  }
  function openChat() {
    if (!chatInputEl || chatOpen) return          // solo too — the input doubles as the field console
    chatOpen = true
    for (const k in K) K[k] = false            // drop any held movement keys
    charger.forceRelease()                     // and a ward being held: typing never fires it
    document.exitPointerLock()
    chatInputEl.style.display = 'block'; chatInputEl.value = ''; chatInputEl.focus()
    if (chatLogEl) chatLogEl.style.opacity = '1'
  }
  function closeChat() {
    chatOpen = false
    if (chatInputEl) chatInputEl.style.display = 'none'
    if (typingSent) { typingSent = false; clearTimeout(typingStopT); mpClient?.sendTyping(false) }
  }
  chatInputEl?.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      const t = chatInputEl.value.trim()
      if (t.startsWith('/') && !t.startsWith('/me ')) handleCommand(t)   // the field console
      else if (t && mpClient) mpClient.sendChat(t)
      else if (t) showMessage('no one is here to hear it.')
      closeChat()
    }
    else if (e.code === 'Escape') closeChat()
    else noteTyping()
  })

  // ── the field console: the chat input doubles as a command line, solo or
  //    online. /recover reports the open case (and at the sealed door on
  //    Level ∅ surfaces its key); /file <answer> reads the next instrument
  //    against the case manifest — the SAME salted hash and the SAME
  //    same-origin keyring the web board at /recover/ uses, so a task done in
  //    the maze shows as read on the board, and vice versa. ──
  // the open case is remembered per browser (cs.case.open); /recover <case> switches it.
  const RECOVER_DEFAULT = 'case-d8'
  const rOpenCase = () => { try { return localStorage.getItem('cs.case.open') || RECOVER_DEFAULT } catch (e) { return RECOVER_DEFAULT } }
  const rSetOpenCase = (id) => { try { localStorage.setItem('cs.case.open', id) } catch (e) {} }
  const RECOVER_SALT = 'cornerspore:'
  const rNorm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '')
  async function rHash(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RECOVER_SALT + rNorm(s)))
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
  }
  const rKey = (c, s) => 'cs.case.' + c + '.' + s
  const rSolved = (c, s) => { try { return localStorage.getItem(rKey(c, s)) === '1' } catch (e) { return false } }
  let recoverManifest = null, recoverIndex = null
  // The desktop app runs from file://, where ../recover/ does not exist: there the live manifests are read from the public
  // site, the same https origin /play/ is served from (GitHub Pages sends Access-Control-Allow-Origin: *). The PWA keeps
  // its relative, same-origin path exactly as before.
  const RECOVER_REMOTE = typeof location !== 'undefined' && location.protocol === 'file:'
  const RECOVER_BASE = RECOVER_REMOTE ? 'https://backrooms.thecornerspore.dev/recover/cases/' : '../recover/cases/'
  async function loadIndex() {
    if (recoverIndex) return recoverIndex
    const r = await fetch(RECOVER_BASE + 'index.json', { cache: 'no-store' })
    if (!r.ok) throw new Error('no index')
    recoverIndex = (await r.json()).cases || []
    return recoverIndex
  }
  async function loadCase(id) {
    const want = id || rOpenCase()
    if (recoverManifest && recoverManifest.id === want) return recoverManifest
    const r = await fetch(RECOVER_BASE + want + '.json', { cache: 'no-store' })
    if (!r.ok) throw new Error('no case')
    recoverManifest = await r.json()
    return recoverManifest
  }
  // '/recover d8', '/recover case-s37', '/recover S-37' all resolve against the index
  async function resolveCase(q) {
    const n = rNorm(q)
    if (!n) return null
    const idx = await loadIndex()
    return idx.find(c => rNorm(c.id) === n || rNorm(c.code) === n || rNorm(c.id) === 'case' + n) || null
  }
  async function handleCommand(t) {
    const parts = t.slice(1).trim().split(/ +/)   // plain-space split — no escapes to lose in transit
    const cmd = parts[0], arg = parts.slice(1).join(' ')
    try {
      if (cmd === 'recover' || cmd === 'case' || cmd === 'cases') {
        if (cmd === 'cases' || arg === 'list') {
          const idx = await loadIndex()
          const rows = idx.map(c => c.code + ' ' + (c.stations || []).filter(s => rSolved(c.id, s)).length + '/' + (c.stations || []).length + (c.id === rOpenCase() ? ' (open)' : ''))
          const shown = rows.slice(0, 5), more = rows.length - shown.length
          showMessage(rows.length ? shown.join(' · ') + (more > 0 ? ' · and ' + more + ' more on the board' : '') + ' — /recover <case> opens one.' : 'no cases have surfaced.')
          return
        }
        if (arg) {
          const c = await resolveCase(arg)
          if (!c) { showMessage('no case answers to that. /cases lists them.'); return }
          rSetOpenCase(c.id)
        }
        const m = await loadCase()
        const done = m.stations.filter(s => rSolved(m.id, s.id)).length
        const next = m.stations.find(s => !rSolved(m.id, s.id))
        showMessage(m.title + ' — ' + done + ' of ' + m.stations.length + ' instruments read.' + (next ? ' next: ' + next.title + '.' : ' the case is read.'))
        // a station may declare where in the maze it can be read (manifest .maze = {level | levels, hint})
        const mazeLevels = next && next.maze ? (next.maze.levels || [next.maze.level]) : []
        if (next && next.maze && next.maze.hint && mazeLevels.includes(level?.index ?? 0))
          setTimeout(() => showMessage(next.maze.hint), 2600)
      } else if (cmd === 'file') {
        if (!arg) { showMessage('file what? /file <answer>'); return }
        const m = await loadCase()
        const next = m.stations.find(s => !rSolved(m.id, s.id))
        if (!next) { showMessage('the case is already read.'); return }
        if ((await rHash(arg)) === String((next.gate && next.gate.hash) || '').toLowerCase()) {
          try { localStorage.setItem(rKey(m.id, next.id), '1') } catch (e) {}
          blip(); showMessage('filed. ' + next.title + ' — read. ' + (next.onSolve || ''))
          if (!m.stations.some(s => !rSolved(m.id, s.id)))
            setTimeout(() => showMessage(((m.reward && m.reward.key) || 'the case is read.') + ' — open the board at /recover/.'), 3000)
        } else showMessage('the file does not answer to that.')
      } else if (cmd === 'intake') {
        // the form again, read-only; anything typed after it is an amendment, and the file does not take those
        const r = parseIntakeCommand(arg)
        if (r.refuse) showMessage(r.refuse)
        else openForm()
      } else showMessage('the file does not recognise that. try /recover, /cases, /file <answer> or /intake.')   // TODO(integrate:W3) I13/I15: the ONE string 'the file does not recognise that. try /recover, /cases, /file <answer>, /intake or /status.' once /status lands
    } catch (e) {
      // desktop: a fetch that never reached the site (offline, DNS, blocked) says so plainly
      if (RECOVER_REMOTE && e && e.name === 'TypeError') showMessage('no signal. the file is kept online —\nconnect to the internet and try again.')
      else showMessage('the file could not be opened from here.')
    }
  }
  if (mpClient) {
    mpClient.onChat(addChatLine)
    mpClient.onTyping(showTyping)
    addChatLine('', 'connected — Enter to chat · /me to emote', true)
  }

  // ── the event bus (src/net/evbus.js): the one relayed 'ev' every co-op verb rides, and 'here' — the heartbeat that tells the room which
  //    floor you are on and what the file knows of you (and you of them: the bus merges a friend's onto their players-list record, the
  //    sprites read it). null solo, so every `bus?.` is a no-op there and the game is today's. Nothing here allocates per frame: the roster
  //    the bus reads (peerIdSet, peerRec) is refilled in place by fillRemotes, self() writes one object, hereFields() fills one. ──
  const selfPos = { x: 0, y: 0, lvl: 0 }
  const peerIdSet = new Set(), peerRec = new Map()        // the players list's ids and their last records (x, y), this frame
  const peerPos = (id) => peerRec.get(id) ?? null
  // the one frame (evidence.js): the sprite cull's view cone and the walls' line of sight (raycaster.js; bodies never block it) — a friend
  // in it develops on the film, a lost soul in it shows the door behind them. Hoisted once: the photo allocates no options
  const frameLos = (ax, ay, bx, by) => lineOfSight(ax, ay, bx, by, level.grid.floor)
  const FRAME_OPTS = { pos: peerPos, cone: inViewCone, hf: HF, maxCells: SUBJECT_RANGE, los: frameLos }
  // a friend's light (lightshare.js): who lights you, by the same walls-only line of sight, six cells; hoisted, the per-frame ask allocates nothing
  const LIT_OPTS = { cells: LIT_RANGE, los: frameLos, pos: peerPos }
  // your ward on the wire (one reused payload: sendEv serialises it at once), and a friend's, re-run on YOUR things from where they stand
  const wardOut = { x: 0, y: 0, a: 0, lvl: 0 }
  const wardProbe = { x: 0, y: 0, angle: 0 }
  // someone has evidence of you (evidence.js): a friend's photograph holds you over 25 sanity for 90 s on the play clock, and says so on 'here'
  const evidence = createEvidence()
  // who you could kneel by (downed.js downedInFront): the same walls-only line of sight, hoisted so the per-frame ask allocates nothing
  const DN_OPTS = { los: frameLos }
  // the two kinds that name the RECEIVER (rollcall.js evKinds: a kneel's `to`, a woke's `by` must be my id) — and emit() runs that same
  // check on what I send, which names someone else. So I send ONE reused payload each, let through by identity; every frame received
  // (never this object) is checked exactly as evKinds says
  const kneelOut = { to: '' }, wokeOut = { by: '' }
  const callOut = { x: 0, y: 0, lvl: 0, c: true }   // your whistle on the wire: one reused payload (sendEv serialises it at once)
  const bus = mpClient ? createEvBus({
    send: mpClient.sendEv, now: () => performance.now(),
    self: () => { selfPos.x = player.x; selfPos.y = player.y; selfPos.lvl = level ? level.index : 0; return selfPos },
    peerPos, peerIds: () => peerIdSet, selfId: () => mpClient.id, mergeRemote: mpClient.mergeRemote,
  }) : null
  if (bus) {
    mpClient.onEv(bus.receive)
    // a friend's floor change is a people line: 'no-clipped deeper.' / 'climbed back.' / 'fell in.' (none when the depth held)
    bus.onFloorChange((id, name, from, to, line) => { if (line) addChatLine(name || 'someone', line, true) })
    // the room's files on this floor moved (a friend arrived, left or re-filed): the floor's lean is read again — the docket's standing never is
    bus.onRoomChange(() => { if (level) { level.amb = ambientMods(level.st, bus.roomStanding()); retension() } })
    // the kinds, registered in this one place (the bus believes nothing it was not told about); each item's handlers land in its own step
    const kinds = evKinds(() => mpClient.id)
    bus.register('whistle', kinds.whistle)   // lvl 0..4, a spot within 2 of where the list has them, one per 8 s each
    bus.register('kneel', { ...kinds.kneel, check: (p) => (p === kneelOut && typeof p.to === 'string') || kinds.kneel.check(p) })   // to me, within 2, one per 350 ms
    bus.register('woke', { ...kinds.woke, check: (p) => (p === wokeOut && typeof p.by === 'string') || kinds.woke.check(p) })       // names me, within 3
    // a friend whistles on this floor: their pitch, from where they stand (panned, fainter with distance, half under your radio), a people
    // line with the bearing — never #msg — and they are on the roll call. A whistle from far off steadies you once a minute per friend
    bus.on('whistle', ({ id, name, payload: p }) => {
      if (!level || p.lvl !== level.index) return
      const dx = p.x - player.x, dy = p.y - player.y, dist = Math.hypot(dx, dy), now = performance.now()
      whistle(whistlePitch(id, name), whistlePan(dx, dy, player.angle), whistleGain(dist, radioWasOn))
      addChatLine(name || 'someone', `whistles · ${bearingLabel(dx, dy, player.angle)}`, true)
      rollcall.hear(id, name, p.x, p.y, now)
      if (dist > FAR_BONUS.cells && rollcall.farBonusOk(id, now)) { sanity = Math.min(100, sanity + FAR_BONUS.sanity); company.add(FAR_BONUS.company) }
    })
    // a friend kneels by you while you are down: their eighth tick (not before 4 s) counts you back — where you fell, never through die()
    bus.on('kneel', ({ id }) => { if (down.st === 'down' && down.kneelTick(id) === 'woken') wakeUp(id) })
    // the one you knelt by came back (their 'woke' lands after their 'here' already said 'ok': the kneel remembers whom, 2 s)
    bus.on('woke', ({ id }) => { if (kneel.wasKneelingOn(id)) { sanity = Math.min(100, sanity + KNEELER_SANITY); showMessage(KNEELER_LINE, PRIO.interaction) } })
    // a cache and its taking (caches.js): replayable — the relay keeps the last ones and hands them, stamped replay, to whoever comes later;
    // a live cache must be set down where the list has its owner standing (x / y within the slack)
    bus.register('cache', { check: (p) => isCachePayload(p, ITEM_NAMES), replayable: true, posKeys: ['x', 'y'], minGapMs: 3000 })
    bus.register('take', { check: isTakePayload, replayable: true, minGapMs: 500 })
    // a friend's ward and a friend's photograph (lightshare.js / evidence.js): never replayed — a push or a picture from before you came means
    // nothing. emit() runs the same check on what I send, which names a friend, so the photo's check is its shape and the handler asks
    // whether it is of me
    bus.register('ward', { check: (p) => Number.isInteger(p.lvl) && p.lvl >= 0 && p.lvl <= 4 && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.a), posKeys: ['x', 'y'], minGapMs: 600 })
    bus.register('photo', { check: (p) => typeof p.of === 'string' && Number.isInteger(p.lvl) && p.lvl >= 0 && p.lvl <= 4, maxDist: 11, minGapMs: 4000 })
    // a friend sets a cache down: on this floor it is laid where they stood (the nearest open cell if the floor has moved), with a people line
    // when it happens live; for another floor it waits in the ledger until you get there (buildLevel). Same cell: the newest wins; the
    // seventh from one owner retires their oldest
    bus.on('cache', ({ id, name, payload: p, replay }) => {
      if (!level) return
      const key = cacheKey(p.lvl, p.cx, p.cy), here = p.lvl === level.index
      const r = ledger.place({ key, lvl: p.lvl, cx: p.cx, cy: p.cy, id, name, t: playT, pending: here ? null : { x: p.x, y: p.y, type: p.type, extra: extraFor(p, id, name, key) } })
      if (r.replaced) removeCache(r.replaced)
      for (const e of r.evicted) removeCache(e)
      if (here) {
        const open = level.grid.floor(Math.floor(p.x), Math.floor(p.y)) ? p : findOpenNear(p.x, p.y, level.grid.floor)
        if (open) ledger.bind(key, itemSys.dropAt(open.x, open.y, p.type, extraFor(p, id, name, key), null).key); else ledger.take(key)
        if (!replay) addChatLine(name || 'someone', 'sets something down.', true)
      }
    })
    // someone took a cache: it is gone from wherever it lies for you too
    bus.on('take', ({ payload: { key } }) => { const e = ledger.take(key); if (e) removeCache(e) })
    // a friend wards on this floor: their tap is re-run on YOUR things from where they stand (the things are each client's own) — what it
    // staggers, throws or takes apart, it does here too, and they are a noise of 10 the things hear (theirs: never your stillness, never your
    // noiseMul). Only when you stood in its cone and it met something does it reach you: steadied
    bus.on('ward', ({ id, name, payload: p }) => {
      if (!level || p.lvl !== level.index || !bus.onFloor(id)) return
      wardProbe.x = p.x; wardProbe.y = p.y; wardProbe.angle = p.a
      const res = getPref('creatures') ? level.entitySys.ward(wardProbe, WARD_TAP) : EMPTY_WARD
      level.entitySys.noise(p.x, p.y, 10, 'friend')
      const out = wardOutcome(inCone(p, player), res)
      if (out === 'steadied') { sanity = Math.min(100, sanity + 8); calmTimer = Math.max(calmTimer, 4); hurt = 0; wardPulse(); shake = Math.max(shake, 0.2) }
      const line = wardLine(out, name || 'someone', res)
      if (line) showMessage(line, PRIO.interaction)
    })
    // a friend photographs you: evidence — 90 s you do not go under 25, and the room sees you solid. Lying down, it counts you back at once
    // (the ONE wake: never die(), never a layer, never the pin's debt)
    bus.on('photo', ({ id, payload: p }) => {
      if (!level || p.of !== mpClient.id || p.lvl !== level.index || !bus.onFloor(id)) return
      evidence.seen(id, playT)
      if (photoOutcome(down.st) === 'counted' && down.wakeNow() === 'woken') wakeUp(id, COUNTED_LINE)
      else { sanity = Math.min(100, sanity + 6); wardPulse(); showMessage(EVIDENCE_LINE, PRIO.discovery) }
      bus.here(hereFields())
    })
  }
  // what 'here' says of you (bus.here sends it at once when a field changed, else every 3 s from tick): ONE object, filled per call (the bus
  // copies it). Sent about once a second from the loop, and at once after a travel or a death
  const myAseed = anchor ? anchorSeed(anchor.lat, anchor.lng) : null
  const hereObj = { lvl: 0, lit: true, st: 'ok', seen: false, o: null, thin: false, status: 'notice-mailed', aseed: myAseed }
  // what the sanity step reads of your own file beside a friend's (the status's affinity, the same pin): ONE object, refilled with 'here'
  const selfFile = { status: 'notice-mailed', aseed: myAseed, origin: null, thin: false }
  let hereTimer = 1                                        // the first frame says it
  function hereFields() {
    hereObj.lvl = level ? level.index : 0
    hereObj.lit = flashlight
    hereObj.st = kneel.st ? 'kneel' : down.st
    hereObj.seen = evidence.active(playT)   // a friend's photograph of you is still developing: they draw you solid (thin or not)
    hereObj.o = origin
    hereObj.thin = thin
    hereObj.status = file.status
    hereObj.aseed = myAseed
    selfFile.status = file.status; selfFile.aseed = myAseed; selfFile.origin = origin; selfFile.thin = thin
    return hereObj
  }

  // ── down, and counted back (downed.js). goDown: the fatal hit laid you down — your light goes out (the stillness rule hides a still,
  //    dark body like any other), the veil comes over, the room hears 'down'. wakeUp is the ONE wake: a friend's eighth kneel tick, or
  //    a friend's photograph (COUNTED_LINE) — where you fell, 60 hp, never through die(), never a layer minted, never the pin's debt. It does not
  //    flip down.st: the caller did (kneelTick / wakeNow returned 'woken'). The kneel: F by a downed friend in front lights you and holds
  //    you still beside them; F again, a step, Space, Esc, or their leaving 'down' or six cells ends it ──
  function goDown() {
    if (kneel.st) stopKneel(null)
    down.goDown()                                  // bare: the down state's own ms clock
    savedLight = flashlight; flashlight = false
    document.body.classList.add('down')            // the line reads over the veil (index.html: body.down #msg)
    showMessage(DOWN_LINE, PRIO.combat)
    bus?.here(hereFields())
  }
  function wakeUp(byId, line = WOKEN_LINE) {
    player.hp = Math.min(WAKE.hp, player.maxHp); sanity = Math.min(100, sanity + WAKE.sanity)
    invuln = WAKE.invuln; regenDelay = WAKE.regenDelay; hurt = 0
    flashlight = savedLight
    if (downEl) downEl.style.opacity = '0'
    document.body.classList.remove('down')
    showMessage(line, PRIO.interaction)
    if (bus) { wokeOut.by = byId; bus.emit('woke', wokeOut) }
    bus?.here(hereFields())
  }
  function startKneel(rp) {
    kneel.start(rp.id, rp.name, performance.now(), wardInput.press)   // the ward's press count now: a later Space is a change the frame sees
    savedLight = flashlight; flashlight = true                         // you cannot count what you cannot see: lit, still — the hunted one
    bus?.here(hereFields())
  }
  function stopKneel(line) {
    kneel.stop(); flashlight = savedLight
    if (line) showMessage(line, PRIO.interaction)
    bus?.here(hereFields())
  }

  // ── the whistle (rollcall.js): C calls out — two notes at your own pitch, a noise of 14 at your feet the things two corners off hear (it
  //    is yours: the stillness clocks start again and a stand ends), and the room hears it as the ONE reused frame. One line a call, never
  //    two: who has answered lately, counted in words — or, alone where nothing hunts, the hall keeping it. Alone where something does, it
  //    steadies you a little, and one call in six something answers in the wrong pitch (on this floor only: a travel or a death drops it).
  //    One a WHISTLE_COOLDOWN_MS on the roll call's ms clock: a second inside it is swallowed, no line. `whistle` is audio.js's: hence the name ──
  function whistleOut(live) {
    const now = performance.now()
    if (now - lastWhistleAt < WHISTLE_COOLDOWN_MS) return
    lastWhistleAt = now
    whistle(whistlePitch(mpClient?.id ?? 'solo', mpClient?.getName() ?? 'wanderer'), 0, 1)
    level.entitySys.noise(player.x, player.y, WHISTLE_NOISE)
    stillness.noise(playT); standHeld = 0
    const n = rollcall.count(now)
    if (bus) { callOut.x = player.x; callOut.y = player.y; callOut.lvl = level.index; callOut.c = n <= 32; bus.emit('whistle', callOut) }
    showMessage(n === 1 && !live ? NO_ANSWER_LINE : countLine(n), PRIO.interaction)
    if (n === 1 && live) {
      sanity = Math.min(100, sanity + SOLO_SANITY)
      if (rollcall.echoRoll()) {
        const g = arrivalGen
        setTimeout(() => { if (g !== arrivalGen) return; footfall(ECHO.footfalls); sanity = Math.max(0, sanity - ECHO.sanity); showMessage(ECHO_LINE, PRIO.interaction) }, ECHO.delayMs)
      }
    }
  }

  // ── messages (black text, fades via opacity — see CSS): one voice. Every line goes through the priority queue (messages.js) so a
  //    floor murmur never talks over 'it has you.'; the loop ticks it and writes #msg. Default priority: interaction (what you did). ──
  const msgEl  = document.getElementById('msg')
  let msgTimer = 0
  let msgNext  = base.messageInterval[0] + Math.random() * (base.messageInterval[1] - base.messageInterval[0])
  const msgQ = createMessageQueue()
  function showMessage(text, prio = PRIO.interaction) { if (text) msgQ.push(String(text), prio) }

  // ── polaroid ──
  const flashEl = document.getElementById('flash')
  let flashAt = -1e9, flashT = 0
  const FLASH_OPTS = { range: 6, cone: FOV, stagger: 1.8 }, NO_FLASH = { hit: 0 }   // what the flash does to the things (entities.js flash)
  function firePolaroid() {
    let dataUrl = null
    // through the renderer: a WebGL canvas is only readable when re-drawn, and the GPU backend draws on a sibling canvas, not on #c
    try { dataUrl = level?.gfx?.capture ? level.gfx.capture() : canvas.toDataURL('image/png') } catch { /* ignore */ }
    if (flashEl) {
      // A gentle ramp to a soft peak and a long decay (was: instant 90% white). Photosensitivity: a second flash
      // inside minGapMs is skipped so mashing the button cannot strobe the screen; reduceFlicker lowers it further.
      // The flash also shares the flicker limiter's budget (flashWait / noteFlash): it is held back while a light dip
      // is starting or has just started, and counts as a dip start itself, so the two never exceed 3 flashes a second.
      const fx = flashFor(renderOpts.reduceFlicker), now = performance.now()
      if (now - flashAt >= fx.minGapMs) {
        flashAt = now
        clearTimeout(flashT)
        const go = () => {
          noteFlash(fk)
          flashEl.style.transition = `opacity ${fx.attackMs}ms ease-out`; flashEl.style.opacity = String(fx.peak)
          flashT = setTimeout(() => { flashEl.style.transition = `opacity ${fx.decayMs}ms ease-in-out`; flashEl.style.opacity = '0' }, fx.attackMs)
        }
        const wait = flashWait(fk, renderOpts.reduceFlicker)
        if (wait > 0) flashT = setTimeout(go, Math.ceil(wait * 1000) + 30); else go()
      }
    }
    // the flash reaches the things: everything in the cone with a line to you reels, blind (a smiler or a lurker turns and runs);
    // the shutter is a noise they hear
    level.entitySys.noise(player.x, player.y, 9)
    const b = getPref('creatures') ? level.entitySys.flash(player, FLASH_OPTS) : NO_FLASH
    if (b.hit) showMessage('the flash catches it. it reels, blind.', PRIO.interaction)
    // the caption develops from the LIVE frame, so it works in the browser too (no save bridge). What it develops (compose-polaroid.js): a
    // friend in frame (the photo goes to them), the column's own film (thin's first shot, the anchored pin, the unnamed's letter that is not
    // theirs), a lost soul and the door behind them, the thin figure, the hall, the claim's letter — under LEGACY with nobody in frame the
    // three captions as they were. A capture is a small counter-claim: it steadies you (+8, after the caption read the sanity it was taken at)
    const thinNear = ephemera.some(a => a.variant === 'thin' && (a.x - player.x) ** 2 + (a.y - player.y) ** 2 < 16)
    const subject = bus ? subjectInFrame(player, bus.freshPeersOnFloor(), FRAME_OPTS) : null   // one reused record: read in the call, never kept
    const np = level.decor.nearestNpc(player.x, player.y, SOUL_RANGE)
    const soul = np && inFrame(player, np.x, np.y, FRAME_OPTS) ? np : null
    const r = polaroidCaption({ rules, mods, subject, soul, doorArrow: soul ? knownWayArrow() : null, thinNear, status: file.status,
      index: level.index, depth: level.depth, sanity, origin, thin, thinFirstShot, anchor, D: driftD(), firstShotOfLevel: !shotOnLevel,
      photoIdx, player, lvl: level.index })
    shotOnLevel = true
    if (thin) thinFirstShot = false
    if (r.emitPhoto && bus) bus.emit('photo', r.emitPhoto)    // the friend in frame is sent the photo (the bus refuses a kind not yet registered)
    if (r.glyphAdvance) photoIdx++
    sanity = Math.min(100, sanity + r.sanity); wardPulse()
    if (r.leashCalm) leashCalm = r.leashCalm                   // a pin caption quiets the leash for a while
    // still save the real evidence file on desktop; the caption shows regardless
    if (dataUrl && window.backrooms?.savePhoto) window.backrooms.savePhoto(dataUrl).catch(() => {})
    showMessage(r.cap)
  }
  // the door a lost soul in the film stands before: the nearest way you have SEEN that leads on, as the compass would point it from here
  // (compass.js compassLines over the pencil sheet, no faint fallback); null when none is known, or on the block (it keeps no sheet)
  const doorOut = []
  function knownWayArrow() {
    if (level.cfg.map) return null
    compassLines({ player, known: fog.ways(level.index) }, doorOut)
    return doorOut.length ? doorOut[0].arrow : null
  }

  // The radio: cosmetic hum near the surface; in the deep stacks (floors 2–3) it reads the ledger aloud, one number group at a time — not
  // talking to you, reading a list, counting DOWN to your line. What it says (compose-radio.js): the status's mode on the near floors (the
  // crackle for a notice nobody answered, the floor's roll call for a filed one), the ledger below; the column's heartbeat and last line
  // (the roll call's count of who answered layers over today's 'that one was yours.'); the last group heard goes on the file
  function readRadio(on) {
    const r = radioLine({ on, rules, mode: mods.radioMode(level.depth), stationIdx, groups: RADIO_GROUPS, count: rollcall.count(performance.now()),
      firstDeepHearing, rollLine: level.st ? rollCall(level.st) : null })
    showMessage(r.message)
    if (r.blip) blip()
    if (r.heartbeat) heartbeat()
    for (let i = 0; i < r.followUps.length; i++) { const f = r.followUps[i]; setTimeout(() => showMessage(f.text), f.ms) }
    if (r.advance) stationIdx = (stationIdx + 1) % RADIO_GROUPS.length
    if (r.ledgerHeardNow && !file.ledgerHeard) applyFile({ ...file, ledgerHeard: true })
    if (r.keyLineNow) firstDeepHearing = false
  }

  // The counter-claim: fires ONCE, when the player has both typed the claim at a presence AND fired the beacon registered to EXTENSION-30150A
  // — and the file can hold a seam (compose-gates.js finaleGate: a column that can write a name where the dark can read it, a file still
  // open, under litigation or the notice nobody answered). Renderer-side, so it resolves in the browser build too (no Electron bridge
  // required). Held, it is the litigation's closing, on the file.
  function tryFinale() {
    if (!finaleGate({ seamHeld, claimFiled, beaconFired, rules, status: file.status, closing: file.closing })) return
    seamHeld = true
    applyFile({ ...file, closing: 'litigation' })
    wardPulse(); calmTimer = 600; flickTgt = 1; flickTimer = 1.2; sanity = Math.min(100, sanity + 30)
    itemSys.grant('ballast'); renderHotbar()
    showMessage('the seam holds. the lights do not stutter. an extension that, for once, stays an extension.')
    setTimeout(() => showMessage('something answers on your channel — one voice, then the sense of others behind it. the roll call was always the living, counting themselves.'), 2600)
    setTimeout(() => showMessage("m., last page: 'walk in. do not drop in. hold the seam for the rest of us, and write your name where the dark can read it.'"), 5600)
  }

  function applyItemEffect(eff) {
    if (!eff) return
    const dfloor = level?.index ?? 0
    // the file's own reading of a thing first (origin-rules.js): the one frozen LEGACY_EFFECT for every item but a thin player's glowstick
    const r = rules.itemEffect(eff, dfloor)
    if (r && !r.legacy) {
      fogTimer = r.fog; calmTimer = Math.max(calmTimer, r.calm); if (r.blip) blip()
      sanity = Math.max(0, Math.min(100, sanity + r.sanity)); showMessage(r.line); renderHotbar(); return
    }
    if (eff.type === 'almond-water') {
      if (eff.sour) {
        level.entitySys.noise(player.x, player.y, 6)        // the retch: the things hear it
        // TODO(integrate:W3) I13: the extension status's 'advance' (statusMods(file.status).sourWater) is read BEFORE the column's rule and wins
        const sw = rules.sourWater(dfloor)                  // processed: the ledger moved years ago — no slam, no whisper, no sanity
        if (sw) {
          sanity = Math.max(0, Math.min(100, sanity + sw.sanity)); if (sw.slam) doorSlam(); if (sw.whisper) whisper(); if (sw.flicker) { flickTgt = 0.5; flickTimer = 0.3 }
          showMessage(sw.line)
        } else if (dfloor === 3) {
          sanity = Math.max(0, sanity - 14); doorSlam()
          showMessage('the water is sour, and something reads the withdrawal. a line moves in a ledger you cannot see.')
        } else {
          sanity = Math.max(0, sanity - 8); whisper(); flickTgt = 0.5; flickTimer = 0.3
          showMessage('the water is sour on your tongue. it takes something from you, and gives nothing back.')
        }
      } else {
        stamina = 100; calmTimer = 20; sanity = Math.min(100, sanity + rules.sweetWater); wardPulse()   // +35 (unnamed: 20)
        quietTimer = QUIET_SECONDS                          // and your steps go soft for a while (tactics.quiet halves the footstep noise)
        showMessage('the water is sweet. the lights steady, and so does your mind.')
      }
    } else if (eff.type === 'glowstick') {
      fogTimer = Math.max(18, 45 - Math.min(dfloor, 3) * 6); calmTimer = Math.max(calmTimer, 8); blip()
      showMessage('green light pushes at the dark — less than it used to. the crack it opens is shorter down here.')
    } else if (eff.type === 'bandage') {
      if (dfloor === 2 || dfloor === 3) {
        player.hp = Math.min(player.maxHp, player.hp + 60); calmTimer = Math.max(calmTimer, 6)
        showMessage('down here the grit under your nails is true, so the mend is true too. it holds.')
      } else {
        player.hp = Math.min(player.maxHp, player.hp + 40)
        showMessage('you patch yourself up. it holds, for now.')
      }
    } else if (eff.type === 'polaroid') {
      firePolaroid()
    } else if (eff.type === 'radio') {
      readRadio(eff.on)
    } else if (eff.type === 'plumb') {
      // the strain gauge: a grain reading that tightens with depth. A tool — it is
      // read on every press and never consumed (items.js useSelected).
      blip(); calmTimer = Math.max(calmTimer, 8)
      const grain = Math.max(0, 100 - Math.min(dfloor, 4) * 17)
      if (dfloor >= 2) { whisper(); showMessage(`the plumb reads grain ${grain}. the needle will not sit. the world is tighter here, and older.`) }
      else showMessage(`the plumb reads grain ${grain}. slack, still. it holds.`)
    } else if (eff.type === 'ballast') {
      // true floor, made present: the drop-in-thinness antidote. Never sours.
      calmTimer = 30; stamina = 100; flickTgt = 1; flickTimer = 1.2
      showMessage('you set both feet and mean it. your whole weight arrives. the dark cannot read a thing this here.')
      // and it cures thin for good: the whole of you arrives (the layer comes off the column; the room learns it at once)
      if (thin) { thin = false; rules = rulesFor(origin, false); setTimeout(() => showMessage(CURE_LINE, PRIO.discovery), 2600); bus?.here(hereFields()) }
    } else if (eff.type === 'extension-slip') {
      // 30150A — the one line the system never closed. Hands the concept, not the
      // literal claim: the phrase itself is earned from the numbers station.
      // TODO(integrate:W3) I13: the line below becomes slipText(origin, file.status, file.closing)
      sanity = Math.min(100, sanity + 20); wardPulse()
      showMessage('notice 30150A. status: EXTENSION — the one line the system never closed. a door left ajar it cannot foreclose. make your claim where the presence waits.')
    }
    renderHotbar()
  }

  // ── ambient events (Living Atmosphere): the scheduler in events.js decides
  //    WHEN and WHICH; these are the side effects, hooked into the existing
  //    flicker / audio / message / apparition systems. ──
  function spawnCrosser() {
    const dfloor = level?.index ?? 0
    // on the deep stacks, sometimes it is not a thing but a faint drop-in — a
    // person minted thin from far away, drifting slow enough to photograph.
    // (0.3; more often where the floor's files lean to litigation — docket.js ambientMods)
    const faint = (dfloor === 2 || dfloor === 3) && Math.random() < level.amb.thinChance
    const ahead = 7 + Math.random() * 4                        // out in the fog ahead
    const bx = player.x + Math.cos(player.angle) * ahead
    const by = player.y + Math.sin(player.angle) * ahead
    const perp = player.angle + Math.PI / 2                     // crossing your line of sight
    const dir = Math.random() < 0.5 ? 1 : -1
    const sp = faint ? 1.1 : 2.6, span = 1.7
    const a = {
      x: bx - Math.cos(perp) * dir * span, y: by - Math.sin(perp) * dir * span,
      vx: Math.cos(perp) * dir * sp, vy: Math.sin(perp) * dir * sp,
      ttl: (span * 2) / sp + 0.2, variant: faint ? 'thin' : (Math.random() < 0.5 ? 'shade' : 'lurker'),
    }
    // a thin player sees the other drop-in stop halfway and wave (origin-thin.js CROSSER; the loop's apparition step pauses it). EF.apparition
    // copies only x / y / variant / vx / vy, so these fields never reach the renderer
    if (faint && rules.crosserPause()) { a.pauseAtTtl = a.ttl / 2; a.pauseT = 0; a.paused = false }
    ephemera.push(a)
  }
  // fireEvent(id, prio): the scheduled events murmur at ambient (dropped unless the line is idle); a drawer's haunt is the result of a search,
  // so containers.js fires it at interaction and the line shows behind 'you rummage.' (door-slam / crosser keep their interaction default)
  function fireEvent(id, prio = PRIO.ambient) {
    if (id === 'lights-cascade') {
      flickTgt = 0.14; flickTimer = 0.7                        // a wave of dark, held, then the loop recovers it
      showMessage('the lights go out ahead of you, one by one. then, slowly, they come back.', prio)
    } else if (id === 'door-slam') {
      doorSlam(); shake = Math.max(shake, 0.35)
      showMessage('somewhere behind you, a door slams shut.')
    } else if (id === 'hum-stops') {
      humDuck(2.6)
      showMessage('the hum stops. the silence has a shape. then it resumes, as if something had been listening.', prio)
    } else if (id === 'cold-spot') {
      sanity = Math.max(0, sanity - 4); whisper()
      showMessage('a cold spot. your breath fogs where there is nothing cold enough to fog it.', prio)
    } else if (id === 'footsteps') {
      footfall()
      showMessage('footsteps. not yours. they keep your pace, and stop when you stop.', prio)
    } else if (id === 'crosser') {
      spawnCrosser(); footfall(3); heartbeat(0.7)
      showMessage('far down the hall, something crosses the intersection. the hall is empty when you look again.')
    }
  }

  // ── the drawers (containers.js): the hold starts only when nothing real is close, any step cancels it (the movement block), and it
  //    lands after SEARCH_HOLD_S in resolveSearch. What a drawer holds is a pure roll of its key and chunk, so a save and a reload agree;
  //    a completed search is remembered by the floor (levelmem) and heard by the things (noise 4, sharedConventions #5). ──
  function startSearch(p, th) {
    if (th.hunted || th.nearest <= 4) { showMessage('not now.', PRIO.interaction); return }
    searchTarget = p; searchT = SEARCH_HOLD_S
    showMessage('you rummage.', PRIO.interaction)
    drawerSlide()
  }
  const clampSanity = (d) => { sanity = Math.max(0, Math.min(100, sanity + d)) }
  const searchApi = {
    grant: itemSys.grant, message: showMessage, sanity: clampSanity, fire: (id) => fireEvent(id, PRIO.interaction),
    // 'behind-you': the still figure on the trail you just walked; a cold spot when no open trail cell is behind you (hauntEffects -> null)
    behindYou: () => { const fx = hauntEffects('standing-figure', hauntCtx()); if (fx) applyHaunt(fx); else fireEvent('cold-spot', PRIO.interaction) },
  }
  function resolveSearch(p) {
    const [cx, cy] = p.key.split(':')[0].split(',').map(Number)     // keys are `${cx},${cy}:${i}` (scatter) or `${cx},${cy}:d${n}` (dressed)
    const roll = rollContainer(p.key, cx, cy, level.index, worldSeed | 0, level.cfg.maze?.salt | 0)
    if (!applyRoll(roll, searchApi)) return                           // an item with no hand free: the key stays unsearched
    searchLog.markSearched(p.key); mem.noteSearched(level.index, p.key)
    level.entitySys.noise(p.x, p.y, 4)
    if (level.index >= DRAWER_COST.minLevel) {                        // the deep floors count the drawers you open
      sanity = Math.max(0, sanity - DRAWER_COST.sanity)
      if (!drawerCostSaid) { drawerCostSaid = true; showMessage(DRAWER_COST.line, PRIO.discovery) }
    }
    if (roll.kind === 'item') renderHotbar()
  }

  // ── the hauntings (haunts.js): the tracker hands back the nearest placed haunt in radius and off cooldown, only while calm (the loop);
  //    hauntEffects turns its id into the one-shot applied here. hauntCtx is ONE reused object — getProps / lastTrail allocate, but only
  //    on a haunt, never per frame. A null effect (no trail cell behind you, no chair to turn) consumes no cooldown. ──
  const hauntCtxObj = { player, props: null, isOpen: (x, y) => level.grid.floor(Math.floor(x), Math.floor(y)), trail: null }
  function hauntCtx() { hauntCtxObj.props = level.decor.getProps(); hauntCtxObj.trail = fog.lastTrail(6); return hauntCtxObj }
  function applyHaunt(fx) {
    if (fx.ephemera) ephemera.push(fx.ephemera)                     // the figure carries vanishAt: the loop drops it when you come within three
    if (fx.audio === 'whisper') whisper()
    else if (fx.audio === 'doorSlam') doorSlam()
    else if (fx.audio === 'footfall:8') { footfall(8); waterT = fx.timerS ?? 12; waterStepT = 3 }   // and again every ~3 s while the water runs
    if (fx.shake) shake = Math.max(shake, fx.shake)
    // fx.moveProps: nothing to do — hauntEffects turned the chairs in place already (the list is informational)
    if (fx.flashlightOff) {
      flashlight = false
      const tog = lightToggles                                      // restored only if L was not touched meanwhile
      setTimeout(() => { if (lightToggles === tog) flashlight = true }, fx.flashlightOff * 1000)
    }
    showMessage(fx.message, PRIO.discovery)
    clampSanity(fx.sanity)
  }

  // ── contact (the mover's report, collide.js): the foley on an ENTER edge, the hard bump of a sprint into something with mass
  //    (a shake, a breath, a noise the things hear, one line per type per level), the pallet's tap, the clutter line and bob
  //    pulse, and the body that would not let you through ──
  function noteContact(report) {
    const hit = report.entered
    if (hit && bumpGate.near(timing.t)) {
      const kind = bumpKindFor(hit.kind, hit.type)
      if (kind !== 'silent') bump(kind, bumpIntensity(report.enterSpeed), 0)
    }
    if (isHardBump(report, wantSprint)) {
      shake = Math.max(shake, 0.06); stamina = Math.max(0, stamina - 2)
      level.entitySys.noise(player.x, player.y, 5)   // the things hear a hard bump
      const type = hit.type
      if (!bumpSaid.has(type) && timing.t - lastBumpLine > 30) {
        bumpSaid.add(type); lastBumpLine = timing.t
        showMessage(BUMP_LINES[type] ?? BUMP_LINES.default)
      }
    }
    if (report.stepType === 'pallet') bump('wood', 0.5)
    if (report.clutterEntered) {
      bobPulse = 0.35
      if (!clutterSeen.has(report.clutterType)) {
        clutterSeen.add(report.clutterType)
        showMessage(CLUTTER_LINES[report.clutterType] ?? CLUTTER_LINES.default, PRIO.interaction)
      }
    }
    if (report.blockedBy && hostile(report.blockedBy) && timing.t - lastLetThrough > 4) {
      lastLetThrough = timing.t
      showMessage('it does not let you through.', PRIO.interaction)
    }
  }

  // ── vending machine: draw one item, once. Deep down the almond water it gives
  //    may be sour — the lost soul's warning, made real. ──
  function dispenseFromMachine(m) {
    if (!m) return
    if (vendLocked) { showMessage('the tray is empty.'); return }   // a death empties the trays for this visit (until the next travel)
    if (vendedSet.has(m.key)) return
    const refilled = mem.wasRestocked(level.index, m.key, playT)   // spent on an earlier visit, restocked while you were away
    const dfloor = level?.index ?? 0
    const pool = ['almond-water', 'almond-water', 'glowstick', 'bandage']
    // Field Recovery caches surface in the deep stacks — a strain gauge, ballast, an exhibit
    if (dfloor === 2 || dfloor === 3) pool.push('plumb', 'ballast', 'extension-slip')
    // a floor whose files lean one way stocks for it, and the tray says which (docket.js trayLean: nothing on a floor that does not lean)
    const lean = trayLean(level.st)
    if (lean.item) pool.push(lean.item, lean.item)
    const type = pool[Math.floor(Math.random() * pool.length)]
    const sour = type === 'almond-water' && dfloor >= 2 && Math.random() < 0.4
    const extra = type === 'plumb' ? { tool: true } : (sour ? { sour: true } : {})
    const res = itemSys.grant(type, extra)
    if (!res.ok) { showMessage('the machine whirs, but your hands are already full.'); return }
    mem.noteVended(level.index, m.key, playT); vendedSet.add(m.key)
    if (!level.cfg.map) fog.pinThing(level.index, 'm:' + m.key, 'machine', m.x, m.y, true)   // struck through on the map
    renderHotbar(); blip()
    const clunk = `the machine clunks, and a ${ITEM_NAMES[type] ?? type} drops into the tray.${lean.stamp ? ` the tray is stamped ${lean.stamp}.` : ''}`
    if (refilled) { showMessage('the machine has been refilled. by whom.', PRIO.discovery); setTimeout(() => showMessage(clunk), 1600) }
    else showMessage(clunk)
  }

  // ── snapshot + persistence (solo progress & inventory — the "save game") ──
  // v:1, only ADDED to: memory (levelmem export), playT, deaths, dispelled, and fog (the map, the largest field). The fog is re-exported
  // on the full cadence only (every 4th periodic save, every travel / death / unload); the saves between carry the last export, so the
  // map is never absent from the file — the dirty-items save that follows every travel by one frame would otherwise drop it again.
  let fogExport = null
  // one inventory slot as saved and as restored (the same shape both ways): the type, and only the flags it carries. The plumb is a tool
  // by its type as well, so a save written before the flag was kept heals on load
  const invRow = (i) => ({
    type: i.type, ...(i.on ? { on: true } : {}), ...(i.sour ? { sour: true } : {}), ...(i.tool || i.type === 'plumb' ? { tool: true } : {}),
  })
  function snapshot(full = false) {
    const s = {
      level: level?.index ?? 0,
      x: player.x, y: player.y, angle: player.angle,
      hp: player.hp, maxHp: player.maxHp,
      inventory: itemSys.inventory.map(invRow),           // the flags ride along: a plumb stays a tool, sour water stays sour
      selected: itemSys.selected,
      pagesRead: [...readSet],
      worldSeed, anchor,
      dispelled: level?.entitySys.getDispelled() ?? [],   // the chunks whose presence came apart, with the seconds they stay empty
      memory: mem.export(), playT, deaths,                // what every floor keeps of you, the play clock, the deaths
      vendLocked,                                         // a death's empty trays survive a quit and a Continue
    }
    if (full || !fogExport) fogExport = fog.export()      // the pencil sheets, per floor
    s.fog = fogExport
    // who the file has you as: the column, the layer, the form's facts and the floors it filed (origin-intake.js; plain data, the Set as an array)
    Object.assign(s, identityOut({ origin, thin, filed, intakeCtx, filedFloors }))
    // the caches' index (caches.js): whose each one is, for the caps (where they lie is the floors' memory, above)
    s.caches = ledger.snapshot()
    return s
  }
  let saveTimer = 0, persistN = 0
  // solo runs are the ones you resume; the fog rides along on every 4th periodic save and always on a travel / a death / unload
  function persist(full = false) { if (mpClient) return; persistN++; writeSave(snapshot(full || persistN % 4 === 0)) }
  window.addEventListener('beforeunload', () => persist(true))

  // The saved position meets the settled furniture (the last step of applyResume): the chunk around it was streamed by updateAt, then
  // settlePlayer lifts the player out of any body or wall face under them. A push of more than half a cell means the spot is gone
  // (a cabinet now stands there), so the nearest open cell centre takes them in instead, and the floor says so.
  function resumeSettle() {
    if (!getPref('solidBodies')) return
    const moved = level.solid.settlePlayer(player)
    if (moved > 0.5) {
      const spot = openSpotNear(player.x, player.y)
      if (spot) { player.x = spot.x; player.y = spot.y }
      showMessage('you woke somewhere slightly else.', PRIO.discovery)
    }
  }
  // the nearest open cell centre (a spiral over grid.floor, up to 3 cells out) that no solid body overlaps; null when none is that close
  const SPOT_Q = []
  function openSpotNear(x0, y0) {
    const cx0 = Math.floor(x0), cy0 = Math.floor(y0)
    for (let r = 0; r <= 3; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
          const ix = cx0 + dx, iy = cy0 + dy
          if (!level.grid.floor(ix, iy)) continue
          const x = ix + 0.5, y = iy + 0.5
          const n = level.bodies.query(x, y, PLAYER_R, SPOT_Q)
          let clear = true
          for (let i = 0; i < n; i++) if (SPOT_Q[i].cls === 'solid') { clear = false; break }
          if (clear) return { x, y }
        }
      }
    }
    return null
  }

  // ── boot: resume a saved run, else a fresh SOLO run enters through Level ∅
  //    (the block — index 4), while online play starts in the lobby together. ──
  if (resume) {
    // levelmem.applyResume owns the order: mem.import + playT + deaths -> buildLevel at the remembered arrival chunk -> the player fields ->
    // the decor / item scan at the resumed chunk -> the dispelled chunks -> the fog -> the settle. A v:1 save missing every new field loads
    // to today's behaviour. The clock is set first: buildLevel's vendedFor and the dispelled chunks' remaining seconds count from it (the
    // entity system reads playT through deps.now, so restoreDispelled is handed the list alone — never applyResume's literal clock).
    // Who the file has you as is read BEFORE applyResume (its buildLevel reads filedFloors for the vend memory), validated in one call: a
    // v:1 save without the fields resumes unfiled and files on its next way.
    ;({ origin, thin, filed, intakeCtx, filedFloors } = identityIn(resume, intakeCtx))
    rules = rulesFor(origin, thin); evConfig.events = rules.eventWeights()
    ledger.restore(resume.caches)   // the caches' index before buildLevel rebinds it (a save without it: empty, the floor's own caches adopted)
    playT = Number(resume.playT) || 0
    const r = applyResume(resume, {
      mem, buildLevel,
      applyPlayer: (s) => {
        player.x = s.x ?? player.x
        player.y = s.y ?? player.y
        player.angle = s.angle ?? 0
        player.maxHp = s.maxHp ?? 100
        player.hp = s.hp ?? player.maxHp
        if (Array.isArray(s.pagesRead)) for (const f of s.pagesRead) if (Number.isInteger(f) && f >= 0 && f < SCRAPS.length) readSet.add(f)
        if (Array.isArray(s.inventory)) {
          itemSys.inventory.length = 0
          for (const it of s.inventory) itemSys.inventory.push(invRow(it))
          itemSys.select(Math.max(0, Math.min(5, s.selected ?? 0)))
          renderHotbar()
        }
        return player
      },
      updateAt: (pcx, pcy) => { level.grid.setPlayerChunk(pcx, pcy); level.cache.preload(pcx, pcy); level.decor.update(pcx, pcy); itemSys.update(pcx, pcy) },
      restoreDispelled: (l) => level.entitySys.restoreDispelled(l),
      fogImport: (f) => { if (f && !fog.import(f)) console.warn('[map] part of the saved map was refused and skipped') },
      settlePlayer: resumeSettle,
    })
    deaths = r.deaths
    vendLocked = resume.vendLocked === true   // absent (v:1): false, today's behaviour
    // a save that carries no visit to the floor you resume on (v:1: no memory) records it now, so a later return there is not a first
    // visit; a save that does carry it is untouched (a resume is not a visit)
    if (!mem.get(level.index)?.visits) mem.arrive(level.index, r.spawnChunk ?? { cx: r.pcx, cy: r.pcy }, playT)
  } else {
    buildLevel(mpClient ? 0 : 4); mem.arrive(level.index, spawnChunk, playT)   // solo: fall in through the block (∅); online: the lobby
    if (getPref('solidBodies')) level.solid.settlePlayer(player)               // out of a prop the spawn cell may hug (the online lobby)
  }
  showMessage(level.cfg.levelName, PRIO.combat)

  // apply saved audio/visual prefs, then keep them live as the panel changes them
  setMusicEnabled(getPref('music'))
  setMusicVolume(getPref('musicVolume'))
  setAmbienceVolume(getPref('ambienceVolume'))   // volume before the toggle, so the first ramp lands on the right level
  setAmbience(getPref('ambience'))
  onPrefChange((k, v) => {
    if (k === 'grain')          renderOpts.grain = v
    else if (k === 'particles') renderOpts.particles = v
    else if (k === 'crosshair') renderOpts.crosshair = v
    else if (k === 'reduceFlicker') renderOpts.reduceFlicker = v
    else if (k === 'renderer') { renderOpts.renderer = v; if (level && level.gfx) { try { level.gfx.dispose() } catch { /* ignore */ } level.gfx = makeGfx(level.cfg, level.cache) } }   // rebuilt now, not at the next level
    else if (k === 'fpsCap')    { fpsCap = v; qd.setPrefs({ fpsCap: v }) }
    else if (k === 'graphicsQuality' || k === 'hiDpi') { if (qd.setPrefs({ [k]: v })) queueResize() }     // laid out by the next frame that draws
    else if (k === 'music')     setMusicEnabled(v)
    else if (k === 'musicVolume') setMusicVolume(v)
    else if (k === 'ambience')  setAmbience(v)
    else if (k === 'ambienceVolume') setAmbienceVolume(v)
    else if (k === 'solidBodies') { if (v && level) level.solid.settlePlayer(player) }   // switched on mid-stride: out of whatever you stood in
    // mouseSensitivity, headBob, creatures, damage and solidBodies (the mover's dispatch) are read live each frame
  })

  // ?gfxstats=1: the diagnostics panel (gfx-stats.js) — created only when asked for; otherwise nothing, no timer, no element
  const gfxStats = statsEnabled(location.search) ? createStatsOverlay({
    doc: document, parent: document.getElementById('hud-cluster'),
    read: () => {
      const g = level.gfx, t = renderOpts.qualityTier
      return {
        kind: g.kind, why: g.why, info: g.info, fallbacks: g.fallbacks, tier: t, scale: renderOpts.renderScale ?? qualityFor(t).scale,
        canvasW: canvas.width, canvasH: canvas.height, cssW: canvas.clientWidth, cssH: canvas.clientHeight, dpr: window.devicePixelRatio, levelStart,
      }
    },
  }) : null

  // ── the map's helpers, built once (nothing allocated per frame): the cache's epoch per chunk (0 where there is none), the decor's
  //    nearest-way probe for the stale check, the compass's one state object (its stale predicate inside), and the compass element ──
  const epochOf = (cx, cy) => level.cache.epochOf?.(cx, cy) ?? 0
  const nearestWayFn = (x, y) => level.decor.nearestWay(x, y, 2)
  const compassState = { player, known: null, fallback: null, arrived: null, stale: (p) => fog.isStale(level.index, p.chunkKey, epochOf) }
  const compassEl = document.getElementById('exit-compass')
  // what goes on the map because you SAW it (sightpins.js), on the cell-change tick only: the ways at 1.35x the fog (the beam shows that
  // far), the sights at the fog (their first-sight line once, within 9 u), and by proximity (PROX_PIN) the machine, the note and the soul
  // beside you — the same cone and line of sight the sprite pass and the things use. decor keys every per-chunk record by the bare chunk
  // key, which the way pins use: the other pins are namespaced by kind ('s:' / 'm:' / 'n:' / 'p:'), so a note never overwrites the hole
  function pinSeen(reach) {
    const L = level.index, floor = level.grid.floor
    let n = visibleWays(player, level.decor.getExits(), floor, reach * 1.35, HF, seenWays)
    for (let i = 0; i < n; i++) { const e = seenWays[i]; fog.pinWay(L, e, epochOf(Math.floor(e.x / CHUNK_SIZE), Math.floor(e.y / CHUNK_SIZE))) }
    // a tenant's map also marks every exit the floor has loaded, seen or not (the file has the building's plans; everyone else draws what they saw)
    if (rules.wayReveal === 'loaded') { const ex = level.decor.getExits(); for (let i = 0; i < ex.length; i++) fog.pinWay(L, ex[i], epochOf(Math.floor(ex[i].x / CHUNK_SIZE), Math.floor(ex[i].y / CHUNK_SIZE))) }
    n = visibleWays(player, level.decor.getStairs(), floor, reach * 1.35, HF, seenWays)
    for (let i = 0; i < n; i++) { const s = seenWays[i]; fog.pinWay(L, s, epochOf(s.cx, s.cy)) }
    n = visibleWays(player, level.decor.getSights(), floor, reach, HF, seenSights)
    for (let i = 0; i < n; i++) {
      const s = seenSights[i]
      fog.pinThing(L, 's:' + s.key, 'sight', s.x, s.y)
      if ((s.x - player.x) ** 2 + (s.y - player.y) ** 2 <= 81) {
        const said = L + ':' + s.key
        if (!sightSaid.has(said)) { sightSaid.add(said); showMessage(SIGHT_LINES[s.type]?.line, PRIO.discovery) }
      }
    }
    const m = level.decor.nearestMachine(player.x, player.y, PROX_PIN)
    if (m) fog.pinThing(L, 'm:' + m.key, 'machine', m.x, m.y, vendedSet.has(m.key))
    const sc = level.decor.nearestScrap(player.x, player.y, PROX_PIN)
    if (sc) fog.pinThing(L, 'n:' + sc.key, 'note', sc.x, sc.y, readSet.has(sc.frag))
    const np = level.decor.nearestNpc(player.x, player.y, PROX_PIN)
    if (np) fog.pinThing(L, 'p:' + np.key, 'npc', np.x, np.y)
  }

  const entityAsm = createEntityAssembler(), EF = ENTITY_FILLS
  // the remote players this frame: ONE reused array refilled once per frame (the net block) from the players list, read by the sanity
  // friend rule and the sprite list. With the bus only the friends on THIS floor count (bus.onFloor: a peer without a fresh heartbeat — an
  // old client, or one gone quiet 8 s — always does), and a stale friend's heartbeat fields are blanked so it draws as a legacy peer (a
  // record keeps the last fields the bus merged). The same pass refills the roster the bus reads (peerIdSet / peerRec). getRemotePlayers
  // hands fresh copies, so a record's fields may be written here without touching the client's own.
  const remoteOnFloor = []
  function fillRemotes() {
    remoteOnFloor.length = 0; peerIdSet.clear(); peerRec.clear()
    if (!mpClient) return
    const list = mpClient.getRemotePlayers(), now = performance.now()
    for (let i = 0; i < list.length; i++) {
      const rp = list[i]
      peerIdSet.add(rp.id); peerRec.set(rp.id, rp)
      if (bus) {
        if (!bus.onFloor(rp.id)) continue
        if (!bus.fresh(rp.id)) { rp.st = rp.lit = rp.origin = rp.status = undefined; rp.thin = rp.seen = false }
        else if ((rp.x - player.x) ** 2 + (rp.y - player.y) ** 2 < 36) rollcall.touch(rp.id, now)   // a friend within six is no quiet one
      }
      remoteOnFloor.push(rp)
    }
  }
  // what the things know about you this frame (hunt.js / variants.js ctx): ONE object, mutated per frame, never rebuilt. `player` is the
  // live object (where they look for you), hf the half field of view (watched() == drawn on screen), damage the floor's contact damage,
  // lures the dropped talking radios (tactics.computeLures hands back one reused array; recomputed when the items changed or every 0.5 s).
  // The four trailing fields are the file's reading of you (compose-perception.js): sight x, hidden, memory x, your noises x — at
  // { 1, false, 1, 1 } (LEGACY: an unfiled player) the things are today's
  const aiCtx = { flashlight, sprinting: false, dark: false, fog: 16, radioOn: false, lures: [], t: 0, hf: HF, playerAngle: 0, player, damage: 16, sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1 }
  // what perceptionFor reads (ONE object, refilled per frame): the column, the depth, the stillness clocks, your light and radio, a friend's light
  const perCtx = { rules, depth: 0, stillFor: 0, noiseFor: 0, flashlight, radioOn: false, litNear: false }
  let litNear = false   // a friend's light reaches you this frame (lightshare.js litFriendNear, written in the net block; never solo)
  let litRec = null     // whose light it is (their bus record: L names them when you go dark in it)
  // what sanityStep reads (ONE object, refilled per frame where the sanity block is). Set once: you, your own file, this floor's remote
  // players (the reused array fillRemotes refills; empty solo) and the bus's two questions — a peer it has no fresh 'here' for is the old
  // friend rule (+3), a fresh one draws on the company pool. leashDebt stays 0: driftD() carries the debt already
  const sanCtx = { rules, mods, closingOverlay: co, flashlight, litNear: false, index: 0, depth: 0, hunted: false, gaze: false, gazeRate: 0, origin: null,
    drift: 0, leashDebt: 0, leashCalm: 0, down: false, company: 0, companyWas: 0, disagreeSaid: false, dt: 0,
    player, self: selfFile, remotes: remoteOnFloor, fresh: bus ? bus.fresh : null, onFloor: bus ? bus.onFloor : null }
  let last = 0
  let frameCount = 0
  let loopErrs = 0
  // time plumbing: `dt` below is the CLAMPED simulation step; `rawMs` is the real interval between processed frames,
  // which the quality controller and the renderer's animation clock need (a clamped dt hides an overloaded machine)
  const pacer = createFramePacer()
  const timing = { t: 0, dt: 1 / 60 }     // handed to render(): seconds since the first frame / real frame time (capped at 0.1 s)
  let t0 = -1, lastWorkMs = 0
  function loop(ts) {
   try {
    // fpsCap: skip frames on the raw timestamp; a pending layout (at most one per frame, however many events came in) only on a frame that draws
    if (!frameDue(ts, pacer, fpsCap, resizeGate, resize)) { requestAnimationFrame(loop); return }
    const w0 = performance.now()
    const rawMs = last > 0 ? ts - last : 1000 / 60
    if (t0 < 0) t0 = ts
    const dt = Math.min(rawMs / 1000, 0.05)
    last = ts
    playT += dt
    timing.t = (ts - t0) / 1000; timing.dt = Math.min(rawMs / 1000, 0.1)
    if (qd.frame(rawMs, lastWorkMs)) qd.apply(renderOpts)                 // adaptive resolution: down fast, up slowly
    // the GPU health monitor watches the REAL frame interval (a CPU-side timer cannot see GPU time); it only acts once the resolution is at its floor
    if (level.gfx.kind === 'gpu') level.gfx.noteFrame(rawMs, { budgetMs: 1000 / (fpsCap > 0 ? fpsCap : 60), atFloor: qd.state.atFloor })
    if (frameCount % 120 === 0 && window.devicePixelRatio !== lastDpr) resize()   // the window moved to another display
    const cfg = level.cfg

    // ── flicker (per-level tuning) — rate-limited: at most 3 dips a second (WCAG 2.3.1), depth-capped under
    //    reduceFlicker. The state machine is gfx-quality.js stepFlicker; events and items that write flickTgt /
    //    flickTimer directly (lights-cascade, sour water, ...) are vetted by it on the next step. ──
    const fl = cfg.flicker
    const calm = calmTimer > 0
    if (calm) calmTimer -= dt
    fk.value = flicker; fk.target = flickTgt; fk.timer = flickTimer
    stepFlicker(fk, dt, fl, Math.random, calm, renderOpts.reduceFlicker)
    flicker = fk.value; flickTgt = fk.target; flickTimer = fk.timer
    setFlicker(flicker)
    // the tesla's charge: the lights drop for the half second before the jolt (variants.js arcCharge -> threat.arcPending), once per
    // charge; stepFlicker vets the dip on its next step like every other direct write
    const thA = level.entitySys.getThreat()
    if (thA.arcPending && !arcWas) { flickTgt = 0.35; flickTimer = 0.4; blip() }
    arcWas = thA.arcPending

    // ── movement (frozen during a transition fade or while typing in chat): W/S/A/D sum into ONE step (same multipliers 1 / 0.6 / 0.7),
    //    scaled by the clutter under you (x0.55 while edging through), then exactly one tryMove ──
    creaturesOn = getPref('creatures')
    const creaturesLive = creaturesOn && !!cfg.entities?.enabled
    // a card, the chat, the wish dialog or a fade is up: the verbs below do not fire (a Space that closed the note card never wards)
    const modal = transitioning || dialogOpen || chatOpen || noteOpen || mapOpen || down.st === 'down' || kneel.st !== null   // (the map too: Space is off while you read it; lying down or kneeling, no ward)

    // ── the ward (ward.js): the charger is ticked EVERY frame — it owns the hold, the cost and the cooldown — on the press / release
    //    edge counts. Charging slows this frame's step and drains the legs; a release (or the 1.0 s cap) fires: tap or charged, the
    //    things in the cone recoil / come apart / are caught turning (hunt's opening counts double), and a dispel steadies you. ──
    let verbMul = 1
    const w = charger.tick(dt, wardInput.press, wardInput.release, stamina)
    if (modal) charger.forceRelease()
    else if (w?.charging) { stamina = Math.max(0, stamina - w.drain * dt); verbMul *= w.moveMul }
    else if (w?.denied) showMessage('nothing left in your legs to push with.')
    else if (w) {
      stamina -= w.cost
      const res = getPref('creatures') ? level.entitySys.ward(player, wardOpts(w.charged)) : EMPTY_WARD
      level.entitySys.noise(player.x, player.y, 12)   // a ward is loud: the things round the corner hear it
      stillness.noise(playT); standHeld = 0          // and it is yours: the stillness clocks start again (and the stand with them)
      // the room's things are each its own: a friend on this floor re-runs your tap where you stand (lightshare.js; one reused payload)
      if (bus) { wardOut.x = player.x; wardOut.y = player.y; wardOut.a = +player.angle.toFixed(2); wardOut.lvl = level.index; bus.emit('ward', wardOut) }
      wardPulse(); shake = Math.max(shake, w.charged ? 0.7 : 0.45)
      if      (res.dispelled > 0) showMessage(res.dispelled > 1 ? 'they come apart in the light.' : 'it comes apart in the light.')
      else if (res.opening > 0)   showMessage('you catch it turning. it reels.')
      else if (res.hit > 0)       showMessage(res.hit > 1 ? (rules.wardRecoil ? 'they recoil from you. so do you.' : 'they recoil from you.') : (rules.wardRecoil ? RECOIL_LINE : 'it recoils from you.'))
      else                        showMessage('you push at the dark. it gives nothing back.')
      sanity = Math.min(100, sanity + 10 * res.dispelled)
      // thin: whatever the push meets pushes back — RECOIL_DIST along your own facing, through the same mover as a step (a body or a creature
      // stops it), marched in RECOIL_STEPS so the shove never passes through a wall one cell thick
      if (rules.wardRecoil && res.hit > 0) {
        for (let i = 0; i < RECOIL_STEPS; i++) tryMove(player.x - Math.cos(player.angle) * (RECOIL_DIST / RECOIL_STEPS), player.y - Math.sin(player.angle) * (RECOIL_DIST / RECOIL_STEPS))
        shake = Math.max(shake, RECOIL_SHAKE)
      }
    }
    // kneeling, Space is your hands on them, not a ward (`modal` dropped the latch above): it ends the kneel
    if (kneel.st && wardInput.press !== kneel.st.press0) stopKneel(HANDS_LINE)
    // ── the bandage commit (tactics.js): 1.2 s of holding still at 0.4 speed; the heal and the consume land at the end (a hit
    //    cancels it in the HP block below, and the bandage stays in your hand) ──
    const c = commit.tick(dt)
    if (c === 'running') verbMul *= 0.4
    else if (c === 'done') applyItemEffect(itemSys.consumeSelected())
    if (quietTimer > 0) quietTimer -= dt
    // the anchored leash: a pin caption's calm runs out, a death's debt pays itself off at a metre a second (both 0 for everyone else)
    if (leashCalm > 0) leashCalm -= dt
    leashDebt = leashDebtStep(leashDebt, dt)

    let moved = false, stepped = false   // moved: a movement key is held; stepped: the player actually went somewhere
    wantSprint = false
    // a step leaves the friend you knelt by (the step itself is taken this frame); lying down, you do not move at all
    if (kneel.st && (K['KeyW'] || K['KeyS'] || K['KeyA'] || K['KeyD'] || K['ArrowUp'] || K['ArrowDown'])) stopKneel(null)
    if (!transitioning && !chatOpen && !noteOpen && down.st !== 'down' && !kneel.st) {
      wantSprint = (K['ShiftLeft'] || K['ShiftRight']) && stamina > 0
      if (mapOpen) wantSprint = false                       // reading the map: half pace, no sprint (held, not modal)
      const mult = mapOpen ? 0.5 : (wantSprint ? 1.8 : 1)
      const sp = SPEED * dt * 60 * mult * verbMul
      const ca = Math.cos(player.angle), sa = Math.sin(player.angle)
      let mx = 0, my = 0
      if (K['KeyW'] || K['ArrowUp'])   { mx += ca * sp; my += sa * sp; moved = true }
      if (K['KeyS'] || K['ArrowDown']) { mx -= ca * sp * 0.6; my -= sa * sp * 0.6; moved = true }
      if (K['KeyA'])                   { mx += Math.cos(player.angle - Math.PI/2) * sp * 0.7; my += Math.sin(player.angle - Math.PI/2) * sp * 0.7; moved = true }
      if (K['KeyD'])                   { mx += Math.cos(player.angle + Math.PI/2) * sp * 0.7; my += Math.sin(player.angle + Math.PI/2) * sp * 0.7; moved = true }
      if (moved) {
        lastDt = dt
        const mult2 = getPref('solidBodies') ? level.solid.clutterAt(player.x, player.y) : 1
        const x0 = player.x, y0 = player.y
        tryMove(player.x + mx * mult2, player.y + my * mult2)
        stepped = (player.x - x0) ** 2 + (player.y - y0) ** 2 > 1e-6   // pressed against a body you stay put (the slowest real step is > 3e-3)
      }
      if (!locked && K['ArrowLeft'])  player.angle -= 0.04 * dt * 60   // dt-scaled: a 144 Hz display turns at the same rate
      if (!locked && K['ArrowRight']) player.angle += 0.04 * dt * 60
      if (moved && wantSprint)          stamina = Math.max(0, stamina - 22 * dt)
      else if (!charger.isCharging())   stamina = Math.min(100, stamina + 9 * dt)   // a held ward drains the legs: no regen under it
    }
    player.moving = moved
    // the stillness clocks (stillness.js): a step restarts the still one; a sprint is a sound as well (one reused report, the play clock)
    stillNote.moving = moved; stillNote.flashlight = flashlight; stillNote.radioOn = radioWasOn; stillNote.t = playT
    stillness.note(stillNote)
    if (moved && wantSprint) stillness.noise(playT)
    // the hold at a drawer (containers.js): any step leaves it (a real step: W held into the cabinet is not one); otherwise it lands after SEARCH_HOLD_S
    if (searchT > 0 && stepped) { searchT = 0; searchTarget = null; showMessage('you leave the drawer.', PRIO.interaction) }
    if (searchT > 0) { searchT -= dt; if (searchT <= 0 && searchTarget) { resolveSearch(searchTarget); searchTarget = null } }
    if (moved) player.bob += 0.12 * dt * 60
    // a footstep the things can hear lands every half bob cycle (the bob advances 7.2 rad/s: a step every 0.44 s); emitted below, once
    // the grid follows this frame's chunk
    const stepN = Math.floor(player.bob / Math.PI)
    const footstep = moved && stepN !== lastStepN
    lastStepN = stepN
    // the walk's bob, plus the clutter step: a +5 px rise that settles over 0.35 s (noteContact starts it on clutterEntered)
    const bobBase = (moved && getPref('headBob')) ? Math.sin(player.bob) * 4 : 0
    player.bobOffset = bobBase + (bobPulse > 0 ? Math.sin((0.35 - bobPulse) / 0.35 * Math.PI) * 5 : 0)
    bobPulse = Math.max(0, bobPulse - dt)

    // ── the message line: the queue decides what shows; one reused result or null (messages.js) ──
    const mq = msgQ.tick(dt)
    if (mq && msgEl) { if (mq.show) { msgEl.textContent = mq.text; msgEl.style.opacity = '1' } else msgEl.style.opacity = '0' }

    if (fogTimer > 0) fogTimer -= dt
    const fogMul = fogTimer > 0 ? 1.6 : 1

    // ── atmospheric messages ──
    msgTimer += dt
    if (msgTimer >= msgNext) {
      msgTimer = 0
      msgNext  = base.messageInterval[0] + Math.random() * (base.messageInterval[1] - base.messageInterval[0])
      showMessage(level.messages[Math.floor(Math.random() * level.messages.length)], PRIO.ambient)
    }

    // ── Living Atmosphere: occasional ambient dread events (procedural floors only) ──
    //    (not while a drawer is being searched, and not inside the quiet a haunt or an earlier event left behind)
    const evCanFire = !transitioning && !dialogOpen && !chatOpen && !noteOpen && level.index >= 0 && level.index <= 3 && searchT <= 0 && dreadQuietT <= 0
    const evId = eventSched.tick(dt, { level: level.index, sanity, canFire: evCanFire })
    if (evId) { fireEvent(evId); dreadQuietT = 12 }
    dreadQuietT = Math.max(0, dreadQuietT - dt)
    // running water (a haunt): the footfalls keep your pace for as long as its timer runs
    if (waterT > 0) { waterT -= dt; waterStepT -= dt; if (waterStepT <= 0 && waterT > 0) { waterStepT = 3; footfall(8) } }

    updateHud(); updateHp(); updateStamina()
    saveTimer += dt
    if (saveTimer > 8) { saveTimer = 0; persist() }

    // ── the things set down (items.js): their clocks first — a radio's battery goes, a glowstick gutters out — then the lures (the
    //    dropped radios still talking: one reused array, recomputed when the items changed or every 0.5 s; read now, never kept) ──
    const expired = itemSys.expireDropped(playT)
    for (let i = 0; i < expired.length; i++) showMessage(expired[i].kind === 'battery' ? 'the batteries go.' : 'the green light gutters out.', PRIO.ambient)
    lureT += dt
    const itemsDirty = itemSys.isDirty()     // true once after any drop / pickup / expiry / enterLevel (the read clears it)
    if (itemsDirty || lureT >= 0.5) { lureT = 0; aiCtx.lures = itemSys.getLures(playT, player.x, player.y) }
    if (itemsDirty) { mem.setDropped(level.index, itemSys.getDropped()); persist() }   // what lies on this floor is its to keep: on the one dirty read, never every frame
    const lures = aiCtx.lures

    // ── radio audio sync: yours, or one set down within 12 u still talking ──
    const radioOn = itemSys.isRadioOn() || lureWithin(lures, player.x, player.y, 12)
    if (radioOn !== radioWasOn) { radioWasOn = radioOn; setRadio(radioOn) }

    const pcx = Math.floor(player.x / CHUNK_SIZE)
    const pcy = Math.floor(player.y / CHUNK_SIZE)
    level.grid.setPlayerChunk(pcx, pcy)      // before entitySys.update / any floor() read this frame
    // the dropped radios talk: a noise of 8 from each lure every 0.5 s (sharedConventions #5), flooded over this frame's grid
    lureNoiseT += dt
    if (lureNoiseT >= 0.5) {
      lureNoiseT = 0
      if (creaturesLive) for (let i = 0; i < lures.length; i++) level.entitySys.noise(lures[i].x, lures[i].y, 8, 'lure')   // not yours: never scaled by the file's noiseMul
    }

    // ── presence proximity (radio finds them from farther) ──
    const presenceRange = radioOn ? 400 : 4
    let nearPresence = false
    for (let dy = -1; dy <= 1 && !nearPresence; dy++) {
      for (let dx = -1; dx <= 1 && !nearPresence; dx++) {
        const cx = pcx + dx, cy = pcy + dy
        if (!chunkHasPresence(cx, cy)) continue
        const px2 = cx * CHUNK_SIZE + CHUNK_SIZE / 2
        const py2 = cy * CHUNK_SIZE + CHUNK_SIZE / 2
        if ((player.x - px2) ** 2 + (player.y - py2) ** 2 < presenceRange) nearPresence = true
      }
    }
    const hintEl = document.getElementById('presence-hint')
    if (hintEl) hintEl.style.opacity = nearPresence ? '1' : '0'

    // ── items: pickup prompt ──
    const nearItem = itemSys.nearestItem(player.x, player.y, 1.4)
    // ── the ways (exits, and the stairs a pass adds): the prompt (wider grab range) ──
    const nearExit = level.decor.nearestWay(player.x, player.y, rules.exitGrab)   // 1.6 (a tenant's hands find a way from 2.4)
    const nearNpc  = level.decor.nearestNpc(player.x, player.y, 1.8)
    const nearScrap = level.decor.nearestScrap(player.x, player.y, 1.8)
    const nearMachine = level.decor.nearestMachine(player.x, player.y, 1.6)
    // the drawers (containers.js): the nearest container you have not opened; it takes the prompt and F over a way farther than
    // 1.0 u (the block has no containers). Ladder: item > machine > container-or-way > scrap > soul
    const nearBox = cfg.map ? null : level.decor.nearestProp(player.x, player.y, 1.5, unsearchedBox)
    const boxFirst = nearBox !== null && (!nearExit || (nearExit.x - player.x) ** 2 + (nearExit.y - player.y) ** 2 > 1)
    // a friend down in front of you, within 1.3 and ±0.6 rad, in sight (downed.js; this floor's remote players as the net block last filled
    // them — one frame old, the record itself): F kneels by them, and the prompt says so above everything else
    const dnFront = (bus && !kneel.st) ? downedInFront(player, remoteOnFloor, DN_OPTS) : null

    const itemHintEl = document.getElementById('item-hint')
    if (itemHintEl) {
      if (kneel.st || dnFront) {
        itemHintEl.textContent = KNEEL_HINT
        itemHintEl.style.opacity = kneel.st ? kneel.dim().toFixed(2) : '1'   // fainter as you count (no numbers on screen)
      } else if (nearItem) {
        // a cache says whose it is: yours, or who left it (the record itself carries the note)
        itemHintEl.textContent = `f · take the ${ITEM_NAMES[nearItem.type] ?? nearItem.type}` + (nearItem.cacheKey ? (isMine(nearItem) ? ' · yours' : ` · left by ${nearItem.by ?? 'wanderer'}`) : '')
        itemHintEl.style.opacity = '1'
      } else if (nearMachine && !vendedSet.has(nearMachine.key)) {
        itemHintEl.textContent = 'f · draw from the machine'
        itemHintEl.style.opacity = '1'
      } else if (boxFirst) {
        itemHintEl.textContent = `f · search ${CONTAINER_TYPES[nearBox.type]}`
        itemHintEl.style.opacity = '1'
      } else if (nearExit) {
        // the way's own label and where it goes (exit records carry kind/label; stairs carry theirs); the one you just came by is closing
        itemHintEl.textContent = closing && nearExit.key === closing.key && playT < closing.until ? 'f · the way is still closing.' : `f · ${wayLabel(nearExit)}`
        itemHintEl.style.opacity = '1'
      } else if (nearScrap) {
        itemHintEl.textContent = nearScrap.form ? 'e · read the form' : 'e · read the scrap'
        itemHintEl.style.opacity = '1'
      } else if (nearNpc) {
        itemHintEl.textContent = 'e · speak to the lost soul'
        itemHintEl.style.opacity = '1'
      } else {
        itemHintEl.style.opacity = '0'
      }
    }

    // the paper card freezes play and takes its keys FIRST, before the chat, the map and the verbs can read them: Esc / E / F / Space /
    // Enter / NumpadEnter, X and the digits (papercard CARD_KEYS) are the card's while it is up — a page goes back on any close key, as
    // before (touch too: the SPEAK / ACT / WARD buttons set these keys), a sealed card reads or leaves, a cache menu picks
    if (noteOpen) {
      for (let i = 0; i < CARD_KEYS.length; i++) { const k = CARD_KEYS[i]; if (K[k]) { K[k] = false; cardInput(k) } }
    }

    // Enter opens chat when connected to others
    if (!chatOpen && !dialogOpen && !noteOpen && (K['Enter'] || K['NumpadEnter'])) {
      K['Enter'] = false; K['NumpadEnter'] = false; openChat()
    }

    // Esc gets up from beside the friend you knelt by (before the map can read it)
    if (kneel.st && K['Escape']) { K['Escape'] = false; stopKneel(null) }

    // ── the map (held, not modal): Tab or Esc folds it; Tab opens it when nothing else is up and the floor has a map (the block has none).
    //    The edge is consumed either way, so a Tab pressed on the block or under a card does not open the sheet on the next floor. ──
    if (mapOpen && (K['Escape'] || K['Tab'])) { K['Escape'] = K['Tab'] = false; closeMap() }
    else if (K['Tab']) {
      K['Tab'] = false
      if (!transitioning && !dialogOpen && !chatOpen && !noteOpen && !cfg.map && settingsHidden()) {
        mapCard.open(); mapOpen = true; document.body.classList.add('map-open')
        if (!mapEverOpened) { mapEverOpened = true; showMessage('you start drawing. it is the only way to know you are moving.', PRIO.discovery) }
      }
    }

    // lying down, your hands do nothing: the verbs' keys are swept before they can be read — all but C (calling out is how someone may
    // notice). Enter (the chat) and Tab (the map) are above, and stay
    if (down.st === 'down') { K['KeyF'] = K['KeyQ'] = K['KeyX'] = K['KeyE'] = K['KeyB'] = K['KeyL'] = false; for (let i = 1; i <= 6; i++) K['Digit' + i] = false }
    // the verbs: off while a card (the note, the map), the chat, the wish dialog or a fade is up
    if (!transitioning && !dialogOpen && !chatOpen && !noteOpen && !mapOpen) {
      // F — a downed friend in front first (kneel by them; F again gets up), else the item, else the machine, else the drawer (when it is
      // nearer than the way), else the way
      if (K['KeyF'] && (kneel.st || dnFront)) { K['KeyF'] = false; if (kneel.st) stopKneel(null); else startKneel(dnFront) }
      if (K['KeyF']) {
        K['KeyF'] = false
        if (nearItem) {
          const res = itemSys.pickUp(nearItem.key)
          if (res.ok) { showMessage(`you take the ${ITEM_NAMES[res.item.type] ?? res.item.type}.`); if (!nearItem.key.startsWith('d:')) mem.noteTaken(level.index, nearItem.key) }   // a chunk spawn never respawns; a set-down item is not 'taken'
          else if (res.reason === 'full') showMessage('your hands are full.')
          // a cache: the word left with it is read on the card ('you left this.' for your own; a stranger's steadies you — not alone, for a
          // moment) and the room is told it is gone. The page count never moves: a cache is not a page
          if (res.ok && res.item.cacheKey) {
            if (!isMine(res.item)) sanity = Math.min(100, sanity + 4)
            ledger.take(res.item.cacheKey)
            relayLater('take', { key: res.item.cacheKey }, { drop: res.item.cacheKey })
            if (res.item.ph >= 0 || res.item.oct >= 0) openCard('read', readText(isMine(res.item) ? 'you left this.' : (res.item.by ?? 'wanderer'), res.item.ph >= 0 ? PHRASES[res.item.ph] : '', arrowFor(res.item.oct, player.angle)))
          }
          renderHotbar()
        } else if (nearMachine && !vendedSet.has(nearMachine.key)) {
          dispenseFromMachine(nearMachine)
        } else if (boxFirst) {
          startSearch(nearBox, thA)                             // last frame's threat record (this frame's lands below)
        } else if (nearExit) {
          travel(nearExit)
        }
      }
      // Q — use: a bandage on a hunted floor (1-3) is a committed wrap (peek now, consume when it lands); everything else as before
      if (K['KeyQ']) {
        K['KeyQ'] = false
        const it = itemSys.peekSelected()
        if (it?.type === 'bandage' && level.index >= 1 && level.index <= 3) { if (!commit.active) { commit.start(); showMessage('you hold still and wrap it.') } }
        else applyItemEffect(itemSys.useSelected())
      }
      if (K['KeyX']) { K['KeyX'] = false; setDown() }
      if (K['KeyC']) { K['KeyC'] = false; whistleOut(creaturesLive) }   // C — call out (the touch CALL button sets the same key; lying down too)
      if (K['KeyM']) { K['KeyM'] = false; const on = !getPref('music'); setPref('music', on); showMessage(on ? 'the music seeps back in.' : 'the music stops.') }
      if (K['KeyN']) { K['KeyN'] = false; cycleTrack() }
      if (K['KeyL']) {
        K['KeyL'] = false
        if (kneel.st) showMessage(LIGHT_STAYS_LINE)        // kneeling, the light is theirs
        else { flashlight = !flashlight; lightToggles++; showMessage(flashlight ? 'flashlight on.' : litOffLine(litRec ? litRec.name : null)) }   // the counter: a haunt only restores a light you did not touch; dark in a friend's light, the line names them
      }
      if (K['KeyB']) {
        K['KeyB'] = false
        // what the push is (compose-gates.js beaconDecision): the webhook fires whenever a beacon is set; the counter-claim counts toward
        // the seam only when the file can hold one (else 'you have no standing to file this.' follows it); the column's push line, the
        // anchored's pin in the payload, the processed's floor filed (it never restocks)
        const effect = getPref('beaconEffect')
        const webhook = getPref('beaconWebhook')
        const target = (webhook || '').toLowerCase().replace(/[^a-z0-9]/g, '')
        const b = beaconDecision({ effect, target, rules, status: file.status, closing: file.closing, anchor, webhook })
        for (let i = 0; i < b.lines.length; i++) showMessage(b.lines[i])
        if (b.fire) {
          // fire the real webhook on desktop; the counter-claim resolves renderer-side either way
          const p = window.backrooms?.fireBeacon?.(b.payload)
          if (p) p.then(r => showMessage(
                    r?.ok ? 'something answers.'
                  : r?.reason === 'cooldown' ? 'the beacon is still warm.'
                  : 'the beacon goes quiet.'))
                 .catch(() => showMessage('the beacon goes quiet.'))
          else if (!b.counterClaim) showMessage('the beacon goes quiet.')
          if (b.filesFloor) filedFloors.add(floorKey(worldSeed, level.index))
          if (b.setBeaconFired) { beaconFired = true; tryFinale() }
        }
      }
      for (let i = 0; i < 6; i++) {
        const code = `Digit${i + 1}`
        if (K[code]) { K[code] = false; cancelCommit(); itemSys.select(i); renderHotbar() }   // a slot change ends a wrap (consume takes the SELECTED item)
      }
      // E — the presence, else the form or the scrap, else (∅, a tenant-to-be) the sealed door ahead, else the lost soul
      if (K['KeyE']) {
        K['KeyE'] = false
        const door = cfg.map && !nearPresence && !nearScrap && provisionalOrigin() === 'tenant' ? doorAhead() : null
        if (nearPresence) openDialog()
        else if (nearScrap) nearScrap.form ? openForm() : openNoteCard(nearScrap)   // TODO(integrate:W3) I13: an unread page under compliance opens 'sealed' (mods.sealedCards)
        else if (door) knockDoor(door)
        else if (nearNpc) {
          const r = rules.npcLine()                       // processed: the soul sees the stamp and will not talk
          if (r) { showMessage(r.text); sanity = Math.max(0, Math.min(100, sanity + r.sanity)) }
          else showMessage(NPC_LINES[Math.floor(Math.random() * NPC_LINES.length)])   // TODO(integrate:W3) I13: the pool is NPC_LINES.concat(npcLines(file.status))
        }
      }
      // Space — the ward — is the charger block at the head of the frame (ward.js reads the press / release edge counts)
    }
    if (K['Escape'] && dialogOpen) { K['Escape'] = false; closeDialog() }

    // ── stream world + subsystems around the player ──
    level.cache.preload(pcx, pcy)
    itemSys.update(pcx, pcy)
    level.decor.update(pcx, pcy)
    // ── the map (fogmap.js): O(1) until your cell changes; then the flood of the open cells around you, the pins of what you can see
    //    (sightpins.js), and the stale check — a way drawn where the building has since moved is lost, said once per 90 s. The block has
    //    no map; the card redraws its strokes on that tick only and its arrow when you turn. ──
    const cix = Math.floor(player.x), ciy = Math.floor(player.y)
    const cellChanged = cix !== lastCellIx || ciy !== lastCellIy
    lastCellIx = cix; lastCellIy = ciy
    if (!cfg.map) {
      const st = fog.step(level.index, player.x, player.y, revealRadius(level.index), level.grid.floor, epochOf)
      if (st) {
        pinSeen(cfg.fogDistance * fogMul)
        const lost = fog.checkStale(level.index, player, nearestWayFn, epochOf)
        if (lost && playT - lastLostMsg > 90) { lastLostMsg = playT; showMessage('the hole is not where you drew it.', PRIO.discovery); whisper() }
        if (mapOpen) mapCard.cellsDirty()
      }
      if (mapOpen) mapCard.angleDirty(player.angle)
    }
    // ── the compass (compass.js): the nearest way you have SEEN that leads on (a '~' when its chunk moved), else the faint pull of the
    //    nearest loaded way, and the way you came; recomputed only when the cell, the heading (> 0.05 rad) or the known ways changed;
    //    hidden under the prompt ──
    if (compassEl) {
      const known = fog.ways(level.index)
      if (cellChanged || Math.abs(player.angle - lastCompassAngle) > 0.05 || known.length !== lastWayCount) {
        lastCompassAngle = player.angle; lastWayCount = known.length
        compassState.known = known
        compassState.fallback = level.decor.nearestWayAny(player.x, player.y)     // one reused { rec, dist }: read now, never kept
        compassState.arrived = fog.arrivedPin(level.index)
        compassLines(compassState, compassOut)
        const s = compassText(compassOut)
        if (s !== lastCompassText) { compassEl.textContent = s; lastCompassText = s }
      }
      compassEl.style.opacity = (compassOut.length === 0 || nearExit) ? '0' : '1'
    }
    netTimer += dt
    if (mpClient?.isConnected() && netTimer >= 0.05) { netTimer = 0; mpClient.sendPos(player.x, player.y, player.angle, player.hp) }
    // the people: the roster and this floor's remote players, once; then the bus's tick (new / gone / stale peers, the 3 s heartbeat) and
    // 'here' about once a second (the bus sends only a change, or the 3 s beat)
    fillRemotes()
    if (bus) { bus.tick(performance.now()); hereTimer += dt; if (hereTimer >= 1) { hereTimer = 0; bus.here(hereFields()) } }
    // a cache or a take the outgoing gap held back goes now, in order (relayLater)
    if (bus) while (evOutbox.length && bus.emit(evOutbox[0][0], evOutbox[0][1], evOutbox[0][2])) evOutbox.shift()
    // kneeling: a tick to the friend every 500 ms while they stay down, on this floor and within six; else the kneel ends and your light
    // comes back (they woke, walked off, dropped off the floor)
    if (kneel.st) {
      let tgt = null
      for (let i = 0; i < remoteOnFloor.length; i++) if (remoteOnFloor[i].id === kneel.st.id) { tgt = remoteOnFloor[i]; break }
      const kr = kneel.tick(performance.now(), tgt, player)
      if (kr === 'emit') { kneelOut.to = kneel.st.id; bus?.emit('kneel', kneelOut) }
      else if (kr === 'ended') { flashlight = savedLight; bus?.here(hereFields()) }
    }
    // the roll call (rollcall.js), on the list the bus just recounted: a friend on this floor who has not whistled, spoken or stood within six
    // for 90 s has gone quiet — said at a murmur's priority, and it costs you, again every 90 s it stays true. Its one reused list, read now
    if (bus) { const qs = rollcall.tick(performance.now(), bus.freshPeersOnFloor()); for (let i = 0; i < qs.length; i++) { sanity = Math.max(0, sanity - QUIET_SANITY); showMessage(qs[i].line, PRIO.ambient) } }
    // a friend's light (lightshare.js): the nearest friend on this floor whose light is on, within six and in sight — standing in it unlit
    // the things see you less (perceptionFor) and the dark eats at you slower (sanityStep). Here, before both read it; solo, never
    litRec = bus ? litFriendNear(player, bus.freshPeersOnFloor(), LIT_OPTS) : null; litNear = litRec !== null
    // ── the things: what they know about you this frame, then one update; the threat record it returns drives contact damage, the
    //    heartbeat and sanity (no second pass over the list). Creatures can be switched off entirely (pure liminal exploration;
    //    creaturesOn was read at the top of the frame): the record is then reset, so everything below reads zero. ──
    aiCtx.flashlight = flashlight; aiCtx.sprinting = moved && wantSprint; aiCtx.dark = !cfg.lights; aiCtx.fog = cfg.fogDistance
    aiCtx.radioOn = itemSys.isRadioOn(); aiCtx.t = playT; aiCtx.playerAngle = player.angle; aiCtx.damage = cfg.entities?.damage ?? 16
    // (aiCtx.lures was refreshed above, with the dropped things' clocks)
    // the file's reading of you (compose-perception.js over rules.perception): the four numbers copied onto aiCtx, never the object — LEGACY's
    // are { 1, false, 1, 1 }; a filed player still and silent, unlit, the radio off is hidden (thin: still 0.6 s, whatever the light)
    perCtx.rules = rules; perCtx.depth = level.depth; perCtx.stillFor = stillness.stillFor(playT); perCtx.noiseFor = stillness.noiseFor(playT)
    perCtx.flashlight = flashlight; perCtx.radioOn = aiCtx.radioOn; perCtx.litNear = litNear
    const pf = perceptionFor(perCtx)
    aiCtx.sightMul = pf.sightMul; aiCtx.hidden = pf.hidden; aiCtx.loseTrackMul = pf.loseTrackMul; aiCtx.noiseMul = pf.noiseMul
    // the first frame it hides you with a thing within 12 (last frame's record: this frame's lands below), once a run, not during a stand
    if (pf.hidden && !wasHidden && !huntsMovementSaid && thA.nearest < 12 && standHeld <= 0) { huntsMovementSaid = true; showMessage(HUNTS_MOVEMENT_LINE, PRIO.discovery) }
    wasHidden = pf.hidden
    // footsteps: walk 3 / sprint 7, halved by sweet water (tactics.quiet); the flood reads the grid at this frame's chunk
    if (footstep && creaturesLive) level.entitySys.noise(player.x, player.y, (aiCtx.sprinting ? 7 : 3) * quiet(quietTimer))
    const th = creaturesOn ? level.entitySys.update(dt, player, pcx, pcy, aiCtx) : (level.entitySys.getThreat().reset(), level.entitySys.getThreat())
    const nEv = level.entitySys.drainEvents(entEvents)
    for (let i = 0; i < nEv; i++) onEntityEvent(entEvents[i])
    const woke = level.entitySys.takeWakeEvent()
    if (woke) { footfall(); showMessage(woke > 1 ? 'they followed you down.' : 'it followed you down.', PRIO.discovery) }

    // ── the hauntings (haunts.js): only while CALM — no event could fire either, nothing hunting, nothing within 14, no hit for 20 s,
    //    the map folded; dreadQuietT (a haunt sets 20 s, an event 12 s) keeps the two dread layers apart. The block has none (no fog, no
    //    records). getHaunts is decor's one reused list; the effect is applied by applyHaunt and the spot pinned on the map. ──
    const hauntCalm = evCanFire && dreadQuietT <= 0 && !th.hunted && th.nearest >= 14 && playT - lastHitT > 20 && !mapOpen && !cfg.map
    const h = hauntCalm ? haunts.check(player.x, player.y, level.decor.getHaunts(), true) : null
    if (h) {
      const fx = hauntEffects(h.id, hauntCtx())
      if (fx) { haunts.fire(h.key); applyHaunt(fx); dreadQuietT = 20; fog.pinThing(level.index, h.key, 'haunt', h.x, h.y) }
    }

    // ── HP: contact damage, i-frames, delayed regen, death ──
    if (invuln > 0) invuln -= dt
    if (!transitioning && creaturesLive && getPref('damage') && invuln <= 0 && th.dmg > 0 && down.st !== 'down') {
      player.hp -= th.dmg * rules.damageMul; invuln = 0.7; hurt = 1; regenDelay = 6; shake = 1   // (thin: there is less of you to hit)
      showMessage(th.dmgKind === 'arc' ? 'the current finds you.' : 'it has you.', PRIO.urgent)   // the hit's line lands with the hit
      lastHitT = playT
      if (mapOpen) closeMap(); if (noteOpen) closeNoteCard()
      cancelCommit('the bandage slips.')
      fog.pinThing(level.index, 'hurt:' + frameCount, 'hurt', player.x, player.y)   // where it hurt you, on the map (the last 12 kept)
    }
    if (regenDelay > 0) regenDelay -= dt
    else if (player.hp < player.maxHp && down.st !== 'down') player.hp = Math.min(player.maxHp, player.hp + 3.5 * dt)
    if (hurt > 0) hurt = Math.max(0, hurt - dt * 2)
    const hurtEl = document.getElementById('hurt')
    if (hurtEl) hurtEl.style.opacity = (hurt * 0.55).toFixed(2)
    // lying down: the veil lifts as you are counted; 25 s with nobody kneeling is a death — nobody came (the decision's cost, die(d))
    const veil = down.st === 'down' ? down.lift().toFixed(2) : '0'
    if (downEl && veil !== downVeil) { downVeil = veil; downEl.style.opacity = veil }   // written on a change only: nothing at rest
    if (down.tick() === 'timeout') die(deathDecision({ mp: !!mpClient, peers: 0, downSt: down.st, rules, filed, thin, D: driftD(), timeout: true }))
    // hp gone: a friend fresh on this floor and you go down instead (compose-gates.js); already down, you wait; else a death — under LEGACY
    // (or solo) today's die() exactly, with the column's consequences when filed
    if (player.hp <= 0) { player.hp = 0; const d = deathDecision({ mp: !!mpClient, peers: bus ? bus.freshPeersOnFloor().length : 0, downSt: down.st, rules, filed, thin, D: driftD(), timeout: false }); if (d === 'down') goDown(); else if (d !== 'wait') die(d) }

    // ── tension (tension.js): the hunted state as heartbeat and music. The hunt's report drives it (Level 0 / ∅, a fade and creatures
    //    off read as calm — null); the heart comes into your ears as the level rises, the floor's own song thickens on 'enter' and takes
    //    its long breath back on 'exit' (setMood patches the live mood in place: no restart, no seam), one 'it is close.' per crossing ──
    const tn = tension.tick(dt, creaturesLive && !transitioning ? th : null, player.hp)
    heartT -= dt
    if (down.st === 'down') { if (heartT <= 0) { heartbeat(DOWN_BEAT.intensity); heartT = DOWN_BEAT.everyS } }   // lying down: slow and faint (the music may still thicken: they ARE on you)
    else if (tn.beat < Infinity && heartT <= 0) { heartbeat(0.5 + tn.level); heartT = tn.beat }
    // (songBase: a loop-wide binding named base would shadow initGame's config for the whole frame, and the murmur reads its messageInterval)
    const songBase = trackIdx < 0 ? cfg.music : TRACKS[trackIdx].mood
    if (tn.just === 'enter') setMood(huntDelta(songBase))
    if (tn.just === 'exit') setMood(calmDelta(songBase))
    huntMood = tn.mood === 'hunt'
    // not on the heels of 'it has seen you.': it would only wait out that line's dwell and push the hit's line back
    if (tn.close && playT - lastSeenLine > 1.6) showMessage('it is close.', PRIO.combat)

    // ── sanity — dark, the hunt and a thing's gaze drain it; light, almond water, a friend restore it ──
    // ONE step (compose-sanity.js), per second: under LEGACY the post-core block term for term — light ±2, the depth drain (Level ∅ none),
    // -3 hunted, -gazeRate under a gaze (a smiler 1.5, a watcher 3), +3 for one friend within 6 on this floor — and what the file adds:
    // the column's light, a status's or a closing's depth term, the pin's leash, the company pool a fresh friend draws on, -1 flat lying
    // down. The result is one reused record; the clamp is here, as before
    sanCtx.rules = rules; sanCtx.mods = mods; sanCtx.closingOverlay = co; sanCtx.flashlight = flashlight; sanCtx.litNear = litNear
    sanCtx.index = level.index; sanCtx.depth = level.depth; sanCtx.hunted = th.hunted; sanCtx.gaze = th.gaze; sanCtx.gazeRate = th.gazeRate
    sanCtx.origin = origin; sanCtx.drift = driftD(); sanCtx.leashCalm = leashCalm
    sanCtx.down = down.st === 'down'           // lying down: -1 flat, nothing else counts
    sanCtx.company = sanCtx.companyWas = company.value; sanCtx.disagreeSaid = disagreeSaid; sanCtx.dt = dt
    const s = sanityStep(sanCtx)
    sanity = Math.max(0, Math.min(100, sanity + s.delta * dt))
    company.add(s.companyDelta)
    if (s.exhaustedNow) showMessage(EXHAUSTED_LINE, PRIO.discovery)
    if (s.disagreeNow) { disagreeSaid = true; showMessage(DISAGREE_LINE, PRIO.discovery) }
    // someone has evidence of you: for 90 s the floor under you is 25 (not calm — the whispers still come at 25)
    if (evidence.active(playT)) sanity = Math.max(sanity, EVIDENCE_FLOOR)
    updateSanity()
    const insane = Math.max(0, Math.min(1, (42 - sanity) / 42))
    if (insaneEl) insaneEl.style.opacity = (insane * 0.6).toFixed(2)
    // the whispers come closer together the higher the tension runs (the window shrinks by up to half)
    if (insane > 0.25 && !transitioning) { sanWhisperT -= dt; if (sanWhisperT <= 0) { whisper(); sanWhisperT = (3 + Math.random() * 6) * (1 - 0.5 * tn.level) } }

    // ── screen shake (decays) ──
    if (shake > 0.01) {
      shake = Math.max(0, shake - dt * 3)
      const m = shake * 8 * (renderOpts.reduceFlicker ? 0.25 : 1)     // reduce flicker / reduced motion: a quarter of the shake
      canvas.style.transform = `translate(${((Math.random() - 0.5) * m).toFixed(1)}px, ${((Math.random() - 0.5) * m).toFixed(1)}px)`
    } else if (canvas.style.transform) canvas.style.transform = ''

    // ── assemble sprites and render ──
    // advance any event apparitions (render-only; no collision or damage)
    for (let i = ephemera.length - 1; i >= 0; i--) {
      const a = ephemera[i]
      if (a.pauseT > 0) { a.pauseT -= dt; continue }                // another drop-in, stopped to wave at a thin player (spawnCrosser)
      a.x += a.vx * dt; a.y += a.vy * dt; a.ttl -= dt
      if (a.pauseAtTtl != null && !a.paused && a.ttl <= a.pauseAtTtl) {
        a.paused = true
        const cp = rules.crosserPause()                               // null once the ballast has cured you: it walks on
        if (cp) { a.pauseT = cp.pause; sanity = Math.min(100, sanity + cp.sanity); showMessage(cp.line, PRIO.discovery) }
      }
      if (a.vanishAt && (a.x - player.x) ** 2 + (a.y - player.y) ** 2 < a.vanishAt * a.vanishAt) a.ttl = 0   // the still figure: gone when you come close
      if (a.ttl <= 0) ephemera.splice(i, 1)
    }
    // one flat list in this order: enemies (as-is), remote players, npcs, props, exits, items, notes, machines, sights, apparitions — built
    // from pooled records every frame instead of fresh objects (createEntityAssembler: same fields, same values, same order as before)
    entityAsm.begin()
    if (creaturesOn) entityAsm.pass(level.entitySys.getEntities())
    if (mpClient) entityAsm.add('player', remoteOnFloor, EF.player)
    entityAsm.add('npc', level.decor.getNpcs(), EF.npc)
    entityAsm.add('prop', level.decor.getProps(), EF.prop)
    entityAsm.add('exit', level.decor.getExits(), EF.exit)
    entityAsm.add('stair', level.decor.getStairs(), EF.exit)     // the ways up draw with the exit art, from their own pool (never aliasing the exits')
    entityAsm.add('item', itemSys.getWorldItems(), EF.item)
    entityAsm.add('note', level.decor.getScraps(), EF.note, readSet)
    entityAsm.add('machine', level.decor.getMachines(), EF.machine, vendedSet)
    entityAsm.add('sight', level.decor.getSights(), EF.sight)
    entityAsm.add('apparition', ephemera, EF.apparition)
    const allEntities = entityAsm.end()

    const r0 = performance.now()
    // the wall test declares the chunk it hands the cache (and the cache's evict radius), which lets the rays' per-frame isWall memo stay on
    // (gfx-world.js memoSafe); an undeclared closure renders the same pixels, only slower
    const wallFn = (wx, wy) => level.cache.isWall(wx, wy, pcx, pcy)
    wallFn.pcx = pcx; wallFn.pcy = pcy; wallFn.evictRadius = level.cfg.chunkEvictRadius ?? 3
    level.gfx.render(player, wallFn, flicker, allEntities, fogMul,
      { flashlight, glow: fogTimer > 0 ? [80, 235, 110] : null }, timing)
    const r1 = performance.now()
    frameCount++
    if (levelStart && levelStart.frames++ === 0) {
      levelStart.firstMs = r1 - r0; levelStart.readyMs = r1 - levelStart.t0
      if (gfxStats) { try { console.info(`[renderer] level ${levelStart.level} start: build ${levelStart.buildMs.toFixed(1)} ms (renderer ${levelStart.gfxMs.toFixed(1)}), first frame ${levelStart.firstMs.toFixed(1)} ms, ready after ${levelStart.readyMs.toFixed(1)} ms`) } catch { /* ignore */ } }
    }
    if (gfxStats) gfxStats.frame(rawMs, r1 - r0)
    lastWorkMs = performance.now() - w0                                   // this frame's callback cost: the controller's headroom signal
   } catch (e) {
    // A per-frame error must never permanently freeze the game: log it (first
    // few only, to avoid flooding) and fall through to reschedule below.
    loopErrs++
    if (loopErrs <= 5) {
      try { window.backrooms?.logError?.(`loop#${loopErrs} @frame${frameCount} lvl${level?.index}: ${(e && e.stack) || e}`) } catch (_) {}
    }
   }
   requestAnimationFrame(loop)   // ALWAYS reschedule — resilience over a stray throw
  }
  requestAnimationFrame(loop)

  // Stall watchdog — if requestAnimationFrame stops advancing (a GPU/compositor
  // hang that never trips main's 'unresponsive'), record it so the freeze finally
  // leaves a trace in the log instead of vanishing silently.
  let watchPrev = -1
  setInterval(() => {
    // Only a real stall counts — rAF legitimately pauses when the window is
    // hidden/minimized, so don't cry wolf then.
    if (frameCount === watchPrev && document.visibilityState === 'visible') {
      try { window.backrooms?.logError?.(`render loop STALLED — no new frames for ~4s at frame ${frameCount} (level ${level?.index})`) } catch (_) {}
    }
    watchPrev = frameCount
  }, 4000)
}
