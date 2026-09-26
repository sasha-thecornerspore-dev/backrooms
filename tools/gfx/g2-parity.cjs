'use strict'
// g2-parity.cjs — sprite-only CPU vs GPU parity rig (builder G2).
//   electron g2-parity.cjs <renderer src dir> <out dir> <tier> <scene,scene,...> [WxH] [t seconds]
// Writes <scene>.<tier>.{cpu,gpu,diff}.png and stats.<tier>.json; prints one JSON line of stats per scene.
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '1')
const [src, out, tier, scenes, sz = '960x540', tt = '3.7', fl = '', atlas = ''] = process.argv.slice(2).filter((a) => a !== '--')
;(async () => {
  await app.whenReady()
  const win = new BrowserWindow({ show: false, width: 960, height: 540, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.on('console-message', (...a) => { const d = a[0] && typeof a[0] === 'object' && 'message' in a[0] ? a[0] : { level: a[1], message: a[2] }; process.stderr.write('[page] ' + d.message + '\n') })
  await win.loadFile(path.join(__dirname, 'g2-parity.html'))
  const call = (e) => win.webContents.executeJavaScript(e, true)
  let worldJson = null
  try { worldJson = JSON.parse(fs.readFileSync(path.join(src, 'world.json'), 'utf8')) } catch { /* optional */ }
  await call(`window.__init(${JSON.stringify({ srcUrl: pathToFileURL(path.resolve(src)).href.replace(/\/?$/, '/'), worldJson })})`)
  fs.mkdirSync(out, { recursive: true })
  const [w, h] = sz.split('x').map(Number)
  const rows = []
  for (const id of scenes.split(',')) {
    try {
      const r = await call(`window.__run(${JSON.stringify({ id, tier, size: { w, h }, t: Number(tt), atlas: atlas === '' ? 0 : Number(atlas), flicker: fl === '' ? null : Number(fl) })})`)
      for (const k of ['cpu', 'gpu', 'diff']) fs.writeFileSync(path.join(out, `${id}.${tier}.${k}.png`), Buffer.from(r[k + 'Png'], 'base64'))
      rows.push(r.stats)
      console.log(JSON.stringify(r.stats))
    } catch (e) { console.log(JSON.stringify({ id, error: String((e && e.message) || e).split('\n')[0] })) }
  }
  fs.writeFileSync(path.join(out, `stats.${tier}.json`), JSON.stringify(rows, null, 1))
  app.exit(0)
})().catch((e) => { console.error(e); app.exit(1) })
