// The crew (2.0.7, release 1): /who in words, a friend re-filed, a friend from your square, the photo's word, the body in words and a
// friend's whistle pencilled on your sheet. All of it is read off what the room already says: nothing new is sent between players, and
// nothing new is said on Level ∅. The rules are pinned here; the wiring is lifted out of game.js and run where it can be (it only runs in
// a page), and read as text where it cannot (test/*wiring*.test.js style).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { CREW, CREW_FLOORS, whoLines, refileLine, refileText, squareLine, squareMatch, photoWord, fileWord, floorName, createCrewWatch } from '../src/renderer/crew.js'
import { createEvBus } from '../src/net/evbus.js'
import { sysText } from '../src/net/client.js'
import { STATUSES } from '../src/renderer/status.js'
import { LEVELS } from '../src/renderer/levels.js'
import { floorWord, TERM } from '../src/renderer/terminal.js'
import { anchorSeed, neighbourhoodSeed, pinTag, formatAnchor } from '../src/renderer/anchor.js'
import { BODY_LINE, BODY_PLACE, pinCaption } from '../src/renderer/origin-anchored.js'
import { ADDRESS_PIN } from '../src/renderer/origin-intake.js'
import { ROOM_PIN_JOIN, ANCHORED_LINE } from '../src/renderer/site.js'
import { polaroidCaption, LINES } from '../src/renderer/compose-polaroid.js'
import { LEGACY } from '../src/renderer/origin-rules.js'
import { statusMods } from '../src/renderer/status.js'
import { createFogMap, buildMapView, CALL_MARK_MS, CALL_REDRAW_MS, CALL_MAX } from '../src/renderer/fogmap.js'
import { drawMap, fitView, GLYPHS, CALL_GLYPH, CALL_ALPHA } from '../src/renderer/mapcard.js'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const game = read('../src/renderer/game.js'), html = read('../src/renderer/index.html'), evbusSrc = read('../src/net/evbus.js')
const at = (src, s, from = 0) => { const k = src.indexOf(s, from); expect(k, s).toBeGreaterThan(-1); return k }
const slice = (src, from, to) => { const a = at(src, from), b = src.indexOf(to, a); expect(b, to).toBeGreaterThan(a); return src.slice(a, b) }
const count = (s) => game.split(s).length - 1

// the rules every new line keeps: lowercase, no digits, no '!', no coordinates, tags or seeds (a tag or a seed is digits)
function plain(line, label = line) {
  expect(typeof line, label).toBe('string')
  expect(line, label).toBe(line.toLowerCase())
  expect(line, label).not.toMatch(/[\d!]/)
  expect(line, label).not.toMatch(/-?\d+\.\d+/)
}

const PIN = { lat: 39.2975, lng: -76.643 }                 // a door in west baltimore (pin-privacy.test.js's)
const NEXT = { lat: 39.2949, lng: -76.643 }                // 290 m south: the next cell over
const SAME = { lat: 39.3021, lng: -76.6388 }               // ~600 m off: the same cell

describe('the floors and the words, by name', () => {
  it('the four floors are the field terminal\'s names (levels.js, words only); the block is none', () => {
    expect(CREW_FLOORS).toEqual(LEVELS.filter((l) => Number.isInteger(l.id)).map((l) => floorWord(l.name)))
    expect(CREW_FLOORS).toEqual(['the lobby', 'habitable zone', 'pipe dreams', 'electrical station'])
    expect([0, 1, 2, 3].map(floorName)).toEqual(CREW_FLOORS)
    for (const v of [4, -1, 5, 1.5, '1', null, undefined]) expect(floorName(v), String(v)).toBe(null)
    for (const f of CREW_FLOORS) plain(f)
  })
  it('the words are status.js\'s four; anything else is no word', () => {
    expect(STATUSES.map(fileWord)).toEqual(['notice mailed', 'extension', 'compliance', 'litigation'])   // as every voice says it (the form's F7)
    for (const v of ['king', '', null, undefined, 4, 'EXTENSION']) expect(fileWord(v), String(v)).toBe(null)
  })
})

