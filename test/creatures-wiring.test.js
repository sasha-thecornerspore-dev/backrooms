// Creatures wiring (integrator, the variants + hunt step): game.js hands the entity system ONE aiCtx object per frame (the hunt path),
// reads the returned threat record for contact damage / the heartbeat / sanity instead of walking the list itself, drains the hunt and
// variant events into one reused array and answers each with its line, emits the noises the things hear (footsteps, the ward, the
// polaroid, a hard bump), lets the flash reach them, takes hunt.js as the one creature-solidity / hostility rule, sends the stalkers on
// your heels down with you, and saves / restores the dispelled chunks. game.js only boots in a page, so these are source guards plus the
// aiCtx shape replayed against the real entity system (the behaviour itself is hunt.test.js / entities-hunt.test.js / variants.test.js).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { createEntitySystem } from '../src/renderer/entities.js'
import { createThreat } from '../src/renderer/hunt.js'
import { HF } from '../src/renderer/gfx-frame.js'
import { AI_CTX_KEYS } from '../src/renderer/compose-perception.js'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const game = read('../src/renderer/game.js')
const sw = read('../src/sw.js')
const build = read('../tools/build-play.sh')
const at = (s) => { const k = game.indexOf(s); expect(k, s).toBeGreaterThan(0); return k }

describe('game.js: the real exported names, and the placeholders are gone', () => {
  it('imports hostile / solidCreature from hunt.js, quiet from tactics.js and FOV / HF from gfx-frame.js', () => {
    expect(game).toMatch(/import \{ hostile, solidCreature \} from '\.\/hunt\.js'/)
    expect(game).toMatch(/import \{ quiet, lureWithin, createCommit, QUIET_SECONDS \} from '\.\/tactics\.js'/)   // fight-verbs widened it
    expect(game).toMatch(/import \{ FOV, HF \} from '\.\/gfx-frame\.js'/)
  })
  it('the solid world takes hunt.solidCreature; noteContact asks hunt.hostile; no TODO(integrate:hunt) is left', () => {
    at("const solid     = createSolidWorld({ index: bodies, floorFn: grid.floor, solidCreature })")
    expect(game).toMatch(/if \(report\.blockedBy && hostile\(report\.blockedBy\) && timing\.t - lastLetThrough > 4\)/)
    expect(game).not.toMatch(/huntSolidCreature|huntHostile/)
    expect(game).not.toMatch(/TODO\(integrate:hunt\)/)
    expect(game).not.toMatch(/TODO\(integrate:variants\)/)
  })
})

