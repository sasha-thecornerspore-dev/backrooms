// firstrun.js — the first run, authored: a note near the spawn names a lost soul, the soul names a room, the room holds the way down.
// The pure thread: its steps advance only in order, the pull it holds comes free at the soul or after 120 s of lobby time, and it is off
// for a seeded world, a room, a resume past the room, on the block and on any floor below. (Where the note, the soul and the room really
// are in the fixed world: test/firstrun-world.test.js.)
import { describe, it, expect } from 'vitest'
import {
  createFirstRun, noteRecord, FIRST_NOTE, FIRST_SOUL, FIRST_ROOM, STEPS, DONE, FIRST_RUN_UNLOCK_S, inRoom,
} from '../src/renderer/firstrun.js'
import { SCRAPS } from '../src/renderer/scraps.js'
import { LOBBY, BLOCK } from '../src/renderer/topology.js'

const LINES = [FIRST_NOTE.text, FIRST_SOUL.line, FIRST_SOUL.again, FIRST_ROOM.line]
const NUMBER_WORDS = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|first|second|third|half|once|twice|dozen|pair|single|double)\b/g
const ROOM_IN = { x: FIRST_ROOM.way.x | 0, y: FIRST_ROOM.way.y | 0 }
const fresh = (o = {}) => createFirstRun({ fresh: true, ...o })
// walk a thread to step n the only way it goes: in order
function toStep(fr, n) {
  if (n >= 1) fr.onRead(FIRST_NOTE.key)
  if (n >= 2) fr.onSoul(FIRST_SOUL.key)
  if (n >= 3) fr.onEnter(ROOM_IN.x, ROOM_IN.y)
  return fr
}

describe('the authored data', () => {
  it('is frozen: the note, the soul, the room and the step table', () => {
    for (const o of [FIRST_NOTE, FIRST_SOUL, FIRST_ROOM, FIRST_ROOM.way, STEPS, ...STEPS]) expect(Object.isFrozen(o)).toBe(true)
    expect(FIRST_RUN_UNLOCK_S).toBe(120)
    expect(DONE).toBe(3)
  })

  it('the step table: read the note, ask the soul, enter the room', () => {
    expect(STEPS.map((s) => s.on)).toEqual(['read', 'soul', 'enter'])
    expect(STEPS.map((s) => s.key)).toEqual([FIRST_NOTE.key, FIRST_SOUL.key, FIRST_ROOM.key])
    expect(STEPS.length).toBe(DONE)
  })

  it('the lines are lowercase, understated: no digits, no exclamation marks, no number word beyond the draft\'s', () => {
    for (const l of LINES) {
      expect(typeof l).toBe('string')
      expect(l.length).toBeGreaterThan(10)
      expect(l).toBe(l.toLowerCase())
      expect(l).not.toMatch(/[0-9!]/)
      expect(l.endsWith('.')).toBe(true)
    }
    // 'the one that does not want you' is Appendix A's own draft word; nothing else counts anything
    expect(LINES.flatMap((l) => l.match(NUMBER_WORDS) ?? [])).toEqual(['one'])
    expect(FIRST_SOUL.again).toMatch(/\bthe one\b/)
  })

  it('the note is its own record: not a page, nothing in SCRAPS, readable on the note card like one', () => {
    expect(SCRAPS).not.toContain(FIRST_NOTE.text)
    for (const p of SCRAPS) expect(FIRST_NOTE.text.includes(p)).toBe(false)
    const r = noteRecord()
    expect(r).toEqual({ key: FIRST_NOTE.key, x: FIRST_NOTE.x, y: FIRST_NOTE.y, frag: -1, firstrun: true })
    expect(r.form).toBeUndefined()                            // never the block's form
    expect(noteRecord()).not.toBe(r)                          // a fresh record each time: decor may write to it
    expect(FIRST_NOTE.key).not.toMatch(/^-?\d+,-?\d+$/)       // never a chunk key: no page's key, and decor never evicts it
  })

  it('the room is a rectangle of cells around its way, and inRoom reads it', () => {
    const { x0, y0, x1, y1, way } = FIRST_ROOM
    expect(x0).toBeLessThan(x1); expect(y0).toBeLessThan(y1)
    expect(inRoom(Math.floor(way.x), Math.floor(way.y))).toBe(true)
    expect(inRoom(x0, y0)).toBe(true); expect(inRoom(x1, y1)).toBe(true)
    expect(inRoom(x0 - 1, y0)).toBe(false); expect(inRoom(x1 + 1, y1)).toBe(false)
    expect(inRoom(x0, y0 - 1)).toBe(false); expect(inRoom(x1, y1 + 1)).toBe(false)
  })
})

