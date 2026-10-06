// Foundation wiring (integrator): game.js speaks through the message queue with a priority on every line that needs one, takes its keys
// through input.js takeKey (and sweeps the key map on blur / hidden), reads the grid through world.js createGridReader, and no longer
// drains sanity on Level ∅ as if it were a fourth floor. game.js only boots in a page, so these are source guards plus the loop's DOM
// write replayed against the real queue.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { createMessageQueue, PRIO } from '../src/renderer/messages.js'

const game = fs.readFileSync(new URL('../src/renderer/game.js', import.meta.url), 'utf8')
const sw = fs.readFileSync(new URL('../src/sw.js', import.meta.url), 'utf8')
const build = fs.readFileSync(new URL('../tools/build-play.sh', import.meta.url), 'utf8')

describe('game.js: one voice (messages.js)', () => {
  it('showMessage only pushes into the queue; the timer fade and the direct DOM write are gone', () => {
    expect(game).toMatch(/import \{ createMessageQueue, PRIO \} from '\.\/messages\.js'/)
    expect(game).toMatch(/const msgQ = createMessageQueue\(\)/)
    expect(game).toMatch(/function showMessage\(text, prio = PRIO\.interaction\) \{ if \(text\) msgQ\.push\(String\(text\), prio\) \}/)
    expect(game).not.toMatch(/showMessage\._t/)
    expect(game).not.toMatch(/setTimeout\(\(\) => \{ msgEl\.style\.opacity = '0' \}, 4200\)/)
  })
  it('the loop ticks the queue right after the movement block and writes #msg from the one result', () => {
    const i = game.indexOf("const bobBase = (moved && getPref('headBob'))")
    const j = game.indexOf('const mq = msgQ.tick(dt)')
    const k = game.indexOf('if (fogTimer > 0) fogTimer -= dt')
    expect(i).toBeGreaterThan(0); expect(j).toBeGreaterThan(i); expect(k).toBeGreaterThan(j)
    expect(game).toMatch(/if \(mq && msgEl\) \{ if \(mq\.show\) \{ msgEl\.textContent = mq\.text; msgEl\.style\.opacity = '1' \} else msgEl\.style\.opacity = '0' \}/)
  })
  it('every line that must win or must yield carries its priority', () => {
    expect(game).toMatch(/showMessage\(th\.dmgKind === 'arc' \? 'the current finds you\.' : 'it has you\.', PRIO\.combat\)/)   // the creatures step: the jolt has its own line
    // travel: the level name wins at once; on a first visit the way hint is a discovery line that follows it
    expect(game).toMatch(/showMessage\(level\.cfg\.levelName, PRIO\.combat\)\r?\n\s+const wm = wayMessage\(way, \{ partner, mem: mem\.get\(way\.target\) \}\)\r?\n\s+if \(first\) \{\r?\n\s+if \(level\.cfg\.exit\?\.hint\) setTimeout\(\(\) => showMessage\(level\.cfg\.exit\.hint, PRIO\.discovery\), 3800\)/)
    // dying: 'everything goes dark.' is combat; the wake line (death.js) follows as discovery
    expect(game).toMatch(/showMessage\('everything goes dark\.', PRIO\.combat\)/)
    expect(game).toMatch(/setTimeout\(\(\) => showMessage\(r\.message, PRIO\.discovery\), 2600\)/)
    expect(game).toMatch(/buildLevel\(mpClient \? 0 : 4\)[^\n]*\r?\n\s*\}\r?\n\s*showMessage\(level\.cfg\.levelName, PRIO\.combat\)/)
    expect(game).toMatch(/showMessage\(level\.messages\[Math\.floor\(Math\.random\(\) \* level\.messages\.length\)\], PRIO\.ambient\)/)
    // event lines: ambient, except the two that answer to you
    for (const line of [
      'the lights go out ahead of you, one by one. then, slowly, they come back.',
      'the hum stops. the silence has a shape. then it resumes, as if something had been listening.',
      'a cold spot. your breath fogs where there is nothing cold enough to fog it.',
      'footsteps. not yours. they keep your pace, and stop when you stop.',
    ]) expect(game).toContain(`showMessage('${line}', PRIO.ambient)`)
    expect(game).toContain("showMessage('somewhere behind you, a door slams shut.')")
    expect(game).toContain("showMessage('far down the hall, something crosses the intersection. the hall is empty when you look again.')")
    // ward results stay on the default (interaction)
    expect(game).toContain("showMessage('you push at the dark. it gives nothing back.')")
  })
  it('buildLevel clears the queue once the new level object stands', () => {
    expect(game).toMatch(/level = \{ index, cfg, cache, grid, bodies, decor, solid, entitySys, gfx, messages \}\r?\n\s*decor\.update\(spawnChunk\.cx, spawnChunk\.cy\); itemSys\.update\(spawnChunk\.cx, spawnChunk\.cy\)\r?\n\s*msgQ\.clear\(\)/)
  })
  it("the loop's DOM write, replayed: a floor murmur never talks over 'it has you.', and the line fades once", () => {
    const el = { textContent: '', style: { opacity: '0' } }
    const q = createMessageQueue()
    const frame = (dt) => { const mq = q.tick(dt); if (mq && el) { if (mq.show) { el.textContent = mq.text; el.style.opacity = '1' } else el.style.opacity = '0' } }
    q.push('it has you.', PRIO.combat); frame(1 / 60)
    expect(el.textContent).toBe('it has you.'); expect(el.style.opacity).toBe('1')
    q.push('the carpet is damp.', PRIO.ambient)
    for (let i = 0; i < 60; i++) frame(1 / 60)            // a second later the murmur was dropped, not shown
    expect(el.textContent).toBe('it has you.'); expect(el.style.opacity).toBe('1')
    for (let i = 0; i < 60 * 4; i++) frame(1 / 60)        // holdS 4.2 s: faded exactly once
    expect(el.style.opacity).toBe('0')
    expect(q.tick(1 / 60)).toBeNull()
  })
})

