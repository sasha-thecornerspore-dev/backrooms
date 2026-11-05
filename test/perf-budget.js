// perf-budget.js — the wall-clock budget a timing test may spend, and where its timing is written down. Not a test file itself
// (vitest runs test/**/*.test.js only).
//
// Three tests time 600 steps of the simulation against the clock: frame-perf (the whole non-render frame), entities-hunt (the
// entity system alone) and compose-perception (the things with the file's four numbers on the aiCtx). Their budget, 150 ms, is
// written for a desk machine, where the three run in about 50, 28 and 22 ms warmed (2026-11-05, node 26).
//
// The suite runs in CI on GitHub's shared Linux runners only (node 22). They step the same code about twice as slowly as a desk,
// and differently from one job to the next: main's whole frame (04fd43d) took 85.1 ms warmed there against about 44 on a desk,
// more than half the budget before anything was added. On PR #25 (4277be8) the run that carried the budget took 157.9 ms in one
// job and 246.2 ms in another, the same commit in the same minute, and both failed on the clock alone. Two things met there:
//   - the test: 2.0.5 teaches the floor between its two runs, the engine rebuilds the hot path for the taught creatures, and the
//     second run paid for that instead of being the warmed one (two to three times main's on node 22; a sixth more on node 26).
//     frame-perf.test.js now walks the taught floor twice and budgets the better walk.
//   - the runner: half the budget gone on a good minute, and the two jobs a half apart on the same commit.
//
// So where CI is set the budget is CI_SLACK times wider. For the whole frame that is 600 ms for 600 frames, a millisecond a
// frame: still a sixteenth of a frame at sixty a second, so the simulation is still never what a frame waits on, even on a
// machine several times slower than a desk. Off CI the budget is exactly the one written, so a slow frame fails on the desk that
// wrote it. The identities each test pins (the one record handed back every frame) are exact everywhere.
import { appendFileSync } from 'node:fs'

export const CI_SLACK = 4

// CI as GitHub Actions and every other runner set it ("true" or "1"); empty, "false" and "0" are no CI at all
export function onCI(env = process.env) {
  const v = String(env.CI ?? '').trim().toLowerCase()
  return v !== '' && v !== 'false' && v !== '0'
}

// budgetMs(ms[, env]) -> the milliseconds this run may spend: ms off CI, ms * CI_SLACK on it
export function budgetMs(ms, env = process.env) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) throw new RangeError(`perf-budget: a budget is a positive number of ms, not ${String(ms)}`)
  return onCI(env) ? ms * CI_SLACK : ms
}

// note(label, ms1, ms2, budget[, env]) -> the line it wrote, or null. On GitHub Actions a step may append markdown to the file
// GITHUB_STEP_SUMMARY names, and it shows on the run's page: one line per timing test, pass or fail, so the next slow runner is
// read off the run instead of dug out of a step log (frame-perf prints its own there; the other two print nothing). Anywhere
// else, and on any error, it writes nothing: a timing is never why a test fails here.
export function note(label, ms1, ms2, budget, env = process.env) {
  try {
    const file = env.GITHUB_STEP_SUMMARY
    if (!file) return null
    const best = Math.min(ms1, ms2)
    const line = `- ${label}: ${best.toFixed(1)} ms the better of ${ms1.toFixed(1)} / ${ms2.toFixed(1)}, budget ${budget} ms (${Math.round((best / budget) * 100)}%)\n`
    appendFileSync(file, line)
    return line
  } catch { return null }
}
