import { describe, it, expect } from 'vitest'
import {
  MODES, CLOSE_KEYS, CARD_KEYS, createCard, chooseLines, readText, setFoot,
  SEALED_TEXT, SEALED_FOOT, SEALED_LINES, REDACTED_FOOT, REFUSE_LINE, READ_FOOT, CHOOSE_NONE, CONFIRM_LINES,
} from '../src/renderer/papercard.js'

const MENU = ['take the left.', 'keep writing.', 'drink it.', 'whistle every minute.', 'i left the lantern.', 'walk in. do not drop in.']
const TAPS = ['tap', 'tapLine:0', 'tapLine:3']
const DIGITS = ['Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6']

describe('constants', () => {
  it('has the six modes in order', () => {
    expect(MODES).toEqual(['page', 'form', 'confirm', 'sealed', 'choose', 'read'])
  })
  it("CLOSE_KEYS reproduce today's close-any-key rule (game.js: Escape/E/F/Space/Enter/NumpadEnter)", () => {
    expect(CLOSE_KEYS).toEqual(['Escape', 'KeyE', 'KeyF', 'Space', 'Enter', 'NumpadEnter'])
  })
  it('CARD_KEYS is CLOSE_KEYS plus X and the digits 0-6 — the set the key block clears while a card is open', () => {
    expect(CARD_KEYS).toEqual([...CLOSE_KEYS, 'KeyX', ...DIGITS])
  })
  it('SEALED_TEXT is five full blocks', () => {
    expect(SEALED_TEXT).toBe('█████')
    expect([...SEALED_TEXT]).toHaveLength(5)
    expect([...SEALED_TEXT].every(ch => ch === '█')).toBe(true)
  })
  it('ships the exact strings', () => {
    expect(SEALED_FOOT).toBe('read it · e      leave it unread · x')
    expect(SEALED_LINES).toEqual(['read it · e', 'leave it unread · x'])
    expect(REDACTED_FOOT).toBe('you do not read it. the file notes that you did not.')
    expect(REFUSE_LINE).toBe('the file already knows you read it.')
    expect(READ_FOOT).toBe('a cache, not a page')
    expect(CHOOSE_NONE).toBe('0 · nothing')
  })
  it('every string is lowercase and understated — no exclamation marks', () => {
    for (const s of [SEALED_FOOT, ...SEALED_LINES, REDACTED_FOOT, REFUSE_LINE, READ_FOOT, CHOOSE_NONE]) {
      expect(s).toBe(s.toLowerCase())
      expect(s).not.toContain('!')
    }
  })
})

describe('chooseLines', () => {
  it("renders '1 · take the left.' … '0 · nothing'", () => {
    const lines = chooseLines(MENU)
    expect(lines).toHaveLength(7)
    expect(lines[0]).toBe('1 · take the left.')
    expect(lines[1]).toBe('2 · keep writing.')
    expect(lines[5]).toBe('6 · walk in. do not drop in.')
    expect(lines[6]).toBe('0 · nothing')
  })
  it('a shorter menu still ends in nothing; an empty one is only nothing', () => {
    expect(chooseLines(['a', 'b'])).toEqual(['1 · a', '2 · b', '0 · nothing'])
    expect(chooseLines([])).toEqual(['0 · nothing'])
    expect(chooseLines()).toEqual(['0 · nothing'])
  })
})

describe('readText', () => {
  it('composes the cache note like one of m.\'s pages, signed, with the reader-relative arrow, under the cache foot', () => {
    const r = readText('ada', 'take the left.', '↖')
    expect(r.foot).toBe(READ_FOOT)
    expect(r.text).toBe('take the left. ↖\n— ada')
  })
  it('omits a missing arrow and a missing signature', () => {
    expect(readText('ada', 'take the left.', '').text).toBe('take the left.\n— ada')
    expect(readText('', 'take the left.', '↖').text).toBe('take the left. ↖')
    expect(readText(null, 'take the left.', null).text).toBe('take the left.')
  })
  it('opens straight into read mode', () => {
    const card = createCard()
    const s = card.open('read', readText('ada', 'take the left.', '↖'))
    expect(s.mode).toBe('read')
    expect(s.text).toBe('take the left. ↖\n— ada')
    expect(s.foot).toBe(READ_FOOT)
  })
})

