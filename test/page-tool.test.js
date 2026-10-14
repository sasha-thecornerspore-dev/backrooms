// tools/gfx/page.cjs — the boot-check tool (W5): a hidden Electron window runs requestAnimationFrame only when a frame is forced, so a
// keydown + keyup pair dispatched inside ONE --eval never reached the game loop and a broken key handler passed the boot check unnoticed.
// --pump N forces N frames after each --eval statement (--eval may now be repeated), --drive FILE runs a main-process key sequence with
// frames interleaved, and window.backrooms.logError is stubbed before the game is entered so a per-frame exception the loop swallows
// counts as a [page error]. page.cjs needs Electron, so its pure argument parser is tested by extraction and the rest by source guards.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '..', 'tools', 'gfx', 'page.cjs'), 'utf8').replace(/\r\n/g, '\n')
const fnSrc = /function parseArgs\(argv\) \{[\s\S]*?\n\}/.exec(src)[0]
const parseArgs = new Function(fnSrc + '\nreturn parseArgs')()   // the parser has no dependencies: lift it out of the Electron script

describe('page.cjs argument parser', () => {
  it('collects a repeated --eval in order, as a list even when given once', () => {
    expect(parseArgs(['--eval', 'a()', '--level', '1', '--eval', 'b()']).val.eval).toEqual(['a()', 'b()'])
    expect(parseArgs(['--eval', 'only()']).val.eval).toEqual(['only()'])
    expect(parseArgs(['--level', '1']).val.eval).toBeUndefined()
  })
  it('--pump and --drive take a value; the old flags and values are unchanged', () => {
    const { val, flags } = parseArgs(['--start', '--pump', '3', '--drive', 'x/drive.cjs', '--w', '960', '--verbose'])
    expect(val.pump).toBe('3')
    expect(val.drive).toBe('x/drive.cjs')
    expect(val.w).toBe('960')
    expect(flags.has('start')).toBe(true); expect(flags.has('verbose')).toBe(true)
    expect(flags.has('pump')).toBe(false); expect(flags.has('drive')).toBe(false)
  })
})

describe('page.cjs frame pumping and the loop-error bridge (source guards)', () => {
  it('pump(n) forces n frames with capturePage, and every --eval statement is followed by a pump', () => {
    expect(src).toMatch(/const pump = async \(n\) => \{ for \(let i = 0; i < n; i\+\+\) \{ await wc\.capturePage\(\); await sleep\(20\) \} \}/)
    expect(src).toContain('for (const js of evals) { await exec(js); if (pumpN) await pump(pumpN); else await sleep(200) }')
    expect(src).toContain("const pumpN = Number(val.pump || 0)")
    expect(src).not.toMatch(/if \(val\.eval\) \{ await exec\(val\.eval\)/)   // the single-statement path is gone
  })
  it('--drive loads a .cjs or an ESM module and hands it the frame-interleaving helpers', () => {
    expect(src).toMatch(/try \{ drive = require\(file\) \} catch \(e\) \{ if \(e\.code !== 'ERR_REQUIRE_ESM'\) throw e; drive = \(await import\(pathToFileURL\(file\)\.href\)\)\.default \}/)
    expect(src).toContain('await drive({ exec, pump, key, tap, hold, state, sleep, log, wc, errors, flags, val })')
    // tap = down, frames, up; hold repeats the keydown every 8 frames like a real keyboard and releases at the end
    expect(src).toContain("const tap = async (code, frames = 2) => { await key('keydown', code); await pump(frames); await key('keyup', code) }")
    expect(src).toMatch(/const hold = async \(code, frames\) => \{ await key\('keydown', code\); for [^\n]*if \(i % 8 === 7\) await key\('keydown', code, true\); await pump\(1\) \} await key\('keyup', code\) \}/)
  })
  it('stubs window.backrooms.logError to console.error BEFORE the game is entered, with the stall watchdog downgraded to a warning', () => {
    const stub = src.indexOf("window.backrooms = { logError: (m) => (/STALLED/.test(String(m)) ? console.warn : console.error)('[loop] ' + m) }")
    const cont = src.indexOf("document.getElementById('btn-continue').click()")
    const solo = src.indexOf("document.getElementById('btn-solo').click()")
    const start = src.indexOf('if (wantStart) {')
    expect(stub).toBeGreaterThan(start)
    expect(stub).toBeLessThan(cont); expect(stub).toBeLessThan(solo)
    expect(src.slice(stub - 40, stub)).toContain('if (!window.backrooms)')   // never shadows a real preload bridge
  })
  it('documents --pump and --drive in the usage header', () => {
    expect(src).toMatch(/^\/\/ {3}--pump N {11}force N frames/m)
    expect(src).toMatch(/^\/\/ {3}--drive FILE {7}a \.cjs \/ \.mjs module exporting async \(ctx\) => \{\}/m)
    expect(src).toMatch(/--eval JS[^\n]*\n\/\/ {22}May be repeated/)
  })
})

