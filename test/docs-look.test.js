// The docs follow vertical look (look.js): the mouse and the touch drag tilt the view up and down now, so the README and the manual stop
// saying there is no looking up or down, and both settings tables carry the two new rows with the defaults prefs.js gives them. The labels
// are read from the settings panel, so a renamed row turns this red until the docs follow.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { PREF_DEFAULTS } from '../src/renderer/prefs.js'

const root = path.resolve(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')
const readme = read('README.md'), manual = read('docs/manual.html'), html = read('src/renderer/index.html')
const section = (doc, from, to) => { const a = doc.indexOf(from), b = doc.indexOf(to, a + 1); expect(a, from).toBeGreaterThan(-1); expect(b, to).toBeGreaterThan(a); return doc.slice(a, b) }
const label = (id) => { const m = new RegExp(`<span>([^<]+?)\\s*<span class="set-hint">[^<]*</span></span><input type="checkbox" id="${id}"/>`).exec(html); expect(m, id).not.toBe(null); return m[1] }

describe('vertical look in the docs', () => {
  it('nobody says there is no looking up or down any more', () => {
    for (const doc of [readme, manual]) {
      expect(doc).not.toMatch(/no looking up or down/i)
      expect(doc).not.toMatch(/left and right only/i)
    }
  })
  it('the README: the first ten minutes, the controls and the phone say the view tilts', () => {
    const first = section(readme, '## the first ten minutes', '## ')
    expect(first).toContain('the mouse turns you left and right and tilts your view up and down')
    const controls = section(readme, '## controls', '## settings')
    expect(controls).toContain('| click | grab the mouse to look — left and right, and up and down (no key tilts the view) |')
    expect(controls).toContain('a drag anywhere else looks around — sideways to turn, up and down to tilt (a swipe that is mostly sideways only turns you)')
    expect(controls).toContain('← → turn (while the mouse is loose; turning so brings your view back level)')
    expect(first).toContain('**←** and **→** turn you, and bring your view back level.')
  })
  it('the README settings: both rows, named as the panel names them', () => {
    const settings = section(readme, '## settings', '## multiplayer').toLowerCase()
    expect(PREF_DEFAULTS.verticalLook).toBe(true); expect(PREF_DEFAULTS.invertVerticalLook).toBe(false)
    expect(settings).toContain(`| ${label('set-vlook').toLowerCase()} | the mouse and the touch drag tilt your view up and down too. off, the view stays level`)
    expect(settings).toContain(`| ${label('set-vlook-invert').toLowerCase()} | push up to look down.`)
  })
  it('the manual: your hands, the phone, lying down, settings and comfort', () => {
    const hands = section(manual, '<section id="hands">', '<section id="screen">')
    expect(hands).toContain('The mouse turns you left and right and tilts your view up and down')
    expect(hands).toContain('left and right, and up and down about a third of the view each way')
    expect(hands).toContain('no key tilts the view')
    expect(hands).toContain('Your light is in your hand: it points where you look.')
    expect(hands).toContain('sideways to turn, up and down to tilt your view')
    // the drag shares the mouse's sensitivity SETTING, not its rate (touch.js: 0.0055 a px to turn, 0.004 to tilt, against the mouse's 0.002)
    expect(hands).not.toContain('at the same sensitivity as a mouse')
    expect(hands).toContain('(a little slower than turning). A swipe that is mostly sideways only turns you')
    expect(hands).toContain('The mouse sensitivity setting applies here too.')
    // lying down does not let the mouse go (game.js goDown never exits the pointer lock): it still turns you, and the view settles level
    expect(hands).not.toMatch(/laid down[^.]*release the mouse/)
    expect(hands).toContain('Lying down (online) it stays grabbed and still turns you, but your view settles level.')
    expect(hands).toContain('turning with them brings your view back level; no key tilts the view')
    expect(manual).toContain('Your light goes out, your view sinks back level, a black veil comes over the screen')
    const settings = section(manual, '<section id="settings">', '</section>')
    expect(settings).toContain(`<tr><td class="k">${label('set-vlook')}</td><td data-label="choices">on / off</td><td data-label="starts as">on</td>`)
    expect(settings).toContain(`<tr><td class="k">${label('set-vlook-invert')}</td><td data-label="choices">on / off</td><td data-label="starts as">off</td>`)
    expect(settings.indexOf('Vertical look')).toBeGreaterThan(settings.indexOf('Mouse sensitivity'))
    const comfort = section(manual, '<section id="comfort">', '</section>')
    expect(comfort).toContain('switch off <b>vertical look</b> if a tilting view swims')
  })
  it('the in-game strings stay in the house style: the panel hints are lowercase, no digits, no exclamation marks', () => {
    for (const id of ['set-vlook', 'set-vlook-invert']) {
      const hint = new RegExp(`<span class="set-hint">([^<]*)</span></span><input type="checkbox" id="${id}"/>`).exec(html)[1]
      expect(hint).toBe(hint.toLowerCase()); expect(hint).not.toMatch(/[0-9!]/)
    }
  })
})