describe('createCard / open', () => {
  it('starts closed and open() returns the state it also keeps', () => {
    const card = createCard()
    expect(card.state).toBeNull()
    const s = card.open('page', { text: 'day one.', foot: '1 of 26 pages found' })
    expect(card.state).toBe(s)
    expect(s).toMatchObject({ mode: 'page', text: 'day one.', foot: '1 of 26 pages found', lines: [], revealed: false, redacted: false })
  })
  it('rejects an unknown mode', () => {
    expect(() => createCard().open('menu', {})).toThrow()
  })
  it('a plain card has no option lines; confirm, sealed and choose do', () => {
    const card = createCard()
    expect(card.open('form', { text: 'x' }).lines).toEqual([])
    expect(card.open('confirm', { text: 'x' }).lines).toEqual(CONFIRM_LINES)
    expect(card.open('read', { text: 'x' }).lines).toEqual([])
    expect(card.open('sealed', { text: 'x' }).lines).toEqual(SEALED_LINES)
    expect(card.open('choose', { menu: MENU }).lines).toEqual(chooseLines(MENU))
  })
  it('sealed hides the page text behind the blocks and shows the sealed foot', () => {
    const s = createCard().open('sealed', { text: 'day one. i took the wrong door.', foot: '3 of 26 pages found' })
    expect(s.text).toBe(SEALED_TEXT)
    expect(s.foot).toBe(SEALED_FOOT)
    expect(s.hidden).toBe('day one. i took the wrong door.')
    expect(s.revealFoot).toBe('3 of 26 pages found')
  })
  it('a redacted frag reopens as blocks with the redacted foot and no option lines', () => {
    const s = createCard().open('sealed', { text: 'day one.', redacted: true })
    expect(s.text).toBe(SEALED_TEXT)
    expect(s.foot).toBe(REDACTED_FOOT)
    expect(s.redacted).toBe(true)
    expect(s.lines).toEqual([])
  })
  it('keeps the callbacks on the state for the adapter', () => {
    const onPick = () => {}, onConfirm = () => {}, onClose = () => {}
    const s = createCard().open('choose', { menu: MENU, onPick, onConfirm, onClose })
    expect(s.onPick).toBe(onPick)
    expect(s.onConfirm).toBe(onConfirm)
    expect(s.onClose).toBe(onClose)
  })
  it('step on a closed card does nothing', () => {
    const card = createCard()
    expect(card.step(null, 'KeyE')).toEqual({ state: null, action: null })
    expect(card.step(undefined, 'tap')).toEqual({ state: null, action: null })
  })
  it('step keeps card.state in sync and does not mutate the state it was given', () => {
    const card = createCard()
    const s0 = card.open('sealed', { text: 'day one.' })
    const frozen = JSON.stringify(s0)
    const { state: s1 } = card.step(s0, 'KeyE')
    expect(card.state).toBe(s1)
    expect(JSON.stringify(s0)).toBe(frozen)
  })
})

describe('page / form / read', () => {
  for (const mode of ['page', 'form', 'read']) {
    for (const key of [...CLOSE_KEYS, 'tap']) {
      it(`${mode}: ${key} closes`, () => {
        const card = createCard()
        const s = card.open(mode, { text: 'x' })
        const { state, action } = card.step(s, key)
        expect(action).toEqual({ type: 'close' })
        expect(state).toBeNull()
        expect(card.state).toBeNull()
      })
    }
  }
  it('page/form ignore X and the digits and line taps (they belong to sealed/choose)', () => {
    for (const mode of ['page', 'form']) {
      const card = createCard()
      const s = card.open(mode, { text: 'x' })
      for (const key of ['KeyX', ...DIGITS, 'tapLine:0', 'tapLine:5']) {
        const r = card.step(s, key)
        expect(r.action).toBeNull()
        expect(r.state).toBe(s)
      }
    }
  })
  it('read: any key at all closes — X, digits, line taps included', () => {
    for (const key of [...CLOSE_KEYS, 'KeyX', ...DIGITS, ...TAPS]) {
      const card = createCard()
      const s = card.open('read', { text: 'x' })
      expect(card.step(s, key)).toEqual({ state: null, action: { type: 'close' } })
    }
  })
  it('form never produces reveal, redact, refuse or pick', () => {
    const card = createCard()
    const s = card.open('form', { text: 'x' })
    for (const key of [...CARD_KEYS, ...TAPS]) {
      const { action } = card.step(s, key)
      if (action) expect(action.type).toBe('close')
    }
  })
  it('an unknown key is ignored in every mode', () => {
    for (const mode of MODES) {
      const card = createCard()
      const s = card.open(mode, { text: 'x', menu: MENU })
      const r = card.step(s, 'KeyQ')
      expect(r).toEqual({ state: s, action: null })
    }
  })
})

