// game.js wiring for the radio's static (M21): radiostatic.js read once a frame after tension, on this frame's dread (the 4 Hz read
// over the path field), the hunt's report and your carried radio, behind the gate dread and tension already use (creatures live, no
// fade) plus the block's; audio.js glides to what it hands back. Source guards on game.js (it only boots in a page), then the frame's
// dread block and this block lifted together and replayed at 60 Hz on a real level 1 into the real audio.js over the fake context:
// a thing coming along the halls raises the hiss step by step, a thing two cells off behind a wall and far round by the halls is
// faint, a hunt holds it, and the radio off, creatures off, a fade or the block build no hiss at all. The offline lists carry the
// new module.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { installFakeAudioContext } from './audio-fake.js'
import { DREAD_CLOCK, dreadFrom, dreadNear, createTeller } from '../src/renderer/dread.js'
import { createPathField } from '../src/renderer/pathfield.js'
import { createRadioStatic, staticLevel, STATIC } from '../src/renderer/radiostatic.js'
import { DEFAULT_CONFIG, createChunkCache, createGridReader } from '../src/renderer/world.js'
import { levelConfig } from '../src/renderer/levels.js'
import { chunkMid, findOpenNear } from '../src/renderer/topology.js'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const game = read('../src/renderer/game.js')
const sw = read('../src/sw.js')
const build = read('../tools/build-play.sh')
const at = (s, from = 0) => { const k = game.indexOf(s, from); expect(k, s).toBeGreaterThan(0); return k }
const slice = (from, to) => { const a = at(from), b = game.indexOf(to, a); expect(b, to).toBeGreaterThan(a); return game.slice(a, b) }
const count = (re) => (game.match(re) || []).length
const loopAt = game.indexOf('function loop(ts) {')
const lcg = (s) => () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
const code = (s) => s.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n')   // the block without its comment lines

const HEAD = '// ── the radio\'s static (radiostatic.js)'
const RADIO = () => slice(HEAD, '// ── sanity —')
const DREAD = () => slice('// ── dread (dread.js)', '// ── the lobby\'s exit hint, held for the first run')
const TICK = 'const rs = radioStatic.tick(dreadOut.dread, th.hunted, aiCtx.radioOn, creaturesLive && !transitioning && !cfg.map)'

describe('game.js: the imports and the one state', () => {
  it('imports the static by its real names: createRadioStatic from radiostatic.js, setRadioStatic from audio.js (the audio tail as it was)', () => {
    expect(game).toMatch(/import \{ createRadioStatic \} from '\.\/radiostatic\.js'/)
    expect(game).toMatch(/import \{ initAudio, setFlicker, setRadio, setRadioStatic, setMusic, [^\n]*, drawerSlide, whistle, bump \} from '\.\/audio\.js'/)
  })
  it('one radioStatic, made once, before the loop, beside dread\'s record', () => {
    expect(count(/createRadioStatic\(\)/g)).toBe(1)
    expect(at('const radioStatic = createRadioStatic()')).toBeLessThan(loopAt)
    expect(at('const radioStatic = createRadioStatic()')).toBeGreaterThan(at('const dreadOut = { dread: 0, x: 0, y: 0, variant: null, d: -1, los: false }'))
  })
})

