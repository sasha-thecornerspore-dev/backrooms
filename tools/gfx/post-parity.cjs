'use strict'
// post-parity.cjs — POST-STAGE parity of the GPU post pass against gfx-post.js, on ONE shared world frame.
//
//   node_modules/electron/dist/electron.exe tools/gfx/post-parity.cjs --src <src/renderer> --out <dir> --scenes a,b,c
//        [--quality legacy|low|medium|high] [--size 960x540] [--frames N] [--ropts '{"tape":true}'] [--gpu-opts '{"postTargets":"rgba8"}']
//
// For each scene the CPU renderer's own world + sprite buffer is shaded by gfx-post.js composeFrame (Canvas2D) AND by the GPU post pass
// (gfx-gl-post.js, WebGL2 on SwiftShader here) with the same frame state, particle field and clock; writes <id>.cpu.png, <id>.gpu.png and
// <id>.diff.png (GPU - CPU, x4 around mid grey) and prints the mean / p99 / p99.9 absolute per-channel difference (0..255) and each side's mean colour.
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')

const argv = process.argv.slice(2)
const val = {}
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) val[argv[i].slice(2)] = argv[++i]
const src = path.resolve(val.src || path.join(__dirname, '..', '..', 'src', 'renderer'))
const out = path.resolve(val.out || path.join(__dirname, 'out', 'parity'))
const scenes = (val.scenes || 'l0-corridor').split(',').map((s) => s.trim()).filter(Boolean)
const m = /^(\d+)x(\d+)$/.exec(val.size || '960x540')
const size = { w: +m[1], h: +m[2] }
const errors = []

app.disableHardwareAcceleration()      // WebGL2 on SwiftShader, the harness's setting
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('force-color-profile', 'srgb')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

async function main() {
  fs.mkdirSync(out, { recursive: true })
  await app.whenReady()
  const win = new BrowserWindow({ show: false, width: size.w, height: size.h, useContentSize: true, backgroundColor: '#000', webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const wc = win.webContents
  wc.on('console-message', (...a) => {
    const d = a[0] && typeof a[0] === 'object' && 'message' in a[0] ? a[0] : { level: a[1], message: a[2] }
    if (/willReadFrequently/.test(String(d.message))) return
    const lvl = String(d.level)
    if (lvl === 'error' || lvl === '3') { errors.push(String(d.message)); process.stderr.write('[page error] ' + d.message + '\n') }
    else if (lvl === 'warning' || lvl === '2') process.stderr.write('[page warn] ' + d.message + '\n')
  })
  await win.loadFile(path.join(__dirname, 'post-parity.html'))
  let worldJson = null
  try { worldJson = JSON.parse(fs.readFileSync(path.join(src, 'world.json'), 'utf8')) } catch { /* optional */ }
  const call = (expr) => wc.executeJavaScript(expr, true)
  const srcUrl = pathToFileURL(src).href.replace(/\/?$/, '/')
  await call(`window.__pp.init(${JSON.stringify({ srcUrl, worldJson })})`)
  const rows = []
  for (const id of scenes) {
    if (val.gl) {      // --gl 1: the whole GPU renderer (createGlRenderer) on this scene, one PNG
      let r
      try { r = await call(`window.__pp.runGl(${JSON.stringify(id)}, ${JSON.stringify({ quality: val.quality || null, size, frames: val.frames ? +val.frames : null, ropts: val.ropts ? JSON.parse(val.ropts) : null })})`) }
      catch (e) { const msg = String((e && e.message) || e).split('\n')[0]; errors.push(id + ': ' + msg); process.stderr.write('  ' + id + ': FAILED - ' + msg + '\n'); continue }
      const tag = val.quality ? id + '.' + val.quality : id
      fs.writeFileSync(path.join(out, tag + '.gl.png'), Buffer.from(r.png.replace(/^data:image\/png;base64,/, ''), 'base64'))
      console.log('  ' + tag.padEnd(26) + ' gl renderer ok; canvases ' + JSON.stringify(r.canvases) + ' left after dispose: ' + r.leftAfterDispose + (r.resizeErr != null ? '  resize GL error: ' + r.resizeErr : ''))
      continue
    }
    let r
    try {
      r = await call(`window.__pp.run(${JSON.stringify(id)}, ${JSON.stringify({
        quality: val.quality || null, size, frames: val.frames ? +val.frames : null,
        ropts: val.ropts ? JSON.parse(val.ropts) : null, gpuOpts: val['gpu-opts'] ? JSON.parse(val['gpu-opts']) : null,
      })})`)
    } catch (e) { const msg = String((e && e.message) || e).split('\n')[0]; errors.push(`${id}: ${msg}`); process.stderr.write(`  ${id}: FAILED - ${msg}\n`); continue }
    const tag = val.quality ? `${id}.${val.quality}` : id
    for (const k of ['cpu', 'gpu', 'diff']) fs.writeFileSync(path.join(out, `${tag}.${k}.png`), Buffer.from(r[k].replace(/^data:image\/png;base64,/, ''), 'base64'))
    const s = r.stats
    rows.push({ id: tag, ...s })
    console.log(`  ${tag.padEnd(26)} mean ${s.mean.toFixed(2).padStart(6)}  p99 ${String(s.p99).padStart(3)}  p99.9 ${String(s.p999).padStart(3)}   bias c ${s.bias.centre} r ${s.bias.ring}  cpu rgb ${s.cpuMean.join('/')}  gpu rgb ${s.gpuMean.join('/')}   ${r.info.tier.scale ? 'scale ' + r.info.tier.scale : ''} ${r.info.precision} post ${r.info.msGpu.toFixed(1)}ms(SwiftShader)${r.glError ? '   GL ERROR ' + r.glError : ''}`)
  }
  fs.writeFileSync(path.join(out, 'parity.json'), JSON.stringify(rows, null, 2))
  app.exit(errors.length ? 1 : 0)
}
main().catch((e) => { process.stderr.write(String((e && e.stack) || e) + '\n'); app.exit(1) })