describe('createFirstRun: in order', () => {
  it('starts at step 0, on, holding the pull', () => {
    const fr = fresh()
    expect(fr.step()).toBe(0)
    expect(fr.on()).toBe(true)
    expect(fr.done()).toBe(false)
    expect(fr.unlocked()).toBe(false)
    expect(fr.toward()).toBeNull()
  })

  it('reading the note is step 1; any other page or a second read does nothing', () => {
    const fr = fresh()
    expect(fr.onRead('1,0')).toBe(false)
    expect(fr.onRead(19)).toBe(false)
    expect(fr.step()).toBe(0)
    expect(fr.onRead(FIRST_NOTE.key)).toBe(true)
    expect(fr.step()).toBe(1)
    expect(fr.onRead(FIRST_NOTE.key)).toBe(false)
    expect(fr.step()).toBe(1)
    expect(fr.unlocked()).toBe(false)                         // the note alone does not free the pull
  })

  it('the soul before the note is any lost soul: no line of its own, no step', () => {
    const fr = fresh()
    expect(fr.onSoul(FIRST_SOUL.key)).toBeNull()
    expect(fr.step()).toBe(0)
  })

  it('the room before the soul says nothing and is not a step', () => {
    const fr = fresh()
    expect(fr.onEnter(ROOM_IN.x, ROOM_IN.y)).toBeNull()
    fr.onRead(FIRST_NOTE.key)
    expect(fr.onEnter(ROOM_IN.x, ROOM_IN.y)).toBeNull()
    expect(fr.step()).toBe(1)
  })

  it('the named soul names the room (step 2), then says the room again; another soul is just a soul', () => {
    const fr = toStep(fresh(), 1)
    expect(fr.onSoul('-2,1')).toBeNull()
    expect(fr.step()).toBe(1)
    expect(fr.onSoul(FIRST_SOUL.key)).toBe(FIRST_SOUL.line)
    expect(fr.step()).toBe(2)
    expect(fr.unlocked()).toBe(true)                          // step 2 frees the pull
    expect(fr.onSoul(FIRST_SOUL.key)).toBe(FIRST_SOUL.again)
    expect(fr.onSoul(FIRST_SOUL.key)).toBe(FIRST_SOUL.again)
    expect(fr.step()).toBe(2)
  })

  it('while it waits on the room it says where the room\'s way is; never before, never after', () => {
    const fr = toStep(fresh(), 1)
    expect(fr.toward()).toBeNull()
    fr.onSoul(FIRST_SOUL.key)
    expect(fr.toward()).toBe(FIRST_ROOM.way)
    fr.onEnter(ROOM_IN.x, ROOM_IN.y)
    expect(fr.toward()).toBeNull()
  })

  it('entering the room says its line once and the thread is done', () => {
    const fr = toStep(fresh(), 2)
    expect(fr.onEnter(FIRST_ROOM.x0 - 1, FIRST_ROOM.y0)).toBeNull()
    expect(fr.step()).toBe(2)
    expect(fr.onEnter(FIRST_ROOM.x0, FIRST_ROOM.y0)).toBe(FIRST_ROOM.line)
    expect(fr.step()).toBe(3)
    expect(fr.done()).toBe(true)
    expect(fr.on()).toBe(false)
    expect(fr.unlocked()).toBe(true)
    expect(fr.onEnter(ROOM_IN.x, ROOM_IN.y)).toBeNull()
    expect(fr.onSoul(FIRST_SOUL.key)).toBeNull()             // done: the soul goes back to its own pool
    expect(fr.onRead(FIRST_NOTE.key)).toBe(false)
  })
})