describe('game.js: the frame\'s one read', () => {
  it('after tension (this frame\'s hunt report and your carried radio are in), before sanity; once', () => {
    const k = at(HEAD, loopAt)
    expect(k).toBeGreaterThan(at('const tn = tension.tick(', loopAt))
    expect(k).toBeGreaterThan(at('aiCtx.radioOn = itemSys.isRadioOn(); aiCtx.t = playT;', loopAt))
    expect(k).toBeGreaterThan(at('const th = creaturesOn ? level.entitySys.update(', loopAt))
    expect(k).toBeGreaterThan(at('// ── dread (dread.js)', loopAt))
    expect(k).toBeLessThan(at('// ── sanity —', loopAt))
    expect(count(/radioStatic\.tick\(/g)).toBe(1); expect(count(/setRadioStatic\(/g)).toBe(1)
  })
  it('reads dread, the hunt, the CARRIED radio, behind dread\'s own gate and the block\'s; hands the gain and the glide to audio.js', () => {
    expect(RADIO()).toMatch(new RegExp(TICK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\r?\\n\\s*setRadioStatic\\(rs\\.gain, rs\\.tc\\)'))
    expect(code(RADIO())).not.toMatch(/\bradioWasOn\b|\bradioOn\b(?<!aiCtx\.radioOn)/)   // never the lure-inclusive radioOn: a radio set down is not yours
  })
  it('allocates nothing, says nothing, sends nothing: no object, closure, array, string, line or wire in it', () => {
    const c = code(RADIO())
    expect(c).not.toMatch(/\{ [a-z]+:|=>|\bnew\b|\[\]|['"`]/)
    expect(c).not.toMatch(/showMessage|plate\(|later\(|bus\b|mpClient|persist|mem\./)
  })
  it('the dread block and the tension line are as they were (the static is a reader of both, not a change to either)', () => {
    expect(DREAD()).not.toMatch(/radioStatic|setRadioStatic/)
    expect(game).toContain('const tn = tension.tick(dt, creaturesLive && !transitioning ? th : null, player.hp, creaturesLive && !transitioning ? dreadOut.dread : 0)')
    expect(game).toContain('if (radioOn !== radioWasOn) { radioWasOn = radioOn; setRadio(radioOn) }')
  })
})

describe('the offline shell lists', () => {
  it('radiostatic.js is in src/sw.js and tools/build-play.sh, and the cache name moved on', () => {
    expect(sw).toContain("'/renderer/radiostatic.js'"); expect(build).toContain("'radiostatic.js'")
    expect(Number(/backrooms-pwa-v(\d+)/.exec(sw)[1])).toBeGreaterThanOrEqual(13)
  })
})

// ── replayed: the dread block and the static's block, lifted, at 60 Hz, on a real level 1, into the real audio.js ───────────────────
let world = null
const L1 = () => world ?? (world = (() => {
  const cfg = levelConfig(DEFAULT_CONFIG, 1)
  const cache = createChunkCache(cfg, null); cache.preload(0, 0)
  const grid = createGridReader(cache, (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)); grid.setPlayerChunk(0, 0)
  return { cache, grid }
})())
// the value a param glides to by time t, from its setTargetAtTime log (the Web Audio rule: each event starts from where the last left it)
function glided(p, t) {
  let v = 0, t0 = 0, target = 0, tc = 1
  for (const [name, to, at0, k] of p.calls) {
    if (name !== 'setTargetAtTime' || at0 > t) continue
    v = target + (v - target) * Math.exp(-(at0 - t0) / tc)
    t0 = at0; target = to; tc = k
  }
  return target + (v - target) * Math.exp(-(t - t0) / tc)
}

let fake, audio, ctx, timers
beforeEach(async () => {
  fake = installFakeAudioContext()
  timers = [vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 1), vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 1)]
  vi.resetModules()
  audio = await import('../src/renderer/audio.js')
  audio.initAudio(DEFAULT_CONFIG)
  ctx = fake.nodes.ctxs[0]
})
afterEach(() => { for (const s of timers) s.mockRestore(); fake.restore() })

const thing = (x, y, o = {}) => ({ x, y, variant: 'shade', ai: 'roam', los: false, pending: 0, stagger: 0, ...o })
// a cell d steps from (5, 5) by the halls of the real level 1
const P5 = { x: 5.5, y: 5.5, angle: 0 }
function cellAt(d) {
  const probe = createPathField(); probe.build(5, 5, L1().cache)
  for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) if (probe.dist(5 + dx, 5 + dy) === d) return { x: 5.5 + dx, y: 5.5 + dy }
  return null
}
const hissGain = () => { const src = fake.nodes.all.find((n) => n.kind === 'buffer-source' && n.loop === true); return src ? src.out[0].out[0].gain : null }

function rig({ ents, player, live = true, map = null, transitioning = false, radioOn = true }) {
  const W = L1()
  const st = { playT: 0, dt: 1 / 60, dreadT: 0, fieldT: -Infinity, fieldOn: false }
  const D = {
    level: { entitySys: { getEntities: () => ents }, cache: W.cache }, creaturesLive: live, transitioning, cfg: { map }, player,
    pathField: createPathField(), teller: createTeller({ rng: lcg(3) }), dreadOut: { dread: 0, x: 0, y: 0, variant: null, d: -1, los: false },
    dreadNear, dreadFrom, DREAD_CLOCK, call: () => {},
    radioStatic: createRadioStatic(), setRadioStatic: (g, tc) => audio.setRadioStatic(g, tc), th: { hunted: false }, aiCtx: { radioOn },
  }
  const keys = Object.keys(st).join(', ')
  const fn = new Function('st', 'D', `const { ${Object.keys(D).join(', ')} } = D\nlet { ${keys} } = st\n${DREAD()}\n${RADIO()}\nObject.assign(st, { ${keys} })`)
  const run = (seconds) => { const n = Math.round(seconds * 60); for (let i = 0; i < n; i++) { st.playT = Math.round((st.playT + 1 / 60) * 1e6) / 1e6; ctx.currentTime = st.playT; fn(st, D) } }
  return { D, st, run }
}

describe('replayed in the frame', () => {
  it('a thing coming along the halls: the hiss rises with every cell it closes, with no direction in it, and glides there', () => {
    const W = L1(), mid = chunkMid(0, 0), m = findOpenNear(mid.x, mid.y, W.grid.floor) ?? mid
    const player = { x: m.x, y: m.y, angle: 0 }
    const probe = createPathField(); probe.build(Math.floor(m.x), Math.floor(m.y), W.cache)
    const cell = { x: 0, y: 0, d: -1 }
    expect(probe.pick(20, 22, lcg(5), null, cell)).toBe(true)
    const e = thing(cell.x, cell.y), r = rig({ ents: [e], player })
    const log = []
    for (let s = 0; s < 40 && cell.d > 1; s++) {
      r.run(1)
      log.push([cell.d, audio.radioStaticLevel(), glided(hissGain(), r.st.playT)])
      probe.next(Math.floor(cell.x), Math.floor(cell.y), cell); e.x = cell.x; e.y = cell.y   // one cell nearer by the halls
    }
    expect(log.length).toBeGreaterThanOrEqual(18)
    for (let i = 1; i < log.length; i++) {
      expect(log[i][1], `d ${log[i][0]}`).toBeGreaterThan(log[i - 1][1])
      expect(log[i][2], `d ${log[i][0]}`).toBeGreaterThan(log[i - 1][2])
    }
    for (const [d, target] of log) expect(target).toBeCloseTo(staticLevel(0.4 / (1 + d / 6)), 12)   // dread's own number, nothing else
    // turning round changes nothing: the same thing, the same cell, any facing
    r.run(1); const here = audio.radioStaticLevel()
    expect(here).toBeGreaterThan(log.at(-1)[1])
    for (const angle of [Math.PI / 2, Math.PI, -2]) { player.angle = angle; r.run(0.5); expect(audio.radioStaticLevel()).toBe(here) }
    // and the glide is a glide: at most one change per dread read (4 Hz), each a setTargetAtTime
    const calls = hissGain().calls
    expect(calls.every((c) => c[0] === 'setTargetAtTime')).toBe(true)
    expect(calls.length).toBeLessThanOrEqual(Math.ceil(r.st.playT / DREAD_CLOCK.tick) + 1)
  })
  it('a thing two cells off behind a wall, round eighteen by the halls, is faint; the same thing two cells off in the open is not', () => {
    const W = L1(), player = { ...P5 }
    const probe = createPathField(); probe.build(5, 5, W.cache)
    expect([W.grid.floor(7, 5), Math.hypot(7 - 5, 5 - 5), probe.dist(7, 5)]).toEqual([true, 2, 18])
    const behind = rig({ ents: [thing(7.5, 5.5)], player }); behind.run(3)
    const faint = audio.radioStaticLevel()
    const open = cellAt(2)                                   // two steps off by the halls, for comparison
    expect(open).not.toBeNull()
    const near = rig({ ents: [thing(open.x, open.y)], player }); near.run(3)
    expect(faint).toBeGreaterThan(0)
    expect(faint).toBeCloseTo(staticLevel(0.4 / (1 + 18 / 6)), 12)
    expect(audio.radioStaticLevel()).toBeCloseTo(staticLevel(0.4 / (1 + 2 / 6)), 12)
    expect(faint).toBeLessThan(audio.radioStaticLevel() / 2)
  })
  it('a hunt holds it: the thing that saw you counts for no dread, the hiss keeps its level; the hunt gone, it lingers out', () => {
    const c = cellAt(3), e = thing(c.x, c.y), r = rig({ ents: [e], player: { ...P5 } })
    r.run(2); const was = audio.radioStaticLevel()
    expect(was).toBeGreaterThan(0)
    e.ai = 'hunt'; r.D.th.hunted = true; r.run(2)
    expect(r.D.dreadOut.dread).toBe(0); expect(audio.radioStaticLevel()).toBe(was)
    e.ai = 'roam'; e.x = 60.5; r.D.th.hunted = false; r.run(2)
    expect(audio.radioStaticLevel()).toBe(0)
    expect(hissGain().calls.at(-1)).toEqual(['setTargetAtTime', 0, expect.any(Number), STATIC.fall])
  })
  it('the radio off, creatures off, a fade or the block: no hiss is ever built, whatever is near', () => {
    const c = cellAt(2)
    for (const o of [{ radioOn: false }, { live: false }, { transitioning: true }, { map: {} }]) {
      const r = rig({ ents: [thing(c.x, c.y, { variant: 'hound' })], player: { ...P5 }, ...o })
      r.run(5)
      expect(hissGain(), JSON.stringify(o)).toBeNull()
      expect(audio.radioStaticLevel()).toBe(0)
    }
  })
  it('switching the radio off mid-hiss cuts it fast; a radio set down is not yours (the static reads aiCtx.radioOn, the carried one)', () => {
    const c = cellAt(3), r = rig({ ents: [thing(c.x, c.y)], player: { ...P5 } })
    r.run(2); expect(audio.radioStaticLevel()).toBeGreaterThan(0)
    r.D.aiCtx.radioOn = false; r.run(1 / 60)
    expect(audio.radioStaticLevel()).toBe(0)
    expect(hissGain().calls.at(-1)).toEqual(['setTargetAtTime', 0, expect.any(Number), STATIC.cut])
  })
})
