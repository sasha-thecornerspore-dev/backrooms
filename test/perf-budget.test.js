// perf-budget.js: the wall-clock budgets are a desk machine's, four times wider on a shared CI runner, and each timing is
// written to the run's summary on GitHub Actions (2.0.5, PR #25).
import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { budgetMs, CI_SLACK, onCI, note } from './perf-budget.js'

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8')

describe('perf-budget: the budget a timing test may spend', () => {
  it('is the written budget off CI, and CI_SLACK times it where CI is set', () => {
    expect(CI_SLACK).toBe(4)
    expect(budgetMs(150, {})).toBe(150)
    expect(budgetMs(150, { CI: 'true' })).toBe(600)
    expect(budgetMs(150, { CI: '1' })).toBe(600)
    expect(budgetMs(40, { CI: 'true' })).toBe(160)
  })

  it('reads an empty, "false" or "0" CI as no CI at all', () => {
    for (const v of [undefined, '', ' ', 'false', 'FALSE', '0']) {
      expect(onCI({ CI: v }), String(v)).toBe(false)
      expect(budgetMs(150, { CI: v }), String(v)).toBe(150)
    }
    for (const v of ['true', 'TRUE', '1', 'yes']) expect(onCI({ CI: v }), v).toBe(true)
  })

  it('reads this process when no environment is handed over', () => {
    expect(budgetMs(150)).toBe(onCI(process.env) ? 600 : 150)
  })

  it('refuses a budget that is not a positive number', () => {
    for (const bad of [0, -1, NaN, Infinity, '150', undefined]) expect(() => budgetMs(bad, {}), String(bad)).toThrow(RangeError)
  })

  it('the PR #25 runs fit the CI budget and the desk runs fit the desk budget', () => {
    // the two Linux jobs that failed at 150 ms (warmed), and the cold runs beside them
    for (const ms of [157.9, 246.2, 267.6, 351.1]) expect(ms).toBeLessThan(budgetMs(150, { CI: 'true' }))
    for (const ms of [51.6, 28.8, 22.3]) expect(ms).toBeLessThan(budgetMs(150, {}))
  })
})

describe('perf-budget: note() writes a timing to the run summary', () => {
  it('appends one markdown line per call to the file GITHUB_STEP_SUMMARY names, and hands the line back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-budget-'))
    try {
      const file = join(dir, 'summary.md')
      const env = { GITHUB_STEP_SUMMARY: file }
      const a = note('frame-perf', 267.6, 157.9, 600, env)
      const b = note('entities-hunt', 40.25, 28.84, 150, env)
      expect(a).toBe('- frame-perf: 157.9 ms the better of 267.6 / 157.9, budget 600 ms (26%)\n')
      expect(b).toBe('- entities-hunt: 28.8 ms the better of 40.3 / 28.8, budget 150 ms (19%)\n')
      expect(readFileSync(file, 'utf8')).toBe(a + b)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('writes nothing, and says so, where there is no summary file', () => {
    expect(note('frame-perf', 10, 20, 150, {})).toBe(null)
    expect(note('frame-perf', 10, 20, 150, { GITHUB_STEP_SUMMARY: '' })).toBe(null)
  })

  it('never throws: a summary that cannot be written is null, not a failed test', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-budget-'))
    try {
      // the directory itself cannot be appended to as a file; neither can a file under a folder that is not there
      expect(note('frame-perf', 10, 20, 150, { GITHUB_STEP_SUMMARY: dir })).toBe(null)
      const gone = join(dir, 'no-such-folder', 'summary.md')
      expect(note('frame-perf', 10, 20, 150, { GITHUB_STEP_SUMMARY: gone })).toBe(null)
      expect(existsSync(gone)).toBe(false)
      // a timing that is not a number (a test edited badly) is null too, and nothing is written
      const file = join(dir, 'summary.md')
      expect(note('frame-perf', undefined, 20, 150, { GITHUB_STEP_SUMMARY: file })).toBe(null)
      expect(note('frame-perf', 10, '20', 150, { GITHUB_STEP_SUMMARY: file })).toBe(null)
      expect(note('frame-perf', 10, 20, 150, null)).toBe(null)
      expect(existsSync(file)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('the three timing tests take their budget from perf-budget.js', () => {
  const FILES = { './frame-perf.test.js': 'frame-perf', './entities-hunt.test.js': 'entities-hunt', './compose-perception.test.js': 'compose-perception' }

  it('each imports budgetMs and note, spends budgetMs(150) once, never a bare 150, and notes its two runs under its own name', () => {
    for (const [f, label] of Object.entries(FILES)) {
      const s = read(f)
      expect(s, f).toContain("import { budgetMs, note } from './perf-budget.js'")
      expect(s.split('budgetMs(150)').length - 1, f).toBe(1)
      expect(s, f).not.toMatch(/toBeLessThan\(150\)/)
      expect(s, f).not.toMatch(/BUDGET_MS = 150\b/)
      expect(s.split(`note('${label}', ms1, ms2, `).length - 1, f).toBe(1)
    }
  })

  it('the note is written before the budget is asserted, so a failed run still leaves its timing', () => {
    for (const [f, label] of Object.entries(FILES)) {
      const s = read(f)
      const at = s.indexOf(`note('${label}', ms1, ms2, `)
      const budgetAssert = s.indexOf(' ms`).toBeLessThan(')                     // the one assertion that carries the two timings in its message
      expect(s.split(' ms`).toBeLessThan(').length - 1, f).toBe(1)
      expect(at, f).toBeGreaterThan(-1)
      expect(budgetAssert, f).toBeGreaterThan(at)
    }
  })

  it("gfx-surfaces' timed ceilings are hang guards of ten seconds or more, not budgets", () => {
    // the one other place a test asserts on the clock; a new timing test should come through perf-budget.js
    const timed = /performance\.now\(\) - t0[^\n]*toBeLessThan\((\d+)\)/g
    const hits = [...read('./gfx-surfaces.test.js').matchAll(timed)]
    expect(hits.length).toBeGreaterThan(0)
    for (const m of hits) expect(Number(m[1])).toBeGreaterThanOrEqual(10000)
  })

  it('frame-perf walks the taught floor twice and budgets the better walk, so the budget is never spent on the engine re-warming', () => {
    const s = read('./frame-perf.test.js')
    expect(s).toContain('const ms2a = run(FRAMES), ms2b = run(FRAMES), ms2 = Math.min(ms2a, ms2b)')
    expect(s).toContain('expect(S.frame).toBe(3 * FRAMES)')
    expect(s).not.toContain('2 * FRAMES')
  })
})

describe('a test is not timed out by a slow runner', () => {
  it('the suite-wide timeout is thirty seconds or more (vitest.config.js), not the five a desk needs', async () => {
    // learn.test.js's slowest test: 0.9 s on a desk, 1.2 and 1.7 s on the two PR #25 runners, against vitest's default 5 s
    const config = (await import('../vitest.config.js')).default
    expect(config.test.testTimeout).toBeGreaterThanOrEqual(30000)
  })
})