describe('game.js: one aiCtx object, mutated per frame, handed to one update', () => {
  const lit = game.match(/const aiCtx = \{ ([^}]*) \}/)
  it('is declared once, outside the loop, with exactly the fields the hunt path and the variants read', () => {
    expect(lit).not.toBeNull()
    const keys = lit[1].split(',').map((f) => f.trim().split(':')[0].trim()).filter(Boolean)
    // the eleven the hunt path always read, then the file's four (compose-perception.js AI_CTX_KEYS: sightMul, hidden, loseTrackMul, noiseMul)
    expect(keys).toEqual([...AI_CTX_KEYS])
    expect(keys.slice(0, 11)).toEqual(['flashlight', 'sprinting', 'dark', 'fog', 'radioOn', 'lures', 't', 'hf', 'playerAngle', 'player', 'damage'])
    expect((game.match(/const aiCtx = /g) || []).length).toBe(1)
    expect(game.indexOf('const aiCtx = ')).toBeLessThan(game.indexOf('function loop(ts) {'))
  })
  it('every frame writes the live fields in place (no fresh object) and the lures only when the items changed or 0.5 s passed', () => {
    expect(game).toMatch(/aiCtx\.flashlight = flashlight; aiCtx\.sprinting = moved && wantSprint; aiCtx\.dark = !cfg\.lights; aiCtx\.fog = cfg\.fogDistance/)
    expect(game).toMatch(/aiCtx\.radioOn = itemSys\.isRadioOn\(\); aiCtx\.t = playT; aiCtx\.playerAngle = player\.angle; aiCtx\.damage = cfg\.entities\?\.damage \?\? 16/)
    // fight-verbs reads isDirty() ONCE per frame (the read clears it) and shares it between the lures and the (floors) memory write
    expect(game).toMatch(/const itemsDirty = itemSys\.isDirty\(\)/)
    expect(game).toMatch(/if \(itemsDirty \|\| lureT >= 0\.5\) \{ lureT = 0; aiCtx\.lures = itemSys\.getLures\(playT, player\.x, player\.y\) \}/)
    expect((game.match(/itemSys\.isDirty\(\)/g) || []).length).toBe(1)
  })
  it('the update takes aiCtx (the hunt path), the legacy aggro multiplier is gone, and creatures off resets the one threat record', () => {
    expect(game).toMatch(/const th = creaturesOn \? level\.entitySys\.update\(dt, player, pcx, pcy, aiCtx\) : \(level\.entitySys\.getThreat\(\)\.reset\(\), level\.entitySys\.getThreat\(\)\)/)
    expect(game).not.toMatch(/radioOn \? 1\.5 : 1/)
    // the grid follows the player chunk before the update, as before
    expect(at('level.grid.setPlayerChunk(pcx, pcy)')).toBeLessThan(at('const th = creaturesOn ? level.entitySys.update('))
  })
  it('the nearest-stalker loop is gone: the threat record drives contact damage, the heartbeat and sanity', () => {
    expect(game).not.toMatch(/let nearD2 = Infinity/)
    expect(game).not.toMatch(/nearD/)
    expect(game).not.toMatch(/if \(e\.stagger > 0\) continue\s+\/\/ reeling from a ward/)
    expect(game).toMatch(/if \(!transitioning && creaturesLive && getPref\('damage'\) && invuln <= 0 && th\.dmg > 0\) \{\r?\n\s*player\.hp -= th\.dmg \* rules\.damageMul; invuln = 0\.7; hurt = 1; regenDelay = 6; shake = 1[^\n]*\r?\n\s*showMessage\(th\.dmgKind === 'arc' \? 'the current finds you\.' : 'it has you\.', PRIO\.urgent\)[^\n]*\r?\n\s*lastHitT = playT\r?\n\s*if \(mapOpen\) closeMap\(\); if \(noteOpen\) closeNoteCard\(\)\r?\n\s*cancelCommit\('the bandage slips\.'\)/)
    // the heartbeat block became tension.tick (fight-verbs; pinned in fight-wiring.test.js): the threat record still feeds it
    expect(game).not.toMatch(/const prox = 1 - th\.nearest \/ 12/)
    expect(game).toMatch(/const tn = tension\.tick\(dt, creaturesLive && !transitioning \? th : null, player\.hp\)/)
    expect(game).not.toMatch(/if \(nearD < 10\) sdelta -= 4/)
    // the threat record's hunt and gaze reach the one sanity step (compose-sanity.js: -3 hunted, -gazeRate under a gaze — I7)
    expect(game).toMatch(/sanCtx\.hunted = th\.hunted; sanCtx\.gaze = th\.gaze; sanCtx\.gazeRate = th\.gazeRate/)
    expect(game).toMatch(/const s = sanityStep\(sanCtx\)\r?\n\s*sanity = Math\.max\(0, Math\.min\(100, sanity \+ s\.delta \* dt\)\)/)
    expect(game).not.toMatch(/sdelta/)
    expect(game).toMatch(/const creaturesLive = creaturesOn && !!cfg\.entities\?\.enabled/)
  })
  it("the tesla's charge drops the lights once per charge, right after stepFlicker", () => {
    const a = at('stepFlicker(fk, dt, fl, Math.random, calm, renderOpts.reduceFlicker)')
    const b = at('if (thA.arcPending && !arcWas) { flickTgt = 0.35; flickTimer = 0.4; blip() }')
    expect(b).toBeGreaterThan(a)
    expect(game).toMatch(/const thA = level\.entitySys\.getThreat\(\)\r?\n\s*if \(thA\.arcPending && !arcWas\) \{ flickTgt = 0\.35; flickTimer = 0\.4; blip\(\) \}\r?\n\s*arcWas = thA\.arcPending/)
    expect(game).toMatch(/let arcWas\s+= false/)
  })
})