describe('whoLines: the room in words', () => {
  const self = { id: 'me', lvl: 1, status: 'extension' }
  it('solo, or everyone gone: one line that says so', () => {
    expect(whoLines([], self)).toEqual([CREW.WHO_SOLO])
    expect(whoLines(null, null)).toEqual(['no one is here but you.'])
    expect(whoLines([{ id: 'me', name: 'ada', lvl: 0, status: 'compliance' }], self)).toEqual([CREW.WHO_SOLO])   // yourself is never a friend
  })
  it('you first, then each friend: the floor by its name and the word the file has them under', () => {
    const peers = [
      { id: 'a', name: 'ada', lvl: 0, status: 'notice-mailed' },
      { id: 'b', name: 'bo', lvl: 2, status: 'litigation' },
      { id: 'c', name: 'cy', lvl: 3, status: 'compliance' },
    ]
    expect(whoLines(peers, self)).toEqual([
      'you · habitable zone · filed under extension.',
      'ada · the lobby · filed under notice mailed.',
      'bo · pipe dreams · filed under litigation.',
      'cy · electrical station · filed under compliance.',
    ])
  })
  it('a friend on the block shows no floor; one with no fresh heartbeat is listed and not placed', () => {
    const lines = whoLines([{ id: 'n', name: 'nell', lvl: 4, status: 'litigation' }, { id: 'o', name: 'old', lvl: null, status: null }, { id: 'q', name: 'quiet' }], self)
    expect(lines.slice(1)).toEqual(['nell · filed under litigation.', 'old · the file has not placed them.', 'quiet · the file has not placed them.'])
    for (const l of lines) { expect(l).not.toMatch(/the block|level|∅/); for (const f of CREW_FLOORS) if (l.startsWith('nell')) expect(l).not.toContain(f) }
    // a self on the block reads the same way (game.js says nothing new there at all: below)
    expect(whoLines([{ id: 'a', name: 'ada', lvl: 0, status: 'extension' }], { id: 'me', lvl: 4, status: 'compliance' })[0]).toBe('you · filed under compliance.')
  })
  it('a name is spliced as typed (no $ pattern read); a nameless friend is someone', () => {
    expect(whoLines([{ id: 'x', name: 'm$&ie $1', lvl: 1, status: 'extension' }], null)).toEqual(['m$&ie $1 · habitable zone · filed under extension.'])
    expect(whoLines([{ id: 'x', name: '', lvl: 1, status: 'extension' }], null)).toEqual(['someone · habitable zone · filed under extension.'])
  })
  it('every row on every floor under every word keeps the rules (with a plain name)', () => {
    for (let lvl = 0; lvl <= 4; lvl++) for (const status of STATUSES) for (const l of whoLines([{ id: 'a', name: 'ada', lvl, status }, { id: 'b', name: 'bo' }], { id: 'me', lvl, status })) plain(l)
  })
})

describe('the refile line and the square line', () => {
  it('refileLine is the people line as the chat draws it: "— name re-filed under <word>."', () => {
    expect(refileLine('ada', 'litigation')).toBe('— ada re-filed under litigation.')
    expect(refileText('extension')).toBe('re-filed under extension.')
    expect(squareLine('ada')).toBe('— ada came in from your square.')
    // the chat's own drawing of a people line (game.js, since the dropped line: client.js sysText — '— ' + from + ' ' + text, with no
    // space only before a line that starts with an apostrophe, which neither of these does)
    expect(game.includes('if (l.sys) return `<div class="chat-sys">${escapeHtml(sysText(l.from, l.text))}</div>`')).toBe(true)
    const draw = (from, text) => sysText(from, text)
    for (const w of STATUSES) expect(refileText(w).startsWith("'")).toBe(false)
    expect(CREW.SQUARE.startsWith("'")).toBe(false)
    for (const w of STATUSES) expect(draw('ada', refileText(w))).toBe(refileLine('ada', w))
    expect(draw('ada', CREW.SQUARE)).toBe(squareLine('ada'))
    for (const w of STATUSES) { plain(refileText(w)); plain(refileLine('ada', w)) }
    plain(CREW.SQUARE); plain(squareLine('ada'))
  })
})