describe('createFirstRun: the pull comes free at 120 s of lobby time', () => {
  it('ticks only lobby time while it holds; 120 s frees it', () => {
    const fr = fresh()
    for (let i = 0; i < 959; i++) fr.tick(0.125)              // 119.875 s, exact in binary
    expect(fr.unlocked()).toBe(false)
    fr.tick(0.125)
    expect(fr.unlocked()).toBe(true)
    expect(fr.step()).toBe(0)                                 // time frees the pull, it does not advance the thread
    expect(fr.on()).toBe(true)
  })

  it('a bad dt is no time', () => {
    const fr = fresh()
    for (const dt of [-5, NaN, Infinity, undefined]) fr.tick(dt)
    expect(fr.unlocked()).toBe(false)
  })

  it('the block counts nothing and holds nothing; the lobby then starts from zero', () => {
    const fr = fresh({ level: BLOCK })
    expect(fr.on()).toBe(true)
    expect(fr.unlocked()).toBe(true)                          // nothing is held on the block: the hold is the lobby's
    for (let i = 0; i < 2000; i++) fr.tick(0.1)
    expect(fr.onRead(FIRST_NOTE.key)).toBe(false)             // and nothing advances there
    fr.onLevel(LOBBY)
    expect(fr.unlocked()).toBe(false)
    fr.tick(FIRST_RUN_UNLOCK_S - 1)
    expect(fr.unlocked()).toBe(false)
    fr.tick(1)
    expect(fr.unlocked()).toBe(true)
  })

  it('the block\'s id string reads as the block too', () => {
    const fr = fresh({ level: '∅' })
    expect(fr.on()).toBe(true)
    fr.onLevel(0)
    expect(fr.unlocked()).toBe(false)
  })
})

describe('createFirstRun: off', () => {
  const offChecks = (fr) => {
    expect(fr.on()).toBe(false)
    expect(fr.unlocked()).toBe(true)
    expect(fr.toward()).toBeNull()
    expect(fr.onRead(FIRST_NOTE.key)).toBe(false)
    expect(fr.onSoul(FIRST_SOUL.key)).toBeNull()
    expect(fr.onEnter(ROOM_IN.x, ROOM_IN.y)).toBeNull()
  }

  it('for a seeded world', () => {
    for (const worldSeed of [0, 1, 424242, -7]) {
      const fr = fresh({ worldSeed })
      offChecks(fr)
      expect(fr.step()).toBe(0)
    }
    expect(fresh({ worldSeed: undefined }).on()).toBe(true)   // no seed given is the fixed world
  })

  it('in a room (an online run)', () => { offChecks(fresh({ room: true })) })

  it('when the run is not a fresh solo one, or nothing says it is', () => {
    offChecks(createFirstRun({ fresh: false }))
    offChecks(createFirstRun())
    offChecks(createFirstRun({ fresh: 'yes' }))
  })

  it('for a resume past the room; a resume before it carries on from its step', () => {
    const past = fresh({ step: 3 })
    offChecks(past)
    expect(past.done()).toBe(true)
    expect(past.step()).toBe(3)
    expect(fresh({ step: 9 }).step()).toBe(3)
    const mid = fresh({ step: 2 })
    expect(mid.on()).toBe(true)
    expect(mid.unlocked()).toBe(true)
    expect(mid.onEnter(ROOM_IN.x, ROOM_IN.y)).toBe(FIRST_ROOM.line)
    const one = fresh({ step: 1 })
    expect(one.onSoul(FIRST_SOUL.key)).toBe(FIRST_SOUL.line)
    expect(fresh({ step: -1 }).step()).toBe(0)
    expect(fresh({ step: 1.5 }).step()).toBe(0)
  })

  it('on any floor below, and for the rest of the run once you have gone down', () => {
    const fr = toStep(fresh(), 1)
    fr.onLevel(1)
    offChecks(fr)
    fr.onLevel(LOBBY)                                         // the loop brings you back: the thread does not
    offChecks(fr)
    expect(fr.step()).toBe(1)
    expect(fr.done()).toBe(false)
  })

  it('a chunk key from a floor below never matches: the thread listens on the lobby only', () => {
    const fr = toStep(fresh({ level: 2 }), 0)
    offChecks(fr)
  })
})
