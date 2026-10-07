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
    expect(buildBody).toMatch(/lastCellIx = NaN[^\n]*\r?\n(\s*\/\/[^\n]*\r?\n)*\s*level\.depth = depthOf\(index\); level\.st = null; level\.amb = null; retension\(\)/)
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