describe('squareMatch: two pinned players share a square, the room\'s own included', () => {
  it('equal marks match; a pin from the next cell does not; no pin never matches', () => {
    const ws = 1234567
    expect(squareMatch(pinTag(PIN, ws), pinTag(SAME, ws))).toBe(true)
    expect(squareMatch(pinTag(PIN, ws), pinTag(NEXT, ws))).toBe(false)
    expect(squareMatch({ aseed: pinTag(PIN, ws) }, pinTag(SAME, ws))).toBe(true)          // a record or a mark, either side
    for (const [a, b] of [[null, null], [null, 5], [5, null], [undefined, undefined], [5.5, 5.5], ['5', '5'], [{}, {}], [NaN, NaN]]) expect(squareMatch(a, b), `${a},${b}`).toBe(false)
  })
  it('the room\'s own square: a room drawn from your cell marks you 0, and two pins from it match', () => {
    const ws = neighbourhoodSeed(PIN)                                       // the room was opened from this cell (or by an invite to it)
    expect(pinTag(PIN, ws)).toBe(0); expect(pinTag(SAME, ws)).toBe(0)
    expect(squareMatch(pinTag(PIN, ws), pinTag(SAME, ws))).toBe(true)
    expect(squareMatch(0, 0)).toBe(true)
    expect(squareMatch(pinTag(PIN, ws), pinTag(NEXT, ws))).toBe(false)
    expect(anchorSeed(PIN.lat, PIN.lng)).not.toBe(ws)                        // (the door's own seed is never what a room is told)
  })
  it('the square line says no more than the film: the photo\'s SUBJECT_PIN reads this one rule', () => {
    const cp = read('../src/renderer/compose-polaroid.js')
    expect(cp).toContain("import { squareMatch, photoWord } from './crew.js'")
    expect(cp).toContain('if (squareMatch(s.aseed, tag)) return LINES.SUBJECT_PIN')
    const ctx = (aseed, tag) => ({ rules: LEGACY, mods: statusMods('notice-mailed'), subject: { id: 'p', name: 'ada', st: 'ok', thin: false, origin: 'tenant', status: 'extension', aseed },
      soul: null, doorArrow: null, thinNear: false, status: 'notice-mailed', index: 1, depth: 1, sanity: 10, origin: null, thin: false, thinFirstShot: false,
      anchor: null, pinTag: tag, D: 0, firstShotOfLevel: false, photoIdx: 0, player: { x: 0, y: 0 }, lvl: 1 })
    for (const [a, b] of [[0, 0], [7, 7], [7, 8], [null, 7], [7, null], [null, null]]) {
      const pin = polaroidCaption(ctx(a, b)).cap.includes('the film shows your pin.')
      expect(pin, `${a},${b}`).toBe(squareMatch(a, b))
    }
  })
})

describe('createCrewWatch: what a friend\'s heartbeat earns, once', () => {
  const ev = (o) => ({ id: 'a', name: 'ada', lvl: 1, status: 'extension', aseed: null, first: false, from: 'extension', ...o })
  it('a re-filing: never on the first heartbeat, once per change, never for the same word', () => {
    const w = createCrewWatch(), ctx = { selfId: 'me', selfTag: null }
    expect(w.heard(ev({ first: true, from: null, status: 'litigation' }), ctx)).toEqual([])
    expect(w.heard(ev({ from: 'litigation', status: 'litigation' }), ctx)).toEqual([])
    expect(w.heard(ev({ from: 'litigation', status: 'compliance' }), ctx)).toEqual(['re-filed under compliance.'])
    expect(w.heard(ev({ from: 'compliance', status: 'compliance' }), ctx)).toEqual([])
    expect(w.heard(ev({ from: 'compliance', status: 'notice-mailed' }), ctx)).toEqual(['re-filed under notice mailed.'])
    expect(w.heard(ev({ from: 'king', status: 'extension' }), ctx)).toEqual([])     // nothing the file has a word for is no change
  })
  it('the square: the first heartbeat of a friend whose pin\'s square is yours, once a session (by name), the room\'s own square too', () => {
    const w = createCrewWatch()
    expect(w.heard(ev({ first: true, from: null, aseed: 0 }), { selfId: 'me', selfTag: 0 })).toEqual(['came in from your square.'])
    expect(w.heard(ev({ id: 'a2', first: true, from: null, aseed: 0 }), { selfId: 'me', selfTag: 0 })).toEqual([])   // ada again, a new id
    expect(w.heard(ev({ id: 'b', name: 'bo', first: true, from: null, aseed: 41 }), { selfId: 'me', selfTag: 41 })).toEqual(['came in from your square.'])
    expect(w.heard(ev({ id: 'c', name: 'cy', first: true, from: null, aseed: 41 }), { selfId: 'me', selfTag: 42 })).toEqual([])   // another square
    expect(w.heard(ev({ id: 'd', name: 'di', first: true, from: null, aseed: null }), { selfId: 'me', selfTag: 41 })).toEqual([])  // no pin
    expect(w.heard(ev({ id: 'e', name: 'ed', first: true, from: null, aseed: 41 }), { selfId: 'me', selfTag: null })).toEqual([])  // you brought none
    expect(w.heard(ev({ id: 'b', name: 'bo', first: false, from: 'extension', aseed: 41 }), { selfId: 'me', selfTag: 41 })).toEqual([])   // only on coming in
    // the blank name many share is nobody in particular: each 'wanderer' from your square is said, by their own id
    expect(w.heard(ev({ id: 'w1', name: 'wanderer', first: true, from: null, aseed: 41 }), { selfId: 'me', selfTag: 41 })).toEqual(['came in from your square.'])
    expect(w.heard(ev({ id: 'w2', name: 'wanderer', first: true, from: null, aseed: 41 }), { selfId: 'me', selfTag: 41 })).toEqual(['came in from your square.'])
    expect(w.heard(ev({ id: 'w1', name: 'wanderer', first: true, from: null, aseed: 41 }), { selfId: 'me', selfTag: 41 })).toEqual([])
  })
  it('nothing about yourself, nothing about a friend on the block, nothing to you while you stand on it', () => {
    const w = createCrewWatch()
    expect(w.heard(ev({ id: 'me', from: 'extension', status: 'litigation' }), { selfId: 'me' })).toEqual([])
    expect(w.heard(ev({ lvl: 4, from: 'extension', status: 'litigation' }), { selfId: 'me' })).toEqual([])
    expect(w.heard(ev({ from: 'extension', status: 'litigation' }), { selfId: 'me', onBlock: true })).toEqual([])
    expect(w.heard(ev({ name: 'nell', lvl: 4, first: true, from: null, aseed: 3 }), { selfId: 'me', selfTag: 3 })).toEqual([])
    expect(w.heard(ev({ name: 'ned', first: true, from: null, aseed: 3 }), { selfId: 'me', selfTag: 3, onBlock: true })).toEqual([])
    for (const bad of [null, undefined, {}, { id: 7 }]) expect(w.heard(bad, { selfId: 'me' })).toEqual([])
  })
})

