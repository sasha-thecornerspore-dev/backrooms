// THE LEGACY-IDENTITY SUITE. The legacy state — { origin null, thin false, filed false, rules LEGACY, status 'notice-mailed',
// closing null, no bus or no fresh peers, down.st 'ok' } — must reproduce the POST-core game.js byte for byte through the six
// composers. Every case quotes the game.js lines it reproduces (re-anchored by text: game.js has moved since the specs were
// written). It also pins the LEGACY / notice-mailed value of every W2 / W3 name the composers read, so a rename there fails
// here, not in game.js.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { perceptionFor, AI_CTX_DEFAULTS } from '../src/renderer/compose-perception.js'
import { sanityStep } from '../src/renderer/compose-sanity.js'
import { polaroidCaption } from '../src/renderer/compose-polaroid.js'
import { radioLine, RADIO_GROUPS } from '../src/renderer/compose-radio.js'
import { wishRoute, isClaim } from '../src/renderer/compose-wish.js'
import { finaleGate, beaconDecision, deathDecision } from '../src/renderer/compose-gates.js'
import { LEGACY, LEGACY_LAST_LINE } from '../src/renderer/origin-rules.js'
import { claimRefile } from '../src/renderer/origin-processed.js'
import { statusMods, loadFile, depthOf, fileStatus } from '../src/renderer/status.js'
import { closingOverlay, closingReply } from '../src/renderer/closings.js'
import { createEntitySystem } from '../src/renderer/entities.js'
import { generateChunk, CHUNK_SIZE } from '../src/renderer/world.js'
import { HF } from '../src/renderer/gfx-frame.js'

const game = readFileSync(new URL('../src/renderer/game.js', import.meta.url), 'utf8')
const DT = 1 / 60
const N = CHUNK_SIZE
const NM = statusMods('notice-mailed')

// ── (1) perception: the replay ──────────────────────────────────────────────────────────────────────────────────────
// game.js: `const aiCtx = { flashlight, sprinting: false, dark: false, fog: 16, radioOn: false, lures: [], t: 0, hf: HF,
// playerAngle: 0, player, damage: 16 }` and `const th = creaturesOn ? level.entitySys.update(dt, player, pcx, pcy, aiCtx) : …`
describe('(1) perception replay: the four fields at their defaults change nothing', () => {
  function chunkFloor(cx, cy) {
    const g = generateChunk(cx, cy, 0, { corridor: 1 })
    return (ix, iy) => ix >= 0 && iy >= 0 && ix < N && iy < N && g[iy * N + ix] === 0
  }
  const floor = chunkFloor(0, 0)
  const mkGrid = (f) => ({ floor: f, setPlayerChunk() {} })
  const wallOf = (f) => (wx, wy) => !f(Math.floor(wx), Math.floor(wy))
  const ent = (x, y, variant, id) => ({ id, x, y, type: 'stalker', variant, state: 'idle', dir: 0, dirTimer: 99, stagger: 0, wardHits: 0, chunkCx: 0, chunkCy: 0 })
  function replay(extra) {
    let t = 0
    const sys = createEntitySystem({ chunkEvictRadius: 3, entities: { enabled: false } }, wallOf(floor), { grid: mkGrid(floor), obstacles: null, now: () => t })
    const player = { x: 5.5, y: 11.5, angle: 0 }
    const ctx = { flashlight: false, sprinting: false, dark: true, fog: 16, radioOn: false, lures: [], t: 0, hf: HF, playerAngle: 0, player, damage: 16, ...extra }
    const list = sys.getEntities()
    // a shade 8 u down the mid-row hall, a hound, a watcher, a crawler 2.5 u off
    list.push(ent(13.5, 11.5, 'shade', 1), ent(5.5, 3.5, 'hound', 2), ent(17.5, 5.5, 'watcher', 3), ent(5.5, 9.0, 'crawler', 4))
    for (const e of list) expect(floor(Math.floor(e.x), Math.floor(e.y)), e.variant).toBe(true)
    const trace = [], out = []
    for (let i = 0; i < 2000; i++) {
      t = i * DT
      // a deterministic lissajous over the hall; the light toggles every 300 frames; a sprint-loud step every 90
      player.x = 9.5 + 4 * Math.sin(i * 0.011); player.y = 11.5 + 3 * Math.sin(i * 0.017 + 1)
      player.angle = i * 0.02
      if (i % 300 === 0) ctx.flashlight = !ctx.flashlight
      if (i % 90 === 0) sys.noise(player.x, player.y, 7)
      ctx.t = t; ctx.playerAngle = player.angle
      sys.update(DT, player, 0, 0, ctx)
      for (const e of list) trace.push([e.id, e.x, e.y, e.ai, e.seen, e.los, e.lostT, e.heardId].join('|'))
      const m = sys.drainEvents(out)
      for (let k = 0; k < m; k++) trace.push(out[k].kind + ':' + out[k].id)
    }
    return trace
  }
  it('2000 frames, four creatures: the 11-key and the 15-key ctx give byte-identical trajectories and events', () => {
    const a = replay({})
    const b = replay({ ...AI_CTX_DEFAULTS })
    expect(b.length).toBe(a.length)
    expect(b).toEqual(a)
    // the replay is not idle: things hunted, heard and lost the line
    const s = a.join('\n')
    expect(s).toMatch(/\|hunt\|/)
    expect(s).toMatch(/alert:/)
  })
})

