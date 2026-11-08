// The field terminal's wiring into game.js (v2.0.6). game.js only boots in a page, so these are source guards plus the pieces lifted out
// of it and replayed against the real modules (the film-wiring.test.js way): opening and folding it, the filing through the one gate,
// the log and the scrollback's copy, the radio's mask, the record's event sites, and what never goes on the wire.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { TERM, TERM_CHROME, parseTermLine, run as runTermLine, createFilingGate, createHistory, mazeFloors, jotRows, strikeRows, termWord, isOpener } from '../src/renderer/terminal.js'
import { createSeal } from '../src/renderer/recover-seal.js'
import { createCasebook } from '../src/renderer/casebook.js'
import { createMessageQueue, PRIO } from '../src/renderer/messages.js'
import { radioLine, RADIO_GROUPS } from '../src/renderer/compose-radio.js'
import { ledgerLines } from '../src/renderer/terminal.js'
import { DRAWER_NOTES } from '../src/renderer/containers.js'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const game = read('../src/renderer/game.js')
const html = read('../src/renderer/index.html')
const sw = read('../src/sw.js'), build = read('../tools/build-play.sh')
const terminal = read('../src/renderer/terminal.js'), casebookSrc = read('../src/renderer/casebook.js')
const at = (s, from = 0) => { const k = game.indexOf(s, from); expect(k, s).toBeGreaterThan(0); return k }
const slice = (from, to) => { const a = at(from), b = game.indexOf(to, a); expect(b, to).toBeGreaterThan(a); return game.slice(a, b) }
const lift = (re) => { const m = game.match(re); expect(m, String(re)).not.toBeNull(); return m[0] }
const count = (re) => (game.match(re) || []).length
const loopAt = game.indexOf('function loop(ts) {')
const loopBody = game.slice(loopAt, game.indexOf('requestAnimationFrame(loop)   // ALWAYS reschedule'))
const OPEN = /function openTerm\(line = null\) \{[\s\S]*?\r?\n {2}\}/
const CLOSE = /function closeTerm\(\) \{[\s\S]*?\r?\n {2}\}/
const FILE_NEXT = /async function fileNext\(arg, \{ viaTerm = false \} = \{\}\) \{[\s\S]*?\r?\n {2}\}/
const RUN = /function runTerm\(raw\) \{[\s\S]*?\r?\n {2}\}/

// openTerm and closeTerm, lifted and run against a stub page
function termRig(st = {}) {
  const K = { KeyW: true, Space: true }, calls = { release: 0, unlock: 0, open: [], close: 0, print: [], said: [], ran: [], hist: 0 }
  const body = { cls: new Set(), classList: { add: (c) => body.cls.add(c), remove: (c) => body.cls.delete(c) } }
  const g = { transitioning: false, dialogOpen: false, chatOpen: false, noteOpen: false, mapOpen: false, kneel: { st: null }, down: { st: null }, settings: true, ...st }
  const h = new Function('K', 'charger', 'document', 'term', 'showMessage', 'TERM', 'settingsHidden', 'floorPrompt', 'parseTermLine', 'isOpener', 'runTerm', 'termHistory', 'g',
    `let termOpen = false, termGreeted = false, chatOpen = g.chatOpen
     const { transitioning, dialogOpen, noteOpen, mapOpen, kneel, down } = g
     ${lift(OPEN)}\n${lift(CLOSE)}
     return { openTerm, closeTerm, state: () => ({ termOpen, chatOpen, termGreeted }) }`)(
    K, { forceRelease: () => calls.release++ }, { exitPointerLock: () => calls.unlock++, body }, { ok: true, open: (p) => calls.open.push(p), close: () => calls.close++, print: (r) => calls.print.push(r) },
    (m) => calls.said.push(m), TERM, () => g.settings, () => 'pipe dreams ›', parseTermLine, isOpener, (l) => calls.ran.push(l), { reset: () => calls.hist++ }, g)
  return { h, K, calls, body }
}

