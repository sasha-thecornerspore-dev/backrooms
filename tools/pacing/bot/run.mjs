// run.mjs — the playtest bot's sessions on ONE tree, in parallel: instrument a scratch copy of the tree's src (patch.mjs; the tree itself
// is never written), then run tools/gfx/page.cjs on that copy with session.cjs as its --drive, one hidden Electron window per session.
// Game time is the clamped play clock, so a busy machine only stretches the wall time.
//
//   node tools/pacing/bot/run.mjs --tree <worktree> --out <scratch dir> [--sessions level0,level1,level2,level3,fresh-takes-way]
//                                 [--seconds 180] [--parallel 5] [--electron <electron.exe>] [--timeout 1500] [--seeds 601,602,...]
//
// Sessions (the 2.0.3 catch-up's, same seeds and saves):
//   level0           a fresh solo run (SOLO, the fixed world), staying in the lobby
//   level1..level3   a planted save on that floor (a resume), staying there
//   fresh-takes-way  a fresh solo run that takes every way it stands at and follows the compass when nothing in view calls it
// Each session writes <out>/<name>/{log.jsonl, summary.json, frames/, last.png, run.txt}; then stats.mjs reads them.
// Electron and node will not start from a long cwd on Windows: every process here runs with cwd = the tree root (keep it short).
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, createWriteStream, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, REPO } from '../lib.mjs'
import { patchTree } from './patch.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { val } = parseArgs(process.argv.slice(2), ['tree', 'out', 'sessions', 'seconds', 'parallel', 'electron', 'timeout', 'seeds'])
const tree = path.resolve(val.tree ?? REPO)
const outDir = path.resolve(val.out ?? path.join(tree, '..', 'pacing-bot'))
const SECONDS = Number(val.seconds ?? 180)
const PAR = Number(val.parallel ?? 5)
const electron = path.resolve(val.electron ?? path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'))
const pageCjs = path.join(REPO, 'tools', 'gfx', 'page.cjs')
const FILE = { origin: 'unnamed', filed: true, intakeCtx: { route: 'solo', arrival: 'walked', name: '' } }
export const SESSIONS = {
  level0: { start: true, seed: 101 },
  level1: { level: 1, seed: 202, save: { x: 11.5, y: 11.5, angle: 0.8, ...FILE } },
  level2: { level: 2, seed: 303, save: { x: 11.5, y: 11.5, angle: 2.4, ...FILE } },
  level3: { level: 3, seed: 404, save: { x: 11.5, y: 11.5, angle: -0.7, ...FILE } },
  'fresh-takes-way': { start: true, seed: 505, takeWays: true, follow: true },
}
const base = (val.sessions ?? Object.keys(SESSIONS).join(',')).split(',')
for (const n of base) if (!SESSIONS[n]) throw new Error('unknown session ' + n)
// --seeds 601,602: each listed session once per seed instead of its own, as <name>-s<seed> (more samples of a one-off number, such as
// the fresh run's time in the lobby)
const seeds = val.seeds ? val.seeds.split(',').map(Number) : null
const names = seeds ? base.flatMap((n) => seeds.map((s) => `${n}-s${s}`)) : base
const sessionOf = (name) => { const m = /^(.*)-s(\d+)$/.exec(name); return m ? { ...SESSIONS[m[1]], seed: Number(m[2]) } : SESSIONS[name] }
if (!existsSync(electron)) throw new Error('no electron at ' + electron)

mkdirSync(outDir, { recursive: true })
const rep = patchTree(path.join(tree, 'src'), path.join(outDir, 'src'))
writeFileSync(path.join(outDir, 'patch.json'), JSON.stringify({ tree, ...rep }, null, 1))
process.stderr.write(`[bot] instrumented copy ${rep.renderer} (game hooks: ${rep.gameHooks.join(', ')}; audio exports wrapped ${rep.audioWrapped})\n`)

function runOne(name) {
  const s = sessionOf(name), dir = path.join(outDir, name)
  mkdirSync(dir, { recursive: true })
  const args = [pageCjs, '--src', rep.renderer, '--out', path.join(dir, 'last.png'), '--timeout', String(val.timeout ?? 1500), '--prefs', JSON.stringify({ graphicsQuality: 'high' }), '--drive', path.join(HERE, 'session.cjs')]
  if (s.level !== undefined) args.push('--level', String(s.level), '--save', JSON.stringify(s.save))
  else args.push('--start')
  const env = { ...process.env, PT_OUT: dir, PT_SECONDS: String(SECONDS), PT_SEED: String(s.seed), PT_TAKE_WAYS: s.takeWays ? '1' : '0', PT_FOLLOW: s.follow ? '1' : '0', PT_LEVEL: s.level === undefined ? 'fresh' : String(s.level) }
  return new Promise((res) => {
    const t0 = Date.now()
    const log = createWriteStream(path.join(dir, 'run.txt'))
    const p = spawn(electron, args, { cwd: tree, env, stdio: ['ignore', 'pipe', 'pipe'] })
    p.stdout.pipe(log, { end: false }); p.stderr.pipe(log, { end: false })
    p.on('close', (code) => { log.end(); process.stderr.write(`[bot] ${name}: exit ${code} after ${((Date.now() - t0) / 1000).toFixed(0)} s\n`); res({ name, code }) })
  })
}
const queue = [...names], results = []
await Promise.all(Array.from({ length: Math.min(PAR, queue.length) }, async () => { while (queue.length) results.push(await runOne(queue.shift())) }))
writeFileSync(path.join(outDir, 'runs.json'), JSON.stringify(results, null, 1))
if (results.some((r) => r.code !== 0)) { process.stderr.write('[bot] a session failed: see its run.txt\n'); process.exitCode = 1 }
