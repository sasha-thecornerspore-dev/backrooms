// block-prebuild-wiring.test.js — the block's TexSet built ahead while the title is up (gfx-block-prebuild.test.js has the job itself):
// index.html starts game.js prebuildBlock in an idle callback once the title is up, prebuildBlock builds it from the very config buildLevel
// builds the block from, never once a run has begun, and buildLevel drops it for a run that starts anywhere else; the renderers take it
// through buildTexturesMemo.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

describe('the wiring', () => {
  const game = readFileSync(new URL('../src/renderer/game.js', import.meta.url), 'utf8')
  const page = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
  it('game.js builds it from the block\'s own config (levelConfig over world.json), never once a run has begun, and drops it elsewhere', () => {
    expect(game).toMatch(/export async function prebuildBlock\(o = \{\}\) \{\r?\n\s*if \(runStarted\) return null\r?\n\s*const base = await loadConfig\(\)\r?\n\s*return runStarted \? null : prebuildLevelTextures\(levelConfig\(base, BLOCK\), o\)/)
    expect(game).toMatch(/const base = await loadConfig\(\)\r?\n\s*runStarted = true/)
    expect(game).toMatch(/function buildLevel\(index, at = null\) \{\r?\n\s*const tb\s+= performance\.now\(\)\r?\n\s*if \(index !== BLOCK\) cancelPrebuilds\(\)/)
    expect(game).toContain("import { prebuildLevelTextures, cancelPrebuilds } from './gfx-textures.js'")
  })
  it('index.html starts it in an idle callback of its own while the title is up, queued after the backdrop\'s; gfxbench never reaches it', () => {
    expect(page).toContain("import { initGame, prebuildBlock } from './game.js'")
    expect(page).toContain('whenIdle(() => { if (titleUp()) prebuildBlock().catch(() => {}) })')
    expect(page.indexOf("import('./gfx-attract.js')")).toBeLessThan(page.indexOf('prebuildBlock().catch'))
    expect(page.indexOf("has('gfxbench')")).toBeLessThan(page.indexOf('prebuildBlock().catch'))
  })
  it('the renderers still take their TexSet from the memo (the handover point)', () => {
    const cpu = readFileSync(new URL('../src/renderer/gfx-cpu.js', import.meta.url), 'utf8')
    const gl = readFileSync(new URL('../src/renderer/gfx-gl.js', import.meta.url), 'utf8')
    expect(cpu).toContain('const tex     = buildTexturesMemo(config.palette, config.materials, config.look, LEVEL_KEY)')
    expect(gl).toContain('tex = (deps.buildTextures || buildTexturesMemo)(config.palette, config.materials, config.look, LEVEL_KEY)')
  })
})