describe('confirm', () => {
  it('Escape → close, confirmed false', () => {
    const card = createCard()
    const s = card.open('confirm', { text: 'ada. is that how it is spelled?', foot: 'e · yes      esc · no' })
    expect(card.step(s, 'Escape')).toEqual({ state: null, action: { type: 'close', confirmed: false } })
  })
  for (const key of ['KeyE', 'KeyF', 'Enter', 'tap']) {
    it(`${key} → close, confirmed true`, () => {
      const card = createCard()
      const s = card.open('confirm', { text: 'x' })
      expect(card.step(s, key)).toEqual({ state: null, action: { type: 'close', confirmed: true } })
    })
  }
  it('is Esc vs anything — every other card key confirms, so touch SPEAK (KeyE) says yes naturally', () => {
    for (const key of [...CARD_KEYS.filter(k => k !== 'Escape'), ...TAPS]) {
      const card = createCard()
      const s = card.open('confirm', { text: 'x' })
      expect(card.step(s, key).action).toEqual({ type: 'close', confirmed: true })
    }
  })
  // F9: touch has no Esc — the spelling card must be declinable by a tap
  it('shows its foot as two tappable lines: tapLine:0 says yes, tapLine:1 says no', () => {
    const card = createCard()
    const s = card.open('confirm', { text: 'adaa. is that how it is spelled?', foot: 'e · yes      esc · no' })
    expect(s.lines).toEqual(['yes · e', 'no · esc'])
    expect(card.step(s, 'tapLine:0')).toEqual({ state: null, action: { type: 'close', confirmed: true } })
    expect(card.step(card.open('confirm', { text: 'x' }), 'tapLine:1')).toEqual({ state: null, action: { type: 'close', confirmed: false } })
    expect(card.state).toBeNull()
  })
})

describe('sealed', () => {
  const open = (opts = {}) => {
    const card = createCard()
    return [card, card.open('sealed', { text: 'day one. i took the wrong door.', foot: '4 of 26 pages found', ...opts })]
  }

  it('E → reveal, and the card is then an ordinary page showing the hidden text', () => {
    const [card, s] = open()
    const { state, action } = card.step(s, 'KeyE')
    expect(action).toEqual({ type: 'reveal' })
    expect(state).not.toBeNull()
    expect(state.mode).toBe('page')
    expect(state.text).toBe('day one. i took the wrong door.')
    expect(state.foot).toBe('4 of 26 pages found')   // the legacy foot the adapter passed in
    expect(state.revealed).toBe(true)
    expect(state.redacted).toBe(false)
    expect(state.lines).toEqual([])
  })
  it('reveal without a foot leaves it empty for the adapter to set', () => {
    const card = createCard()
    const s = card.open('sealed', { text: 'x' })
    const { state } = card.step(s, 'KeyE')
    expect(state.foot).toBe('')
    const s2 = card.setFoot(state, '5 of 26 pages found')
    expect(setFoot(state, 'x').foot).toBe('x')   // the pure form, for anyone without the card
    expect(s2.foot).toBe('5 of 26 pages found')
    expect(s2).not.toBe(state)
    expect(card.state).toBe(s2)
  })
  it('the revealed page closes on any close key like a page', () => {
    const [card, s] = open()
    const { state } = card.step(s, 'KeyE')
    for (const key of [...CLOSE_KEYS, 'tap']) {
      expect(card.step(state, key)).toEqual({ state: null, action: { type: 'close' } })
    }
  })
  it('X → redact: stays open, text stays blocks, foot swaps, option lines go away', () => {
    const [card, s] = open()
    const { state, action } = card.step(s, 'KeyX')
    expect(action).toEqual({ type: 'redact' })
    expect(state.mode).toBe('sealed')
    expect(state.text).toBe(SEALED_TEXT)
    expect(state.foot).toBe(REDACTED_FOOT)
    expect(state.redacted).toBe(true)
    expect(state.revealed).toBe(false)
    expect(state.lines).toEqual([])
    expect(card.state).toBe(state)
  })
  it('X after reveal → refuse, and the card stays open unchanged', () => {
    const [card, s] = open()
    const { state: page } = card.step(s, 'KeyE')
    const { state, action } = card.step(page, 'KeyX')
    expect(action).toEqual({ type: 'refuse', line: REFUSE_LINE })
    expect(state).toBe(page)
    expect(state.revealed).toBe(true)
  })
  it('a second X on a redacted card redacts nothing twice; E then closes it unread (the file has its answer)', () => {
    const [card, s] = open()
    const { state: red } = card.step(s, 'KeyX')
    expect(card.step(red, 'KeyX')).toEqual({ state: red, action: null })
    expect(card.step(red, 'KeyE')).toEqual({ state: null, action: { type: 'close' } })
    expect(card.step(red, 'tapLine:0')).toEqual({ state: null, action: { type: 'close' } })
  })
  it('a reopened redacted frag can never be revealed', () => {
    const [card, s] = open({ redacted: true })
    expect(card.step(s, 'KeyE')).toEqual({ state: null, action: { type: 'close' } })
    expect(card.step(s, 'KeyX')).toEqual({ state: s, action: null })
  })
  for (const key of ['Escape', 'KeyF', 'Space']) {
    it(`${key} → close without redact`, () => {
      const [card, s] = open()
      expect(card.step(s, key)).toEqual({ state: null, action: { type: 'close' } })
    })
  }
  it('Enter and a bare tap do not close a sealed card — the choice is the only way through (the lines stopPropagation)', () => {
    const [card, s] = open()
    for (const key of ['Enter', 'NumpadEnter', 'tap', ...DIGITS]) {
      expect(card.step(s, key)).toEqual({ state: s, action: null })
    }
  })
  it('the two option lines are the two keys: tapLine:0 reveals, tapLine:1 redacts', () => {
    const [card, s] = open()
    expect(card.step(s, 'tapLine:0').action).toEqual({ type: 'reveal' })
    expect(card.step(s, 'tapLine:1').action).toEqual({ type: 'redact' })
    expect(card.step(s, 'tapLine:2')).toEqual({ state: s, action: null })
  })
})

