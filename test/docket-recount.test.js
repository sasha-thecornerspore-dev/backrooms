import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { recount, withDocket, parsePages } from '../tools/docket.mjs'
import { EMPTY_DOCKET } from '../src/renderer/docket.js'

const issue = (number, body, labels = ['wish', 'pending'], extra = {}) => ({ number, body, labels, ...extra })
const zeros = () => JSON.parse(JSON.stringify(EMPTY_DOCKET))

describe('recount', () => {
  it('tallies trailers by level and status; denied wishes and bare wishes count nothing', () => {
    const d = recount([
      issue(1, 'stay a while\nfiled under: EXTENSION · level 2'),
      issue(2, 'keep the lights\nfiled under: EXTENSION · level 2', ['wish', 'granted']),
      issue(3, 'be quiet\nfiled under: COMPLIANCE · level 0', ['wish', 'denied']),
      issue(4, 'make the fog warmer'),
      issue(5, ''),
    ])
    const want = zeros()
    want['2'].extension = 2
    expect(d).toEqual(want)
  })

  it('a malformed trailer, a level outside 0..3 or the unfiled status tallies nothing', () => {
    const d = recount([
      issue(1, 'x\nfiled under: EXTENSION · level two'),
      issue(2, 'x\nfiled under: EXTENSION · level 4'),
      issue(3, 'x\nfiled under: LITIGATION · level 7'),
      issue(4, 'x\nfiled under: NOTICE MAILED · level 1'),
      issue(5, null),
      issue(6, undefined),
    ])
    expect(d).toEqual(zeros())
  })

  it('labels as strings or as {name} objects; a wish label is required', () => {
    const d = recount([
      issue(1, 'a\nfiled under: LITIGATION · level 1', [{ name: 'wish' }, { name: 'pending' }]),
      issue(2, 'b\nfiled under: LITIGATION · level 1', ['wish']),
      issue(3, 'c\nfiled under: LITIGATION · level 1', ['pending']),
      issue(4, 'd\nfiled under: LITIGATION · level 1', [{ name: 'wish' }, { name: 'denied' }]),
      issue(5, 'e\nfiled under: LITIGATION · level 1'.replace('1', '3'), null),
    ])
    expect(d['1'].litigation).toBe(2)
    expect(d['3'].litigation).toBe(0)
  })

  it('pull requests are not wishes', () => {
    const d = recount([issue(1, 'x\nfiled under: COMPLIANCE · level 3', ['wish'], { pull_request: { url: 'https://example.invalid/pr/1' } })])
    expect(d).toEqual(zeros())
  })

  it('is order-independent', () => {
    const list = [
      issue(1, 'a\nfiled under: EXTENSION · level 0'),
      issue(2, 'b\nfiled under: COMPLIANCE · level 1'),
      issue(3, 'c\nfiled under: COMPLIANCE · level 1'),
      issue(4, 'd\nfiled under: LITIGATION · level 3'),
    ]
    expect(recount(list.slice().reverse())).toEqual(recount(list))
  })

  it('recount([]) is a fresh zero docket; EMPTY_DOCKET stays frozen', () => {
    const d = recount([])
    expect(d).toEqual(EMPTY_DOCKET)
    expect(d).not.toBe(EMPTY_DOCKET)
    d['0'].extension = 5
    expect(EMPTY_DOCKET['0'].extension).toBe(0)
    expect(Object.isFrozen(EMPTY_DOCKET['0'])).toBe(true)
    expect(recount(undefined)).toEqual(EMPTY_DOCKET)
  })
})

describe('withDocket', () => {
  it('replaces .docket and keeps every other key', () => {
    const text = readFileSync(new URL('../src/renderer/world.json', import.meta.url), 'utf8')
    const before = JSON.parse(text)
    const d = zeros()
    d['2'].extension = 3
    const out = withDocket(text, d)
    expect(out.endsWith('\n')).toBe(true)
    const after = JSON.parse(out)
    expect(after.docket).toEqual(d)
    const { docket: _a, ...restA } = after
    const { docket: _b, ...restB } = before
    expect(restA).toEqual(restB)
  })

  it('adds the key to a drifted world that dropped it', () => {
    const out = JSON.parse(withDocket(JSON.stringify({ fogDistance: 12 }), zeros()))
    expect(out).toEqual({ fogDistance: 12, docket: zeros() })
  })
})

describe('parsePages (gh --paginate --jq emits one array per page)', () => {
  it('flattens compact pages, pretty pages and a single array', () => {
    expect(parsePages('[{"number":1}]\n[{"number":2},{"number":3}]\n')).toEqual([{ number: 1 }, { number: 2 }, { number: 3 }])
    expect(parsePages('[\n  {"number": 1, "body": "a ] b [ \\" c"}\n]\n[\n  {"number": 2}\n]')).toEqual([{ number: 1, body: 'a ] b [ " c' }, { number: 2 }])
    expect(parsePages('[]')).toEqual([])
    expect(parsePages('')).toEqual([])
  })
})
