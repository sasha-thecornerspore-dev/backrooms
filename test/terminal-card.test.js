// The field terminal's card (terminal.js createTermCard) over a fake document, the mapcard.test.js way: the labels from the table, rows
// by textContent only and at most 120, every key kept from the game, Enter / Esc / ` / Tab / the arrows, and how a press folds it.
import { describe, it, expect } from 'vitest'
import { createTermCard, TERM_CHROME, MAX_ROWS } from '../src/renderer/terminal.js'

function fakeDoc(withTerm = true) {
  const els = {}, docListeners = {}
  const mk = (id, tag = 'div') => {
    const e = { id, tag, style: {}, textContent: '', value: '', placeholder: '', className: '', children: [], listeners: {}, parent: null,
      scrollTop: 0, scrollHeight: 0, clientHeight: 100, focused: false,
      addEventListener(t, fn) { this.listeners[t] = fn },
      appendChild(c) { c.parent = this; this.children.push(c); this.scrollHeight = this.children.length * 20; return c },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parent = null; return c },
      contains(x) { for (let n = x; n; n = n.parent) if (n === this) return true; return false },
      focus() { this.focused = true }, blur() { this.focused = false } }
    Object.defineProperty(e, 'innerHTML', { set() { throw new Error('innerHTML is never written') } })
    if (id) els[id] = e
    return e
  }
  if (withTerm) {
    const term = mk('term'), head = mk('term-head'), row = mk('term-row')
    for (const [p, c] of [[term, head], [head, mk('term-title')], [head, mk('term-close')], [term, mk('term-out')], [term, row], [row, mk('term-prompt')], [row, mk('term-input', 'input')]]) p.appendChild(c)
  }
  const outside = mk('canvas')
  return { els, outside, docListeners, getElementById: (id) => els[id] ?? null, createElement: (tag) => mk(null, tag),
    addEventListener(t, fn) { docListeners[t] = fn } }
}
const key = (code, extra = {}) => {
  const e = { code, key: extra.key ?? code, repeat: false, isComposing: false, stopped: false, prevented: false, ...extra }
  e.stopPropagation = () => { e.stopped = true }; e.preventDefault = () => { e.prevented = true }
  return e
}
function rig(o = {}) {
  const doc = fakeDoc(), got = { submit: [], close: 0, tab: [], hist: [] }
  const card = createTermCard(doc, { onSubmit: (v) => got.submit.push(v), onClose: () => got.close++, onTab: (v) => { got.tab.push(v); return o.tab ?? null },
    onHistory: (d) => { got.hist.push(d); return o.hist ?? null } })
  const input = doc.els['term-input'], out = doc.els['term-out']
  const press = (code, extra) => { const e = key(code, extra); input.listeners.keydown(e); return e }
  return { doc, card, got, input, out, press }
}