// ── (2) perceptionFor(LEGACY) is the identity ───────────────────────────────────────────────────────────────────────
describe('(2) perceptionFor over LEGACY is { 1, false, 1, 1 } for every input', () => {
  it('every depth x stillFor x noiseFor x light x radio x litNear', () => {
    const ref = LEGACY.perception({})
    let bad = 0, n = 0, first = null
    const ctx = { rules: LEGACY, depth: 0, stillFor: 0, noiseFor: 0, flashlight: false, radioOn: false, litNear: false }
    for (let depth = 0; depth <= 3; depth++) for (let s = 0; s <= 200; s++) for (let q = 0; q <= 201; q++) for (let bits = 0; bits < 8; bits++) {
      ctx.depth = depth; ctx.stillFor = s * 0.5; ctx.noiseFor = q === 201 ? Infinity : q * 0.5
      ctx.flashlight = (bits & 1) !== 0; ctx.radioOn = (bits & 2) !== 0; ctx.litNear = (bits & 4) !== 0
      const p = perceptionFor(ctx)
      n++
      if (first === null) first = p
      if (p !== first || p.sightMul !== 1 || p.hidden !== false || p.loseTrackMul !== 1 || p.noiseMul !== 1) bad++
    }
    expect(n).toBe(4 * 201 * 202 * 8)
    expect(bad).toBe(0)
    expect(first).not.toBe(ref)                                   // a copy, never the block's own object
    expect(first).toEqual({ sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1 })
  })
})

