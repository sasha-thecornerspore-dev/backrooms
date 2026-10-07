// papercard.js — the paper card.
//
// One primitive for every card the game lays over the maze: m.'s found pages,
// the intake form on the counter, the "is that how it is spelled?" confirm, the
// sealed page compliance leaves unread, the cache menu and the cache note. Pure:
// it only DECIDES what a key does to an open card; game.js owns the DOM, the
// readSet, sanity and the file. Every two-way card is Esc vs anything, so the
// touch SPEAK button (KeyE) confirms naturally — and since touch has no Esc, a
// confirm's foot is two tappable lines, the second a no. Taps arrive as keys too: 'tap'
// is a pointerdown on the card body, 'tapLine:<i>' a pointerdown on option line
// i (the lines stopPropagation, so a sealed/choose card never closes by accident).

export const MODES = ['page', 'form', 'confirm', 'sealed', 'choose', 'read']

// today's close-any-key rule for a page (game.js key block), kept byte for byte
export const CLOSE_KEYS = ['Escape', 'KeyE', 'KeyF', 'Space', 'Enter', 'NumpadEnter']
const DIGITS = ['Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6']
// everything the key block clears from K while a card is open
export const CARD_KEYS = [...CLOSE_KEYS, 'KeyX', ...DIGITS]

export const SEALED_TEXT = '█████'
export const SEALED_FOOT = 'read it · e      leave it unread · x'
export const SEALED_LINES = ['read it · e', 'leave it unread · x']   // the foot, as two tappable lines
export const REDACTED_FOOT = 'you do not read it. the file notes that you did not.'
export const REFUSE_LINE = 'the file already knows you read it.'
export const CONFIRM_LINES = ['yes · e', 'no · esc']   // the confirm foot, tappable: touch has no Esc to say no with
export const READ_FOOT = 'a cache, not a page'
export const CHOOSE_NONE = '0 · nothing'

const NONE = Object.freeze([])
const CLOSE = Object.freeze({ type: 'close' })

// '1 · take the left.' … '0 · nothing' — menu is the phrases, in order
export function chooseLines(menu = []) {
  const out = menu.map((p, i) => `${i + 1} · ${p}`)
  out.push(CHOOSE_NONE)
  return out
}

// the cache note reads like one of m.'s pages: the phrase, the reader-relative
// arrow, signed by whoever set it down. Returns open('read', …)'s opts.
export function readText(name, phrase, arrow) {
  const line = arrow ? `${phrase} ${arrow}` : `${phrase}`
  return { text: name ? `${line}\n— ${name}` : line, foot: READ_FOOT }
}

const lineIndex = key => {
  if (typeof key !== 'string' || !key.startsWith('tapLine:')) return -1
  const n = Number(key.slice(8))
  return Number.isInteger(n) && n >= 0 ? n : -1
}
const digit = key => (DIGITS.includes(key) ? Number(key[5]) : -1)
const known = key => CARD_KEYS.includes(key) || key === 'tap' || lineIndex(key) >= 0

const isClose = key => CLOSE_KEYS.includes(key) || key === 'tap'

export function createCard() {
  const card = {
    state: null,

    open(mode, opts = {}) {
      if (!MODES.includes(mode)) throw new Error(`papercard: unknown mode '${mode}'`)
      const s = {
        mode,
        text: opts.text ?? '',
        foot: opts.foot ?? '',
        lines: NONE,
        count: 0,            // choose: how many pickable lines precede the nothing line
        hidden: null,        // sealed: the page text behind the blocks
        revealFoot: null,    // sealed: the foot to show once revealed
        revealed: false,
        redacted: false,
        onPick: opts.onPick ?? null,
        onConfirm: opts.onConfirm ?? null,
        onClose: opts.onClose ?? null,
      }
      if (mode === 'sealed') {
        s.hidden = s.text
        s.revealFoot = s.foot
        s.text = SEALED_TEXT
        s.redacted = !!opts.redacted
        s.foot = s.redacted ? REDACTED_FOOT : SEALED_FOOT
        s.lines = s.redacted ? NONE : SEALED_LINES
      } else if (mode === 'confirm') {
        s.lines = CONFIRM_LINES
      } else if (mode === 'choose') {
        if (opts.menu) { s.lines = chooseLines(opts.menu); s.count = opts.menu.length }
        else {
          s.lines = opts.lines ?? NONE
          s.count = s.lines.length - (s.lines[s.lines.length - 1] === CHOOSE_NONE ? 1 : 0)
        }
      }
      card.state = s
      return s
    },

    step(state, key) {
      if (!state) return { state: null, action: null }
      const r = stepState(state, key)
      card.state = r.state
      return r
    },
  }

  // the adapter sets the legacy foot after a reveal ('{n} of 26 pages found')
  card.setFoot = (state, foot) => { const s = { ...state, foot }; card.state = s; return s }
  return card
}

export function setFoot(state, foot) { return { ...state, foot } }

function stepState(s, key) {
  const same = { state: s, action: null }
  if (!known(key)) return same
  switch (s.mode) {
    case 'read':
      return { state: null, action: CLOSE }

    case 'page':
    case 'form':
      if (isClose(key)) return { state: null, action: CLOSE }
      // a page revealed from a sealed card can never be redacted after the fact
      if (key === 'KeyX' && s.revealed) return { state: s, action: { type: 'refuse', line: REFUSE_LINE } }
      return same

    case 'confirm':
      // the no line is the Esc a phone does not have; the body and the yes line are anything
      return { state: null, action: { type: 'close', confirmed: key !== 'Escape' && key !== 'tapLine:1' } }

    case 'sealed': {
      const li = lineIndex(key)
      const read = key === 'KeyE' || li === 0
      const leave = key === 'KeyX' || li === 1
      if (s.redacted) {
        // the file has its answer: the choice keys close, X is spent
        if (read || key === 'Escape' || key === 'KeyF' || key === 'Space') return { state: null, action: CLOSE }
        return same
      }
      if (read) return { state: { ...s, mode: 'page', text: s.hidden, foot: s.revealFoot ?? '', lines: NONE, revealed: true }, action: { type: 'reveal' } }
      if (leave) return { state: { ...s, foot: REDACTED_FOOT, lines: NONE, redacted: true }, action: { type: 'redact' } }
      if (key === 'Escape' || key === 'KeyF' || key === 'Space') return { state: null, action: CLOSE }
      return same
    }

    case 'choose': {
      const pick = i => ({ state: null, action: { type: 'pick', pick: i } })
      if (key === 'Escape' || key === 'Digit0') return pick(null)
      const d = digit(key)
      if (d > 0) return d <= s.count ? pick(d - 1) : same
      const li = lineIndex(key)
      if (li >= 0) return li < s.count ? pick(li) : li === s.count ? pick(null) : same
      return same
    }
  }
  return same
}