describe('createTermCard', () => {
  it('a page without #term gets a no-op card', () => {
    const card = createTermCard(fakeDoc(false), {})
    expect(card.ok).toBe(false)
    expect(() => { card.open('x'); card.print([{ t: 'a', cls: 't-out' }]); card.mirror('b'); card.clear(); card.setPrompt('p'); card.focus(); card.close() }).not.toThrow()
    expect(card.isOpen()).toBe(false)
    expect(createTermCard(null, {}).ok).toBe(false)
  })
  it('writes its labels from the table, opens with the prompt and the input focused, closes', () => {
    const { doc, card, input } = rig()
    expect(doc.els['term-title'].textContent).toBe(TERM_CHROME.TITLE)
    expect(doc.els['term-close'].textContent).toBe(TERM_CHROME.CLOSE_HINT)
    // the hint names a hand's own ways: a coarse pointer has no Esc and no `; a page that cannot ask gets the keyboard's
    const touch = fakeDoc(); touch.defaultView = { matchMedia: (q) => ({ matches: q === '(pointer: coarse)' }) }
    createTermCard(touch, {})
    expect(touch.els['term-close'].textContent).toBe(TERM_CHROME.CLOSE_HINT_TOUCH)
    expect(TERM_CHROME.CLOSE_HINT).not.toMatch(/tap/); expect(TERM_CHROME.CLOSE_HINT_TOUCH).not.toMatch(/esc|`/)
    const odd = fakeDoc(); odd.defaultView = { matchMedia: () => { throw new Error('no') } }
    createTermCard(odd, {})
    expect(odd.els['term-close'].textContent).toBe(TERM_CHROME.CLOSE_HINT)
    expect(input.placeholder).toBe(TERM_CHROME.PLACEHOLDER)
    card.open('pipe dreams ›')
    expect([doc.els.term.style.display, doc.els['term-prompt'].textContent, input.focused, card.isOpen()]).toEqual(['flex', 'pipe dreams ›', true, true])
    card.setPrompt('the lobby ›'); expect(doc.els['term-prompt'].textContent).toBe('the lobby ›')
    card.close()
    expect([doc.els.term.style.display, input.focused, card.isOpen()]).toEqual(['none', false, false])
  })
  it('rows by textContent only, with their class; never more than 120; clear empties it', () => {
    const { card, out } = rig()
    card.print([{ t: '<b>not markup</b>', cls: 't-page' }, { t: 'plain', cls: 't-out' }])
    expect(out.children.map((c) => [c.textContent, c.className])).toEqual([['<b>not markup</b>', 't-page'], ['plain', 't-out']])
    card.mirror('it has you.')
    expect(out.children[2]).toMatchObject({ textContent: 'it has you.', className: 't-sys' })
    for (let i = 0; i < 300; i++) card.print([{ t: 'row ' + i, cls: 't-out' }])
    expect(out.children).toHaveLength(MAX_ROWS)
    expect(MAX_ROWS).toBe(120)
    expect(out.children[MAX_ROWS - 1].textContent).toBe('row 299')
    card.print([]); card.print(null)
    expect(out.children).toHaveLength(MAX_ROWS)
    card.clear()
    expect(out.children).toHaveLength(0)
  })
  it('every key stops at the input; Enter submits the line and clears it (a phone\'s enter too)', () => {
    const { got, input, press } = rig()
    for (const c of ['KeyW', 'KeyA', 'Space', 'KeyE', 'KeyF', 'Digit1', 'KeyM', 'ShiftLeft', 'Tab', 'Enter', 'Escape', 'Backquote', 'ArrowUp', 'PageDown'])
      expect(press(c).stopped, c).toBe(true)
    got.submit.length = 0
    input.value = 'pages'
    const e = press('Enter')
    expect([got.submit, input.value, e.prevented]).toEqual([['pages'], '', true])
    input.value = 'help'; press('', { key: 'Enter' })
    expect(got.submit[got.submit.length - 1]).toBe('help')
    input.value = 'radio'; press('', { key: 'Enter', isComposing: true })
    expect(got.submit[got.submit.length - 1]).toBe('help')
  })
  it('an IME keeps its keys: Enter and Esc while composing (or the 229 of a composition\'s commit) neither submit nor fold', () => {
    const { got, input, press } = rig()
    input.value = 'ねこ'
    for (const e of [press('Enter', { isComposing: true }), press('Enter', { keyCode: 229 }), press('Escape', { isComposing: true }), press('Escape', { keyCode: 229 })])
      expect([e.stopped, e.prevented]).toEqual([true, false])
    expect([got.submit, got.close, input.value]).toEqual([[], 0, 'ねこ'])
    press('Enter', { keyCode: 13 })
    expect(got.submit).toEqual(['ねこ'])
  })
  it('Esc and ` close, with preventDefault (no ` typed); a held key does not close again; Tab calls onTab and takes its line', () => {
    const r = rig({ tab: 'floors ' })
    const a = r.press('Escape'), b = r.press('Backquote'), c = r.press('Backquote', { repeat: true })
    expect([a.prevented, b.prevented, c.prevented, r.got.close]).toEqual([true, true, true, 2])
    r.input.value = 'fl'
    const t = r.press('Tab')
    expect([t.prevented, r.got.tab, r.input.value]).toEqual([true, ['fl'], 'floors '])
    const n = rig({ tab: null }); n.input.value = 'zz'; n.press('Tab')
    expect(n.input.value).toBe('zz')
  })
  it('the arrows walk the history through onHistory; PageUp / PageDown scroll the scrollback', () => {
    const r = rig({ hist: 'jot a line' })
    r.press('ArrowUp'); r.press('ArrowDown')
    expect([r.got.hist, r.input.value]).toEqual([[-1, 1], 'jot a line'])
    r.out.scrollTop = 500
    r.press('PageUp'); expect(r.out.scrollTop).toBe(410)
    r.press('PageDown'); expect(r.out.scrollTop).toBe(500)
  })
  it('a mouse press outside folds it, a touch press does not, nor a press inside; the header hint folds it, touch or mouse', () => {
    const r = rig()
    const down = r.doc.docListeners.pointerdown
    down({ pointerType: 'mouse', target: r.doc.outside })
    expect(r.got.close).toBe(0)                                    // not open yet
    r.card.open('p')
    down({ pointerType: 'touch', target: r.doc.outside })
    down({ pointerType: 'mouse', target: r.doc.els['term-out'] })
    down({ pointerType: 'mouse', target: r.input })
    expect(r.got.close).toBe(0)
    down({ pointerType: 'mouse', target: r.doc.outside })
    expect(r.got.close).toBe(1)
    const ev = { preventDefault() {}, stopPropagation() {} }
    r.doc.els['term-close'].listeners.pointerdown(ev)
    expect(r.got.close).toBe(2)
    // a button: Enter or Space on it (a click no pointer made, detail 0) folds it; a pointer's own click was its pointerdown
    r.doc.els['term-close'].listeners.click({ detail: 1 })
    expect(r.got.close).toBe(2)
    r.doc.els['term-close'].listeners.click({ detail: 0 })
    expect(r.got.close).toBe(3)
  })
  it('a click in the panel that selects nothing gives the keys back to the input; a selection is left alone', () => {
    const r = rig()
    let selected = ''
    r.doc.getSelection = () => ({ toString: () => selected })
    r.card.open('p'); r.input.blur()
    r.doc.els.term.listeners.pointerup({ target: r.out })
    expect(r.input.focused).toBe(true)
    r.input.blur(); selected = 'a copied line'
    r.doc.els.term.listeners.pointerup({ target: r.out })
    expect(r.input.focused).toBe(false)
  })
  it('the scrollback keeps to the bottom unless it was scrolled up; a line typed brings it back down', () => {
    const r = rig()
    for (let i = 0; i < 20; i++) r.card.print([{ t: 'row ' + i }])
    expect(r.out.scrollTop).toBe(r.out.scrollHeight)
    r.out.scrollTop = 0; r.out.listeners.scroll()                  // the player scrolled up
    r.card.print([{ t: 'c' }]); r.card.mirror('a line the building said.')
    expect(r.out.scrollTop).toBe(0)                                // a copied line or a late reply does not pull the view down
    r.input.value = 'read the-carpet'
    const card = r.card
    r.press('Enter')
    expect(r.out.scrollTop).toBe(r.out.scrollHeight)               // Enter: to the foot, before the rows print
    card.print([{ t: '› read the-carpet', cls: 't-in' }, { t: 'the page.', cls: 't-page' }])
    expect(r.out.scrollTop).toBe(r.out.scrollHeight)               // and the rows that answer it stay in view
    r.out.scrollTop = 5; r.out.listeners.scroll()                  // scrolled up again; clear and open both go back to the foot
    card.clear(); card.print([{ t: 'x' }])
    expect(r.out.scrollTop).toBe(r.out.scrollHeight)
  })
  it('a print reads the layout to go to the foot only: whether it is at the foot is kept by the scroll events, never read in print', () => {
    const r = rig()
    let reads = 0, top = 0
    Object.defineProperty(r.out, 'scrollTop', { get() { reads++; return top }, set(v) { top = v }, configurable: true })
    Object.defineProperty(r.out, 'clientHeight', { get() { reads++; return 100 }, configurable: true })
    for (let i = 0; i < 5; i++) { r.card.print([{ t: 'row ' + i }]); r.card.mirror('a line.') }
    expect(reads).toBe(0)
    expect(top).toBe(r.out.scrollHeight)
  })
})
