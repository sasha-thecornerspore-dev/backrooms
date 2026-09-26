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
