// PKG-6: the field console (/recover, /cases, /file) read the case manifests from '../recover/cases/', which cannot exist
// under the desktop app's file:// page. On file: they now come from the public site (the origin /play/ is served from),
// a fetch that never reaches it says "no signal", and the PWA path is untouched. (initGame has no DOM test rig; the live
// page was checked with tools/gfx/page.cjs: /cases fetched https://backrooms.thecornerspore.dev/recover/cases/index.json
// with a 200, and a failing fetch showed the no-signal message.)
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

const src = readFileSync(new URL('../src/renderer/game.js', import.meta.url), 'utf8')
const site = readFileSync(new URL('../src/renderer/site.js', import.meta.url), 'utf8')

describe('field console case manifests (PKG-6)', () => {
  // (launch-fixes F7: not only file:// — itch's CDN 403s a ../ path and localhost has no /recover/, so the site's own https origin is read
  // whenever the page is not on the site; site.js recoverBase is pinned in test/site.test.js)
  it('reads from the public https origin whenever the page is not on the site (file://, itch, localhost)', () => {
    expect(src).toMatch(/const RECOVER_BASE = recoverBase\(typeof location === 'undefined' \? null : location\)/)
    expect(src).toMatch(/const RECOVER_REMOTE = RECOVER_BASE !== RECOVER_LOCAL/)
    expect(site).toMatch(/export const RECOVER_SITE = SITE_ORIGIN \+ '\/recover\/cases\/'/)
    expect(site).toMatch(/export const SITE_ORIGIN = 'https:\/\/backrooms\.thecornerspore\.dev'/)
    expect(site).toMatch(/export const RECOVER_LOCAL = '\.\.\/recover\/cases\/'/)
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
