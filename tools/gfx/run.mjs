// run.mjs — deterministic render harness CLI.
//
//   node tools/gfx/run.mjs --src <path to a src/renderer dir> --out <dir>
//        [--scenes a,b,c | none] [--bench] [--gpu] [--size 960x540] [--list]
//
//   --src     the renderer tree to draw with (must contain renderer.js, levels.js, world.js, ...). The
//             harness imports everything from HERE, so the same command runs the pristine baseline
//             tree and a refactored tree.
//   --out     output directory: <scene>.png, manifest.json (sha256 per PNG), bench.json (with --bench)
//   --scenes  comma list of scene ids or group names (e.g. sprites-lineup); default: all. `none` = no PNGs.
//   --bench   also run the benchmark (60 warm-up + 240 measured render() calls at 1280x720 for three
//             poses) and write bench.json. Combine with `--scenes none` for a timing-only run.
//   --bench-rounds N  repeat the benchmark N times (interleaved) and report medians of rounds (default 3).
//   --bench-vs <dir>  A/B benchmark (implies --bench): load a second renderer tree (B) and measure it back to
//             back with --src (A) inside every round, alternating who goes first; bench.json gets per-pose B/A
//             ratios that are immune to machine drift. This is the right tool for the "+10% frame time" gate:
//             absolute milliseconds move by 30% between a quiet and a busy machine, ratios do not.
//   --gpu     leave Chromium hardware acceleration ON (default OFF: software raster, reproducible).
//   --size    scene size WxH (default 960x540; the bench size is fixed at 1280x720).
//   --list    print the scene ids and exit.
//   --timeout seconds before the run is killed (default 600).
//
// Exit code 0 = every requested scene rendered without a page error; non-zero otherwise.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

function parseArgs(argv) {
  const a = { flags: new Set(), val: {} }
  const valued = new Set(['src', 'out', 'scenes', 'size', 'timeout', 'bench-rounds', 'bench-vs', 'quality', 'ropts', 'stress'])
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (!t.startsWith('--')) { console.error(`unexpected argument: ${t}`); process.exit(2) }
    const k = t.slice(2)
    if (valued.has(k)) { a.val[k] = argv[++i]; if (a.val[k] === undefined) { console.error(`--${k} needs a value`); process.exit(2) } }
    else a.flags.add(k)
  }
  return a
}

const usage = () => {
  console.error('usage: node tools/gfx/run.mjs --src <src/renderer dir> --out <dir> [--scenes a,b,c|none] [--bench] [--bench-rounds 3] [--bench-vs <dir>] [--gpu] [--size 960x540] [--quality legacy|low|medium|high] [--reduce-flicker] [--ropts json] [--stress N] [--allow-fallback] [--list]')
  process.exit(2)
}

const args = parseArgs(process.argv.slice(2))
if (!args.val.src || (!args.val.out && !args.flags.has('list'))) usage()

const src = path.resolve(args.val.src)
if (!fs.existsSync(path.join(src, 'renderer.js'))) {
  console.error(`--src ${src} does not contain renderer.js`)
  process.exit(2)
}
const benchVs = args.val['bench-vs'] ? path.resolve(args.val['bench-vs']) : null
if (benchVs && !fs.existsSync(path.join(benchVs, 'renderer.js'))) {
  console.error(`--bench-vs ${benchVs} does not contain renderer.js`)
  process.exit(2)
}
const out = path.resolve(args.val.out || path.join(here, 'out', '_list'))

let size = { w: 960, h: 540 }
if (args.val.size) {
  const m = /^(\d+)x(\d+)$/.exec(args.val.size)
  if (!m) { console.error('--size must look like 960x540'); process.exit(2) }
  size = { w: +m[1], h: +m[2] }
}

let electron
try { electron = require('electron') } catch { electron = null }
if (typeof electron !== 'string') electron = path.resolve(here, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe')
if (!fs.existsSync(electron)) { console.error(`electron binary not found at ${electron}`); process.exit(2) }

const opts = {
  src, out,
  scenes: args.val.scenes ? args.val.scenes.split(',').map((s) => s.trim()).filter(Boolean) : null,
  bench: args.flags.has('bench') || !!benchVs,
  benchVs,
  benchRounds: Math.max(1, Math.floor(Number(args.val['bench-rounds']) || 3)),
  benchSize: { w: 1280, h: 720 },
  gpu: args.flags.has('gpu'),
  quality: args.val.quality || null,               // renderOpts.qualityTier for every scene (gfx-quality.js tier name)
  stress: args.val.stress ? Math.max(1, Math.floor(Number(args.val.stress))) : 0,   // --stress N: N renderer create/draw/dispose cycles (level transitions)
  allowFallback: args.flags.has('allow-fallback'),   // with renderer:'gpu' in --ropts: do not fail a scene that fell back to the CPU
  reduceFlicker: args.flags.has('reduce-flicker'), // renderOpts.reduceFlicker
  ropts: args.val.ropts ? JSON.parse(args.val.ropts) : null,   // extra renderOpts merged into every scene (e.g. '{"bloom":false}')
  size,
  sizeGiven: !!args.val.size,
  list: args.flags.has('list'),
  verbose: args.flags.has('verbose'),
}

if (!opts.list) fs.mkdirSync(out, { recursive: true })
try { fs.rmSync(path.join(out, 'run-status.json'), { force: true }) } catch { /* ignore */ }

const t0 = Date.now()
if (!opts.list) console.log(`gfx: src=${src}\n     out=${out}  size=${size.w}x${size.h}  gpu=${opts.gpu ? 'ON' : 'off'}`)

const child = spawn(electron, [path.join(here, 'main.cjs')], {
  env: { ...process.env, GFX_OPTS: JSON.stringify(opts), ELECTRON_ENABLE_LOGGING: '0', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
child.stdout.on('data', (d) => process.stdout.write(d))
child.stderr.on('data', (d) => {
  // forward everything except Chromium's known-harmless GPU-process chatter
  for (const line of d.toString().split(/\r?\n/)) {
    if (line && !/gpu_process|dxgi|angle_platform|vulkan|dcomp|disk_cache|Autofill|INFO:CONSOLE|willReadFrequently/i.test(line)) process.stderr.write(line + '\n')
  }
})

const timeoutMs = (Number(args.val.timeout) || 600) * 1000
const killer = setTimeout(() => { console.error(`gfx: timed out after ${timeoutMs / 1000}s — killing`); child.kill() }, timeoutMs)

child.on('exit', (code) => {
  clearTimeout(killer)
  let status = null
  try { status = JSON.parse(fs.readFileSync(path.join(out, 'run-status.json'), 'utf8')) } catch { /* list mode / crash */ }
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  if (opts.list) process.exit(code === 0 ? 0 : 1)
  if (code === 0 && status && status.ok) {
    const n = status.scenes || 0
    console.log(`gfx: OK — ${n} scene(s)${opts.bench ? ' + bench' : ''} in ${secs}s -> ${out}`)
    process.exit(0)
  }
  console.error(`gfx: FAILED (exit ${code}) after ${secs}s`)
  if (status && status.errors) for (const e of status.errors) console.error('  - ' + String(e).split('\n')[0])
  process.exit(1)
})