// ── (3) sanity ──────────────────────────────────────────────────────────────────────────────────────────────────────
// game.js:
//   let sdelta = flashlight ? 2 : -2
//   sdelta -= (level.index >= 0 && level.index <= 3 ? level.index : 0) * 0.5   // Level ∅ (index 4) does not drain like a fourth floor
//   if (th.hunted) sdelta -= 3
//   if (th.gaze) sdelta -= th.gazeRate
//   if (mpClient) { for (const rp of remoteOnFloor) { if ((rp.x - player.x) ** 2 + (rp.y - player.y) ** 2 < 36) { sdelta += 3; break } } }
//   sanity = Math.max(0, Math.min(100, sanity + sdelta * dt))
describe('(3) sanityStep(legacy) is the post-core sanity block', () => {
  it('the source block is still the one quoted', () => {
    expect(game).toMatch(/let sdelta = flashlight \? 2 : -2\r?\n\s*sdelta -= \(level\.index >= 0 && level\.index <= 3 \? level\.index : 0\) \* 0\.5/)
    expect(game).toMatch(/if \(th\.hunted\) sdelta -= 3/)
    expect(game).toMatch(/if \(th\.gaze\) sdelta -= th\.gazeRate/)
  })
  function legacyDelta(flashlight, index, hunted, gaze, gazeRate, remotes, player) {
    let sdelta = flashlight ? 2 : -2
    sdelta -= (index >= 0 && index <= 3 ? index : 0) * 0.5
    if (hunted) sdelta -= 3
    if (gaze) sdelta -= gazeRate
    for (const rp of remotes) { if ((rp.x - player.x) ** 2 + (rp.y - player.y) ** 2 < 36) { sdelta += 3; break } }
    return sdelta
  }
  it('flashlight x index 0..4 x hunted x gaze x rate x { none, a peer at d² 35.9, at 36.1 }', () => {
    const player = { x: 10, y: 10 }
    const peers = [[], [{ id: 'a', x: 10 + Math.sqrt(35.9), y: 10 }], [{ id: 'b', x: 10, y: 10 + Math.sqrt(36.1) }]]
    const ctx = { rules: LEGACY, mods: NM, closingOverlay: closingOverlay(null), flashlight: false, litNear: false, index: 0, depth: 0, hunted: false, gaze: false, gazeRate: 0,
      origin: null, drift: 123, leashDebt: 0, leashCalm: 0, down: false, player, self: { status: 'notice-mailed', aseed: null, origin: null, thin: false },
      remotes: [], fresh: null, onFloor: null, company: 60, companyWas: 60, disagreeSaid: false, dt: DT }
    let first = null, cases = 0
    for (const f of [true, false]) for (let index = 0; index <= 4; index++) for (const h of [true, false]) for (const g of [true, false]) for (const r of [1.5, 3]) for (const rem of peers) {
      Object.assign(ctx, { flashlight: f, index, depth: depthOf(index), hunted: h, gaze: g, gazeRate: r, remotes: rem })
      const s = sanityStep(ctx)
      first ??= s
      expect(s).toBe(first)
      expect(s.delta, `f${f} i${index} h${h} g${g} r${r} n${rem.length}`).toBe(legacyDelta(f, index, h, g, r, rem, player))
      expect(s.companyDelta).toBe(0.75 * DT)
      expect(s.exhaustedNow).toBe(false)
      expect(s.disagreeNow).toBe(false)
      expect(s.nearestFriendId).toBe(null)
      cases++
    }
    expect(cases).toBe(240)
    // ∅ at index 4: the depth term is 0, the dark alone drains 2/s; index 3 drains 1.5 on top
    Object.assign(ctx, { flashlight: false, index: 4, depth: 0, hunted: false, gaze: false, remotes: [] })
    expect(sanityStep(ctx).delta).toBe(-2)
    Object.assign(ctx, { index: 3, depth: 3 })
    expect(sanityStep(ctx).delta).toBe(-3.5)
  })
  it('pins the W2 / W3 values the composer reads', () => {
    for (let d = 0; d <= 3; d++) { expect(LEGACY.lightTerm(true, false, d)).toBe(2); expect(LEGACY.lightTerm(false, false, d)).toBe(-2) }
    expect(LEGACY.leash).toBe(false)
    expect(LEGACY.friendBase({ rp: { id: 'x' }, selfAseed: null })).toBe(3)
    expect(NM.sanityDepthTerm(4, 0)).toBe(0)
    expect(NM.sanityDepthTerm(3, 3)).toBe(-1.5)
    expect(closingOverlay(null).sanityDepthTerm).toBeUndefined()
  })
})