describe('opening and folding it', () => {
  it('openTerm: chatOpen with it, every held key dropped, the ward let go, the pointer lock released; the banner once; the line run', () => {
    const { h, K, calls, body } = termRig()
    expect(h.openTerm('/pages')).toBe(true)
    expect(h.state()).toEqual({ termOpen: true, chatOpen: true, termGreeted: true })
    expect([K.KeyW, K.Space, calls.release, calls.unlock, calls.open, body.cls.has('term-open')]).toEqual([false, false, 1, 1, ['pipe dreams ›'], true])
    expect(calls.print).toEqual([[{ t: TERM.BANNER, cls: 't-dim' }]])
    expect(calls.ran).toEqual(['/pages'])
    h.closeTerm()
    expect(h.state()).toMatchObject({ termOpen: false, chatOpen: false })
    expect([calls.release, calls.close, calls.hist, body.cls.has('term-open')]).toEqual([2, 1, 1, false])
    h.openTerm('/term')                                                   // the opener runs nothing; the banner is not said twice
    expect([calls.ran, calls.print.length]).toEqual([['/pages'], 1])
    expect(h.openTerm('/pages')).toBe(false)                              // already open: nothing
    expect(calls.open).toHaveLength(2)
  })
  it('refused while a fade, the dialog, the line, a card, the map, a kneel or the settings panel is up; lying down it says so and stays shut', () => {
    for (const st of [{ transitioning: true }, { dialogOpen: true }, { chatOpen: true }, { noteOpen: true }, { mapOpen: true }, { kneel: { st: 'kneel' } }, { settings: false }]) {
      const { h, calls } = termRig(st)
      expect(h.openTerm(), JSON.stringify(st)).toBe(false)
      expect([h.state().termOpen, calls.open.length, calls.said], JSON.stringify(st)).toEqual([false, 0, []])
    }
    const { h, calls } = termRig({ down: { st: 'down' } })
    expect(h.openTerm()).toBe(false)
    expect([h.state().termOpen, calls.said]).toEqual([false, [TERM.NOT_STANDING]])
  })
  it('the loop: ` opens it (its edge consumed either way, as Tab\'s), Esc folds it first; a travel, a death and the settings panel fold it, a hit does not', () => {
    const enter = loopBody.indexOf("K['Enter'] = false; K['NumpadEnter'] = false; openChat()")
    const bq = loopBody.indexOf("if (K['Backquote']) { K['Backquote'] = false; if (termOpen) closeTerm(); else openTerm() }")
    const esc = loopBody.indexOf("if (termOpen && K['Escape']) { K['Escape'] = false; closeTerm() }")
    expect(enter).toBeGreaterThan(0); expect(bq).toBeGreaterThan(enter); expect(esc).toBeGreaterThan(bq)
    expect(esc).toBeLessThan(loopBody.indexOf("if (kneel.st && K['Escape'])"))
    expect(esc).toBeLessThan(loopBody.indexOf("if (mapOpen && (K['Escape'] || K['Tab']))"))
    // a hit folds the map and the card but not the terminal, as it does not fold the line: a fold under typing fingers would hand the rest
    // of the word to the verbs (the input blurred, the pointer not locked: input.js takeKey takes a key typed on the body)
    const hit = slice("player.hp -= th.dmg * rules.damageMul; invuln = 0.7", 'if (regenDelay > 0) regenDelay -= dt')
    expect(hit).toContain('if (mapOpen) closeMap(); if (noteOpen) closeNoteCard()')
    expect(hit).not.toMatch(/closeTerm|closeChat/)
    expect(slice('function travel(way) {', '// die(): death.js resolves it')).toMatch(/if \(mapOpen\) closeMap\(\)\r?\n\s*if \(termOpen\) closeTerm\(\)/)
    expect(slice('function die(d = null) {', '// ── input ──')).toMatch(/if \(mapOpen\) closeMap\(\)\r?\n\s*if \(termOpen\) closeTerm\(\)/)
    expect(game).toContain("document.addEventListener('backrooms:settings-open', () => { if (termOpen) closeTerm(); forgetAsked = false; renderForget(TERM_CHROME.SETTINGS_FORGET, TERM_CHROME.SETTINGS_FORGET_HINT) })")
    expect(slice('function buildLevel(index, at = null) {', 'const fader = createFader(')).toContain('msgQ.clear(); term.clear(); logRing.clear()')
  })
  it('the line hands a terminal word off before the console, and the console line stays as it was', () => {
    const h = slice("chatInputEl?.addEventListener('keydown', (e) => {", '// ── the field console: the chat input doubles')
    const hand = h.indexOf('if (termWord(t)) { closeChat(); if (mapOpen) closeMap(); if (!openTerm(t) && kneel.st) showMessage(TERM.NOT_STANDING); return }')
    expect(hand).toBeGreaterThan(h.indexOf('const t = chatInputEl.value.trim()'))
    expect(hand).toBeLessThan(h.indexOf("if (t.startsWith('/') && !t.startsWith('/me ')) handleCommand(t)   // the field console"))
    expect(termWord('/pages')).toBe(true); expect(termWord('/file x')).toBe(false); expect(termWord('/me waves')).toBe(false)
  })
  it('a word typed on the line over the map folds the map and opens the terminal; kneeling it says the terminal waits; never dropped silently', () => {
    // the hand-off replayed with the real openTerm / closeTerm: the line opens over the map and while kneeling (both are held), so its
    // word must not land on openTerm's refusal and vanish
    const HAND = lift(/if \(termWord\(t\)\) \{ closeChat\(\);[^\n]*return \}/)
    function handRig(st = {}) {
      const g = { transitioning: false, dialogOpen: false, noteOpen: false, kneel: { st: null }, down: { st: null }, ...st }
      const calls = { said: [], ran: [], open: 0, chat: 0, map: 0 }
      const h = new Function('K', 'charger', 'document', 'term', 'showMessage', 'TERM', 'settingsHidden', 'floorPrompt', 'parseTermLine', 'isOpener', 'runTerm', 'termHistory', 'termWord', 'g', 'calls',
        `let termOpen = false, termGreeted = false, chatOpen = true, mapOpen = !!g.mapOpen
         const { transitioning, dialogOpen, noteOpen, kneel, down } = g
         function closeChat() { chatOpen = false; calls.chat++ }
         function closeMap() { mapOpen = false; calls.map++ }
         ${lift(OPEN)}\n${lift(CLOSE)}
         return { type(t) { ${HAND} }, state: () => ({ termOpen, chatOpen, mapOpen }) }`)(
        {}, { forceRelease() {} }, { exitPointerLock() {}, body: { classList: { add() {}, remove() {} } } }, { ok: true, open: () => calls.open++, close() {}, print() {} },
        (m) => calls.said.push(m), TERM, () => true, () => 'p ›', parseTermLine, isOpener, (l) => calls.ran.push(l), { reset() {} }, termWord, g, calls)
      return { h, calls }
    }
    const map = handRig({ mapOpen: true })
    map.h.type('/notes')
    expect([map.h.state(), map.calls.map, map.calls.ran, map.calls.said]).toEqual([{ termOpen: true, chatOpen: true, mapOpen: false }, 1, ['/notes'], []])
    const plain = handRig()
    plain.h.type('/grep hum')
    expect([plain.h.state().termOpen, plain.calls.map, plain.calls.ran]).toEqual([true, 0, ['/grep hum']])
    const knelt = handRig({ kneel: { st: { id: 'b' } } })
    knelt.h.type('/term')
    expect([knelt.h.state(), knelt.calls.said, knelt.calls.ran]).toEqual([{ termOpen: false, chatOpen: false, mapOpen: false }, [TERM.NOT_STANDING], []])
    const lying = handRig({ down: { st: 'down' } })
    lying.h.type('/pages')
    expect(lying.calls.said).toEqual([TERM.NOT_STANDING])                  // said once, by openTerm
  })
  it('` never repeats as a key; the touch line opens it with /term, which the placeholder names', () => {
    expect(read('../src/renderer/input.js')).toMatch(/const NO_REPEAT {2}= new Set\(\[[^\]]*'Backquote'[^\]]*\]\)/)
    // /term first in the brackets: a phone's line (the full width at 14 px mono) shows some forty characters of it
    expect(html).toContain('placeholder="say something…  (' + TERM_CHROME.CHAT_PLACEHOLDER + 'Enter sends · Esc cancels · /me to emote · /recover · /cases · /file … · /intake · /status · /invite)"')
    expect(('say something…  (' + TERM_CHROME.CHAT_PLACEHOLDER).length).toBeLessThan(39)
    expect(html).toMatch(/<span>b beacon<\/span> · <span>` terminal<\/span><\/div>/)
    expect(html).toContain('<span>' + TERM_CHROME.HINT_SPAN + '</span>')
    expect(html.indexOf('<span>' + TERM_CHROME.HINT_SPAN + '</span>')).toBeGreaterThan(html.indexOf('<span>b beacon</span>'))
  })
  it('the panel is written once, after the line, with its keep-above rule for the building\'s line and its touch placement', () => {
    expect(html.split('<div id="term" ').length - 1).toBe(1)
    expect(html.indexOf('<div id="term" ')).toBeGreaterThan(html.indexOf('<input id="chat-input"'))
    const input = html.match(/<input id="term-input"[^>]*>/)[0]
    for (const a of ['maxlength="120"', 'spellcheck="false"', 'autocapitalize="off"', 'autocomplete="off"', 'autocorrect="off"', 'enterkeyhint="go"', 'aria-labelledby="term-title"'])
      expect(input, a).toContain(a)
    expect(html.match(/<input id="chat-input"[^>]*>/)[0]).toContain('autocorrect="off"')   // (it carries /file too: an answer is never 'corrected')
    // the building's line over the panel's layer, and off the panel itself: left of it on a desktop, under it on touch
    expect(html).toContain('body.term-open #msg { z-index: 62; left: calc((100vw - min(560px, 46vw) - 32px) / 2); max-width: min(640px, calc(100vw - min(560px, 46vw) - 64px)); }')
    expect(html).toContain('@media (pointer: coarse) { body.term-open #msg { left: 50%; max-width: min(92vw, 640px); top: calc(max(12px, env(safe-area-inset-top)) + 42vh + 10px); } }')
    expect(html).toMatch(/#term \{\s*position: fixed; right: 16px; bottom: 150px; width: min\(560px, 46vw\); max-height: 52vh; z-index: 61;/)
    expect(html).toContain('@media (pointer: coarse) { #term { top: max(12px, env(safe-area-inset-top)); left: max(16px, env(safe-area-inset-left)); right: max(16px, env(safe-area-inset-right)); bottom: auto; width: auto; max-height: 42vh; } }')
    expect(html).toContain('@media (pointer: coarse) { #term-close { padding: 12px 10px; margin: -12px -10px; } }')
    expect(html).toContain('@media (pointer: coarse) { #term-input, #chat-input { font-size: 16px; } }')   // (a phone zooms into a field under 16 px)
    expect(html).toMatch(/#term-out \{[^}]*overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y;[^}]*white-space: pre-wrap; overflow-wrap: anywhere;/)
    expect(html).not.toMatch(/term-caret|#term-input:focus \{ animation/)            // the system's caret blinks; no second blink over it
    expect(html).toContain('<div id="term-head"><span id="term-title"></span><button id="term-close" type="button"></button></div>')
    // Forget, in the 'your file' row, through its own event
    const row = html.slice(html.indexOf('<div id="file-row"'), html.indexOf('<div id="locate-row"'))
    expect(row).toContain('<button id="btn-term-forget" aria-describedby="term-forget-hint"></button>')
    expect(row).toContain('<div id="term-forget-hint" class="set-hint" aria-live="polite"></div>')
    // the button keeps the focus (a second Enter confirms); the game ignores a press the hidden panel could not have seen
    expect(html).toContain("document.getElementById('btn-term-forget').onclick = () => document.dispatchEvent(new CustomEvent('backrooms:term-forget'))")
    expect(count(/document\.addEventListener\('backrooms:term-forget'/g)).toBe(1)
  })
})

describe('the filing, through the one gate (lifted and replayed with the real seal and the real gate)', () => {
  const V = JSON.parse(read('./fixtures/recover-seal-v1.json'))
  const plain = (maze = null) => ({ id: V.manifest.id, title: 'the made-up case', stations: V.manifest.stations.map((s, i) => ({ id: s.id, title: 'no. ' + s.id, gate: s.gate,
    onSolve: V.notes[s.id], ...(i === 1 && maze ? { maze } : {}) })), reward: V.reward })
  function fileRig({ m = plain(), floor = 1, map = null, onSleep = null, sealOver = null } = {}) {
    const store = new Map(), seal = createSeal({ storage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) } })
    const said = [], timers = [], clock = { t: 1000 }
    const gate = createFilingGate()
    const level = { index: floor, cfg: { map } }
    const fn = new Function('filingGate', 'performance', 'showMessage', 'TERM', 'loadCase', 'rSolved', 'recoverSeal', 'sleep', 'blip', 'level', 'mazeFloors', 'setTimeout',
      `${lift(FILE_NEXT)}\nreturn fileNext`)(gate, { now: () => clock.t }, (x) => said.push(x), TERM, async () => m, (c, s) => seal.isSolved(c, s), sealOver ? sealOver(seal) : seal,
      async (ms) => { clock.t += ms; if (onSleep) onSleep(level) }, () => {}, level, mazeFloors, (f, ms) => timers.push([f, ms]))
    return { fn, said, timers, clock, seal, store, gate, m, level }
  }
  it('a miss: the reading line, then — no sooner than the floor — the one wrong-answer line; the answer is never said or stored', async () => {
    const r = fileRig()
    await r.fn(V.wrong.first)
    expect(r.said).toEqual([TERM.FILE_READING, 'the file does not answer to that.'])
    expect(r.clock.t).toBe(2500)                                           // the floor: 1.5 s from the ask
    expect([...r.store.values()].join('|')).not.toContain(V.wrong.first)
    expect(r.said.join('|')).not.toContain(V.wrong.first)
  })
  it('the back-off: a filing inside the wait says the office takes none yet, whatever was typed; the reply never varies by guess', async () => {
    const r = fileRig()
    await r.fn(V.wrong.first)
    r.said.length = 0
    await r.fn(V.answers.first)                                            // the right answer, inside the wait: refused the same
    await r.fn('anything at all')
    expect(r.said).toEqual([TERM.FILE_WAIT, TERM.FILE_WAIT])
    expect(r.seal.isSolved(r.m.id, 'first')).toBe(false)
    r.clock.t += 4000
    r.said.length = 0
    await r.fn(V.typed.first)
    expect(r.said[0]).toBe(TERM.FILE_READING)
    expect(r.said[1]).toBe('filed. no. first — read. ' + V.notes.first)
    expect(r.seal.isSolved(r.m.id, 'first')).toBe(true)
  })
  it('a hit from the terminal on the floor the instrument names: the honour flag and its line; from the line, or another floor, or the block, never', async () => {
    const maze = { levels: [2, 3], hint: 'the deep stacks.' }
    const go = async (o, viaTerm) => {
      const r = fileRig({ m: plain(maze), ...o })
      await r.fn(V.answers.first, { viaTerm }); r.clock.t += 1e6
      await r.fn(V.answers.second, { viaTerm })
      return [r.seal.honoured(r.m.id, 'second'), r.said.includes(TERM.FILE_HONOUR), r.seal.honoured(r.m.id, 'first')]
    }
    expect(await go({ floor: 2 }, true)).toEqual([true, true, false])
    expect(await go({ floor: 3 }, true)).toEqual([true, true, false])
    expect(await go({ floor: 2 }, false)).toEqual([false, false, false])
    expect(await go({ floor: 1 }, true)).toEqual([false, false, false])
    expect(await go({ floor: 4, map: { cells: [] } }, true)).toEqual([false, false, false])
  })
  it('the honour is judged on the floor it was filed from, taken at the ask: a way taken while the office reads changes nothing', async () => {
    const maze = { levels: [2, 3], hint: 'the deep stacks.' }
    const go = async (from, to) => {
      const r = fileRig({ m: plain(maze), floor: from, onSleep: (lv) => { lv.index = to; lv.cfg.map = to === 4 ? { cells: [] } : null } })
      await r.fn(V.answers.first, { viaTerm: true }); r.clock.t += 1e6
      r.level.index = from; r.level.cfg.map = null                       // back where the second is filed from
      await r.fn(V.answers.second, { viaTerm: true })                     // ... and through a way while the office reads it
      return [r.seal.honoured(r.m.id, 'second'), r.said.includes(TERM.FILE_HONOUR), r.level.index]
    }
    expect(await go(1, 2)).toEqual([false, false, 2])                     // filed off its floors, arrived on one: not honoured
    expect(await go(2, 1)).toEqual([true, true, 1])                       // filed on its floor, arrived off them: still filed from its floor
    expect(await go(3, 4)).toEqual([true, true, 4])                       // and the block under the answer changes nothing either
  })
  it('a hit this machine could not keep the key of: the key\'s line rides on the filed line, so the queue never drops the note', async () => {
    const r = fileRig({ sealOver: (seal) => ({ ...seal, fileAnswer: async (...a) => ({ ...(await seal.fileAnswer(...a)), kept: false }) }) })
    await r.fn(V.answers.first)
    expect(r.said).toEqual([TERM.FILE_READING, 'filed. no. first — read. ' + V.notes.first + '\n' + TERM.FILE_NOKEY])
    // through the real queue, behind the reading line: the honoured filing's two results both show, the note first
    const q = createMessageQueue()
    q.push(TERM.FILE_READING, PRIO.interaction); q.tick(0); q.tick(1.5)
    const results = [r.said[1], TERM.FILE_HONOUR]
    for (const t of results) q.push(t, PRIO.interaction)
    const shown = []
    for (let i = 0; i < 40; i++) { const x = q.tick(0.25); if (x && x.show) shown.push(x.text) }
    expect(shown).toEqual(results)
  })
  it('the case closed: its line in place of the closing key, which the HUD never says now; then the case is already read, the gate let go', async () => {
    const r = fileRig()
    for (const id of ['first', 'second', 'third']) { await r.fn(V.answers[id]); r.clock.t += 1e6 }
    expect(r.timers.map(([, ms]) => ms)).toEqual([3000])
    r.timers[0][0]()
    expect(r.said[r.said.length - 1]).toBe(TERM.CASE_CLOSED)
    expect(r.said.join('|')).not.toContain(V.reward.key)
    r.said.length = 0
    await r.fn('more')
    await r.fn('more')
    expect(r.said).toEqual([TERM.FILE_READING, 'the case is already read.', TERM.FILE_READING, 'the case is already read.'])
  })
  it('no answer: the line asks for one and the gate is not asked; a manifest that will not load lets the gate go', async () => {
    const r = fileRig()
    await r.fn('')
    expect(r.said).toEqual(['file what? /file <answer>'])
    const broken = fileRig()
    const fn = new Function('filingGate', 'performance', 'showMessage', 'TERM', 'loadCase', 'rSolved', 'recoverSeal', 'sleep', 'blip', 'level', 'mazeFloors', 'setTimeout',
      `${lift(FILE_NEXT)}\nreturn fileNext`)(broken.gate, { now: () => 0 }, () => {}, TERM, async () => { throw new TypeError('no signal') }, () => false, broken.seal, async () => {}, () => {}, { index: 0, cfg: {} }, mazeFloors, () => {})
    await expect(fn('x')).rejects.toThrow('no signal')
    expect(broken.gate.ask(0)).toEqual({ ok: true })
  })
  it('the line\'s /file is the same filing; the old salt, hash and normalize copies are gone; the closing key is read only in the case review', () => {
    expect(slice('async function handleCommand(t) {', '// desktop: a fetch that never reached the site')).toMatch(/\} else if \(cmd === 'file'\) \{\r?\n\s*await fileNext\(arg, \{ viaTerm: false \}\)/)
    expect(game).toContain("async function termFile(arg) { try { await fileNext(arg, { viaTerm: true }) } catch (e) { consoleFailed(e) } }")
    const f = lift(FILE_NEXT)
    for (const s of ['filingGate.ask(performance.now())', 'recoverSeal.fileAnswer(m, next, arg)', 'recoverSeal.openStation(m, next)', 'filingGate.settle(r.ok, performance.now())'])
      expect(f, s).toContain(s)
    expect(game).not.toMatch(/RECOVER_SALT|rHash|rNorm/)
    expect(game).not.toMatch(/reward\.key|closing\.reward|\.reward && /)
    expect(terminal).toMatch(/if \(w\.key\) rows\.push\(row\(w\.key, 't-page'\)\)/)
    expect(count(/the file does not answer to that\./g)).toBe(1)
  })
})

describe('the terminal\'s line (runTerm, lifted and replayed)', () => {
  function runRig() {
    const printed = [], calls = []
    const termHistory = createHistory()
    const fn = new Function('parseTermLine', 'termHistory', 'runTermLine', 'termView', 'term', 'closeTerm', 'handleCommand', 'notesFor', 'termFile', 'whereCase', 'casebook', 'jotRows', 'strikeRows',
      `${lift(RUN)}\nreturn runTerm`)(parseTermLine, termHistory, runTermLine,
      () => ({ book: { pages: [], souls: [], drawers: [], thread: 0, caches: [], sights: [], dens: [], margin: [] }, redacted: [], radio: { mask: 0, groups: [], ledgerHeard: false }, photoIdx: 0, floorNames: [] }),
      { print: (r) => printed.push(...r), clear: () => calls.push('clear') }, () => calls.push('close'), (t) => calls.push(['pass', t]), (a) => calls.push(['notes', a]),
      (a) => calls.push(['file', a]), () => calls.push('where'), { jot: (a) => { calls.push(['jot', a]); return 'ok' }, strike: () => false }, jotRows, strikeRows)
    return { fn, printed, calls, termHistory }
  }
  it('a filing goes to termFile with its answer, never into the scrollback or the history', () => {
    const r = runRig()
    r.fn('file The Ledger'); r.fn('/FILE  paper weight')
    expect(r.calls).toEqual([['file', 'The Ledger'], ['file', 'paper weight']])
    expect(r.printed.map((x) => x.t)).toEqual([TERM_CHROME.ECHO_FILE, TERM_CHROME.ECHO_FILE])
    expect(r.termHistory.size()).toBe(0)
  })
  it('the line\'s words pass to the console (the form folds the terminal first); jot, clear and exit run here', () => {
    const r = runRig()
    r.fn('status'); r.fn('recover d8'); r.fn('intake'); r.fn('jot a line'); r.fn('clear'); r.fn('exit'); r.fn('notes s37'); r.fn('   ')
    expect(r.calls).toEqual([['pass', '/status'], ['pass', '/recover d8'], 'close', ['pass', '/intake'], ['jot', 'a line'], 'clear', 'close', ['notes', 's37']])
    expect(r.printed.map((x) => x.t)).toContain(TERM.JOT_OK)
    expect(r.termHistory.size()).toBe(7)
    r.calls.length = 0
    r.fn('intake my amendment')                                            // no card follows an amendment: the terminal stays up for its refusal
    expect(r.calls).toEqual([['pass', '/intake my amendment']])
  })
})

describe('the log, the scrollback\'s copy and the radio', () => {
  it('after the pinned #msg write, once per line shown: the record\'s said finds, then the log (never on the block) and the copy while it is up, both through loggable', () => {
    const pinned = "if (mq && msgEl) { if (mq.show) { msgEl.textContent = mq.text; msgEl.style.opacity = '1' } else msgEl.style.opacity = '0' }"
    const mine = 'if (mq && mq.show) { keepShown(mq.text); if (loggable(mq.text, pinText)) { if (!level.cfg.map) logRing.push(mq.text); if (termOpen) term.mirror(mq.text) } }'
    expect(loopBody.indexOf(mine)).toBeGreaterThan(loopBody.indexOf(pinned))
    expect(loopBody.split(mine).length - 1).toBe(1)
    expect(count(/logRing\.push\(/g)).toBe(1); expect(count(/term\.mirror\(/g)).toBe(1)
    expect(game).toContain('const pinText = anchor ? formatAnchor(anchor) : null')
  })
  // keepShown, lifted with its tables and run against the real casebook: what the screen showed, and only that, goes in
  const SHOWN = /function keepShown\(text\) \{[\s\S]*?\r?\n {2}\}/
  const TABLES = lift(/const DRAWER_OF = new Map\(\)\r?\nDRAWER_NOTES\.forEach[^\n]*\r?\nconst RADIO_OF = ledgerLines\(RADIO_GROUPS\)/)
  function shownRig({ map = null, at = 'a' } = {}) {
    const bounds = { pages: 26, souls: [12], drawers: DRAWER_NOTES.length, phrases: 8, sights: [], kinds: [], floors: 4, thread: 3 }
    const firsts = []
    const casebook = createCasebook({ storage: null, bounds, onFirst: () => firsts.push(1), setTimer: () => 1, clearTimer() {} })
    const file = { at }, level = { index: 2, cfg: { map } }, step = { n: 0 }
    const h = new Function('DRAWER_NOTES', 'RADIO_GROUPS', 'ledgerLines', 'casebook', 'level', 'file', 'SOUL_OF', 'firstRun', `${TABLES}
      let heardMask = 0, heardAt = file.at, threadAt = 0
      ${lift(/function noteHeard\(i\) \{[^\n]*\}/)}
      ${lift(/function keepThread\(\) \{[^\n]*\}/)}
      ${lift(SHOWN)}
      return { keepShown, keepThread, mask: () => (heardAt === file.at ? heardMask : 0), forgot() { threadAt = firstRun.step() }, RADIO_OF, DRAWER_OF }`)(
      DRAWER_NOTES, RADIO_GROUPS, ledgerLines, casebook, level, file, new Map(), { step: () => step.n })
    return { h, casebook, file, level, step, firsts }
  }
  const groupLine = (i) => radioLine({ on: true, mode: 'ledger', stationIdx: i, groups: RADIO_GROUPS, rules: { radio: () => ({}) } }).message
  it('the radio\'s bit is set as its group\'s line shows, under the file it was heard under (readRadio and the radio branch untouched)', () => {
    expect(slice("} else if (eff.type === 'radio') {", "} else if (eff.type === 'plumb') {")).not.toMatch(/noteHeard|casebook/)
    expect(RADIO_GROUPS.map((g, i) => groupLine(i))[0]).toBe(`the station counts, slow and patient: ${RADIO_GROUPS[0]} …   [1/4]`)
    expect([...ledgerLines(RADIO_GROUPS)]).toEqual(RADIO_GROUPS.map((g, i) => [groupLine(i), i]))   // the radio's own lines, all four
    expect(count(/radioLine\(/g)).toBe(1)                                  // (the seam stays one call: factions-wiring)
    const r = shownRig()
    expect([...r.h.RADIO_OF.values()]).toEqual([0, 1, 2, 3])
    r.h.keepShown('the radio crackles to life.'); expect(r.h.mask()).toBe(0)
    r.h.keepShown(groupLine(0)); r.h.keepShown(groupLine(2)); expect(r.h.mask()).toBe(5)
    r.level.cfg.map = { cells: [] }                                       // the block: the mask is not the record, a group heard there counts
    r.h.keepShown(groupLine(3)); expect(r.h.mask()).toBe(13)
    r.file.at = 'b'                                                       // a new filing: the station starts over, the mask with it
    expect(r.h.mask()).toBe(0)
    r.h.keepShown(groupLine(1)); expect(r.h.mask()).toBe(2)
    expect(game).toContain("radio: { mask: heardAt === file.at ? heardMask : 0, groups: RADIO_GROUPS, ledgerHeard: file.ledgerHeard === true }")
  })
  it('a group or a drawer\'s note the queue dropped is never kept: behind a combat line only the last two of three show, and only they go in', () => {
    const r = shownRig()
    const q = createMessageQueue()
    q.push('it has you.', PRIO.combat)
    for (const i of [0, 1, 2]) q.push(groupLine(i), PRIO.interaction)
    q.push(DRAWER_NOTES[4], PRIO.interaction)                             // the drawer's note pushes the oldest waiting group out too
    for (let i = 0; i < 80; i++) { const x = q.tick(0.25); if (x && x.show) r.h.keepShown(x.text) }
    expect(r.h.mask()).toBe(1 << 2)
    expect(r.casebook.view().drawers).toEqual([{ i: 4, lv: 2 }])
    const blk = shownRig({ map: { cells: [] } })
    blk.h.keepShown(DRAWER_NOTES[1])
    expect(blk.casebook.view().drawers).toEqual([])                       // the block keeps nothing
    // a note, a soul's line and a group never share a text, so one shown line is never two finds (the souls' own lines are game.js's)
    for (const t of DRAWER_NOTES) { expect(r.h.RADIO_OF.has(t), t).toBe(false); expect(game.includes(t), t).toBe(false) }
  })
  it('Forget clears the thread for the session: the next line shown writes no step back, says no first-find line, and voices stays locked', () => {
    const r = shownRig()
    r.step.n = 2
    r.h.keepShown('a line.')
    expect([r.casebook.view().thread, r.firsts.length]).toEqual([2, 1])
    r.casebook.forget(); r.h.forgot()                                    // the game's Forget: casebook.forget(); threadAt = firstRun.step()
    for (let i = 0; i < 5; i++) { r.h.keepShown('another line.'); r.h.keepThread() }
    expect([r.casebook.view().thread, r.firsts.length]).toEqual([0, 1])
    r.step.n = 3                                                          // a step taken after it goes in, and is the first find again
    r.h.keepShown('a later line.')
    expect([r.casebook.view().thread, r.firsts.length]).toEqual([3, 2])
    const fg = slice("document.addEventListener('backrooms:term-forget', () => {", "document.addEventListener('backrooms:new-notice'")
    expect(fg).toContain('casebook.forget(); threadAt = firstRun.step();')
    expect(fg.indexOf('if (settingsHidden()) {')).toBeGreaterThan(0)
    expect(fg.indexOf('if (settingsHidden()) {')).toBeLessThan(fg.indexOf('casebook.forget()'))
    expect(fg).toContain('renderForget(TERM_CHROME.SETTINGS_FORGET_AGAIN, TERM_CHROME.SETTINGS_FORGET_HINT)')
  })
})

describe('the record\'s event sites', () => {
  it('every find goes in only off the block, at its event; nothing writes the record or stringifies in the frame', () => {
    const calls = game.match(/[^\n]*casebook\.(page|soul|drawer|thread|cache|sight|den)\([^\n]*/g)
    expect(calls.length).toBeGreaterThanOrEqual(7)
    for (const c of calls) expect(c, c).toMatch(/!level\.cfg\.map/)
    // keepShown: the radio's mask first (any floor), then nothing more on the block, before any record call
    const shown = lift(/function keepShown\(text\) \{[\s\S]*?\r?\n {2}\}/)
    expect(shown).toMatch(/^function keepShown\(text\) \{\r?\n\s*const rk = RADIO_OF\.get\(text\)\r?\n\s*if \(rk !== undefined\) noteHeard\(rk\)\r?\n\s*if \(level\.cfg\.map\) return/)
    expect(shown.indexOf('if (level.cfg.map) return')).toBeLessThan(shown.indexOf('casebook.'))
    expect(loopBody).not.toMatch(/casebook\.flush|JSON\.stringify|casebook\.toJSON/)
    expect(count(/casebook\.flush\(\)/g)).toBe(2)                           // beforeunload, pagehide
    expect(game).toContain("window.addEventListener('beforeunload', () => casebook.flush())")
    expect(game).toContain('casebook.seed([...readSet])')
    expect(slice('function revealScrap() {', 'function redactScrap() {')).toContain('if (!level.cfg.map) casebook.page(scrap.frag, level.index)')
    // a drawer's note goes in as it shows (keepShown), never as it is pushed: the queue can drop it, and the drawer is searched for good
    expect(slice('function resolveSearch(p) {', '// ── the hauntings')).not.toMatch(/casebook/)
    expect(shown).toContain('if (dk !== undefined && !level.cfg.map) casebook.drawer(dk, level.index)')
  })
  it('the save never carries the record', () => {
    expect(slice('function snapshot(full = false) {', 'let saveTimer = 0')).not.toMatch(/casebook|margin|heardMask/)
  })
})

describe('reach', () => {
  it('nothing new on the wire: no client, no chat, no typing, no bus, no relay in the terminal\'s block, its modules or its sites', () => {
    const block = slice('// ── filing (the line\'s /file and the terminal\'s file)', '  if (mpClient) {') + slice("// the field terminal's Forget", "document.addEventListener('backrooms:new-notice'")
    for (const src of [block, terminal, casebookSrc]) expect(src).not.toMatch(/mpClient|sendChat|sendTyping|\bbus\.|bus\?\.|relayLater|fetch\(/)
  })
  it('the two new modules are in both offline shells', () => {
    for (const f of ['casebook.js', 'terminal.js', 'recover-seal.js']) { expect(sw).toContain(`'/renderer/${f}'`); expect(build).toContain(`'${f}'`) }
  })
})