describe('game.js: the events, drained once per frame into one reused array', () => {
  const body = game.slice(game.indexOf('function onEntityEvent(ev)'), game.indexOf('// Flicker state (persists'))
  it('drains right after the update, into a module-level array, and answers each event in that frame', () => {
    expect(game).toMatch(/const entEvents = \[\]/)
    expect(game).toMatch(/const nEv = level\.entitySys\.drainEvents\(entEvents\)\r?\n\s*for \(let i = 0; i < nEv; i\+\+\) onEntityEvent\(entEvents\[i\]\)/)
    expect(at('const th = creaturesOn ? level.entitySys.update(')).toBeLessThan(at('const nEv = level.entitySys.drainEvents(entEvents)'))
  })
  it("'seen' near the fog says 'it has seen you.' (combat, 8 s), far says 'something, far off, stops.' (ambient, 30 s) and re-arms the turning cue", () => {
    expect(body).toMatch(/case 'seen':\r?\n\s*turningSaid\.delete\(ev\.id\)\r?\n\s*if \(ev\.d <= fog \* 1\.1\) \{ if \(playT - lastSeenLine > 8\) \{ lastSeenLine = playT; showMessage\('it has seen you\.', PRIO\.combat\) \} \}\r?\n\s*else if \(playT - lastFarLine > 30\) \{ lastFarLine = playT; showMessage\('something, far off, stops\.', PRIO\.ambient\) \}/)
  })
  it('the hunt events carry their lines and priorities', () => {
    expect(body).toContain("case 'lost': showMessage('you have lost it. it is still looking.', PRIO.discovery); break")
    expect(body).toContain("case 'alert': if (ev.d <= fog) footfall(1); break")
    expect(body).toMatch(/case 'turn': if \(!turnSaid\) \{ turnSaid = true; showMessage\('it has nowhere to go\. it turns\.', PRIO\.interaction\) \} break/)
    expect(body).toMatch(/case 'turning': if \(ev\.d <= fog && !turningSaid\.has\(ev\.id\)\) \{ turningSaid\.add\(ev\.id\); showMessage\('it stops\. it turns\.', PRIO\.interaction\) \} break/)
  })
  it('the variant events carry theirs: the smiler, the hound (twice, once per run), the lurker, the crawler, the watcher', () => {
    expect(body).toContain("case 'smiler-freeze': whisper(); showMessage('it stops when you look. do not look away.', PRIO.discovery); break")
    expect(body).toMatch(/case 'hound-windup': footfall\(2\); if \(!houndTold\) \{ houndTold = true; showMessage\('it gathers itself\. push now\.', PRIO\.urgent\) \} break/)
    expect(body).toMatch(/case 'hound-pass': if \(!passTold\) \{ passTold = true; showMessage\('it skids past\.', PRIO\.interaction\) \} break/)
    expect(body).toMatch(/case 'lurker-hunt': if \(playT - lastDuck > 1\.4\) \{ lastDuck = playT; humDuck\(1\.4\) \} break/)
    expect(body).toContain("case 'crawler': sanity = Math.max(0, sanity - 8); showMessage('something takes your ankles.', PRIO.urgent); break")
    expect(body).toContain("case 'watcher-dispelled': sanity = Math.min(100, sanity + 12); showMessage('it looks away first.', PRIO.interaction); break")
  })
  it('the per-level gates are cleared with the other level-scoped sets', () => {
    expect(game).toMatch(/bumpSaid\.clear\(\); clutterSeen\.clear\(\); turningSaid\.clear\(\); turnSaid = false/)
  })
  it('every new line is lowercase, understated, in-fiction: no capitals, no exclamation marks', () => {
    for (const m of body.matchAll(/showMessage\('([^']*)'/g)) {
      expect(m[1]).toBe(m[1].toLowerCase())
      expect(m[1]).not.toContain('!')
    }
  })
})

describe('game.js: the noises the things hear, and the flash', () => {
  it('footsteps: one per half bob cycle, walk 3 / sprint 7, halved by quiet(quietTimer), emitted after the grid follows the chunk', () => {
    expect(game).toMatch(/const stepN = Math\.floor\(player\.bob \/ Math\.PI\)\r?\n\s*const footstep = moved && stepN !== lastStepN\r?\n\s*lastStepN = stepN/)
    expect(game).toMatch(/if \(footstep && creaturesLive\) level\.entitySys\.noise\(player\.x, player\.y, \(aiCtx\.sprinting \? 7 : 3\) \* quiet\(quietTimer\)\)/)
    expect(at('level.grid.setPlayerChunk(pcx, pcy)')).toBeLessThan(at('if (footstep && creaturesLive) level.entitySys.noise('))
    expect(at('if (footstep && creaturesLive) level.entitySys.noise(')).toBeLessThan(at('const th = creaturesOn ? level.entitySys.update('))
  })
  it('the ward is a noise of 12, a hard bump of 5 (no optional call left), the polaroid of 9', () => {
    expect(game).toMatch(/const res = getPref\('creatures'\) \? level\.entitySys\.ward\(player, wardOpts\(w\.charged\)\) : EMPTY_WARD\r?\n\s*level\.entitySys\.noise\(player\.x, player\.y, 12\)/)   // fight-verbs: tap / charged opts
    expect(game).toMatch(/level\.entitySys\.noise\(player\.x, player\.y, 5\)/)
    expect(game).not.toMatch(/entitySys\.noise\?\./)
    expect(game).toMatch(/level\.entitySys\.noise\(player\.x, player\.y, 9\)/)
  })
  it('the polaroid flashes the things in the view cone (range 6, FOV, stagger 1.8) through one hoisted options object, and says so on a hit', () => {
    expect(game).toMatch(/const FLASH_OPTS = \{ range: 6, cone: FOV, stagger: 1\.8 \}, NO_FLASH = \{ hit: 0 \}/)
    expect(game).toMatch(/const b = getPref\('creatures'\) \? level\.entitySys\.flash\(player, FLASH_OPTS\) : NO_FLASH\r?\n\s*if \(b\.hit\) showMessage\('the flash catches it\. it reels, blind\.', PRIO\.interaction\)/)
  })
})

