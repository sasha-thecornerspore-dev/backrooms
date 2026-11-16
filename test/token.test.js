// The way out token (wish #29): an item with no use anyone can see, that seems important not to throw away.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { TOKEN, TOKEN_LINE, TOKEN_ODDS, trayToken } from '../src/renderer/token.js'
import { createItemSystem, KEPT } from '../src/renderer/items.js'
import { resolveDeath } from '../src/renderer/death.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'

const game = readFileSync(new URL('../src/renderer/game.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const holding = (inv) => { const s = createItemSystem({ ...DEFAULT_CONFIG }, () => false); for (const it of inv) s.grant(it.type, it.extra ?? {}); return s }

describe('the way out token (wish #29)', () => {
  it('is called a way out token and says only that it seems important not to throw it away', () => {
    expect(TOKEN).toBe('way-out-token')
    expect(TOKEN_LINE).toContain('way out token')
    expect(TOKEN_LINE).toContain('seems important not to throw it away')
  })

  it('a machine draw gives it one time in TOKEN_ODDS, and never to a hand that already holds one', () => {
    expect(TOKEN_ODDS).toBe(25)
    expect(trayToken([], 0)).toBe(true)
    expect(trayToken([], 1 / TOKEN_ODDS - 1e-9)).toBe(true)
    expect(trayToken([], 1 / TOKEN_ODDS)).toBe(false)
    expect(trayToken([], 0.9)).toBe(false)
    expect(trayToken([{ type: 'bandage' }], 0)).toBe(true)
    expect(trayToken([{ type: 'bandage' }, { type: TOKEN, tool: true }], 0)).toBe(false)
    expect(trayToken(null, 0)).toBe(true)
    expect(trayToken([], NaN)).toBe(false)
    expect(trayToken([], -0.1)).toBe(false)
    // about one draw in 25 over many
    let n = 0
    for (let i = 0; i < 10000; i++) if (trayToken([], i / 10000)) n++
    expect(n).toBe(400)
  })

  it('is kept: never thrown, never set down with a word, and using it spends nothing (flag or no flag)', () => {
    expect(KEPT.has(TOKEN)).toBe(true)
    for (const extra of [{ tool: true }, {}]) {
      const sys = holding([{ type: TOKEN, extra }])
      expect(sys.throwSelected(0, 0, 0, 0)).toEqual({ ok: false, reason: 'kept' })
      expect(sys.throwSelected(0, 0, 0, 0, { ph: 1, oct: 0 })).toEqual({ ok: false, reason: 'kept' })
      expect(sys.useSelected()).toEqual({ type: TOKEN, tool: true })
      expect(sys.useSelected()).toEqual({ type: TOKEN, tool: true })
      expect(sys.inventory.map((i) => i.type)).toEqual([TOKEN])
    }
  })

  it('is never lost in a fall, held or not, flag or no flag', () => {
    for (const tok of [{ type: TOKEN, tool: true }, { type: TOKEN }]) {
      const r = resolveDeath({ level: 2, inventory: [{ type: 'bandage' }, tok], selected: 1, maxHp: 100, deaths: 0 })
      expect(r.dropped).toBeNull()
      expect(r.inventory).toEqual([{ type: 'bandage' }, tok])
    }
  })

  it('game.js names it, a machine on any floor drops it as a tool, and using it shows the line', () => {
    expect(game).toContain("import { TOKEN, TOKEN_LINE, trayToken } from './token.js'")
    expect(game).toMatch(/const ITEM_NAMES = \{[\s\S]*?'way-out-token':\s+'way out token',\n\}/)
    expect(game).toMatch(/const TRAY_NAMES = \{[\s\S]*?'way-out-token':\s+'a way out token',\n\}/)
    const vend = game.slice(game.indexOf('function dispenseFromMachine'), game.indexOf('// ── snapshot + persistence'))
    expect(vend).toContain('const type = trayToken(itemSys.inventory, Math.random()) ? TOKEN : pool[Math.floor(Math.random() * pool.length)]')
    expect(vend).toContain("const extra = type === 'plumb' || type === TOKEN ? { tool: true } : (sour ? { sour: true } : {})")
    // drawn before any floor's pool is consulted: the deep-stack branch does not gate it
    expect(vend.indexOf('trayToken(')).toBeGreaterThan(vend.indexOf('if (dfloor === 2 || dfloor === 3)'))
    expect(vend).not.toMatch(/if \(dfloor[^\n]*trayToken/)
    const eff = game.slice(game.indexOf('function applyItemEffect'), game.indexOf('// ── ambient events'))
    expect(eff).toMatch(/\} else if \(eff\.type === TOKEN\) \{\n(?:\s*\/\/[^\n]*\n)*\s*showMessage\(TOKEN_LINE\)\n\s*\}/)
  })
})
