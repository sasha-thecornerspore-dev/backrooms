// The factions wave, wired into game.js / index.html (the integrator's serial steps; game.js only boots in a page, so these are source
// guards plus the pieces lifted out of game.js and replayed against the real modules). The modules themselves are tested on their own:
// origins-*.test.js (W2), evbus / papercard (W1 / W9), and the later items' own tests. Each step adds its describe here; I15 closes it.
import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { intake, filingLine, identityOut, identityIn, normaliseIntakeCtx } from '../src/renderer/origin-intake.js'
import { rulesFor, LEGACY } from '../src/renderer/origin-rules.js'
import { TENANT_EVENTS, SEALED_CELLS, facingCell, isSealedMaterial, doorLine } from '../src/renderer/origin-tenant.js'
import { floorKey } from '../src/renderer/origin-processed.js'
import { EVENTS } from '../src/renderer/events.js'
import { PRIO } from '../src/renderer/messages.js'
import { NULL_MAP } from '../src/renderer/level-null-map.js'
import { createFixedMap } from '../src/renderer/fixedmap.js'
import { writeSave, readSave } from '../src/renderer/save.js'
import { perceptionFor, AI_CTX_KEYS, AI_CTX_DEFAULTS } from '../src/renderer/compose-perception.js'
import { createStillness, HUNTS_MOVEMENT_LINE } from '../src/renderer/stillness.js'
import { sanityStep, EXHAUSTED_LINE, DISAGREE_LINE } from '../src/renderer/compose-sanity.js'
import { createCompany } from '../src/renderer/rollcall.js'
import { statusMods, depthOf } from '../src/renderer/status.js'
import { closingOverlay } from '../src/renderer/closings.js'
import { standing, placementMods, applyPlacement, EMPTY_STANDING, rollCall } from '../src/renderer/docket.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { polaroidCaption } from '../src/renderer/compose-polaroid.js'
import { radioLine, RADIO_GROUPS } from '../src/renderer/compose-radio.js'
import { wishRoute } from '../src/renderer/compose-wish.js'
import { beaconDecision, NO_BEACON_LINE, CLAIM_LINE, LEGACY_PUSH_LINE } from '../src/renderer/compose-gates.js'
import { inFrame, subjectInFrame, SOUL_RANGE, SUBJECT_RANGE } from '../src/renderer/evidence.js'
import { inViewCone } from '../src/renderer/raycaster.js'
import { HF } from '../src/renderer/gfx-frame.js'
import { loadFile, canFile, STRINGS } from '../src/renderer/status.js'
import { closingLines, NO_STANDING } from '../src/renderer/closings.js'
import { standConditions, standTick, closingProgress, yourFileLines, slipText, STAND_STEADY_LINE } from '../src/renderer/closings.js'
import { npcLines, fileStatus, DAY_MS } from '../src/renderer/status.js'
import { createCard } from '../src/renderer/papercard.js'
import { SCRAPS } from '../src/renderer/scraps.js'
import { OPENED_LINE, RELEASE_LINE, RADIO_KEY_LINE } from '../src/renderer/origin-processed.js'
import { LEGACY_LAST_LINE } from '../src/renderer/origin-rules.js'
import { createDownState, createKneel, DOWN_LINE, WOKEN_LINE, KNEELER_LINE, HANDS_LINE, LIGHT_STAYS_LINE, KNEEL_HINT, WAKE, KNEELER_SANITY, DOWN_BEAT } from '../src/renderer/downed.js'
import { deathDecision, NOBODY_CAME, finaleGate } from '../src/renderer/compose-gates.js'
import { evKinds } from '../src/renderer/rollcall.js'
import { createEvBus } from '../src/net/evbus.js'
import { createRollCall, whistlePitch, bearingLabel, whistleGain, whistlePan, countLine, WHISTLE_COOLDOWN_MS, WHISTLE_NOISE, QUIET_SANITY, SOLO_SANITY, FAR_BONUS, ECHO,
  NO_ANSWER_LINE, ECHO_LINE, UNANSWERED_LINE } from '../src/renderer/rollcall.js'
import { ACTIONS } from '../src/renderer/touch.js'
import { takeKey } from '../src/renderer/input.js'
import { createItemSystem, KEPT } from '../src/renderer/items.js'
import { PHRASES, PHRASE_FRAG, NOTE_NONE, menuFor, cacheKey, parseCacheKey, octOf, arrowFor, isCachePayload, isTakePayload, extraFor, createCacheLedger, NAME_CAP_EXEMPT } from '../src/renderer/caches.js'
import { readText, READ_FOOT, chooseLines } from '../src/renderer/papercard.js'
import { createLevelMemory } from '../src/renderer/levelmem.js'
import { findOpenNear } from '../src/renderer/topology.js'
import { LIT_RANGE, litFriendNear, inCone, wardOutcome, wardLine, litOffLine } from '../src/renderer/lightshare.js'
import { createEvidence, photoOutcome, EVIDENCE_FLOOR, EVIDENCE_LINE, COUNTED_LINE } from '../src/renderer/evidence.js'
import { WARD_TAP } from '../src/renderer/ward.js'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const game = read('../src/renderer/game.js')
const html = read('../src/renderer/index.html')
const sw = read('../src/sw.js')
const build = read('../tools/build-play.sh')
const at = (s, from = 0) => { const k = game.indexOf(s, from); expect(k, s).toBeGreaterThan(0); return k }
const slice = (from, to) => { const a = at(from), b = game.indexOf(to, a); expect(b, to).toBeGreaterThan(a); return game.slice(a, b) }
const count = (re) => (game.match(re) || []).length
const loopAt = game.indexOf('function loop(ts) {')
const buildBody = slice('function buildLevel(index, at = null) {', 'const fader = createFader(')
const travelBody = slice('function travel(way) {', '// die(): death.js resolves it')
const dieBody = slice('function die(d = null) {', '// ── input ──')
const resumeBody = slice('if (resume) {', 'buildLevel(mpClient ? 0 : 4)')
const ORIGIN_FILES = ['origin-intake.js', 'origin-rules.js', 'origin-tenant.js', 'origin-anchored.js', 'origin-processed.js', 'origin-unnamed.js', 'origin-thin.js']

