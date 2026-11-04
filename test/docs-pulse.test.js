// The docs follow 2.0.4's pulse (review S9, S10, C14, S11, S13): the manual and README quote the lines the game says now, not the
// ones it stopped saying, and say what the compass and the ambience setting do now. The game's own lines are imported, so the next
// change to one of them turns this red until the docs follow.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { LEVELS } from '../src/renderer/levels.js'
import { NOT_NOW_LINE, SEARCHED_HINT, TRACE_LINES, searchingHint } from '../src/renderer/containers.js'
import { FAINT, SEEN_ON, SEEN_OFF, arrivalSummary } from '../src/renderer/compass.js'
import { EVENTS } from '../src/renderer/events.js'
import { LOST_LINE } from '../src/renderer/levels.js'
import { wayMessage } from '../src/renderer/topology.js'

const root = path.resolve(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')
const readme = read('README.md'), manual = read('docs/manual.html'), index = read('src/renderer/index.html')
const docs = { readme, manual }
const pkg = JSON.parse(read('package.json'))

describe('the lobby\'s arrival line', () => {
  it('the manual quotes the lobby\'s sub-line as the game shows it, without the old "no exit."', () => {
    expect(manual).toContain(`<p class="line">${LEVELS[0].sub}</p>`)
    for (const [k, d] of Object.entries(docs)) expect(d, k).not.toContain('no exit. you are here')
  })
})

describe('the drawers', () => {
  it('no doc quotes "you rummage." any more; both quote the refusal whole', () => {
    for (const [k, d] of Object.entries(docs)) {
      expect(d, k).not.toContain('you rummage.')
      expect(d, k).toContain(NOT_NOW_LINE)
      expect(d, k).not.toMatch(/not now\.(?! something is close\.)/)
    }
  })
  // (review batch six) a drawer's roll is fixed by its key (containers.js rollContainer) and a full-handed search leaves the key unsearched,
  // as in 2.0.3, so the find waits in the drawer on a later visit too: no doc says it waits for this visit only, or calls it new
  it('the manual says the hold\'s hint, the searched hint, a floor plan, and a find that waits in the drawer', () => {
    expect(manual).toContain(`<i>${searchingHint('cabinet')}</i>`)
    expect(manual).toContain(`<i>${SEARCHED_HINT}</i>`)
    expect(manual).toContain(`<i>${TRACE_LINES.content}</i>`)
    expect(manual).toMatch(/hands are full[^<]*waits in that drawer/)
    expect(readme).toContain(`*${SEARCHED_HINT}*`)
    expect(readme).toContain('a floor plan that marks your map')
    expect(readme).toMatch(/hands are too full for waits in the drawer/)
    expect(manual).toContain('if your hands are full, it waits in that drawer until you search it again.')
    expect(readme).toContain('a find your hands are too full for waits in the drawer.')
    const notes = read('docs/release-notes/v2.0.4.md')
    for (const [k, d] of Object.entries({ ...docs, notes })) expect(d, k).not.toMatch(/on this visit|for this visit|for the visit/)
    expect(notes).not.toContain('too full for waits in the drawer')
  })
})

describe('the compass', () => {
  it('no doc promises the faint line at once or with a distance', () => {
    expect(manual).not.toContain('each with an arrow turned to your facing and a distance')
    expect(manual).not.toContain(`until you have seen one, it says <code>${FAINT}</code>.`)
    expect(manual).toContain(`<code>${FAINT}</code>: no distance, and not quite true`)
    expect(readme).not.toContain(`when you have seen none, *${FAINT}*.`)
    expect(readme).toContain(`after a while or a hint, *${FAINT}*: no distance, and not quite true`)
    // (review batch six) the block's pull is free at once and keeps its metres (game.js: pull = !!cfg.map || ..., compassText(.., !!cfg.map))
    expect(readme).toContain(`after a while or a hint, *${FAINT}*: no distance, and not quite true (on the block it points at the gap at once, with its distance)`)
  })
})

describe('the events, the seen line, the tray and the presence (review S12)', () => {
  // each data event (events.js fx) as the docs tell it; a new one turns this red until the docs name it
  const TOLD = { 'phone-rings': 'a phone rings a few rooms over', 'chair-scrape': 'a chair is pushed back in the next room',
    'pipe-knock': 'something knocks along the pipe', 'breaker-trip': 'a breaker trips' }
  it('both docs tell every event that carries its own effect, and that the first on a floor is often heard, not read', () => {
    expect(Object.keys(TOLD).sort()).toEqual(EVENTS.filter((e) => e.fx).map((e) => e.id).sort())
    for (const [k, d] of Object.entries(docs)) {
      for (const w of Object.values(TOLD)) expect(d.toLowerCase(), `${k}: ${w}`).toContain(w)
      expect(d.toLowerCase(), k).toContain('more often than not, the first of them on a floor you have just reached is heard, not read')
      // (review batch six) the knock's four strikes play at one gain from one side (events.js fx, game.js FX_PLAY): heard first, nothing
      // in it comes toward you, so no doc says it does (the line, when read, is the game's own)
      expect(d.toLowerCase(), k).not.toContain('knocks along the pipe toward you')
    }
  })
  it('both docs give the seen line on your screen and off it', () => {
    expect(manual).toContain(`<i>${SEEN_ON}</i>`); expect(manual).toContain(`<i>${SEEN_OFF}</i>`)
    expect(readme).toContain(`*${SEEN_ON}*`); expect(readme).toContain(`*${SEEN_OFF}*`)
  })
  it('the manual\'s tray line lets the game\'s own article stand', () => {
    expect(manual).not.toContain('and a … drops into the tray.')
    expect(manual).toContain('<i>the machine clunks, and … drops into the tray.</i>')
  })
  it('the manual says the lobby\'s presence keeps quiet a little while when you first arrive', () => {
    expect(manual).toContain('There is always one close to where you first arrive in the lobby. That one keeps quiet a little while before it first offers to speak.')
  })
})

describe('the ambience setting', () => {
  it('the hint, the manual and the README say it carries your steps and the sounds of things nearby', () => {
    const hint = index.match(/Ambience <span class="set-hint">([^<]*)<\/span>/)[1]
    expect(hint).not.toBe('hum &amp; drone')
    expect(hint).toContain('steps')
    expect(hint).toBe(hint.toLowerCase())
    expect(hint).not.toMatch(/[0-9!]/)
    expect(manual).toMatch(/<td class="k">Ambience<\/td>.*<td data-label="notes">[^<]*your own steps[^<]*<\/td>/)
    expect(readme).toMatch(/^\| ambience \| [^\n]*your own steps[^\n]*\|$/m)
  })
})

// ── release prep: the rest of what the docs said that 2.0.4 no longer does ─────────────────────────────────────────────────────
describe('the things on the floors, and hearing them first', () => {
  const floorName = (i) => LEVELS[i].name.split(' — ')[1]
  it('every creature card names exactly the floors it is laid out on, in order, and whether it hunts or wanders (the watcher roams the pipes)', () => {
    const where = {}
    for (let i = 1; i <= 3; i++) {
      const e = LEVELS[i].config.entities
      for (const v of e.stalkerVariants || []) (where[v] ||= { floors: [], role: 'hunts' }).floors.push(floorName(i))
      for (const v of e.wandererVariants || []) (where[v] ||= { floors: [], role: 'wanders' }).floors.push(floorName(i))
    }
    expect(where.watcher.floors).toContain('pipe dreams')
    for (const [v, { floors, role }] of Object.entries(where)) {
      const m = manual.match(new RegExp(`<div class="name">${v}</div><div class="where">([^<]*)</div>`))
      expect(m, v).not.toBeNull()
      expect(m[1].split(' · '), v).toEqual([...floors, role])
    }
  })
  it('both docs say a thing near you that has not found you yet is heard, and brings a slow heartbeat, before anything hunts you', () => {
    expect(manual).toMatch(/<h3>Your heart<\/h3>\n  <p>[^\n]*slow[^\n]*has not found you yet/)
    expect(manual).toMatch(/<li><b>You hear them first\.<\/b>[^\n]*its own sound[^\n]*from where it is/)
    expect(readme).not.toContain('when your heart comes into your ears, something has you.')
    expect(readme).toMatch(/when your heart comes into your ears, something is near: slow, it has not found you yet/)
    expect(readme).toMatch(/\*\*listen to your heart\.\*\* [^\n]*has not found you yet[^\n]*its own sound[^\n]*slowly/)
    // (review batch six) badly hurt, your heart beats with nothing near (tension.js tick: hp < 25 lifts it to a slow beat, any floor, as in
    // 2.0.3): no doc says a heartbeat always means something is near
    expect(readme).toContain('when your heart comes into your ears, something is near: slow, it has not found you yet; quick, it has. badly hurt, you hear it with nothing near at all.')
    expect(manual).not.toContain('again. If you can hear your pulse, it is already near.')
    expect(manual).toContain('Badly hurt, you hear your own heart with nothing near at all; otherwise, if you can hear your pulse, it is already near.')
    const notes = read('docs/release-notes/v2.0.4.md')
    expect(notes).toContain('close by a slow heartbeat starts before anything hunts you, and stops when the thing goes — never through a wall (badly hurt, you hear it anyway).')
    expect(read('src/renderer/tension.js')).toContain('if (hp < 25 && target < 0.4) target = 0.4')
  })
  it('quiet water is told by what the things hear, now that you hear your own steps (they do not go quieter to you)', () => {
    expect(manual).not.toContain('your footsteps are softer for a while')
    expect(manual).not.toContain('and softens your footsteps.')
    expect(readme).not.toContain('softens your steps for a while')
    expect(readme).not.toContain('your steps go soft for a while')
    expect(manual).toContain('the things hear your footsteps less for a while')
  })
})

describe('the compass, the first minute and the lines the budget lets go', () => {
  it('the faint pull waits longer only on the lobby of a solo run without a pin, and the block keeps its distance', () => {
    expect(manual).not.toContain('longer on your first run')
    expect(manual).toContain('On the lobby of a solo run without a pin it waits longer')
    expect(manual).toContain('On the block it points at the gap at once, with its distance.')
    expect(manual).toContain('A presence waits close to where you arrive, and on a solo run without a pin someone has left a note a little way off.')
  })
  // (review batch six) a lift ride back to a floor you know puts up no name plate: the lift's own line takes its place (game.js travel;
  // pulse-wiring replays it)
  it('a floor speaks its own line the first time and its name after (off the lift, the lift\'s line in its place), and says little while you arrive', () => {
    expect(manual).not.toContain('and the floor below says its name.')
    expect(manual).toContain('the first time, a line of its own; after that, its name, except off the lift, where the lift\'s own line takes its place (the level plate has the name).')
    expect(manual).toContain('When you reach a floor it says little for the first while: its line or its name, and one more. Off the lift, on a floor you know, the lift\'s own line takes the name\'s place.')
  })
  // (review batch five) the summary takes an arrival's second plate on a floor you come back to, at 3.8 s, and the filing line takes it
  // on the way that files you (game.js travel): both say themselves a few seconds in again, so both docs promise them again, as they did
  // before the docs step took them out. If the budget loses either line again, take it out of the docs and turn this guard round.
  // (review batch six) the lift's return says it too now (its name plate gives way), and climbing out says the ring's own line in its
  // place, so the promise names the ways that keep it, and the lobby's own way (pulse-wiring replays every one)
  it('both docs promise the summary on coming back by a hole, a stairwell or the lift, and the filing line a few seconds in, not within the first minute', () => {
    const summary = arrivalSummary({ down: 0 }, 2)
    const ring = wayMessage({ kind: 'ring', target: 0 }, { mem: { x: 0, y: 0 } })
    for (const [k, d] of Object.entries(docs)) expect(d, k).toContain(summary)
    expect(manual).toContain(`Come back to a floor by a hole, a stairwell or the lift and it says so: <i>${summary}</i> — and tells you how many ways down are on your map. Climb out to the lobby and it says so in its own way: <i>${ring}</i>`)
    expect(readme).toContain(`come back by a hole, a stairwell or the lift and the floor says so: *${summary}* climb out and the lobby says so in its own way: *${ring}*`)
    for (const [k, d] of Object.entries(docs)) expect(d, k).not.toMatch(/come back to a floor and it says so|come back and the floor says so/i)
    expect(manual).toContain('a few breaths after the floor has had its say, a line arrives: <i>the file has you now.</i>')
    expect(readme.match(/a few seconds after you land/g)).toHaveLength(2)
    for (const [k, d] of Object.entries(docs)) expect(d, k).not.toContain('within your first minute there')
  })
  // (review batch five follow-up) the ways table quotes the ring's own line as what climbing out does. It is a return's only, and the
  // summary had taken its plate; travel says it again on that return, at 3.8 s, the summary let go (pulse-wiring replays it). If the
  // budget loses it again, take it out of the table and turn this guard round
  it('the manual\'s ways table quotes the ring\'s own line, which climbing out to the lobby says', () => {
    const ring = wayMessage({ kind: 'ring', target: 0 }, { mem: { x: 0, y: 0 } })
    expect(ring).toBe('the carpet remembers you.')
    expect(manual).toContain(`<tr><td class="k">f · climb out — level 0</td><td data-label="from">3</td><td data-label="what it does">back to the lobby — <i>${ring}</i></td></tr>`)
  })
  // (review batch six) one flag covers both plain lines and the light starts on (game.js lightSaid, flashlight = true), so below the block
  // the run's first press says the dark's line and 'flashlight on.' is not said; the flag is not saved, so a continued run starts over
  it('the manual says only the first press speaks below the block, the presence keeps quiet while hunted or by an unread page, and a floor plan marks the map', () => {
    expect(manual).not.toContain('On the four floors below the block it says so once a run; after that only the light changes.')
    expect(manual).not.toContain('Press <kbd>L</kbd> — <i>flashlight on.</i>')
    expect(manual).toContain('Press <kbd>L</kbd> to turn your light off and on. It is on when you arrive. Light steadies you; turn it off and <i>the dark leans in.</i> On the four floors below the block only the first press of a run says anything (a run you continue starts over), unless you go dark in a friend\'s light; after that only the light changes. On the block every press says so, and the light coming back says <i>flashlight on.</i>')
    const notes = read('docs/release-notes/v2.0.4.md')
    expect(notes).not.toContain('the flashlight\'s lines and the smiler\'s warning come once a run')
    expect(notes).toContain('below the block, only your first press of the light says anything, and the smiler\'s warning comes once; a run you continue hears each once more.')
    expect(manual).toContain('It keeps quiet while something is hunting you, and while an unread page lies within reach')
    expect(manual).toContain('A floor plan from a <a href="#drawers">drawer</a> can mark one thing you have not seen yet.')
  })
  // (review batch six) the wake's lines are its arrival's plates (game.js die; pulse-wiring replays every wake): on a floor you know no
  // name, where you woke at 2.6 s and what your hands let go at 5.2 s; on a floor new to you its own line and where you woke, what your
  // hands let go after the window; the third after the window, all of it lost to a way taken first. If the wake's order or its plates
  // change, change these sentences with it
  it('the docs say what a wake says and when, and no doc promises what your hands let go at once', () => {
    const notes = read('docs/release-notes/v2.0.4.md')
    expect(notes).not.toContain('told at once what your hands let go')
    expect(notes).toContain('when you wake from a death, where you woke comes a few seconds in (after the floor\'s own line, on a floor new to you), and on a floor you know, what your hands let go comes next; the rest waits until the floor has settled, and goes unsaid if you take a way first.')
    expect(manual).toContain('Waking from a death is an arrival too: on a floor you know it does not say its name (the level plate has it), only where you woke and then what your hands let go, or the file\'s word on your death if they held nothing; on a floor new to you, its line, then where you woke.')
    expect(manual).toContain('Anything else waits until the floor has settled, about three quarters of a minute, or is let go; what waits goes unsaid if you take a way first.')
    expect(manual).not.toContain('Anything else waits until later, or is let go.')
    expect(manual).toContain('<li>Waking is an arrival: the floor says little at first, and the rest of what the death has to say waits. See <a href="#speaking">the building speaking</a>.</li>')
    expect(manual).toContain('<h3 id="speaking">The building speaking</h3>')
  })
  // (review batch six, old since 2.0.3) a wake never gives the ceiling back (game.js die calls mem.arrive, not onArrive), and it counts
  // the floor as set foot on, so a floor first reached by waking never gives it back. If die() ever calls onArrive, turn this round
  it('both docs say only a floor first reached by a way gives the ceiling back, not one you first wake on', () => {
    expect(manual).not.toContain('Every floor you set foot on for the first time gives some of it back.')
    expect(manual).toContain('Every floor you first reach by a way gives some of it back; one you first wake on does not.')
    expect(readme).not.toContain('every floor you reach for the first time gives a little of the ceiling back.')
    expect(readme).toContain('every floor you first reach by a way gives a little of the ceiling back (one you first wake on does not).')
    const game = read('src/renderer/game.js'), die = game.slice(game.indexOf('function die(d = null) {'), game.indexOf('// ── input ──'))
    expect(die).not.toContain('onArrive(')
    expect(die).toContain('const first = mem.arrive(level.index, spawnChunk, playT).visits === 1')
  })
})

// The draft comment at the top of a version's notes is the owner's to delete when they are ready to publish, so nothing here asks for
// it: the guard holds with it or without it, and asks only that nothing of it is left half-deleted (a stray DRAFT, <!-- or --> outside
// a closed comment would show in the release, or hide the notes after it). The notes are found through package.json and no version is
// pinned; the lines below are 2.0.4's own, so they read 2.0.4's notes by name, as docs-launch reads 2.0.0's.
const draftLeftOpen = (s) => /DRAFT|<!--|-->/.test(s.replace(/<!--[^]*?-->/g, ''))
describe('the release notes for this version', () => {
  const file = `docs/release-notes/v${pkg.version}.md`
  it('exist for the version in package.json, and leave no draft marker open, with the draft comment or without it', () => {
    expect(fs.existsSync(path.join(root, file))).toBe(true)
    const notes = read(file)
    expect(draftLeftOpen(notes)).toBe(false)
    expect(draftLeftOpen(notes.replace(/^<!--[^]*?-->\n/, ''))).toBe(false)
    for (const half of ['DRAFT for the owner. -->\nnotes', '<!-- DRAFT for the owner.\nnotes', 'ready to publish. -->\nnotes']) {
      expect(draftLeftOpen(half), half).toBe(true)
    }
  })
  it('quote the game\'s lines as the game says them, and say what a mixed room and an old save see (2.0.4\'s notes)', () => {
    const notes = read('docs/release-notes/v2.0.4.md')
    for (const s of [FAINT, SEEN_OFF, SEARCHED_HINT, NOT_NOW_LINE, LOST_LINE, searchingHint('cabinet')]) expect(notes, s).toContain(`*${s}*`)
    expect(notes).toContain('## the backrooms 2.0.4')
    expect(notes).toContain('### update together')
    expect(notes).toMatch(/2\.0\.3 copy and a 2\.0\.4 copy in the same room/)
    expect(notes).toContain('nothing new goes over the wire')
    expect(notes).toMatch(/saved on 2\.0\.3[^\n]*levels one to three[^\n]*somewhere new/)
  })
  // (review batch six) a line held inside an arrival's window drains one per DRAIN_S (10 s, plates.js), and some unasked lines never pass
  // the budget, so no doc names a fixed gap; and the tick plays on a pick-up and a machine's draw only (game.js: pickup() twice)
  it('name no fixed gap between unasked lines, and give the tick where the game plays it', () => {
    const notes = read('docs/release-notes/v2.0.4.md')
    for (const [k, d] of Object.entries({ ...docs, notes })) expect(d, k).not.toContain('every twenty seconds')
    expect(notes).toContain('after that the building speaks unasked only every so often.')
    expect(manual).toContain('After that it speaks unasked only every so often')
    expect(notes).not.toContain('a tick when you take something')
    expect(notes).toContain('a tick when you pick something up or draw from a machine')
    const game = read('src/renderer/game.js')
    expect((game.match(/\bpickup\(\)/g) || []).length).toBe(2)
  })
})
