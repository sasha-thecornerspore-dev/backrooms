// Solid-bodies wiring (integrator, the collide + placement step): game.js builds a level as cache -> grid -> bodies -> decor(hooks) ->
// solid -> entitySys -> gfx, moves the player through ONE collide.js call per frame (movePlayer with Solid furniture on, the legacy
// movePoint with it off), answers the mover's report in noteContact (foley, the hard bump, the pallet tap, the clutter line and bob
// pulse, the body that would not let you through), settles a resumed player out of the furniture, reads the ways through
// decor.nearestWay / nearestWayAny, draws the stairs from their own pooled category, and index.html carries the Solid furniture row.
// game.js only boots in a page, so these are source guards (the behaviour is collide.test.js / feedback.test.js / placement.test.js).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const game = read('../src/renderer/game.js')
const html = read('../src/renderer/index.html')
const sw = read('../src/sw.js')
const build = read('../tools/build-play.sh')

describe('game.js: buildLevel order (cache -> grid -> bodies -> decor(hooks) -> solid -> entitySys -> gfx)', () => {
  it('imports the real exported names', () => {
    expect(game).toMatch(/import \{ createSolidWorld, createColliderIndex, movePoint, PLAYER_R \} from '\.\/collide\.js'/)
    expect(game).toMatch(/import \{ bumpKindFor, bumpIntensity, isHardBump, createBumpGate, BUMP_LINES \} from '\.\/feedback\.js'/)
    expect(game).toMatch(/import \{ CLUTTER_LINES \} from '\.\/placement\.js'/)
    expect(game).toMatch(/, bump \} from '\.\/audio\.js'/)
  })
  it('the index is created before decor, decor fills it through onChunk / onEvict, the solid world reads it and the grid', () => {
    const at = (s) => { const k = game.indexOf(s); expect(k, s).toBeGreaterThan(0); return k }
    const cache = at('const cache = cfg.map ? createFixedMap(cfg.map) : createChunkCache(cfg, worldSeed)')
    const grid = at('const grid      = createGridReader(cfg.map ? null : cache, isWall)')
    const bodies = at('const bodies    = createColliderIndex()')
    const decor = at('const decor     = createDecorSystem(cfg, isWall, worldSeed, {')
    const solid = at('const solid     = createSolidWorld({ index: bodies, floorFn: grid.floor, solidCreature })')
    const ents = at('const entitySys = createEntitySystem(cfg, isWall, { obstacles: solid.forEntities, grid, now: () => playT })')
    const gfx = at('const gfx       = makeGfx(cfg, cache)')
    expect(cache).toBeLessThan(grid); expect(grid).toBeLessThan(bodies); expect(bodies).toBeLessThan(decor)
    expect(decor).toBeLessThan(solid); expect(solid).toBeLessThan(ents); expect(ents).toBeLessThan(gfx)
    expect(game).toMatch(/onChunk: \(k, bundle\) => bodies\.setChunk\(k, bundle\.colliders\),\r?\n\s*onEvict: \(k\) => bodies\.dropChunk\(k\),/)
    expect(game).toMatch(/level = \{ index, cfg, cache, grid, bodies, decor, solid, entitySys, gfx, messages \}/)
  })
  it('the contact sets are level-scoped (cleared next to the frame\'s vendedSet, which levelmem now hands out) and the passes run in the fixed order', () => {
    // (the vendedSet is read once the new level object stands, below the clears: itemSys.enterLevel must see the new walls — W-R1)
    const build = game.slice(game.indexOf('function buildLevel(index, at = null) {'), game.indexOf('const fader = createFader('))
    expect(build).toMatch(/\n\s*bumpSaid\.clear\(\); clutterSeen\.clear\(\)/)
    expect(build.indexOf('bumpSaid.clear(); clutterSeen.clear()')).toBeLessThan(build.indexOf('vendedSet = mem.vendedFor(index, playT)'))
    expect(game).toMatch(/passes: cfg\.map \? \[\] : \[stairsPass\(cfg, cfg\.ways\), dressPass\(cfg\), hauntsPass\(cfg\)\]\.filter\(Boolean\),/)   // stairs -> dress -> haunts
    expect(game).not.toMatch(/TODO\(integrate:dress\)/)
    // the creatures step: hunt.js is the one creature-solidity / hostility rule (the placeholders are gone)
    expect(game).toMatch(/import \{ hostile, solidCreature \} from '\.\/hunt\.js'/)
    expect(game).not.toMatch(/huntSolidCreature|huntHostile|TODO\(integrate:hunt\)/)
    expect(game).toMatch(/let playT\s+= 0/)
    expect(game).toMatch(/\n\s*playT \+= dt\r?\n/)
  })
})

