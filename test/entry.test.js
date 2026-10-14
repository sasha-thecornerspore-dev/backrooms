// The front door (owner decision 1, 2026-10-13; launch-fixes F2 option A): a fresh run — solo, anchored or online — comes in through
// the lobby (level 0). Level ∅, the real block, stays in the game and is reached on purpose: the title screen's quiet 'the front door',
// or a saved run that stood there (CONTINUE). The file still writes you into a column on the first way you take, wherever you came in.
// game.js only boots in a page, so the boot is a pure rule (topology.js entryLevel) plus source guards on its wiring.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { entryLevel, LOBBY, BLOCK, waysFor } from '../src/renderer/topology.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { intake, normaliseIntakeCtx, formText } from '../src/renderer/origin-intake.js'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const game = read('../src/renderer/game.js')
const html = read('../src/renderer/index.html')
const at = (src, s, from = 0) => { const k = src.indexOf(s, from); expect(k, s).toBeGreaterThan(0); return k }
const slice = (src, from, to) => { const a = at(src, from), b = src.indexOf(to, a); expect(b, to).toBeGreaterThan(a); return src.slice(a, b) }

describe('entryLevel: the lobby first, the block by the front door', () => {
  it('the lobby is level 0 and the block is ∅', () => {
    expect(LOBBY).toBe(0)
    expect(levelConfig(DEFAULT_CONFIG, LOBBY).levelIndex).toBe(0)
    expect(levelConfig(DEFAULT_CONFIG, BLOCK).levelIndex).toBe('∅')
  })
  it('a fresh solo run, an anchored one and an online one all come in through the lobby', () => {
    expect(entryLevel()).toBe(LOBBY)
    expect(entryLevel({ online: false })).toBe(LOBBY)
    expect(entryLevel({ online: true })).toBe(LOBBY)
  })
  it('the front door is the block, solo only: an online room starts together in the lobby', () => {
    expect(entryLevel({ frontDoor: true })).toBe(BLOCK)
    expect(entryLevel({ online: false, frontDoor: true })).toBe(BLOCK)
    expect(entryLevel({ online: true, frontDoor: true })).toBe(LOBBY)
  })
  it('the block still lets you out one way, into the lobby (its gap)', () => {
    expect(waysFor(BLOCK)[0]).toMatchObject({ target: LOBBY })
    expect(levelConfig(DEFAULT_CONFIG, BLOCK).notes).toEqual([{ x: 6.5, y: 6.5 }])   // the form on the counter is where it was
  })
})