describe('the bus reads it off the heartbeat it already had: nothing new on the wire', () => {
  const HERE = { lvl: 1, lit: true, st: 'ok', seen: false, o: 'tenant', thin: false, status: 'extension', aseed: null, v: 1 }
  let n = 1
  const frame = (id, over = {}) => ({ type: 'ev', id, name: id, kind: 'here', payload: { ...HERE, ...over, n: n++ }, t: 0 })
  function rig() {
    let t = 0
    const sent = []
    const bus = createEvBus({ send: (kind, payload) => sent.push({ kind, payload }), now: () => t, self: () => ({ x: 0, y: 0, lvl: 1 }), peerPos: () => null,
      peerIds: () => new Set(['a', 'b']), selfId: 'me' })
    return { bus, sent, step: (dt) => { t += dt } }
  }
  it('onPeerFile: first on the first heartbeat heard from an id, from the word the one before said', () => {
    const { bus, step } = rig(), got = []
    bus.onPeerFile((e) => got.push(e))
    bus.receive(frame('a', { status: 'extension', aseed: 9 })); step(3000)
    bus.receive(frame('a', { status: 'litigation', aseed: 9 })); step(3000)
    bus.receive(frame('a', { status: 'litigation', lvl: 2, aseed: 9 }))
    expect(got).toEqual([
      { id: 'a', name: 'a', lvl: 1, status: 'extension', aseed: 9, first: true, from: null },
      { id: 'a', name: 'a', lvl: 1, status: 'litigation', aseed: 9, first: false, from: 'extension' },
      { id: 'a', name: 'a', lvl: 2, status: 'litigation', aseed: 9, first: false, from: 'litigation' },
    ])
    expect(bus.receive(frame('me', { status: 'compliance' }))).toBe(false)          // yourself: dropped before anything hears it
    expect(got.length).toBe(3)
  })
  it('the heartbeat goes out as it did: version 1, the same eight fields', () => {
    const { bus, sent } = rig()
    bus.here({ lvl: 2, lit: true, st: 'ok', seen: false, o: 'anchored', thin: false, status: 'litigation', aseed: 0, extra: 'x', who: 'y' })
    expect(sent).toHaveLength(1)
    expect(sent[0].kind).toBe('here')
    expect(Object.keys(sent[0].payload).sort()).toEqual(['aseed', 'lit', 'lvl', 'n', 'o', 'seen', 'st', 'status', 'thin', 'v'])
    expect(sent[0].payload.v).toBe(1)
    expect(evbusSrc).toContain("const HERE_KEYS = ['lvl', 'lit', 'st', 'seen', 'o', 'thin', 'status', 'aseed']")
    expect(evbusSrc).toContain('(p.aseed === null || Number.isInteger(p.aseed)) && p.v === 1')
  })
  it('game.js registers the kinds it always did, and no other; nothing in the crew sends', () => {
    const kinds = [...game.matchAll(/bus\.register\('(\w+)'/g)].map((m) => m[1])
    expect(kinds).toEqual(['whistle', 'kneel', 'woke', 'cache', 'take', 'ward', 'photo'])
    const crew = read('../src/renderer/crew.js')
    expect(crew.replace(/\/\/.*$/gm, '')).not.toMatch(/\b(emit|send|sendEv|sendChat|document|window|fetch|localStorage|performance|Math\.random)\b/)
  })
  it('the game never asks where the player is: no geolocation anywhere in src/', () => {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]))
    const root = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
    for (const f of walk(root).filter((f) => /\.(js|html|mjs|cjs)$/.test(f))) expect(fs.readFileSync(f, 'utf8'), f).not.toContain('geolocation')
  })
})

