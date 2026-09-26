'use strict'
// main.cjs — Electron main process for the deterministic render harness.
//
// Launched by run.mjs:   electron.exe tools/gfx/main.cjs        (options arrive as JSON in GFX_OPTS)
//
// It opens ONE hidden BrowserWindow on harness.html, asks the page to render each scene (or the
// benchmark) via executeJavaScript, and writes the PNGs / bench.json / manifest.json into --out.
// Nothing here draws anything; all rendering happens in the page against the renderer under test.
//
// Hardware acceleration is OFF unless opts.gpu — the CPU raycaster is what we measure, and software
// raster is what makes the PNGs reproducible byte-for-byte.
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { pathToFileURL } = require('url')

const opts = JSON.parse(process.env.GFX_OPTS || '{}')
const log = (...a) => process.stdout.write(a.join(' ') + '\n')
const errors = []
let sceneCount = 0, ctxWarnings = 0

// A fresh throwaway profile per run: localStorage (the renderer's crash-loop marker, the GPU validation cache) must not carry state from an earlier
// run into this one, or a GPU comparison silently degrades to the CPU ('crash-loop') because of what an old run left behind.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gfx-harness-'))
app.setPath('userData', userData)
if (!opts.gpu) app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('force-color-profile', 'srgb')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

function finish(code) {
  try {
    if (opts.out && !opts.list) fs.writeFileSync(path.join(opts.out, 'run-status.json'), JSON.stringify({ ok: code === 0, scenes: sceneCount, errors }, null, 2))
  } catch { /* ignore */ }
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* the profile may still be locked: it is in the temp dir */ }
  app.exit(code)
}

