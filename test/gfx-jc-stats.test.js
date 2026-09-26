// Fixer JC, H-CORE-4 / E2E-2: the ?gfxstats=1 panel overlapped the centre message (the level-name plate) and was cut off / covered by the chat
// on phones. It now has a slot per layout (STATS_CSS: desktop top-right under the gear, portrait phone in the cluster's flow, short screen
// between the cluster and the touch controls), wraps instead of clipping, and keeps #msg below its bottom edge. The real-page check (no
// overlap with any visible HUD element at 1280x720, 1024x600, 390x844, 844x390, 932x430, CPU and GPU) is tools/gfx/page.cjs --query
// '?gfxstats=1' --demo with a rect-intersection --eval; this file pins the pieces that make it so.
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import { statsLines, createStatsOverlay, STATS_CSS } from '../src/renderer/gfx-stats.js'

const html = fs.readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')

describe('what the panel says', () => {
  it('the level start is two short lines (the numbers that used to be cut off on a phone are on their own line)', () => {
    const l = statsLines({ kind: 'cpu', why: 'x', levelStart: { level: 2, buildMs: 224.23, gfxMs: 149.1, firstMs: 897.3, readyMs: 1947.5 } }, { n: 0 })
    expect(l.slice(-2)).toEqual(['level 2 start: build 224.2 (renderer 149.1) ms', '  first frame 897.3 · ready 1947.5 ms'])
    for (const s of l.slice(-2)) expect(s.length).toBeLessThanOrEqual(50)
  })
})

describe('where it goes (STATS_CSS)', () => {
  it('wraps long lines instead of clipping them', () => {
    expect(STATS_CSS).toMatch(/#gfx-stats \{[^}]*white-space: pre-wrap/)
    expect(STATS_CSS).not.toMatch(/overflow: hidden/)
  })
  it('desktop: fixed top-right, under the settings gear (38 px tall at max(12px, safe-area) in index.html), clear of the gauges on the left', () => {
    expect(html).toMatch(/body #btn-settings \{\s*top: max\(12px, env\(safe-area-inset-top\)\); right: max\(12px, env\(safe-area-inset-right\)\);[^}]*height: 38px/)
    expect(STATS_CSS).toMatch(/#hud-cluster > #gfx-stats \{ position: fixed; top: calc\(max\(12px, env\(safe-area-inset-top\)\) \+ 46px\); right: max\(12px, env\(safe-area-inset-right\)\);/)
    expect(STATS_CSS).toMatch(/max-width: min\(620px, calc\(100vw - 300px\)\)/)
  })
  it('portrait phone: in the cluster flow; short screen: fixed at the top right of the cluster, clear of the touch column', () => {
    const portrait = /@media \(max-width: 700px\) \{([\s\S]*?)\n\}/.exec(STATS_CSS)[1]
    expect(portrait).toMatch(/#hud-cluster > #gfx-stats \{ position: static;/)
    const short = /@media \(max-height: 460px\) \{([\s\S]*?)\n\}/.exec(STATS_CSS)[1]
    expect(short).toMatch(/position: fixed; top: max\(10px, env\(safe-area-inset-top\)\); right: auto; left: var\(--gfx-stats-left, 276px\)/)
    expect(short).toMatch(/max-width: calc\(100vw - var\(--gfx-stats-left, 276px\) - 116px\)/)
    // the short-screen block comes last, so a short AND narrow window gets the short-screen slot
    expect(STATS_CSS.indexOf('@media (max-height: 460px)')).toBeGreaterThan(STATS_CSS.indexOf('@media (max-width: 700px)'))
  })
  it('the centre message never sits above the panel, and its own tops are index.html\'s (34%, 30% on phones)', () => {
    expect(html).toMatch(/#msg \{\s*position: fixed; top: 34%;/)
    expect(/@media \(max-width: 700px\) \{[\s\S]*?#msg \{ top: 30%;/.test(html)).toBe(true)
    expect(STATS_CSS).toMatch(/body\.gfx-stats-on #msg \{ top: max\(34%, var\(--gfx-stats-clear, 0px\)\); \}/)
    expect(STATS_CSS).toMatch(/@media \(max-width: 700px\) \{[\s\S]*body\.gfx-stats-on #msg \{ top: max\(30%, var\(--gfx-stats-clear, 0px\)\); \}/)
  })
})

// a DOM with just enough for the placement plumbing
function fakeDoc({ panelBottom = 120, clusterRight = 244 } = {}) {
  const props = new Map()
  const classes = new Set()
  const mk = (tag) => ({
    tag, style: {}, attrs: {}, children: [], textContent: '', id: '',
    setAttribute(k, v) { this.attrs[k] = v }, appendChild(c) { this.children.push(c); c.parent = this },
    remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null } },
    getBoundingClientRect: () => (tag === 'div' ? { bottom: panelBottom, right: 600 } : { bottom: 200, right: clusterRight }),
  })
  const doc = {
    head: mk('head'), body: Object.assign(mk('body'), { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } }),
    documentElement: { style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) } },
    createElement: mk, props, classes,
  }
  return doc
}
describe('createStatsOverlay in the game (a parent: the HUD cluster)', () => {
  it('adds its placement rules, a body class and the two edges while it exists, and takes all of it away on dispose', () => {
    const doc = fakeDoc(), parent = doc.createElement('section')
    const timers = { setInterval: vi.fn(() => 3), clearInterval: vi.fn() }
    const o = createStatsOverlay({ doc, parent, read: () => ({ kind: 'cpu' }), timers })
    expect(doc.head.children.length).toBe(1)
    expect(doc.head.children[0].textContent).toBe(STATS_CSS)
    expect(doc.classes.has('gfx-stats-on')).toBe(true)
    expect(doc.props.get('--gfx-stats-clear')).toBe('128px')                 // the panel's bottom + 8
    expect(doc.props.get('--gfx-stats-left')).toBe('256px')                  // the cluster's right edge + 12
    expect(o.el.style.whiteSpace).toBeUndefined(); expect(o.el.style.overflow).toBeUndefined(); expect(o.el.style.position).toBeUndefined()
    o.dispose()
    expect(doc.head.children.length).toBe(0); expect(doc.classes.size).toBe(0); expect(doc.props.size).toBe(0)
  })
  it('without a parent (no game HUD) it adds no rules and publishes nothing', () => {
    const doc = fakeDoc()
    const o = createStatsOverlay({ doc, read: () => null, timers: { setInterval: () => 1, clearInterval: () => {} } })
    expect(doc.head.children.length).toBe(0); expect(doc.classes.size).toBe(0); expect(doc.props.size).toBe(0)
    expect(o.el.style.position).toBe('fixed')
  })
})