describe('game.js: /who, the people lines, the photo', () => {
  it('/who answers in the console, between /invite and the fallback, which names it; on the block nothing new is said', () => {
    const cmd = slice(game, 'async function handleCommand(t) {', '// desktop: a fetch that never reached the site')
    const who = at(cmd, "} else if (cmd === 'who') {")
    expect(at(cmd, "} else if (cmd === 'invite') {")).toBeLessThan(who)
    const help = at(cmd, "const help = 'the file does not recognise that. try /recover, /cases, /file <answer>, /intake, /status, /who or /invite.'")
    expect(who).toBeLessThan(help)
    // the help line names /who; on the block it reads exactly as 2.0.6 had it
    const fallback = slice(cmd, '      } else {\n        // the help names /who', '\n      }\n    } catch (e) {')
    expect(fallback).toContain("showMessage(level?.cfg.map ? help.replace(', /who', '') : help)")
    const say = (lvl) => { const out = []; new Function('level', 'showMessage', fallback.slice(fallback.indexOf('{') + 1))(lvl, (m) => out.push(m)); return out }
    expect(say({ cfg: {} })).toEqual(['the file does not recognise that. try /recover, /cases, /file <answer>, /intake, /status, /who or /invite.'])
    expect(say({ cfg: { map: {} } })).toEqual(['the file does not recognise that. try /recover, /cases, /file <answer>, /intake, /status or /invite.'])
    expect(say(null)).toEqual(say({ cfg: {} }))
    expect(cmd).toContain("showMessage(level?.cfg.map ? TERM.WHERE_NONE : whoLines(crewRoster(), { id: mpClient?.id ?? null, lvl: level ? level.index : null, status: file.status }).join('\\n'))")
    expect(TERM.WHERE_NONE).toBe('the file holds nothing from here.')       // the terminal's own line on the block, already said there
    expect(game).toMatch(/import \{ whoLines, createCrewWatch \} from '\.\/crew\.js'/)
    // /who is the console's, not a terminal word: the field terminal's 'who' waits for release 3
    expect(read('../src/renderer/terminal.js')).not.toMatch(/'who'/)
  })
  it('lifted and run: the roster is this frame\'s players list, placed only where the bus has a fresh heartbeat', () => {
    const fn = slice(game, 'function crewRoster() {', '\n  }\n') + '\n  }'
    expect(fn).not.toContain('getRemotePlayers')                             // the one read of the players list stays fillRemotes'
    const peerRec = new Map([['a', { id: 'a', name: 'ada', x: 1, y: 1 }], ['b', { id: 'b', name: 'bo', x: 2, y: 2 }]])
    const bus = { fresh: (id) => id === 'a', peers: new Map([['a', { lvl: 2, status: 'litigation' }], ['b', { lvl: 3, status: 'compliance' }]]) }
    const roster = new Function('peerRec', 'bus', `${fn}\nreturn crewRoster()`)(peerRec, bus)
    expect(roster).toEqual([{ id: 'a', name: 'ada', lvl: 2, status: 'litigation' }, { id: 'b', name: 'bo', lvl: null, status: null }])
    expect(whoLines(roster, { id: 'me', lvl: 2, status: 'extension' })).toEqual(['you · pipe dreams · filed under extension.', 'ada · pipe dreams · filed under litigation.', 'bo · the file has not placed them.'])
    expect(new Function('peerRec', 'bus', `${fn}\nreturn crewRoster()`)(new Map(), null)).toEqual([])   // solo
  })
  it('lifted and run: the people lines go to the chat as people lines, read with your own mark, nothing on the block', () => {
    const wire = slice(game, 'const crewWatch = createCrewWatch()', '\n  })\n') + '\n  })'
    expect(at(game, 'const myPinTag = pinTag(anchor, worldSeed)')).toBeLessThan(at(game, 'const crewWatch = createCrewWatch()'))
    expect(count('bus?.onPeerFile(')).toBe(1)
    const said = []
    let cb = null
    const run = (level) => new Function('createCrewWatch', 'bus', 'mpClient', 'myPinTag', 'level', 'addChatLine', `${wire}`)(
      createCrewWatch, { onPeerFile: (f) => { cb = f } }, { id: 'me' }, 0, level, (from, text, sys) => said.push([from, text, sys]))
    run({ cfg: {} })
    cb({ id: 'a', name: 'ada', lvl: 1, status: 'extension', aseed: 0, first: true, from: null })
    cb({ id: 'a', name: 'ada', lvl: 1, status: 'litigation', aseed: 0, first: false, from: 'extension' })
    cb({ id: 'b', name: '', lvl: 2, status: 'compliance', aseed: 5, first: false, from: 'litigation' })
    expect(said).toEqual([['ada', 'came in from your square.', true], ['ada', 're-filed under litigation.', true], ['someone', 're-filed under compliance.', true]])
    said.length = 0
    run({ cfg: { map: {} } })                                                 // you stand on the block
    cb({ id: 'a', name: 'ada', lvl: 1, status: 'compliance', aseed: 0, first: false, from: 'litigation' })
    cb({ id: 'c', name: 'cy', lvl: 1, status: 'compliance', aseed: 0, first: true, from: null })
    expect(said).toEqual([])
    run(null)                                                                 // no floor yet: nothing either
    cb({ id: 'a', name: 'ada', lvl: 1, status: 'extension', aseed: 0, first: false, from: 'litigation' })
    expect(said).toEqual([])
  })
  it('the photo reads your mark and its friend\'s word through compose-polaroid.js, once', () => {
    expect(game).toContain('anchor, pinTag: myPinTag, D: driftD(), firstShotOfLevel: !shotOnLevel,')
    expect(LINES.SUBJECT_PIN).toBe('the film develops {name}. the film shows your pin.')
    plain(photoWord('litigation')); expect(photoWord('litigation')).toBe(' filed under litigation.'); expect(photoWord('king')).toBe('')
    for (const w of STATUSES) plain(photoWord(w).trim())
  })
})