// ── (4) polaroid ────────────────────────────────────────────────────────────────────────────────────────────────────
// game.js (firePolaroid, after the noise 9 and the flash):
//   const thinNear = ephemera.some(a => a.variant === 'thin' && (a.x - player.x) ** 2 + (a.y - player.y) ** 2 < 16)
//   const finalizing = sanity < 40 || (level?.index ?? 0) >= 3
//   sanity = Math.min(100, sanity + 8); wardPulse()
//   thinNear -> 'the film shows someone who was not in the room. you can see the wall through them.'
//   finalizing -> 'the film shows the hall as it will finalize: darker, one door fewer.'
//   else const g = 'iwashere'[photoIdx % 8]; photoIdx++ -> `the film develops one letter that was not in the room: "${g}". transcribe it.`
describe('(4) polaroidCaption(legacy) is the three captions of firePolaroid', () => {
  it('the source still carries the three captions and the finalizing gate', () => {
    expect(game).toContain("cap = 'the film shows someone who was not in the room. you can see the wall through them.'")
    expect(game).toContain("cap = 'the film shows the hall as it will finalize: darker, one door fewer.'")
    expect(game).toContain('cap = `the film develops one letter that was not in the room: "${g}". transcribe it.`')
    expect(game).toContain('const finalizing = sanity < 40 || (level?.index ?? 0) >= 3')
    expect(game).toContain("const g = 'iwashere'[photoIdx % 8]; photoIdx++")
  })
  function legacy(thinNear, index, sanity, photoIdx) {
    const finalizing = sanity < 40 || index >= 3
    if (thinNear) return { cap: 'the film shows someone who was not in the room. you can see the wall through them.', adv: false }
    if (finalizing) return { cap: 'the film shows the hall as it will finalize: darker, one door fewer.', adv: false }
    const g = 'iwashere'[photoIdx % 8]
    return { cap: `the film develops one letter that was not in the room: "${g}". transcribe it.`, adv: true }
  }
  it('thinNear x index 0..4 x sanity {0, 39, 40, 100} x photoIdx 0..15', () => {
    let spelled = ''
    for (const thinNear of [true, false]) for (let index = 0; index <= 4; index++) for (const sanity of [0, 39, 40, 100]) for (let photoIdx = 0; photoIdx < 16; photoIdx++) {
      const r = polaroidCaption({ rules: LEGACY, mods: NM, subject: null, soul: null, doorArrow: null, thinNear, status: 'notice-mailed', index, depth: depthOf(index), sanity,
        origin: null, thin: false, thinFirstShot: true, anchor: null, D: 0, firstShotOfLevel: true, photoIdx, player: { x: 1, y: 2 }, lvl: index })
      const want = legacy(thinNear, index, sanity, photoIdx)
      expect(r.cap).toBe(want.cap)
      expect(r.glyphAdvance).toBe(want.adv)
      expect(r.sanity).toBe(8)
      expect(r.emitPhoto).toBe(null)
      expect(r.leashCalm).toBe(0)
      if (!thinNear && index === 0 && sanity === 100) spelled += /"(.)"/.exec(r.cap)[1]
    }
    expect(spelled).toBe('iwashereiwashere')
    // ∅ at index 4 is finalizing, as today
    const z = polaroidCaption({ rules: LEGACY, mods: NM, subject: null, soul: null, thinNear: false, status: 'notice-mailed', index: 4, depth: 0, sanity: 100, origin: null, thin: false, thinFirstShot: false, anchor: null, D: 0, firstShotOfLevel: false, photoIdx: 0, player: { x: 0, y: 0 }, lvl: 4 })
    expect(z.cap).toBe('the film shows the hall as it will finalize: darker, one door fewer.')
  })
  it('pins the W2 / W3 values the composer reads', () => {
    expect(LEGACY.polaroid({ thinFirstShot: true, D: 999, firstShotOfLevel: true, glyph: 'i' })).toBe(null)
    expect(LEGACY.canDevelopClaim).toBe(true)
    for (let index = 0; index <= 4; index++) for (const sanity of [0, 39, 40, 100]) {
      expect(NM.polaroidGlyph(index, depthOf(index), sanity)).toBe(!(sanity < 40 || index >= 3))
    }
    expect(NM.thinSanity).toBe(0)
  })
})