describe('I14a: the scheduler\'s one mutable config, the file, the floor\'s depth', () => {
  it('ONE scheduler reads evConfig (never rebuilt, never bare); retension() is the one writer of its tension', () => {
    expect(game).toMatch(/import \{ createEventScheduler, EVENTS \} from '\.\/events\.js'/)
    expect(at('const evConfig = { events: EVENTS, tension: 0 }')).toBeLessThan(loopAt)
    expect(count(/createEventScheduler\(/g)).toBe(1)
    expect(game).toContain('const eventSched = createEventScheduler({ config: evConfig })')
    expect(game).not.toMatch(/createEventScheduler\(\)/)
    expect(count(/evConfig\.tension = /g)).toBe(1)
    expect(game).toMatch(/function retension\(\) \{ evConfig\.tension = [^\n]*\}/)
  })
  it('`file` is declared once before the loop (the here heartbeat reads its status); the level literal gains nothing, the depth is set after it', () => {
    expect(count(/let file = /g)).toBe(1)
    expect(at('let file = ')).toBeLessThan(loopAt)
    expect(game).toContain('hereObj.status = file.status')
    expect(game).toMatch(/level = \{ index, cfg, cache, grid, bodies, decor, solid, entitySys, gfx, messages \}/)
    expect(buildBody).toMatch(/lastCellIx = NaN[^\n]*\r?\n(\s*\/\/[^\n]*\r?\n)*\s*level\.depth = depthOf\(index\); level\.st = st; level\.amb = ambientMods\(st, bus \? bus\.roomStanding\(\) : null\); retension\(\)/)
  })
})

describe('I14a (W8): the floor\'s file — the placement overlay, the room\'s lean, the tray, the far crosser', () => {
  it('imports the docket by its real names; docket.js is in both offline shells', () => {
    expect(game).toMatch(/import \{ standing, placementMods, applyPlacement, ambientMods, trayLean(, rollCall)? \} from '\.\/docket\.js'/)
    expect(sw).toContain("'/renderer/docket.js'")
    expect(build).toContain("'docket.js'")
    expect(game).not.toMatch(/TODO\(integrate:W8\)/)
  })
  it('the cfg stage: the standing once from base.docket (none on the block), placement, then the closing LAST, between levelConfig and cfg.ways', () => {
    const a = buildBody.indexOf('const cfg   = levelConfig(base, index)'), w = buildBody.indexOf('cfg.ways    = waysFor(index)')
    const s = buildBody.indexOf('const st = standing(base.docket, cfg.map ? null : depthOf(index))')
    const p = buildBody.indexOf('applyPlacement(cfg, placementMods(st))')
    const c = buildBody.indexOf('if (closingOverlay(file.closing).scrapsDenom === 0) cfg.scraps = { ...cfg.scraps, denom: 0 }')
    for (const k of [a, s, p, c, w]) expect(k).toBeGreaterThan(0)
    expect(a).toBeLessThan(s); expect(s).toBeLessThan(p); expect(p).toBeLessThan(c); expect(c).toBeLessThan(w)
    expect(count(/applyPlacement\(/g)).toBe(1)
    expect(count(/standing\(base\.docket/g)).toBe(1)
  })
  it('the cfg stage, lifted and replayed: a zero docket and an open file leave every floor\'s cfg as it was; a lean moves the denoms; compliance takes the pages', () => {
    const lines = buildBody.slice(buildBody.indexOf('const st = standing('), buildBody.indexOf('cfg.ways    = waysFor(index)'))
    const stage = new Function('base', 'index', 'file', 'levelConfig', 'standing', 'placementMods', 'applyPlacement', 'closingOverlay', 'depthOf',
      `const cfg = levelConfig(base, index)\n${lines}\nreturn { cfg, st }`)
    const run = (base, index, file) => stage(base, index, file, levelConfig, standing, placementMods, applyPlacement, closingOverlay, depthOf)
    const open = { status: 'notice-mailed', closing: null }
    for (let i = 0; i <= 4; i++) {
      const { cfg, st } = run(DEFAULT_CONFIG, i, open)
      expect(cfg, String(i)).toEqual(levelConfig(DEFAULT_CONFIG, i))
      expect(st.lead).toBe(null)
      if (i === 4) expect(st).toBe(EMPTY_STANDING)                                    // the block has no file of its own
    }
    const leaning = { ...DEFAULT_CONFIG, docket: { ...DEFAULT_CONFIG.docket, '2': { extension: 0, compliance: 9, litigation: 1 } } }
    const two = run(leaning, 2, open)
    expect(two.st.lead).toBe('compliance')
    expect(two.cfg.scraps.denom).toBeGreaterThan(levelConfig(leaning, 2).scraps.denom)
    expect(run(leaning, 1, open).cfg).toEqual(levelConfig(leaning, 1))                  // the lean is that floor's only
    expect(run(leaning, 2, { status: 'compliance', closing: 'compliance' }).cfg.scraps.denom).toBe(0)
  })
  it('the room\'s lean is re-read on its change (once registered), the crosser\'s thinness and the tray read the floor', () => {
    expect(count(/bus\.onRoomChange\(/g)).toBe(1)
    expect(game).toContain('bus.onRoomChange(() => { if (level) { level.amb = ambientMods(level.st, bus.roomStanding()); retension() } })')
    const cross = slice('function spawnCrosser() {', 'function fireEvent(')
    expect(cross).toContain('const faint = (dfloor === 2 || dfloor === 3) && Math.random() < level.amb.thinChance')
    expect(cross).not.toContain('Math.random() < 0.3')
    const vend = slice('function dispenseFromMachine(m) {', '// ── snapshot + persistence')
    expect(vend).toMatch(/const lean = trayLean\(level\.st\)\r?\n\s*if \(lean\.item\) pool\.push\(lean\.item, lean\.item\)\r?\n\s*const type = pool\[/)
    expect(vend).toContain("drops into the tray.${lean.stamp ? ` the tray is stamped ${lean.stamp}.` : ''}`")
    expect(count(/trayLean\(/g)).toBe(1)
  })
})

describe('I5: the file (origin-*.js) in game.js', () => {
  it('imports the origin modules by their real names; initGame takes the intake ctx', () => {
    expect(game).toMatch(/import \{ intake, filingLine, formText, FORM_FOOT, parseIntakeCommand, normaliseIntakeCtx, identityOut, identityIn \} from '\.\/origin-intake\.js'/)
    expect(game).toMatch(/import \{ rulesFor, LEGACY \} from '\.\/origin-rules\.js'/)
    expect(game).toMatch(/import \{ DOOR_SANITY, isSealedMaterial, doorLine, facingCell \} from '\.\/origin-tenant\.js'/)
    expect(game).toMatch(/import \{ MERCY_LINE, leashDebtStep \} from '\.\/origin-anchored\.js'/)
    expect(game).toMatch(/import \{ floorKey \} from '\.\/origin-processed\.js'/)
    // (the naming wish itself is read by the wish router since I8: compose-wish.js wishRoute -> kind 'name')
    expect(game).toMatch(/import \{ spellCard, refileWithName, spelledLine, ONLINE_LINE \} from '\.\/origin-unnamed\.js'/)
    expect(game).not.toMatch(/parseNameWish/)
    expect(game).toMatch(/import \{ RECOIL_DIST, RECOIL_SHAKE, RECOIL_LINE, CURE_LINE \} from '\.\/origin-thin\.js'/)
    expect(game).toMatch(/export async function initGame\(canvas, \{ worldSeed = null, mpClient = null, anchor = null, resume = null, intakeCtx = null \} = \{\}\) \{/)
    expect(game).not.toMatch(/TODO\(integrate:W2\)/)
  })
  it('the state is declared once, before the loop; rules starts LEGACY and is only ever reassigned through rulesFor', () => {
    for (const s of ['let origin = null, thin = false, filed = false, filedFloors = new Set(), leashDebt = 0, leashCalm = 0', 'let rules = LEGACY',
      "intakeCtx = normaliseIntakeCtx(intakeCtx, { route: 'solo', arrival: null, anchor, name: '' })", 'const doorsSaid = new Set()',
      'const provisionalOrigin = () => filed ? origin : intake(intakeCtx)']) {
      expect(at(s)).toBeLessThan(loopAt)
      expect(game.split(s).length - 1, s).toBe(1)
    }
    // every write of `rules`: the filing, the ballast cure, the naming re-file, the claim's re-file (I8), the resume, a death's minted layer (I9)
    expect(count(/(?<![.\w])rules = (?!LEGACY)/g)).toBe(count(/(?<![.\w])rules = rulesFor\(/g))
    expect(count(/(?<![.\w])rules = rulesFor\(/g)).toBe(6)
  })
  it('driftD() is the ONE drift helper: declared once, the only driftMeters( call, read by the HUD and the leash row', () => {
    expect(count(/const driftD = /g)).toBe(1)
    expect(game).toContain('const driftD = () => anchor ? Math.round(driftMeters(player.x, player.y, spawnX, spawnY) + leashDebt) : 0')
    expect(count(/driftMeters\(/g)).toBe(1)
    const hud = game.slice(at('function updateHud() {'), at('// ── HP bar ──'))
    expect(hud).toContain('if (anchor) text += `   ·   drift ${driftD()}m`')
    expect(hud).toContain('const lt = rules.leash ? `leash ${driftD()} m` : \'\'')
    expect(hud).toContain('if (leashEl && lt !== leashText) { leashText = lt; leashEl.textContent = lt }')
  })
  it('the first travel of a run files you, under the fade right after buildLevel: the arrival, the column, the layer, the rules, the weights, the room, the line', () => {
    const b = travelBody.indexOf('buildLevel(way.target, fromC)'), f = travelBody.indexOf('if (!filed) {')
    expect(b).toBeGreaterThan(0); expect(f).toBeGreaterThan(b)
    expect(f).toBeLessThan(travelBody.indexOf('const partner = '))
    expect(travelBody).toMatch(/if \(!filed\) \{\r?\n\s*intakeCtx\.arrival = mpClient \? mpClient\.arrival\(\) : 'walked'\r?\n\s*filed = true; origin = intake\(intakeCtx\); thin = intakeCtx\.arrival === 'dropped'; rules = rulesFor\(origin, thin\)\r?\n\s*evConfig\.events = rules\.eventWeights\(\)\r?\n\s*bus\?\.here\(hereFields\(\)\)\r?\n\s*later\(7600, filingLine\(origin, thin\), PRIO\.discovery\)/)
    expect(count(/if \(!filed\) \{/g)).toBe(1)
    // the anchored mercy, once per descent, after the arrival ladder and before the room hears the new floor
    const mercy = travelBody.indexOf("if (origin === 'anchored') later(9500, MERCY_LINE, PRIO.discovery)")
    expect(mercy).toBeGreaterThan(travelBody.indexOf("later(11000, 'the floor remembers you less.', PRIO.discovery)"))
    expect(mercy).toBeLessThan(travelBody.lastIndexOf('bus?.here(hereFields())'))
  })
  it('the filing block, lifted from game.js and replayed: solo files a tenant once, a dropped-in online player files thin, a walked-in opener files processed', () => {
    const body = travelBody.match(/if \(!filed\) \{\r?\n([\s\S]*?)\r?\n\s*\}\r?\n/)[1]
    const run = (filed0, ctx, mpClient) => {
      const evConfig = { events: EVENTS, tension: 0 }, said = [], heard = []
      const fn = new Function('intake', 'rulesFor', 'filingLine', 'PRIO', 'mpClient', 'evConfig', 'bus', 'hereFields', 'later', 'intakeCtx',
        `let filed = ${filed0}, origin = null, thin = false, rules = null\nif (!filed) {\n${body}\n}\nreturn { filed, origin, thin, rules }`)
      const out = fn(intake, rulesFor, filingLine, PRIO, mpClient, evConfig, { here: (h) => heard.push(h) }, () => 'here', (ms, t, p) => said.push([ms, t, p]), ctx)
      return { ...out, evConfig, said, heard, ctx }
    }
    const solo = run(false, { route: 'solo', arrival: null, anchor: null, name: 'ada' }, null)
    expect([solo.filed, solo.origin, solo.thin]).toEqual([true, 'tenant', false])
    expect(solo.ctx.arrival).toBe('walked')
    expect(solo.rules).toBe(rulesFor('tenant', false))
    expect(solo.evConfig.events).toBe(TENANT_EVENTS)
    expect(solo.said).toEqual([[7600, 'the file has you now.', PRIO.discovery]])
    const dropped = run(false, { route: 'online', arrival: null, anchor: null, name: 'jo' }, { arrival: () => 'dropped' })
    expect([dropped.origin, dropped.thin]).toEqual(['tenant', true])
    expect(dropped.said[0][1]).toBe('the file has you now. you dropped in. not all of you arrived.')
    expect(dropped.heard).toEqual(['here'])
    const opener = run(false, { route: 'host', arrival: null, anchor: null, name: '' }, { arrival: () => 'walked' })
    expect(opener.origin).toBe('processed')
    expect(opener.evConfig.events).toBe(EVENTS)
    const again = run(true, { route: 'solo', arrival: null, anchor: null, name: 'ada' }, null)
    expect([again.origin, again.said.length]).toEqual([null, 0])                       // filed once per run
  })
  it('the save ADDS the identity after the fog; the resume reads it ABOVE the clock (applyResume\'s buildLevel reads filedFloors), with the weights', () => {
    const snap = slice('function snapshot(full = false) {', 'let saveTimer = 0')
    expect(snap).toMatch(/s\.fog = fogExport\r?\n(\s*\/\/[^\n]*\r?\n)*\s*Object\.assign\(s, identityOut\(\{ origin, thin, filed, intakeCtx, filedFloors \}\)\)/)
    expect(resumeBody).toMatch(/;\(\{ origin, thin, filed, intakeCtx, filedFloors \} = identityIn\(resume, intakeCtx\)\)\r?\n\s*rules = rulesFor\(origin, thin\); evConfig\.events = rules\.eventWeights\(\)/)
    expect(resumeBody.indexOf('identityIn(resume, intakeCtx)')).toBeLessThan(resumeBody.indexOf('playT = Number(resume.playT) || 0'))
    expect(resumeBody).toMatch(/playT = Number\(resume\.playT\) \|\| 0\r?\n\s*const r = applyResume\(resume, \{/)
  })
  describe('the identity through save.js, the way game.js writes and reads it', () => {
    afterEach(() => vi.unstubAllGlobals())
    const stub = () => {
      const store = new Map()
      vi.stubGlobal('localStorage', { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) })
    }
    const title = { route: 'solo', arrival: null, anchor: null, name: 'ada' }                   // index.html's intakeFor('solo', null)
    const boot = (ctx) => normaliseIntakeCtx(ctx, { route: 'solo', arrival: null, anchor: null, name: '' })
    it('a v:1 save without the fields resumes unfiled, LEGACY, an empty Set, on the title screen\'s form', () => {
      stub()
      writeSave({ level: 1, x: 2.5, y: 2.5, playT: 40 })
      const s = readSave()
      const ctx = boot(title)
      const id = identityIn(s, ctx)
      expect([id.origin, id.thin, id.filed]).toEqual([null, false, false])
      expect(id.intakeCtx).toBe(ctx)
      expect(id.filedFloors).toEqual(new Set())
      expect(rulesFor(id.origin, id.thin)).toBe(LEGACY)
    })
    it('a filed run round-trips: the column, the layer, the form, the filed floors (and the vend rule reads them)', () => {
      stub()
      const state = { origin: 'processed', thin: true, filed: true, intakeCtx: { route: 'online', arrival: 'walked', anchor: null, name: 'ada' }, filedFloors: new Set([floorKey(7, 2)]) }
      const s = { level: 2, x: 3.5, y: 3.5, fog: null }
      Object.assign(s, identityOut(state))
      writeSave(s)
      const id = identityIn(readSave(), boot(title))
      expect(id).toEqual(state)
      expect(id.filedFloors.has(floorKey(7, 2))).toBe(true)
      expect(rulesFor(id.origin, id.thin)).toBe(rulesFor('processed', true))
    })
  })
  it('a filed floor never restocks: buildLevel, travel and die read the vend memory with -Infinity for it', () => {
    expect(buildBody).toContain('vendedSet = mem.vendedFor(index, filedFloors.has(floorKey(worldSeed, index)) ? -Infinity : playT)')
    for (const b of [travelBody, dieBody]) expect(b).toContain('vendedSet = mem.vendedFor(level.index, filedFloors.has(floorKey(worldSeed, level.index)) ? -Infinity : playT)')
    expect(game).not.toMatch(/mem\.vendedFor\([^\n]*, playT\)/)
  })
  it('the rule hooks: the grab, the hit, a page, sweet and sour water, the thing\'s own reading, the cure, the map, the crosser', () => {
    expect(game).toContain('const nearExit = level.decor.nearestWay(player.x, player.y, rules.exitGrab)')
    expect(game).toMatch(/player\.hp -= th\.dmg \* rules\.damageMul; invuln = 0\.7/)
    expect(game.slice(at('function revealScrap() {'), at('function redactScrap() {'))).toContain('sanity = Math.min(100, sanity + rules.scrapSanity)')
    expect(game).toContain('sanity = Math.min(100, sanity + rules.sweetWater)')
    const fx = slice('function applyItemEffect(eff) {', "} else if (eff.type === 'glowstick') {")
    expect(fx).toMatch(/const r = rules\.itemEffect\(eff, dfloor\)\r?\n\s*if \(r && !r\.legacy\) \{/)
    expect(fx.indexOf('rules.itemEffect(eff, dfloor)')).toBeLessThan(fx.indexOf("if (eff.type === 'almond-water')"))
    expect(fx).toMatch(/if \(eff\.sour\) \{\r?\n\s*level\.entitySys\.noise\(player\.x, player\.y, 6\)[^\n]*\r?\n(\s*\/\/[^\n]*\r?\n)*\s*const sw = rules\.sourWater\(dfloor\)/)
    expect(fx).toMatch(/\} else if \(dfloor === 3\) \{/)
    const ballast = slice("} else if (eff.type === 'ballast') {", "} else if (eff.type === 'extension-slip') {")
    expect(ballast).toContain('if (thin) { thin = false; rules = rulesFor(origin, false); setTimeout(() => showMessage(CURE_LINE, PRIO.discovery), 2600); bus?.here(hereFields()) }')
    const pin = slice('function pinSeen(reach) {', 'const entityAsm = createEntityAssembler()')
    expect(pin).toMatch(/if \(rules\.wayReveal === 'loaded'\) \{ const ex = level\.decor\.getExits\(\); for \(let i = 0; i < ex\.length; i\+\+\) fog\.pinWay\(L, ex\[i\], epochOf\(/)
    const cross = slice('function spawnCrosser() {', 'function fireEvent(')
    expect(cross).toContain('if (faint && rules.crosserPause()) { a.pauseAtTtl = a.ttl / 2; a.pauseT = 0; a.paused = false }')
    expect(game).toMatch(/if \(a\.pauseT > 0\) \{ a\.pauseT -= dt; continue \}/)
    expect(game).toContain('if (cp) { a.pauseT = cp.pause; sanity = Math.min(100, sanity + cp.sanity); showMessage(cp.line, PRIO.discovery) }')
  })
  it('the thin ward recoils you along your own facing through the mover, marched under a cell a step, and says so', () => {
    const block = game.slice(at('let verbMul = 1'), at('let moved = false'))
    expect(block).toMatch(/sanity = Math\.min\(100, sanity \+ 10 \* res\.dispelled\)\r?\n(\s*\/\/[^\n]*\r?\n)*\s*if \(rules\.wardRecoil && res\.hit > 0\) \{\r?\n\s*for \(let i = 0; i < RECOIL_STEPS; i\+\+\) tryMove\(player\.x - Math\.cos\(player\.angle\) \* \(RECOIL_DIST \/ RECOIL_STEPS\), player\.y - Math\.sin\(player\.angle\) \* \(RECOIL_DIST \/ RECOIL_STEPS\)\)\r?\n\s*shake = Math\.max\(shake, RECOIL_SHAKE\)/)
    expect(game).toMatch(/const RECOIL_STEPS = 4\b/)
    expect(1.7 / 4).toBeLessThan(1)                                   // a step never clears a whole wall cell
    expect(block).toContain("rules.wardRecoil ? 'they recoil from you. so do you.' : 'they recoil from you.'")
  })
  it('the leash: the calm and the debt run down each frame beside the quiet timer', () => {
    expect(game).toMatch(/if \(quietTimer > 0\) quietTimer -= dt\r?\n(\s*\/\/[^\n]*\r?\n)*\s*if \(leashCalm > 0\) leashCalm -= dt\r?\n\s*leashDebt = leashDebtStep\(leashDebt, dt\)/)
  })
  it('the here heartbeat says the column and the layer', () => {
    const body = slice('function hereFields() {', 'return hereObj')
    expect(body).toContain('hereObj.o = origin')
    expect(body).toContain('hereObj.thin = thin')
  })
})

describe('I5: the form, the doors, the soul, the console, the naming', () => {
  it('E: the presence, else the form (or a page), else ∅\'s sealed door ahead for a tenant-to-be, else the soul (the processed refusal first)', () => {
    const e = slice("if (K['KeyE']) {", "if (K['Escape'] && dialogOpen)")
    // (I13: the page opens sealed under compliance until it is read or given up)
    const order = ['if (nearPresence) openDialog()', 'else if (nearScrap) nearScrap.form ? openForm() : mods.sealedCards && !readSet.has(nearScrap.frag) ? openSealed(nearScrap) : openNoteCard(nearScrap)',
      'else if (door) knockDoor(door)', 'else if (nearNpc) {'].map((s) => e.indexOf(s))
    for (let i = 0; i < order.length; i++) expect(order[i], String(i)).toBeGreaterThan(i ? order[i - 1] : 0)
    expect(e).toContain("const door = cfg.map && !nearPresence && !nearScrap && provisionalOrigin() === 'tenant' ? doorAhead() : null")
    expect(e).toMatch(/const r = rules\.npcLine\(\)[^\n]*\r?\n\s*if \(r\) \{ showMessage\(r\.text\); sanity = Math\.max\(0, Math\.min\(100, sanity \+ r\.sanity\)\) \}/)
    expect(game).toContain("itemHintEl.textContent = nearScrap.form ? 'e · read the form' : 'e · read the scrap'")
  })
  it('the form card: the form text from the intake ctx and the file\'s status; the doors read the FIXED map only, +3 once a door', () => {
    expect(game).toContain("function openForm() { openCard('form', { text: formText(intakeCtx, file.status).join('\\n'), foot: FORM_FOOT }) }")
    const door = slice('function doorAhead() {', '// ── the map card (mapcard.js)')
    expect(door).toContain('const c = facingCell(player, 1.2)')
    expect(door).toContain('return isSealedMaterial(level.cache.materialAt(c.ix + 0.5, c.iy + 0.5)) ? c : null')
    expect(door).toContain('showMessage(doorLine(c.ix, c.iy), PRIO.discovery)')
    expect(door).toContain('if (!doorsSaid.has(k)) { doorsSaid.add(k); sanity = Math.min(100, sanity + DOOR_SANITY) }')
  })
  it('every one of the block\'s 28 sealed doors can be knocked on: an open cell beside it, facing it, reaches it at arm\'s length', () => {
    const map = createFixedMap(NULL_MAP)
    expect(SEALED_CELLS.length).toBe(28)
    for (const [ix, iy] of SEALED_CELLS) {
      let ok = false
      for (const [dx, dy, a] of [[0, 1, -Math.PI / 2], [0, -1, Math.PI / 2], [1, 0, Math.PI], [-1, 0, 0]]) {
        if (map.isWall(ix + dx + 0.5, iy + dy + 0.5)) continue
        const c = facingCell({ x: ix + dx + 0.5, y: iy + dy + 0.5, angle: a }, 1.2)
        if (c.ix === ix && c.iy === iy && isSealedMaterial(map.materialAt(c.ix + 0.5, c.iy + 0.5)) && doorLine(c.ix, c.iy)) ok = true
      }
      expect(ok, `${ix},${iy}`).toBe(true)
    }
  })
  it('/intake re-opens the form or refuses an amendment; the fallback names it', () => {
    const cmd = slice('async function handleCommand(t) {', '// desktop: a fetch that never reached the site')
    expect(cmd).toMatch(/\} else if \(cmd === 'intake'\) \{\r?\n(\s*\/\/[^\n]*\r?\n)*\s*const r = parseIntakeCommand\(arg\)\r?\n\s*if \(r\.refuse\) showMessage\(r\.refuse\)\r?\n\s*else openForm\(\)/)
    expect(cmd).toContain("showMessage('the file does not recognise that. try /recover, /cases, /file <answer>, /intake or /status.')")   // (the ONE string, I13)
  })
  it('the naming re-file: an unnamed player\'s naming wish closes the dialog and asks how it is spelled; only a confirm files the name', () => {
    const fn = slice('function refileName(name) {', "document.getElementById('wish-cancel')")
    expect(fn).toMatch(/closeDialog\(\); if \(wishText\) wishText\.disabled = false; const sub = document\.getElementById\('wish-submit'\); if \(sub\) sub\.disabled = false/)
    expect(fn).toMatch(/openCard\('confirm', \{ \.\.\.spellCard\(name\), onConfirm: \(\) => \{\r?\n\s*intakeCtx = refileWithName\(intakeCtx, name\); origin = intake\(intakeCtx\); rules = rulesFor\(origin, thin\)\r?\n\s*evConfig\.events = rules\.eventWeights\(\)[^\n]*\r?\n\s*setPref\('playerName', name\)\r?\n\s*showMessage\(spelledLine\(name, origin\), PRIO\.discovery\)/)
    expect(fn).toContain('if (mpClient) setTimeout(() => showMessage(ONLINE_LINE, PRIO.discovery), 2600)')
    // the router reads the naming wish (I8: compose-wish.js wishRoute, the unnamed only); the handler re-files before anything is disabled or sent
    const submit = slice("document.getElementById('wish-submit')?.addEventListener('click', async () => {", "if (wishResp) wishResp.textContent = r.reply ?? ''")
    expect(submit).toMatch(/const r = wishRoute\(\{ text, origin, rules, file, canFile: fileable\(\), now: Date\.now\(\), depth: level\.depth \}\)\r?\n\s*if \(r\.kind === 'name'\) \{ refileName\(r\.name\); return \}/)
    // the confirm card's foot is its prompt: the put-it-back hint steps aside and the foot keeps its gap
    expect(game).toContain("noteHintEl.style.display = lines.length || s.mode === 'confirm' ? 'none' : ''")
    // a cache's word is read with the thing already in your hands: the hint folds the card away, it does not put anything back
    expect(game).toContain("noteHintEl.textContent = s.mode === 'read' ? 'tap · e · esc — fold it away' : 'tap · e · esc — put it back'")
    expect(html).toMatch(/#note-foot \{[^}]*white-space: pre-wrap;/)
    expect(fn).toContain('document.activeElement?.blur?.()')
  })
  it('every write of origin (outside the resume\'s identityIn) re-points the scheduler at the new column\'s weights, on that line or the next', () => {
    const lines = game.split(/\r?\n/)
    const writes = []
    for (let i = 0; i < lines.length; i++) if (/(^\s*|[;{]\s*)origin = (?!null\b)/.test(lines[i].replace(/\/\/.*$/, ''))) writes.push(i)
    expect(writes.length).toBe(3)                                             // the filing, the naming re-file, the claim's re-file
    for (const i of writes) expect(lines[i] + '\n' + lines[i + 1], lines[i]).toContain('evConfig.events = rules.eventWeights()')
    expect(game).toMatch(/\(\{ origin, thin, filed, intakeCtx, filedFloors \} = identityIn\(resume, intakeCtx\)\)\r?\n\s*rules = rulesFor\(origin, thin\); evConfig\.events = rules\.eventWeights\(\)/)
  })
})

describe('I5: index.html — the form\'s facts on the four start paths, the leash row, the console', () => {
  it('intakeFor builds { route, arrival: null, anchor, name } from the title screen; getName is declared above it', () => {
    expect(html).toContain('const intakeFor = (route, anchor) => ({ route, arrival: null, anchor: anchor || null, name: getName() })')
    expect(html.indexOf('const getName = ')).toBeLessThan(html.indexOf('const intakeFor = '))
    expect(html.indexOf('const intakeFor = ')).toBeLessThan(html.indexOf('async function startSolo()'))
  })
  it('solo, the relay, JOIN LAN, HOST LAN (host only when this app started the server) and CONTINUE each hand initGame an intake ctx', () => {
    const solo = html.slice(html.indexOf('async function startSolo()'), html.indexOf('// one connection attempt at a time'))
    expect(solo).toContain("const intakeCtx = intakeFor('solo', anchor)")
    expect(solo).toMatch(/\{ worldSeed: anchorSeed\(anchor\.lat, anchor\.lng\), anchor, intakeCtx \}\r?\n\s*: \{ intakeCtx \}/)
    expect(html).toContain("async function startMultiplayer(serverUrl, roomId, statusEl, route = 'lan') {")
    expect(html).toContain('await initGame(canvas, { worldSeed, mpClient, anchor, intakeCtx: intakeFor(route, anchor) })')
    expect(html).toContain("await startMultiplayer(`ws://localhost:${port}`, room, startStatus, r ? 'host' : 'lan')")
    expect(html).toContain("startMultiplayer(url, room, null, 'lan')")
    expect(html).toMatch(/startMultiplayer\(`\$\{RELAY_URL\}\/\?room=\$\{encodeURIComponent\(code\)\}`, code, document\.getElementById\('online-status'\), 'online'\)/)
    expect(html).toContain("const intakeCtx = savedRun.intakeCtx && typeof savedRun.intakeCtx === 'object' ? savedRun.intakeCtx : intakeFor('solo', anchor)")
    expect(html).toContain('await initGame(canvas, { worldSeed: savedRun.worldSeed ?? null, anchor, resume: savedRun, intakeCtx })')
  })
  it('the locate row carries the leash line; the console placeholder names /intake', () => {
    expect(html).toMatch(/<button id="btn-locate"[^\n]*\r?\n\s*<div id="leash-line" class="set-hint"[^>]*><\/div>/)
    expect(html).toContain('/recover · /cases · /file … · /intake · /status)')   // (I13: /status landed)
  })
})

describe('I5: the offline shell lists carry the seven origin modules', () => {
  for (const f of ORIGIN_FILES) {
    it(`${f} is in src/sw.js and tools/build-play.sh`, () => {
      expect(sw).toContain(`'/renderer/${f}'`)
      expect(build).toContain(`'${f}'`)
    })
  }
})

describe('I6: the file\'s reading of you, as the things perceive it (compose-perception.js, stillness.js)', () => {
  const loop = game.slice(loopAt)
  it('imports perceptionFor and the stillness clock by their real names', () => {
    expect(game).toMatch(/import \{ perceptionFor \} from '\.\/compose-perception\.js'/)
    expect(game).toMatch(/import \{ createStillness, HUNTS_MOVEMENT_LINE \} from '\.\/stillness\.js'/)
  })
  it('ONE aiCtx with the fifteen keys, the file\'s four trailing at their defaults', () => {
    const fields = game.match(/const aiCtx = \{ ([^}]*) \}/)[1].split(',').map((f) => f.trim())
    expect(fields.map((f) => f.split(':')[0].trim())).toEqual([...AI_CTX_KEYS])
    expect(fields.slice(11)).toEqual(Object.entries(AI_CTX_DEFAULTS).map(([k, v]) => `${k}: ${v}`))
  })
  it('one perCtx before the loop; perceptionFor once a frame, after the aiCtx writes and before the footsteps and the update; four numbers copied, never the object', () => {
    expect(count(/const perCtx = /g)).toBe(1)
    expect(at('const perCtx = { rules, depth: 0, stillFor: 0, noiseFor: 0, flashlight, radioOn: false, litNear: false }')).toBeLessThan(loopAt)
    expect(count(/perceptionFor\(/g)).toBe(1)
    const call = at('const pf = perceptionFor(perCtx)')
    expect(call).toBeGreaterThan(at('aiCtx.radioOn = itemSys.isRadioOn(); aiCtx.t = playT;'))
    expect(call).toBeLessThan(at('if (footstep && creaturesLive) level.entitySys.noise('))
    expect(call).toBeLessThan(at('const th = creaturesOn ? level.entitySys.update('))
    expect(loop).toContain('perCtx.rules = rules; perCtx.depth = level.depth; perCtx.stillFor = stillness.stillFor(playT); perCtx.noiseFor = stillness.noiseFor(playT)')
    expect(loop).toContain('perCtx.flashlight = flashlight; perCtx.radioOn = aiCtx.radioOn; perCtx.litNear = litNear')   // the carried radio, as the things read it
    expect(loop).toContain('aiCtx.sightMul = pf.sightMul; aiCtx.hidden = pf.hidden; aiCtx.loseTrackMul = pf.loseTrackMul; aiCtx.noiseMul = pf.noiseMul')
    expect(game).not.toMatch(/= pf(?![.\w])/)                            // the reused result is read, never kept
    expect(count(/let litNear = /g)).toBe(1)
    expect(at('let litNear = false')).toBeLessThan(loopAt)
  })
  it('the stillness clock: one, on the play clock, noted right after the step through one reused report; your ward and a sprint are sounds', () => {
    expect(count(/createStillness\(/g)).toBe(1)
    expect(at('const stillness = createStillness({ now: () => playT })')).toBeLessThan(loopAt)
    expect(at('const stillNote = { moving: false, flashlight: true, radioOn: false, t: 0 }')).toBeLessThan(loopAt)
    expect(loop).toMatch(/player\.moving = moved\r?\n(\s*\/\/[^\n]*\r?\n)*\s*stillNote\.moving = moved; stillNote\.flashlight = flashlight; stillNote\.radioOn = radioWasOn; stillNote\.t = playT\r?\n\s*stillness\.note\(stillNote\)\r?\n\s*if \(moved && wantSprint\) stillness\.noise\(playT\)/)
    expect(game).not.toMatch(/stillness\.note\(\{/)                     // no literal per frame
    const ward = game.slice(at('let verbMul = 1'), at('let moved = false'))
    expect(ward).toMatch(/level\.entitySys\.noise\(player\.x, player\.y, 12\)[^\n]*\r?\n\s*stillness\.noise\(playT\); standHeld = 0/)
    for (const m of game.matchAll(/stillness\.noise\(([^)]*)\)/g)) expect(m[1]).toBe('playT')   // the play clock, never performance.now()
    const lure = slice('lureNoiseT += dt', '// ── presence proximity')
    expect(lure).not.toContain('stillness.')
  })
  it('the lure and a friend\'s relayed ward (I12) are the two tagged noises; every other noise call keeps three arguments and is yours', () => {
    expect(game).toContain("level.entitySys.noise(lures[i].x, lures[i].y, 8, 'lure')")
    expect(game).toContain("level.entitySys.noise(p.x, p.y, 10, 'friend')")
    expect([...game.matchAll(/entitySys\.noise\([^\n]*?, '(\w+)'\)/g)].map((m) => m[1]).sort()).toEqual(['friend', 'lure'])
  })
  it('\'it hunts movement.\' once a run: the first frame it hides you with a thing within 12 (last frame\'s record), never during a stand', () => {
    expect(at('let wasHidden = false, huntsMovementSaid = false')).toBeLessThan(loopAt)
    expect(loop).toMatch(/if \(pf\.hidden && !wasHidden && !huntsMovementSaid && thA\.nearest < 12 && standHeld <= 0\) \{ huntsMovementSaid = true; showMessage\(HUNTS_MOVEMENT_LINE, PRIO\.discovery\) \}\r?\n\s*wasHidden = pf\.hidden/)
    expect(HUNTS_MOVEMENT_LINE).toBe('it hunts movement. you remember that now.')
  })
  it('the perception block, lifted from game.js and replayed: LEGACY never moves the four; a filed player still, silent and unlit is hidden; thin hides in 0.6 s, light on', () => {
    const block = slice('perCtx.rules = rules;', '// footsteps: walk 3 / sprint 7')
    const fn = new Function('perCtx', 'aiCtx', 'st', 'perceptionFor', 'stillness', 'level', 'HUNTS_MOVEMENT_LINE', 'PRIO', 'showMessage',
      `let { rules, playT, flashlight, litNear, thA, standHeld, wasHidden, huntsMovementSaid } = st\n${block}\nst.wasHidden = wasHidden; st.huntsMovementSaid = huntsMovementSaid`)
    let t = 0
    const clock = createStillness({ now: () => t })
    const aiCtx = { radioOn: false, ...AI_CTX_DEFAULTS }
    const perCtx = { rules: LEGACY, depth: 0, stillFor: 0, noiseFor: 0, flashlight: true, radioOn: false, litNear: false }
    const said = []
    const st = { rules: LEGACY, playT: 0, flashlight: false, litNear: false, thA: { nearest: 5 }, standHeld: 0, wasHidden: false, huntsMovementSaid: false }
    const four = () => ({ sightMul: aiCtx.sightMul, hidden: aiCtx.hidden, loseTrackMul: aiCtx.loseTrackMul, noiseMul: aiCtx.noiseMul })
    const step = (s) => { t = s; st.playT = s; fn(perCtx, aiCtx, st, perceptionFor, clock, { depth: 1 }, HUNTS_MOVEMENT_LINE, PRIO, (m, p) => said.push([m, p])) }
    clock.note({ moving: true, t: 0 })
    for (let s = 0; s <= 10; s += 0.5) { step(s); expect(four()).toEqual(AI_CTX_DEFAULTS) }   // unfiled: today's things, however still
    expect(said).toEqual([])
    st.rules = rulesFor('tenant', false); clock.note({ moving: true, t: 10 })
    step(11); expect(aiCtx.hidden).toBe(false)
    step(12); expect(aiCtx.hidden).toBe(true)                            // two still, silent seconds, the light and the radio off
    expect(said).toEqual([[HUNTS_MOVEMENT_LINE, PRIO.discovery]])
    st.flashlight = true; step(12.5); expect(aiCtx.hidden).toBe(false)
    st.flashlight = false; step(13); expect(aiCtx.hidden).toBe(true)
    clock.noise(13); step(13.5); expect(aiCtx.hidden).toBe(false)        // a sound you made: seen again
    expect(said.length).toBe(1)                                          // once a run
    st.rules = rulesFor('tenant', true); st.flashlight = true; clock.note({ moving: true, t: 20 })
    step(20.5); expect(aiCtx.hidden).toBe(false)
    step(20.7); expect(aiCtx.hidden).toBe(true); expect(aiCtx.noiseMul).toBe(0.5)   // thin: 0.6 s, whatever the light
    // a fresh run: nothing within 12, or a stand running, says nothing
    for (const [nearest, standHeld] of [[20, 0], [5, 3]]) {
      Object.assign(st, { rules: rulesFor('tenant', false), flashlight: false, thA: { nearest }, standHeld, wasHidden: false, huntsMovementSaid: false })
      said.length = 0; clock.note({ moving: true, t: 30 }); step(33)
      expect(aiCtx.hidden).toBe(true); expect(said).toEqual([])
    }
  })
})

describe('I7: the one sanity step (compose-sanity.js)', () => {
  const loop = game.slice(loopAt)
  const block = slice('sanCtx.rules = rules;', 'updateSanity()')
  it('imports the step, the company pool, the status mods and the closing overlay by their real names', () => {
    expect(game).toMatch(/import \{ sanityStep, EXHAUSTED_LINE, DISAGREE_LINE \} from '\.\/compose-sanity\.js'/)
    // (each module's import line grows as later steps wire more of it: the name is pinned to its module)
    expect(game).toMatch(/import \{[^}]*\bcreateCompany\b[^}]*\} from '\.\/rollcall\.js'/)
    expect(game).toMatch(/import \{[^}]*\bstatusMods\b[^}]*\} from '\.\/status\.js'/)
    expect(game).toMatch(/import \{[^}]*\bclosingOverlay\b[^}]*\} from '\.\/closings\.js'/)
  })
  it('the state before the loop: mods / co from the file, one company pool, the disagreement once, your own file beside here', () => {
    for (const s of ['let mods = statusMods(file.status), co = closingOverlay(file.closing)', 'const company = createCompany()', 'let disagreeSaid = false',
      "const selfFile = { status: 'notice-mailed', aseed: myPinTag, origin: null, thin: false }"]) {
      expect(at(s)).toBeLessThan(loopAt)
      expect(game.split(s).length - 1, s).toBe(1)
    }
    expect(at('let file = ')).toBeLessThan(at('let mods = statusMods(file.status)'))
    const here = slice('function hereFields() {', 'return hereObj')
    expect(here).toContain('selfFile.status = file.status; selfFile.aseed = myPinTag; selfFile.origin = origin; selfFile.thin = thin')
    expect(here).toContain('hereObj.aseed = myPinTag')                       // the tag, never anchorSeed itself (it inverts to the place)
  })
  it('ONE sanCtx before the loop (you, your file, this floor\'s remote players, the bus\'s two questions set once); sanityStep once a frame', () => {
    expect(count(/const sanCtx = /g)).toBe(1)
    expect(at('const sanCtx = {')).toBeLessThan(loopAt)
    expect(at('const sanCtx = {')).toBeGreaterThan(at('const remoteOnFloor = []'))
    expect(game).toContain('player, self: selfFile, remotes: remoteOnFloor, fresh: bus ? bus.fresh : null, onFloor: bus ? bus.onFloor : null }')
    expect(count(/sanityStep\(/g)).toBe(1)
    expect(count(/mpClient\.getRemotePlayers\(\)/g)).toBe(1)              // fillRemotes' one read: the step reads its array
    expect(block).not.toMatch(/sanCtx\.(player|self|remotes|fresh|onFloor) = /)
  })
  it('the block: after the tension, where the six lines were; the refill, the step, the clamp, the pool, the two lines at discovery; nothing of the old block left', () => {
    expect(at('const s = sanityStep(sanCtx)')).toBeGreaterThan(at('const tn = tension.tick('))
    expect(at('const s = sanityStep(sanCtx)')).toBeGreaterThan(at('// ── sanity —'))
    expect(at('const s = sanityStep(sanCtx)')).toBeLessThan(at('updateSanity()', loopAt))
    expect(block).toContain('sanCtx.rules = rules; sanCtx.mods = mods; sanCtx.closingOverlay = co; sanCtx.flashlight = flashlight; sanCtx.litNear = litNear')
    expect(block).toContain('sanCtx.index = level.index; sanCtx.depth = level.depth; sanCtx.hunted = th.hunted; sanCtx.gaze = th.gaze; sanCtx.gazeRate = th.gazeRate')
    expect(block).toContain('sanCtx.origin = origin; sanCtx.drift = driftD(); sanCtx.leashCalm = leashCalm')   // the ONE drift helper (it carries the debt)
    expect(block).toContain('sanCtx.company = sanCtx.companyWas = company.value; sanCtx.disagreeSaid = disagreeSaid; sanCtx.dt = dt')
    expect(block).toMatch(/const s = sanityStep\(sanCtx\)\r?\n\s*sanity = Math\.max\(0, Math\.min\(100, sanity \+ s\.delta \* dt\)\)\r?\n\s*company\.add\(s\.companyDelta\)\r?\n\s*if \(s\.exhaustedNow\) showMessage\(EXHAUSTED_LINE, PRIO\.discovery\)\r?\n\s*if \(s\.disagreeNow\) \{ disagreeSaid = true; showMessage\(DISAGREE_LINE, PRIO\.discovery\) \}/)
    expect(game).not.toMatch(/sdelta/)
    expect(loop).not.toMatch(/sanCtx = \{/)                                // refilled in place, never rebuilt
  })
  // the block lifted from game.js (and the literal it fills), run against the real step and a real pool
  const lit = game.match(/const sanCtx = (\{[^]*?\})\r?\n/)[1]
  const mkCtx = new Function('rules', 'mods', 'co', 'flashlight', 'player', 'selfFile', 'remoteOnFloor', 'bus', `return ${lit}`)
  // (down: I9; the evidence floor, I12: nobody's photograph of you unless a case hands one in)
  const run = new Function('sanCtx', 'company', 'sanityStep', 'showMessage', 'EXHAUSTED_LINE', 'DISAGREE_LINE', 'PRIO', 'driftD', 'st', 'evidence = { active: () => false }', 'EVIDENCE_FLOOR = 25',
    `let { rules, mods, co, flashlight, litNear, level, th, origin, leashCalm, disagreeSaid, dt, sanity, playT, down = { st: 'ok' } } = st\n${block}\nst.sanity = sanity; st.disagreeSaid = disagreeSaid`)
  const NM = statusMods('notice-mailed'), CO = closingOverlay(null), DT = 1 / 60
  const legacy = (f, index, hunted, gaze, rate, friend) => {
    let sdelta = f ? 2 : -2
    sdelta -= (index >= 0 && index <= 3 ? index : 0) * 0.5
    if (hunted) sdelta -= 3
    if (gaze) sdelta -= rate
    if (friend) sdelta += 3
    return sdelta
  }
  it('replayed under LEGACY it is the post-core block: flashlight x index 0..4 (∅ drains nothing) x hunted x gaze x one old friend, solo and online', () => {
    const player = { x: 10, y: 10 }, remotes = [], said = []
    for (const bus of [null, { fresh: () => false, onFloor: () => true }]) {
      const sanCtx = mkCtx(LEGACY, NM, CO, true, player, { status: 'notice-mailed', aseed: null, origin: null, thin: false }, remotes, bus)
      const company = createCompany()
      for (const f of [true, false]) for (let index = 0; index <= 4; index++) for (const h of [true, false]) for (const [g, rate] of [[false, 0], [true, 1.5], [true, 3]]) {
        for (const friend of bus ? [null, { id: 'a', x: 10 + Math.sqrt(35.9), y: 10 }, { id: 'b', x: 10, y: 10 + Math.sqrt(36.1) }] : [null]) {
          remotes.length = 0; if (friend) remotes.push(friend)
          const st = { rules: LEGACY, mods: NM, co: CO, flashlight: f, litNear: false, level: { index, depth: depthOf(index) }, th: { hunted: h, gaze: g, gazeRate: rate },
            origin: null, leashCalm: 0, disagreeSaid: false, dt: DT, sanity: 50, playT: 0 }
          run(sanCtx, company, sanityStep, (m, p) => said.push([m, p]), EXHAUSTED_LINE, DISAGREE_LINE, PRIO, () => 0, st)
          const near = !!friend && (friend.x - 10) ** 2 + (friend.y - 10) ** 2 < 36
          expect(st.sanity, `f${f} i${index} h${h} g${g} r${rate} ${friend?.id}`).toBe(Math.max(0, Math.min(100, 50 + legacy(f, index, h, g, rate, near) * DT)))
        }
      }
      expect(company.value).toBe(60)                                        // no fresh friend: the pool only refills (and is full)
    }
    expect(said).toEqual([])
  })
  it('a fresh friend draws on the pool: it steadies you, runs dry in 20 s with ONE exhausted line, and the files\' disagreement is said once', () => {
    const player = { x: 10, y: 10 }, remotes = [{ id: 'f', x: 12, y: 10, status: 'compliance', thin: false }], said = []
    const bus = { fresh: (id) => id === 'f', onFloor: () => true }
    const self = { status: 'extension', aseed: null, origin: 'tenant', thin: false }
    const rules = rulesFor('tenant', false), mods = statusMods('extension')
    const sanCtx = mkCtx(rules, mods, CO, true, player, self, remotes, bus)
    const company = createCompany()
    const st = { rules, mods, co: CO, flashlight: true, litNear: false, level: { index: 1, depth: 1 }, th: { hunted: false, gaze: false, gazeRate: 0 },
      origin: 'tenant', leashCalm: 0, disagreeSaid: false, dt: DT, sanity: 50, playT: 0 }
    const go = () => run(sanCtx, company, sanityStep, (m, p) => said.push([m, p]), EXHAUSTED_LINE, DISAGREE_LINE, PRIO, () => 0, st)
    go()
    expect(st.sanity).toBeGreaterThan(50)
    expect(said).toEqual([[DISAGREE_LINE, PRIO.discovery]])
    expect(st.disagreeSaid).toBe(true)
    for (let i = 0; i < 25 * 60; i++) go()
    expect(company.value).toBe(0)
    expect(said.filter(([m]) => m === EXHAUSTED_LINE)).toEqual([[EXHAUSTED_LINE, PRIO.discovery]])
    expect(said.filter(([m]) => m === DISAGREE_LINE).length).toBe(1)
    remotes.length = 0                                                      // apart: the pool comes back
    for (let i = 0; i < 10 * 60; i++) go()
    expect(company.value).toBeGreaterThan(7)
  })
})

describe('I8 (W4 / W3 / W8): the film, the station, the presence, the seam and the beacon read the file', () => {
  const COMPOSERS = ['compose-polaroid.js', 'compose-radio.js', 'compose-wish.js', 'compose-gates.js']
  const NM = statusMods('notice-mailed')
  it('imports the composers, the file\'s write and the frame by their real names; game.js keeps no ledger, claim test or caption of its own', () => {
    expect(game).toMatch(/import \{ polaroidCaption \} from '\.\/compose-polaroid\.js'/)
    expect(game).toMatch(/import \{ radioLine, RADIO_GROUPS \} from '\.\/compose-radio\.js'/)
    expect(game).toMatch(/import \{ wishRoute \} from '\.\/compose-wish\.js'/)
    expect(game).toMatch(/import \{ finaleGate, beaconDecision, deathDecision \} from '\.\/compose-gates\.js'/)   // (deathDecision: I9)
    expect(game).toMatch(/import \{ SUBJECT_RANGE, SOUL_RANGE, inFrame, subjectInFrame\b[^}]*\} from '\.\/evidence\.js'/)   // (I12 adds the evidence clock after them)
    expect(game).toMatch(/import \{ lineOfSight, inViewCone \} from '\.\/raycaster\.js'/)
    // (I13 adds the npc pool, the settings control's filing and the strings; the stand, the progress, the slip and the 'your file' lines)
    expect(game).toMatch(/import \{ depthOf, loadFile, saveFile, statusMods, npcLines, canFile, canRefile, wishPrompt, fileStatus, STRINGS as FILE \} from '\.\/status\.js'/)
    expect(game).toMatch(/import \{ standConditions, standTick, closingOverlay, closingLines, isWishOpen, closingProgress, slipText, yourFileLines, CLOSED_OFFICE, STAND_STEADY_LINE \} from '\.\/closings\.js'/)
    expect(game).toMatch(/import \{ createCompany, createRollCall\b[^}]*\} from '\.\/rollcall\.js'/)   // (I9 / I10 add the kinds and the whistle's names after them)
    for (const re of [/const RADIO_GROUPS = /, /const isClaim = /, /const finalizing = /, /iwashere/, /extension30150a/]) expect(game).not.toMatch(re)
    // each seam is ONE call
    for (const re of [/polaroidCaption\(/g, /radioLine\(/g, /wishRoute\(/g, /finaleGate\(/g, /beaconDecision\(/g, /rollCall\(level\.st\)/g]) expect(count(re), String(re)).toBe(1)
    expect(slice('function readRadio(on) {', '// The counter-claim: fires ONCE')).toContain('rollLine: level.st ? rollCall(level.st) : null')
    expect(game).not.toMatch(/TODO\(integrate:W4\) I8/)
    for (const f of [...COMPOSERS, 'evidence.js']) { expect(sw).toContain(`'/renderer/${f}'`); expect(build).toContain(`'${f}'`) }
  })
  it('the file: loaded from prefs once; ONE write — applyFile (a fresh object every time, mods / co re-derived, saveFile once, the tension, the room)', () => {
    expect(game).toContain("let file = loadFile(getPref('file'))")
    expect(count(/saveFile\(/g)).toBe(1)
    expect(game).toContain('function applyFile(f) { file = f; mods = statusMods(file.status); co = closingOverlay(file.closing); saveFile(file); retension(); bus?.here(hereFields()) }')
    expect(count(/(?<![.\w])file = /g)).toBe(2)                              // the declaration and applyFile: never written anywhere else
    const writes = [...game.matchAll(/applyFile\(([^)]*)\)/g)].map((m) => m[1]).filter((a) => a !== 'f')
    expect(writes.length).toBeGreaterThanOrEqual(4)                          // the ledger heard, the seam held, a close, a status
    for (const a of writes) expect(a).toMatch(/^(\{ \.\.\.file, [^}]*\}|r\.file)$/)
    expect(game).toContain('function retension() { evConfig.tension = (level?.amb?.tension ?? 0) + (closingOverlay(file.closing).tension ?? 0) }')
    expect(count(/const closingTimers = \[\]/g)).toBe(1)
    expect(buildBody).toContain('for (const t of closingTimers) clearTimeout(t); closingTimers.length = 0; standHeld = 0; shotOnLevel = false')
    // lifted and run: the write re-derives from the NEW reference and saves exactly what it was handed
    const line = game.match(/function applyFile\(f\) \{[^\n]*\}/)[0]
    const saved = [], heard = []
    let tensioned = 0
    const fn = new Function('statusMods', 'closingOverlay', 'saveFile', 'retension', 'bus', 'hereFields', 'st',
      `let { file, mods, co } = st\n${line}\napplyFile(st.next)\nObject.assign(st, { file, mods, co })`)
    const st = { file: loadFile(null), mods: NM, co: closingOverlay(null), next: { ...loadFile(null), status: 'compliance', closing: 'compliance' } }
    fn(statusMods, closingOverlay, (f) => saved.push(f), () => tensioned++, { here: (h) => heard.push(h) }, () => 'here', st)
    expect(st.file).toBe(st.next)
    expect(st.mods).toBe(statusMods('compliance'))
    expect(st.co).toBe(closingOverlay('compliance'))
    expect(saved).toEqual([st.next]); expect(tensioned).toBe(1); expect(heard).toEqual(['here'])
  })
  it('the presence: a closed file refuses the dialog before it opens; the placeholder and the faint lines are the file\'s', () => {
    const open = slice('function openDialog() {', 'function closeDialog()')
    expect(open).toMatch(/if \(dialogOpen\) return\r?\n\s*if \(!isWishOpen\(file\.closing\)\) \{ showMessage\(CLOSED_OFFICE\); return \}[^\n]*\r?\n\s*dialogOpen = true/)
    expect(open).toContain('const wp = wishPrompt({ origin, status: file.status, closing: file.closing, canFile: fileable(), canRefile: canRefile(file.at, Date.now()) })')
    expect(open).toContain('wishText.placeholder = wp.placeholder; renderWishSub(wp.sub)')
    expect(game).toContain('const fileable = () => canFile({ ledgerHeard: file.ledgerHeard, pagesRead: readSet.size, depth: level.depth })')
    expect(html).toMatch(/<textarea id="wish-text"[^>]*><\/textarea>\r?\n\s*<p id="wish-sub"><\/p>\r?\n\s*<div id="wish-actions">/)
    expect(html).toMatch(/#wish-sub \{[^}]*font-size: 11px;[^}]*\}/)
  })
  it('#wish-sub, lifted and run on a fake DOM: one faint line each; a stamp line types the word before \' · \' and submits, never while the dialog is busy', () => {
    const src = slice('function renderWishSub(lines) {', 'function openDialog() {')
    const mk = () => {
      const el = { className: '', children: [], handlers: {}, classes: new Set(), value: '', disabled: false, clicks: 0 }
      let text = ''
      Object.defineProperty(el, 'textContent', { get: () => text, set: (v) => { text = v; if (v === '') el.children.length = 0 } })
      el.classList = { add: (c) => el.classes.add(c) }
      el.addEventListener = (k, f) => { el.handlers[k] = f }
      el.appendChild = (c) => el.children.push(c)
      el.click = () => el.clicks++
      return el
    }
    const subEl = mk(), wishText = mk(), submit = mk()
    const doc = { createElement: () => mk(), getElementById: (id) => (id === 'wish-submit' ? submit : null) }
    const render = new Function('wishSubEl', 'document', 'wishText', `${src}\nreturn renderWishSub`)(subEl, doc, wishText)
    render([STRINGS.NOTICE_UNANSWERED])                                     // the legacy dialog: one line, read only
    expect(subEl.children.map((c) => c.textContent)).toEqual(['a notice was mailed to you. you have not answered.'])
    expect(subEl.children[0].classes.has('stamp')).toBe(false)
    render([...STRINGS.STAMP_LINES])
    expect(subEl.children.length).toBe(3)
    expect(subEl.children.every((c) => c.classes.has('stamp') && c.className === 'wish-line')).toBe(true)
    expect(subEl.children[1].handlers.pointerdown).toBeUndefined()          // a click, never a press: a scroll or a stray touch files nothing
    subEl.children[1].handlers.click({ preventDefault() {} })
    expect([wishText.value, submit.clicks]).toEqual(['compliance', 1])      // a status word, never 'close the file'
    submit.disabled = true; subEl.children[0].handlers.click({ preventDefault() {} })
    expect([wishText.value, submit.clicks]).toEqual(['compliance', 1])
  })
  it('the wish, lifted and replayed against the real router: today\'s claim and wish byte for byte; a name, a status, a close and a re-file stay in the room', async () => {
    const body = slice('const r = wishRoute(', 'setTimeout(() => {')
    const filing = slice('// a status filing (status.js fileStatus)', '// what you typed is routed')
    const AsyncFunction = (async () => {}).constructor
    const run = async (st0, text) => {
      const st = { origin: null, rules: LEGACY, file: loadFile(null), filed: false, thin: false, photoIdx: 5, stationIdx: 2, claimFiled: false, depth: 1, pages: 0, ...st0 }
      const out = { sent: [], said: [], timers: [], applied: [], compliance: 0, finale: 0, named: [], here: 0, resp: null, closingTimers: [], cards: [], closed: 0 }
      const fn = new AsyncFunction('text', 'wishRoute', 'canFile', 'readSet', 'level', 'refileName', 'wishResp', 'wishText', 'document', 'applyCompliance',
        'closingLines', 'closingTimers', 'showMessage', 'PRIO', 'rulesFor', 'evConfig', 'bus', 'hereFields', 'window', 'tryFinale', 'setTimeout', 'openCard', 'closeDialog', 'st', 'out',
        `let { origin, rules, file, filed, thin, photoIdx, stationIdx, claimFiled } = st
        function applyFile(f) { file = f; out.applied.push(f) }
        const fileable = () => canFile({ ledgerHeard: file.ledgerHeard, pagesRead: readSet.size, depth: level.depth })
        ${filing}
        try {\n${body}\n} finally { st.confirm = () => { out.cards.at(-1)[1].onConfirm(); Object.assign(st, { file, photoIdx, stationIdx, claimFiled }) }; Object.assign(st, { origin, rules, file, photoIdx, stationIdx, claimFiled }) }`)
      const resp = { set textContent(v) { out.resp = v } }
      const btn = { disabled: false }
      await fn(text, wishRoute, canFile, { size: st.pages }, { depth: st.depth }, (n) => out.named.push(n), resp, { disabled: false }, { getElementById: () => btn },
        () => out.compliance++, closingLines, out.closingTimers, (m, p) => out.said.push([m, p]), PRIO, rulesFor, { events: EVENTS }, { here: () => out.here++ }, () => 'here',
        { backrooms: { submitWish: async (t, m) => { out.sent.push([t, m]) } } }, () => out.finale++, (f, ms) => { out.timers.push(ms); return out.timers.length },
        (mode, o) => { out.cards.push([mode, o]); return {} }, () => out.closed++, st, out)
      return { st, out }
    }
    // today's claim: sent as typed, the legacy reply, the claim filed and the seam tried; no re-file for an unfiled claimant
    let { st, out } = await run({}, 'i was here')
    expect(out.sent).toEqual([['i was here', { origin: null }]])
    expect(out.resp).toBe('you did not ask. you asserted. the file has no column to deny a claim made. received.')
    expect([st.claimFiled, out.finale, st.origin, st.rules, out.applied.length]).toEqual([true, 1, null, LEGACY, 0])
    ;({ st, out } = await run({}, 'let me out'))
    expect(out.sent).toEqual([['let me out', { origin: null }]])
    expect(out.resp).toBe('your request has been received. whether it is heard is another matter.')
    expect([st.claimFiled, out.finale]).toEqual([false, 0])
    // a filed claimant is re-filed as processed before the seam is tried (the anchored released first), with its lines after the dialog
    ;({ st, out } = await run({ origin: 'anchored', rules: rulesFor('anchored', false), filed: true }, 'I was here.'))
    expect([st.origin, st.rules, out.here, st.claimFiled, out.finale]).toEqual(['processed', rulesFor('processed', false), 1, true, 1])
    expect(out.sent).toEqual([['I was here.', { origin: 'anchored' }]])                // the meta is the column that typed it
    expect(out.timers).toEqual([3000, 5600])
    expect([RELEASE_LINE, OPENED_LINE].every((l) => typeof l === 'string')).toBe(true)
    expect(out.said).toEqual([])                                                  // (the lines wait on their timers)
    // the unnamed's naming wish: re-filed through the card, nothing disabled, nothing sent
    ;({ st, out } = await run({ origin: 'unnamed', rules: rulesFor('unnamed', false), filed: true }, 'call me ada'))
    expect([out.named, out.sent, out.resp]).toEqual([['ada'], [], null])
    // a status word: filed (the letters, the station and the claim start over) and nothing sent; refused while the file cannot read you
    ;({ st, out } = await run({ claimFiled: true }, 'extension'))
    expect(out.resp).toBe(STRINGS.NOTICE_UNANSWERED)
    expect([out.applied.length, st.photoIdx, out.sent.length]).toEqual([0, 5, 0])
    ;({ st, out } = await run({ claimFiled: true, depth: 2 }, 'file me under extension'))
    expect(out.resp).toBe(STRINGS.FILED)
    expect(out.applied.length).toBe(1); expect(out.applied[0].status).toBe('extension')
    expect([st.photoIdx, st.stationIdx, st.claimFiled, out.sent.length, out.closingTimers.length]).toEqual([0, 0, false, 0, 0])
    ;({ st, out } = await run({ depth: 2, file: { ...loadFile(null), status: 'litigation', at: 1 } }, 'compliance'))   // a re-filing says so, after the dialog
    expect(out.resp).toBe(STRINGS.FILED)
    expect([out.closingTimers.length, out.timers]).toEqual([1, [3000]])
    // a file that holds work (a closing reached, pages given up) is never re-filed by one tap: the dialog closes and the card asks first
    for (const held of [{ closing: 'extension' }, { redacted: [3, 4] }]) {
      const before = { ...loadFile(null), status: 'extension', at: 1, ledgerHeard: true, ...held }
      ;({ st, out } = await run({ depth: 2, claimFiled: true, file: before }, 'litigation'))
      expect([out.applied, out.resp, out.closed, st.file, st.claimFiled]).toEqual([[], null, 1, before, true])
      expect(out.cards.map(([m, o]) => [m, o.text, o.foot])).toEqual([['confirm', 'file under litigation? the old file closes with what it holds.', 'e · yes      esc · no']])
      st.confirm()                                                              // e: filed, as the stamp would have
      expect([out.applied.map((f) => [f.status, f.closing, f.redacted]), st.claimFiled, st.photoIdx]).toEqual([[['litigation', null, []]], false, 0])
      expect(out.said).toEqual([[STRINGS.FILED, PRIO.discovery]])
      expect(out.timers.at(-1)).toBe(2600)                                       // the re-filing's line after it
    }
    // nothing to lose: filed at once, as before (and a refusal never asks)
    ;({ st, out } = await run({ depth: 2, file: { ...loadFile(null), status: 'extension', at: 1, closing: 'extension' } }, 'extension'))
    expect([out.cards.length, out.resp]).toEqual([0, STRINGS.SAME_STATUS])
    // the compliance close: thirteen pages given up closes the file, the floor stops leaving pages, two lines follow the dialog
    const thirteen = { ...loadFile(null), status: 'compliance', at: 1, redacted: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }
    ;({ st, out } = await run({ file: thirteen }, 'close the file'))
    expect(out.applied.map((f) => f.closing)).toEqual(['compliance'])
    expect([out.compliance, out.closingTimers.length, out.timers, out.sent.length]).toEqual([1, 2, [5600, 8200], 0])
    expect(out.resp).toBe(closingLines('compliance')[0])
    ;({ st, out } = await run({ file: { ...thirteen, redacted: [1, 2] } }, 'close the file'))
    expect([out.applied.length, out.compliance, out.resp]).toEqual([0, 0, 'the file is not ready to close. two of thirteen pages given up.'])
    // a filed status's wish carries the trailer; the meta is the column's
    ;({ st, out } = await run({ origin: 'tenant', rules: rulesFor('tenant', false), filed: true, depth: 3, file: { ...loadFile(null), status: 'extension', at: 1 } }, 'warmer fog'))
    expect(out.sent).toEqual([['warmer fog\nfiled under: EXTENSION · level 3', rulesFor('tenant', false).wishMeta()]])
  })
  it('the radio, lifted and replayed: today\'s station on the deep floors byte for byte; the ledger heard goes on the file once; the key, the count, the roll call', () => {
    const body = slice('const r = radioLine(', '// The counter-claim: fires ONCE').replace(/\}\s*$/, '')
    const fn = new Function('on', 'radioLine', 'rules', 'mods', 'level', 'RADIO_GROUPS', 'rollcall', 'rollCall', 'performance', 'showMessage', 'blip', 'heartbeat', 'setTimeout', 'st', 'out',
      `let { stationIdx, firstDeepHearing, file } = st\nfunction applyFile(f) { file = f; out.applied.push(f) }\n${body}\nObject.assign(st, { stationIdx, firstDeepHearing, file })`)
    const press = (st, on, out) => fn(on, radioLine, st.rules, st.mods, st.level, RADIO_GROUPS, { count: () => st.count }, rollCall, { now: () => 0 },
      (m, p) => out.said.push(p === undefined ? m : [m, p]), () => out.blips++, () => out.beats++, (f, ms) => { out.later.push(ms); f() }, st, out)
    const fresh = (o = {}) => ({ stationIdx: 0, firstDeepHearing: true, file: loadFile(null), rules: LEGACY, mods: NM, level: { depth: 2, st: EMPTY_STANDING }, count: 1, ...o })
    const blank = () => ({ said: [], blips: 0, beats: 0, later: [], applied: [] })
    const st = fresh(), out = blank()
    for (let i = 0; i < 4; i++) press(st, true, out)
    expect(out.said).toEqual([
      'the station counts, slow and patient: 12 26 04 22 11 08 …   [1/4]', 'the station counts, slow and patient: 21 08 19 24 23 12 …   [2/4]',
      'the station counts, slow and patient: 23 12 17 23 11 08 …   [3/4]', 'the station counts, slow and patient: 09 12 15 08   [4/4]',
      'it reads the last group, then stops. that one was yours.'])
    expect([out.blips, out.beats, out.later, st.stationIdx]).toEqual([4, 1, [1900], 0])
    expect(out.applied.length).toBe(1)
    expect(out.applied[0]).toEqual({ ...loadFile(null), ledgerHeard: true })
    for (let i = 0; i < 4; i++) press(st, true, out)
    expect(out.applied.length).toBe(1)                                        // heard once is heard
    // the near floors: today's crackle and silence for a notice nobody answered; a filed status hears the floor's roll call
    const near = fresh({ level: { depth: 0, st: EMPTY_STANDING } }), o2 = blank()
    press(near, true, o2); press(near, false, o2)
    expect(o2.said).toEqual(['the radio crackles to life.', 'the radio falls silent.'])
    expect([o2.blips, near.stationIdx]).toEqual([0, 0])
    const roll = fresh({ mods: statusMods('extension'), level: { depth: 1, st: EMPTY_STANDING } }), o3 = blank()
    press(roll, true, o3)
    expect(o3.said).toEqual(['the station reads the floor. nothing is filed here.'])
    expect([o3.blips, roll.stationIdx]).toEqual([1, 0])
    // the processed hear the key once a run, and a beat on every group; the roll call's count layers over the last line
    const proc = fresh({ rules: rulesFor('processed', false) }), o4 = blank()
    press(proc, true, o4)
    expect([o4.said[1], proc.firstDeepHearing, o4.beats]).toEqual([RADIO_KEY_LINE, false, 1])
    const many = fresh({ stationIdx: 3, count: 3 }), o5 = blank()
    press(many, true, o5)
    expect(o5.said[1]).toBe('it reads the last group, then stops. those were yours — three of you.')
    expect(LEGACY_LAST_LINE).toBe('it reads the last group, then stops. that one was yours.')
  })
  it('the film, lifted and replayed: today\'s three captions, +8 after the caption read the sanity, the letter only on a letter; a friend in frame, the soul\'s door, the pin\'s calm, thin\'s first shot', () => {
    const body = slice('const thinNear = ephemera.some(', '// the door a lost soul in the film stands before').replace(/\}\s*$/, '')
    const fn = new Function('ephemera', 'player', 'bus', 'subjectInFrame', 'FRAME_OPTS', 'level', 'SOUL_RANGE', 'inFrame', 'polaroidCaption', 'knownWayArrow', 'rules', 'mods', 'file',
      'origin', 'thin', 'anchor', 'myPinTag', 'driftD', 'wardPulse', 'window', 'dataUrl', 'showMessage', 'st', 'out',
      `let { sanity, photoIdx, thinFirstShot, shotOnLevel, leashCalm } = st\n${body}\nObject.assign(st, { sanity, photoIdx, thinFirstShot, shotOnLevel, leashCalm })`)
    const player = { x: 10.5, y: 10.5, angle: 0 }
    const opts = { pos: (id) => (id === 'f' ? { x: 15.5, y: 10.5, angle: Math.PI } : null), cone: inViewCone, hf: HF, maxCells: SUBJECT_RANGE, los: () => true }
    const shoot = (st, o = {}) => {
      const out = { said: [], pulses: 0 }
      fn(o.ephemera ?? [], player, o.bus ?? null, subjectInFrame, opts, { index: st.index, depth: depthOf(st.index), decor: { nearestNpc: () => o.npc ?? null } }, SOUL_RANGE, inFrame,
        polaroidCaption, () => o.arrow ?? null, o.rules ?? LEGACY, o.mods ?? NM, { status: o.status ?? 'notice-mailed' }, o.origin ?? null, o.thin ?? false, o.anchor ?? null,
        o.tag ?? null, () => o.D ?? 0, () => out.pulses++, {}, null, (m, p) => out.said.push(p === undefined ? m : [m, p]), st, out)
      return out
    }
    const legacy = (thinNear, index, sanity, photoIdx) => thinNear ? 'the film shows someone who was not in the room. you can see the wall through them.'
      : sanity < 40 || index >= 3 ? 'the film shows the hall as it will finalize: darker, one door fewer.'
        : `the film develops one letter that was not in the room: "${'iwashere'[photoIdx % 8]}". transcribe it.`
    for (const thinNear of [false, true]) for (let index = 0; index <= 4; index++) for (const sanity of [0, 39, 40, 95]) {
      const st = { sanity, photoIdx: 3, thinFirstShot: true, shotOnLevel: false, leashCalm: 0, index }
      const eph = thinNear ? [{ variant: 'thin', x: 11.5, y: 11.5 }] : []
      const out = shoot(st, { ephemera: eph })
      expect(out.said).toEqual([legacy(thinNear, index, sanity, 3)])
      expect([st.sanity, out.pulses, st.shotOnLevel, st.leashCalm]).toEqual([Math.min(100, sanity + 8), 1, true, 0])
      expect(st.photoIdx).toBe(!thinNear && !(sanity < 40 || index >= 3) ? 4 : 3)
    }
    // a friend in frame: the photo is theirs (sent through the bus), the caption develops them
    const busOut = []
    const bus = { freshPeersOnFloor: () => [{ id: 'f', name: 'maddie', st: 'ok', thin: false, seen: false, o: 'tenant', status: 'extension', aseed: null }], emit: (k, p) => busOut.push([k, p]) }
    let st = { sanity: 60, photoIdx: 0, thinFirstShot: true, shotOnLevel: true, leashCalm: 0, index: 1 }
    let out = shoot(st, { bus })
    expect(out.said[0]).toMatch(/^the film develops maddie\. there is an address under them\./)
    expect(busOut).toEqual([['photo', { of: 'f', x: 10.5, y: 10.5, lvl: 1 }]])
    // the same pin: their 'here' carries its tag, held against yours (never the seed)
    const pinned = { freshPeersOnFloor: () => [{ id: 'f', name: 'maddie', st: 'ok', thin: false, seen: false, o: 'tenant', status: 'extension', aseed: 4242 }], emit: () => {} }
    st = { sanity: 60, photoIdx: 0, thinFirstShot: true, shotOnLevel: true, leashCalm: 0, index: 1 }
    expect(shoot(st, { bus: pinned, anchor: { lat: 1, lng: 2 }, tag: 4242 }).said[0]).toMatch(/^the film develops maddie\. the film shows your pin\./)
    st = { sanity: 60, photoIdx: 0, thinFirstShot: true, shotOnLevel: true, leashCalm: 0, index: 1 }
    expect(shoot(st, { bus: pinned, anchor: { lat: 1, lng: 2 }, tag: 4243 }).said[0]).toMatch(/^the film develops maddie\. there is an address under them\./)
    // a lost soul in frame, and the door behind them when one is on your sheet
    st = { sanity: 60, photoIdx: 0, thinFirstShot: true, shotOnLevel: true, leashCalm: 0, index: 1 }
    out = shoot(st, { npc: { x: 14.5, y: 10.5 }, arrow: '↗' })
    expect(out.said).toEqual(['the film shows them, and behind them, faintly, a door: ↗'])
    st = { sanity: 60, photoIdx: 0, thinFirstShot: true, shotOnLevel: true, leashCalm: 0, index: 1 }
    expect(shoot(st, { npc: { x: 10.5, y: 30.5 } }).said[0]).toMatch(/^the film develops one letter/)   // a soul out of frame is not in the film
    // the anchored pin on a floor's first shot quiets the leash; thin's first shot spends itself
    st = { sanity: 60, photoIdx: 0, thinFirstShot: true, shotOnLevel: false, leashCalm: 0, index: 1 }
    shoot(st, { rules: rulesFor('anchored', false), origin: 'anchored', anchor: { lat: 1, lng: 2 }, D: 50 })
    expect([st.leashCalm, st.shotOnLevel]).toEqual([60, true])
    st = { sanity: 60, photoIdx: 0, thinFirstShot: true, shotOnLevel: false, leashCalm: 0, index: 1 }
    out = shoot(st, { rules: rulesFor('tenant', true), origin: 'tenant', thin: true })
    expect([out.said[0], st.thinFirstShot, st.photoIdx]).toEqual(['the film shows the hall. at the edge of the frame it shows the wall through your hand.', false, 0])
  })
  it('the noise 9 and the flash stay before the caption; the soul\'s door is the compass\'s seen way, never the faint pull, never on the block', () => {
    const fire = slice('function firePolaroid() {', 'function knownWayArrow() {')
    expect(fire.indexOf('level.entitySys.noise(player.x, player.y, 9)')).toBeLessThan(fire.indexOf('const b = getPref(\'creatures\') ? level.entitySys.flash(player, FLASH_OPTS) : NO_FLASH'))
    expect(fire.indexOf('NO_FLASH')).toBeLessThan(fire.indexOf('polaroidCaption('))
    expect(game).toContain('const frameLos = (ax, ay, bx, by) => lineOfSight(ax, ay, bx, by, level.grid.floor)')
    expect(at('const FRAME_OPTS = { pos: peerPos, cone: inViewCone, hf: HF, maxCells: SUBJECT_RANGE, los: frameLos }')).toBeLessThan(loopAt)
    const door = slice('function knownWayArrow() {', '// The radio: cosmetic hum')
    expect(door).toContain('if (level.cfg.map) return null')
    expect(door).toContain('compassLines({ player, known: fog.ways(level.index) }, doorOut)')
    expect(door).not.toContain('fallback')
    for (const s of ['const doorOut = []', 'let thinFirstShot = true', 'let shotOnLevel = false', 'let firstDeepHearing = true',
      'const rollcall = createRollCall({ now: () => performance.now() })']) expect(at(s), s).toBeLessThan(loopAt)   // the roll call keeps its own ms clock, never playT
  })
  it('the seam: the core\'s gate and the file\'s, then the litigation\'s closing on a litigation file before the lines; the notice nobody answered can hold it every run', () => {
    const fin = slice('function tryFinale() {', 'function applyItemEffect(eff) {')
    expect(fin).toMatch(/if \(!finaleGate\(\{ seamHeld, claimFiled, beaconFired, rules, status: file\.status, closing: file\.closing \}\)\) return\r?\n\s*seamHeld = true\r?\n\s*if \(file\.status === 'litigation'\) applyFile\(\{ \.\.\.file, closing: 'litigation' \}\)[^\n]*\r?\n\s*wardPulse\(\); calmTimer = 600;/)
    // lifted and replayed against the real gate: a notice-mailed file holds the seam and stays open, so the next run (seamHeld false again) holds it too
    const run = new Function('finaleGate', 'rules', 'wardPulse', 'itemSys', 'renderHotbar', 'showMessage', 'setTimeout', 'st',
      `let { seamHeld, claimFiled, beaconFired, file, calmTimer, flickTgt, flickTimer, sanity } = st\nfunction applyFile(f) { file = f }\n${fin}\ntryFinale()\nObject.assign(st, { seamHeld, file })`)
    const hold = (file) => { const st = { seamHeld: false, claimFiled: true, beaconFired: true, file, calmTimer: 0, flickTgt: 0, flickTimer: 0, sanity: 50 }
      run(finaleGate, LEGACY, () => {}, { grant: () => {} }, () => {}, () => {}, () => {}, st); return st }
    let st = hold(loadFile(null))
    expect([st.seamHeld, st.file.status, st.file.closing]).toEqual([true, 'notice-mailed', null])
    st = hold(st.file)                                                          // the next run, the same profile
    expect([st.seamHeld, st.file.closing]).toEqual([true, null])
    st = hold({ ...loadFile(null), status: 'litigation', at: 1 })
    expect([st.seamHeld, st.file.closing]).toEqual([true, 'litigation'])
    expect(hold(st.file).seamHeld).toBe(false)                                 // litigation's closing is the file's: held once, until a new filing
  })
  it('the beacon, lifted and replayed: today\'s three pushes byte for byte; the pin rides only an anchored push; a processed push files the floor; a closed file has no standing', () => {
    const k = game.indexOf("const effect = getPref('beaconEffect')"), endS = 'if (b.setBeaconFired) { beaconFired = true; tryFinale() }'
    const body = game.slice(k, game.indexOf(endS, k) + endS.length) + '\n}'
    const fn = new Function('getPref', 'beaconDecision', 'rules', 'file', 'anchor', 'showMessage', 'window', 'filedFloors', 'floorKey', 'worldSeed', 'level', 'tryFinale', 'st',
      `let { beaconFired } = st\n${body}\nst.beaconFired = beaconFired`)
    const push = (o) => {
      const out = { said: [], fired: [], finale: 0, floors: new Set() }
      const st = { beaconFired: false }
      const prefs = { beaconEffect: o.effect, beaconWebhook: o.webhook }
      const win = o.bridge ? { backrooms: { fireBeacon: (p) => { out.fired.push(p); return { then: () => ({ catch() {} }) } } } } : {}
      fn((key) => prefs[key], beaconDecision, o.rules ?? LEGACY, o.file ?? loadFile(null), o.anchor ?? null, (m, p) => out.said.push(p === undefined ? m : [m, p]), win, out.floors,
        floorKey, 7, { index: 2 }, () => out.finale++, st)
      return { ...out, beaconFired: st.beaconFired }
    }
    expect(push({ effect: 'off', webhook: '' }).said).toEqual([NO_BEACON_LINE])
    expect(push({ effect: undefined, webhook: 'x' }).said).toEqual(['no beacon set. register one in settings.'])
    let p = push({ effect: 'pulse', webhook: 'https://ntfy.sh/EXTENSION-30150A' })
    expect([p.said, p.beaconFired, p.finale]).toEqual([[CLAIM_LINE], true, 1])
    expect(CLAIM_LINE).toBe('you fire the beacon — not a cry for help. a claim. i was here. put it in the file.')
    p = push({ effect: 'pulse', webhook: 'https://ntfy.sh/somewhere' })
    expect([p.said, p.beaconFired, p.finale]).toEqual([[LEGACY_PUSH_LINE, 'the beacon goes quiet.'], false, 0])
    p = push({ effect: 'pulse', webhook: 'https://ntfy.sh/somewhere', bridge: true, anchor: { lat: 1, lng: 2 } })
    expect(p.fired).toEqual([{ effect: 'pulse', webhook: 'https://ntfy.sh/somewhere' }])            // LEGACY never carries the pin
    p = push({ effect: 'pulse', webhook: 'https://ntfy.sh/somewhere', bridge: true, anchor: { lat: 1, lng: 2 }, rules: rulesFor('anchored', false) })
    expect(p.fired).toEqual([{ effect: 'pulse', webhook: 'https://ntfy.sh/somewhere', anchor: { lat: 1, lng: 2 } }])
    p = push({ effect: 'pulse', webhook: 'https://ntfy.sh/somewhere', rules: rulesFor('processed', false) })
    expect([...p.floors]).toEqual([floorKey(7, 2)])
    p = push({ effect: 'pulse', webhook: 'https://ntfy.sh/EXTENSION-30150A', file: { ...loadFile(null), status: 'litigation', closing: 'litigation' } })
    expect([p.said, p.beaconFired, p.finale]).toEqual([[CLAIM_LINE, NO_STANDING], false, 0])
  })
})

describe('I9 (W4 / W5): down, not dead — the death decision, lying down, the kneel, being counted back', () => {
  const loop = game.slice(loopAt)
  const HP_LINE = "if (player.hp <= 0) { player.hp = 0; const d = deathDecision({ mp: !!mpClient, peers: friendsUp(), downSt: down.st, rules, filed, thin, D: driftD(), timeout: false }); if (d === 'down') goDown(); else if (d !== 'wait') die(d) }"
  const TIMEOUT_LINE = "if (down.tick() === 'timeout') die(deathDecision({ mp: !!mpClient, peers: 0, downSt: down.st, rules, filed, thin, D: driftD(), timeout: true }))"
  const SWEEP = "if (down.st === 'down') { K['KeyF'] = K['KeyQ'] = K['KeyX'] = K['KeyE'] = K['KeyB'] = K['KeyL'] = false; for (let i = 1; i <= 6; i++) K['Digit' + i] = false }"
  const helpers = slice('function goDown() {', '// ── messages (black text')
  const fn = (name) => helpers.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\r?\\n  \\}`))[0]
  // the source without its comments (a call named in a comment is not a call)
  const code = game.split(/\r?\n/).map((l) => l.replace(/^\s*\/\/.*$|\s\/\/ .*$/, '')).join('\n')

  it('imports downed.js and deathDecision by their real names; downed.js is in both offline shells; nothing of I9 is left to do', () => {
    expect(game).toMatch(/import \{ createDownState, createKneel, downedInFront, DOWN_LINE, KNEEL_HINT, HANDS_LINE, LIGHT_STAYS_LINE, WOKEN_LINE, KNEELER_LINE, WAKE, KNEELER_SANITY, DOWN_BEAT \} from '\.\/downed\.js'/)
    expect(sw).toContain("'/renderer/downed.js'")
    expect(build).toContain("'downed.js'")
    expect(game).not.toMatch(/TODO\(integrate:W4\)/)
    expect(game).not.toMatch(/TODO\(integrate:W5\) I9/)
  })
  it('one down state and one kneel, before the loop, on performance.now() ms — never playT, and never handed a clock', () => {
    for (const s of ['const down = createDownState({ now: () => performance.now() })', 'const kneel = createKneel({ now: () => performance.now() })', 'let savedLight = true',
      "const downEl = document.getElementById('down')", "let downVeil = '0'", 'const DN_OPTS = { los: frameLos }', "const kneelOut = { to: '' }, wokeOut = { by: '' }"]) {
      expect(at(s), s).toBeLessThan(loopAt)
      expect(game.split(s).length - 1, s).toBe(1)
    }
    expect(count(/createDownState\(/g)).toBe(1); expect(count(/createKneel\(/g)).toBe(1)
    for (const re of [/down\.goDown\(playT/, /down\.tick\(playT/, /down\.kneelTick\([^)]*playT/, /kneel\.tick\(playT/, /playT \* 1000/]) expect(game).not.toMatch(re)
    expect(count(/down\.goDown\(\)/g)).toBe(1)                               // goDown(), bare
    expect(count(/down\.tick\(\)/g)).toBe(1)                                 // the loop's timeout check, bare
  })
  it('deathDecision is called exactly twice, both with the ONE signature; the hp block goes down, waits or dies; the timeout dies with nobody', () => {
    const calls = [...game.matchAll(/deathDecision\((\{[^}]*\})\)/g)].map((m) => m[1])
    expect(calls.length).toBe(2)
    for (const c of calls) expect(c).toMatch(/^\{ mp: !!mpClient, peers: (friendsUp\(\)|0), downSt: down\.st, rules, filed, thin, D: driftD\(\), timeout: (true|false) \}$/)
    expect(loop).toContain(HP_LINE)
    expect(loop).toContain(TIMEOUT_LINE)
    expect(loop.indexOf(TIMEOUT_LINE)).toBeLessThan(loop.indexOf(HP_LINE))
    expect(loop.indexOf("if (hurtEl) hurtEl.style.opacity = (hurt * 0.55).toFixed(2)")).toBeLessThan(loop.indexOf(TIMEOUT_LINE))
    expect((code.match(/(?<!function )\bdie\(/g) || []).length).toBe(2)       // the timeout and the hp block: nothing else dies
  })
  it('the hp block, lifted and replayed against the real decision: solo and an empty floor die today\'s death; a fresh friend lays you down; down, you wait', () => {
    const up = game.match(/function friendsUp\(\) \{[\s\S]*?\r?\n  \}/)[0]
    const run = new Function('deathDecision', 'mpClient', 'bus', 'down', 'rules', 'filed', 'thin', 'driftD', 'goDown', 'die', 'player', `${up}\n${HP_LINE}`)
    const go = (mp, peers, downSt, theirs = 'ok') => {
      const out = { down: 0, died: [] }, player = { hp: -4 }
      run(deathDecision, mp ? {} : null, mp ? { freshPeersOnFloor: () => Array.from({ length: peers }, () => ({ st: theirs })) } : null, { st: downSt }, LEGACY, false, false, () => 0,
        () => out.down++, (d) => out.died.push(d), player)
      return { ...out, hp: player.hp }
    }
    const legacyDeath = { die: true, mintThin: false, leashDebt: 0, sanity: 0, regenDelay: 0, line: null }
    expect(go(false, 0, 'ok')).toEqual({ down: 0, died: [legacyDeath], hp: 0 })     // solo: today's death, nothing added
    expect(go(true, 0, 'ok')).toEqual({ down: 0, died: [legacyDeath], hp: 0 })      // friends only on other floors
    expect(go(true, 1, 'ok')).toEqual({ down: 1, died: [], hp: 0 })                 // a fresh friend here: down
    expect(go(true, 1, 'down')).toEqual({ down: 0, died: [], hp: 0 })               // already down: wait
    expect(go(true, 1, 'ok', 'down')).toEqual({ down: 0, died: [legacyDeath], hp: 0 })   // the only friend here is down too: nobody can come
    expect(go(true, 2, 'ok', 'kneel')).toEqual({ down: 1, died: [], hp: 0 })        // kneeling by someone is still on their feet
  })
  it('die(d): the reset right after the core\'s invuln line, then the decision (its regenDelay wins), the veil cleared; its line third, at 7800 ms', () => {
    expect(dieBody).toMatch(/invuln = 1\.6; regenDelay = 0; hurt = 0\r?\n(\s*\/\/[^\n]*\r?\n)*\s*if \(down\.st === 'down'\) flashlight = savedLight\r?\n\s*down\.reset\(\); if \(kneel\.st\) \{ kneel\.stop\(\); flashlight = savedLight \}\r?\n\s*if \(d\) \{ if \(d\.mintThin && filed\) \{ thin = true; rules = rulesFor\(origin, thin\); thinFirstShot = true \} if \(d\.leashDebt > 0\) leashDebt = d\.leashDebt; if \(d\.sanity\) sanity = Math\.max\(0, Math\.min\(100, sanity \+ d\.sanity\)\); if \(d\.regenDelay\) regenDelay = d\.regenDelay \}\r?\n\s*if \(downEl\) downEl\.style\.opacity = '0'\r?\n\s*document\.body\.classList\.remove\('down'\)/)
    expect(dieBody).toMatch(/if \(r\.dropped\) later\(5200, r\.droppedLine, PRIO\.discovery\)\r?\n\s*if \(d\?\.line\) later\(7800, d\.line, PRIO\.discovery\)/)
    expect(game).not.toContain('you wake where you fell in.')
  })
  it('die(d)\'s block, lifted and replayed: LEGACY\'s d changes nothing; a filed timeout mints the layer, costs 20 and 12 s, gives the light back; the pin\'s debt', () => {
    const block = dieBody.slice(dieBody.indexOf("if (down.st === 'down') flashlight = savedLight"), dieBody.indexOf('level.grid.setPlayerChunk(spawnChunk.cx', dieBody.indexOf('invuln = 1.6')))
    const fnD = new Function('d', 'down', 'kneel', 'downEl', 'document', 'rulesFor', 'st',
      `let { flashlight, savedLight, thin, rules, thinFirstShot, leashDebt, sanity, regenDelay, filed, origin } = st\n${block}\nObject.assign(st, { flashlight, savedLight, thin, rules, thinFirstShot, leashDebt, sanity, regenDelay })`)
    const run = (d, o = {}) => {
      let t = 0
      const down = createDownState({ now: () => t }), kneel = createKneel({ now: () => t })
      if (o.down) down.goDown(0)
      const cls = new Set(['down']), veil = { style: { opacity: '0.62' } }
      const st = { flashlight: !o.down, savedLight: true, thin: false, rules: o.rules ?? LEGACY, thinFirstShot: false, leashDebt: 0, sanity: 50, regenDelay: 0, filed: o.filed ?? false, origin: o.origin ?? null }
      fnD(d, down, kneel, veil, { body: { classList: { remove: (c) => cls.delete(c) } } }, rulesFor, st)
      return { st, downSt: down.st, veil: veil.style.opacity, cls: [...cls] }
    }
    const legacy = deathDecision({ mp: false, peers: 0, downSt: 'ok', rules: LEGACY, filed: false, thin: false, D: 0, timeout: false })
    let r = run(legacy)
    expect([r.st.flashlight, r.st.thin, r.st.rules, r.st.sanity, r.st.regenDelay, r.st.leashDebt, r.st.thinFirstShot]).toEqual([true, false, LEGACY, 50, 0, 0, false])
    expect([r.downSt, r.veil, r.cls]).toEqual(['ok', '0', []])
    const tenant = rulesFor('tenant', false)
    const timeout = deathDecision({ mp: true, peers: 0, downSt: 'down', rules: tenant, filed: true, thin: false, D: 0, timeout: true })
    expect(timeout.line.startsWith(NOBODY_CAME + ' ')).toBe(true)
    r = run(timeout, { down: true, rules: tenant, filed: true, origin: 'tenant' })
    expect([r.st.flashlight, r.st.thin, r.st.rules, r.st.thinFirstShot, r.st.sanity, r.st.regenDelay, r.downSt]).toEqual([true, true, rulesFor('tenant', true), true, 30, 12, 'ok'])
    const unfiled = deathDecision({ mp: true, peers: 0, downSt: 'down', rules: LEGACY, filed: false, thin: false, D: 0, timeout: true })
    expect(unfiled.line).toBe(NOBODY_CAME)
    r = run(unfiled, { down: true })
    expect([r.st.thin, r.st.rules, r.st.sanity, r.st.regenDelay]).toEqual([false, LEGACY, 30, 12])                   // no file, no layer
    const pinned = deathDecision({ mp: false, peers: 0, downSt: 'ok', rules: rulesFor('anchored', false), filed: true, thin: false, D: 40, timeout: false })
    r = run(pinned, { rules: rulesFor('anchored', false), filed: true, origin: 'anchored' })
    expect([r.st.leashDebt, r.st.thin, r.st.sanity, r.st.regenDelay]).toEqual([40, true, 50, 0])
  })
  it('goDown / wakeUp / startKneel / stopKneel, lifted and replayed: the light forced and given back, the room told; wakeUp is the ONE wake and flips nothing', () => {
    for (const n of ['goDown', 'wakeUp', 'startKneel', 'stopKneel']) expect(count(new RegExp(`function ${n}\\(`, 'g')), n).toBe(1)
    const wake = fn('wakeUp')
    expect(wake).not.toMatch(/(?<!function )die\(/)
    expect(wake).not.toMatch(/\bdown\.(st|reset|wakeNow|kneelTick|goDown)\b/)                    // the caller flipped down.st
    expect(wake).not.toMatch(/\bthin\b|leashDebt/)                                               // never a layer, never the pin's debt
    expect(fn('goDown')).not.toMatch(/(?<!function )die\(/)
    // wakeUp is called from the kneel handler and the photo handler (I12) — never from die()
    expect((code.match(/(?<!function )\bwakeUp\(/g) || []).length).toBe(2)
    expect(game).toContain("bus.on('kneel', ({ id }) => { if (down.st === 'down' && down.kneelTick(id) === 'woken') wakeUp(id) })")
    expect(game).toContain("if (photoOutcome(down.st) === 'counted' && down.wakeNow() === 'woken') wakeUp(id, COUNTED_LINE)")
    const mk = new Function('kneel', 'down', 'player', 'showMessage', 'PRIO', 'bus', 'hereFields', 'document', 'downEl', 'wardInput', 'performance',
      'WAKE', 'WOKEN_LINE', 'DOWN_LINE', 'wokeOut', 'st',
      `let { flashlight, savedLight, sanity, invuln, regenDelay, hurt } = st\n${helpers}\nreturn { goDown, wakeUp, startKneel, stopKneel, read: () => ({ flashlight, savedLight, sanity, invuln, regenDelay, hurt }) }`)
    let t = 0
    const down = createDownState({ now: () => t }), kneel = createKneel({ now: () => t })
    const said = [], sent = [], cls = new Set(), veil = { style: { opacity: '0.9' } }
    let here = 0
    const bus = { emit: (k, p) => { sent.push([k, { ...p }]); return true }, here: () => here++ }
    const player = { hp: 0, maxHp: 100 }
    const h = mk(kneel, down, player, (m, p) => said.push([m, p]), PRIO, bus, () => 'here', { body: { classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c) } } },
      veil, { press: 3 }, { now: () => t }, WAKE, WOKEN_LINE, DOWN_LINE, { by: '' }, { flashlight: true, savedLight: true, sanity: 40, invuln: 0, regenDelay: 6, hurt: 1 })
    h.goDown()
    expect([down.st, h.read().flashlight, h.read().savedLight, [...cls], here]).toEqual(['down', false, true, ['down'], 1])
    expect(said).toEqual([[DOWN_LINE, PRIO.combat]])
    h.wakeUp('f')
    expect(down.st).toBe('down')                                                                  // wakeUp does not flip it: the caller did
    expect([player.hp, h.read().sanity, h.read().invuln, h.read().regenDelay, h.read().hurt, h.read().flashlight]).toEqual([60, 50, 2, 0, 0, true])
    expect([veil.style.opacity, [...cls], here]).toEqual(['0', [], 2])
    expect(said[1]).toEqual([WOKEN_LINE, PRIO.interaction])
    expect(sent).toEqual([['woke', { by: 'f' }]])
    // kneeling lights you; a fall while kneeling gets up first and keeps the light you had before the kneel
    t = 100; down.reset()
    const k = mk(kneel, down, player, (m, p) => said.push([m, p]), PRIO, bus, () => 'here', { body: { classList: { add() {}, remove() {} } } }, null, { press: 7 }, { now: () => t },
      WAKE, WOKEN_LINE, DOWN_LINE, { by: '' }, { flashlight: false, savedLight: true, sanity: 40, invuln: 0, regenDelay: 0, hurt: 0 })
    k.startKneel({ id: 'f', name: 'maddie' })
    expect([kneel.st.id, kneel.st.press0, k.read().flashlight, k.read().savedLight]).toEqual(['f', 7, true, false])
    k.goDown()
    expect([kneel.st, down.st, k.read().flashlight, k.read().savedLight]).toEqual([null, 'down', false, false])
    k.startKneel({ id: 'g', name: 'jo' }); k.stopKneel(HANDS_LINE)
    expect([kneel.st, k.read().flashlight, said[said.length - 1]]).toEqual([null, false, [HANDS_LINE, PRIO.interaction]])
  })
  it('the bus: kneel and woke from evKinds, my ONE outgoing payload let through by identity; through the real bus a received one is checked as evKinds says', () => {
    expect(game).toContain('const kinds = evKinds(() => mpClient.id)')
    const lines = game.match(/bus\.register\('kneel'[^\n]*\r?\n\s*bus\.register\('woke'[^\n]*/)[0].replace(/\/\/[^\n]*/g, '')
    expect(game).toContain("bus.on('woke', ({ id }) => { if (kneel.wasKneelingOn(id)) { sanity = Math.min(100, sanity + KNEELER_SANITY); showMessage(KNEELER_LINE, PRIO.interaction) } })")
    const sent = [], pos = { near: { x: 1.5, y: 0 }, far: { x: 3, y: 0 } }
    const bus = createEvBus({ send: (kind, payload) => sent.push([kind, JSON.parse(JSON.stringify(payload))]), now: () => 1000, self: () => ({ x: 0, y: 0, lvl: 1 }),
      peerPos: (id) => pos[id] ?? null, peerIds: () => new Set(Object.keys(pos)), selfId: () => 'me' })
    const kneelOut = { to: '' }, wokeOut = { by: '' }
    new Function('bus', 'kinds', 'kneelOut', 'wokeOut', lines)(bus, evKinds(() => 'me'), kneelOut, wokeOut)
    kneelOut.to = 'near'
    expect(bus.emit('kneel', kneelOut)).toBe(true)                                // mine, to the friend I kneel by
    expect(bus.emit('kneel', { to: 'near' })).toBe(false)                         // any other object is checked as received: not to me
    wokeOut.by = 'near'
    expect(bus.emit('woke', wokeOut)).toBe(true)
    expect(sent.map(([k, p]) => [k, p.to ?? p.by])).toEqual([['kneel', 'near'], ['woke', 'near']])
    const frame = (id, kind, payload, n) => ({ id, name: id, kind, payload: { ...payload, n }, t: 1 })
    expect(bus.receive(frame('near', 'kneel', { to: 'me' }, 1))).toBe(true)
    expect(bus.receive(frame('near', 'kneel', { to: 'you' }, 2))).toBe(false)
    expect(bus.receive(frame('far', 'kneel', { to: 'me' }, 3))).toBe(false)       // 3 cells: beyond maxDist 2
    expect(bus.receive(frame('far', 'woke', { by: 'me' }, 4))).toBe(true)         // within 3
    expect(bus.receive(frame('near', 'woke', { by: 'you' }, 5))).toBe(false)
  })
  it('the gates: modal, a step ends a kneel before the movement gate, the hit block, the regen, travel, the slow beat; tension.tick untouched', () => {
    expect(loop).toContain("const modal = transitioning || dialogOpen || chatOpen || noteOpen || mapOpen || down.st === 'down' || kneel.st !== null")
    expect(loop).toMatch(/if \(kneel\.st && \(K\['KeyW'\] \|\| K\['KeyS'\] \|\| K\['KeyA'\] \|\| K\['KeyD'\] \|\| K\['ArrowUp'\] \|\| K\['ArrowDown'\]\)\) stopKneel\(null\)\r?\n\s*if \(!transitioning && !chatOpen && !noteOpen && down\.st !== 'down' && !kneel\.st\) \{/)
    expect(loop).toContain("if (!transitioning && creaturesLive && getPref('damage') && invuln <= 0 && th.dmg > 0 && down.st !== 'down') {")
    expect(loop).toContain("else if (player.hp < player.maxHp && down.st !== 'down') player.hp = Math.min(player.maxHp, player.hp + 3.5 * dt)")
    expect(travelBody).toMatch(/^function travel\(way\) \{\r?\n\s*if \(transitioning \|\| down\.st === 'down'\) return/)
    expect(travelBody).toMatch(/if \(closing && closing\.key === way\.key && playT < closing\.until\) return/)
    expect(loop).toContain('const tn = tension.tick(dt, creaturesLive && !transitioning ? th : null, player.hp)')
    expect(loop).toMatch(/if \(down\.st === 'down'\) \{ if \(heartT <= 0\) \{ heartbeat\(DOWN_BEAT\.intensity\); heartT = DOWN_BEAT\.everyS \} \}/)
    expect(DOWN_BEAT).toEqual({ intensity: 0.3, everyS: 2 })
    // Space while kneeling is your hands on them (the latch was dropped by modal), after the charger and its recoil
    const ward = game.slice(at('let verbMul = 1'), at('let moved = false'))
    expect(ward).toMatch(/shake = Math\.max\(shake, RECOIL_SHAKE\)\r?\n\s*\}\r?\n\s*\}\r?\n(\s*\/\/[^\n]*\r?\n)*\s*if \(kneel\.st && wardInput\.press !== kneel\.st\.press0\) stopKneel\(HANDS_LINE\)/)
  })
  it('the verbs: lying down every verb key but C is swept just before the gate; the kneel\'s F heads the F chain; Esc and L while kneeling', () => {
    expect(loop).toContain(SWEEP)
    const sweepAt = loop.indexOf(SWEEP), gateAt = loop.indexOf('if (!transitioning && !dialogOpen && !chatOpen && !noteOpen && !mapOpen) {')
    expect(sweepAt).toBeGreaterThan(loop.indexOf("else if (K['Tab']) {"))
    expect(sweepAt).toBeLessThan(gateAt)
    expect(SWEEP).not.toContain("K['KeyC']")
    const K = Object.fromEntries(['KeyF', 'KeyQ', 'KeyX', 'KeyE', 'KeyB', 'KeyL', 'KeyC', 'KeyM', 'Enter', 'Tab', 'KeyW', 'Digit1', 'Digit6'].map((k) => [k, true]))
    new Function('down', 'K', SWEEP)({ st: 'down' }, K)
    expect(Object.keys(K).filter((k) => K[k])).toEqual(['KeyC', 'KeyM', 'Enter', 'Tab', 'KeyW'])    // C still calls; the music, chat, map, the gaze stay
    const K2 = { KeyF: true }; new Function('down', 'K', SWEEP)({ st: 'ok' }, K2); expect(K2.KeyF).toBe(true)
    expect(loop).toMatch(/if \(!transitioning && !dialogOpen && !chatOpen && !noteOpen && !mapOpen\) \{\r?\n(\s*\/\/[^\n]*\r?\n)+\s*if \(K\['KeyF'\] && \(kneel\.st \|\| dnFront\)\) \{ K\['KeyF'\] = false; if \(kneel\.st\) stopKneel\(null\); else startKneel\(dnFront\) \}\r?\n\s*if \(K\['KeyF'\]\) \{/)
    expect(loop).toMatch(/if \(kneel\.st && K\['Escape'\]\) \{ K\['Escape'\] = false; stopKneel\(null\) \}[^\n]*\r?\n(\s*\r?\n)?(\s*\/\/[^\n]*\r?\n)*\s*if \(mapOpen && \(K\['Escape'\] \|\| K\['Tab'\]\)\)/)
    // (the off line is lightshare.js litOffLine since I12: today's 'flashlight off — the dark leans in.' when nobody's light reaches you)
    expect(loop).toMatch(/if \(K\['KeyL'\]\) \{\r?\n\s*K\['KeyL'\] = false\r?\n\s*if \(kneel\.st\) showMessage\(LIGHT_STAYS_LINE\)[^\n]*\r?\n\s*else \{ flashlight = !flashlight; lightToggles\+\+; showMessage\(flashlight \? 'flashlight on\.' : litOffLine\(litRec \? litRec\.name : null\)\) \}/)
    expect(LIGHT_STAYS_LINE).toBe('your light stays on them.')
  })
  it('the prompt: who is down in front (the hoisted options, last frame\'s fill) heads the ladder, dimming as you count; the kneel ticks after the remote fill', () => {
    expect(loop).toContain('const dnFront = (bus && !kneel.st) ? downedInFront(player, remoteOnFloor, DN_OPTS) : null')
    expect(loop.indexOf('const dnFront = ')).toBeLessThan(loop.indexOf("const itemHintEl = document.getElementById('item-hint')"))
    expect(loop).toMatch(/if \(itemHintEl\) \{\r?\n\s*if \(kneel\.st \|\| dnFront\) \{\r?\n\s*itemHintEl\.textContent = KNEEL_HINT\r?\n\s*itemHintEl\.style\.opacity = kneel\.st \? kneel\.dim\(\)\.toFixed\(2\) : '1'[^\n]*\r?\n\s*\} else if \(nearItem\) \{/)
    expect(KNEEL_HINT).toBe('f · stay with them')
    const tick = loop.indexOf('const kr = kneel.tick(performance.now(), tgt, player)')
    expect(tick).toBeGreaterThan(loop.indexOf('fillRemotes()'))
    expect(tick).toBeGreaterThan(loop.indexOf('if (bus) { bus.tick(performance.now());'))
    expect(tick).toBeLessThan(loop.indexOf('const th = creaturesOn ? level.entitySys.update('))
    expect(loop).toContain("if (kr === 'emit') { kneelOut.to = kneel.st.id; bus?.emit('kneel', kneelOut) }")
    expect(loop).toContain("else if (kr === 'ended') { flashlight = savedLight; bus?.here(hereFields()) }")
    expect(buildBody).toMatch(/for \(const t of closingTimers\) clearTimeout\(t\);[^\n]*\r?\n(\s*\/\/[^\n]*\r?\n)*\s*if \(kneel\.st\) \{ kneel\.stop\(\); flashlight = savedLight \}/)
    expect(buildBody).not.toMatch(/down\.(reset|goDown)/)                       // lying down is not touched by a build (travel refuses; die resets)
  })
  it('here says kneel / down; the sanity step lies down (-1 flat); the veil is written on a change only', () => {
    expect(slice('function hereFields() {', 'return hereObj')).toContain("hereObj.st = kneel.st ? 'kneel' : down.st")
    expect(loop).toContain("sanCtx.down = down.st === 'down'")
    expect(loop).toMatch(/const veil = down\.st === 'down' \? down\.lift\(\)\.toFixed\(2\) : '0'\r?\n\s*if \(downEl && veil !== downVeil\) \{ downVeil = veil; downEl\.style\.opacity = veil \}/)
    expect(count(/classList\.add\('down'\)/g)).toBe(1)                           // goDown
    expect(count(/classList\.remove\('down'\)/g)).toBe(2)                        // wakeUp, die
    // the sanity block, lifted: lying down it is -1 a second whatever else is true, and the pool neither drains nor refills
    const block = slice('sanCtx.rules = rules;', 'updateSanity()')
    const lit = game.match(/const sanCtx = (\{[^]*?\})\r?\n/)[1]
    const sanCtx = new Function('rules', 'mods', 'co', 'flashlight', 'player', 'selfFile', 'remoteOnFloor', 'bus', `return ${lit}`)(LEGACY, statusMods('notice-mailed'), closingOverlay(null), true, { x: 0, y: 0 }, {}, [], null)
    const company = createCompany(); company.add(-30)
    const st = { rules: LEGACY, mods: statusMods('notice-mailed'), co: closingOverlay(null), flashlight: true, litNear: false, level: { index: 2, depth: 2 }, th: { hunted: true, gaze: true, gazeRate: 3 },
      origin: null, leashCalm: 0, disagreeSaid: false, dt: 1 / 60, sanity: 50, playT: 0, down: { st: 'down' } }
    new Function('sanCtx', 'company', 'sanityStep', 'showMessage', 'EXHAUSTED_LINE', 'DISAGREE_LINE', 'PRIO', 'driftD', 'st', 'evidence = { active: () => false }', 'EVIDENCE_FLOOR = 25',   // (the evidence floor: I12)
      `let { rules, mods, co, flashlight, litNear, level, th, origin, leashCalm, disagreeSaid, dt, sanity, playT, down } = st\n${block}\nst.sanity = sanity`)(sanCtx, company, sanityStep, () => {}, EXHAUSTED_LINE, DISAGREE_LINE, PRIO, () => 0, st)
    expect(st.sanity).toBe(50 - 1 / 60)
    expect(company.value).toBe(30)
  })
  it('index.html: #down is its own veil between #hurt and #fade, z 45, and the line you are told reads over it', () => {
    expect(html).toMatch(/<div id="hurt"><\/div>\r?\n\s*<div id="down"><\/div>\r?\n\s*<div id="fade"><\/div>/)
    const css = html.match(/#down \{[^}]*\}/)[0]
    for (const s of ['position: fixed', 'inset: 0', 'background: #000', 'opacity: 0', 'pointer-events: none', 'z-index: 45', 'transition: opacity 0.4s']) expect(css).toContain(s)
    expect(html).toContain('body.down #msg { z-index: 46; }')
    expect([DOWN_LINE, WOKEN_LINE, KNEELER_LINE]).toEqual(['everything goes dark. you are still here. somewhere, someone may notice.', 'you are counted. you come back.', 'you stayed. you counted them back.'])
    expect(KNEELER_SANITY).toBe(8)
  })
})

describe('I10 (W5): the whistle — the C edge, your call, a friend\'s, the roll call and who has gone quiet', () => {
  const loop = game.slice(loopAt)
  const code = game.split(/\r?\n/).map((l) => l.replace(/^\s*\/\/.*$|\s\/\/ .*$/, '')).join('\n')
  const C_LINE = "if (K['KeyC']) { K['KeyC'] = false; whistleOut(creaturesLive) }"
  const QUIET = "if (bus) { const qs = rollcall.tick(performance.now(), bus.freshPeersOnFloor()); for (let i = 0; i < qs.length; i++) { sanity = Math.max(0, sanity - QUIET_SANITY); showMessage(qs[i].line, PRIO.ambient) } }"
  const lift = (re) => { const m = game.match(re); expect(m, String(re)).not.toBeNull(); return m[0] }
  const whistleSrc = lift(/function whistleOut\(live\) \{[\s\S]*?\r?\n {2}\}/)

  it('imports the whistle by its real names (the audio call before the bump); the state before the loop; nothing of W5 is left to do', () => {
    expect(game).toMatch(/import \{ createCompany, createRollCall, evKinds, whistlePitch, bearingLabel, whistleGain, whistlePan, countLine, WHISTLE_COOLDOWN_MS, WHISTLE_NOISE, QUIET_SANITY, SOLO_SANITY, FAR_BONUS, ECHO, NO_ANSWER_LINE, ECHO_LINE, UNANSWERED_LINE \} from '\.\/rollcall\.js'/)
    expect(game).toMatch(/, drawerSlide, whistle, bump \} from '\.\/audio\.js'/)
    expect(sw).toContain("'/renderer/rollcall.js'"); expect(build).toContain("'rollcall.js'")
    expect(game).not.toMatch(/TODO\(integrate:W5\)/)
    for (const s of ['const rollcall = createRollCall({ now: () => performance.now() })', 'let lastWhistleAt = -Infinity', 'const callOut = { x: 0, y: 0, lvl: 0, c: true }']) {
      expect(at(s), s).toBeLessThan(loopAt)
      expect(game.split(s).length - 1, s).toBe(1)
    }
    expect(count(/createRollCall\(/g)).toBe(1)
    expect([WHISTLE_COOLDOWN_MS, WHISTLE_NOISE, QUIET_SANITY, SOLO_SANITY]).toEqual([10000, 14, 4, 2])
  })
  it('C is an edge in the verbs block right after X (lying down too: the sweep spares it); the touch CALL button is a plain key into the same edge', () => {
    expect(loop).toMatch(/if \(K\['KeyX'\]\) \{ K\['KeyX'\] = false; setDown\(\) \}\r?\n\s*if \(K\['KeyC'\]\) \{ K\['KeyC'\] = false; whistleOut\(creaturesLive\) \}/)   // (X asks on the card first since I11)
    const c = loop.indexOf(C_LINE)
    expect(c).toBeGreaterThan(loop.indexOf('if (!transitioning && !dialogOpen && !chatOpen && !noteOpen && !mapOpen) {'))
    expect(c).toBeLessThan(loop.indexOf("if (K['Escape'] && dialogOpen)"))
    expect(count(/function whistleOut\(/g)).toBe(1)
    expect((code.match(/(?<!function )\bwhistleOut\(/g) || []).length).toBe(1)          // the one edge calls it
    // held: the key repeats are dropped at the gate and the edge is consumed, so a held key (or a held CALL) calls once
    expect(takeKey({ code: 'KeyC', repeat: true }, {})).toBe('ignore')
    expect(takeKey({ code: 'KeyC', repeat: false }, {})).toBe('take')
    const K = { KeyC: true }, calls = []
    const edge = new Function('K', 'whistleOut', 'creaturesLive', C_LINE)
    edge(K, (live) => calls.push(live), true); edge(K, (live) => calls.push(live), true)
    expect([calls, K.KeyC]).toEqual([[true], false])
    // CALL: the dock's sixth button sets K['KeyC'] like the key; never an edge counter (only the ward's Space is)
    expect(ACTIONS[ACTIONS.length - 1]).toEqual({ code: 'KeyC', label: 'CALL', hint: 'whistle' })
    expect(game).toContain('initTouchControls({ canvas, K, player, getPref, edges: { Space: wardInput } })')
  })

  // whistleOut lifted out of game.js, its world faked: the roll call is the real one on an injected ms clock
  const mkWhistle = (deps, st) => new Function(...Object.keys(deps), 'st',
    `let { lastWhistleAt, standHeld, sanity, playT, arrivalGen } = st\n${whistleSrc}\nreturn { whistleOut, read: () => ({ lastWhistleAt, standHeld, sanity }), nextArrival: () => { arrivalGen++ } }`)(...Object.values(deps), st)
  function rig({ mp = null, bus = null, echo = false, heard = [] } = {}) {
    let t = 1000
    const said = [], sounds = [], noises = [], timers = [], stillNoises = [], steps = []
    const rollcall = createRollCall({ now: () => t, rng: () => (echo ? 0 : 0.99) })
    for (const id of heard) rollcall.hear(id, id, 0, 0, t)
    const callOut = { x: 0, y: 0, lvl: 0, c: true }
    const h = mkWhistle({
      performance: { now: () => t }, whistle: (...a) => sounds.push(a), whistlePitch, mpClient: mp,
      level: { index: 2, entitySys: { noise: (...a) => noises.push(a) } }, player: { x: 4.5, y: 7.25 },
      stillness: { noise: (p) => stillNoises.push(p) }, rollcall, bus, callOut,
      showMessage: (m, p) => said.push([m, p]), PRIO, countLine, NO_ANSWER_LINE, UNANSWERED_LINE, SOLO_SANITY, ECHO, ECHO_LINE,
      footfall: (n) => steps.push(n), setTimeout: (f, ms) => timers.push([f, ms]), WHISTLE_COOLDOWN_MS, WHISTLE_NOISE,
    }, { lastWhistleAt: -Infinity, standHeld: 3, sanity: 50, playT: 42, arrivalGen: 0 })
    return { h, said, sounds, noises, timers, stillNoises, steps, callOut, at: (ms) => { t = ms } }
  }
  it('your call, lifted and replayed: your pitch, a noise of 14 at your feet that is yours, a stand ended, ONE line; a second inside 10 s is swallowed', () => {
    const r = rig()
    r.h.whistleOut(false)                                                          // the lobby (or the block), alone
    expect(r.sounds).toEqual([[whistlePitch('solo', 'wanderer'), 0, 1]])
    expect(r.noises).toEqual([[4.5, 7.25, WHISTLE_NOISE]])                         // three arguments: yours, so the file's noiseMul applies
    expect(r.stillNoises).toEqual([42])                                            // the play clock
    expect(r.h.read()).toEqual({ lastWhistleAt: 1000, standHeld: 0, sanity: 50 })
    expect(r.said).toEqual([[NO_ANSWER_LINE, PRIO.interaction]])
    expect(r.timers).toEqual([])
    r.at(1000 + WHISTLE_COOLDOWN_MS - 1); r.h.whistleOut(false)
    expect([r.sounds.length, r.noises.length, r.stillNoises.length, r.said.length]).toEqual([1, 1, 1, 1])   // swallowed: no sound, no noise, no line
    r.at(1000 + WHISTLE_COOLDOWN_MS); r.h.whistleOut(false)
    expect([r.sounds.length, r.noises.length, r.said.length, r.h.read().lastWhistleAt]).toEqual([2, 2, 2, 1000 + WHISTLE_COOLDOWN_MS])
  })
  it('alone where something hunts: \'one. just you.\', +2, and one call in six an answer at the wrong pitch 1.2 s later — dropped by a travel or a death first', () => {
    let r = rig({ echo: true })
    r.h.whistleOut(true)
    expect(r.said).toEqual([['one. just you.', PRIO.interaction]])
    expect(r.h.read().sanity).toBe(50 + SOLO_SANITY)
    expect(r.timers.map(([, ms]) => ms)).toEqual([ECHO.delayMs])
    r.timers[0][0]()
    expect(r.steps).toEqual([ECHO.footfalls])
    expect(r.h.read().sanity).toBe(50 + SOLO_SANITY - ECHO.sanity)
    expect(r.said[1]).toEqual([ECHO_LINE, PRIO.interaction])
    r = rig({ echo: true }); r.h.whistleOut(true); r.h.nextArrival(); r.timers[0][0]()
    expect([r.steps, r.said.length, r.h.read().sanity]).toEqual([[], 1, 50 + SOLO_SANITY])
    r = rig({ echo: false }); r.h.whistleOut(true)
    expect([r.timers, r.h.read().sanity]).toEqual([[], 50 + SOLO_SANITY])
  })
  it('online: the ONE reused frame through the real bus (evKinds lets it through), your pitch by id and name; answered, the count in words and nothing else', () => {
    const sent = []
    const bus = createEvBus({ send: (k, p) => sent.push([k, JSON.parse(JSON.stringify(p))]), now: () => 5000, self: () => ({ x: 4.5, y: 7.25, lvl: 2 }),
      peerPos: () => null, peerIds: () => new Set(), selfId: () => 'me' })
    expect(game).toContain("bus.register('whistle', kinds.whistle)")
    bus.register('whistle', evKinds(() => 'me').whistle)
    const emitted = []
    const r = rig({ mp: { id: 'me', getName: () => 'maddie' }, bus: { emit: (k, p) => { emitted.push(p); return bus.emit(k, p) } }, heard: ['a', 'b'] })
    r.h.whistleOut(true)
    expect(r.sounds).toEqual([[whistlePitch('me', 'maddie'), 0, 1]])
    expect(emitted.length).toBe(1); expect(emitted[0]).toBe(r.callOut)              // the one payload, written in place
    expect(sent.map(([k, p]) => [k, p.x, p.y, p.lvl, p.c])).toEqual([['whistle', 4.5, 7.25, 2, true]])
    expect(r.said).toEqual([['three of you.', PRIO.interaction]])
    expect([r.h.read().sanity, r.timers.length]).toEqual([50, 0])                  // answered: no solo term, no echo
    expect(whistleSrc).not.toMatch(/\{ x: player\.x/)                              // no literal per call
  })
  it('a friend standing on the floor who has not whistled yet: \'nobody has answered yet.\' — never \'just you\', no solo steadying, nothing answers in their place', () => {
    for (const live of [false, true]) {
      const r = rig({ echo: true, mp: { id: 'me', getName: () => 'jo' }, bus: { emit: () => true, freshPeersOnFloor: () => [{ id: 'f', st: 'ok' }] } })
      r.h.whistleOut(live)
      expect([r.said, r.h.read().sanity, r.timers]).toEqual([[[UNANSWERED_LINE, PRIO.interaction]], 50, []])
    }
    const r = rig({ echo: true, mp: { id: 'me', getName: () => 'jo' }, bus: { emit: () => true, freshPeersOnFloor: () => [] } })   // the floor empty of friends: as alone
    r.h.whistleOut(true)
    expect([r.said, r.h.read().sanity, r.timers.length]).toEqual([[['one. just you.', PRIO.interaction]], 50 + SOLO_SANITY, 1])
  })
  it('a friend\'s call (the receive half), lifted and replayed through the real bus: their pitch from where they stand, a people line with the bearing, the roll call, the far bonus once a minute', () => {
    const recv = lift(/bus\.on\('whistle', \(\{ id, name, payload: p \}\) => \{[\s\S]*?\r?\n {4}\}\)/)
    const pos = { near: { x: 3, y: 0 }, far: { x: 20, y: 0 }, other: { x: 1, y: 1 }, liar: { x: 1, y: 1 } }
    let t = 10000
    const bus = createEvBus({ send: () => {}, now: () => t, self: () => ({ x: 0, y: 0, lvl: 1 }), peerPos: (id) => pos[id] ?? null,
      peerIds: () => new Set(Object.keys(pos)), selfId: () => 'me' })
    bus.register('whistle', evKinds(() => 'me').whistle)
    const sounds = [], lines = [], rollcall = createRollCall({ now: () => t }), company = createCompany(), st = {}
    company.add(-40)
    new Function('bus', 'level', 'player', 'performance', 'whistle', 'whistlePitch', 'whistlePan', 'whistleGain', 'radioWasOn', 'addChatLine', 'bearingLabel',
      'rollcall', 'FAR_BONUS', 'company', 'st', `let sanity = 50\n${recv}\nst.sanity = () => sanity`)(bus, { index: 1 }, { x: 0, y: 0, angle: 0 }, { now: () => t },
      (...a) => sounds.push(a), whistlePitch, whistlePan, whistleGain, true, (...a) => lines.push(a), bearingLabel, rollcall, FAR_BONUS, company, st)
    const frame = (id, payload, n) => ({ id, name: id, kind: 'whistle', payload: { c: true, ...payload, n }, t: 1 })
    expect(bus.receive(frame('near', { x: 3, y: 0, lvl: 1 }, 1))).toBe(true)
    expect(sounds).toEqual([[whistlePitch('near', 'near'), whistlePan(3, 0, 0), whistleGain(3, true)]])
    expect(whistleGain(3, true)).toBeCloseTo((1 - 3 / 40) / 2)                    // half under your radio
    expect(lines).toEqual([['near', `whistles · ${bearingLabel(3, 0, 0)}`, true]])  // the people channel, never #msg
    expect(lines[0][1].startsWith('whistles · near ')).toBe(true)
    expect([rollcall.count(t), st.sanity(), company.value]).toEqual([2, 50, 20])  // on the roll call; near: no far bonus
    expect(bus.receive(frame('far', { x: 20, y: 0, lvl: 1 }, 2))).toBe(true)
    expect(lines[1][1].startsWith('whistles · far ')).toBe(true)
    expect([rollcall.count(t), st.sanity(), company.value]).toEqual([3, 50 + FAR_BONUS.sanity, 20 + FAR_BONUS.company])
    t += 9000                                                                       // past the wire's 8 s, inside the bonus's minute
    expect(bus.receive(frame('far', { x: 20, y: 0, lvl: 1 }, 3))).toBe(true)
    expect([sounds.length, st.sanity()]).toEqual([3, 50 + FAR_BONUS.sanity])
    expect(bus.receive(frame('far', { x: 20, y: 0, lvl: 1 }, 4))).toBe(false)       // the same friend inside 8 s
    expect(bus.receive(frame('other', { x: 1, y: 1, lvl: 3 }, 5))).toBe(true)       // another floor's call: believed, not heard
    expect(bus.receive(frame('liar', { x: 4.5, y: 1, lvl: 1 }, 6))).toBe(false)     // not where the list has them
    expect([sounds.length, lines.length, rollcall.count(t)]).toEqual([3, 3, 3])
  })
  it('the roll call ticks once a frame on the list the bus just recounted; a friend unheard, unspoken and apart for 90 s has gone quiet: a murmur, -4, again 90 s on', () => {
    expect(loop).toContain(QUIET)
    expect(count(/rollcall\.tick\(/g)).toBe(1)
    const q = loop.indexOf(QUIET)
    expect(q).toBeGreaterThan(loop.indexOf('if (bus) { bus.tick(performance.now());'))
    expect(q).toBeGreaterThan(loop.indexOf('const kr = kneel.tick(performance.now(), tgt, player)'))
    expect(q).toBeLessThan(loop.indexOf('const th = creaturesOn ? level.entitySys.update('))
    const run = new Function('bus', 'rollcall', 'performance', 'showMessage', 'PRIO', 'QUIET_SANITY', 'st', `let { sanity } = st\n${QUIET}\nst.sanity = sanity`)
    let t = 0
    const rc = createRollCall({ now: () => t }), said = [], st = { sanity: 50 }, peers = [{ id: 'a', name: 'maddie' }]
    const tick = (ms, bus = { freshPeersOnFloor: () => peers }) => { t = ms; run(bus, rc, { now: () => t }, (m, p) => said.push([m, p]), PRIO, QUIET_SANITY, st) }
    tick(0); tick(90000)
    expect(said).toEqual([])                                                        // seated, then not yet
    tick(90001)
    expect(said).toEqual([['it has been a while since maddie. the hall is quiet.', PRIO.ambient]])
    expect(st.sanity).toBe(50 - QUIET_SANITY)
    tick(90002); expect(said.length).toBe(1)
    rc.touch('a', 150000); tick(180002); expect(said.length).toBe(1)               // a touch keeps them counted
    tick(240002); expect(said.length).toBe(2)
    tick(999999, null); expect(said.length).toBe(2)                                  // solo: no bus, no roll call
  })
  it('the touches: a friend\'s chat line (not a system line, not your own) and a fresh friend within six, in the one remote fill', () => {
    const chatSrc = lift(/function addChatLine\(from, text, isSystem, id\) \{[\s\S]*?\r?\n {2}\}/)
    expect(chatSrc).toMatch(/JOIN_SAY_MS\); return \}\r?\n\s*if \(id && !isSystem && mpClient && id !== mpClient\.id\) rollcall\.touch\(id, performance\.now\(\)\)/)
    const chatWith = (rc, clock) => new Function('JOINED_LINE', 'JOIN_SAY_MS', 'bus', 'setTimeout', 'joinedLine', 'chatLines', 'renderChat', 'mpClient', 'blip', 'rollcall', 'performance',
      `${chatSrc}\nreturn addChatLine`)('entered the level.', 2000, {}, () => {}, () => '', [], () => {}, { id: 'me', getName: () => 'jo' }, () => {}, rc, clock)
    let t = 0
    const seat = [{ id: 'a', name: 'maddie' }]
    let rc = createRollCall({ now: () => t }); rc.tick(0, seat)
    t = 80000; chatWith(rc, { now: () => t })('maddie', 'over here', false, 'a')
    expect(rc.tick(90001, seat)).toEqual([])                                         // she spoke: not quiet
    rc = createRollCall({ now: () => t }); rc.tick(0, seat)
    const add = chatWith(rc, { now: () => t })
    add('maddie', 'whistles · near ↑', true); add('jo', 'hello?', false, 'me'); add('maddie', 'a line with no id', false)
    expect(rc.tick(90001, seat).map((e) => e.id)).toEqual(['a'])                     // none of those is her speaking
    const fillSrc = lift(/function fillRemotes\(\) \{[\s\S]*?\r?\n {2}\}/)
    expect(fillSrc).toMatch(/if \(!bus\.fresh\(rp\.id\)\) \{[^\n]*\}\r?\n\s*else if \(\(rp\.x - player\.x\) \*\* 2 \+ \(rp\.y - player\.y\) \*\* 2 < 36\) rollcall\.touch\(rp\.id, now\)/)
    const list = [{ id: 'near', x: 5, y: 0 }, { id: 'far', x: 7, y: 0 }, { id: 'stale', x: 1, y: 0 }], fresh = new Set(['near', 'far'])
    rc = createRollCall({ now: () => t }); rc.tick(0, list)
    const fill = new Function('remoteOnFloor', 'peerIdSet', 'peerRec', 'mpClient', 'bus', 'player', 'rollcall', 'performance', `${fillSrc}\nreturn fillRemotes`)(
      [], new Set(), new Map(), { getRemotePlayers: () => list.map((r) => ({ ...r })) }, { onFloor: () => true, fresh: (id) => fresh.has(id) }, { x: 0, y: 0 }, rc, { now: () => t })
    t = 80000; fill()
    expect(rc.tick(90001, list).map((e) => e.id)).toEqual(['far', 'stale'])         // within six and fresh: touched; seven off, or a stale record: not
  })
  it('the hint row, the README and the field manual say it; every whistle line is lowercase, in-fiction, no exclamation', () => {
    expect(html).toContain('<span>x set down</span> · <span>c whistle</span><span class="k-map"> · tab map</span>')
    const readme = read('../README.md'), manual = read('../docs/manual.html')
    expect(readme).toMatch(/^\| x · set down \| [^\n]*\r?\n\| c · whistle \| call out — a two-note whistle the floor and your friends hear; the things hear it too \|$/m)
    expect(readme).toContain('**the whistle (c).**')
    expect(manual).toContain('<span class="k"><kbd>C</kbd></span><span class="d"><b>whistle</b>')
    expect(manual).toContain('<h3 style="font-size:15px">Call out</h3>')
    for (const s of [NO_ANSWER_LINE, ECHO_LINE, countLine(1), countLine(2), countLine(7), countLine(40)]) { expect(s).toBe(s.toLowerCase()); expect(s).not.toContain('!') }
  })
})

describe('I11 (W6): the caches — a thing set down with a word, read on the card, the room told, the floor remembering it', () => {
  const loop = game.slice(loopAt)
  const lift = (re) => { const m = game.match(re); expect(m, String(re)).not.toBeNull(); return m[0] }
  const ITEM_NAMES = new Function(`return ${lift(/const ITEM_NAMES = \{[\s\S]*?\n\}/).replace(/^const ITEM_NAMES = /, '')}`)()
  const setDownSrc = slice('function setDown() {', "document.getElementById('btn-discard')?.addEventListener('click', setDown)")
  const pickupSrc = lift(/if \(res\.ok && res\.item\.cacheKey\) \{[\s\S]*?\r?\n {10}\}/)
  const cacheOn = lift(/bus\.on\('cache', \(\{ id, name, payload: p, replay \}\) => \{[\s\S]*?\r?\n {4}\}\)/)
  const takeOn = lift(/bus\.on\('take', \(\{ id, payload: \{ key \}, replay \}\) => \{[\s\S]*?\r?\n {4}\}\)/)
  const regs = ['cache', 'take'].map((k) => lift(new RegExp(`bus\\.register\\('${k}'[^\\n]*`)))
  const replace = slice('for (const c of ledger.pendingFor(index)) {', '// the keys still spent at this visit')
  const HERE_F = { lvl: 1, lit: false, st: 'ok', seen: false, o: null, thin: false, status: 'notice-mailed', aseed: null, v: 1 }
  // setDown / throwSelected / removeCache / relayLater lifted out of game.js, their world faked around the REAL items, ledger and floors' memory
  const readySrc = lift(/const cacheReady = [^\n]*/)
  const mkSetDown = (deps) => new Function(...Object.keys(deps), `${readySrc}\n${setDownSrc}\nreturn { setDown, throwSelected, removeCache, relayLater }`)(...Object.values(deps))
  function rig({ inv = ['bandage'], cardEl = {}, bus = null, id = null, name = 'wanderer', level = { index: 1 }, readSet = new Set() } = {}) {
    const items = createItemSystem({ ...DEFAULT_CONFIG }, () => false, 0)
    for (const t of inv) items.grant(t, t === 'plumb' ? { tool: true } : {})
    items.select(0)
    const out = { said: [], cards: [], hot: 0, cancels: 0 }
    const ledger = createCacheLedger(), evOutbox = [], mem = createLevelMemory(), player = { x: 10.5, y: 10.5, angle: 0 }
    const h = mkSetDown({ itemSys: items, noteCardEl: cardEl, KEPT, showMessage: (m) => out.said.push(m), menuFor, level, openCard: (mode, opts) => { out.cards.push([mode, opts]); return {} },
      ITEM_NAMES, PHRASES, NOTE_NONE, octOf, player, myName: () => name, myId: () => id, playT: 42, cancelCommit: () => out.cancels++, cacheKey, ledger,
      renderHotbar: () => out.hot++, mem, bus, evOutbox, readSet })
    return { h, items, out, ledger, evOutbox, mem, player, level }
  }

  it('imports caches.js, KEPT and readText by their real names; caches.js is in both offline shells; nothing of W6 is left to do', () => {
    expect(game).toMatch(/import \{ PHRASES, NOTE_NONE, menuFor, cacheKey, parseCacheKey, octOf, arrowFor, isCachePayload, isTakePayload, extraFor, createCacheLedger, NAME_CAP_EXEMPT \} from '\.\/caches\.js'/)
    expect(game).toMatch(/import \{ createItemSystem, KEPT \} from '\.\/items\.js'/)
    expect(game).toMatch(/import \{ createCard, CARD_KEYS, readText \} from '\.\/papercard\.js'/)
    expect(sw).toContain("'/renderer/caches.js'"); expect(build).toContain("'caches.js'")
    expect(game).not.toMatch(/TODO\(integrate:W6\)/)
    for (const s of ['const ledger = createCacheLedger()', 'const evOutbox = []', 'const OUTBOX_MARGIN_MS = 250',
      'const isMine = (rec) => (rec.byId ?? null) === myId() || (rec.by != null && rec.by === myName() && !NAME_CAP_EXEMPT.includes(rec.by))',
      "const cacheReady = () => !bus || (!evOutbox.length && bus.ready('cache'))"]) {
      expect(at(s), s).toBeLessThan(loopAt)
      expect(game.split(s).length - 1, s).toBe(1)
    }
    expect(count(/createCacheLedger\(/g)).toBe(1)
  })
  it('X and the dock\'s ✕ both ask on the card (setDown); the ONE items.throwSelected call carries the note; without the card element X is today\'s', () => {
    expect(loop).toContain("if (K['KeyX']) { K['KeyX'] = false; setDown() }")
    expect(game).toContain("document.getElementById('btn-discard')?.addEventListener('click', setDown)")
    expect(count(/itemSys\.throwSelected\(/g)).toBe(1)
    expect(game).toContain('const r = itemSys.throwSelected(player.x, player.y, player.angle, playT, note)')
    expect(setDownSrc).toContain('if (!it || !noteCardEl) { throwSelected(null); return }')
    expect(count(/function setDown\(/g)).toBe(1)
  })
  it('set down, lifted and replayed: the card offers the floor\'s six for this thing; a word makes a cache (the landing cell its key, yours, the hand empty); nothing is today\'s drop', () => {
    let r = rig()
    r.h.setDown()
    expect(r.out.cards.length).toBe(1)
    const [mode, opts] = r.out.cards[0]
    const menu = menuFor(1, 'bandage')
    expect(mode).toBe('choose')
    expect(opts.menu).toEqual(menu.map((i) => PHRASES[i]))
    expect(opts.text).toBe('leave a word with the bandage, for whoever finds it.')
    expect(chooseLines(opts.menu).at(-1)).toBe('0 · nothing')
    expect(r.items.inventory.length).toBe(1)                                         // only peeked while the card is up
    opts.onPick(2)
    const row = r.items.getDropped()
    expect(row).toEqual([{ x: 11.7, y: 10.5, type: 'bandage', ph: menu[2], oct: 0, by: 'wanderer', cacheKey: 'c:1:11,10' }])   // solo: no id, so it is yours
    expect(r.ledger.get('c:1:11,10')).toMatchObject({ lvl: 1, cx: 11, cy: 10, id: null, name: 'wanderer', t: 42, localKey: 'd:0', pending: null })
    expect([r.out.said, r.out.cancels, r.out.hot, r.items.inventory.length, r.evOutbox.length]).toEqual([['you set it down.'], 1, 1, 0, 0])   // solo: nobody to tell
    // nothing (0, Esc): today's plain drop, byte for byte
    r = rig(); r.h.setDown(); r.out.cards[0][1].onPick(null)
    expect(r.items.getDropped()).toEqual([{ x: 11.7, y: 10.5, type: 'bandage' }])
    expect([r.out.said, r.ledger.size]).toEqual([['you drop the bandage.'], 0])
    // the finds are refused before anything is offered; an empty hand is silent; no card element: X exactly as it was
    r = rig({ inv: ['plumb'] }); r.h.setDown()
    expect([r.out.cards.length, r.out.said, r.items.inventory.length]).toEqual([0, ['you do not put that down.'], 1])
    r = rig({ inv: [] }); r.h.setDown()
    expect([r.out.cards.length, r.out.said, r.out.hot]).toEqual([0, [], 1])
    r = rig({ cardEl: null }); r.h.setDown()
    expect([r.out.cards.length, r.out.said, r.items.getDropped()]).toEqual([0, ['you drop the bandage.'], [{ x: 11.7, y: 10.5, type: 'bandage' }]])
    // a talking radio keeps its own line with a word too
    r = rig({ inv: ['radio'] }); r.items.inventory[0].on = true; r.h.setDown(); r.out.cards[0][1].onPick(0)
    expect(r.out.said).toEqual(['you set the radio down, still talking. let it talk.'])
    expect(r.items.getDropped()[0]).toMatchObject({ on: true, ph: menuFor(1, 'radio')[0], cacheKey: 'c:1:11,10' })
  })
  // F12: the words on the card are the part of the record you found — the pages read, once they hold six phrases
  it('F12: the card offers only phrases from the pages you have read, once there are six of them; before that, the floor\'s six', () => {
    expect(setDownSrc).toContain('const menu = menuFor(level.index, it.type, readSet)')
    const readSet = new Set([12, 3, 6])                                                       // the fork, the almond water, the whistle
    let r = rig({ readSet }); r.h.setDown()
    expect(r.out.cards[0][1].menu).toEqual(menuFor(1, 'bandage', readSet).map((i) => PHRASES[i]))
    for (const ph of r.out.cards[0][1].menu) expect(readSet.has(PHRASE_FRAG[PHRASES.indexOf(ph)])).toBe(true)
    r.out.cards[0][1].onPick(1)
    expect(r.items.getDropped()[0].ph).toBe(menuFor(1, 'bandage', readSet)[1])
    r = rig({ readSet: new Set([12]) }); r.h.setDown()
    expect(r.out.cards[0][1].menu).toEqual(menuFor(1, 'bandage').map((i) => PHRASES[i]))
  })
  it('online: a cache leaves at once or not at all (your hands are not ready); a take waits in the outbox, in order, and leaves past its gap with a margin', () => {
    let ok = true
    const sent = []
    const bus = { emit: (k, p, o) => { if (!ok) return false; sent.push([k, JSON.parse(JSON.stringify(p)), o]); return true }, ready: () => ok }
    const r = rig({ inv: ['almond-water', 'bandage', 'glowstick'], bus, id: 'me', name: 'maddie' })
    r.items.inventory[0].sour = true
    r.h.setDown(); r.out.cards[0][1].onPick(1)
    const ph = menuFor(1, 'almond-water')[1]
    expect(sent).toEqual([['cache', { lvl: 1, cx: 11, cy: 10, x: 11.7, y: 10.5, type: 'almond-water', ex: { sour: true }, ph, oct: 0 }, { keep: 'c:1:11,10' }]])
    expect(r.items.getDropped()[0]).toMatchObject({ sour: true, by: 'maddie', byId: 'me' })
    expect(isCachePayload(sent[0][1], ITEM_NAMES)).toBe(true)
    ok = false
    r.player.x = 20.5; r.h.setDown(); r.out.cards[1][1].onPick(0)                    // inside the gap: it stays in your hands, nothing queued
    expect([r.out.said.at(-1), r.items.inventory.map((i) => i.type), r.items.getDropped().length, r.ledger.size, r.evOutbox]).toEqual(
      ['your hands are not ready.', ['bandage', 'glowstick'], 1, 1, []])
    r.h.relayLater('take', { key: 'c:1:5,5' }, { drop: 'c:1:5,5' })                 // a take inside its gap waits
    ok = true
    r.player.x = 30.5; r.h.setDown(); r.out.cards[2][1].onPick(0)                    // the gap is open, but a take still waits: never ahead of it
    expect([r.out.said.at(-1), r.items.getDropped().length, r.evOutbox.map(([k, p]) => [k, p.key])]).toEqual(['your hands are not ready.', 1, [['take', 'c:1:5,5']]])
    // the loop's flush, lifted: it asks ready(kind, margin) and lets each out once
    const flush = lift(/if \(bus\) while \(evOutbox\.length && bus\.ready\(evOutbox\[0\]\[0\], OUTBOX_MARGIN_MS\)\) \{ const o = evOutbox\.shift\(\); bus\.emit\(o\[0\], o\[1\], o\[2\]\) \}/)
    const asked = []
    new Function('bus', 'evOutbox', 'OUTBOX_MARGIN_MS', flush)({ ready: (k, m) => { asked.push([k, m]); return ok }, emit: bus.emit }, r.evOutbox, 250)
    expect([asked, sent.map(([k, p]) => [k, p.cx ?? p.key]), r.evOutbox]).toEqual([[['take', 250]], [['cache', 11], ['take', 'c:1:5,5']], []])
    r.h.setDown(); r.out.cards[3][1].onPick(0)                                       // now it lands, and leaves the frame it lands in
    expect(sent.map(([k, p]) => [k, p.cx ?? p.key])).toEqual([['cache', 11], ['take', 'c:1:5,5'], ['cache', 31]])
    expect(loop.indexOf(flush)).toBeGreaterThan(loop.indexOf('if (bus) { bus.tick(performance.now());'))
  })
  it('yours across a reconnect: the id is new each join, so your own name is yours too — never \'wanderer\', the name everybody has', () => {
    const src = lift(/const isMine = [^\n]*/)
    const mine = (id, name) => new Function('myId', 'myName', 'NAME_CAP_EXEMPT', `${src}\nreturn isMine`)(() => id, () => name, NAME_CAP_EXEMPT)
    const now = mine('p2', 'sasha')
    expect(now({ byId: 'p2', by: 'sasha' })).toBe(true)                           // this connection
    expect(now({ byId: 'p1', by: 'sasha' })).toBe(true)                           // an earlier one, replayed by the relay: 'you left this.', no +4
    expect(now({ byId: 'p9', by: 'maddie' })).toBe(false)
    const anon = mine('p2', 'wanderer')
    expect(anon({ byId: 'p1', by: 'wanderer' })).toBe(false)                      // a stranger with the default name stays a stranger
    expect(mine(null, 'wanderer')({ by: 'wanderer' })).toBe(true)                 // solo: no id, every cache yours (as before)
  })
  it('two real buses, wired as game.js wires them: a walking friend\'s second cache is believed (it leaves where she stands, never late), and two takes in a breath survive the jitter', () => {
    let tA = 0, tB = 0
    const wire = []
    const pos = { a: { x: 10.5, y: 10.5 } }                                            // where B's players list has her
    const A = createEvBus({ send: (k, p, o) => wire.push({ kind: k, payload: JSON.parse(JSON.stringify(p)) }), now: () => tA, self: () => ({ x: 0, y: 0, lvl: 1 }),
      peerPos: () => null, peerIds: () => new Set(), selfId: () => 'a' })
    const B = createEvBus({ send: () => {}, now: () => tB, self: () => ({ x: 0, y: 0, lvl: 1 }), peerPos: (id) => pos[id] ?? null, peerIds: () => new Set(['a']), selfId: () => 'b' })
    for (const bus of [A, B]) new Function('bus', 'isCachePayload', 'isTakePayload', 'ITEM_NAMES', regs.join('\n'))(bus, isCachePayload, isTakePayload, ITEM_NAMES)
    const r = rig({ inv: ['almond-water', 'bandage'], bus: A, id: 'a', name: 'ada' })
    const deliver = (i, at) => { tB = at; return B.receive({ id: 'a', name: 'ada', kind: wire[i].kind, payload: wire[i].payload, t: 1 }) }
    const walk = (to) => { r.player.x = to; pos.a.x = to }
    const flush = new Function('bus', 'evOutbox', 'OUTBOX_MARGIN_MS', lift(/if \(bus\) while \(evOutbox\.length && bus\.ready\([^\n]*/))
    // three cells a second: one set down at 0; the next tried at 1 s stays in her hands; set down at 3.1 s, from where she stands then
    r.h.setDown(); r.out.cards[0][1].onPick(0)
    const got = [deliver(0, 80)]
    tA = 1000; walk(13.5); r.h.setDown(); r.out.cards[1][1].onPick(0)
    expect([r.out.said.at(-1), wire.length]).toEqual(['your hands are not ready.', 1])
    tA = 3100; walk(19.8); r.h.setDown(); r.out.cards[2][1].onPick(0)
    got.push(deliver(1, 3130))                                                         // quicker on the wire than the first
    expect(got).toEqual([true, true])
    // two takes in a breath: the second waits in the outbox and leaves past the gap with the margin; 80 ms then 30 ms on the wire
    tA = 4000; r.h.relayLater('take', { key: 'c:1:11,10' }, { drop: 'c:1:11,10' })
    tA = 4100; r.h.relayLater('take', { key: 'c:1:21,10' }, { drop: 'c:1:21,10' })
    for (let t = 4100; t <= 5000; t += 16) { tA = t; flush(A, r.evOutbox, 250) }
    expect([wire.length, r.evOutbox.length]).toEqual([4, 0])
    expect([deliver(2, 4080), deliver(3, 4750 + 30)]).toEqual([true, true])
  })
  it('one live cache a cell (the newest wins), six an owner (the oldest goes): the record leaves the world; another floor\'s is taken out of that floor\'s memory', () => {
    const r = rig({ inv: ['bandage', 'bandage'], id: 'me', name: 'maddie' })
    r.h.setDown(); r.out.cards[0][1].onPick(0)
    r.h.setDown(); r.out.cards[1][1].onPick(3)                                       // the same landing cell
    expect(r.items.getDropped().map((d) => [d.cacheKey, d.ph])).toEqual([['c:1:11,10', menuFor(1, 'bandage')[3]]])
    expect(r.ledger.size).toBe(1)
    const rr = rig({ inv: [], id: 'me', name: 'maddie' })
    for (let i = 0; i < 7; i++) {
      rr.items.grant('bandage'); rr.items.select(0)
      rr.player.x = 10.5 + i * 3; rr.h.setDown(); rr.out.cards[i][1].onPick(0)
    }
    expect(rr.ledger.size).toBe(6)
    expect(rr.items.getDropped().map((d) => d.cacheKey)).not.toContain('c:1:11,10')            // the first one is gone from the floor
    expect(rr.items.getDropped().length).toBe(6)
    // another floor: its memory loses the row; a pending one was never laid down
    rr.mem.setDropped(2, [{ x: 1.5, y: 1.5, type: 'bandage', cacheKey: 'c:2:1,1' }, { x: 3.5, y: 3.5, type: 'glowstick' }])
    rr.h.removeCache({ key: 'c:2:1,1', lvl: 2, localKey: 'd:9', pending: null })
    expect(rr.mem.droppedFor(2)).toEqual([{ x: 3.5, y: 3.5, type: 'glowstick' }])
    rr.h.removeCache({ key: 'c:2:3,3', lvl: 2, localKey: null, pending: { x: 3.5, y: 3.5, type: 'bandage', extra: {} } })
    expect(rr.mem.droppedFor(2).length).toBe(1)
    rr.h.removeCache({ key: 'c:3:0,0', lvl: 3, localKey: null, pending: null })     // a floor you never stood on: nothing made up for it
    expect(rr.mem.get(3)).toBeNull()
    expect(count(/mem\.setDropped\(/g)).toBe(4)
  })
  it('F on a cache, lifted and replayed: the word read on the card (whose, the arrow from where you stand), +4 for a stranger\'s, the ledger and the room let go of it', () => {
    expect(game).toMatch(/if \(res\.ok\) \{ showMessage\(`you take the \$\{ITEM_NAMES\[res\.item\.type\] \?\? res\.item\.type\}\.`\); if \(!nearItem\.key\.startsWith\('d:'\)\) mem\.noteTaken\(level\.index, nearItem\.key\) \}[^\n]*\r?\n\s*else if \(res\.reason === 'full'\) showMessage\('your hands are full\.'\)\r?\n(\s*\/\/[^\n]*\r?\n)*\s*if \(res\.ok && res\.item\.cacheKey\) \{/)
    expect(pickupSrc).toContain('if (!isMine(res.item)) sanity = Math.min(100, sanity + 4)')
    const run = new Function('res', 'isMine', 'st', 'ledger', 'relayLater', 'openCard', 'readText', 'PHRASES', 'arrowFor', 'player', `let { sanity } = st\n${pickupSrc}\nst.sanity = sanity`)
    const go = (rec, mine, angle = 0) => {
      const items = createItemSystem({ ...DEFAULT_CONFIG }, () => false, 0), ledger = createCacheLedger(), cards = [], relayed = [], st = { sanity: 50 }
      const d = items.dropAt(5.5, 5.5, 'bandage', rec, null)
      ledger.place({ key: rec.cacheKey, lvl: 1, cx: 5, cy: 5, id: rec.byId ?? null, name: rec.by ?? null })
      const res = items.pickUp(d.key)
      run(res, () => mine, st, ledger, (...a) => relayed.push(a), (m, o) => cards.push([m, o]), readText, PHRASES, arrowFor, { angle })
      return { cards, relayed, st, ledger, inv: items.inventory }
    }
    let o = go({ ph: 2, oct: 0, by: 'maddie', byId: 'f', cacheKey: 'c:1:5,5' }, false)
    expect(o.cards).toEqual([['read', { text: `${PHRASES[2]} ↑\n— maddie`, foot: READ_FOOT }]])
    expect([o.st.sanity, o.relayed, o.ledger.size, o.inv]).toEqual([54, [['take', { key: 'c:1:5,5' }, { drop: 'c:1:5,5' }]], 0, [{ type: 'bandage' }]])
    o = go({ ph: 9, oct: 2, by: 'wanderer', cacheKey: 'c:1:5,5' }, true, Math.PI / 2)           // your own, read facing the other way
    expect(o.cards).toEqual([['read', { text: `${PHRASES[9]} ${arrowFor(2, Math.PI / 2)}\n— you left this.`, foot: READ_FOOT }]])
    expect(o.st.sanity).toBe(50)
    // the prompt says whose it is (the record itself is the prompt's nearItem)
    expect(game).toContain("itemHintEl.textContent = `f · take the ${ITEM_NAMES[nearItem.type] ?? nearItem.type}` + (nearItem.cacheKey ? (isMine(nearItem) ? ' · yours' : ` · left by ${nearItem.by ?? 'wanderer'}`) : '')")
  })
  it('the room through the real bus: the registrations as lifted; a live cache here is laid down with whose it is and a people line, a replay silently, another floor\'s waits; a take removes it', () => {
    const pos = { f: { x: 20.5, y: 10.5 } }
    let t = 10000
    const bus = createEvBus({ send: () => {}, now: () => t, self: () => ({ x: 10, y: 10, lvl: 1 }), peerPos: (id) => pos[id] ?? null, peerIds: () => new Set(Object.keys(pos)), selfId: () => 'me' })
    new Function('bus', 'isCachePayload', 'isTakePayload', 'ITEM_NAMES', regs.join('\n'))(bus, isCachePayload, isTakePayload, ITEM_NAMES)
    const level = { index: 1, grid: { floor: (x, y) => !(x === 40 && y === 10) } }
    const r = rig({ level, id: 'me', name: 'jo' }), lines = []
    new Function('bus', 'level', 'cacheKey', 'ledger', 'playT', 'extraFor', 'removeCache', 'findOpenNear', 'itemSys', 'addChatLine', 'parseCacheKey', 'peerPos', `${cacheOn}\n${takeOn}`)(
      bus, level, cacheKey, r.ledger, 7, extraFor, r.h.removeCache, findOpenNear, r.items, (...a) => lines.push(a), parseCacheKey, (id) => pos[id] ?? null)
    const frame = (id, payload, n, extra = {}) => ({ id, name: id === 'f' ? 'maddie' : id, kind: 'cache', payload: { ...payload, n }, t: 1, ...extra })
    const p = { lvl: 1, cx: 20, cy: 10, x: 20.5, y: 10.5, type: 'almond-water', ex: { sour: true }, ph: 3, oct: 2 }
    expect(bus.receive({ id: 'f', name: 'maddie', kind: 'here', payload: { ...HERE_F, n: 0 }, t: 1 })).toBe(true)   // her heartbeat: floor 1
    expect(bus.receive(frame('f', p, 1))).toBe(true)
    expect(r.items.getDropped()).toEqual([{ x: 20.5, y: 10.5, type: 'almond-water', sour: true, ph: 3, oct: 2, by: 'maddie', byId: 'f', cacheKey: 'c:1:20,10' }])
    expect(lines).toEqual([['maddie', 'sets something down.', true]])
    expect(r.ledger.get('c:1:20,10')).toMatchObject({ id: 'f', name: 'maddie', localKey: 'd:0' })
    t += 1000
    expect(bus.receive(frame('f', { ...p, cx: 21, x: 21.5 }, 2))).toBe(false)                     // inside the 3 s gap
    t += 3000
    expect(bus.receive(frame('f', { ...p, cx: 24, x: 24.5 }, 3))).toBe(false)                     // not where the list has them
    expect(bus.receive(frame('f', { ...p, ph: 12 }, 4))).toBe(false)                             // not one of the twelve
    expect(bus.receive(frame('g', { ...p, cx: 40, x: 40.5 }, 1, { replay: true }))).toBe(true)  // the relay's keep, on a cell that is wall here now
    expect(r.items.getDropped()[1]).toMatchObject({ x: 40.5, y: 9.5, by: 'g', byId: 'g', cacheKey: 'c:1:40,10' })
    expect(lines.length).toBe(1)                                                                // a replay says nothing
    expect(bus.receive(frame('g', { ...p, lvl: 2, cx: 3, cy: 3, x: 3.5, y: 3.5 }, 2, { replay: true }))).toBe(true)
    expect([r.items.getDropped().length, r.ledger.pendingFor(2).map((e) => e.key)]).toEqual([2, ['c:2:3,3']])
    expect(bus.receive({ id: 'f', name: 'maddie', kind: 'take', payload: { key: 'c:1:20,10', n: 9 }, t: 1 })).toBe(true)
    expect(r.items.getDropped().map((d) => d.cacheKey)).toEqual(['c:1:40,10'])
    expect(r.ledger.get('c:1:20,10')).toBeNull()
    expect(bus.receive({ id: 'f', name: 'maddie', kind: 'take', payload: { key: 'c:2:3,3', n: 10 }, t: 1 })).toBe(false)   // inside the take's 0.5 s
    t += 600
    expect(bus.receive({ id: 'f', name: 'maddie', kind: 'take', payload: { key: 'c:2:3,3', n: 11 }, t: 1 })).toBe(true)
    expect(r.ledger.pendingFor(2).map((e) => e.key)).toEqual(['c:2:3,3'])                     // live, from floor 1: not hers to take
    expect(bus.receive({ id: 'g', name: 'g', kind: 'take', payload: { key: 'c:2:3,3', n: 20 }, t: 1, replay: true })).toBe(true)
    expect(r.ledger.pendingFor(2)).toEqual([])                                                  // the relay's take: never laid down, never will be
    expect(bus.receive({ id: 'f', name: 'maddie', kind: 'take', payload: { key: 'x', n: 12 }, t: 1, replay: true })).toBe(false)
    for (const s of regs) expect(s).toMatch(/replayable: true/)
    expect(regs[0]).toContain("posKeys: ['x', 'y'], minGapMs: 3000")
    expect(regs[1]).toContain('minGapMs: 500')
  })
  // RN-4: a key is tied to the one who sends it — a live take only from a fresh friend on its floor within 3 of its cell; a live cache only
  // for the floor their 'here' says, and only on the cell it lies in
  it('RN-4: nobody erases a cache from across the building — a far take, a take from another floor or a stale friend, a cache keyed to a far cell or another floor: refused', () => {
    const pos = { f: { x: 20.5, y: 10.5 } }
    let t = 10000
    const bus = createEvBus({ send: () => {}, now: () => t, self: () => ({ x: 10, y: 10, lvl: 1 }), peerPos: (id) => pos[id] ?? null, peerIds: () => new Set(Object.keys(pos)), selfId: () => 'me' })
    new Function('bus', 'isCachePayload', 'isTakePayload', 'ITEM_NAMES', regs.join('\n'))(bus, isCachePayload, isTakePayload, ITEM_NAMES)
    const level = { index: 1, grid: { floor: () => true } }
    const r = rig({ level, id: 'me', name: 'jo' })
    new Function('bus', 'level', 'cacheKey', 'ledger', 'playT', 'extraFor', 'removeCache', 'findOpenNear', 'itemSys', 'addChatLine', 'parseCacheKey', 'peerPos', `${cacheOn}\n${takeOn}`)(
      bus, level, cacheKey, r.ledger, 7, extraFor, r.h.removeCache, findOpenNear, r.items, () => {}, parseCacheKey, (id) => pos[id] ?? null)
    let n = 0
    const take = (key, extra = {}) => bus.receive({ id: 'f', name: 'maddie', kind: 'take', payload: { key, n: n++ }, t: 1, ...extra })
    const cache = (p) => bus.receive({ id: 'f', name: 'maddie', kind: 'cache', payload: { type: 'bandage', ph: 0, oct: 0, ...p, n: n++ }, t: 1 })
    // two caches of mine: one far down the hall on this floor, one waiting on floor 2
    r.ledger.place({ key: 'c:1:300,300', lvl: 1, cx: 300, cy: 300, id: 'me', name: 'jo' })
    r.ledger.place({ key: 'c:2:20,10', lvl: 2, cx: 20, cy: 10, id: 'me', name: 'jo', pending: { x: 20.5, y: 10.5, type: 'bandage', extra: {} } })
    expect(bus.receive({ id: 'f', name: 'maddie', kind: 'here', payload: { ...HERE_F, n: n++ }, t: 1 })).toBe(true)
    take('c:1:300,300'); t += 600
    take('c:3:300,300'); t += 600                                                                // a floor she is not on, a cell nobody has
    take('c:2:20,10'); t += 600                                                                  // her cell, but floor 2: she stands on 1
    expect([r.ledger.get('c:1:300,300') !== null, r.ledger.get('c:2:20,10') !== null]).toEqual([true, true])
    // a cache keyed to a far cell is not a cache at all; one keyed to her own cell on a floor she is not on is not believed either
    expect(cache({ lvl: 1, cx: 300, cy: 300, x: 20.5, y: 10.5 })).toBe(false)
    t += 3100
    expect(cache({ lvl: 2, cx: 20, cy: 10, x: 20.5, y: 10.5 })).toBe(true)
    expect(r.ledger.get('c:2:20,10')).toMatchObject({ id: 'me' })                               // still mine: nothing replaced it
    // within 3 of the cell, on its floor, fresh: taken
    pos.f = { x: 302, y: 300.5 }; t += 600
    take('c:1:300,300')
    expect(r.ledger.get('c:1:300,300')).toBeNull()
    // a friend whose heartbeat stopped 8 s ago is not believed live; the relay's replay of a take still is
    r.ledger.place({ key: 'c:1:301,300', lvl: 1, cx: 301, cy: 300, id: 'me', name: 'jo' })
    t += 9000
    take('c:1:301,300')
    expect(r.ledger.get('c:1:301,300')).not.toBeNull()
    take('c:1:301,300', { replay: true })
    expect(r.ledger.get('c:1:301,300')).toBeNull()
  })
  it('buildLevel lays down what waited for this floor (the nearest open cell, or gone) and rebinds the floor\'s caches, between the items and the vend memory', () => {
    const enter = buildBody.indexOf('itemSys.enterLevel(cfg, cfg.map ? null : mem.takenFor(index), cfg.map ? null : mem.droppedFor(index))')
    expect(enter).toBeGreaterThan(0)
    expect(buildBody.indexOf('for (const c of ledger.pendingFor(index)) {')).toBeGreaterThan(enter)
    expect(buildBody.indexOf('ledger.clearPending(index); ledger.rebind(index, itemSys.getWorldItems())')).toBeLessThan(buildBody.indexOf('vendedSet = mem.vendedFor(index,'))
    expect(buildBody.indexOf('ledger.clearPending(index); ledger.rebind(index, itemSys.getWorldItems())')).toBeGreaterThan(buildBody.indexOf('for (const c of ledger.pendingFor(index)) {'))
    const items = createItemSystem({ ...DEFAULT_CONFIG }, () => false, 0), ledger = createCacheLedger()
    items.enterLevel({ ...DEFAULT_CONFIG }, null, [{ x: 5.5, y: 5.5, type: 'bandage', ph: 1, oct: 0, by: 'jo', cacheKey: 'c:2:5,5' }])   // yours, from the floor's memory
    const wait = (cx, cy, extra) => ledger.place({ key: cacheKey(2, cx, cy), lvl: 2, cx, cy, id: 'f', name: 'maddie', t: cx, pending: { x: cx + 0.5, y: cy + 0.5, type: 'glowstick', extra } })
    wait(8, 8, extraFor({ ph: 4, oct: 1 }, 'f', 'maddie', 'c:2:8,8'))
    wait(12, 8, extraFor({ ph: 5, oct: 1 }, 'f', 'maddie', 'c:2:12,8'))
    wait(60, 8, extraFor({ ph: 6, oct: 1 }, 'f', 'maddie', 'c:2:60,8'))
    const grid = { floor: (x, y) => !(x === 12 && y === 8) && !(x >= 50 && x <= 70) }        // one cell walled up, one whole region
    new Function('ledger', 'index', 'grid', 'findOpenNear', 'itemSys', replace)(ledger, 2, grid, findOpenNear, items)
    expect(items.getDropped().map((d) => [d.cacheKey, d.x, d.y])).toEqual([['c:2:5,5', 5.5, 5.5], ['c:2:8,8', 8.5, 8.5], ['c:2:12,8', 12.5, 7.5]])
    expect(ledger.get('c:2:60,8')).toBeNull()                                                   // nothing open within three: gone
    expect(ledger.pendingFor(2)).toEqual([])
    expect(ledger.get('c:2:5,5')).toMatchObject({ name: 'jo', localKey: 'd:0' })               // adopted from what the floor remembered
    expect(ledger.get('c:2:8,8').localKey).toBe('d:1')
  })
  describe('the caches\' index through save.js, the way game.js writes and reads it', () => {
    afterEach(() => vi.unstubAllGlobals())
    const stub = () => { const store = new Map(); vi.stubGlobal('localStorage', { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }) }
    it('snapshot adds `caches` after the fog; the resume restores it right under the identity, above the pinned clock line', () => {
      const snap = slice('function snapshot(full = false) {', 'let saveTimer = 0')
      expect(snap.indexOf('s.caches = ledger.snapshot()')).toBeGreaterThan(snap.indexOf('s.fog = fogExport'))
      expect(resumeBody).toMatch(/rules = rulesFor\(origin, thin\); evConfig\.events = rules\.eventWeights\(\)\r?\n\s*ledger\.restore\(resume\.caches\)[^\n]*\r?\n\s*playT = Number\(resume\.playT\) \|\| 0\r?\n\s*const r = applyResume\(resume, \{/)
    })
    it('a v:1 save without `caches` resumes with an empty index; one with an own cache restores it (where it lies is the floors\' memory)', () => {
      stub()
      writeSave({ level: 1, x: 2.5, y: 2.5, playT: 40 })
      const a = createCacheLedger(); a.restore(readSave().caches)
      expect(a.size).toBe(0)
      const own = createCacheLedger(); own.place({ key: 'c:1:11,10', lvl: 1, cx: 11, cy: 10, id: null, name: 'wanderer', t: 42 }); own.bind('c:1:11,10', 'd:0')
      writeSave({ level: 1, x: 2.5, y: 2.5, playT: 40, caches: own.snapshot() })
      const b = createCacheLedger(); b.restore(readSave().caches)
      expect(b.get('c:1:11,10')).toEqual({ key: 'c:1:11,10', lvl: 1, cx: 11, cy: 10, id: null, name: 'wanderer', t: 42, localKey: null, pending: null })
    })
  })
})

describe('I12 (W7): a friend\'s light, a friend\'s ward, a friend\'s photograph — and the floor under you while someone has evidence of you', () => {
  const loop = game.slice(loopAt)
  const lift = (re) => { const m = game.match(re); expect(m, String(re)).not.toBeNull(); return m[0] }
  const wardOn = lift(/bus\.on\('ward', \(\{ id, name, payload: p \}\) => \{[\s\S]*?\r?\n {4}\}\)/)
  const photoOn = lift(/bus\.on\('photo', \(\{ id, payload: p \}\) => \{[\s\S]*?\r?\n {4}\}\)/)
  const regs = ['ward', 'photo'].map((k) => lift(new RegExp(`bus\\.register\\('${k}'[^\\n]*`)))
  const LIT_LINE = 'litRec = bus ? litFriendNear(player, bus.freshPeersOnFloor(), LIT_OPTS) : null; litNear = litRec !== null'
  const EMIT = "if (bus) { wardOut.x = player.x; wardOut.y = player.y; wardOut.a = +player.angle.toFixed(2); wardOut.lvl = level.index; bus.emit('ward', wardOut) }"
  const FLOOR = 'if (evidence.active(playT)) sanity = Math.max(sanity, EVIDENCE_FLOOR)'
  const mkBus = (pos, clock) => {
    const sent = []
    const bus = createEvBus({ send: (k, p) => sent.push([k, JSON.parse(JSON.stringify(p))]), now: () => clock.t, self: () => ({ x: 10, y: 10, lvl: 1 }), peerPos: (id) => pos[id] ?? null,
      peerIds: () => new Set(Object.keys(pos)), selfId: () => 'me' })
    new Function('bus', regs.join('\n'))(bus)
    return { bus, sent }
  }

  it('imports lightshare.js, the evidence clock and WARD_TAP by their real names; lightshare.js is in both offline shells; nothing of W7 is left to do', () => {
    expect(game).toMatch(/import \{ LIT_RANGE, litFriendNear, inCone, wardOutcome, wardLine, litOffLine \} from '\.\/lightshare\.js'/)
    expect(game).toMatch(/import \{ SUBJECT_RANGE, SOUL_RANGE, inFrame, subjectInFrame, createEvidence, photoOutcome, EVIDENCE_FLOOR, EVIDENCE_LINE, COUNTED_LINE \} from '\.\/evidence\.js'/)
    expect(game).toMatch(/import \{ createWardCharger, wardOpts, WARD_TAP \} from '\.\/ward\.js'/)
    expect(sw).toContain("'/renderer/lightshare.js'"); expect(build).toContain("'lightshare.js'")
    expect(game).not.toMatch(/TODO\(integrate:W7\)/)
    for (const s of ['const LIT_OPTS = { cells: LIT_RANGE, los: frameLos, pos: peerPos }', 'const wardOut = { x: 0, y: 0, a: 0, lvl: 0 }', 'const wardProbe = { x: 0, y: 0, angle: 0 }',
      'const evidence = createEvidence()', 'let litRec = null']) {
      expect(at(s), s).toBeLessThan(loopAt)
      expect(game.split(s).length - 1, s).toBe(1)
    }
    expect(count(/createEvidence\(/g)).toBe(1)
    expect(LIT_RANGE).toBe(6)
  })
  it('litNear once a frame in the net block — after the remote fill and the bus tick, before the things and the sanity read it; replayed: solo never, a lit friend in reach is the record', () => {
    expect(loop).toContain(LIT_LINE)
    expect(count(/litFriendNear\(/g)).toBe(1)
    const k = loop.indexOf(LIT_LINE)
    expect(k).toBeGreaterThan(loop.indexOf('fillRemotes()'))
    expect(k).toBeGreaterThan(loop.indexOf('if (bus) { bus.tick(performance.now());'))
    expect(k).toBeLessThan(loop.indexOf('aiCtx.flashlight = flashlight'))
    expect(k).toBeLessThan(loop.indexOf('perCtx.litNear = litNear'))
    expect(k).toBeLessThan(loop.indexOf('sanCtx.litNear = litNear'))
    const run = new Function('bus', 'litFriendNear', 'player', 'LIT_OPTS', 'st', `let { litRec, litNear } = st\n${LIT_LINE}\nObject.assign(st, { litRec, litNear })`)
    const player = { x: 10, y: 10 }, rec = { id: 'f', name: 'maddie', lit: true, legacy: false }
    const opts = { cells: LIT_RANGE, los: () => true, pos: (id) => (id === 'f' ? { x: 15, y: 10, angle: 0 } : null) }
    let st = { litRec: 'stale', litNear: true }
    run(null, litFriendNear, player, opts, st)
    expect(st).toEqual({ litRec: null, litNear: false })                                         // solo: today's frame
    st = { litRec: null, litNear: false }
    run({ freshPeersOnFloor: () => [rec] }, litFriendNear, player, opts, st)
    expect(st.litRec).toBe(rec); expect(st.litNear).toBe(true)
    run({ freshPeersOnFloor: () => [{ ...rec, lit: false }] }, litFriendNear, player, opts, st)
    expect(st).toEqual({ litRec: null, litNear: false })                                         // their light off: no shelter
  })
  it('L: going dark in a friend\'s light names them; in nobody\'s it is today\'s line; kneeling, the light stays on them', () => {
    const L = lift(/if \(K\['KeyL'\]\) \{[\s\S]*?\r?\n {6}\}/)
    const run = new Function('K', 'kneel', 'litOffLine', 'showMessage', 'LIGHT_STAYS_LINE', 'st', `let { flashlight, lightToggles, litRec } = st\n${L}\nObject.assign(st, { flashlight, lightToggles })`)
    const said = [], press = (st, kneel = { st: null }) => run({ KeyL: true }, kneel, litOffLine, (m) => said.push(m), LIGHT_STAYS_LINE, st)
    let st = { flashlight: true, lightToggles: 0, litRec: { name: 'maddie' } }
    press(st)
    expect([st.flashlight, st.lightToggles, said.at(-1)]).toEqual([false, 1, "flashlight off — you stand in maddie's light."])
    press(st)
    expect(said.at(-1)).toBe('flashlight on.')
    st = { flashlight: true, lightToggles: 0, litRec: null }
    press(st)
    expect(said.at(-1)).toBe('flashlight off — the dark leans in.')
    st = { flashlight: true, lightToggles: 0, litRec: { name: 'maddie' } }
    press(st, { st: { id: 'f' } })
    expect([st.flashlight, said.at(-1)]).toEqual([true, LIGHT_STAYS_LINE])
  })
  it('your ward on the wire: ONE reused payload in the fire branch, after the pinned noise of 12 and before the pulse; through the real bus it is believed, one per 600 ms', () => {
    const fire = slice('let verbMul = 1', 'let moved = false')
    expect(fire).toContain(EMIT)
    expect(fire.indexOf('level.entitySys.noise(player.x, player.y, 12)')).toBeLessThan(fire.indexOf(EMIT))
    expect(fire.indexOf(EMIT)).toBeLessThan(fire.indexOf('wardPulse(); shake = Math.max(shake, w.charged ? 0.7 : 0.45)'))
    expect(count(/bus\.emit\('ward'/g)).toBe(1)
    const clock = { t: 5000 }, { bus, sent } = mkBus({}, clock)
    const wardOut = { x: 0, y: 0, a: 0, lvl: 0 }
    const emit = new Function('bus', 'wardOut', 'player', 'level', EMIT)
    emit(bus, wardOut, { x: 10.25, y: 4.5, angle: 1.23456 }, { index: 2 })
    expect(sent).toEqual([['ward', { x: 10.25, y: 4.5, a: 1.23, lvl: 2, n: 0 }]])
    clock.t += 590; emit(bus, wardOut, { x: 10.25, y: 4.5, angle: 0 }, { index: 2 })
    expect(sent.length).toBe(1)                                                                  // the charger's 0.65 s is above the bus's 0.6
    clock.t += 60; emit(bus, wardOut, { x: 10.25, y: 4.5, angle: -7 }, { index: 2 })
    expect(sent[1][1].a).toBe(-7)
    emit(null, wardOut, { x: 1, y: 1, angle: 0 }, { index: 2 })                                   // solo: nobody to tell
    expect(sent.length).toBe(2)
  })
  it('a friend\'s ward, lifted and replayed through the real bus: their tap re-run on YOUR things from where they stand, a friend noise of 10; steadied only in its cone with something met', () => {
    expect(wardOn).not.toMatch(/stillness\.noise|standHeld|wardRecoil|tryMove/)                // their noise is not your motion; the recoil is the warder's own
    expect(count(/level\.entitySys\.noise\(p\.x, p\.y, 10, 'friend'\)/g)).toBe(1)
    const clock = { t: 10000 }, pos = { f: { x: 11, y: 10 }, far: { x: 30, y: 10 } }, { bus } = mkBus(pos, clock)
    const said = [], calls = [], noises = []
    let res = { hit: 1, dispelled: 0, opening: 0 }, creatures = true
    const level = { index: 1, entitySys: { ward: (probe, opts) => { calls.push([{ ...probe }, opts]); return res }, noise: (...a) => noises.push(a) } }
    let pulses = 0
    const read = new Function('bus', 'level', 'wardProbe', 'getPref', 'EMPTY_WARD', 'WARD_TAP', 'wardOutcome', 'inCone', 'player', 'wardPulse', 'wardLine', 'showMessage', 'PRIO', 'st',
      `let { sanity, calmTimer, hurt, shake } = st\n${wardOn}\nreturn () => ({ sanity, calmTimer, hurt, shake })`)(
      bus, level, { x: 0, y: 0, angle: 0 }, (k) => (k === 'creatures' ? creatures : null), { hit: 0, dispelled: 0, opening: 0 }, WARD_TAP, wardOutcome, inCone,
      { x: 10, y: 10, angle: 0 }, () => pulses++, wardLine, (m, p) => said.push([m, p]), PRIO, { sanity: 50, calmTimer: 0, hurt: 1, shake: 0 })
    let n = 0
    const ward = (id, p, extra = {}) => bus.receive({ id, name: id === 'f' ? 'maddie' : id, kind: 'ward', payload: { lvl: 1, ...p, n: ++n }, t: 1, ...extra })
    // facing you from a step away, and it met something: steadied
    expect(ward('f', { x: 11, y: 10, a: 3.14 })).toBe(true)
    expect(calls).toEqual([[{ x: 11, y: 10, angle: 3.14 }, WARD_TAP]])
    expect(noises).toEqual([[11, 10, 10, 'friend']])
    expect(read()).toEqual({ sanity: 58, calmTimer: 4, hurt: 0, shake: 0.2 })
    expect([said, pulses]).toEqual([[['maddie pushes the dark off you.', PRIO.interaction]], 1])
    // facing away: whatever it met, it met elsewhere — the line, not the gift
    clock.t += 700; res = { hit: 2, dispelled: 0, opening: 0 }
    expect(ward('f', { x: 11, y: 10, a: 0 })).toBe(true)
    expect([read().sanity, said.at(-1)]).toEqual([58, ['they recoil from maddie.', PRIO.interaction]])
    clock.t += 700; res = { hit: 0, dispelled: 1, opening: 0 }
    ward('f', { x: 11, y: 10, a: 0 })
    expect(said.at(-1)).toEqual(["it comes apart in maddie's light.", PRIO.interaction])
    // toward you, nothing there; away from you, nothing there: a line, then silence
    clock.t += 700; res = { hit: 0, dispelled: 0, opening: 0 }
    ward('f', { x: 11, y: 10, a: 3.14 })
    expect(said.at(-1)).toEqual(['maddie pushes at the dark near you. it gives nothing back.', PRIO.interaction])
    clock.t += 700; const before = said.length
    ward('f', { x: 11, y: 10, a: 0 })
    expect(said.length).toBe(before)
    // creatures off: no thing of yours to meet; another floor: nothing at all
    clock.t += 700; creatures = false; const nCalls = calls.length
    ward('f', { x: 11, y: 10, a: 3.14 })
    expect([calls.length, said.at(-1)[0]]).toEqual([nCalls, 'maddie pushes at the dark near you. it gives nothing back.'])
    clock.t += 700; creatures = true; const nNoise = noises.length
    expect(ward('f', { lvl: 2, x: 11, y: 10, a: 3.14 })).toBe(true)
    expect([calls.length, noises.length]).toEqual([nCalls, nNoise])
    // the wire: inside 600 ms, a replay, or not where the list has them: refused
    clock.t += 100
    expect(ward('f', { x: 11, y: 10, a: 3.14 })).toBe(false)
    clock.t += 700
    expect(ward('f', { x: 11, y: 10, a: 3.14 }, { replay: true })).toBe(false)
    expect(ward('far', { x: 26, y: 10, a: 0 })).toBe(false)
    expect(ward('f', { x: 11, y: 10, a: NaN })).toBe(false)
  })
  it('a friend\'s photograph, lifted and replayed through the real bus: of you, evidence; lying down it counts you back through the ONE wake; of someone else, or from another floor, nothing', () => {
    expect(photoOn).toContain("if (photoOutcome(down.st) === 'counted' && down.wakeNow() === 'woken') wakeUp(id, COUNTED_LINE)")
    expect(photoOn).not.toMatch(/(?<!function )\bdie\(|thin|leashDebt/)
    expect(slice('function hereFields() {', 'return hereObj')).toContain('hereObj.seen = evidence.active(playT)')
    const clock = { t: 20000 }, pos = { f: { x: 14, y: 10 }, far: { x: 22, y: 10 } }, { bus, sent } = mkBus(pos, clock)
    // the trap the photo's check could have been: emit() runs it on what I SEND, which is of a friend — it must go out
    expect(bus.emit('photo', { of: 'f', x: 10, y: 10, lvl: 1 })).toBe(true)
    expect(sent.map(([k, p]) => [k, p.of])).toEqual([['photo', 'f']])
    let t = 0
    const down = createDownState({ now: () => t }), evidence = createEvidence()
    const said = [], wakes = [], heres = []
    let pulses = 0
    const read = new Function('bus', 'level', 'mpClient', 'evidence', 'playT', 'photoOutcome', 'down', 'wakeUp', 'wardPulse', 'showMessage', 'EVIDENCE_LINE', 'COUNTED_LINE', 'PRIO', 'hereFields', 'st',
      `let { sanity } = st\n${photoOn}\nreturn () => sanity`)(bus, { index: 1 }, { id: 'me' }, evidence, 100, photoOutcome, down, (...a) => wakes.push(a), () => pulses++,
      (m, p) => said.push([m, p]), EVIDENCE_LINE, COUNTED_LINE, PRIO, () => { heres.push(evidence.active(100)); return {} }, { sanity: 10 })
    let n = 0
    const photo = (id, p, extra = {}) => bus.receive({ id, name: id, kind: 'photo', payload: { of: 'me', x: pos[id]?.x ?? 0, y: 10, lvl: 1, ...p, n: ++n }, t: 1, ...extra })
    expect(photo('f', {})).toBe(true)
    expect([read(), pulses, said, wakes, heres]).toEqual([16, 1, [[EVIDENCE_LINE, PRIO.discovery]], [], [true]])
    expect([evidence.active(189.9), evidence.active(190), evidence.by()]).toEqual([true, false, 'f'])
    // lying down: counted back at once, no hold, through wakeUp — the +6 is not added on top
    clock.t += 4000; down.goDown()
    expect(photo('f', {})).toBe(true)
    expect([wakes, down.st, read(), said.length]).toEqual([[['f', COUNTED_LINE]], 'ok', 16, 1])
    // of someone else, another floor, inside 4 s, or from 11+ away: nothing
    clock.t += 4000
    expect(photo('f', { of: 'g' })).toBe(true)
    clock.t += 4000
    expect(photo('f', { lvl: 2 })).toBe(true)
    expect([read(), said.length, wakes.length]).toEqual([16, 1, 1])
    clock.t += 100
    expect(photo('f', {})).toBe(false)
    expect(photo('far', {})).toBe(false)
    expect(photo('f', {}, { replay: true })).toBe(false)
  })
  it('the evidence floor: right after the clamp, before the bar; replayed, 90 s you do not go under 25 — then you can', () => {
    const block = slice('sanCtx.rules = rules;', 'updateSanity()')
    expect(block.indexOf(FLOOR)).toBeGreaterThan(block.indexOf('sanity = Math.max(0, Math.min(100, sanity + s.delta * dt))'))
    expect(block.trimEnd().endsWith(FLOOR)).toBe(true)
    expect(count(/EVIDENCE_FLOOR\)/g)).toBe(1)
    const lit = game.match(/const sanCtx = (\{[^]*?\})\r?\n/)[1]
    const sanCtx = new Function('rules', 'mods', 'co', 'flashlight', 'player', 'selfFile', 'remoteOnFloor', 'bus', `return ${lit}`)(LEGACY, statusMods('notice-mailed'), closingOverlay(null), false, { x: 0, y: 0 }, {}, [], null)
    const run = new Function('sanCtx', 'company', 'sanityStep', 'showMessage', 'EXHAUSTED_LINE', 'DISAGREE_LINE', 'PRIO', 'driftD', 'st', 'evidence', 'EVIDENCE_FLOOR',
      `let { rules, mods, co, flashlight, litNear, level, th, origin, leashCalm, disagreeSaid, dt, sanity, playT, down } = st\n${block}\nst.sanity = sanity`)
    const ev = createEvidence(); ev.seen('f', 0)
    const go = (sanity, playT) => {
      const st = { rules: LEGACY, mods: statusMods('notice-mailed'), co: closingOverlay(null), flashlight: false, litNear: false, level: { index: 3, depth: 3 }, th: { hunted: true, gaze: true, gazeRate: 3 },
        origin: null, leashCalm: 0, disagreeSaid: false, dt: 1 / 60, sanity, playT, down: { st: 'ok' } }
      run(sanCtx, createCompany(), sanityStep, () => {}, EXHAUSTED_LINE, DISAGREE_LINE, PRIO, () => 0, st, ev, EVIDENCE_FLOOR)
      return st.sanity
    }
    expect(go(5, 10)).toBe(EVIDENCE_FLOOR)                                                      // the dark, the hunt and a gaze: still 25
    expect(go(60, 10)).toBeLessThan(60)                                                         // a floor, not a gift: above it the drain goes on
    expect(go(5, 90)).toBeLessThan(5)                                                           // the window closed
    expect(EVIDENCE_FLOOR).toBe(25)
  })
  it('the lines a friend\'s light, ward and photograph say are lowercase, in-fiction, with no exclamation', () => {
    for (const s of [litOffLine('maddie'), litOffLine(null), wardLine('steadied', 'maddie', {}), wardLine('nothing', 'maddie', {}), wardLine('elsewhere', 'maddie', { dispelled: 2 }),
      wardLine('elsewhere', 'maddie', { hit: 1 }), EVIDENCE_LINE, COUNTED_LINE, 'sets something down.', 'you set it down.', 'leave a word with the bandage, for whoever finds it.']) {
      expect(s).toBe(s.toLowerCase()); expect(s).not.toContain('!')
    }
  })
})

describe('I11 / I12: the README and the field manual say what a cache, a friend\'s light, a friend\'s ward and a photograph do', () => {
  const readme = read('../README.md'), manual = read('../docs/manual.html')
  it('README: the x row carries the word and the arrow, an l row, the cache in the items, and the light, the push, evidence and lying down under multiplayer', () => {
    expect(readme).toMatch(/^\| x · set down \| set the selected item down where you stand, with a phrase lifted from the pages and an arrow for whoever finds it — a talking radio keeps talking where it lies \|$/m)
    // F12: the words are the pages' (m.'s and the replies beside them), and the ones you have read once there are six; no claim that m. wrote them all
    for (const doc of [readme, manual]) {
      expect(doc).not.toContain('only what m. wrote')
      expect(doc).not.toContain('the water here is sour.')
      expect(doc).toContain('once the pages you have read hold six of the twelve phrases, the card offers only words from those.')
    }
    expect(readme).toMatch(/^\| l \| flashlight on \/ off/m)
    for (const s of ['**leave a word.**', '*f · take the bandage · left by maddie*', '**a friend\'s light (l).**', '**push for each other (space).**', '**evidence (the polaroid).**', '**down, not dead.**']) expect(readme).toContain(s)
    expect(readme).toContain(EVIDENCE_LINE.split('. ')[0])
  })
  it('the manual: X sets down with a word, L in a friend\'s light, the cache notice, the three co-op panels; the stale lines are gone', () => {
    expect(manual).toContain('<span class="k"><kbd>X</kbd></span><span class="d"><b>set down</b> — and leave a word with it, if you like</span>')
    for (const s of ['<h3>Leave a word</h3>', '<h3 style="font-size:15px">Share the light</h3>', '<h3 style="font-size:15px">Push for each other</h3>', '<h3 style="font-size:15px">Evidence</h3>']) expect(manual).toContain(s)
    expect(manual).not.toContain('wake where you fell in')
    expect(manual).not.toContain('The floor you left does not remember you.')
  })
})

describe('I13 (W3): the file\'s own — the stand, the sealed pages, the souls\' word, the sour water, the slip, /status and the \'your file\' row', () => {
  const loop = game.slice(loopAt)
  const ext = { ...loadFile(null), status: 'extension', at: Date.UTC(2026, 9, 6), ledgerHeard: true }
  it('nothing of W3 is left to do: no marker in game.js or index.html, and the slip\'s line is the closings\' own', () => {
    expect(game).not.toMatch(/TODO\(integrate:W3\)/)
    expect(html).not.toMatch(/TODO\(integrate:W3\)/)
    expect(game).not.toContain('make your claim where the presence waits')
    const slip = slice("} else if (eff.type === 'extension-slip') {", 'renderHotbar()')
    expect(slip).toMatch(/sanity = Math\.min\(100, sanity \+ 20\); wardPulse\(\)\r?\n\s*showMessage\(slipText\(origin, file\.status, file\.closing\)\)/)
    // under LEGACY (no column, the notice nobody answered) the slip says today's line byte for byte
    expect(slipText(null, 'notice-mailed', null)).toBe('notice 30150A. status: EXTENSION — the one line the system never closed. a door left ajar it cannot foreclose. make your claim where the presence waits.')
  })
  it('the stand: ONE standCtx before the loop, refilled and ticked once a frame right after the bar (the sanity block\'s slice is untouched)', () => {
    expect(count(/const standCtx = /g)).toBe(1)
    expect(at('const standCtx = {')).toBeLessThan(loopAt)
    expect(loop).not.toMatch(/standCtx = \{/)
    for (const re of [/standTick\(/g, /standConditions\(/g, /(?<!function )closeExtension\(\)/g]) expect(count(re), String(re)).toBe(1)
    expect(at('standCtx.status = file.status;', loopAt)).toBeGreaterThan(at('updateSanity()', loopAt))
    expect(at('standCtx.status = file.status;', loopAt)).toBeLessThan(at('const insane = ', loopAt))
    const block = slice('standCtx.status = file.status;', 'const insane = ')
    expect(block).toContain('standCtx.standFloor = level.amb.standFloor')
    expect(block).toMatch(/const sd = standTick\(standHeld, dt, standConditions\(standCtx\)\)\r?\n\s*standHeld = sd\.held\r?\n\s*if \(sd\.done\) closeExtension\(\)\r?\n\s*if \(sd\.steady\) showMessage\(STAND_STEADY_LINE, PRIO\.discovery\)/)
    // F2: the sanity step hears last frame's stand (the dark does not eat you while it is held), set just above the sanity block's slice
    expect(loop).toMatch(/sanCtx\.standing = standHeld > 0[^\n]*\r?\n\s*sanCtx\.rules = rules;/)
    expect(game.match(/const sanCtx = (\{[^]*?\})\r?\n/)[1]).toContain('standing: false')
  })
  it('the stand, lifted and replayed against the real closings: 45 s dark, still and heard on the deepest floor closes the extension ONCE; a step, the light, a thing near, the wrong floor or word, never', () => {
    const block = slice('standCtx.status = file.status;', 'const insane = ')
    const standCtx = new Function(`return ${game.match(/const standCtx = (\{[^\n]*\})/)[1]}`)()
    const said = []
    const fn = new Function('standCtx', 'standTick', 'standConditions', 'closeExtension', 'showMessage', 'STAND_STEADY_LINE', 'PRIO', 'st',
      `let { file, level, flashlight, moved, th, sanity, transitioning, standHeld, dt } = st\n${block}\nst.standHeld = standHeld`)
    const fresh = (o = {}) => ({ file: ext, level: { depth: 3, amb: { standFloor: 3 } }, flashlight: false, moved: false, th: { nearest: Infinity }, sanity: 60, transitioning: false, standHeld: 0, dt: 0.5, ...o })
    const run = (st, frames) => { let closed = 0; for (let i = 0; i < frames; i++) fn(standCtx, standTick, standConditions, () => closed++, (m, p) => said.push([m, p]), STAND_STEADY_LINE, PRIO, st); return closed }
    let st = fresh()
    expect(run(st, 89)).toBe(0)                                               // 44.5 s
    expect(run(st, 1)).toBe(1)                                                // the crossing frame
    for (const o of [{ moved: true }, { flashlight: true }, { th: { nearest: 9 } }, { level: { depth: 2, amb: { standFloor: 3 } } }, { file: loadFile(null) },
      { file: { ...ext, ledgerHeard: false } }, { file: { ...ext, closing: 'extension' } }, { sanity: 30 }, { transitioning: true }]) {
      st = fresh(o)
      expect(run(st, 100), JSON.stringify(o)).toBe(0)
      expect(st.standHeld).toBe(0)
    }
    st = fresh({ level: { depth: 2, amb: { standFloor: 2 } } })              // where the room leads extension on the pipes, a floor shallower
    expect(run(st, 90)).toBe(1)
    st = fresh(); run(st, 60); st.moved = true; run(st, 1); st.moved = false   // a step halfway: it starts again
    expect(run(st, 89)).toBe(0); expect(run(st, 1)).toBe(1)
    said.length = 0; st = fresh(); run(st, 29); expect(said).toEqual([])      // 14.5 s: nothing yet
    run(st, 1); expect(said).toEqual([[STAND_STEADY_LINE, PRIO.discovery]])   // 15 s: once
    run(st, 60); expect(said.length).toBe(1)
  })
  it('the extension closes over you: on the file first, then the lights and your mind, the slip in your hands, and the three lines on the closing\'s timers', () => {
    const src = slice('function closeExtension() {', "document.getElementById('wish-cancel')")
    const out = { applied: [], granted: [], hotbar: 0, timers: [], said: [] }
    const fn = new Function('applyFile', 'itemSys', 'renderHotbar', 'closingLines', 'closingTimers', 'setTimeout', 'showMessage', 'PRIO', 'st',
      `let { file, calmTimer, flickTgt, flickTimer, sanity } = st\n${src}\ncloseExtension()\nObject.assign(st, { calmTimer, flickTgt, flickTimer, sanity })`)
    const st = { file: ext, calmTimer: 0, flickTgt: 0.4, flickTimer: 0, sanity: 80 }
    const timers = []
    fn((f) => out.applied.push(f), { grant: (t) => { out.granted.push(t); return { ok: true } } }, () => out.hotbar++, closingLines, timers,
      (f, ms) => { out.timers.push(ms); f(); return out.timers.length }, (m, p) => out.said.push([m, p]), PRIO, st)
    expect(out.applied).toEqual([{ ...ext, closing: 'extension' }])
    expect([st.calmTimer, st.flickTgt, st.flickTimer, st.sanity]).toEqual([600, 1, 1.2, 100])
    expect([out.granted, out.hotbar, timers.length, out.timers]).toEqual([['extension-slip'], 1, 3, [0, 2600, 5600]])
    expect(out.said).toEqual(closingLines('extension').map((l) => [l, PRIO.discovery]))
    expect(buildBody).toContain('for (const t of closingTimers) clearTimeout(t); closingTimers.length = 0; standHeld = 0')   // a new floor drops them
  })
  it('a closed file: the shimmer is gone from the walls before the hint is written, and E finds no presence', () => {
    const k = at('if (!isWishOpen(file.closing)) nearPresence = false', loopAt)
    expect(k).toBeGreaterThan(at('if ((player.x - px2) ** 2 + (player.y - py2) ** 2 < presenceRange) nearPresence = true', loopAt))
    expect(k).toBeLessThan(at("const hintEl = document.getElementById('presence-hint')", loopAt))
    expect(k).toBeLessThan(at("if (K['KeyE']) {", loopAt))
  })
  it('the sealed pages, lifted and run on the real card: under compliance an unread page opens sealed; read it and it is a page, leave it and the file has it — once', () => {
    expect(game).toContain("function openSealed(scrap) { openCard('sealed', { text: SCRAPS[scrap.frag] ?? '', foot: '', redacted: file.redacted.includes(scrap.frag) }, scrap) }")
    expect(statusMods('compliance').sealedCards).toBe(true)
    for (const s of ['notice-mailed', 'extension', 'litigation']) expect(statusMods(s).sealedCards).toBe(false)
    const src = slice('function redactScrap() {', '// E at a scrap:')
    const out = { applied: [], pins: 0 }
    const fn = new Function('applyFile', 'level', 'fog', 'st', `let { file, cardScrap } = st\nfunction applyFile2(f) { file = f; applyFile(f) }\n${src.replace('applyFile(', 'applyFile2(')}\nredactScrap(); st.file = file`)
    const scrap = { frag: 4, key: 'k', x: 1, y: 2 }
    const st = { file: { ...loadFile(null), status: 'compliance', at: 1, redacted: [2] }, cardScrap: scrap }
    const level = { cfg: { map: null }, index: 2 }, fog = { pinThing: () => out.pins++ }
    fn((f) => out.applied.push(f), level, fog, st)
    fn((f) => out.applied.push(f), level, fog, st)                            // the same page again: the file already has it
    expect(out.applied.map((f) => f.redacted)).toEqual([[2, 4]])
    expect([out.pins, st.file.redacted]).toEqual([2, [2, 4]])
    // the real card: the sealed page is blocks until read; X gives it up (the redact action), a given-up page reopens as blocks with no choice
    const card = createCard()
    let s = card.open('sealed', { text: SCRAPS[4], foot: '', redacted: false })
    expect(s.text).not.toBe(SCRAPS[4])
    expect(card.step(s, 'KeyX').action).toEqual({ type: 'redact' })
    s = card.open('sealed', { text: SCRAPS[4], foot: '', redacted: true })
    expect(s.lines.length).toBe(0)
    s = card.open('sealed', { text: SCRAPS[4], foot: '', redacted: false })
    const r = card.step(s, 'KeyE')
    expect([r.action, r.state.mode, r.state.text]).toEqual([{ type: 'reveal' }, 'page', SCRAPS[4]])
  })
  it('the souls know the word you are under, lifted and replayed: a notice nobody answered is today\'s twelve and today\'s pick; a filed word adds its line', () => {
    const src = game.match(/const pool = NPC_LINES\.concat\(npcLines\(file\.status\)\)\r?\n\s*showMessage\(pool\[Math\.floor\(Math\.random\(\) \* pool\.length\)\]\)/)[0]
    const NPC_LINES = new Function(`return ${game.match(/const NPC_LINES = (\[[^]*?\r?\n\])/)[1]}`)()
    expect(NPC_LINES.length).toBe(12)
    const say = (status, r) => { let said = null; new Function('NPC_LINES', 'npcLines', 'file', 'Math', 'showMessage', src)(NPC_LINES, npcLines, { status }, { floor: Math.floor, random: () => r }, (m) => { said = m }); return said }
    for (const r of [0, 0.3, 0.5, 0.999]) expect(say('notice-mailed', r)).toBe(NPC_LINES[Math.floor(r * NPC_LINES.length)])
    expect(say('extension', 0.999)).toBe('you can stop looking for the stairs now.')
    expect(say('compliance', 0.999)).toBe(statusMods('compliance').npcLine)
    expect(say('litigation', 0.999)).toBe(statusMods('litigation').npcLine)
    expect(slice("if (K['KeyE']) {", "if (K['Escape'] && dialogOpen)")).toMatch(/const r = rules\.npcLine\(\)[^\n]*\r?\n\s*if \(r\) \{[^\n]*\}\r?\n\s*else \{/)   // the processed refusal still first
  })
  it('the sour water, lifted and replayed: under extension it advances the station (no slam, no whisper, nothing taken) and wins over the column; else today\'s', () => {
    const src = slice('if (eff.sour) {', 'stamina = 100; calmTimer = 20;').replace(/\}\s*else\s*\{\s*$/, '}')
    const fn = new Function('level', 'player', 'rules', 'dfloor', 'mods', 'RADIO_GROUPS', 'FILE', 'showMessage', 'doorSlam', 'whisper', 'eff', 'st',
      `let { stationIdx, sanity, flickTgt, flickTimer } = st\n${src}\nObject.assign(st, { stationIdx, sanity, flickTgt, flickTimer })`)
    const drink = (o) => {
      const out = { noise: [], said: [], slams: 0, whispers: 0 }
      const st = { stationIdx: o.stationIdx ?? 0, sanity: 50, flickTgt: 1, flickTimer: 0 }
      fn({ entitySys: { noise: (x, y, l) => out.noise.push(l) } }, { x: 0, y: 0 }, o.rules ?? LEGACY, o.dfloor ?? 3, statusMods(o.status ?? 'notice-mailed'), RADIO_GROUPS, STRINGS,
        (m) => out.said.push(m), () => out.slams++, () => out.whispers++, { sour: true }, st)
      return { ...out, st }
    }
    let d = drink({ status: 'extension', stationIdx: 3 })
    expect([d.noise, d.said, d.slams, d.whispers, d.st.sanity, d.st.stationIdx]).toEqual([[6], [STRINGS.SOUR_ADVANCE], 0, 0, 50, 0])
    d = drink({ status: 'extension', rules: rulesFor('processed', false), stationIdx: 1 })   // the status wins over the column's rule
    expect([d.said, d.st.stationIdx]).toEqual([[STRINGS.SOUR_ADVANCE], 2])
    d = drink({})                                                             // a notice nobody answered, the deepest floor: today's
    expect([d.said, d.slams, d.st.sanity, d.st.stationIdx]).toEqual([['the water is sour, and something reads the withdrawal. a line moves in a ledger you cannot see.'], 1, 36, 0])
    d = drink({ dfloor: 2, status: 'compliance' })
    expect([d.whispers, d.st.sanity, d.st.flickTgt]).toEqual([1, 42, 0.5])
  })
  it('/status, lifted and replayed: the file in one line — the word, the column, the closing\'s steps; the fallback is the ONE string', () => {
    const cmd = slice('async function handleCommand(t) {', '// desktop: a fetch that never reached the site')
    expect(cmd).toMatch(/\} else if \(cmd === 'status'\) \{\r?\n(\s*\/\/[^\n]*\r?\n)*\s*showMessage\(fileLines\(\)\.slice\(0, -1\)\.join\(' · '\)\)\r?\n\s*\} else showMessage\('the file does not recognise that\. try \/recover, \/cases, \/file <answer>, \/intake or \/status\.'\)/)
    expect(count(/const fileLines = /g)).toBe(1)
    const line = game.match(/const fileLines = \(\) => [^\n]*/)[0]
    const status = (file, origin, claimFiled = false, beaconFired = false) => new Function('yourFileLines', 'closingProgress', 'file', 'origin', 'claimFiled', 'beaconFired',
      `${line}\nreturn fileLines().slice(0, -1).join(' · ')`)(yourFileLines, closingProgress, file, origin, claimFiled, beaconFired)
    expect(status(loadFile(null), null)).toBe('notice mailed. unanswered. · the file has not written down how you came in.')
    expect(status(ext, 'tenant')).toBe('filed under extension · since 2026-10-06 · the file has you at an address. · the station has read its last group to you · done · standing in the dark on the deepest floor')
    expect(status({ ...ext, status: 'compliance', redacted: [1, 2, 3] }, 'processed')).toContain('three of thirteen pages given up · the file, closed')
    expect(status({ ...ext, status: 'litigation' }, 'anchored', true, false)).toContain('the claim, typed · done · the beacon, pushed')
    for (const s of [status(loadFile(null), null), status(ext, 'unnamed')]) { expect(s).toBe(s.toLowerCase()); expect(s).not.toContain('!') }
  })
  it('the \'your file\' row: drawn on the panel\'s open, hidden on the title screen; the control files a new notice under the office\'s day (lifted, on a fake DOM)', () => {
    expect(html).toMatch(/<div id="file-row" style="display:none;[^"]*">\r?\n\s*<div class="set-section">YOUR FILE<\/div>\r?\n\s*<p id="file-lines"><\/p>\r?\n\s*<button id="btn-new-notice">request a new notice<\/button>/)
    expect(html.indexOf('id="file-row"')).toBeGreaterThan(html.indexOf('id="settings-modal"'))
    expect(html.indexOf('id="file-row"')).toBeLessThan(html.indexOf('id="locate-row"'))
    expect(html.indexOf('id="file-row"')).toBeLessThan(html.indexOf('<div class="modal-foot">'))
    const open = html.slice(html.indexOf("document.getElementById('btn-settings').onclick"), html.indexOf("document.getElementById('btn-locate').onclick"))
    expect(open).toMatch(/settingsMod\.style\.display = 'flex'\r?\n(\s*\/\/[^\n]*\r?\n)*\s*document\.dispatchEvent\(new CustomEvent\('backrooms:settings-open'\)\)/)
    expect(html).toContain("document.getElementById('btn-new-notice').onclick = (e) => { e.currentTarget.blur(); document.dispatchEvent(new CustomEvent('backrooms:new-notice')) }")
    expect(game).toContain("document.addEventListener('backrooms:settings-open', () => { noticeAsked = false; renderFileRow() })")
    expect(count(/document\.addEventListener\('backrooms:new-notice'/g)).toBe(1)
    // the row on a fake DOM: every line but the last is a faint line, the last is the button; the reply under it
    const mk = () => { const el = { children: [], style: {}, className: '' }; let t = ''; Object.defineProperty(el, 'textContent', { get: () => t, set: (v) => { t = v; if (v === '') el.children.length = 0 } }); el.appendChild = (c) => el.children.push(c); return el }
    const row = mk(), lines = mk(), btn = mk(), reply = mk()
    const render = new Function('fileRowEl', 'fileLinesEl', 'newNoticeEl', 'fileReplyEl', 'fileLines', 'document', `${slice("function renderFileRow(reply = '') {", "document.addEventListener('backrooms:settings-open'")}\nreturn renderFileRow`)
    const want = yourFileLines(ext, 'tenant', closingProgress('extension', { ledgerHeard: true, closing: null }))
    render(row, lines, btn, reply, () => want, { createElement: mk })('a new notice is mailed to you.')
    expect([lines.children.map((c) => c.textContent), lines.children.every((c) => c.className === 'file-line'), btn.textContent, reply.textContent, row.style.display])
      .toEqual([want.slice(0, -1), true, 'request a new notice', 'a new notice is mailed to you.', 'block'])
    const bare = mk(); render(null, bare, mk(), mk(), () => want, { createElement: mk })()   // no row in the page: nothing is drawn
    expect(bare.children.length).toBe(0)
    // the control, lifted and replayed against the real fileStatus: back to the notice nobody answered — once a day, never twice under the same word
    const body = game.match(/document\.addEventListener\('backrooms:new-notice', \(\) => \{\r?\n([^]*?)\r?\n  \}\)/)[1]
    const press = (file, now, asked = false) => {
      const out = { applied: [], said: [], rendered: [] }
      const st = { file, photoIdx: 4, stationIdx: 2, claimFiled: true, noticeAsked: asked }
      const btn = { textContent: 'request a new notice' }
      new Function('fileStatus', 'Date', 'applyFile', 'showMessage', 'PRIO', 'renderFileRow', 'newNoticeEl', 'st',
        `let { file, photoIdx, stationIdx, claimFiled, noticeAsked } = st\nconst fileHolds = () => file.closing != null || file.redacted.length > 0\n;(() => {\n${body}\n})()\nObject.assign(st, { photoIdx, stationIdx, claimFiled, noticeAsked })`)(fileStatus, { now: () => now }, (f) => out.applied.push(f),
        (m, p) => out.said.push([m, p]), PRIO, (r) => out.rendered.push(r), btn, st)
      return { ...out, st, btn: btn.textContent }
    }
    expect(game).toContain('const fileHolds = () => file.closing != null || file.redacted.length > 0')
    // a file that holds work (a closing reached, pages given up): the first press only asks; the second files
    for (const held of [{ closing: 'extension' }, { redacted: [1, 2, 3] }]) {
      let q = press({ ...ext, ...held }, ext.at + DAY_MS)
      expect([q.applied, q.said, q.rendered, q.btn, q.st.noticeAsked, q.st.claimFiled]).toEqual([[], [], ['a new notice? the old file closes with what it holds. press again to file it.'], 'yes, a new notice', true, true])
      q = press({ ...ext, ...held }, ext.at + DAY_MS, true)
      expect([q.applied.length, q.said, q.st.noticeAsked]).toEqual([1, [[STRINGS.NEW_NOTICE, PRIO.discovery]], false])
    }
    let p = press({ ...ext, closing: 'extension' }, ext.at + DAY_MS, true)
    expect(p.applied).toEqual([{ status: 'notice-mailed', at: ext.at + DAY_MS, ledgerHeard: true, closing: null, redacted: [] }])
    expect([p.said, p.rendered, p.st.photoIdx, p.st.stationIdx, p.st.claimFiled]).toEqual([[[STRINGS.NEW_NOTICE, PRIO.discovery]], [STRINGS.NEW_NOTICE], 0, 0, false])
    p = press(ext, ext.at + DAY_MS)                                            // nothing to lose: filed on the first press
    expect([p.applied.length, p.said]).toEqual([1, [[STRINGS.NEW_NOTICE, PRIO.discovery]]])
    p = press(ext, ext.at + DAY_MS - 1)                                        // the office's day is not up
    expect([p.applied, p.said, p.st.photoIdx]).toEqual([[], [[STRINGS.OFFICE_CLOSED, PRIO.discovery]], 4])
    p = press(loadFile(null), 5)                                               // already the notice nobody answered
    expect([p.applied, p.said]).toEqual([[], [[STRINGS.SAME_STATUS, PRIO.discovery]]])
  })
  it('the README and the field manual say what the file is: the column, the status and its three stamps, the closings, the row, /status, the floors\' count', () => {
    const readme = read('../README.md'), manual = read('../docs/manual.html')
    const sec = readme.slice(readme.indexOf('## the file'), readme.indexOf('## controls'))
    for (const s of ['**tenant**', '**anchored**', '**unnamed**', '**processed**', '**thin**', '**extension** · *let it stay open*', '**compliance** · *close the file*',
      '**litigation** · *contest it*', '**three ways a file closes.**', '**request a new notice**', '`/status`', '`filed under: EXTENSION · level 2`']) expect(sec, s).toContain(s)
    expect(readme).toMatch(/^\| your file \| [^\n]*\*\*request a new notice\*\* \|$/m)
    expect(readme).toMatch(/^\| enter \| [^\n]*`\/status`/m)
    expect(manual).toContain('<section id="file">')
    for (const s of ['<h2>The file has you now</h2>', '<h3 style="font-size:15px">The stand</h3>', '<span class="mono">/status</span>', '<h3>Compliance</h3>']) expect(manual, s).toContain(s)
    expect(manual.indexOf('<section id="file">')).toBeLessThan(manual.indexOf('<section id="coop">'))
    for (const doc of [sec, manual.slice(manual.indexOf('<section id="file">'), manual.indexOf('<section id="coop">'))]) expect(doc).not.toContain('!')
  })
})

// I15 closes the wave: every rule the steps above wired, pinned once more in one place against the final game.js (each step's own describe
// keeps the detail and the replays); nothing left marked for a later step anywhere in src/; both offline shells carry every module and the
// caches' names moved with them; the README tells a newcomer every control, every setting and what online play needs.
describe('I15: the factions wave, closed', () => {
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url))
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)])
  const readme = read('../README.md'), manual = read('../docs/manual.html')
  const verbs = slice("if (K['KeyF'] && (kneel.st || dnFront))", '// Space — the ward — is the charger block')

  it('no TODO(integrate:…) is left anywhere under src/', () => {
    const left = walk(srcDir).filter((f) => /\.(js|cjs|mjs|html)$/.test(f)).filter((f) => fs.readFileSync(f, 'utf8').includes('TODO(integrate:'))
    expect(left).toEqual([])
  })

  it('one aiCtx with the fifteen keys, the file\'s four trailing; one scheduler on evConfig; one writer each of the file and the tension', () => {
    const lit = /const aiCtx = \{([^\n]*)\}\r?\n/.exec(game)
    expect(lit).not.toBe(null)
    expect(lit[1].split(',').map((s) => s.split(':')[0].trim())).toEqual([...AI_CTX_KEYS])
    expect(count(/const aiCtx = /g)).toBe(1)
    expect(count(/createEventScheduler\(/g)).toBe(1)
    expect(game).toContain('createEventScheduler({ config: evConfig })')
    expect(count(/saveFile\(/g)).toBe(1)
    expect(slice('function applyFile(f) {', '\n')).toContain('saveFile(file)')
    expect(count(/evConfig\.tension = /g)).toBe(1)
    expect(slice('function retension() {', '\n')).toContain('evConfig.tension = ')
  })

  it('each composer is called exactly once, the death decision twice with its one signature; the clocks stay their own', () => {
    for (const re of [/perceptionFor\(/g, /sanityStep\(/g, /polaroidCaption\(/g, /radioLine\(/g, /wishRoute\(/g, /finaleGate\(/g, /beaconDecision\(/g]) expect(count(re), String(re)).toBe(1)
    expect(count(/deathDecision\(/g)).toBe(2)
    expect(count(/deathDecision\(\{ mp: !!mpClient, peers: [^,]+, downSt: down\.st, rules, filed, thin, D: driftD\(\), timeout: (true|false) \}\)/g)).toBe(2)
    for (const re of [/down\.goDown\(playT/, /down\.tick\(playT/, /playT \* 1000/]) expect(game).not.toMatch(re)
    expect(count(/const driftD = /g)).toBe(1)
    expect(count(/driftMeters\(/g)).toBe(1)
    expect(slice('const driftD = ', '\n')).toContain('driftMeters(')
    expect(count(/rollCall\(level\.st\)/g)).toBe(1)
    expect(slice('function readRadio(on) {', '// The counter-claim: fires ONCE')).toContain('rollCall(level.st)')
  })

  it('the order the steps fixed: the card before Enter; the filing in travel(); placement, the closing, then the ways; the caches after the items', () => {
    const cardBranch = at('for (let i = 0; i < CARD_KEYS.length; i++)', loopAt)
    expect(cardBranch).toBeLessThan(at('// Enter opens chat when connected to others', loopAt))
    expect(travelBody.indexOf('buildLevel(way.target, fromC)')).toBeLessThan(travelBody.indexOf('if (!filed) {'))
    expect(travelBody).toContain('later(7600, filingLine(origin, thin), PRIO.discovery)')
    const p = buildBody.indexOf('applyPlacement(cfg, placementMods(st))'), c = buildBody.indexOf('closingOverlay(file.closing).scrapsDenom === 0'), w = buildBody.indexOf('cfg.ways    = waysFor(index)')
    expect(p).toBeGreaterThan(0); expect(p).toBeLessThan(c); expect(c).toBeLessThan(w)
    const e = buildBody.indexOf('itemSys.enterLevel('), q = buildBody.indexOf('for (const c of ledger.pendingFor(index))'), v = buildBody.indexOf('vendedSet = mem.vendedFor(')
    expect(e).toBeGreaterThan(0); expect(e).toBeLessThan(q); expect(q).toBeLessThan(v)
  })

  it('the F chain (a friend down first, then the item, the machine, the drawer, the way) and the E chain (presence, page or form, door, soul)', () => {
    const order = (body, list) => { let k = -1; for (const s of list) { const n = body.indexOf(s); expect(n, s).toBeGreaterThan(k); k = n } }
    order(verbs, ['startKneel(dnFront)', 'if (nearItem) {', 'else if (nearMachine && !vendedSet.has(nearMachine.key)) {', 'else if (boxFirst) {', 'else if (nearExit) {', 'travel(nearExit)'])
    order(verbs, ["if (K['KeyE']) {", 'if (nearPresence) openDialog()', 'else if (nearScrap) nearScrap.form ? openForm()', 'else if (door) knockDoor(door)', 'else if (nearNpc) {'])
  })

  it('the save: the identity and the caches after the fog; the resume reads both ABOVE the clock', () => {
    const snap = slice('function snapshot(full = false) {', 'let saveTimer = 0')
    expect(snap.indexOf('s.fog = fogExport')).toBeLessThan(snap.indexOf('Object.assign(s, identityOut({ origin, thin, filed, intakeCtx, filedFloors }))'))
    expect(snap.indexOf('Object.assign(s, identityOut(')).toBeLessThan(snap.indexOf('s.caches = ledger.snapshot()'))
    const clock = resumeBody.indexOf('playT = Number(resume.playT) || 0')
    expect(resumeBody.indexOf('identityIn(resume, intakeCtx)')).toBeLessThan(clock)
    expect(resumeBody.indexOf('ledger.restore(resume.caches)')).toBeLessThan(clock)
  })

  it('the wake: a kneel and a photograph count you back through wakeUp, never die(); a death never says you wake where you fell in', () => {
    expect(count(/(?<!function )wakeUp\(/g)).toBe(2)
    const kneelOn = slice("bus.on('kneel', ", '\n'), photoOn = slice("bus.on('photo', ", '// what \'here\' says of you')
    for (const h of [kneelOn, photoOn]) { expect(h).toMatch(/wakeUp\(/); expect(h).not.toMatch(/\bdie\(/) }
    for (const doc of [game, readme, manual]) expect(doc).not.toContain('you wake where you fell in.')
    expect(game).toContain("level.entitySys.noise(lures[i].x, lures[i].y, 8, 'lure')")
  })

  it('the console and the card: the ONE fallback string, the placeholder\'s tail, the sealed page read from cardScrap', () => {
    expect(count(/the file does not recognise that\./g)).toBe(1)
    expect(game).toContain("showMessage('the file does not recognise that. try /recover, /cases, /file <answer>, /intake or /status.')")
    expect(html).toContain(' · /intake · /status)"')
    expect(slice('function revealScrap() {', 'function redactScrap() {')).toMatch(/const scrap = cardScrap\r?\n[\s\S]*if \(!level\.cfg\.map\) fog\.pinThing\(level\.index, 'n:' \+ scrap\.key, 'note', scrap\.x, scrap\.y, true\)/)
  })

  it('both offline shells carry every module the wave added (the net one flattened for /play/), and both caches were renamed for it', () => {
    const flat = [...ORIGIN_FILES, 'compose-perception.js', 'compose-sanity.js', 'compose-polaroid.js', 'compose-radio.js', 'compose-wish.js', 'compose-gates.js',
      'status.js', 'closings.js', 'rollcall.js', 'stillness.js', 'downed.js', 'caches.js', 'lightshare.js', 'evidence.js', 'docket.js', 'papercard.js']
    for (const f of flat) {
      expect(game, f).toContain(`from './${f}'`)
      expect(sw, f).toContain(`'/renderer/${f}'`)
      expect(build, f).toContain(`'${f}'`)
    }
    expect(game).toContain("from '../net/evbus.js'")
    expect(sw).toContain("'/net/evbus.js'")
    expect(build).toContain("'evbus.js'")
    expect(Number(/backrooms-pwa-v(\d+)/.exec(sw)[1])).toBeGreaterThanOrEqual(10)
    expect(Number(/PLAY_SW_VERSION:-(\d+)/.exec(build)[1])).toBeGreaterThanOrEqual(21)
  })

  it('touch: six buttons, the sixth is CALL; the README names every one, and the keys a phone cannot press', () => {
    expect(ACTIONS.map((a) => a.label)).toEqual(['ACT', 'USE', 'WARD', 'SPEAK', 'LIGHT', 'CALL'])
    const touch = readme.slice(readme.indexOf('**on a phone or tablet**'), readme.indexOf('your **hit points** sit under'))
    for (const a of ACTIONS) expect(touch, a.label).toContain(`**${a.label}**`)
    for (const k of ['(**b**)', '(**enter**)', '(**m**, **n**)']) expect(touch, k).toContain(k)
  })

  it('README controls: a row for every key the hint row names, the whistle, the set-down word, the kneel', () => {
    const controls = readme.slice(readme.indexOf('## controls'), readme.indexOf('## settings'))
    for (const k of ['wasd', 'shift', 'space (hold to charge)', 'f', 'f · search a cabinet', 'f · kneel', 'tab', 'q', 'x · set down', 'c · whistle', 'l', '1–6', 'e', 'enter', 'b', 'm', 'n', 'esc'])
      expect(controls, k).toMatch(new RegExp(`^\\| ${k.replace(/[()]/g, '\\$&')} \\| `, 'm'))
    expect(html).toContain('<span>c whistle</span>')
    expect(html).toContain('<span>x set down</span>')
    expect(html).toContain('<span>mouse look</span> · <span>space ward</span> · <span>f take / no-clip</span>')   // the hint row teaches the ward too
  })

  it('README settings: every control in the settings panel has its row, and the file\'s', () => {
    const panel = html.slice(html.indexOf('<div id="settings-modal"'), html.indexOf('<canvas id="attract"'))
    const labels = [...panel.matchAll(/<label class="toggle-row">\s*<span>([^<]+?)\s*(?=<)/g)].map((m) => m[1].toLowerCase())
    expect(labels.length).toBeGreaterThanOrEqual(20)
    const settings = readme.slice(readme.indexOf('## settings'), readme.indexOf('## multiplayer')).toLowerCase()
    for (const l of labels) {
      const said = settings.includes(l) || (l.endsWith(' volume') && settings.includes(`| ${l.replace(' volume', '')} |`) && settings.includes('volume slider')) ||
        (l === 'beacon target' && settings.includes('beacon effect / target'))
      expect(said, l).toBe(true)
    }
    expect(settings).toContain('| your file |')
    expect(settings).toContain('locate your body')
  })

  it('README online: update together, the relay that must carry the verbs, and the maintainers\' redeploy and log', () => {
    const mp = readme.slice(readme.indexOf('## multiplayer'), readme.indexOf('## save & continue'))
    expect(mp).toContain('**update together:**')
    expect(mp).toContain('a room on a relay that has not been updated plays as it always did')
    const relay = readme.slice(readme.indexOf('## the relay (maintainer notes)'))
    for (const s of ['`ev`', 'npx wrangler deploy', '`EV_LOG`', '--evlog']) expect(relay, s).toContain(s)
    for (const doc of [mp, readme.slice(readme.indexOf('## how it begins'), readme.indexOf('## anchors'))]) expect(doc).not.toContain('!')
  })

  it('the field manual: the map, the next track, the search and the kneel, the touch buttons, the block, the compass that points at what you have seen', () => {
    const controls = manual.slice(manual.indexOf('<section id="controls">'), manual.indexOf('<section id="hud">'))
    for (const s of ['<kbd>Tab</kbd>', '<kbd>N</kbd>', '<b>search</b>', '<b>kneel</b>', '<b>CALL</b> (C)']) expect(controls, s).toContain(s)
    expect(manual).toContain('LEVEL ∅ · THE BLOCK')
    expect(manual).not.toContain('always points to the nearest exit')
    expect(manual).not.toContain('Where everyone begins.')
    expect(manual).not.toContain('✕ discard')
    expect(manual).toContain('<b>Update together.</b>')
  })
})
