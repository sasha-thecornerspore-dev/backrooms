import { describe, it, expect } from 'vitest'
import { wishTitle, wishLabels } from '../src/wish-labels.js'
import { wishTrailer } from '../src/renderer/status.js'

describe('wishLabels', () => {
  it('a processed wanderer filed under extension is an amendment with a status label', () => {
    expect(wishLabels('x\nfiled under: EXTENSION · level 2', { origin: 'processed' })).toEqual(['wish', 'pending', 'status:extension', 'amendment'])
  })

  it('a plain wish keeps today\'s two labels', () => {
    expect(wishLabels('make the fog warmer')).toEqual(['wish', 'pending'])
    expect(wishLabels('make the fog warmer', undefined)).toEqual(['wish', 'pending'])
    expect(wishLabels('make the fog warmer', null)).toEqual(['wish', 'pending'])
    expect(wishLabels('make the fog warmer', { origin: 'tenant' })).toEqual(['wish', 'pending'])
  })

  it('a status trailer adds its lowercase status', () => {
    expect(wishLabels('x\nfiled under: COMPLIANCE · level 1')).toEqual(['wish', 'pending', 'status:compliance'])
    expect(wishLabels('x' + wishTrailer('litigation', 3), { origin: null })).toEqual(['wish', 'pending', 'status:litigation'])
  })

  it('the unfiled default adds no trailer and so no label', () => {
    expect(wishTrailer('notice-mailed', 0)).toBe('')
    expect(wishLabels('x' + wishTrailer('notice-mailed', 0))).toEqual(['wish', 'pending'])
  })
})

describe('wishTitle', () => {
  it('a one-line wish keeps today\'s title byte for byte', () => {
    expect(wishTitle('make the fog warmer')).toBe('[WISH] make the fog warmer')
    const t = 'i was here'
    expect(wishTitle(t)).toBe(`[WISH] ${t.slice(0, 120)}`)
  })

  it('cuts at 120 characters', () => {
    expect(wishTitle('a'.repeat(200))).toBe('[WISH] ' + 'a'.repeat(120))
  })

  it('carries only the first line, never the trailer', () => {
    expect(wishTitle('first line\nfiled under: EXTENSION · level 2')).toBe('[WISH] first line')
  })
})
