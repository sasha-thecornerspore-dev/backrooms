// The field terminal (terminal.js, v2.0.6): the pure half — the words, the unlock rule, every readout, the case review, the filing gate,
// the history, the log, and the prose lint over its new lines. The card is test/terminal-card.test.js; the wiring into game.js is
// test/terminal-wiring.test.js; the record it reads is test/casebook.test.js.
import { describe, it, expect } from 'vitest'
import {
  TERM, TERM_CHROME, TERM_WORDS, ALWAYS_KNOWN, fill, termWord, isOpener, parseTermLine, floorWord, pageNames, known, run, complete,
  caseLine, reviewCase, whereCaseRows, mazeFloors, createFilingGate, createHistory, createLogRing, loggable, jotRows, strikeRows,
} from '../src/renderer/terminal.js'
import { createCasebook } from '../src/renderer/casebook.js'
import { SCRAPS } from '../src/renderer/scraps.js'
import { SIGHT_LINES } from '../src/renderer/sightpins.js'
import { PHRASES } from '../src/renderer/caches.js'
import { RADIO_GROUPS } from '../src/renderer/compose-radio.js'
import { DRAWER_NOTES } from '../src/renderer/containers.js'
import { KINDS } from '../src/renderer/film.js'
import { FIRST_NOTE, FIRST_SOUL, FIRST_ROOM } from '../src/renderer/firstrun.js'
import { LEVELS } from '../src/renderer/levels.js'
import { WORDS as STATUS_WORDS, STATUSES, npcLines } from '../src/renderer/status.js'
import { SEALED_TEXT, REDACTED_FOOT } from '../src/renderer/papercard.js'
import { LEDGER_LABEL } from '../src/renderer/closings.js'
import { lanLine } from '../src/renderer/site.js'
import { pinCaption } from '../src/renderer/origin-anchored.js'
import { formatAnchor } from '../src/renderer/anchor.js'

const NPC = Array.from({ length: 12 }, (_, i) => `a lost soul's line number ${'abcdefghijkl'[i]}.`)
const NAMES = pageNames(SCRAPS)
const FLOORS = LEVELS.filter((l) => Number.isInteger(l.id)).map((l) => floorWord(l.name))
const BOUNDS = { pages: SCRAPS.length, souls: [NPC.length, ...STATUSES.map((s) => npcLines(s).length)], drawers: DRAWER_NOTES.length, phrases: PHRASES.length,
  sights: Object.keys(SIGHT_LINES), kinds: KINDS, floors: FLOORS.length, thread: 3 }
const noTimer = { setTimer: () => 1, clearTimer: () => {} }
const book = () => createCasebook({ storage: null, bounds: BOUNDS, ...noTimer })
const TEXTS = { npc: NPC, statusPools: STATUSES.map((s) => npcLines(s)), drawers: DRAWER_NOTES,
  first: { note: FIRST_NOTE.text, soul: FIRST_SOUL.line, room: FIRST_ROOM.line }, sights: SIGHT_LINES, phrases: PHRASES }
function viewOf(b, over = {}) {
  return { scraps: SCRAPS, names: NAMES, book: b.view(), readSet: new Set(), redacted: [], radio: { mask: 0, groups: RADIO_GROUPS, ledgerHeard: false },
    texts: TEXTS, floorNames: FLOORS, floor: 0, onBlock: false, log: [], photoIdx: 0, site: false, notes: [], ...over }
}
const say = (line, view) => run(parseTermLine(line), view)
const texts = (r) => r.rows.map((x) => x.t)
const after = (r) => r.rows.slice(1)                              // past the echo

