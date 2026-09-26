// levelstart.mjs — what a level start costs, per renderer configuration, in the REAL page (tools/gfx/page.cjs), cold: one fresh page per
// configuration, the levels built in the order a solo run meets them (∅, 0, 1, 2, 3), exactly the steps game.js buildLevel() takes for the
// renderer (the world is built first, then createRenderer), then six frames drawn on requestAnimationFrame.
//
//   node tools/gfx/levelstart.mjs [--src <src/renderer dir>] [--configs cpu-legacy,cpu-low,cpu-medium,cpu-high,gpu-medium,gpu-high] [--gpu]
//                                 [--w 1280 --h 720] [--json out.json]
//
//   --gpu   hardware acceleration ON (this machine's real GPU through ANGLE). Without it the gpu-* configurations run on SwiftShader, which is only
//           good for checking that the path works (its timings mean nothing).
//
// Per level it prints: world (chunk cache + preload), create (createRenderer: textures, light, sprite prewarm; GPU: context, shaders, uploads),
// first (the first render() call), max2-6 (the worst of render calls 2..6: the GPU validation runs before the 4th), ready (from the start of
// the level build to the rAF after the 6th frame, i.e. what a player waits for under the fade). Numbers on a shared, loaded machine are noisy:
// run it twice and look at the order of magnitude.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
const has = (k) => args.includes('--' + k)
const src = path.resolve(opt('src', path.join(here, '..', '..', 'src', 'renderer')))
const configs = opt('configs', 'cpu-legacy,cpu-low,cpu-medium,cpu-high,gpu-medium,gpu-high').split(',').map((s) => s.trim()).filter(Boolean)
const W = Number(opt('w', 1280)), H = Number(opt('h', 720))
const electron = path.resolve(here, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe')

// the in-page measurement (runs in the title page: the attract mode is stopped first)
const pageJs = (backend, tier) => `(async () => {
  try { (await import('./gfx-attract.js')).stopAttract() } catch (e) {}
  const { createRenderer } = await import('./renderer.js')
  const { loadConfig, createChunkCache, CHUNK_SIZE } = await import('./world.js')
  const { createFixedMap } = await import('./fixedmap.js')
  const { levelConfig } = await import('./levels.js')
  const base = await loadConfig()
  const canvas = document.getElementById('c'); canvas.width = ${W}; canvas.height = ${H}
  const raf = () => new Promise((r) => requestAnimationFrame(r))
  const ro = { grain: true, particles: true, crosshair: true, reduceFlicker: false, maxGlobalDip: 0.5, renderer: '${backend}', qualityTier: '${tier}' }
  const out = []
  for (const index of [4, 0, 1, 2, 3]) {
    await raf(); await raf()
    const t0 = performance.now()
    const cfg = levelConfig(base, index)
    const cache = cfg.map ? createFixedMap(cfg.map) : createChunkCache(cfg, 0)
    cache.preload(0, 0)
    const t1 = performance.now()
    const g = createRenderer(canvas, cfg, ro, cfg.map ? { materialAt: (x, y) => cache.materialAt(x, y) } : {})
    const t2 = performance.now()
    const player = cfg.spawn ? { x: cfg.spawn.x, y: cfg.spawn.y } : { x: 11.5, y: 11.5 }
    Object.assign(player, { angle: 0.3, bob: 0, bobOffset: 0, moving: false, hp: 100, maxHp: 100 })
    const pcx = Math.floor(player.x / CHUNK_SIZE), pcy = Math.floor(player.y / CHUNK_SIZE)
    const costs = []
    for (let f = 0; f < 6; f++) {
      await raf()
      const c0 = performance.now()
      g.render(player, (x, y) => cache.isWall(x, y, pcx, pcy), 1, [], 1, { flashlight: true, glow: null }, { t: f / 60, dt: 1 / 60 })
      costs.push(performance.now() - c0)
    }
    await raf()
    const t3 = performance.now()
    out.push({ level: cfg.levelIndex, kind: g.kind, why: g.why, world: t1 - t0, create: t2 - t1, first: costs[0], max26: Math.max(...costs.slice(1)), ready: t3 - t0, validation: g.info ? g.info.validation : null })
    g.dispose()
  }
  console.info('[gfx] LEVELSTART ' + JSON.stringify(out))
  return 1
})()`

const rows = []
for (const c of configs) {
  const [backend, tier] = c.split('-')
  const pageArgs = [path.join(here, 'page.cjs'), '--w', String(W), '--h', String(H), '--out', path.join(here, 'out', `levelstart-${c}.png`), '--src', src,
    '--visible', '--wait', '200', '--timeout', '240', '--eval', pageJs(backend, tier)]
  if (has('gpu')) pageArgs.push('--gpu')
  else if (backend === 'gpu') pageArgs.push('--ropts', JSON.stringify({ allowSoftwareGl: true }))
  const r = spawnSync(electron, pageArgs, { encoding: 'utf8', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' }, windowsHide: true, maxBuffer: 1 << 24 })
  const m = /\[gfx\] LEVELSTART (\[.*\])/.exec((r.stderr || '') + (r.stdout || ''))
  if (has('verbose')) process.stderr.write(String(r.stderr).split('\n').filter((l) => /warn|error/i.test(l)).slice(0, 12).join('\n') + '\n')
  if (!m) { console.error(`${c}: no result (exit ${r.status})\n${String(r.stderr).split('\n').filter((l) => /error/i.test(l)).slice(0, 5).join('\n')}`); continue }
  for (const x of JSON.parse(m[1])) rows.push({ config: c, ...x })
}
const f = (v) => (Number.isFinite(v) ? v.toFixed(0).padStart(6) : '     -')
console.log(`level start (${W}x${H}${has('gpu') ? ', hardware GPU' : ', GPU on SwiftShader'}) — ms`)
console.log('config       level kind  world create  first max2-6  ready  validation')
for (const x of rows) console.log(`${x.config.padEnd(12)} ${String(x.level).padEnd(5)} ${String(x.kind).padEnd(4)} ${f(x.world)} ${f(x.create)} ${f(x.first)} ${f(x.max26)} ${f(x.ready)}  ${x.validation || '-'}${x.kind === 'cpu' && x.config.startsWith('gpu') ? ` (${x.why})` : ''}`)
if (opt('json')) fs.writeFileSync(opt('json'), JSON.stringify(rows, null, 2))
