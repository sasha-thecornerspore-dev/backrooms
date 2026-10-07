// The factions wave, wired into game.js / index.html (the integrator's serial steps; game.js only boots in a page, so these are source
// guards plus the pieces lifted out of game.js and replayed against the real modules). The modules themselves are tested on their own:
// origins-*.test.js (W2), evbus / papercard (W1 / W9), and the later items' own tests. Each step adds its describe here; I15 closes it.
import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
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
import { OPENED_LINE, RELEASE_LINE, RADIO_KEY_LINE } from '../src/renderer/origin-processed.js'
import { LEGACY_LAST_LINE } from '../src/renderer/origin-rules.js'
import { createDownState, createKneel, DOWN_LINE, WOKEN_LINE, KNEELER_LINE, HANDS_LINE, LIGHT_STAYS_LINE, KNEEL_HINT, WAKE, KNEELER_SANITY, DOWN_BEAT } from '../src/renderer/downed.js'
import { deathDecision, NOBODY_CAME } from '../src/renderer/compose-gates.js'
import { evKinds } from '../src/renderer/rollcall.js'
import { createEvBus } from '../src/net/evbus.js'
import { createRollCall, whistlePitch, bearingLabel, whistleGain, whistlePan, countLine, WHISTLE_COOLDOWN_MS, WHISTLE_NOISE, QUIET_SANITY, SOLO_SANITY, FAR_BONUS, ECHO,
  NO_ANSWER_LINE, ECHO_LINE } from '../src/renderer/rollcall.js'
