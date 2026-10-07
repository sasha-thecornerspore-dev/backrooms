// Dress + between wiring (integrator step "dress-between"): game.js runs the room dressing and the hauntings as decor passes behind the
// stairs (stairs -> dress -> haunts), searches a container on a held F through containers.js (the hold, the cancel, the roll, the floor's
// memory, the noise, the deep floors' cost), and fires a placed haunt only while calm, through ONE dreadQuietT shared with the scheduled
// events. decor.js exposes the chunk's live prop list to the passes (ctx.props), keeps the 'haunt' records it is handed, and hands them
// back as one reused list. audio.js has the drawer's scrape. Source guards on game.js (it only runs in a page), behaviour on the modules.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import { createDecorSystem } from '../src/renderer/decor.js'
import { levelConfig } from '../src/renderer/levels.js'
import { createChunkCache, createGridReader, CHUNK_SIZE, DEFAULT_CONFIG } from '../src/renderer/world.js'
import { waysFor, stairsPass } from '../src/renderer/topology.js'
import { dressPass } from '../src/renderer/dress.js'
import { hauntsPass, HAUNTS } from '../src/renderer/haunts.js'
import { installFakeAudioContext } from './audio-fake.js'
import * as audio from '../src/renderer/audio.js'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const game = read('../src/renderer/game.js')
const decorSrc = read('../src/renderer/decor.js')
const sw = read('../src/sw.js')
const build = read('../tools/build-play.sh')
const readme = read('../README.md')
const at = (s) => { const k = game.indexOf(s); expect(k, s).toBeGreaterThan(0); return k }
const loopAt = game.indexOf('function loop(ts) {')
const once = (s) => expect((game.match(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, s).toBe(1)

describe('game.js: the real exported names, the passes, the state', () => {
  it('imports dress / containers / haunts by their real names and the drawer scrape from audio.js', () => {
    expect(game).toMatch(/import \{ dressPass \} from '\.\/dress\.js'/)
    expect(game).toMatch(/import \{ CONTAINER_TYPES, SEARCH_HOLD_S, DRAWER_COST, rollContainer, applyRoll, createSearchLog \} from '\.\/containers\.js'/)
    expect(game).toMatch(/import \{ hauntsPass, createHauntTracker, hauntEffects \} from '\.\/haunts\.js'/)
    // (I10: the whistle sits between the drawer scrape and the bump — solid-wiring pins the `, bump } from './audio.js'` tail)
    expect(game).toMatch(/import \{ initAudio, [^\n]*, drawerSlide, whistle, bump \} from '\.\/audio\.js'/)
  })
  it('buildLevel runs the passes in the fixed order stairs -> dress -> haunts (none on the block); no TODO(integrate:dress|between) is left', () => {
    expect(game).toMatch(/passes: cfg\.map \? \[\] : \[stairsPass\(cfg, cfg\.ways\), dressPass\(cfg\), hauntsPass\(cfg\)\]\.filter\(Boolean\),/)
    expect(game).not.toMatch(/TODO\(integrate:dress/)
    expect(game).not.toMatch(/TODO\(integrate:between/)
  })
  it('the search and haunt state is declared once, outside the loop; the container predicate is hoisted (no closure per frame)', () => {
    for (const s of ['const searchLog = createSearchLog()', 'let searchT = 0, searchTarget = null, drawerCostSaid = false',
      'const hauntTrackers = new Map()', 'let haunts = null', 'let dreadQuietT = 0, lightToggles = 0', 'let waterT = 0, waterStepT = 0',
      'const unsearchedBox = (p) => CONTAINER_TYPES[p.type] !== undefined && !searchLog.isSearched(p.key)',
      'const hauntCtxObj = { player, props: null, isOpen: (x, y) => level.grid.floor(Math.floor(x), Math.floor(y)), trail: null }']) {
      expect(at(s)).toBeLessThan(loopAt); once(s)
    }
    expect(game).toMatch(/level\.decor\.nearestProp\(player\.x, player\.y, 1\.5, unsearchedBox\)/)
    expect(game).not.toMatch(/nearestProp\(player\.x, player\.y, 1\.5, \(p\) =>/)
  })
  it('buildLevel reseeds the search log from what the floor remembers and drops a hold, the cost line and the water timer', () => {
    const body = game.slice(at('function buildLevel(index, at = null) {'), at('const fader = createFader('))
    expect(body).toContain('searchLog.clear(); searchLog.seed(mem.searchedFor(index)); drawerCostSaid = false; searchT = 0; searchTarget = null; waterT = 0')
  })
})

describe('game.js: the search (containers.js)', () => {
  it('the hint ladder is item > machine > container-or-way > scrap > soul; a container wins over a way farther than 1.0 u', () => {
    expect(game).toMatch(/const nearBox = cfg\.map \? null : level\.decor\.nearestProp\(player\.x, player\.y, 1\.5, unsearchedBox\)/)
    expect(game).toMatch(/const boxFirst = nearBox !== null && \(!nearExit \|\| \(nearExit\.x - player\.x\) \*\* 2 \+ \(nearExit\.y - player\.y\) \*\* 2 > 1\)/)
    const hint = game.slice(at('const itemHintEl = document.getElementById(\'item-hint\')'), at("itemHintEl.textContent = 'e · speak to the lost soul'"))
    const order = ['f · take the', "'f · draw from the machine'", 'f · search ${CONTAINER_TYPES[nearBox.type]}', 'f · the way is still closing.', "'e · read the scrap'"].map((s) => hint.indexOf(s))
    for (let i = 1; i < order.length; i++) expect(order[i], order.join()).toBeGreaterThan(order[i - 1])
    expect(game).toMatch(/\} else if \(boxFirst\) \{\r?\n\s*itemHintEl\.textContent = `f · search \$\{CONTAINER_TYPES\[nearBox\.type\]\}`/)
  })
  it('F starts the search before the way and after the machine; it refuses while hunted or with a thing within 4 ("not now."), else holds SEARCH_HOLD_S with the scrape', () => {
    expect(game).toMatch(/dispenseFromMachine\(nearMachine\)\r?\n\s*\} else if \(boxFirst\) \{\r?\n\s*startSearch\(nearBox, thA\)[^\n]*\r?\n\s*\} else if \(nearExit\) \{\r?\n\s*travel\(nearExit\)/)
    expect(game).toMatch(/function startSearch\(p, th\) \{\r?\n\s*if \(th\.hunted \|\| th\.nearest <= 4\) \{ showMessage\('not now\.', PRIO\.interaction\); return \}\r?\n\s*searchTarget = p; searchT = SEARCH_HOLD_S\r?\n\s*showMessage\('you rummage\.', PRIO\.interaction\)\r?\n\s*drawerSlide\(\)/)
  })
  it('any step leaves the drawer; the hold ticks down and resolves once', () => {
    expect(game).toMatch(/if \(searchT > 0 && stepped\) \{ searchT = 0; searchTarget = null; showMessage\('you leave the drawer\.', PRIO\.interaction\) \}\r?\n\s*if \(searchT > 0\) \{ searchT -= dt; if \(searchT <= 0 && searchTarget\) \{ resolveSearch\(searchTarget\); searchTarget = null \} \}/)
    expect((game.match(/resolveSearch\(searchTarget\)/g) || []).length).toBe(1)
  })
  it('resolveSearch rolls on the key\'s chunk with the world seed and the floor\'s salt, remembers the key only on success, makes a noise of 4 and charges the deep floors once-said', () => {
    expect(game).toMatch(/const \[cx, cy\] = p\.key\.split\(':'\)\[0\]\.split\(','\)\.map\(Number\)/)
    expect(game).toMatch(/const roll = rollContainer\(p\.key, cx, cy, level\.index, worldSeed \| 0, level\.cfg\.maze\?\.salt \| 0\)/)
    expect(game).toMatch(/if \(!applyRoll\(roll, searchApi\)\) return/)
    expect(game).toMatch(/searchLog\.markSearched\(p\.key\); mem\.noteSearched\(level\.index, p\.key\)\r?\n\s*level\.entitySys\.noise\(p\.x, p\.y, 4\)/)
    expect(game).toMatch(/if \(level\.index >= DRAWER_COST\.minLevel\) \{[^\n]*\r?\n\s*sanity = Math\.max\(0, sanity - DRAWER_COST\.sanity\)\r?\n\s*if \(!drawerCostSaid\) \{ drawerCostSaid = true; showMessage\(DRAWER_COST\.line, PRIO\.discovery\) \}/)
    expect(game).toMatch(/if \(roll\.kind === 'item'\) renderHotbar\(\)/)
    // the api: the inventory's grant, the queue, a clamped sanity, the event ids through fireEvent AT INTERACTION (a search result is 'what you
    // did': at ambient the line was dropped behind 'you rummage.'), behind-you through the figure with the cold spot as fallback, also at interaction
    expect(game).toMatch(/grant: itemSys\.grant, message: showMessage, sanity: clampSanity, fire: \(id\) => fireEvent\(id, PRIO\.interaction\),/)
    expect(game).toMatch(/behindYou: \(\) => \{ const fx = hauntEffects\('standing-figure', hauntCtx\(\)\); if \(fx\) applyHaunt\(fx\); else fireEvent\('cold-spot', PRIO\.interaction\) \}/)
    expect(game).not.toMatch(/fire: fireEvent,/)
  })
  it('fireEvent(id, prio = PRIO.ambient): the four murmurs take the caller\'s priority; door-slam and the crosser keep their interaction default', () => {
    once('function fireEvent(id, prio = PRIO.ambient) {')
    const body = game.slice(at('function fireEvent(id, prio = PRIO.ambient) {'), at('function startSearch(p, th) {'))
    for (const line of ['the lights go out ahead of you, one by one. then, slowly, they come back.',
      'the hum stops. the silence has a shape. then it resumes, as if something had been listening.',
      'a cold spot. your breath fogs where there is nothing cold enough to fog it.',
      'footsteps. not yours. they keep your pace, and stop when you stop.']) expect(body).toContain(`showMessage('${line}', prio)`)
    expect(body).not.toContain(', PRIO.ambient)')                                     // no line in fireEvent pins ambient any more
    expect(body).toContain("showMessage('somewhere behind you, a door slams shut.')")
    expect(body).toContain("showMessage('far down the hall, something crosses the intersection. the hall is empty when you look again.')")
    // the scheduled path still murmurs: no priority passed, so the default (ambient) applies
    expect(game).toMatch(/if \(evId\) \{ fireEvent\(evId\); dreadQuietT = 12 \}/)
  })
})

describe('game.js: the hauntings (haunts.js) and the shared quiet', () => {
  it('evCanFire gains the search and the quiet; a scheduled event sets 12 s, a haunt 20 s; the quiet decays every frame', () => {
    expect(game).toMatch(/const evCanFire = !transitioning && !dialogOpen && !chatOpen && !noteOpen && level\.index >= 0 && level\.index <= 3 && searchT <= 0 && dreadQuietT <= 0/)
    expect(game).toMatch(/if \(evId\) \{ fireEvent\(evId\); dreadQuietT = 12 \}\r?\n\s*dreadQuietT = Math\.max\(0, dreadQuietT - dt\)/)
    once('dreadQuietT = 20')
  })
  it('the calm gate and the check: nothing hunting, nothing within 14, no hit for 20 s, the map folded, not the block; a boolean, decor\'s reused list', () => {
    expect(game).toMatch(/const hauntCalm = evCanFire && dreadQuietT <= 0 && !th\.hunted && th\.nearest >= 14 && playT - lastHitT > 20 && !mapOpen && !cfg\.map/)
    expect(game).toMatch(/const h = hauntCalm \? haunts\.check\(player\.x, player\.y, level\.decor\.getHaunts\(\), true\) : null/)
    expect(game).toMatch(/if \(fx\) \{ haunts\.fire\(h\.key\); applyHaunt\(fx\); dreadQuietT = 20; fog\.pinThing\(level\.index, h\.key, 'haunt', h\.x, h\.y\) \}/)
    expect(game).not.toMatch(/haunts\.check\([^\n]*\{ calm/)                 // no per-frame object
    expect(game).not.toMatch(/getKind\('haunt'\)/)                              // getKind allocates; getHaunts is the per-frame one
  })
  it('applyHaunt: the figure onto ephemera, the audio by name, the shake, the light with the toggle counter, the line at discovery, the sanity', () => {
    expect(game).toMatch(/if \(fx\.ephemera\) ephemera\.push\(fx\.ephemera\)/)
    expect(game).toMatch(/if \(fx\.audio === 'whisper'\) whisper\(\)\r?\n\s*else if \(fx\.audio === 'doorSlam'\) doorSlam\(\)\r?\n\s*else if \(fx\.audio === 'footfall:8'\) \{ footfall\(8\); waterT = fx\.timerS \?\? 12; waterStepT = 3 \}/)
    expect(game).toMatch(/if \(fx\.shake\) shake = Math\.max\(shake, fx\.shake\)/)
    expect(game).toMatch(/flashlight = false\r?\n\s*const tog = lightToggles[^\n]*\r?\n\s*setTimeout\(\(\) => \{ if \(lightToggles === tog\) flashlight = true \}, fx\.flashlightOff \* 1000\)/)
    expect(game).toMatch(/showMessage\(fx\.message, PRIO\.discovery\)\r?\n\s*clampSanity\(fx\.sanity\)/)
    expect(game).toMatch(/flashlight = !flashlight; lightToggles\+\+;/)
    // running water keeps pace for its timer
    expect(game).toMatch(/if \(waterT > 0\) \{ waterT -= dt; waterStepT -= dt; if \(waterStepT <= 0 && waterT > 0\) \{ waterStepT = 3; footfall\(8\) \} \}/)
    // the figure does not follow you to the next floor: buildLevel empties the apparitions with the old floor's lines
    expect(game).toMatch(/msgQ\.clear\(\)[^\n]*\r?\n\s*ephemera\.length = 0/)
    once('ephemera.length = 0')
    // the figure vanishes when you come within vanishAt
    expect(game).toMatch(/if \(a\.vanishAt && \(a\.x - player\.x\) \*\* 2 \+ \(a\.y - player\.y\) \*\* 2 < a\.vanishAt \* a\.vanishAt\) a\.ttl = 0/)
    // hauntCtx fills the one object (getProps / lastTrail allocate only on a haunt)
    expect(game).toMatch(/function hauntCtx\(\) \{ hauntCtxObj\.props = level\.decor\.getProps\(\); hauntCtxObj\.trail = fog\.lastTrail\(6\); return hauntCtxObj \}/)
  })
})

describe('the offline shell lists and the README', () => {
  it('dress.js, containers.js and haunts.js are in src/sw.js and tools/build-play.sh', () => {
    for (const f of ['dress.js', 'containers.js', 'haunts.js']) { expect(sw).toContain(`'/renderer/${f}'`); expect(build).toContain(`'${f}'`) }
  })
  it('the controls table has the search row', () => { expect(readme).toMatch(/\| f · search a cabinet \|/) })
})

// ── decor.js: what the passes see and what it keeps ─────────────────────────────────────────────────────────────────────────
const walled = (cfg, seed = 0) => {
  const cache = createChunkCache(cfg, seed)
  const isWall = (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)
  return { isWall, grid: createGridReader(cache, isWall) }
}
const LVL = (i, over = {}) => { const c = levelConfig(DEFAULT_CONFIG, i); c.ways = waysFor(i); return Object.assign(c, over) }
const gamePasses = (cfg) => [stairsPass(cfg, cfg.ways), dressPass(cfg), hauntsPass(cfg)].filter(Boolean)
const byId = (id) => HAUNTS.find((h) => h.id === id)

describe('decor.js: ctx.props, the haunt records, getHaunts', () => {
  it('source: the pass ctx carries the live prop list, add() keeps a haunt per chunk, eviction and enterLevel drop them', () => {
    expect(decorSrc).toMatch(/props: list,/)
    expect(decorSrc).toMatch(/else if \(kind === 'haunt'\) haunts\.set\(key, record\)/)
    expect(decorSrc).toMatch(/stairs\.delete\(k\)\r?\n\s*haunts\.delete\(k\)/)
    expect(decorSrc).toMatch(/stairs\.clear\(\)\r?\n\s*haunts\.clear\(\)/)
  })
  it('ctx.props IS the chunk\'s list, live: a pass behind dressPass sees the dressed records already in it', () => {
    const cfg = LVL(0, { dress: { denom: 1 } })
    const { isWall } = walled(cfg)
    let seen = 0, dressedSeen = 0, lists = 0
    const probe = (ctx) => { lists++; seen += ctx.props.length; for (const p of ctx.props) if (p.key.includes(':d')) dressedSeen++ }
    const sys = createDecorSystem(cfg, isWall, 0, { passes: [dressPass(cfg), probe] })
    sys.update(0, 0)
    expect(lists).toBe(49)
    expect(dressedSeen).toBeGreaterThan(20)
    expect(seen).toBe(sys.getProps().length)                                   // the live list: every record the probe counted is a drawn prop
  })
  it('a haunt handed to ctx.add is kept per chunk, read back through getHaunts (one reused list) and getKind(\'haunt\'), evicted with its chunk, cleared on enterLevel', () => {
    const cfg = LVL(1)
    const { isWall } = walled(cfg)
    const fake = (ctx) => { if (ctx.cx === 0 && ctx.cy === 0) ctx.add('haunt', { key: `${ctx.key}:h`, x: 11.5, y: 11.5, id: 'standing-figure' }) }
    const sys = createDecorSystem(cfg, isWall, 0, { passes: [fake] })
    sys.update(0, 0)
    const a = sys.getHaunts()
    expect(a).toHaveLength(1); expect(a[0]).toEqual({ key: '0,0:h', x: 11.5, y: 11.5, id: 'standing-figure' })
    expect(sys.getHaunts()).toBe(a)                                            // the same array object, rebuilt in place
    expect(sys.getKind('haunt')).toEqual(a); expect(sys.getKind('haunt')).not.toBe(a)
    expect(sys.getProps().some((p) => p.key === '0,0:h')).toBe(false)         // never a prop, never a body
    sys.update(40, 40)                                                         // far away: the chunk is evicted
    expect(sys.getHaunts()).toHaveLength(0)
    sys.update(0, 0); expect(sys.getHaunts()).toHaveLength(1)
    sys.enterLevel(cfg); expect(sys.getHaunts()).toHaveLength(0)
  })
  it('with the game\'s passes on every level 0-3 (haunts gated in everywhere): haunts land on open cells, a needsProps id has its prop within radius in that chunk, and they add no body', () => {
    for (const i of [0, 1, 2, 3]) {
      const cfg = LVL(i, { haunts: { denom: 1 } })
      const { isWall, grid } = walled(cfg)
      grid.setPlayerChunk(0, 0)
      const bundles = new Map()
      const on = createDecorSystem(cfg, isWall, 0, { passes: gamePasses(cfg), onChunk: (k, b) => bundles.set(k, b) }); on.update(0, 0)
      const off = createDecorSystem(cfg, isWall, 0, { passes: gamePasses(cfg).slice(0, 2) }); off.update(0, 0)
      expect(on.getProps()).toEqual(off.getProps())
      expect(on.getStairs()).toEqual(off.getStairs())
      const hs = on.getHaunts()
      expect(hs.length, `level ${i}`).toBeGreaterThan(3)
      for (const h of hs) {
        const [cx, cy] = h.key.split(':')[0].split(',').map(Number)
        expect(grid.floor(Math.floor(h.x), Math.floor(h.y)), h.key).toBe(true)
        expect(byId(h.id).minLevel).toBeLessThanOrEqual(i)
        const need = byId(h.id).needsProps
        if (need) {
          const r = byId(h.id).radius
          expect(bundles.get(`${cx},${cy}`).props.some((p) => p.type === need && (p.x - h.x) ** 2 + (p.y - h.y) ** 2 <= r * r), h.key).toBe(true)
        }
        expect(bundles.get(`${cx},${cy}`).colliders.some((c) => c.key === h.key)).toBe(false)
      }
      if (i === 0) for (const h of hs) expect(h.id).toBe('chairs-moved')       // the lobby's only id, reachable only through ctx.props
    }
  })
})

// ── audio.js drawerSlide ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('audio.js drawerSlide (integrator)', () => {
  let fake, timers, ambience
  beforeAll(() => {
    fake = installFakeAudioContext()
    timers = {
      setInterval:   vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 1),
      clearInterval: vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {}),
      setTimeout:    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 1),
    }
    audio.initAudio(DEFAULT_CONFIG)
    ambience = fake.nodes.all.find((n) => n.kind === 'gain' && n.out.includes(fake.nodes.ctxs[0].destination))
    expect(ambience).toBeTruthy()
  })
  afterAll(() => { for (const s of Object.values(timers)) s.mockRestore(); fake.restore() })
  it('is 0.3 s of noise through a band-pass into a gain on the ambience bus, started and stopped', () => {
    const before = fake.nodes.all.length
    audio.drawerSlide()
    const nodes = fake.nodes.all.slice(before)
    const src = nodes.find((n) => n.kind === 'buffer-source'), bp = nodes.find((n) => n.kind === 'biquad'), g = nodes.find((n) => n.kind === 'gain')
    expect(src.buffer.length).toBe(Math.floor(48000 * 0.3))
    expect(bp.type).toBe('bandpass')
    expect(src.out).toContain(bp); expect(bp.out).toContain(g); expect(g.out).toContain(ambience)
    expect(src.started).toHaveLength(1); expect(src.stopped).toEqual([0.31])
    expect(nodes.some((n) => n.kind === 'oscillator')).toBe(false)             // noise only: no tone
  })
})
