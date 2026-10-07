// Fight-verbs wiring (integrator step "fight"): game.js counts the ward's press / release edges (keyboard + the WARD touch button) and
// ticks ward.js's charger every frame — tap or hold-to-charge, the slow-down and drain while charging, the cooldown inside the charger,
// 'winded' denied, a latch dropped (never fired) when the chat opens / the window blurs / the pointer lock is lost / a card is up; X and the
// dock's ✕ set the selected item down through items.throwSelected (a talking radio keeps talking, a glowstick is a breadcrumb, the finds
// are kept); the dropped things' clocks and lures run each frame (the lures reach the hunt's aiCtx, the radio hum, and the noise the
// things hear); Q on a bandage on floors 1-3 is a 1.2 s committed wrap a hit cancels; sweet water quiets your steps and sour water is a
// noise; tension.js replaces the heartbeat block and drives audio.setMood without a restart. game.js only boots in a page, so these are
// source guards, plus the pieces replayed against the real modules (ward.js, touch.js, audio.js).
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import { createWardCharger, wardOpts } from '../src/renderer/ward.js'
import { initTouchControls } from '../src/renderer/touch.js'
import * as audio from '../src/renderer/audio.js'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const game = read('../src/renderer/game.js')
const touch = read('../src/renderer/touch.js')
const sw = read('../src/sw.js')
const build = read('../tools/build-play.sh')
const readme = read('../README.md')
const html = read('../src/renderer/index.html')
const at = (s) => { const k = game.indexOf(s); expect(k, s).toBeGreaterThan(0); return k }
const loopAt = game.indexOf('function loop(ts) {')