import { ACTIONS } from '../src/renderer/touch.js'
import { takeKey } from '../src/renderer/input.js'

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
    const order = ['if (nearPresence) openDialog()', 'else if (nearScrap) nearScrap.form ? openForm() : openNoteCard(nearScrap)', 'else if (door) knockDoor(door)', 'else if (nearNpc) {'].map((s) => e.indexOf(s))
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
    expect(cmd).toContain("showMessage('the file does not recognise that. try /recover, /cases, /file <answer> or /intake.')")
  })
  it('the naming re-file: an unnamed player\'s naming wish closes the dialog and asks how it is spelled; only a confirm files the name', () => {
    const fn = slice('function refileName(name) {', "document.getElementById('wish-cancel')")
    expect(fn).toMatch(/closeDialog\(\); if \(wishText\) wishText\.disabled = false; const sub = document\.getElementById\('wish-submit'\); if \(sub\) sub\.disabled = false/)
    expect(fn).toMatch(/openCard\('confirm', \{ \.\.\.spellCard\(name\), onConfirm: \(\) => \{\r?\n\s*intakeCtx = refileWithName\(intakeCtx, name\); origin = intake\(intakeCtx\); rules = rulesFor\(origin, thin\)\r?\n\s*setPref\('playerName', name\)\r?\n\s*showMessage\(spelledLine\(name, origin\), PRIO\.discovery\)/)
    expect(fn).toContain('if (mpClient) setTimeout(() => showMessage(ONLINE_LINE, PRIO.discovery), 2600)')
    // the router reads the naming wish (I8: compose-wish.js wishRoute, the unnamed only); the handler re-files before anything is disabled or sent
    const submit = slice("document.getElementById('wish-submit')?.addEventListener('click', async () => {", "if (wishResp) wishResp.textContent = r.reply ?? ''")
    expect(submit).toMatch(/const r = wishRoute\(\{ text, origin, rules, file, canFile: fileable\(\), now: Date\.now\(\), depth: level\.depth \}\)\r?\n\s*if \(r\.kind === 'name'\) \{ refileName\(r\.name\); return \}/)
    // the confirm card's foot is its prompt: the put-it-back hint steps aside and the foot keeps its gap
    expect(game).toContain("if (noteHintEl) noteHintEl.style.display = lines.length || s.mode === 'confirm' ? 'none' : ''")
    expect(html).toMatch(/#note-foot \{[^}]*white-space: pre-wrap;/)
    expect(fn).toContain('document.activeElement?.blur?.()')
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
    expect(html).toContain('/recover · /cases · /file … · /intake)')
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
  it('the lure is the one tagged noise (\'lure\'); every other noise call keeps three arguments and is yours', () => {
    expect(game).toContain("level.entitySys.noise(lures[i].x, lures[i].y, 8, 'lure')")
    expect([...game.matchAll(/entitySys\.noise\([^\n]*?, '(\w+)'\)/g)].map((m) => m[1])).toEqual(['lure'])
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
      "const selfFile = { status: 'notice-mailed', aseed: myAseed, origin: null, thin: false }"]) {
      expect(at(s)).toBeLessThan(loopAt)
      expect(game.split(s).length - 1, s).toBe(1)
    }
    expect(at('let file = ')).toBeLessThan(at('let mods = statusMods(file.status)'))
    const here = slice('function hereFields() {', 'return hereObj')
    expect(here).toContain('selfFile.status = file.status; selfFile.aseed = myAseed; selfFile.origin = origin; selfFile.thin = thin')
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
  const run = new Function('sanCtx', 'company', 'sanityStep', 'showMessage', 'EXHAUSTED_LINE', 'DISAGREE_LINE', 'PRIO', 'driftD', 'st',
    `let { rules, mods, co, flashlight, litNear, level, th, origin, leashCalm, disagreeSaid, dt, sanity, playT, down = { st: 'ok' } } = st\n${block}\nst.sanity = sanity; st.disagreeSaid = disagreeSaid`)   // (down: I9)
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
    expect(game).toMatch(/import \{ SUBJECT_RANGE, SOUL_RANGE, inFrame, subjectInFrame \} from '\.\/evidence\.js'/)
    expect(game).toMatch(/import \{ lineOfSight, inViewCone \} from '\.\/raycaster\.js'/)
    expect(game).toMatch(/import \{ depthOf, loadFile, saveFile, statusMods, canFile, canRefile, wishPrompt \} from '\.\/status\.js'/)
    expect(game).toMatch(/import \{ closingOverlay, closingLines, isWishOpen, CLOSED_OFFICE \} from '\.\/closings\.js'/)
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
    subEl.children[1].handlers.pointerdown({ preventDefault() {} })
    expect([wishText.value, submit.clicks]).toEqual(['compliance', 1])      // a status word, never 'close the file'
    submit.disabled = true; subEl.children[0].handlers.pointerdown({ preventDefault() {} })
    expect([wishText.value, submit.clicks]).toEqual(['compliance', 1])
  })
  it('the wish, lifted and replayed against the real router: today\'s claim and wish byte for byte; a name, a status, a close and a re-file stay in the room', async () => {
    const body = slice('const r = wishRoute(', 'setTimeout(() => {')
    const AsyncFunction = (async () => {}).constructor
    const run = async (st0, text) => {
      const st = { origin: null, rules: LEGACY, file: loadFile(null), filed: false, thin: false, photoIdx: 5, stationIdx: 2, claimFiled: false, depth: 1, pages: 0, ...st0 }
      const out = { sent: [], said: [], timers: [], applied: [], compliance: 0, finale: 0, named: [], here: 0, resp: null, closingTimers: [] }
      const fn = new AsyncFunction('text', 'wishRoute', 'canFile', 'readSet', 'level', 'refileName', 'wishResp', 'wishText', 'document', 'applyCompliance',
        'closingLines', 'closingTimers', 'showMessage', 'PRIO', 'rulesFor', 'evConfig', 'bus', 'hereFields', 'window', 'tryFinale', 'setTimeout', 'st', 'out',
        `let { origin, rules, file, filed, thin, photoIdx, stationIdx, claimFiled } = st
        function applyFile(f) { file = f; out.applied.push(f) }
        const fileable = () => canFile({ ledgerHeard: file.ledgerHeard, pagesRead: readSet.size, depth: level.depth })
        try {\n${body}\n} finally { Object.assign(st, { origin, rules, file, photoIdx, stationIdx, claimFiled }) }`)
      const resp = { set textContent(v) { out.resp = v } }
      const btn = { disabled: false }
      await fn(text, wishRoute, canFile, { size: st.pages }, { depth: st.depth }, (n) => out.named.push(n), resp, { disabled: false }, { getElementById: () => btn },
        () => out.compliance++, closingLines, out.closingTimers, (m, p) => out.said.push([m, p]), PRIO, rulesFor, { events: EVENTS }, { here: () => out.here++ }, () => 'here',
        { backrooms: { submitWish: async (t, m) => { out.sent.push([t, m]) } } }, () => out.finale++, (f, ms) => { out.timers.push(ms); return out.timers.length }, st, out)
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
      'origin', 'thin', 'anchor', 'driftD', 'wardPulse', 'window', 'dataUrl', 'showMessage', 'st', 'out',
      `let { sanity, photoIdx, thinFirstShot, shotOnLevel, leashCalm } = st\n${body}\nObject.assign(st, { sanity, photoIdx, thinFirstShot, shotOnLevel, leashCalm })`)
    const player = { x: 10.5, y: 10.5, angle: 0 }
    const opts = { pos: (id) => (id === 'f' ? { x: 15.5, y: 10.5, angle: Math.PI } : null), cone: inViewCone, hf: HF, maxCells: SUBJECT_RANGE, los: () => true }
    const shoot = (st, o = {}) => {
      const out = { said: [], pulses: 0 }
      fn(o.ephemera ?? [], player, o.bus ?? null, subjectInFrame, opts, { index: st.index, depth: depthOf(st.index), decor: { nearestNpc: () => o.npc ?? null } }, SOUL_RANGE, inFrame,
        polaroidCaption, () => o.arrow ?? null, o.rules ?? LEGACY, o.mods ?? NM, { status: o.status ?? 'notice-mailed' }, o.origin ?? null, o.thin ?? false, o.anchor ?? null,
        () => o.D ?? 0, () => out.pulses++, {}, null, (m, p) => out.said.push(p === undefined ? m : [m, p]), st, out)
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
  it('the seam: the core\'s gate and the file\'s, then the litigation\'s closing on the file before the lines', () => {
    const fin = slice('function tryFinale() {', 'function applyItemEffect(eff) {')
    expect(fin).toMatch(/if \(!finaleGate\(\{ seamHeld, claimFiled, beaconFired, rules, status: file\.status, closing: file\.closing \}\)\) return\r?\n\s*seamHeld = true\r?\n\s*applyFile\(\{ \.\.\.file, closing: 'litigation' \}\)\r?\n\s*wardPulse\(\); calmTimer = 600;/)
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
  const HP_LINE = "if (player.hp <= 0) { player.hp = 0; const d = deathDecision({ mp: !!mpClient, peers: bus ? bus.freshPeersOnFloor().length : 0, downSt: down.st, rules, filed, thin, D: driftD(), timeout: false }); if (d === 'down') goDown(); else if (d !== 'wait') die(d) }"
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
    for (const c of calls) expect(c).toMatch(/^\{ mp: !!mpClient, peers: (bus \? bus\.freshPeersOnFloor\(\)\.length : 0|0), downSt: down\.st, rules, filed, thin, D: driftD\(\), timeout: (true|false) \}$/)
    expect(loop).toContain(HP_LINE)
    expect(loop).toContain(TIMEOUT_LINE)
    expect(loop.indexOf(TIMEOUT_LINE)).toBeLessThan(loop.indexOf(HP_LINE))
    expect(loop.indexOf("if (hurtEl) hurtEl.style.opacity = (hurt * 0.55).toFixed(2)")).toBeLessThan(loop.indexOf(TIMEOUT_LINE))
    expect((code.match(/(?<!function )\bdie\(/g) || []).length).toBe(2)       // the timeout and the hp block: nothing else dies
  })
  it('the hp block, lifted and replayed against the real decision: solo and an empty floor die today\'s death; a fresh friend lays you down; down, you wait', () => {
    const run = new Function('deathDecision', 'mpClient', 'bus', 'down', 'rules', 'filed', 'thin', 'driftD', 'goDown', 'die', 'player', HP_LINE)
    const go = (mp, peers, downSt) => {
      const out = { down: 0, died: [] }, player = { hp: -4 }
      run(deathDecision, mp ? {} : null, mp ? { freshPeersOnFloor: () => new Array(peers) } : null, { st: downSt }, LEGACY, false, false, () => 0,
        () => out.down++, (d) => out.died.push(d), player)
      return { ...out, hp: player.hp }
    }
    const legacyDeath = { die: true, mintThin: false, leashDebt: 0, sanity: 0, regenDelay: 0, line: null }
    expect(go(false, 0, 'ok')).toEqual({ down: 0, died: [legacyDeath], hp: 0 })     // solo: today's death, nothing added
    expect(go(true, 0, 'ok')).toEqual({ down: 0, died: [legacyDeath], hp: 0 })      // friends only on other floors
    expect(go(true, 1, 'ok')).toEqual({ down: 1, died: [], hp: 0 })                 // a fresh friend here: down
    expect(go(true, 1, 'down')).toEqual({ down: 0, died: [], hp: 0 })               // already down: wait
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
    // wakeUp is called from the kneel handler only (the photo path joins it in I12) — never from die()
    expect((code.match(/(?<!function )\bwakeUp\(/g) || []).length).toBe(1)
    expect(game).toContain("bus.on('kneel', ({ id }) => { if (down.st === 'down' && down.kneelTick(id) === 'woken') wakeUp(id) })")
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
    expect(loop).toMatch(/if \(K\['KeyL'\]\) \{\r?\n\s*K\['KeyL'\] = false\r?\n\s*if \(kneel\.st\) showMessage\(LIGHT_STAYS_LINE\)[^\n]*\r?\n\s*else \{ flashlight = !flashlight; lightToggles\+\+; showMessage\(flashlight \? 'flashlight on\.' : 'flashlight off — the dark leans in\.'\) \}/)
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
    new Function('sanCtx', 'company', 'sanityStep', 'showMessage', 'EXHAUSTED_LINE', 'DISAGREE_LINE', 'PRIO', 'driftD', 'st',
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
    expect(game).toMatch(/import \{ createCompany, createRollCall, evKinds, whistlePitch, bearingLabel, whistleGain, whistlePan, countLine, WHISTLE_COOLDOWN_MS, WHISTLE_NOISE, QUIET_SANITY, SOLO_SANITY, FAR_BONUS, ECHO, NO_ANSWER_LINE, ECHO_LINE \} from '\.\/rollcall\.js'/)
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
    expect(loop).toMatch(/if \(K\['KeyX'\]\) \{ K\['KeyX'\] = false; throwSelected\(\) \}\r?\n\s*if \(K\['KeyC'\]\) \{ K\['KeyC'\] = false; whistleOut\(creaturesLive\) \}/)
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
      showMessage: (m, p) => said.push([m, p]), PRIO, countLine, NO_ANSWER_LINE, SOLO_SANITY, ECHO, ECHO_LINE,
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