// ── (5) radio ───────────────────────────────────────────────────────────────────────────────────────────────────────
// game.js readRadio(on):
//   const dfloor = level?.index ?? 0; const deep = dfloor === 2 || dfloor === 3
//   on && deep -> showMessage(`the station counts, slow and patient: ${RADIO_GROUPS[stationIdx]}${last ? '' : ' …'}   [${stationIdx + 1}/${RADIO_GROUPS.length}]`)
//                 blip(); if (last) { heartbeat(); setTimeout(() => showMessage('it reads the last group, then stops. that one was yours.'), 1900) }
//                 stationIdx = (stationIdx + 1) % RADIO_GROUPS.length
//   else showMessage(on ? 'the radio crackles to life.' : 'the radio falls silent.')
describe('(5) radioLine(legacy) is readRadio', () => {
  // RADIO_GROUPS: game.js's own const while it has one; once the integrator imports compose-radio's, the import is the pin
  it('RADIO_GROUPS equals game.js\'s four groups', () => {
    const m = /const RADIO_GROUPS = (\[[^\]]*\])/.exec(game)
    if (m) expect([...RADIO_GROUPS]).toEqual(JSON.parse(m[1].replace(/'/g, '"')))
    else expect(game).toMatch(/import \{[^}]*\bRADIO_GROUPS\b[^}]*\} from '\.\/compose-radio\.js'/)
    expect([...RADIO_GROUPS]).toEqual(['12 26 04 22 11 08', '21 08 19 24 23 12', '23 12 17 23 11 08', '09 12 15 08'])
  })
  function legacy(on, index, stationIdx) {
    const out = { message: null, blip: false, heartbeat: false, followUps: [], advance: false }
    const deep = index === 2 || index === 3
    if (on && deep) {
      const last = stationIdx === RADIO_GROUPS.length - 1
      out.message = `the station counts, slow and patient: ${RADIO_GROUPS[stationIdx]}${last ? '' : ' …'}   [${stationIdx + 1}/${RADIO_GROUPS.length}]`
      out.blip = true
      if (last) { out.heartbeat = true; out.followUps.push({ text: 'it reads the last group, then stops. that one was yours.', ms: 1900 }) }
      out.advance = true
    } else out.message = on ? 'the radio crackles to life.' : 'the radio falls silent.'
    return out
  }
  it('on x index 0..4 x stationIdx 0..3, count 1', () => {
    for (const on of [true, false]) for (let index = 0; index <= 4; index++) for (let stationIdx = 0; stationIdx < 4; stationIdx++) {
      const depth = depthOf(index)
      const r = radioLine({ on, rules: LEGACY, mode: NM.radioMode(depth), stationIdx, groups: RADIO_GROUPS, count: 1, firstDeepHearing: true, rollLine: null })
      const w = legacy(on, index, stationIdx)
      const tag = `on${on} i${index} s${stationIdx}`
      expect(r.message, tag).toBe(w.message)
      expect(r.blip, tag).toBe(w.blip)
      expect(r.heartbeat, tag).toBe(w.heartbeat)
      expect(r.followUps, tag).toEqual(w.followUps)
      expect(r.advance, tag).toBe(w.advance)
      expect(r.ledgerHeardNow, tag).toBe(on && (index === 2 || index === 3) && stationIdx === 3)
      expect(r.keyLineNow, tag).toBe(false)
    }
  })
  it('pins the W2 / W3 values the composer reads', () => {
    expect({ ...LEGACY.radio({ last: true, firstDeepHearing: false }) }).toEqual({ heartbeat: 'last', followUp: LEGACY_LAST_LINE })
    expect(LEGACY.radio({ last: false, firstDeepHearing: true }).followUp).toBe(null)
    expect(LEGACY_LAST_LINE).toBe('it reads the last group, then stops. that one was yours.')
    expect([0, 1, 2, 3].map((d) => NM.radioMode(d))).toEqual(['crackle', 'crackle', 'ledger', 'ledger'])
  })
})

