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