describe('the words', () => {
  it('termWord: a slash and a terminal word, any case, any argument; nothing else', () => {
    for (const w of TERM_WORDS) { expect(termWord('/' + w), w).toBe(true); expect(termWord('/' + w.toUpperCase() + ' x y'), w).toBe(true); expect(termWord('  /' + w + '  ')).toBe(true) }
    for (const l of ['term', 'pages', '/file x', '/recover', '/cases', '/intake', '/status', '/invite', '/me waves', '/', '', null, undefined, '/termx', '/ pages', 'hello /pages'])
      expect(termWord(l), String(l)).toBe(false)
    expect(isOpener('term')).toBe(true); expect(isOpener('terminal')).toBe(true); expect(isOpener('pages')).toBe(false)
  })
  it('parseTermLine: the slash optional, the word lowercased, the argument as typed', () => {
    expect(parseTermLine('/READ The-Carpet')).toMatchObject({ cmd: 'read', arg: 'The-Carpet', echo: '› /READ The-Carpet' })
    expect(parseTermLine('  grep   the dark  ')).toMatchObject({ cmd: 'grep', arg: 'the dark', echo: '› grep   the dark' })
    expect(parseTermLine('')).toMatchObject({ cmd: '', arg: '' })
    expect(parseTermLine('x'.repeat(200)).echo.length).toBeLessThanOrEqual(80)
  })
  it('a filing echoes masked, never with its answer, over random strings, with or without the slash, any case, any whitespace', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296
    const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789 -_.,!?/\'"<>\t'
    for (let n = 0; n < 500; n++) {
      let ans = ''
      for (let i = 1 + ((rnd() * 30) | 0); i > 0; i--) ans += alpha[(rnd() * alpha.length) | 0]
      ans = ans.trim() || 'x'
      for (const pre of ['file ', '/file ', 'FILE ', '/File\t', '  file   ']) {
        const p = parseTermLine(pre + ans)
        expect(p.cmd).toBe('file')
        expect(p.echo).toBe(TERM_CHROME.ECHO_FILE)
        expect(p.echo.includes(ans.slice(0, 3)) && !TERM_CHROME.ECHO_FILE.includes(ans.slice(0, 3))).toBe(false)
        expect(p.line).toBe('')
        const r = say(pre + ans, viewOf(book()))
        for (const row of r.rows) expect(row.t.includes(ans) && ans.length > 2 && !TERM_CHROME.ECHO_FILE.includes(ans)).toBe(false)
        expect(r.effect).toEqual({ kind: 'file', arg: p.arg })
      }
    }
  })
  it('floorWord: the floor\'s own name, with no digit', () => {
    expect(FLOORS).toEqual(['the lobby', 'habitable zone', 'pipe dreams', 'electrical station'])
    expect(floorWord('level ∅ — the block')).toBe('the block')
    for (const f of FLOORS) expect(f).not.toMatch(/\d/)
  })
  it('pageNames: one per page, unique, letters and hyphens only, stable', () => {
    expect(NAMES).toHaveLength(SCRAPS.length)
    expect(new Set(NAMES).size).toBe(NAMES.length)
    for (const n of NAMES) expect(n).toMatch(/^[a-z]+(-[a-z]+)*$/)
    expect(pageNames(SCRAPS)).toEqual(NAMES)
    expect(Object.isFrozen(NAMES)).toBe(true)
    expect(pageNames(['the same words here', 'the same words there', 'the same words here'])).toEqual(['the-same-words', 'the-same-words-there', 'the-same-words-here'])
    expect(pageNames(['same words', 'same words', 'same words'])).toEqual(['same-words', 'same-words-a', 'same-words-b'])
  })
})

describe('the unlock rule (§3.4)', () => {
  it('the always-known words, and nothing else, on an empty record', () => {
    expect(known(viewOf(book()))).toEqual(ALWAYS_KNOWN)
    expect(ALWAYS_KNOWN).toEqual(['help', 'notes', 'recover', 'cases', 'file', 'intake', 'status', 'log', 'where', 'floors', 'jot', 'margin', 'strike', 'clear', 'exit'])
  })
  it('each kind unlocks with its first find', () => {
    const cases = [
      [(b) => b.page(3, 0), {}, ['pages', 'read', 'grep']],
      [() => {}, { redacted: [4] }, ['pages', 'read']],
      [() => {}, { radio: { mask: 2, groups: RADIO_GROUPS, ledgerHeard: false } }, ['radio']],
      [() => {}, { radio: { mask: 0, groups: RADIO_GROUPS, ledgerHeard: true } }, ['radio']],
      [(b) => b.cache(1, 0, true), {}, ['words', 'grep']],
      [(b) => b.soul(0, 1, 0), {}, ['voices', 'grep']],
      [(b) => b.drawer(1, 0), {}, ['voices', 'grep']],
      [(b) => b.thread(1), {}, ['voices', 'grep']],
      [(b) => b.sight('payphone', 1), {}, ['sights', 'grep']],
      [(b) => b.den('hound', 2), {}, ['sights', 'grep']],
      [(b) => b.jot('my own line'), {}, ['grep']],
    ]
    for (const [find, over, want] of cases) {
      const b = book(); find(b)
      expect(known(viewOf(b, over)).filter((w) => !ALWAYS_KNOWN.includes(w)).sort()).toEqual([...want].sort())
    }
  })
  it('a locked word and nonsense get the identical reply, byte for byte; help and Tab never name a locked word', () => {
    const v = viewOf(book())
    const nonsense = after(say('xyzzy', v))
    expect(nonsense).toEqual([{ t: TERM.UNKNOWN, cls: 't-out' }])
    for (const w of ['pages', 'read', 'radio', 'words', 'voices', 'sights', 'grep', 'film']) {
      expect(after(say(w, v)), w).toEqual(nonsense)
      expect(after(say('/' + w + ' something', v)), w).toEqual(nonsense)
      expect(texts(say('help', v)).some((t) => t.startsWith(w + ' ')), w).toBe(false)
      expect(complete(w.slice(0, 2), v) ?? '', w).not.toContain(w)
    }
    expect(say('pages', v).effect).toBeNull()
  })
  it('help lists the unlocked words only, in its order', () => {
    const b = book(); b.page(3, 0)
    const rows = texts(say('help', viewOf(b))).slice(1)
    expect(rows.slice(-2)).toEqual(['clear · empty the screen', 'exit · put it away'])
    expect(rows[0]).toBe(TERM.HELP_HEAD)
    const want = TERM_CHROME.HELP.filter(([w]) => known(viewOf(b)).includes(w)).map(([, l]) => l)
    expect(rows.slice(1)).toEqual(want)
    expect(rows).toContain("pages · m.'s pages you have read")
    expect(rows).not.toContain("radio · the station's groups, as you heard them")
  })
  it('film answers only once a letter has developed this session; invite never hands out a link', () => {
    expect(after(say('film', viewOf(book(), { photoIdx: 1 })))).toEqual([{ t: TERM.FILM, cls: 't-out' }])
    expect(after(say('invite pin', viewOf(book())))).toEqual([{ t: TERM.NO_LINKS, cls: 't-out' }])
    expect(say('invite', viewOf(book())).effect).toBeNull()
  })
})