// ── (6) wish ────────────────────────────────────────────────────────────────────────────────────────────────────────
// game.js: const isClaim = (t) => /iwashere/.test(String(t).toLowerCase().replace(/[^a-z]/g, ''))
//   reply = claim ? 'you did not ask. you asserted. the file has no column to deny a claim made. received.'
//                 : 'your request has been received. whether it is heard is another matter.'
//   await window.backrooms.submitWish(text)
describe('(6) wishRoute(legacy) is the wish submit', () => {
  const CLAIM = 'you did not ask. you asserted. the file has no column to deny a claim made. received.'
  const WISH = 'your request has been received. whether it is heard is another matter.'
  const base = () => ({ origin: null, rules: LEGACY, file: loadFile(null), canFile: false, now: 1_700_000_000_000, depth: 1 })
  it('the source still carries the two replies', () => {
    expect(game).toContain(`'${CLAIM}'`)
    expect(game).toContain(`'${WISH}'`)
  })
  it("'i was here' is a claim; its submit text is the text, byte for byte", () => {
    const r = wishRoute({ ...base(), text: 'i was here' })
    expect(r).toEqual({ kind: 'claim', submit: { text: 'i was here', meta: { origin: null } }, reply: CLAIM, refile: claimRefile(null) })
  })
  it("'let me out' is a wish with the legacy reply", () => {
    const r = wishRoute({ ...base(), text: 'let me out' })
    expect(r.kind).toBe('wish')
    expect(r.submit.text).toBe('let me out')
    expect(r.submit.meta).toEqual({ origin: null })
    expect(r.reply).toBe(WISH)
  })
  it("'close the file' under notice-mailed is an ordinary wish", () => {
    const r = wishRoute({ ...base(), text: 'close the file' })
    expect(r.kind).toBe('wish')
    expect(r.submit.text).toBe('close the file')
  })
  it("'extension' with canFile false is W3's mailed reply, passed through", () => {
    const b = base()
    const r = wishRoute({ ...b, text: 'extension' })
    const w = fileStatus(b.file, 'extension', b.now, false)
    expect(r.kind).toBe('status')
    expect(r.chosen).toBe('extension')
    expect(r.reply).toBe(w.reply)
    expect(r.reply).toBe('a notice was mailed to you. you have not answered.')
    expect(r.resets).toEqual([])
    expect(r.file).toBe(b.file)
    expect(r.submit).toBeUndefined()
  })
  it('isClaim is game.js\'s regex on 20 fixtures', () => {
    const fixtures = ['I was here', 'i-w-a-s h e r e', 'iwashere', 'i was not here', 'I WAS HERE.', 'i.was.here', 'was here', 'iwas', 'hello', '',
      'i  was  here  !', 'IWASHERE', 'i was hear', 'someone said i was here once', '1 was here', 'i_was_here', 'i w a s h e r e x', 'iwashere iwashere', 'i was\nhere', 'wish: i was here']
    const m = /const isClaim = \(t\) => (\/[^\n]*?\/)\.test\(String\(t\)\.toLowerCase\(\)\.replace\(\/\[\^a-z\]\/g, ''\)\)/.exec(game)
    let re
    if (m) re = new RegExp(m[1].slice(1, -1))
    else { expect(game).toMatch(/import \{[^}]*\bisClaim\b[^}]*\} from '\.\/compose-wish\.js'/); re = /iwashere/ }
    const ref = (t) => re.test(String(t).toLowerCase().replace(/[^a-z]/g, ''))
    for (const t of fixtures) expect(isClaim(t), t).toBe(ref(t))
    expect(isClaim('I was here')).toBe(true)
    expect(isClaim('i-w-a-s h e r e')).toBe(true)
    expect(isClaim('i was not here')).toBe(false)
  })
  it('pins the W2 / W3 values the composer reads', () => {
    expect(LEGACY.presenceReply('wish')).toBe(null)
    expect(LEGACY.presenceReply('claim')).toBe(null)
    expect(LEGACY.wishMeta()).toEqual({ origin: null })
    expect(closingReply(null)).toBe(null)
  })
})