async function main() {
  if (!opts.list) fs.mkdirSync(opts.out, { recursive: true })
  await app.whenReady()

  const win = new BrowserWindow({
    show: false,
    width: opts.size.w,
    height: opts.size.h,
    useContentSize: true,
    backgroundColor: '#000000',
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const wc = win.webContents

  // page console → our stderr, so a renderer exception in the code under test is visible
  wc.on('console-message', (...a) => {
    const d = a[0] && typeof a[0] === 'object' && 'message' in a[0] ? a[0] : { level: a[1], message: a[2] }
    const lvl = String(d.level)
    if (/Too many active WebGL contexts/i.test(String(d.message))) ctxWarnings++
    if (/willReadFrequently/.test(String(d.message))) return   // advisory: the bench flush pass calls getImageData on purpose
    if (lvl === 'error' || lvl === '3') { errors.push(String(d.message)); process.stderr.write('[page error] ' + d.message + '\n') }
    else if (lvl === 'warning' || lvl === '2') process.stderr.write('[page warn] ' + d.message + '\n')
    else if (opts.verbose) log('[page]', d.message)
  })
  wc.on('render-process-gone', (_e, details) => { errors.push('render-process-gone: ' + JSON.stringify(details)); finish(1) })

  await win.loadFile(path.join(__dirname, 'harness.html'))

  const call = (expr) => wc.executeJavaScript(expr, true)

  // world.json is fetch()ed by the game's loadConfig(); a file:// fetch is not available here, so we
  // read it in Node and hand it to the page (same merge: DEFAULT_CONFIG <- world.json).
  let worldJson = null
  try { worldJson = JSON.parse(fs.readFileSync(path.join(opts.src, 'world.json'), 'utf8')) } catch { /* optional */ }

  const toUrl = (p) => pathToFileURL(p).href.replace(/\/?$/, '/')
  const srcUrl = toUrl(opts.src)
  let vs = null   // a second tree for the A/B benchmark
  if (opts.benchVs) {
    let wj = null
    try { wj = JSON.parse(fs.readFileSync(path.join(opts.benchVs, 'world.json'), 'utf8')) } catch { /* optional */ }
    vs = { srcUrl: toUrl(opts.benchVs), worldJson: wj }
  }
  const init = await call(`window.__harness.init(${JSON.stringify({ srcUrl, worldJson, gpu: !!opts.gpu, vs, quality: opts.quality || null, reduceFlicker: !!opts.reduceFlicker, ropts: opts.ropts || null })})`)

  if (opts.list) {
    for (const s of init.scenes) log(`${s.id}${s.group && s.group !== s.id ? '  [' + s.group + ']' : ''}  ${s.desc}`)
    return finish(0)
  }

  // --stress N: N create / draw / dispose cycles (level transitions); a live-context leak or a stray canvas is an error
  if (opts.stress) {
    const r = await call(`window.__harness.stress(${JSON.stringify({ n: opts.stress, id: (opts.scenes && opts.scenes[0] !== 'none' && opts.scenes[0]) || 'l0-corridor' })})`)
    log(`  stress: ${r.n} cycles, backends ${JSON.stringify(r.kinds)}, canvases before/after ${r.canvasesBefore}/${r.canvasesAfter}, context warnings ${ctxWarnings}`)
    if (r.canvasesAfter !== r.canvasesBefore) errors.push(`stress: ${r.canvasesAfter - r.canvasesBefore} canvas(es) leaked over ${r.n} cycles`)
    if (ctxWarnings) errors.push(`stress: the browser warned about too many live WebGL contexts ${ctxWarnings} time(s)`)
    if (opts.ropts && opts.ropts.renderer === 'gpu' && !r.kinds.gpu) errors.push('stress: no cycle ran on the GPU path')
    return finish(errors.length ? 1 : 0)
  }

  const want = opts.scenes && opts.scenes[0] !== 'none' ? opts.scenes : null
  let chosen = []
  if (!(opts.scenes && opts.scenes[0] === 'none')) {
    chosen = want
      ? init.scenes.filter((s) => want.includes(s.id) || (s.group && want.includes(s.group)))
      : init.scenes
    const missing = (want || []).filter((w) => !init.scenes.some((s) => s.id === w || s.group === w))
    if (missing.length) { errors.push('unknown scene(s): ' + missing.join(', ')); return finish(1) }
  }

  const manifest = {
    tool: 'tools/gfx harness v1',
    src: opts.src,
    size: opts.size,
    gpu: !!opts.gpu,
    chromium: process.versions.chrome,
    electron: process.versions.electron,
    worldSeed: init.worldSeed,
    warmupFrames: init.warmupFrames,
    scenes: [],
  }

  const t0 = Date.now()
  for (const s of chosen) {
    let r
    try { r = await call(`window.__harness.renderScene(${JSON.stringify(s.id)}, ${JSON.stringify(opts.sizeGiven ? opts.size : null)})`) }
    catch (e) {
      const msg = String((e && e.message) || e).split('\n')[0]
      errors.push(`scene ${s.id}: ${msg}`)
      process.stderr.write(`  ${s.id}: FAILED - ${msg}\n`)
      continue
    }
    if (!r || !r.png) { errors.push(`scene ${s.id}: no image`); continue }
    const buf = Buffer.from(r.png, 'base64')
    fs.writeFileSync(path.join(opts.out, s.id + '.png'), buf)
    // --ropts gpuValidate:'measure': both first-frame validation frames (GPU / CPU reference) next to the scene, for looking at
    const vf = r.info && r.info.validationFrames
    if (vf) for (const k of ['gpu', 'cpu']) if (vf[k]) fs.writeFileSync(path.join(opts.out, `${s.id}.val-${k}.png`), Buffer.from(String(vf[k]).split(',')[1], 'base64'))
    manifest.scenes.push({
      id: s.id, file: s.id + '.png', width: r.width, height: r.height, bytes: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'), ms: Math.round(r.ms), kind: r.kind || 'cpu', why: r.why || null, validation: r.info && r.info.validation || null, validationMetrics: r.info && r.info.validationMetrics || null, validationMs: r.info && r.info.validationMs != null ? Math.round(r.info.validationMs) : null,
    })
    // A GPU request that fell back to the CPU (a shader that did not compile, a failed validation ...) would make every GPU-vs-CPU comparison
    // meaningless: it is an error unless --allow-fallback is given.
    if (opts.ropts && opts.ropts.renderer === 'gpu' && r.kind !== 'gpu' && !opts.allowFallback) errors.push(`scene ${s.id}: asked for the GPU renderer but got '${r.kind}' (${r.why})`)
    log(`  ${s.id.padEnd(22)} ${r.width}x${r.height}  ${(buf.length / 1024).toFixed(0).padStart(5)} KB  ${manifest.scenes[manifest.scenes.length - 1].sha256.slice(0, 12)}  ${r.kind || 'cpu'}${r.kind === 'gpu' && r.info && r.info.renderer ? ' (' + String(r.info.renderer).slice(0, 40) + ')' : ''}${r.kind !== 'gpu' && opts.ropts && opts.ropts.renderer === 'gpu' ? ' FELL BACK: ' + r.why : ''}`)
  }
  manifest.renderMs = Date.now() - t0
  sceneCount = manifest.scenes.length
  if (chosen.length) fs.writeFileSync(path.join(opts.out, 'manifest.json'), JSON.stringify(manifest, null, 2))   // a bench-only run must not clobber a scene manifest

  if (opts.bench) {
    const b = await call(`window.__harness.bench(${JSON.stringify({ w: opts.benchSize.w, h: opts.benchSize.h, rounds: opts.benchRounds || 3 })})`)
    b.chromium = process.versions.chrome
    b.electron = process.versions.electron
    b.gpu = !!opts.gpu
    b.src = opts.src
    if (b.vs) b.vs.src = opts.benchVs
    b.cpu = (os.cpus()[0] || {}).model
    b.cores = os.cpus().length
    b.platform = process.platform + ' ' + os.release()
    b.date = new Date().toISOString()
    // timings are 0.1 ms-quantised; round away the float noise (18.300000011... ms) before writing
    fs.writeFileSync(path.join(opts.out, 'bench.json'), JSON.stringify(b, (_k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v), 2))
    for (const [name, st] of Object.entries(b.scenes)) log(`  bench ${name.padEnd(12)} median ${st.medianMs.toFixed(1)} ms  p95 ${st.p95Ms.toFixed(1)} ms  (rounds ${st.roundMedianMs.map((x) => x.toFixed(1)).join('/')})   with flush: median ${st.flushed.medianMs.toFixed(1)} p95 ${st.flushed.p95Ms.toFixed(1)}   [${b.frames} frames x ${b.rounds} rounds @ ${b.size.w}x${b.size.h}]`)
    if (b.vs) {
      log(`  A/B: B = ${opts.benchVs}`)
      for (const [name, rt] of Object.entries(b.vs.ratio)) {
        log(`  bench ${name.padEnd(12)} B/A median x${rt.medianRatio.toFixed(3)}  p95 x${rt.p95Ratio.toFixed(3)}   with flush: median x${rt.flushedMedianRatio.toFixed(3)} p95 x${rt.flushedP95Ratio.toFixed(3)}   (per round ${rt.roundMedianRatio.map((x) => x.toFixed(3)).join('/')})`)
      }
    }
  }

  finish(errors.length ? 1 : 0)
}

main().catch((e) => { errors.push(String((e && e.stack) || e)); process.stderr.write(String((e && e.stack) || e) + '\n'); finish(1) })