describe('choose', () => {
  const open = (menu = MENU) => {
    const card = createCard()
    return [card, card.open('choose', { text: 'set it down with', menu })]
  }
  it('Digit3 → pick 2', () => {
    const [card, s] = open()
    expect(card.step(s, 'Digit3')).toEqual({ state: null, action: { type: 'pick', pick: 2 } })
  })
  it('Digit1 → pick 0 and Digit6 → pick 5', () => {
    const [card, s] = open()
    expect(card.step(s, 'Digit1').action).toEqual({ type: 'pick', pick: 0 })
    expect(card.step(s, 'Digit6').action).toEqual({ type: 'pick', pick: 5 })
  })
  it('tapLine:5 → pick 5', () => {
    const [card, s] = open()
    expect(card.step(s, 'tapLine:5')).toEqual({ state: null, action: { type: 'pick', pick: 5 } })
  })
  it('tapping the nothing line → pick null', () => {
    const [card, s] = open()
    expect(card.step(s, 'tapLine:6')).toEqual({ state: null, action: { type: 'pick', pick: null } })
  })
  it('Digit0 and Escape → pick null', () => {
    const [card, s] = open()
    expect(card.step(s, 'Digit0')).toEqual({ state: null, action: { type: 'pick', pick: null } })
    expect(card.step(s, 'Escape')).toEqual({ state: null, action: { type: 'pick', pick: null } })
  })
  it('other keys are ignored — E/F/Space/Enter/X and a bare tap do not close the menu', () => {
    const [card, s] = open()
    for (const key of ['KeyE', 'KeyF', 'Space', 'Enter', 'NumpadEnter', 'KeyX', 'tap', 'tapLine:7', 'tapLine:x']) {
      expect(card.step(s, key)).toEqual({ state: s, action: null })
    }
  })
  it('digits past the end of a short menu are ignored; its nothing line still picks null', () => {
    const [card, s] = open(['a', 'b'])
    expect(card.step(s, 'Digit2').action).toEqual({ type: 'pick', pick: 1 })
    expect(card.step(s, 'Digit3')).toEqual({ state: s, action: null })
    expect(card.step(s, 'tapLine:2').action).toEqual({ type: 'pick', pick: null })
    expect(card.step(s, 'tapLine:3')).toEqual({ state: s, action: null })
  })
  it('accepts pre-rendered lines instead of a menu', () => {
    const card = createCard()
    const s = card.open('choose', { text: 'x', lines: chooseLines(['a', 'b', 'c']) })
    expect(s.lines).toEqual(['1 · a', '2 · b', '3 · c', '0 · nothing'])
    expect(card.step(s, 'Digit3').action).toEqual({ type: 'pick', pick: 2 })
    expect(card.step(s, 'tapLine:3').action).toEqual({ type: 'pick', pick: null })
  })
})