// --nohud (launch-fixes F6): a clean capture. The game's own HUD is hidden by CSS — the gauges cluster, the item dock, the compass's
// waypoint line, the controls line (#hint, which the touch layout already hides the same way) and the settings gear — nothing is painted over.
describe('page.cjs --nohud', () => {
  it('is a flag, not a valued option', () => {
    const { val, flags } = parseArgs(['--start', '--nohud', '--w', '960'])
    expect(flags.has('nohud')).toBe(true)
    expect(val.w).toBe('960')
    expect('nohud' in val).toBe(false)
  })
  it('hides #hud-cluster, the dock, the compass, #hint and the settings gear with one display:none !important rule (beats inline styles)', () => {
    const css = /const NOHUD_CSS = '([^']*)'/.exec(src)
    expect(css).toBeTruthy()
    expect(css[1]).toBe('#hud-cluster, #hotbar-dock, #exit-compass, #hint, #btn-settings { display: none !important }')
  })
  it('injects it as a <style> once the page is up (before the settle, the --demo fill, the --eval statements and the capture), only with the flag', () => {
    const inject = src.indexOf("if (flags.has('nohud')) await exec(")
    expect(inject).toBeGreaterThan(src.indexOf('if (wantStart) {'))
    expect(inject).toBeLessThan(src.indexOf('await sleep(Number(val.wait'))
    expect(inject).toBeLessThan(src.indexOf("if (flags.has('demo')) {"))
    expect(inject).toBeLessThan(src.indexOf('for (const js of evals)'))
    expect(src.slice(inject, src.indexOf('\n', inject))).toContain("document.createElement('style')")
    expect(src.slice(inject, src.indexOf('\n', inject))).toContain('NOHUD_CSS')
  })
  it('is documented in the usage header', () => {
    expect(src).toMatch(/^\/\/ {3}--nohud {12}hide the HUD/m)
  })
})

// --save / --force-size / --osr (the promo-shot copy of page.cjs, brought home): --save is merged over the save --level plants, so a
// capture starts the camera at a chosen x / y / angle; --force-size resizes the window's content to exactly --w x --h after it is made
// (Windows clamps a new window to the screen's work area: 1920x1080 on a 1080p screen came out short); --osr renders offscreen.
describe('page.cjs --save, --force-size and --osr', () => {
  it('--save takes a value; --force-size and --osr are flags; the old options are unchanged', () => {
    const save = '{"x":33.5,"y":11.5,"angle":0}'
    const { val, flags } = parseArgs(['--level', '0', '--save', save, '--force-size', '--osr', '--nohud', '--w', '1920', '--h', '1080'])
    expect(val.save).toBe(save)
    expect(flags.has('save')).toBe(false)
    expect(flags.has('force-size')).toBe(true); expect(flags.has('osr')).toBe(true); expect(flags.has('nohud')).toBe(true)
    expect('force-size' in val).toBe(false); expect('osr' in val).toBe(false)
    expect([val.level, val.w, val.h]).toEqual(['0', '1920', '1080'])
  })
  it('merges --save over the planted save, after level ∅ drops x / y for its authored spawn and before the save is written', () => {
    const merge = src.indexOf('if (val.save) Object.assign(save, JSON.parse(val.save))')
    const spawn = src.indexOf('if (lv === 4) { save.x = undefined; save.y = undefined }')
    const write = src.indexOf("await exec(`localStorage.setItem('backrooms:save'")
    expect(merge).toBeGreaterThan(src.indexOf('if (levelArg !== undefined) {'))
    expect(spawn).toBeGreaterThan(0)
    expect(merge).toBeGreaterThan(spawn)    // a --save with x / y wins over the fixed map's spawn; one without them keeps it
    expect(merge).toBeLessThan(write)
  })
  it('refuses --save without --level (there is no planted save to merge it into)', () => {
    expect(src).toMatch(/if \(val\.save !== undefined && levelArg === undefined\) \{[^\n]*process\.exit\(2\) \}/)
  })
  it('--force-size sets the content bounds and size to W x H right after the window is made; --osr turns on offscreen rendering', () => {
    const made = src.indexOf('const win = new BrowserWindow({')
    const force = src.indexOf("if (flags.has('force-size')) { win.setContentBounds({ x: 0, y: 0, width: W, height: H }); win.setContentSize(W, H);")
    expect(force).toBeGreaterThan(made)
    expect(force).toBeLessThan(src.indexOf('await win.loadURL(url)'))
    expect(src.slice(made, force)).toContain("offscreen: flags.has('osr')")
  })
  it('reports the size actually captured and warns when it is not the size asked for', () => {
    expect(src).toContain('const got = nativeImage.createFromBuffer(png).getSize()')
    expect(src).toMatch(/if \(got\.width !== W \|\| got\.height !== H\) process\.stderr\.write\(`\[page warn\] captured/)
  })
  it('keeps --nohud, --door and the lobby-first wording', () => {
    expect(src).toContain("const wantStart = flags.has('start') || flags.has('door') || levelArg !== undefined")
    expect(src).toMatch(/^\/\/ {3}--start {12}click SOLO and wait for the running game \(a fresh solo run comes in through the lobby, level 0\)/m)
    expect(src).toContain("if (flags.has('nohud')) await exec(")
  })
  it('documents all three in the usage header', () => {
    expect(src).toMatch(/^\/\/ {3}--save JSON {8}with --level: merged over the planted save \(Object\.assign\)/m)
    expect(src).toMatch(/^\/\/ {3}--force-size {7}size the window's CONTENT to exactly --w x --h/m)
    expect(src).toMatch(/^\/\/ {3}--osr {14}offscreen rendering \(webPreferences\.offscreen\)/m)
  })
})