describe('game.js: one mover call per frame', () => {
  it('the movement block sums W/S/A/D into one step scaled by clutterAt, then one tryMove; lastDt is the frame step', () => {
    expect(game).toMatch(/let mx = 0, my = 0\r?\n\s*if \(K\['KeyW'\] \|\| K\['ArrowUp'\]\)\s+\{ mx \+= ca \* sp; my \+= sa \* sp; moved = true \}/)
    expect(game).toMatch(/if \(K\['KeyS'\] \|\| K\['ArrowDown'\]\) \{ mx -= ca \* sp \* 0\.6; my -= sa \* sp \* 0\.6; moved = true \}/)
    expect(game).toMatch(/if \(K\['KeyA'\]\)\s+\{ mx \+= Math\.cos\(player\.angle - Math\.PI\/2\) \* sp \* 0\.7; my \+= Math\.sin\(player\.angle - Math\.PI\/2\) \* sp \* 0\.7; moved = true \}/)
    expect(game).toMatch(/if \(moved\) \{\r?\n\s*lastDt = dt\r?\n\s*const mult2 = getPref\('solidBodies'\) \? level\.solid\.clutterAt\(player\.x, player\.y\) : 1\r?\n\s*const x0 = player\.x, y0 = player\.y\r?\n\s*tryMove\(player\.x \+ mx \* mult2, player\.y \+ my \* mult2\)\r?\n\s*stepped = \(player\.x - x0\) \*\* 2 \+ \(player\.y - y0\) \*\* 2 > 1e-6[^\n]*\r?\n\s*\}/)
    expect((game.match(/(?<!function )tryMove\(/g) || []).length).toBe(1)
  })
  it('the sprint flag the hard-bump rule reads is the one the movement block set this frame; creaturesOn is read at the top of the frame', () => {
    expect(game).toMatch(/let wantSprint = false/)
    expect(game).toMatch(/wantSprint = \(K\['ShiftLeft'\] \|\| K\['ShiftRight'\]\) && stamina > 0/)
    expect(game).not.toMatch(/const wantSprint = /)
    expect(game).not.toMatch(/const creaturesOn = /)
    // (fight-verbs: creaturesLive and the verbs block now sit between the read and the movement block)
    const a = game.search(/\n\s*creaturesOn = getPref\('creatures'\)\r?\n\s*const creaturesLive = creaturesOn && !!cfg\.entities\?\.enabled/), b = game.indexOf('const th = creaturesOn ? level.entitySys.update(dt, player, pcx, pcy, aiCtx)')
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a)
  })
})

