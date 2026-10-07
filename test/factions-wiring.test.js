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
import { standing, placementMods, applyPlacement, EMPTY_STANDING } from '../src/renderer/docket.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'

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
const dieBody = slice('function die() {', '// ── input ──')
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
    expect(game).toMatch(/import \{ parseNameWish, spellCard, refileWithName, spelledLine, ONLINE_LINE \} from '\.\/origin-unnamed\.js'/)
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
    // every write of `rules`: the filing, the ballast cure, the naming re-file, the resume
    expect(count(/(?<![.\w])rules = (?!LEGACY)/g)).toBe(count(/(?<![.\w])rules = rulesFor\(/g))
    expect(count(/(?<![.\w])rules = rulesFor\(/g)).toBe(4)
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
    const submit = slice("document.getElementById('wish-submit')?.addEventListener('click', async () => {", 'const claim = isClaim(text)')
    expect(submit).toMatch(/const name = origin === 'unnamed' \? parseNameWish\(text\) : null\r?\n\s*if \(name\) \{ refileName\(name\); return \}/)
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
    expect(game).toMatch(/import \{ createCompany \} from '\.\/rollcall\.js'/)
    expect(game).toMatch(/import \{ statusMods \} from '\.\/status\.js'/)
    expect(game).toMatch(/import \{ closingOverlay \} from '\.\/closings\.js'/)
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
    `let { rules, mods, co, flashlight, litNear, level, th, origin, leashCalm, disagreeSaid, dt, sanity, playT } = st\n${block}\nst.sanity = sanity; st.disagreeSaid = disagreeSaid`)
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