describe('game.js: keys through input.js takeKey', () => {
  it('keydown asks takeKey with the live state and honours ignore / take-prevent', () => {
    expect(game).toMatch(/import \{ takeKey \} from '\.\/input\.js'/)
    expect(game).toMatch(/const settingsHidden = \(\) => \{ const sm = document\.getElementById\('settings-modal'\); return !sm \|\| sm\.style\.display === 'none' \}/)
    expect(game).toMatch(/const r = takeKey\(e, \{ activeTag: e\.target\?\.tagName, isContentEditable: !!e\.target\?\.isContentEditable, locked, settingsOpen: settingsHidden\(\) === false \}\)/)
    expect(game).toMatch(/if \(r === 'ignore'\) return\r?\n\s*if \(r === 'take-prevent'\) e\.preventDefault\(\)\r?\n\s*K\[e\.code\] = true/)
    expect(game).not.toMatch(/t\.tagName === 'INPUT' \|\| t\.tagName === 'TEXTAREA'/)       // the old inline rule lives in input.js now
  })
  it('blur and a hidden document sweep the key map', () => {
    // (fight-verbs added the ward latch drop beside the sweep: a ward held into a blur never fires)
    expect(game).toMatch(/window\.addEventListener\('blur', \(\) => \{ for \(const k in K\) K\[k\] = false; charger\.forceRelease\(\) \}\)/)
    expect(game).toMatch(/document\.addEventListener\('visibilitychange', \(\) => \{ if \(document\.hidden\) \{ for \(const k in K\) K\[k\] = false; charger\.forceRelease\(\) \} \}\)/)
  })
})

describe('game.js: the grid reader and the sanity clamp', () => {
  it('buildLevel makes the grid from the cache (null for a fixed map) and the level carries it', () => {
    expect(game).toMatch(/import \{ loadConfig, CHUNK_SIZE, createChunkCache, createGridReader \} from '\.\/world\.js'/)
    expect(game).toMatch(/const grid\s+= createGridReader\(cfg\.map \? null : cache, isWall\)/)
    expect(game).toMatch(/level = \{ index, cfg, cache, grid, bodies, decor, solid, entitySys, gfx, messages \}/)   // bodies / solid: the collide step
  })
  it('each frame the grid follows the player chunk before the entity system runs', () => {
    const a = game.indexOf('level.grid.setPlayerChunk(pcx, pcy)')
    const b = game.indexOf('level.entitySys.update(dt, player, pcx, pcy')
    const c = game.indexOf('const pcy = Math.floor(player.y / CHUNK_SIZE)')
    expect(c).toBeGreaterThan(0); expect(a).toBeGreaterThan(c); expect(b).toBeGreaterThan(a)
  })
  it('Level ∅ (index 4) does not drain sanity like a fourth floor', () => {
    expect(game).not.toMatch(/sdelta -= level\.index \* 0\.5/)
    expect(game).toMatch(/sdelta -= \(level\.index >= 0 && level\.index <= 3 \? level\.index : 0\) \* 0\.5/)
    const drain = (index) => (index >= 0 && index <= 3 ? index : 0) * 0.5
    expect(drain(0)).toBe(0); expect(drain(3)).toBe(1.5); expect(drain(4)).toBe(0)
  })
})

describe('offline shell lists carry the foundation modules game.js now imports', () => {
  for (const f of ['messages.js', 'input.js']) {
    it(`${f} is in src/sw.js and tools/build-play.sh`, () => {
      expect(sw).toContain(`'/renderer/${f}'`)
      expect(build).toContain(`'${f}'`)
    })
  }
})