describe('game.js: followers and the dispel that is saved', () => {
  it('travel reads the stalkers on your heels BEFORE the fade (never into the lift) and injects them 7-10 u out once the new floor stands, against its bodies', () => {
    const snap = at("const followers = (creaturesOn && way.kind !== 'lift') ? level.entitySys.snapshotChasers(player, 10, 3) : []")
    const fade = game.indexOf('fadeThen(() => {', snap)
    const built = game.indexOf('buildLevel(way.target, fromC)', fade)
    const inj = at('const followed = followers.length ? level.entitySys.inject(followers, player.x, player.y, 7, 10, 3 + Math.random() * 2, (x, y) => level.solid.forEntities.blocked(x, y, 0.2)) : 0')
    expect(snap).toBeLessThan(fade); expect(fade).toBeLessThan(built); expect(built).toBeLessThan(inj)
  })
  it('each frame the wake event says who followed you down', () => {
    expect(game).toMatch(/const woke = level\.entitySys\.takeWakeEvent\(\)\r?\n\s*if \(woke\) \{ footfall\(\); showMessage\(woke > 1 \? 'they followed you down\.' : 'it followed you down\.', PRIO\.discovery\) \}/)
  })
  it('snapshot ADDS dispelled; resume restores it with no literal clock (the system counts from playT through deps.now)', () => {
    expect(game).toMatch(/dispelled: level\?\.entitySys\.getDispelled\(\) \?\? \[\],/)
    // the applyResume dep hands the system the list alone: its own clock (playT through deps.now) counts the remaining seconds
    expect(game).toMatch(/restoreDispelled: \(l\) => level\.entitySys\.restoreDispelled\(l\),/)
    expect(game).not.toMatch(/restoreDispelled\([^\n]*, 0\)/)
    // in the documented order (levelmem.applyResume, pinned in save-shape.test.js): after the decor / items update at the resumed chunk, before the settle
    expect(at('level.decor.update(pcx, pcy); itemSys.update(pcx, pcy)')).toBeLessThan(at('restoreDispelled: (l) => level.entitySys.restoreDispelled(l)'))
    expect(at('restoreDispelled: (l) => level.entitySys.restoreDispelled(l)')).toBeLessThan(at('settlePlayer: resumeSettle,'))
  })
})

describe('the aiCtx game.js builds is what the entity system expects', () => {
  it('an object with those fields takes the hunt path, returns the one threat record with the fields game.js reads, and events drain into a reused array', () => {
    const player = { x: 11.5, y: 11.5, angle: 0 }
    const ctx = { flashlight: true, sprinting: false, dark: false, fog: 16, radioOn: false, lures: [], t: 0, hf: HF, playerAngle: 0, player, damage: 16 }
    const sys = createEntitySystem({ chunkEvictRadius: 3, entities: { enabled: false } }, () => false, { grid: { floor: () => true, setPlayerChunk() {} }, obstacles: null, now: () => 0 })
    const th = sys.update(1 / 60, player, 0, 0, ctx)
    expect(th).toBe(sys.getThreat())
    for (const k of ['hunted', 'nearest', 'nearestEntity', 'gaze', 'gazeRate', 'dmg', 'dmgKind', 'arcPending', 'events']) expect(k in th, k).toBe(true)
    expect(Object.keys(createThreat()).filter((k) => typeof createThreat()[k] !== 'function')).toEqual(expect.arrayContaining(['hunted', 'nearest', 'gaze', 'gazeRate', 'dmg', 'dmgKind', 'arcPending', 'events']))
    const out = []
    expect(sys.drainEvents(out)).toBe(0)
    expect(sys.drainEvents(out)).toBe(0)
    expect(sys.takeWakeEvent()).toBe(0)
    expect(th.dmg).toBe(0); expect(th.hunted).toBe(false)      // entities disabled: everything game.js reads is zero
    // creatures off: game.js resets the record instead of updating
    th.reset(); expect(th.dmg).toBe(0); expect(th.events.length).toBe(0)
    expect(ctx.player).toBe(player)                              // the live object, never copied
  })
})

describe('offline shell lists carry the modules game.js now imports directly', () => {
  for (const f of ['hunt.js', 'variants.js', 'tactics.js', 'gfx-frame.js']) {
    it(`${f} is in src/sw.js and tools/build-play.sh`, () => {
      expect(sw).toContain(`'/renderer/${f}'`)
      expect(build).toContain(`'${f}'`)
    })
  }
})