describe("game.js: noteContact (the report's rules)", () => {
  const body = game.slice(game.indexOf('function noteContact(report)'), game.indexOf('// ── vending machine'))
  it('foley on an ENTER edge through the near gate, never for a silent body', () => {
    expect(body).toMatch(/if \(hit && bumpGate\.near\(timing\.t\)\) \{\r?\n\s*const kind = bumpKindFor\(hit\.kind, hit\.type\)\r?\n\s*if \(kind !== 'silent'\) bump\(kind, bumpIntensity\(report\.enterSpeed\), 0\)/)
  })
  it('a hard bump shakes, costs a breath, makes a noise of 5 and says its line once per type per level with a 30 s cooldown', () => {
    expect(body).toMatch(/if \(isHardBump\(report, wantSprint\)\) \{\r?\n\s*shake = Math\.max\(shake, 0\.06\); stamina = Math\.max\(0, stamina - 2\)\r?\n\s*level\.entitySys\.noise\(player\.x, player\.y, 5\)/)
    expect(body).toMatch(/if \(!bumpSaid\.has\(type\) && timing\.t - lastBumpLine > 30\) \{\r?\n\s*bumpSaid\.add\(type\); lastBumpLine = timing\.t\r?\n\s*showMessage\(BUMP_LINES\[type\] \?\? BUMP_LINES\.default\)/)
  })
  it('the pallet taps, clutter pulses the bob and speaks once per type, and the body that refuses you says so at most every 4 s', () => {
    expect(body).toMatch(/if \(report\.stepType === 'pallet'\) bump\('wood', 0\.5\)/)
    expect(body).toMatch(/if \(report\.clutterEntered\) \{\r?\n\s*bobPulse = 0\.35\r?\n\s*if \(!clutterSeen\.has\(report\.clutterType\)\) \{\r?\n\s*clutterSeen\.add\(report\.clutterType\)\r?\n\s*showMessage\(CLUTTER_LINES\[report\.clutterType\] \?\? CLUTTER_LINES\.default, PRIO\.interaction\)/)
    expect(body).toMatch(/if \(report\.blockedBy && hostile\(report\.blockedBy\) && timing\.t - lastLetThrough > 4\) \{\r?\n\s*lastLetThrough = timing\.t\r?\n\s*showMessage\('it does not let you through\.', PRIO\.interaction\)/)
  })
  it('the bob carries the pulse: a +5 px rise that settles over 0.35 s', () => {
    expect(game).toMatch(/player\.bobOffset = bobBase \+ \(bobPulse > 0 \? Math\.sin\(\(0\.35 - bobPulse\) \/ 0\.35 \* Math\.PI\) \* 5 : 0\)\r?\n\s*bobPulse = Math\.max\(0, bobPulse - dt\)/)
    // the pulse's shape: 0 at the start, 5 at the half, 0 at the end
    const pulse = (left) => left > 0 ? Math.sin((0.35 - left) / 0.35 * Math.PI) * 5 : 0
    expect(pulse(0.35)).toBeCloseTo(0, 9); expect(pulse(0.175)).toBeCloseTo(5, 9); expect(pulse(0)).toBe(0)
  })
})

describe('game.js: settle on resume and on the pref', () => {
  it('a resumed player is settled after decor streams the resumed chunk (applyResume: updateAt, then settlePlayer last); a push over half a cell relocates them with the line', () => {
    expect(game).toMatch(/updateAt: \(pcx, pcy\) => \{ level\.grid\.setPlayerChunk\(pcx, pcy\); level\.cache\.preload\(pcx, pcy\); level\.decor\.update\(pcx, pcy\); itemSys\.update\(pcx, pcy\) \}/)
    expect(game).toMatch(/function resumeSettle\(\) \{\r?\n\s*if \(!getPref\('solidBodies'\)\) return\r?\n\s*const moved = level\.solid\.settlePlayer\(player\)\r?\n\s*if \(moved > 0\.5\) \{/)
    expect(game).toMatch(/showMessage\('you woke somewhere slightly else\.', PRIO\.discovery\)/)
    expect(game).toMatch(/const r = applyResume\(resume, \{/)
    expect(game).toMatch(/settlePlayer: resumeSettle,/)
    expect(game).toMatch(/for \(let r = 0; r <= 3; r\+\+\)/)                     // the spiral: at most 3 cells out
  })
  it('switching Solid furniture on settles once', () => {
    expect(game).toMatch(/else if \(k === 'solidBodies'\) \{ if \(v && level\) level\.solid\.settlePlayer\(player\) \}/)
  })
})

describe('game.js: the ways and the stairs', () => {
  it("the prompt and F use nearestWay with the way's label and floor (wayLabel); the compass reads the reused { rec, dist } as its fallback", () => {
    expect(game).toMatch(/const nearExit = level\.decor\.nearestWay\(player\.x, player\.y, 1\.6\)/)
    expect(game).not.toMatch(/nearestExit\(/)
    expect(game).not.toMatch(/nearestExitAny\(/)
    expect(game).toMatch(/'f · the way is still closing\.' : `f · \$\{wayLabel\(nearExit\)\}`/)
    expect(game).toMatch(/else if \(nearExit\) \{\r?\n\s*travel\(nearExit\)/)
    expect(game).toMatch(/compassState\.fallback = level\.decor\.nearestWayAny\(player\.x, player\.y\)/)
    expect(game).not.toMatch(/anyExit/)
  })
  it('the stairs are a separate pooled category drawn with the exit fill, right after the exits', () => {
    expect(game).toMatch(/entityAsm\.add\('exit', level\.decor\.getExits\(\), EF\.exit\)\r?\n\s*entityAsm\.add\('stair', level\.decor\.getStairs\(\), EF\.exit\)/)
  })
})

describe('index.html: the Solid furniture row', () => {
  it('sits right after Creatures, binds to solidBodies and loads into the panel', () => {
    expect(html).toMatch(/id="set-creatures"\/><\/label>\r?\n\s*<label class="toggle-row"><span>Solid furniture <span class="set-hint">walk around things<\/span><\/span><input type="checkbox" id="set-solid"\/><\/label>/)
    expect(html).toContain("prefChk('set-solid', 'solidBodies')")
    expect(html).toMatch(/document\.getElementById\('set-solid'\)\.checked\s+= p\.solidBodies/)
  })
})

describe('offline shell lists carry the modules game.js now imports', () => {
  for (const f of ['collide.js', 'feedback.js', 'placement.js', 'reach.js']) {
    it(`${f} is in src/sw.js and tools/build-play.sh`, () => {
      expect(sw).toContain(`'/renderer/${f}'`)
      expect(build).toContain(`'${f}'`)
    })
  }
})