// ── (7) gates ───────────────────────────────────────────────────────────────────────────────────────────────────────
// game.js tryFinale: if (seamHeld || !claimFiled || !beaconFired) return
// game.js B: effect / target / counterClaim; off -> 'no beacon set. register one in settings.'; else the claim line or
//   'you push the beacon into the dark...', fireBeacon({ effect, webhook: getPref('beaconWebhook') }), if (counterClaim) beaconFired
// game.js die(): hp <= 0 -> die() at once
describe('(7) the gates under legacy', () => {
  it('the source still carries the gate and the beacon lines', () => {
    expect(game).toContain('if (seamHeld || !claimFiled || !beaconFired) return')
    expect(game).toContain("showMessage('no beacon set. register one in settings.')")
    expect(game).toContain("? 'you fire the beacon — not a cry for help. a claim. i was here. put it in the file.'")
    expect(game).toContain(": 'you push the beacon into the dark...')")
    expect(game).toContain("const counterClaim = target.includes('extension30150a')")
  })
  it('finaleGate === !seamHeld && claimFiled && beaconFired over the 8 booleans', () => {
    for (const seamHeld of [true, false]) for (const claimFiled of [true, false]) for (const beaconFired of [true, false]) {
      expect(finaleGate({ seamHeld, claimFiled, beaconFired, rules: LEGACY, status: 'notice-mailed', closing: null })).toBe(!seamHeld && claimFiled && beaconFired)
    }
    expect(LEGACY.canHoldSeam).toBe(true)
  })
  it('beaconDecision: off, the counter-claim, a plain push', () => {
    const W = 'https://ntfy.sh/EXTENSION-30150A'
    const off = beaconDecision({ effect: 'off', target: '', rules: LEGACY, status: 'notice-mailed', closing: null, anchor: null, webhook: W })
    expect(off.fire).toBe(false)
    expect(off.lines).toEqual(['no beacon set. register one in settings.'])
    expect(off.payload).toBe(null)
    expect(off.setBeaconFired).toBe(false)
    expect(beaconDecision({ effect: undefined, target: '', rules: LEGACY, status: 'notice-mailed', closing: null, anchor: null, webhook: W }).fire).toBe(false)
    const claim = beaconDecision({ effect: 'pulse', target: 'extension30150a', rules: LEGACY, status: 'notice-mailed', closing: null, anchor: { lat: 1, lng: 2 }, webhook: W })
    expect(claim).toEqual({ fire: true, counterClaim: true, setBeaconFired: true, filesFloor: false,
      lines: ['you fire the beacon — not a cry for help. a claim. i was here. put it in the file.'], payload: { effect: 'pulse', webhook: W } })
    expect('anchor' in claim.payload).toBe(false)
    const push = beaconDecision({ effect: 'pulse', target: 'httpsntfyshsomewhere', rules: LEGACY, status: 'notice-mailed', closing: null, anchor: null, webhook: 'https://ntfy.sh/somewhere' })
    expect(push.lines).toEqual(['you push the beacon into the dark...'])
    expect(push.counterClaim).toBe(false)
    expect(push.setBeaconFired).toBe(false)
    expect(push.fire).toBe(true)
    expect(LEGACY.beacon).toEqual({ carriesPin: false, filesFloor: false, line: null })
  })
  it('deathDecision: solo or no fresh peer, standing -> die with nothing added', () => {
    const want = { die: true, mintThin: false, leashDebt: 0, sanity: 0, regenDelay: 0, line: null }
    expect(deathDecision({ mp: false, peers: 0, downSt: 'ok', rules: LEGACY, filed: false, thin: false, D: 0, timeout: false })).toEqual(want)
    expect(deathDecision({ mp: true, peers: 0, downSt: 'ok', rules: LEGACY, filed: false, thin: false, D: 0, timeout: false })).toEqual(want)
    expect(LEGACY.deathEffects({ filed: false, thin: false, D: 0 })).toEqual({ mintThin: false, leashDebt: 0, line: null })
  })
})
