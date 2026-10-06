import { describe, it, expect } from 'vitest'
import { createMessageQueue, PRIO } from '../src/renderer/messages.js'

// advance the queue by `total` seconds in `step` ticks, recording every non-null result as [text, show]
function run(q, total, step = 0.1) {
  const out = []
  for (let i = 0, n = Math.round(total / step); i < n; i++) { const r = q.tick(step); if (r) out.push([r.text, r.show]) }
  return out
}
const shown = (log) => log.filter(([, s]) => s).map(([t]) => t)

describe('PRIO', () => {
  it('orders ambient < discovery < interaction < combat', () => {
    expect(PRIO).toEqual({ ambient: 0, discovery: 1, interaction: 2, combat: 3 })
  })
})

describe('createMessageQueue', () => {
  it('tick on an idle queue returns null', () => {
    const q = createMessageQueue()
    expect(q.tick(0.016)).toBeNull()
    expect(q.tick(1)).toBeNull()
  })

  it('a combat push replaces an interaction line on the same tick', () => {
    const q = createMessageQueue()
    q.push('the drawer is empty.', PRIO.interaction)
    expect(q.tick(0.016)).toEqual({ text: 'the drawer is empty.', show: true })
    q.push('it has you.', PRIO.combat)
    expect(q.tick(0.016)).toEqual({ text: 'it has you.', show: true })
  })

  it('an interaction push during a combat line waits until dwellS has elapsed, then shows', () => {
    const q = createMessageQueue({ dwellS: 1.6 })
    q.push('it has you.', PRIO.combat)
    expect(q.tick(0.1).text).toBe('it has you.')
    q.push('the drawer is empty.', PRIO.interaction)
    expect(run(q, 1.4)).toEqual([])                                   // visible 1.4 s: the combat line stays
    expect(q.tick(0.3)).toEqual({ text: 'the drawer is empty.', show: true })   // 1.7 s >= dwellS
  })

  it('a lower-priority push also waits for the dwell, then replaces', () => {
    const q = createMessageQueue({ dwellS: 1.6 })
    q.push('the drawer is empty.', PRIO.interaction); q.tick(0.1)
    q.push('a room full of chairs.', PRIO.discovery)
    expect(run(q, 1.4)).toEqual([])
    expect(q.tick(0.3)).toEqual({ text: 'a room full of chairs.', show: true })
  })

  it('two discovery pushes 0.1 s apart show >= discoveryGapS apart and neither is dropped', () => {
    const q = createMessageQueue({ discoveryGapS: 6 })
    q.push('a room full of chairs.', PRIO.discovery)
    let t = 0, first = -1, second = -1
    for (let i = 0; i < 200; i++) {
      const r = q.tick(0.1); t += 0.1
      if (i === 0) q.push('someone wrote on the wall.', PRIO.discovery)       // 0.1 s after the first
      if (r && r.show && r.text === 'a room full of chairs.') first = t
      if (r && r.show && r.text === 'someone wrote on the wall.') second = t
    }
    expect(first).toBeGreaterThan(0)
    expect(second).toBeGreaterThan(0)
    expect(second - first).toBeGreaterThanOrEqual(6 - 1e-9)
  })

  it('the first discovery on an idle queue shows at once; the gap applies between discoveries only', () => {
    const q = createMessageQueue({ discoveryGapS: 6 })
    q.push('a room full of chairs.', PRIO.discovery)
    expect(q.tick(0.1)).toEqual({ text: 'a room full of chairs.', show: true })
    run(q, 5)                                                         // fades at holdS
    q.push('the drawer is empty.', PRIO.interaction)                  // interactions are not gated
    expect(q.tick(0.1)).toEqual({ text: 'the drawer is empty.', show: true })
  })

  it('duplicate discovery text is deduped', () => {
    const q = createMessageQueue()
    q.push('it has you.', PRIO.combat); q.tick(0.1)                    // something showing: discoveries queue
    q.push('a room full of chairs.', PRIO.discovery)
    q.push('a room full of chairs.', PRIO.discovery)
    q.push('a room full of chairs.', PRIO.discovery)
    const texts = shown(run(q, 30))
    expect(texts.filter((x) => x === 'a room full of chairs.')).toHaveLength(1)
  })

  it('an ambient push while anything shows is dropped', () => {
    const q = createMessageQueue()
    q.push('the carpet is damp.', PRIO.ambient)
    expect(q.tick(0.1)).toEqual({ text: 'the carpet is damp.', show: true })   // idle queue: it shows
    q.push('the humming never stops.', PRIO.ambient)                           // something is showing: dropped
    expect(shown(run(q, 10))).toEqual([])
  })

  it('an ambient push while anything is queued is dropped', () => {
    const q = createMessageQueue()
    q.push('it has you.', PRIO.combat); q.tick(0.1)
    q.push('the drawer is empty.', PRIO.interaction)                  // waiting behind the combat line
    q.push('the carpet is damp.', PRIO.ambient)
    expect(shown(run(q, 30))).toEqual(['the drawer is empty.'])
  })

  it('an ambient push while a discovery waits for its gap is dropped (queued, not showing)', () => {
    const q = createMessageQueue({ discoveryGapS: 6 })
    q.push('a room full of chairs.', PRIO.discovery); q.tick(0.1)
    q.push('someone wrote on the wall.', PRIO.discovery)
    run(q, 5)                                                         // the first has faded; the second waits for the gap
    q.push('the carpet is damp.', PRIO.ambient)
    expect(shown(run(q, 10))).toEqual(['someone wrote on the wall.'])
  })

  it('a line fades (show:false) holdS after it was shown, once', () => {
    const q = createMessageQueue({ holdS: 4.2 })
    q.push('the drawer is empty.', PRIO.interaction)
    expect(q.tick(0.1).show).toBe(true)
    expect(run(q, 4.0)).toEqual([])                                   // 4.0 s visible: still up
    expect(q.tick(0.3)).toEqual({ text: 'the drawer is empty.', show: false })
    expect(q.tick(0.1)).toBeNull()
  })

  it('consecutive non-null results are the same object', () => {
    const q = createMessageQueue()
    q.push('a', PRIO.interaction)
    const r1 = q.tick(0.1)
    q.push('b', PRIO.combat)
    expect(q.tick(0.1)).toBe(r1)
    for (let i = 0; i < 100; i++) { const r = q.tick(0.1); if (r) expect(r).toBe(r1) }
    q.push('c', PRIO.ambient)
    expect(q.tick(0.1)).toBe(r1)
  })

  it('with 4 interaction pushes in one frame the oldest beyond 2 waiting are dropped', () => {
    const q = createMessageQueue()
    q.push('it has you.', PRIO.combat); q.tick(0.1)
    q.push('one', PRIO.interaction); q.push('two', PRIO.interaction); q.push('three', PRIO.interaction); q.push('four', PRIO.interaction)
    expect(shown(run(q, 20))).toEqual(['three', 'four'])
  })

  it('on an idle queue the first interaction shows and the waiting ones are capped at 2', () => {
    const q = createMessageQueue()
    q.push('one', PRIO.interaction); q.push('two', PRIO.interaction); q.push('three', PRIO.interaction); q.push('four', PRIO.interaction)
    expect(shown(run(q, 20))).toEqual(['one', 'three', 'four'])
  })

  it('queued lines come out combat first, then interaction, then discovery', () => {
    const q = createMessageQueue()
    q.push('it has you.', PRIO.combat); q.tick(0.1)
    q.push('a room full of chairs.', PRIO.discovery)
    q.push('the drawer is empty.', PRIO.interaction)
    q.push('it is close.', PRIO.combat)
    expect(shown(run(q, 30))).toEqual(['it is close.', 'the drawer is empty.', 'a room full of chairs.'])
  })

  it('the same text pushed while it is showing re-arms its hold (no flicker)', () => {
    const q = createMessageQueue({ holdS: 4.2 })
    q.push('the drawer is empty.', PRIO.interaction); q.tick(0.1)
    run(q, 3)
    q.push('the drawer is empty.', PRIO.interaction)                  // 3 s in: re-arm
    expect(run(q, 3)).toEqual([])                                     // no fade at 4.2, no re-show
    expect(run(q, 2)).toEqual([['the drawer is empty.', false]])
  })

  it('clear() drops everything and hides the current line once', () => {
    const q = createMessageQueue()
    q.push('it has you.', PRIO.combat); q.tick(0.1)
    q.push('one', PRIO.interaction); q.push('a room full of chairs.', PRIO.discovery)
    q.clear()
    expect(q.tick(0.1)).toEqual({ text: 'it has you.', show: false })
    expect(run(q, 10)).toEqual([])
    const q2 = createMessageQueue(); q2.clear()
    expect(q2.tick(0.1)).toBeNull()
  })

  // the drawer's haunt (containers.js applyRoll -> game.js fireEvent): the roll lands 0.75 s into 'you rummage.' (interaction, holdS 4.2),
  // so its line must be pushed at interaction to be seen at all; at ambient the queue drops it and the sanity hit arrives with no text
  it('a search result pushed while "you rummage." shows is kept at interaction and dropped at ambient', () => {
    const cold = 'a cold spot. your breath fogs where there is nothing cold enough to fog it.'
    const asWired = createMessageQueue(), seenWired = []
    asWired.push('you rummage.', PRIO.interaction); seenWired.push(...run(asWired, 0.75))     // SEARCH_HOLD_S
    asWired.push(cold, PRIO.interaction); seenWired.push(...run(asWired, 12))
    expect(shown(seenWired)).toEqual(['you rummage.', cold])
    const dropped = createMessageQueue(), seenDropped = []
    dropped.push('you rummage.', PRIO.interaction); seenDropped.push(...run(dropped, 0.75))
    dropped.push(cold, PRIO.ambient); seenDropped.push(...run(dropped, 12))
    expect(shown(seenDropped)).toEqual(['you rummage.'])
  })

  // the lift (game.js travel): a 'before' line pushed ahead of the fade is cleared by buildLevel 0.58 s later, and never shown at all when a
  // prompt result is up; pushed under the veil after the clear, at combat, it reads first and the level name follows (combat queues FIFO)
  it('two combat lines pushed after clear() both show, in order; a discovery line pushed before the clear is lost', () => {
    const lift = 'the lift arrives without being called. it only goes one place.', name = 'level 3 — the pipes'
    const before = createMessageQueue(), seenBefore = []
    before.push('you take the almond water.', PRIO.interaction); seenBefore.push(...run(before, 0.1))
    before.push(lift, PRIO.discovery); seenBefore.push(...run(before, 0.58))              // queued behind the interaction line, under the veil
    before.clear(); before.push(name, PRIO.combat); seenBefore.push(...run(before, 12))   // buildLevel: the clear drops it before it showed
    expect(shown(seenBefore)).toEqual(['you take the almond water.', name])
    const under = createMessageQueue(), seenUnder = []
    under.push('you take the almond water.', PRIO.interaction); seenUnder.push(...run(under, 0.68))
    under.clear(); under.push(lift, PRIO.combat); under.push(name, PRIO.combat); seenUnder.push(...run(under, 12))
    expect(shown(seenUnder)).toEqual(['you take the almond water.', lift, name])
  })

  it('ignores empty pushes', () => {
    const q = createMessageQueue()
    q.push('', PRIO.combat); q.push(null, PRIO.combat); q.push(undefined, PRIO.interaction)
    expect(q.tick(0.1)).toBeNull()
  })
})
