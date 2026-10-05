import { describe, it, expect } from 'vitest'
import { readSettings, writeSettings } from '../src/settings.js'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'

const TMP = join(process.cwd(), '.tmp-settings-test')

describe('settings', () => {
  it('returns defaults when file missing', () => {
    const s = readSettings(join(TMP, 'nonexistent.json'))
    expect(s.autoUpdate).toBe(true)
    expect(s.updateMode).toBe('auto')
  })

  it('round-trips autoUpdate: false', () => {
    mkdirSync(TMP, { recursive: true })
    const p = join(TMP, 'settings.json')
    writeSettings(p, { autoUpdate: false })
    expect(readSettings(p).autoUpdate).toBe(false)
    rmSync(TMP, { recursive: true })
  })

  it('round-trips every update mode and mirrors autoUpdate', () => {
    mkdirSync(TMP, { recursive: true })
    const p = join(TMP, 'settings.json')
    for (const mode of ['auto', 'notify', 'manual']) {
      writeSettings(p, { updateMode: mode, softwareRender: false })
      const s = readSettings(p)
      expect(s.updateMode).toBe(mode)
      expect(s.autoUpdate).toBe(mode === 'auto')
      expect(JSON.parse(readFileSync(p, 'utf8')).updateMode).toBe(mode)
    }
    rmSync(TMP, { recursive: true })
  })

  it('migrates a pre-updateMode file: autoUpdate off meant "prompt", so it becomes notify', () => {
    mkdirSync(TMP, { recursive: true })
    const p = join(TMP, 'settings.json')
    writeFileSync(p, JSON.stringify({ autoUpdate: false, softwareRender: true }))
    expect(readSettings(p)).toMatchObject({ updateMode: 'notify', autoUpdate: false, softwareRender: true })
    writeFileSync(p, JSON.stringify({ autoUpdate: true }))
    expect(readSettings(p).updateMode).toBe('auto')
    rmSync(TMP, { recursive: true })
  })

  it('treats an unknown mode as auto', () => {
    mkdirSync(TMP, { recursive: true })
    const p = join(TMP, 'settings.json')
    writeFileSync(p, JSON.stringify({ updateMode: 'sometimes' }))
    expect(readSettings(p).updateMode).toBe('auto')
    rmSync(TMP, { recursive: true })
  })
})