describe('game.js: the real exported names, and the fight-verbs placeholders are gone', () => {
  it('imports the charger and wardOpts, the tactics quartet, the tension trio and audio.setMood', () => {
    expect(game).toMatch(/import \{ quiet, lureWithin, createCommit, QUIET_SECONDS \} from '\.\/tactics\.js'/)
    expect(game).toMatch(/import \{ createWardCharger, wardOpts \} from '\.\/ward\.js'/)
    expect(game).toMatch(/import \{ createTension, huntDelta, calmDelta \} from '\.\/tension\.js'/)
    expect(game).toMatch(/import \{ [^}]*\bsetMood\b[^}]* \} from '\.\/audio\.js'/)
  })
  it('no TODO(integrate:fight-verbs) is left; the three verbs are built once, outside the loop', () => {
    expect(game).not.toMatch(/TODO\(integrate:fight-verbs\)/)
    for (const s of ['const charger   = createWardCharger()', 'const wardInput = { press: 0, release: 0 }', 'const commit    = createCommit(1.2)', 'const tension   = createTension()']) {
      expect(at(s)).toBeLessThan(loopAt)
      expect((game.match(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length).toBe(1)
    }
    expect(game).toMatch(/const EMPTY_WARD = \{ hit: 0, dispelled: 0, opening: 0 \}/)
  })
  it('the old ward is gone: no wardCd, no K[\'Space\'] edge-consume, no bare entitySys.ward(player)', () => {
    expect(game).not.toMatch(/wardCd/)
    expect(game).not.toMatch(/if \(K\['Space'\]\) \{/)
    expect(game).not.toMatch(/entitySys\.ward\(player\)/)
    expect(game).not.toMatch(/stamina -= 20; /)
  })
})

describe('game.js: the ward edges and the latch drops', () => {
  it('keydown Space (after takeKey, which drops the held repeats) counts a press; keyup Space a release', () => {
    expect(game).toMatch(/K\[e\.code\] = true\r?\n\s*if \(e\.code === 'Space'\) wardInput\.press\+\+/)
    expect(game).toMatch(/window\.addEventListener\('keyup',\s*e => \{ K\[e\.code\] = false; if \(e\.code === 'Space'\) wardInput\.release\+\+ \}\)/)
    expect(at("if (r === 'ignore') return")).toBeLessThan(at("if (e.code === 'Space') wardInput.press++"))
  })
  it('the WARD touch button feeds the same counters', () => {
    expect(game).toMatch(/initTouchControls\(\{ canvas, K, player, getPref, edges: \{ Space: wardInput \} \}\)/)
  })
  it('a latch is dropped without firing on chat open, blur, a hidden tab and a lost pointer lock (the K sweep on blur stays)', () => {
    expect(game).toMatch(/window\.addEventListener\('blur', \(\) => \{ for \(const k in K\) K\[k\] = false; charger\.forceRelease\(\) \}\)/)
    expect(game).toMatch(/if \(document\.hidden\) \{ for \(const k in K\) K\[k\] = false; charger\.forceRelease\(\) \}/)
    expect(game).toMatch(/locked = document\.pointerLockElement === canvas; if \(!locked\) charger\.forceRelease\(\)/)
    const chat = game.slice(game.indexOf('function openChat()'), game.indexOf('function closeChat()'))
    expect(chat).toContain('charger.forceRelease()')
  })
})

describe('game.js: the charger block at the head of the frame', () => {
  const block = game.slice(game.indexOf('let verbMul = 1'), game.indexOf('let moved = false'))
  it('ticks EVERY frame on the edge counts, before the movement block, and a modal frame drops the latch instead of acting', () => {
    expect(at('let verbMul = 1')).toBeGreaterThan(loopAt)
    expect(at('const w = charger.tick(dt, wardInput.press, wardInput.release, stamina)')).toBeLessThan(at('let moved = false'))
    expect(block).toMatch(/if \(modal\) charger\.forceRelease\(\)/)
    expect(game).toMatch(/const modal = transitioning \|\| dialogOpen \|\| chatOpen \|\| noteOpen/)
    expect(at('const modal = transitioning')).toBeLessThan(at('let verbMul = 1'))
  })
  it('charging slows the step (verbMul) and drains the legs; denied says so; a fire costs, wards with the tap / charged opts, is a noise of 12 and shakes 0.45 / 0.7', () => {
    expect(block).toMatch(/else if \(w\?\.charging\) \{ stamina = Math\.max\(0, stamina - w\.drain \* dt\); verbMul \*= w\.moveMul \}/)
    expect(block).toMatch(/else if \(w\?\.denied\) showMessage\('nothing left in your legs to push with\.'\)/)
    expect(block).toMatch(/else if \(w\) \{\r?\n\s*stamina -= w\.cost\r?\n\s*const res = getPref\('creatures'\) \? level\.entitySys\.ward\(player, wardOpts\(w\.charged\)\) : EMPTY_WARD\r?\n\s*level\.entitySys\.noise\(player\.x, player\.y, 12\)/)
    expect(block).toMatch(/wardPulse\(\); shake = Math\.max\(shake, w\.charged \? 0\.7 : 0\.45\)/)
    expect(game).toMatch(/const sp = SPEED \* dt \* 60 \* mult \* verbMul/)
  })
  it('the lines: dispelled, the opening caught, recoil, nothing — and a dispel steadies you by 10', () => {
    expect(block).toMatch(/if\s+\(res\.dispelled > 0\) showMessage\(res\.dispelled > 1 \? 'they come apart in the light\.' : 'it comes apart in the light\.'\)/)
    expect(block).toMatch(/else if \(res\.opening > 0\)\s+showMessage\('you catch it turning\. it reels\.'\)/)
    expect(block).toMatch(/else if \(res\.hit > 0\)\s+showMessage\(res\.hit > 1 \? \(rules\.wardRecoil \? 'they recoil from you\. so do you\.' : 'they recoil from you\.'\) : \(rules\.wardRecoil \? RECOIL_LINE : 'it recoils from you\.'\)\)/)   // origins (I5): thin's recoil line
    expect(block).toMatch(/else\s+showMessage\('you push at the dark\. it gives nothing back\.'\)/)
    expect(block).toMatch(/sanity = Math\.min\(100, sanity \+ 10 \* res\.dispelled\)/)
    // the order: dispelled before the opening before the plain hit
    expect(block.indexOf('res.dispelled > 0')).toBeLessThan(block.indexOf('res.opening > 0'))
    expect(block.indexOf('res.opening > 0')).toBeLessThan(block.indexOf('res.hit > 0'))
  })
})

describe('game.js: set down (X and the dock ✕), the dropped things\' clocks, the lures', () => {
  it('X and #btn-discard both call one throwSelected(); the old discardSelected wrapper is gone', () => {
    expect(game).toMatch(/if \(K\['KeyX'\]\) \{ K\['KeyX'\] = false; throwSelected\(\) \}/)
    expect(game).toMatch(/document\.getElementById\('btn-discard'\)\?\.addEventListener\('click', throwSelected\)/)
    expect(game).not.toMatch(/function discardSelected\(\)/)
    expect(game).not.toMatch(/itemSys\.discardSelected\(\)/)
  })
  it('throwSelected: items.throwSelected on the play clock, the four outcomes, then the hotbar; the memory write is the loop\'s, on its one dirty read', () => {
    const fn = game.slice(game.indexOf('function throwSelected()'), game.indexOf("document.getElementById('btn-discard')"))
    expect(fn).toContain('const r = itemSys.throwSelected(player.x, player.y, player.angle, playT)')
    expect(fn).toMatch(/if \(!r\.ok\) \{ if \(r\.reason === 'kept'\) showMessage\('you do not put that down\.'\) \}/)
    expect(fn).toContain("t === 'radio' && r.item.on ? 'you set the radio down, still talking. let it talk.'")
    expect(fn).toContain("t === 'glowstick'          ? 'you leave the green light where it lies.'")
    expect(fn).toContain('`you drop the ${ITEM_NAMES[t] ?? t}.`')
    expect(fn).toContain('renderHotbar()')
    expect(fn).not.toMatch(/TODO\(integrate:/)
    expect(game).toMatch(/if \(itemsDirty\) \{ mem\.setDropped\(level\.index, itemSys\.getDropped\(\)\); persist\(\) \}/)
  })
  it('each frame: the clocks run first (their two ambient lines), then the lures (one isDirty read, 0.5 s), then the radio hum reads the lures within 12 u', () => {
    expect(game).toMatch(/const expired = itemSys\.expireDropped\(playT\)\r?\n\s*for \(let i = 0; i < expired\.length; i\+\+\) showMessage\(expired\[i\]\.kind === 'battery' \? 'the batteries go\.' : 'the green light gutters out\.', PRIO\.ambient\)/)
    expect(game).toMatch(/const radioOn = itemSys\.isRadioOn\(\) \|\| lureWithin\(lures, player\.x, player\.y, 12\)/)
    expect(at('const expired = itemSys.expireDropped(playT)')).toBeLessThan(at('const itemsDirty = itemSys.isDirty()'))
    expect(at('const itemsDirty = itemSys.isDirty()')).toBeLessThan(at('const radioOn = itemSys.isRadioOn()'))
    // the hunt's ctx.radioOn is the CARRIED radio only (variants.json: a carried playing radio widens the tesla's sight; set down, it is a lure)
    expect(at('const radioOn = itemSys.isRadioOn()')).toBeLessThan(at('aiCtx.radioOn = itemSys.isRadioOn();'))
    expect(game).not.toMatch(/aiCtx\.radioOn = radioOn/)
    expect(game).not.toMatch(/for \(const ev of itemSys\.expireDropped/)      // indexed over the reused array: nothing allocated per frame
  })
  it('the dropped radios are a noise of 8 every 0.5 s, flooded after the grid follows this frame\'s chunk, only while the things are live', () => {
    expect(game).toMatch(/lureNoiseT \+= dt\r?\n\s*if \(lureNoiseT >= 0\.5\) \{\r?\n\s*lureNoiseT = 0\r?\n\s*if \(creaturesLive\) for \(let i = 0; i < lures\.length; i\+\+\) level\.entitySys\.noise\(lures\[i\]\.x, lures\[i\]\.y, 8\)/)
    expect(at('level.grid.setPlayerChunk(pcx, pcy)')).toBeLessThan(at('lureNoiseT += dt'))
    expect(at('const creaturesLive = creaturesOn && !!cfg.entities?.enabled')).toBeLessThan(at('lureNoiseT += dt'))
  })
  it('buildLevel enters the level with what the floor remembers (levelmem): the keys taken and the items set down, nothing for the block', () => {
    expect(game).toMatch(/itemSys\.enterLevel\(cfg, cfg\.map \? null : mem\.takenFor\(index\), cfg\.map \? null : mem\.droppedFor\(index\)\)/)
    expect(game).not.toMatch(/TODO\(integrate:floors\)/)
  })
})

describe('game.js: the bandage commit, the quiet water, the sour noise', () => {
  it('Q on a bandage on floors 1-3 starts the commit without consuming (and does not restart a running one); everything else uses as before', () => {
    expect(game).toMatch(/const it = itemSys\.peekSelected\(\)\r?\n\s*if \(it\?\.type === 'bandage' && level\.index >= 1 && level\.index <= 3\) \{ if \(!commit\.active\) \{ commit\.start\(\); showMessage\('you hold still and wrap it\.'\) \} \}\r?\n\s*else applyItemEffect\(itemSys\.useSelected\(\)\)/)
  })
  it('the commit ticks every frame: running slows the step to 0.4, done consumes the SELECTED item and applies it', () => {
    expect(game).toMatch(/const c = commit\.tick\(dt\)\r?\n\s*if \(c === 'running'\) verbMul \*= 0\.4\r?\n\s*else if \(c === 'done'\) applyItemEffect\(itemSys\.consumeSelected\(\)\)/)
    expect(at('const c = commit.tick(dt)')).toBeLessThan(at('let moved = false'))
  })
  it('a hit cancels it with the line; buildLevel and a set-down / slot change cancel it quietly; die says the line', () => {
    expect(game).toMatch(/function cancelCommit\(msg\) \{ if \(commit\.active\) \{ commit\.cancel\(\); if \(msg\) showMessage\(msg\) \} \}/)
    expect(game).toMatch(/lastHitT = playT\r?\n\s*if \(mapOpen\) closeMap\(\); if \(noteOpen\) closeNoteCard\(\)\r?\n\s*cancelCommit\('the bandage slips\.'\)/)
    const build = game.slice(game.indexOf('function buildLevel(index, at = null)'), game.indexOf('const fader = createFader('))
    expect(build).toMatch(/cancelCommit\(\)\s/)
    expect(build).toContain('tension.reset(); huntMood = false')
    const die = game.slice(game.indexOf('function die()'), game.indexOf('// ── input ──'))
    expect(die).toContain("cancelCommit('the bandage slips.')")
    expect(game).toMatch(/if \(K\[code\]\) \{ K\[code\] = false; cancelCommit\(\); itemSys\.select\(i\); renderHotbar\(\) \}/)
    expect(game).toMatch(/el\.addEventListener\('click', \(\) => \{ cancelCommit\(\); itemSys\.select\(\+el\.dataset\.slot\); renderHotbar\(\) \}\)/)
  })
  it('sweet almond water quiets your steps for QUIET_SECONDS (counted down each frame; the footstep emitter reads quiet(quietTimer)); sour water is a noise of 6', () => {
    expect(game).toMatch(/quietTimer = QUIET_SECONDS/)
    expect(game).toMatch(/if \(quietTimer > 0\) quietTimer -= dt/)
    expect(game).toMatch(/\* quiet\(quietTimer\)\)/)
    const water = game.slice(game.indexOf("if (eff.type === 'almond-water') {"), game.indexOf("} else if (eff.type === 'glowstick') {"))
    expect(water).toMatch(/if \(eff\.sour\) \{\r?\n\s*level\.entitySys\.noise\(player\.x, player\.y, 6\)/)
  })
})

describe('game.js: tension replaces the heartbeat block', () => {
  const block = game.slice(game.indexOf('const tn = tension.tick('), game.indexOf('// ── sanity —'))
  it('the hunt\'s report (null for a fade / creatures off / a floor without creatures) and hp feed it; the heartbeat follows its beat and level', () => {
    expect(block).toContain('const tn = tension.tick(dt, creaturesLive && !transitioning ? th : null, player.hp)')
    expect(block).toMatch(/heartT -= dt\r?\n\s*if \(tn\.beat < Infinity && heartT <= 0\) \{ heartbeat\(0\.5 \+ tn\.level\); heartT = tn\.beat \}/)
    expect(game).not.toMatch(/heartT = 1\.15 - prox \* 0\.8/)
  })
  it('enter / exit patch the live mood from the pristine base (never a setMusic), close says its line as combat, the mood is remembered for N', () => {
    expect(block).toContain('const songBase = trackIdx < 0 ? cfg.music : TRACKS[trackIdx].mood')
    expect(block).toContain("if (tn.just === 'enter') setMood(huntDelta(songBase))")
    expect(block).toContain("if (tn.just === 'exit') setMood(calmDelta(songBase))")
    expect(block).toContain("huntMood = tn.mood === 'hunt'")
    expect(block).toContain("if (tn.close && playT - lastSeenLine > 1.6) showMessage('it is close.', PRIO.combat)")
    expect(block).not.toContain('setMusic(')
  })
  it('the whisper window shrinks with the tension', () => {
    expect(game).toMatch(/sanWhisperT = \(3 \+ Math\.random\(\) \* 6\) \* \(1 - 0\.5 \* tn\.level\)/)
  })
  it('the song is always a COPY of the base mood (setMood patches it in place), and a track cycled mid-hunt takes the hunt delta at once', () => {
    expect(game).toMatch(/function playSong\(base\) \{\r?\n\s*setMusic\(\{ \.\.\.base \}\)\r?\n\s*if \(huntMood\) setMood\(huntDelta\(base\)\)\r?\n\s*\}/)
    expect((game.match(/\bsetMusic\(/g) || []).length).toBe(1)       // only playSong calls it
    expect(game).toContain('playSong(trackIdx < 0 ? cfg.music : TRACKS[trackIdx].mood)')
    expect(game).toContain('playSong(level.cfg.music)')
    expect(game).toContain('playSong(t.mood)')
  })
})

describe('the words', () => {
  it('every fight-verbs line is lowercase, understated, in-fiction: no capitals, no exclamation marks', () => {
    for (const s of ['nothing left in your legs to push with.', 'you catch it turning. it reels.', 'you do not put that down.',
      'you set the radio down, still talking. let it talk.', 'you leave the green light where it lies.', 'the batteries go.',
      'the green light gutters out.', 'you hold still and wrap it.', 'the bandage slips.', 'it is close.']) {
      expect(game).toContain(`'${s}'`)
      expect(s).toBe(s.toLowerCase()); expect(s).not.toContain('!')
    }
  })
  it('README controls rows read "space (hold to charge)" and "x · set down"; the HUD hint and the dock button say set down', () => {
    expect(readme).toMatch(/^\| space \(hold to charge\) \| /m)
    expect(readme).toMatch(/^\| x · set down \| /m)
    expect(html).toContain('<span>x set down</span>')
    expect(html).toContain('title="set the selected item down (x)"')
    // FEEL-10: the visible label says it too (the narrow-screen ::before '✕' is unchanged)
    expect(html).toContain('title="set the selected item down (x)">✕ set down</button>')
    expect(html).not.toContain('✕ discard')
    expect(html).toContain("#btn-discard::before { content: '✕'; font-size: 14px; }")
  })
})

describe('offline shell lists carry the modules game.js now imports directly', () => {
  for (const f of ['ward.js', 'tactics.js', 'tension.js']) {
    it(`${f} is in src/sw.js and tools/build-play.sh`, () => {
      expect(sw).toContain(`'/renderer/${f}'`)
      expect(build).toContain(`'${f}'`)
    })
  }
})

describe('audio.js setMood (integrator)', () => {
  it('is exported, so the audio-mood case runs; and it never restarts the schedulers', () => {
    expect(typeof audio.setMood).toBe('function')
    const src = read('../src/renderer/audio.js')
    const fn = src.slice(src.indexOf('export function setMood(partial)'), src.indexOf('export function setMusicEnabled'))
    expect(fn).toContain('Object.assign(music.mood, partial)')
    expect(fn).not.toContain('restartSchedulers()')
    expect(fn).not.toContain('setInterval')
    expect(fn).toMatch(/if \(partial\.brightness != null && music\.bus\) music\.bus\.frequency\.setTargetAtTime\(partial\.brightness, actx\.currentTime, 2\)/)
    expect(fn).toMatch(/if \(partial\.volume != null\) music\.master\.gain\.setTargetAtTime\(music\.enabled \? partial\.volume \* music\.volScale : 0, actx\.currentTime, 2\.0\)/)
  })
})

// ── the game's charger rule replayed against the real ward.js: a modal frame drops the latch, a tap and a hold fire the right opts ──
describe('the charger rule game.js runs (replayed)', () => {
  function frame(ch, dt, input, stamina, modal) {
    const w = ch.tick(dt, input.press, input.release, stamina)
    if (modal) { ch.forceRelease(); return null }
    return w
  }
  it('a press that lands while a card is up never wards (the latch is dropped the same frame); its release falls on nothing', () => {
    const ch = createWardCharger(), input = { press: 0, release: 0 }
    input.press++
    expect(frame(ch, 1 / 60, input, 100, true)).toBeNull()
    expect(ch.isCharging()).toBe(false)
    input.release++
    expect(frame(ch, 1 / 60, input, 100, false)).toBeNull()
  })
  it('a tap wards with WARD_TAP; a 0.5 s hold slows the step (0.55) then wards with WARD_CHARGED', () => {
    const ch = createWardCharger(), input = { press: 0, release: 0 }
    input.press++; input.release++
    const w = frame(ch, 1 / 60, input, 100, false)
    expect(w.charged).toBe(false); expect(wardOpts(w.charged)).toBe(wardOpts(false)); expect(w.cost).toBe(20)
    const ch2 = createWardCharger(), in2 = { press: 0, release: 0 }
    in2.press++
    let w2 = frame(ch2, 1 / 60, in2, 100, false)
    expect(w2.charging).toBe(true); expect(w2.moveMul).toBe(0.55); expect(w2.drain).toBe(6)
    for (let i = 0; i < 30; i++) w2 = frame(ch2, 1 / 60, in2, 100, false)
    in2.release++
    w2 = frame(ch2, 1 / 60, in2, 100, false)
    expect(w2.charged).toBe(true); expect(wardOpts(w2.charged).range).toBe(4.0); expect(w2.cost).toBe(35)
  })
})

// ── touch.js: the WARD button counts its edges and lets go of the key; the other buttons still leave the key for the loop to consume ──
describe('touch.js edges (integrator)', () => {
  const saved = {}
  function fakeDom() {
    const made = []
    const mk = (tag) => {
      const el = {
        tag, children: [], listeners: Object.create(null), dataset: {}, style: {}, className: '', textContent: '', title: '',
        classList: { add() {}, remove() {} },
        appendChild(c) { this.children.push(c); return c }, append(...cs) { for (const c of cs) this.children.push(c) },
        addEventListener(t, f) { (this.listeners[t] || (this.listeners[t] = [])).push(f) },
        getBoundingClientRect() { return { left: 0, top: 0, width: 132, height: 132 } },
        remove() {},
      }
      made.push(el); return el
    }
    return { made, document: { createElement: mk, getElementById: () => null, head: mk('head'), body: mk('body'), addEventListener() {} } }
  }
  afterEach(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k] } })
  it('source: initTouchControls takes `edges`; press++ on touchstart, release++ and the key let go on touchend / touchcancel; ACTIONS is six', () => {
    expect(touch).toMatch(/export function initTouchControls\(\{ canvas, K, player, getPref, edges = null \} = \{\}\)/)
    expect(touch).toMatch(/if \(edge\) edge\.press\+\+/)
    expect(touch).toMatch(/if \(edge\) \{ edge\.release\+\+; K\[code\] = false \}/)
    const codes = [...touch.match(/const ACTIONS = \[([\s\S]*?)\n\]/)[1].matchAll(/code:\s*'([^']+)'/g)].map((x) => x[1])
    expect(codes).toEqual(['KeyF', 'KeyQ', 'Space', 'KeyE', 'KeyL', 'KeyC'])
    expect(touch).toMatch(/\{ code: 'KeyC', label: 'CALL', hint: 'whistle' \}/)
    // six discs and ACT overflow a landscape phone: the top of the stack wraps into a second column to the left
    expect(touch).toContain('flex-wrap: wrap-reverse')
  })
  it('replayed: WARD moves press on touchstart and release on touchend (clearing K.Space); ACT leaves K.KeyF for the loop', () => {
    for (const k of ['window', 'document']) saved[k] = globalThis[k]
    globalThis.window = { ontouchstart: null, addEventListener() {}, matchMedia: () => ({ matches: true }) }
    const { document, made } = fakeDom()
    globalThis.document = document
    const K = Object.create(null), edges = { Space: { press: 0, release: 0 } }
    const ui = initTouchControls({ canvas: {}, K, player: { angle: 0 }, getPref: () => 100, edges })
    expect(ui).not.toBeNull()
    const btn = (code) => made.find((el) => el.dataset.code === code)
    const ev = { preventDefault() {}, stopPropagation() {} }
    const ward = btn('Space'), act = btn('KeyF')
    expect(ward).toBeDefined(); expect(act).toBeDefined()
    ward.listeners.touchstart[0](ev)
    expect(K.Space).toBe(true); expect(edges.Space.press).toBe(1); expect(edges.Space.release).toBe(0)
    ward.listeners.touchend[0]()
    expect(edges.Space.release).toBe(1); expect(K.Space).toBe(false)
    ward.listeners.touchstart[0](ev); ward.listeners.touchcancel[0]()
    expect(edges.Space.press).toBe(2); expect(edges.Space.release).toBe(2)
    act.listeners.touchstart[0](ev); act.listeners.touchend[0]()
    expect(K.KeyF).toBe(true)                                   // the loop edge-consumes it, as before
    const call = btn('KeyC')
    expect(call).toBeDefined(); expect(call.title).toBe('whistle')
    call.listeners.touchstart[0](ev); call.listeners.touchend[0]()
    expect(K.KeyC).toBe(true)                                   // CALL is a plain key button: the loop edge-consumes the whistle
  })
})