describe('the body in words: the line can no longer print a digit', () => {
  it('the murmur is the words, on every floor, for every pin; the line after it is as it was', () => {
    plain(BODY_LINE)
    expect(BODY_LINE).toBe('your body remains where you fell through.')
    const msgs = slice(game, 'const messages = [', '].filter(Boolean)')
    expect(msgs).toContain("...(anchor ? [BODY_LINE, 'you are very far from your body now.'] : []),")
    expect(msgs).not.toMatch(/formatAnchor|anchor\.lat|anchor\.lng|\$\{/)
    expect(game).toMatch(/import \{ BODY_LINE \} from '\.\/origin-anchored\.js'/)
    // the film's pin caption and the form say the same place in the same words; neither says the numbers, whatever the pin
    expect(pinCaption(PIN, 12, null).startsWith(`the film shows ${BODY_PLACE}.`)).toBe(true)
    expect(ADDRESS_PIN).toBe(`address: ${BODY_PLACE}. the body is there.`)
    for (const p of [PIN, { lat: -90, lng: 180 }, { lat: 48.8584, lng: 2.2945 }]) expect(pinCaption(p, 12, 'w')).not.toContain(formatAnchor(p))
  })
})

describe('every new line keeps the rules', () => {
  it('the crew\'s, the way in\'s, the body\'s', () => {
    for (const [k, l] of Object.entries(CREW)) {
      if (k === 'WHO_SELF') { expect(l).toBe('you'); continue }
      plain(l.replace(/\{\w+\}/g, 'x'), k)
    }
    for (const l of [ROOM_PIN_JOIN, ANCHORED_LINE, BODY_LINE, ADDRESS_PIN, BODY_PLACE]) plain(l)
    expect(CALL_GLYPH).not.toMatch(/[\d\w]/)
  })
})

describe('the docs say what the crew says', () => {
  it('README and the manual: /who, the re-filing, the square, the photo\'s word, the whistle\'s mark', () => {
    const readme = read('../README.md'), manual = read('../docs/manual.html')
    expect(readme).toMatch(/^\| enter \| [^\n]*`\/who` \(who is in the room, in words\)/m)
    expect(manual).toContain('<tr><td class="k">/who</td>')
    expect(manual).toContain(`<i>${CREW.WHO_SOLO}</i>`)
    for (const [k, d] of Object.entries({ readme, manual })) {
      for (const s of ['re-filed under litigation.', 'came in from your square.', CALL_GLYPH, 'the film shows your pin.']) expect(d, `${k}: ${s}`).toContain(s)
    }
    expect(readme).toContain('*filed under litigation.*')
  })
})

describe('the whistle on the sheet (fogmap.js markCall, mapcard.js)', () => {
  const me = (x, y) => ({ x, y, angle: 0 })
  it('a mark lasts about a minute, fading, and is forgotten after; one a friend, the newest call moves it', () => {
    expect(CALL_MARK_MS).toBe(60000); expect(CALL_REDRAW_MS).toBe(1000)
    const fog = createFogMap(), seen = []
    expect(fog.markCall(1, 'a', 10.5, 12.5, 1000)).toBe(true)
    expect(fog.eachCall(1, 1000, (x, y, a) => seen.push([x, y, a]))).toBe(1)
    expect(seen).toEqual([[10.5, 12.5, 1]])
    seen.length = 0; fog.eachCall(1, 31000, (x, y, a) => seen.push(a)); expect(seen[0]).toBeCloseTo(0.5, 5)
    seen.length = 0; fog.eachCall(1, 60999, (x, y, a) => seen.push(a)); expect(seen[0]).toBeGreaterThan(0); expect(seen[0]).toBeLessThan(0.001)
    expect(fog.eachCall(1, 61000)).toBe(0)                                     // gone, and forgotten
    expect(fog.eachCall(1, 1000)).toBe(0)
    fog.markCall(1, 'a', 1.5, 1.5, 0); fog.markCall(1, 'a', 2.5, 2.5, 5000)
    seen.length = 0; fog.eachCall(1, 5000, (x, y) => seen.push([x, y])); expect(seen).toEqual([[2.5, 2.5]])
    for (let i = 0; i < CALL_MAX + 3; i++) fog.markCall(1, 'f' + i, i, i, 6000 + i)
    expect(fog.eachCall(1, 7000)).toBe(CALL_MAX)
  })
  it('never on the block, never a mark without a place, a time or a friend; never saved', () => {
    const fog = createFogMap()
    expect(fog.markCall(4, 'a', 10.5, 12.5, 0)).toBe(false)
    expect(fog.eachCall(4, 0)).toBe(0)
    for (const args of [[1, '', 1, 1, 0], [1, null, 1, 1, 0], [1, 'a', NaN, 1, 0], [1, 'a', 1, Infinity, 0], [1, 'a', 1, 1, NaN], [-1, 'a', 1, 1, 0], [1.5, 'a', 1, 1, 0]])
      expect(fog.markCall(...args), JSON.stringify(args)).toBe(false)
    fog.markCall(2, 'a', 3.5, 3.5, 0)
    expect(JSON.stringify(fog.export())).toBe('{}')                             // the save never carries one
    fog.import({}); expect(fog.eachCall(2, 0)).toBe(0)                          // a resume starts with none
  })
  it('the sheet draws a faint squiggle where they stood, fading with the mark: this floor only, never a number', () => {
    const fog = createFogMap()
    fog.markCall(1, 'a', 30.5, 31.5, 0)
    fog.markCall(2, 'b', 30.5, 31.5, 0)                                         // another floor's call is that floor's
    const texts = [], alphas = []
    const ctx = { fillRect() {}, fillText(t) { texts.push(t); alphas.push(this.globalAlpha) }, save() {}, restore() {}, translate() {}, rotate() {}, beginPath() {}, moveTo() {}, lineTo() {}, fill() {}, globalAlpha: 1 }
    const v = buildMapView(fog, 1, me(30.5, 30.5), { cells: 56, now: 30000 })
    expect(v.nCalls).toBe(1)
    expect(v.calls[0]).toMatchObject({ x: 30.5, y: 31.5 }); expect(v.calls[0].a).toBeCloseTo(0.5, 5)
    drawMap(ctx, v, {})
    expect(texts).toEqual([CALL_GLYPH])
    expect(alphas[0]).toBeCloseTo(CALL_ALPHA * 0.5, 5)
    expect(Object.values(GLYPHS)).not.toContain(CALL_GLYPH)
    // no clock, no mark; past the minute, none
    expect(buildMapView(fog, 1, me(30.5, 30.5), { cells: 56 }).nCalls).toBe(0)
    expect(buildMapView(fog, 1, me(30.5, 30.5), { cells: 56, now: CALL_MARK_MS }).nCalls).toBe(0)
    // out of the window: not drawn (the sheet is 56 cells)
    const far = createFogMap(); far.markCall(1, 'a', 500.5, 500.5, 0)
    expect(buildMapView(far, 1, me(30.5, 30.5), { cells: 56, now: 1 }).nCalls).toBe(0)
    // the zoom keeps a mark on the paper
    const only = createFogMap(); only.markCall(1, 'a', 50.5, 30.5, 0)
    const fit = fitView(buildMapView(only, 1, me(30.5, 30.5), { cells: 56, now: 1 }), 448)
    const vx = (50 - (30 - 28)) * fit.pitch + fit.tx
    expect(vx).toBeGreaterThanOrEqual(0); expect(vx).toBeLessThan(448)
  })
  it('game.js: a friend\'s whistle on this floor marks it (never the block, never your own whistle); the card fades it once a second', () => {
    const h = slice(game, "bus.on('whistle', ({ id, name, payload: p }) => {", '\n    })\n') + '\n    })'
    expect(h).toContain('if (!level.cfg.map && fog.markCall(level.index, id, p.x, p.y, now)) { callMarkUntil = now + CALL_MARK_MS; if (mapOpen) mapCard.cellsDirty() }')
    expect(at(h, 'if (!level || p.lvl !== level.index) return')).toBeLessThan(at(h, 'fog.markCall('))
    const out = slice(game, 'function whistleOut(live) {', '\n  }\n')
    expect(out).not.toContain('markCall')
    expect(count('fog.markCall(')).toBe(1)
    expect(game).toContain('if (t - callDrawnAt >= CALL_REDRAW_MS) { callDrawnAt = t; mapCard.cellsDirty(); if (t >= callMarkUntil) callMarkUntil = 0 }')
    // lifted and run against fakes: the mark lands for a friend on your floor, never on the block or from another floor
    const marks = []
    let dirty = 0
    const run = (level, p) => {
      let handler = null
      const fn = new Function('bus', 'level', 'player', 'whistle', 'whistlePitch', 'whistlePan', 'whistleGain', 'radioWasOn', 'addChatLine', 'bearingLabel', 'rollcall',
        'FAR_BONUS', 'company', 'fog', 'CALL_MARK_MS', 'mapOpen', 'mapCard', 'performance',
        `let sanity = 50, callMarkUntil = 0\n${h}\nreturn { fire: (e) => handler(e), until: () => callMarkUntil }`.replace("bus.on('whistle', ", 'handler = ('))
      const r = fn(null, level, { x: 0, y: 0, angle: 0 }, () => {}, () => 1, () => 0, () => 1, false, () => {}, () => 'near', { hear() {}, farBonusOk: () => false },
        { cells: 12 }, { add() {} }, { markCall: (...a) => { marks.push(a); return true } }, CALL_MARK_MS, true, { cellsDirty: () => { dirty++ } }, { now: () => 5000 })
      r.fire({ id: 'f', name: 'fay', payload: p })
      return r.until()
    }
    expect(run({ index: 1, cfg: {} }, { x: 3, y: 4, lvl: 1 })).toBe(5000 + CALL_MARK_MS)
    expect(marks).toEqual([[1, 'f', 3, 4, 5000]]); expect(dirty).toBe(1)
    expect(run({ index: 4, cfg: { map: {} } }, { x: 3, y: 4, lvl: 4 })).toBe(0)       // the block: no sheet, no mark
    expect(run({ index: 1, cfg: {} }, { x: 3, y: 4, lvl: 2 })).toBe(0)                // another floor's whistle
    expect(marks).toHaveLength(1)
  })
})