describe('game.js: the boot goes through entryLevel; nothing else about ∅ changed', () => {
  it('initGame takes the front door and the room', () => {
    expect(game).toMatch(/export async function initGame\(canvas, \{ worldSeed = null, mpClient = null, anchor = null, resume = null, intakeCtx = null, room = null, frontDoor = false \} = \{\}\) \{/)
    expect(game).toMatch(/import \{ waysFor, stairsPass, chunkMid, findOpenNear, arrivalFor, wayMessage, wayLabel, entryLevel \} from '\.\/topology\.js'/)
  })
  it('a fresh run builds entryLevel\'s floor, counts the visit, and settles the spawn out of any body it hugs', () => {
    expect(game).toMatch(/buildLevel\(entryLevel\(\{ online: !!mpClient, frontDoor \}\)\); mem\.arrive\(level\.index, spawnChunk, playT\)[^\n]*\r?\n\s*if \(getPref\('solidBodies'\)\) level\.solid\.settlePlayer\(player\)/)
    expect(game).not.toMatch(/buildLevel\(mpClient \? 0 : 4\)/)
    expect((game.match(/buildLevel\(entryLevel\(/g) || []).length).toBe(1)
  })
  it('a fresh run says how to leave its first floor, as a first visit through travel() does (review LR-3)', () => {
    const boot = slice(game, 'buildLevel(entryLevel(', 'showMessage(level.cfg.levelName, PRIO.combat)')
    expect(boot).toMatch(/if \(getPref\('solidBodies'\)\) level\.solid\.settlePlayer\(player\)[^\n]*\r?\n\s*\/\/[^\n]*\r?\n\s*if \(level\.cfg\.exit\?\.hint\) later\(3800, level\.cfg\.exit\.hint, PRIO\.discovery\)\r?\n\s*\}/)
    const resume = slice(game, 'if (resume) {', 'buildLevel(entryLevel(')
    expect(resume).not.toContain('exit?.hint')                    // a resumed run is not a first visit
    expect(levelConfig(DEFAULT_CONFIG, LOBBY).exit.hint).toBe('the walls are thin here — no-clip through a torn corner and you fall out of the lobby.')
    expect(at(game, 'function later(ms, text, prio)')).toBeLessThan(at(game, 'buildLevel(entryLevel('))
  })
  it('the resume is untouched: a saved run on ∅ comes back to ∅', () => {
    const resume = slice(game, 'if (resume) {', 'buildLevel(entryLevel(')
    expect(resume).toContain('const r = applyResume(resume, {')
    expect(resume).not.toContain('frontDoor')
  })
  it('the filing is the first way, wherever it starts: travel never asks which floor you came in on', () => {
    const travel = slice(game, 'function travel(way) {', '// die(): death.js resolves it')
    expect(travel).toMatch(/if \(!filed\) \{\r?\n\s*intakeCtx\.arrival = mpClient \? mpClient\.arrival\(\) : 'walked'\r?\n\s*filed = true; origin = intake\(intakeCtx\)/)
    expect(travel).not.toMatch(/frontDoor|index === 4|index === BLOCK/)
  })
  it('replayed: a solo filing from the lobby writes the same column the block did (the form\'s facts, not the floor)', () => {
    for (const title of [{ name: 'ada' }, { name: '' }, { name: 'ada', anchor: { lat: 39.2904, lng: -76.6122 } }]) {
      const ctx = normaliseIntakeCtx({ route: 'solo', arrival: null, anchor: title.anchor ?? null, name: title.name }, null)
      ctx.arrival = 'walked'                                   // travel(): solo is always 'walked', from either floor
      expect(intake(ctx)).toBe(title.anchor ? 'anchored' : title.name ? 'tenant' : 'unnamed')
      expect(formText(ctx, null)[0]).toBe('intake.')          // the form reads the same on the counter (∅) and through /intake (anywhere)
    }
  })
})

describe('index.html: the front door, quiet, under the ways in', () => {
  it('a small lowercase choice with its one line, outside the button row', () => {
    expect(html).toMatch(/<div id="front-door">\r?\n\s*<button id="btn-front-door" type="button">the front door<\/button>\r?\n\s*<div id="front-door-hint">a real block\. read the form\. find the gap\.<\/div>\r?\n\s*<\/div>/)
    const btns = slice(html, '<div class="btns">', '</div>')
    expect(btns).not.toContain('front-door')
    expect(at(html, '<div id="front-door">')).toBeGreaterThan(at(html, '<div class="btns">'))
  })
  it('it is not a notice panel: no wall-yellow plate, no capitals, small type', () => {
    const rule = html.match(/#start #btn-front-door \{[^}]*\}/)
    expect(rule).not.toBe(null)
    expect(rule[0]).toMatch(/background: none;/)
    expect(rule[0]).toMatch(/border: none;/)
    expect(rule[0]).toMatch(/font: 12px var\(--mono\);/)
    expect(html).not.toMatch(/#btn-solo, #start #btn-continue, #start #btn-front-door/)
  })
  it('SOLO and the front door start the same solo run; only the door says frontDoor', () => {
    const solo = slice(html, 'async function startSolo(', '// one connection attempt at a time')
    expect(solo).toMatch(/async function startSolo\(\{ frontDoor = false \} = \{\}\) \{/)
    expect(solo).toContain("const intakeCtx = intakeFor('solo', anchor)")
    expect(solo).toContain('await initGame(canvas, { ...opts, frontDoor })')
    expect(html).toMatch(/document\.getElementById\('btn-solo'\)\.onclick = \(\) => \{\r?\n\s*startStatus\.textContent = ''\r?\n\s*startSolo\(\)/)
    expect(html).toMatch(/document\.getElementById\('btn-front-door'\)\.onclick = \(\) => \{\r?\n\s*startStatus\.textContent = ''\r?\n\s*startSolo\(\{ frontDoor: true \}\)/)
  })
  it('one start for every way in: SOLO, the front door, CONTINUE and every online / LAN join check the same flag (review LR-1)', () => {
    expect(html).toMatch(/let starting = false\r?\n\s*function beginStart\(\) \{\r?\n\s*if \(starting\) return false\r?\n\s*starting = true\r?\n\s*startEl\.inert = true\r?\n\s*return true\r?\n\s*\}/)
    expect(html).toMatch(/function startFailed\(\) \{\r?\n\s*starting = false\r?\n\s*startEl\.inert = false\r?\n\s*\}/)
    const solo = slice(html, 'async function startSolo(', '// one connection attempt at a time')
    expect(solo).toMatch(/\{\r?\n\s*if \(!beginStart\(\)\) return\r?\n/)
    const mp = slice(html, 'async function startMultiplayer(', '// the relay\'s room')
    expect(mp).toMatch(/\{\r?\n\s*if \(!beginStart\(\)\) return\r?\n/)
    expect(mp).toMatch(/catch \(e\) \{\r?\n[^\n]*\r?\n\s*startFailed\(\)/)
    const cont = slice(html, 'cont.onclick = async () => {', 'await initGame(')
    expect(cont).toMatch(/cont\.onclick = async \(\) => \{\r?\n\s*if \(!beginStart\(\)\) return/)
    expect(html).not.toMatch(/soloBusy|mpBusy/)
    // the invite's JOIN, the modal's ENTER, JOIN LAN and HOST LAN all reach the game only through startMultiplayer
    expect((html.match(/await initGame\(/g) || []).length).toBe(3)
    expect((html.match(/if \(!beginStart\(\)\) return/g) || []).length).toBe(3)
  })
  it('the guard, run: SOLO waiting on a short link, then CONTINUE, starts one game, not two (review LR-1)', async () => {
    const decl = slice(html, 'let starting = false', '// a fresh solo run comes in')
    const startEl = { inert: false }
    const { beginStart, startFailed } = new Function('startEl', decl + '\nreturn { beginStart, startFailed }')(startEl)
    let games = 0, answer
    const lookup = new Promise((r) => { answer = r })
    const solo = async () => { if (!beginStart()) return; await lookup; games++ }
    const cont = async () => { if (!beginStart()) return; games++ }
    const s = solo()
    expect(startEl.inert).toBe(true)                                // the title takes no second press while the pin is looked up
    await cont()
    answer(); await s
    expect(games).toBe(1)
    startFailed()
    expect([startEl.inert, beginStart()]).toEqual([false, true])      // a join that failed gives the title back
  })
  it('the title no longer promises the block to everyone', () => {
    expect(html).toContain('<div class="sub">level 0. somewhere. you are here.</div>')
  })
})

describe('tools/gfx/page.cjs: the boot check comes in either way', () => {
  const page = read('../tools/gfx/page.cjs')
  it('--start clicks SOLO (the lobby), --door clicks the front door (the block), a planted save still lands on its own level', () => {
    expect(page).toContain("const wantStart = flags.has('start') || flags.has('door') || levelArg !== undefined")
    const cont = at(page, "if (levelArg !== undefined) await exec(`document.getElementById('btn-continue').click()`)")
    const door = at(page, "else if (flags.has('door')) await exec(`document.getElementById('btn-front-door').click()`)")
    const solo = at(page, "else await exec(`document.getElementById('btn-solo').click()`)")
    expect(cont).toBeLessThan(door); expect(door).toBeLessThan(solo)
    expect(page).toMatch(/^\/\/ {3}--door {13}click the title screen's front door instead: a fresh solo run on Level ∅/m)
    expect(page).not.toContain('a fresh solo run enters through Level ∅')
  })
})
