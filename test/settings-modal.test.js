// PKG-5: at 1280x720 the settings panel's only exit (CLOSE) sat below the fold. The CLOSE row is now a sticky footer of the
// scrolling box, and Esc and a click on the backdrop close it through the SAME save-and-close function as the button.
// (index.html has no DOM test rig; the live page was checked with tools/gfx/page.cjs at 1280x720, 1024x600 and 390x844.)
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')

describe('settings modal exits (PKG-5)', () => {
  it('CLOSE lives in a sticky footer of the settings box', () => {
    expect(html).toMatch(/#settings-modal \.modal-foot \{[^}]*position:sticky;bottom:0/)
    expect(html).toMatch(/<div class="modal-foot">\s*<div class="modal-btns">\s*<button id="settings-close"/)
  })
  it('the button, Esc and the backdrop share one save-and-close path', () => {
    expect(html).toMatch(/async function closeSettings\(\) \{[\s\S]*?saveSettings[\s\S]*?settingsMod\.style\.display = 'none'/)
    expect(html).toMatch(/getElementById\('settings-close'\)\.onclick = closeSettings/)
    expect(html).toMatch(/settingsMod\.addEventListener\('click', \(e\) => \{ if \(e\.target === settingsMod && settingsDownOnBackdrop\) closeSettings\(\) \}\)/)
    expect(html).toMatch(/e\.key !== 'Escape' \|\| !settingsOpen\(\)\) return[\s\S]*?closeSettings\(\)\s*\}, true\)/)
  })
})
