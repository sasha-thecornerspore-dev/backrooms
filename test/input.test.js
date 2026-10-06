import { describe, it, expect } from 'vitest'
import { takeKey } from '../src/renderer/input.js'

// the game's view of the page: nothing focused but the body, pointer not locked, settings hidden
const base = { activeTag: 'BODY', isContentEditable: false, locked: false, settingsOpen: false }
const ev = (code, repeat = false) => ({ code, repeat })
const at = (over) => ({ ...base, ...over })

describe('takeKey', () => {
  it('ignores repeat on KeyF/KeyE/Space/Tab/KeyQ/KeyX', () => {
    for (const code of ['KeyF', 'KeyE', 'Space', 'Tab', 'KeyQ', 'KeyX']) expect(takeKey(ev(code, true), base)).toBe('ignore')
  })

  it('takes repeat on movement keys', () => {
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ArrowUp']) expect(takeKey(ev(code, true), base)).toBe('take')
  })

  it('ignores editable targets whatever the key', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(takeKey(ev('KeyW'), at({ activeTag: tag }))).toBe('ignore')
      expect(takeKey(ev('Space'), at({ activeTag: tag }))).toBe('ignore')
      expect(takeKey(ev('Tab'), at({ activeTag: tag, locked: true }))).toBe('ignore')
    }
    expect(takeKey(ev('Space'), at({ activeTag: 'DIV', isContentEditable: true }))).toBe('ignore')
  })

  it('Space is always take-prevent', () => {
    expect(takeKey(ev('Space'), base)).toBe('take-prevent')
    expect(takeKey(ev('Space'), at({ settingsOpen: true }))).toBe('take-prevent')
    expect(takeKey(ev('Space'), at({ activeTag: 'BUTTON' }))).toBe('take-prevent')
    expect(takeKey(ev('Space'), at({ activeTag: undefined, locked: true }))).toBe('take-prevent')
  })

  it('Tab is take-prevent when locked or body/canvas/nothing has focus, and settings are hidden', () => {
    expect(takeKey(ev('Tab'), base)).toBe('take-prevent')
    expect(takeKey(ev('Tab'), at({ activeTag: 'CANVAS' }))).toBe('take-prevent')
    expect(takeKey(ev('Tab'), at({ activeTag: undefined }))).toBe('take-prevent')
    expect(takeKey(ev('Tab'), at({ activeTag: 'BUTTON', locked: true }))).toBe('take-prevent')
  })

  it('Tab is plain take when a control has focus unlocked, or whenever settings are open', () => {
    expect(takeKey(ev('Tab'), at({ activeTag: 'BUTTON' }))).toBe('take')
    expect(takeKey(ev('Tab'), at({ activeTag: 'A' }))).toBe('take')
    expect(takeKey(ev('Tab'), at({ settingsOpen: true }))).toBe('take')
    expect(takeKey(ev('Tab'), at({ locked: true, settingsOpen: true }))).toBe('take')
    expect(takeKey(ev('Tab'), at({ activeTag: 'CANVAS', settingsOpen: true }))).toBe('take')
  })

  it('everything else is take', () => {
    for (const code of ['KeyW', 'KeyF', 'KeyE', 'KeyQ', 'KeyX', 'Escape', 'Digit1']) expect(takeKey(ev(code), base)).toBe('take')
    expect(takeKey(ev('KeyF'), at({ activeTag: 'BUTTON', settingsOpen: true }))).toBe('take')
  })

  it('tolerates a missing state object and a bare event', () => {
    expect(takeKey({ code: 'KeyW' })).toBe('take')
    expect(takeKey({ code: 'Space' }, {})).toBe('take-prevent')
    expect(takeKey({ code: 'Tab' }, {})).toBe('take-prevent')
  })
})
