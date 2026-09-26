// PKG-6: the field console (/recover, /cases, /file) read the case manifests from '../recover/cases/', which cannot exist
// under the desktop app's file:// page. On file: they now come from the public site (the origin /play/ is served from),
// a fetch that never reaches it says "no signal", and the PWA path is untouched. (initGame has no DOM test rig; the live
// page was checked with tools/gfx/page.cjs: /cases fetched https://backrooms.thecornerspore.dev/recover/cases/index.json
// with a 200, and a failing fetch showed the no-signal message.)
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

const src = readFileSync(new URL('../src/renderer/game.js', import.meta.url), 'utf8')

describe('field console case manifests (PKG-6)', () => {
  it('reads from the public https origin only when the page is file://', () => {
    expect(src).toMatch(/const RECOVER_REMOTE = typeof location !== 'undefined' && location\.protocol === 'file:'/)
    expect(src).toMatch(/const RECOVER_BASE = RECOVER_REMOTE \? 'https:\/\/backrooms\.thecornerspore\.dev\/recover\/cases\/' : '\.\.\/recover\/cases\/'/)
  })
  it('every manifest fetch goes through RECOVER_BASE', () => {
    expect(src).not.toMatch(/fetch\('\.\.\/recover/)
    expect(src).toMatch(/fetch\(RECOVER_BASE \+ 'index\.json', \{ cache: 'no-store' \}\)/)
    expect(src).toMatch(/fetch\(RECOVER_BASE \+ want \+ '\.json', \{ cache: 'no-store' \}\)/)
  })
  it('a network failure on desktop says so; everything else keeps the old message', () => {
    expect(src).toMatch(/if \(RECOVER_REMOTE && e && e\.name === 'TypeError'\) showMessage\('no signal\./)
    expect(src).toMatch(/else showMessage\('the file could not be opened from here\.'\)/)
  })
})
