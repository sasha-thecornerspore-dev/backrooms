import { describe, it, expect } from 'vitest'
import { readSettings, writeSettings } from '../src/settings.js'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'

const TMP = join(process.cwd(), '.tmp-settings-test')

describe('settings', () => {
  it('returns defaults when file missing', () => {
    const s = readSettings(join(TMP, 'nonexistent.json'))
    expect(s.autoUpdate).toBe(true)
  })

  it('round-trips autoUpdate: false', () => {
    mkdirSync(TMP, { recursive: true })
    const p = join(TMP, 'settings.json')
    writeSettings(p, { autoUpdate: false })
    expect(readSettings(p).autoUpdate).toBe(false)
    rmSync(TMP, { recursive: true })
  })
})
