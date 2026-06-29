import { describe, it, expect } from 'vitest'
import { generateChunk, CHUNK_SIZE } from '../src/renderer/world.js'

describe('generateChunk', () => {
  it('returns a Uint8Array of the correct size', () => {
    const chunk = generateChunk(0, 0, 0)
    expect(chunk).toBeInstanceOf(Uint8Array)
    expect(chunk.length).toBe(CHUNK_SIZE * CHUNK_SIZE)
  })

  it('is deterministic — same cx/cy/epoch gives identical output', () => {
    const a = generateChunk(3, -2, 0)
    const b = generateChunk(3, -2, 0)
    expect(a).toEqual(b)
  })

  it('differs for different epoch — revisit generates a new layout', () => {
    const a = generateChunk(3, -2, 0)
    const b = generateChunk(3, -2, 1)
    expect(a).not.toEqual(b)
  })

  it('differs for different chunk coordinates', () => {
    const a = generateChunk(0, 0, 0)
    const b = generateChunk(1, 0, 0)
    expect(a).not.toEqual(b)
  })

  it('border midpoint passages are always open (top edge)', () => {
    const chunk = generateChunk(5, 5, 0)
    const m = Math.floor(CHUNK_SIZE / 2)
    expect(chunk[0 * CHUNK_SIZE + m]).toBe(0)
  })

  it('border midpoint passages are always open (bottom edge)', () => {
    const chunk = generateChunk(5, 5, 0)
    const m = Math.floor(CHUNK_SIZE / 2)
    expect(chunk[(CHUNK_SIZE - 1) * CHUNK_SIZE + m]).toBe(0)
  })

  it('border midpoint passages are always open (left edge)', () => {
    const chunk = generateChunk(5, 5, 0)
    const m = Math.floor(CHUNK_SIZE / 2)
    expect(chunk[m * CHUNK_SIZE + 0]).toBe(0)
  })

  it('border midpoint passages are always open (right edge)', () => {
    const chunk = generateChunk(5, 5, 0)
    const m = Math.floor(CHUNK_SIZE / 2)
    expect(chunk[m * CHUNK_SIZE + (CHUNK_SIZE - 1)]).toBe(0)
  })

  it('cross-corridor cells at midpoint row are always open', () => {
    const chunk = generateChunk(7, -3, 2)
    const m = Math.floor(CHUNK_SIZE / 2)
    // Every cell in the midpoint row should be open (corridor)
    for (let x = 0; x < CHUNK_SIZE; x++) {
      expect(chunk[m * CHUNK_SIZE + x]).toBe(0)
    }
  })

  it('cells contain only 0 or 1', () => {
    const chunk = generateChunk(0, 0, 0)
    for (const v of chunk) {
      expect(v === 0 || v === 1).toBe(true)
    }
  })
})
