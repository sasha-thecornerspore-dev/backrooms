// Every renderer module the page can load must be in BOTH offline shell lists (the installed PWA's service worker and the
// gh-pages /play/ build), or the game works online and breaks offline. Renderer modules are flat siblings in src/renderer/.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const rendererDir = path.join(root, 'src', 'renderer')
const gfx = fs.readdirSync(rendererDir).filter((f) => /^gfx-.*\.js$/.test(f))
const sw = fs.readFileSync(path.join(root, 'src', 'sw.js'), 'utf8')
const build = fs.readFileSync(path.join(root, 'tools', 'build-play.sh'), 'utf8')

describe('offline shell lists', () => {
  it('finds the gfx modules', () => { expect(gfx.length).toBeGreaterThan(8) })
  for (const f of gfx) {
    it(`${f} is in src/sw.js and tools/build-play.sh`, () => {
      expect(sw).toContain(`'/renderer/${f}'`)
      expect(build).toContain(`'${f}'`)
    })
  }
})

// Beyond the gfx modules: every renderer module game.js reaches through static imports (the closure, one hop at a time) must be in both
// lists too, or a new import (messages.js, input.js, ...) works online and breaks the installed PWA offline.
describe('offline shell lists: the import closure of game.js', () => {
  const closure = new Set()
  const queue = ['game.js']
  while (queue.length) {
    const f = queue.shift()
    if (closure.has(f)) continue
    closure.add(f)
    const src = fs.readFileSync(path.join(rendererDir, f), 'utf8')
    for (const m of src.matchAll(/from\s+'\.\/([\w-]+\.js)'/g)) queue.push(m[1])
  }
  it('reaches the foundation modules', () => {
    expect(closure.has('messages.js')).toBe(true)
    expect(closure.has('input.js')).toBe(true)
  })
  for (const f of [...closure].sort()) {
    it(`${f} (imported by game.js) is in src/sw.js and tools/build-play.sh`, () => {
      expect(sw).toContain(`'/renderer/${f}'`)
      expect(build).toContain(`'${f}'`)
    })
  }
})