describe('the readouts', () => {
  it('pages: found order (never the pages\' own order), an earlier walk marked, a given-up page sealed even when the record has it', () => {
    const b = book(); b.page(17, 1); b.page(2, 0); b.page(9, 2); b.page(5, -1)
    const v = viewOf(b, { readSet: new Set([17, 9]), redacted: [9, 11] })
    expect(texts(say('pages', v)).slice(1)).toEqual([TERM.PAGES_HEAD, NAMES[17], fill(TERM_CHROME.PAGE_EARLIER, { name: NAMES[2] }),
      `${SEALED_TEXT} · given up`, fill(TERM_CHROME.PAGE_EARLIER, { name: NAMES[5] }), `${SEALED_TEXT} · given up`,
      'five of twenty-six pages in the file.', 'two of thirteen pages given up.', TERM.PAGES_SEALED])
    expect(SCRAPS.length).toBe(26)                                    // the count's 'twenty-six'
  })
  it('read: a found page\'s text and the foot, nothing counted; a given-up page sealed; unknown or unfound names the same no-name line', () => {
    const b = book(); b.page(7, 0); b.page(9, 0)
    const v = viewOf(b, { redacted: [9] })
    expect(after(say('read ' + NAMES[7], v))).toEqual([{ t: SCRAPS[7], cls: 't-page' }, { t: TERM.READ_FOOT, cls: 't-dim' }])
    expect(after(say('read ' + NAMES[7].toUpperCase(), v))[0].t).toBe(SCRAPS[7])
    expect(after(say('read ' + NAMES[9], v))).toEqual([{ t: SEALED_TEXT, cls: 't-page' }, { t: REDACTED_FOOT, cls: 't-dim' }])
    expect(after(say('read', v))).toEqual([{ t: TERM.READ_WHICH, cls: 't-out' }])
    expect(after(say('read ' + NAMES[3], v))).toEqual([{ t: TERM.NO_NAME, cls: 't-out' }])
    expect(after(say('read no-such-page', v))).toEqual([{ t: TERM.NO_NAME, cls: 't-out' }])
    // a page given up that the record does not hold answers as any unfound name: guessing names never tells which were given up
    const g = viewOf(b, { redacted: [9, 5] })
    expect(after(say('read ' + NAMES[5], g))).toEqual(after(say('read ' + NAMES[3], g)))
    expect(after(say('read ' + NAMES[5], g))).toEqual([{ t: TERM.NO_NAME, cls: 't-out' }])
    expect(after(say('read ' + NAMES[9], g))).toEqual([{ t: SEALED_TEXT, cls: 't-page' }, { t: REDACTED_FOOT, cls: 't-dim' }])
  })
  it('no unread page\'s text ever appears, whatever is typed', () => {
    const b = book(); b.page(0, 0); b.page(1, 1)
    const v = viewOf(b, { redacted: [1], radio: { mask: 15, groups: RADIO_GROUPS, ledgerHeard: true } })
    const lines = ['help', 'pages', 'radio', 'words', 'voices', 'sights', 'floors', 'where', 'log', 'margin', ...NAMES.map((n) => 'read ' + n),
      ...SCRAPS.flatMap((s) => s.split(/[\s,.:;'"—()]+/).filter((w) => w.length >= 3).slice(0, 12).map((w) => 'grep ' + w))]
    const seen = lines.flatMap((l) => texts(say(l, v))).join('\n')
    for (let f = 1; f < SCRAPS.length; f++) for (const at of [0, 40, 80]) if (SCRAPS[f].length >= at + 40) expect(seen.includes(SCRAPS[f].slice(at, at + 40)), `${f} @${at}`).toBe(false)
    expect(seen.includes(SCRAPS[0].slice(0, 60))).toBe(true)
  })
  it('radio: all sixteen masks, only the groups heard, as the radio reads them; the ledger line and its went-by; always the wake line', () => {
    expect(RADIO_GROUPS).toHaveLength(4)
    for (let mask = 0; mask < 16; mask++) for (const ledgerHeard of [false, true]) {
      const rows = texts(say('radio', viewOf(book(), { radio: { mask, groups: RADIO_GROUPS, ledgerHeard } }))).slice(1)
      if (!mask && !ledgerHeard) { expect(rows).toEqual([TERM.UNKNOWN]); continue }
      const want = [TERM.RADIO_HEAD]
      for (let i = 0; i < 4; i++) if (mask & (1 << i)) want.push(`${RADIO_GROUPS[i]}   [${i + 1}/4]`)
      if (ledgerHeard) { want.push(LEDGER_LABEL + '.'); if (mask !== 15) want.push(TERM.RADIO_WENT_BY) }
      want.push(TERM.RADIO_WAKE)
      expect(rows, `mask ${mask} ${ledgerHeard}`).toEqual(want)
      for (let i = 0; i < 4; i++) if (!(mask & (1 << i))) expect(rows.join('\n').includes(RADIO_GROUPS[i]), `mask ${mask} group ${i}`).toBe(false)
    }
  })
  it('words: the phrase, the floor, and whose — yours, a name this session, or someone', () => {
    const b = book(); b.cache(2, 1, true); b.cache(4, 2, false, 'maddie')
    const later = createCasebook({ storage: { getItem: () => JSON.stringify(b.toJSON()), setItem() {} }, bounds: BOUNDS, ...noTimer })
    expect(texts(say('words', viewOf(b))).slice(1)).toEqual([TERM.WORDS_HEAD, `${PHRASES[2]} · habitable zone · yours`, `${PHRASES[4]} · pipe dreams · left by maddie`])
    expect(texts(say('words', viewOf(later))).slice(1)).toEqual([TERM.WORDS_HEAD, `${PHRASES[2]} · habitable zone · yours`, `${PHRASES[4]} · pipe dreams · left by someone`])
  })
  it('voices: each group under its head, repeats gone; the thread as far as it came', () => {
    const b = book(); b.soul(0, 3, 0); b.soul(0, 3, 1); b.soul(2, 0, 1); b.drawer(6, 2); b.thread(2)
    // (k 2 is the second status's line: STATUSES[1], the extension)
    expect(texts(say('voices', viewOf(b))).slice(1)).toEqual([TERM.VOICES_LOST, NPC[3], npcLines(STATUSES[1])[0], TERM.VOICES_DRAWERS, DRAWER_NOTES[6],
      TERM.VOICES_THREAD, FIRST_NOTE.text, FIRST_SOUL.line])
    const t = book(); t.thread(1)
    expect(texts(say('voices', viewOf(t))).slice(1)).toEqual([TERM.VOICES_THREAD, FIRST_NOTE.text])
  })
  it('sights and dens, with their floors', () => {
    const b = book(); b.sight('tvwall', 1); b.den('hound', 3)
    expect(texts(say('sights', viewOf(b))).slice(1)).toEqual([TERM.SIGHTS_HEAD, `${SIGHT_LINES.tvwall.name} · habitable zone — ${SIGHT_LINES.tvwall.line}`,
      TERM.DENS_HEAD, 'the hound · electrical station'])
  })
  it('floors and where: the kinds a floor holds, none left at zero; never a floor not reached; where on the block holds nothing', () => {
    const b = book(); b.page(1, 2); b.page(2, 2); b.soul(0, 1, 2); b.sight('payphone', 0); b.page(3, -1)
    expect(texts(say('floors', viewOf(b))).slice(1)).toEqual([TERM.FLOORS_HEAD, 'the lobby · sights one', 'pipe dreams · pages two · voices one'])
    expect(texts(say('floors', viewOf(book()))).slice(1)).toEqual([TERM.FLOORS_NONE])
    expect(after(say('where', viewOf(b, { floor: 2 })))).toEqual([{ t: 'pipe dreams · pages two · voices one', cls: 't-page' }])
    expect(say('where', viewOf(b, { floor: 2 })).effect).toEqual({ kind: 'where', arg: '' })
    expect(texts(say('where', viewOf(b, { floor: 1 }))).slice(1)).toEqual([TERM.WHERE_NONE])
    const blk = say('where', viewOf(b, { floor: 4, onBlock: true }))
    expect([texts(blk).slice(1), blk.effect]).toEqual([[TERM.WHERE_NONE], null])
  })
  it('grep: three letters or it asks for more; at most six rows, then the more line; only what was found', () => {
    const b = book(); b.page(0, 0); b.jot('a line about the hum'); b.cache(2, 1, true)
    const v = viewOf(b)
    expect(after(say('grep ab', v))).toEqual([{ t: TERM.GREP_SHORT, cls: 't-out' }])
    expect(after(say('grep 12', v))).toEqual([{ t: TERM.GREP_SHORT, cls: 't-out' }])
    expect(after(say('grep', v))).toEqual([{ t: TERM.GREP_SHORT, cls: 't-out' }])
    expect(texts(say('grep hum', v))[1]).toMatch(/^margin · yours · …a line about the hum…$/)
    expect(texts(say('grep loops', v))[1]).toBe(`words · habitable zone · …${PHRASES[2]}…`)
    expect(after(say('grep zzzqqq', v))).toEqual([{ t: TERM.GREP_NONE, cls: 't-out' }])
    const many = book(); for (let i = 0; i < 9; i++) many.jot('the word kettle, line ' + 'abcdefghi'[i])
    const r = texts(say('grep kettle', viewOf(many))).slice(1)
    expect(r).toHaveLength(7); expect(r[6]).toBe(TERM.GREP_MORE)
  })
  it('grep never finds what is only in an unread page, a given-up page, a locked clue, a sealed note or a radio group', () => {
    const b = book(); b.page(0, 0); b.page(5, 1)
    const v = viewOf(b, { redacted: [5], radio: { mask: 15, groups: RADIO_GROUPS, ledgerHeard: true },
      notes: [{ title: 'i · read', text: 'a note the record opened, plainly' }] })
    const word = (f) => SCRAPS[f].split(/\s+/).map((w) => w.replace(/[^a-z]/g, '')).find((w) => w.length >= 6 && !SCRAPS[0].includes(w) && !SCRAPS[5 === f ? 0 : 5].includes(w))
    for (const f of [7, 12, 5]) { expect(word(f), String(f)).toMatch(/^[a-z]{6,}$/); expect(after(say('grep ' + word(f), v)), String(f)).toEqual([{ t: TERM.GREP_NONE, cls: 't-out' }]) }
    expect(after(say('grep 26 04', v))).toEqual([{ t: TERM.GREP_SHORT, cls: 't-out' }])   // a radio group: digits, never searchable
    expect(after(say('grep sealed clue words', v))).toEqual([{ t: TERM.GREP_NONE, cls: 't-out' }])
    expect(texts(say('grep plainly', v))[1]).toMatch(/^notes · i · read · …[a-z ,]*opened, plainly…$/)
  })
  it('log and margin, and the jot / strike replies', () => {
    expect(after(say('log', viewOf(book())))).toEqual([{ t: TERM.LOG_NONE, cls: 't-out' }])
    expect(texts(say('log', viewOf(book(), { log: ['one line.', 'two lines.'] }))).slice(1)).toEqual([TERM.LOG_HEAD, 'one line.', 'two lines.'])
    expect(after(say('margin', viewOf(book())))).toEqual([{ t: TERM.MARGIN_NONE, cls: 't-out' }])
    const b = book(); b.jot('remember the cone')
    expect(texts(say('margin', viewOf(b))).slice(1)).toEqual([TERM.MARGIN_HEAD, 'remember the cone'])
    expect(say('jot x y', viewOf(b)).effect).toEqual({ kind: 'jot', arg: 'x y' })
    expect(say('strike cone', viewOf(b)).effect).toEqual({ kind: 'strike', arg: 'cone' })
    expect(texts({ rows: jotRows('ok') })).toEqual([TERM.JOT_OK]); expect(texts({ rows: jotRows('full') })).toEqual([TERM.JOT_FULL]); expect(texts({ rows: jotRows('empty') })).toEqual([TERM.JOT_WHAT])
    expect(texts({ rows: strikeRows(true) })).toEqual([TERM.STRUCK]); expect(texts({ rows: strikeRows(false) })).toEqual([TERM.STRIKE_NONE])
  })
  it('the effects: the line\'s four words pass, notes and file go to the game, clear and exit; the openers print only the echo', () => {
    const v = viewOf(book())
    for (const w of ['recover', 'cases', 'intake', 'status']) expect(say(w + ' d8', v).effect, w).toEqual({ kind: 'pass', arg: 'd8' })
    expect(say('notes', v).effect).toEqual({ kind: 'notes', arg: '' })
    expect(say('notes s37', v).effect).toEqual({ kind: 'notes', arg: 's37' })
    expect(say('clear', v).effect).toEqual({ kind: 'clear', arg: '' })
    expect(say('exit', v).effect).toEqual({ kind: 'exit', arg: '' })
    for (const w of ['term', 'terminal']) expect([texts(say(w, v)), say(w, v).effect]).toEqual([['› ' + w], null])
  })
})

describe('Tab', () => {
  it('completes a word from the known ones, keeps the slash, and a page name after read — never a hidden one', () => {
    const b = book(); b.page(2, 0); b.page(9, 0)
    const v = viewOf(b, { redacted: [9] })
    expect(complete('fl', v)).toBe('floors ')
    expect(complete('/he', v)).toBe('/help ')
    expect(complete('re', v)).toBeNull()                           // read, recover: no longer common prefix
    expect(complete('rec', v)).toBe('recover ')
    expect(complete('read scr', v)).toBe('read ' + NAMES[2])
    expect(complete('read ' + NAMES[9].slice(0, 3), v)).toBeNull()   // given up: its name is never shown
    expect(complete('read the-c', v)).toBeNull()                    // the carpet page, never found
    expect(complete('ra', v)).toBeNull()                           // radio, locked
    expect(complete('fi', viewOf(book(), { photoIdx: 0 }))).toBe('file ')
    for (let f = 0; f < SCRAPS.length; f++) if (f !== 2) expect(complete('read ' + NAMES[f], v) ?? '').not.toContain(NAMES[f])
  })
})

describe('the case (notes)', () => {
  const M = () => ({
    id: 'case-x', title: 'the made-up case', stations: [
      { id: 'a', title: 'i · the first', clue: 'the first clue.', prompt: 'a word', gate: {}, onSolve: 'note a' },
      { id: 'b', title: 'ii · the second', clue: 'the second clue.', prompt: 'b word', parity: ['in the maze', 'in the record'], gate: {}, onSolve: 'note b',
        maze: { levels: [2, 3], hint: 'the deep stacks hint.' }, where: 'WHERE-B', link: { href: 'https://example.invalid/b', label: 'LINK-B' } },
      { id: 'c', title: 'iii · the third', clue: 'THE LOCKED CLUE.', prompt: 'c word', gate: {}, onSolve: 'NOTE C' },
    ],
    reward: { title: 'the closing title', text: 'the closing text.', fieldText: 'the field text.', key: 'KEY-123', href: 'https://example.invalid/r', linkLabel: 'LABEL-R' },
  })
  const spies = (solved, over = {}) => {
    const calls = { station: [], reward: 0 }
    const deps = { solved: (c, s) => solved.includes(s),
      openStation: async (m, s) => { calls.station.push(s.id); return { text: s.onSolve, from: 'plain' } },
      openReward: async (m) => { calls.reward++; return { reward: m.reward, from: 'plain' } }, ...over }
    return { calls, deps }
  }
  const all = (rows) => rows.map((r) => r.t).join('\n')
  it('caseLine is /recover\'s summary, byte for byte the template game.js said before the terminal (replayed from its old source)', () => {
    // game.js at 92bcba5 (the /recover branch), lifted verbatim
    const OLD = "const done = m.stations.filter(s => rSolved(m.id, s.id)).length\nconst next = m.stations.find(s => !rSolved(m.id, s.id))\n" +
      "return m.title + ' — ' + done + ' of ' + m.stations.length + ' instruments read.' + (next ? ' next: ' + next.title + '.' : ' the case is read.')"
    const old = new Function('m', 'rSolved', OLD)
    for (const solved of [[], ['a'], ['a', 'b'], ['a', 'b', 'c'], ['b']]) {
      const s = (c, id) => solved.includes(id)
      expect(caseLine(M(), s)).toBe(old(M(), s))
    }
  })
  it('the read instruments\' notes, then the first unread one open; nothing past it; the seal is never asked past the first unread', async () => {
    const { calls, deps } = spies(['a', 'c'])
    const rows = await reviewCase(M(), { ...deps, floor: 0 })
    expect(rows.map((r) => r.t)).toEqual([caseLine(M(), deps.solved), 'i · the first — read.', 'note a', TERM.NOTES_OPEN, 'ii · the second',
      'read it by · in the maze · in the record', 'it asks for · b word', 'the second clue.'])
    expect(calls).toEqual({ station: ['a'], reward: 0 })
    expect(all(rows)).not.toMatch(/NOTE C|THE LOCKED CLUE|iii · the third|WHERE-B|LINK-B|example\.invalid|KEY-123/)
  })
  it('nothing read: the summary and the first instrument open, the seal never asked', async () => {
    const { calls, deps } = spies([])
    const rows = await reviewCase(M(), deps)
    expect(rows.map((r) => r.t).slice(0, 3)).toEqual([caseLine(M(), deps.solved), TERM.NOTES_OPEN, 'i · the first'])
    expect(calls).toEqual({ station: [], reward: 0 })
  })
  it('the maze hint only on a floor it names, never on the block', async () => {
    for (const [floor, onBlock, want] of [[2, false, true], [3, false, true], [1, false, false], [4, true, false], [2, true, false], [null, false, false]]) {
      const rows = await reviewCase(M(), { ...spies(['a']).deps, floor, onBlock })
      expect(all(rows).includes('the deep stacks hint.'), `${floor} ${onBlock}`).toBe(want)
    }
    expect(mazeFloors(M().stations[1])).toEqual([2, 3]); expect(mazeFloors({ maze: { level: 4 } })).toEqual([4]); expect(mazeFloors(null)).toEqual([])
  })
  it('a geo station: the place line instead of its clue, and no parity (it names the place too, as the live marker\'s does)', async () => {
    const m = M(); m.stations[0].geo = { lat: 1, lng: 2 }
    m.stations[0].parity = ['in the record · the inscription, transcribed', "in the world · the marker at the park's corner, in daylight"]
    const rows = await reviewCase(m, spies([]).deps)
    expect(all(rows)).toContain(TERM.NOTES_PLACE)
    expect(all(rows)).not.toContain('the first clue.')
    expect(all(rows)).not.toMatch(/read it by|in the world|the marker|the inscription/)
    expect(all(rows)).toContain('it asks for · a word')
  })
  it('the closing file only when every instrument is read: the title, the text (fieldText only when every place was walked), the key; never href or linkLabel', async () => {
    const { calls, deps } = spies(['a', 'b', 'c'])
    const rows = await reviewCase(M(), { ...deps, site: true })
    expect(calls.reward).toBe(1)
    expect(rows.map((r) => r.t).slice(-5)).toEqual([TERM.CLOSING_HEAD, 'the closing title', 'the closing text.', 'KEY-123', TERM_CHROME.BOARD])
    expect(all(rows)).not.toMatch(/example\.invalid|LABEL-R/)
    const field = await reviewCase(M(), { ...spies(['a', 'b', 'c']).deps, fieldComplete: () => true })
    expect(all(field)).toContain('the field text.'); expect(all(field)).not.toContain('the closing text.'); expect(all(field)).not.toContain(TERM_CHROME.BOARD)
    for (const solved of [[], ['a'], ['a', 'b'], ['b', 'c']]) {
      const s = spies(solved)
      const r = await reviewCase(M(), s.deps)
      expect([s.calls.reward, all(r).includes('KEY-123')], solved.join()).toEqual([0, false])
    }
  })
  it('what the seal says: a copy, a shut note, the honour flag; the closing file missing, unsupported, broken, absent', async () => {
    const copy = await reviewCase(M(), { ...spies(['a']).deps, openStation: async () => ({ text: 'the copy', from: 'copy' }), honour: (c, s) => s === 'a' })
    expect(copy.map((r) => r.t).slice(1, 5)).toEqual(['i · the first — read.', 'the copy', TERM.NOTE_COPY, TERM.HONOUR_BADGE])
    const shut = await reviewCase(M(), { ...spies(['a']).deps, openStation: async () => null })
    expect(shut.map((r) => r.t)[2]).toBe(TERM.NOTE_SHUT)
    for (const [r, want] of [[{ missing: [] }, TERM.REWARD_SHUT], [{ unsupported: true }, TERM.REWARD_NOCRYPTO], [{ error: true }, TERM.REWARD_ERR], [{ error: true, newer: true }, TERM.REWARD_ERR]]) {
      const rows = await reviewCase(M(), { ...spies(['a', 'b', 'c']).deps, openReward: async () => r })
      expect(rows[rows.length - 1].t).toBe(want)
    }
    const none = await reviewCase(M(), { ...spies(['a', 'b', 'c']).deps, openReward: async () => ({ none: true }) })
    expect(none[none.length - 1].t).toBe('note c'.toUpperCase())
  })
  it('the notes it opens are handed to grep\'s store (onNote), only the read ones', async () => {
    const seen = []
    await reviewCase(M(), { ...spies(['a', 'b']).deps, onNote: (t, x) => seen.push([t, x]) })
    expect(seen).toEqual([['i · the first', 'note a'], ['ii · the second', 'note b']])
  })
  it('where\'s case line: the open instrument\'s hint on its floor, never on the block, never past the first unread', () => {
    const s = (ids) => (c, id) => ids.includes(id)
    expect(whereCaseRows(M(), s(['a']), 2, false).map((r) => r.t)).toEqual([TERM.WHERE_CASE, 'the deep stacks hint.'])
    expect(whereCaseRows(M(), s(['a']), 1, false)).toEqual([])
    expect(whereCaseRows(M(), s(['a']), 2, true)).toEqual([])
    expect(whereCaseRows(M(), s([]), 2, false)).toEqual([])
    expect(whereCaseRows(null, s([]), 2, false)).toEqual([])
  })
})

describe('the filing gate', () => {
  it('busy through the floor; a miss holds the next ask off 4, 8, 16, then 32 s; a hit resets; it never sees the guess', () => {
    const g = createFilingGate()
    expect(g.ask(0)).toEqual({ ok: true })
    expect(g.ask(100)).toEqual({ busy: true })
    expect(g.floorLeft(400)).toBe(1100); expect(g.floorLeft(2000)).toBe(0)
    let t = 1500
    for (const wait of [4000, 8000, 16000, 32000, 32000, 32000]) {
      g.settle(false, t)
      expect(g.ask(t + wait - 1)).toEqual({ waitMs: 1 })
      expect(g.ask(t + wait)).toEqual({ ok: true })
      t += wait + 1500
    }
    g.settle(true, t)
    expect(g.ask(t)).toEqual({ ok: true })
    g.settle(false, t + 1500)
    expect(g.ask(t + 1500 + 3999)).toEqual({ waitMs: 1 })                 // back to the first wait
    expect(g.ask(t + 1500 + 4000)).toEqual({ ok: true })
    g.release()
    expect(g.ask(t + 6000)).toEqual({ ok: true })                       // released: free again, the back-off untouched
    expect(createFilingGate.length).toBe(0)
    expect(Object.keys(g).sort()).toEqual(['ask', 'floorLeft', 'release', 'settle'])
  })
})

describe('the history and the log', () => {
  it('the history keeps the last twelve lines, never a filing, no repeat; up and down walk it', () => {
    const h = createHistory()
    for (let i = 0; i < 15; i++) h.push('jot line ' + i)
    h.push('file the answer'); h.push('/FILE another'); h.push('jot line 14')
    expect(h.size()).toBe(12)
    expect(h.up()).toBe('jot line 14'); expect(h.up()).toBe('jot line 13')
    expect(h.down()).toBe('jot line 14'); expect(h.down()).toBe('')
    const seen = []; h.reset(); for (let i = 0; i < 14; i++) seen.push(h.up())
    expect(seen.some((l) => /file/.test(l))).toBe(false)
    expect(seen[11]).toBe('jot line 3')
    h.clear(); expect(h.size()).toBe(0); expect(h.up()).toBeNull()
  })
  it('the log ring: a fixed ring of 24, ten thousand pushes and no growth; list fills the caller\'s array in order', () => {
    const ring = createLogRing(24), out = []
    for (let i = 0; i < 10000; i++) ring.push('line ' + i)
    expect(ring.capacity()).toBe(24); expect(ring.count()).toBe(24)
    const same = ring.list(out)
    expect(same).toBe(out)
    expect(out).toEqual(Array.from({ length: 24 }, (_, i) => 'line ' + (10000 - 24 + i)))
    ring.clear(); expect(ring.list(out)).toEqual([]); expect(ring.capacity()).toBe(24)
    const small = createLogRing(3); small.push('a'); small.push('b'); expect(small.list([])).toEqual(['a', 'b'])
  })
  it('loggable: never the film\'s lines (a caption names a street, a pin, a letter), a link, the network line, or the pin itself', () => {
    expect(loggable('it has you.')).toBe(true)
    for (const t of ['the film shows the hall as it will finalize: darker, one door fewer.', 'the film develops the hound, and the hall it keeps to. you mark it on your map.',
      'https://backrooms.thecornerspore.dev/play/?room=abc', 'a pin.\nhttps://x.invalid/?room=a&n=b', lanLine({ code: 'abcd', lan: '192.168.0.2:8787' }), '', null, 7])
      expect(loggable(t), String(t)).toBe(false)
    const anchor = { lat: 39.2965, lng: -76.6431 }
    const pin = formatAnchor(anchor)
    expect(loggable(`your body remains at ${pin}.`, pin)).toBe(false)
    expect(loggable(`your body remains at ${pin}.`, null)).toBe(true)
    expect(loggable(pinCaption(anchor, 12, null), pin)).toBe(false)
  })
})

describe('the strings (VOICE REVIEW)', () => {
  const numberWords = new RegExp(`\\b(${STATUS_WORDS.join('|')}|hundred|thousand|first|second|third|once|twice)\\b`)
  it('every prose line: lowercase, no exclamation mark, no digit, no number word, ends with a period, no link, no page of m.\'s', () => {
    for (const [k, l] of Object.entries(TERM)) {
      expect(typeof l, k).toBe('string')
      expect(l, k).toBe(l.toLowerCase())
      expect(l, k).not.toMatch(/[!\d]/)
      // two words the spec's lines use as a pronoun and an adverb, not as counts: 'this one' (NOTES_PLACE) and 'a line first' (JOT_FULL).
      // Both wait on the owner's voice pass; nothing else may carry a number word
      expect(l.replace(/\bthis one\b/g, 'this').replace(/\ba line first\b/g, 'a line'), k).not.toMatch(numberWords)
      expect(l.endsWith('.'), k).toBe(true)
      expect(l, k).not.toMatch(/http/)
      for (const s of SCRAPS) { expect(s.includes(l), k).toBe(false) }
    }
    expect(Object.isFrozen(TERM)).toBe(true)
  })
  it('the prose and the chrome are apart, frozen, and the chrome\'s templates fill', () => {
    expect(Object.keys(TERM).filter((k) => k in TERM_CHROME)).toEqual([])
    expect(Object.isFrozen(TERM_CHROME)).toBe(true); expect(Object.isFrozen(TERM_CHROME.HELP)).toBe(true)
    expect(fill(TERM_CHROME.PROMPT, { floor: 'pipe dreams' })).toBe('pipe dreams ›')
    expect(fill('{a} $& {b}', { a: '$1', b: null })).toBe('$1 $& {b}')
    expect(TERM_CHROME.HELP.map(([w]) => w)).toEqual(['pages', 'read', 'radio', 'words', 'voices', 'sights', 'floors', 'where', 'grep', 'notes', 'file', 'recover',
      'jot', 'margin', 'strike', 'log', 'clear', 'exit'])
    // each row reads 'word · what it does', the word its own: clear empties the screen, exit puts it away
    for (const [w, l] of TERM_CHROME.HELP) expect(l.startsWith(w + ' '), w).toBe(true)
    expect(TERM_CHROME.HELP.slice(-2).map(([, l]) => l)).toEqual(['clear · empty the screen', 'exit · put it away'])
    // the settings row reads as the panel's other buttons and hints do: lowercase
    for (const k of ['SETTINGS_FORGET', 'SETTINGS_FORGET_HINT', 'SETTINGS_FORGET_AGAIN', 'SETTINGS_FORGOTTEN']) expect(TERM_CHROME[k], k).toBe(TERM_CHROME[k].toLowerCase())
    for (const [, l] of TERM_CHROME.HELP) expect(l).toBe(l.toLowerCase())
  })
})
