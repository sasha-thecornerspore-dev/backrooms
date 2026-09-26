'use strict'
// page.cjs — see the REAL page (src/renderer/index.html over file://) in a hidden Electron window and save a PNG of it.
//
//   node_modules/electron/dist/electron.exe tools/gfx/page.cjs --w 1280 --h 720 --out <png> [options]
//
//   --w N --h N        viewport size in CSS px (default 1280x720)
//   --touch            touch emulation at the given --w/--h (a landscape phone: --w 844 --h 390 --touch --memory 4)
//   --phone            390x844, touch emulation, (pointer: coarse), --memory GB device memory reported (default 2: skips the attract mode)
//   --src <dir>        the renderer tree (default: ../../src/renderer relative to this file)
//   --start            click SOLO and wait for the running game (a fresh solo run enters through Level ∅)
//   --level 0..3|null  start the game ON that level for real: a saved run is planted and CONTINUE is clicked
//                      (null = level ∅). Implies --start. HUD theme = whatever the game sets for that level.
//   --theme X          force document.body.dataset.level = X after the page is up ('0'..'3', '∅', or 'none' to remove)
//   --demo             freeze the game loop and fill the HUD with representative content (message, prompts, compass,
//                      chat, low-ish bars, a full hotbar) so every element can be seen and measured at once
//   --note / --wish    open the found-scrap card / the wish dialog on top (use with --start)
//   --attract-t S      title screen: restart the attract mode at S seconds along its route as a still frame
//   --reduced-motion   emulate prefers-reduced-motion: reduce
//   --wait MS          extra settle time before the capture (default 1500 with --start, 2500 on the title)
//   --measure          also print WCAG contrast of each visible HUD text element against the pixels actually behind its glyphs
//                      (the frame is captured twice, text on / text off; only solid glyph cores count; --keep-measure saves both)
//   --stats            print the attract mode's frame count / average render ms (gfx-attract.js getAttractStats)
//   --ropts JSON       extra renderOpts for the game (globalThis.__backroomsRenderOpts, set before the page's scripts run TOGETHER WITH the test-run marker
//                      globalThis.__backroomsTestRun = true: without the marker the game and the GL backend ignore the hook), e.g. the GPU path on
//                      SwiftShader: --ropts '{"renderer":"gpu","allowSoftwareGl":true}' (with --prefs '{"renderer":"gpu"}' it is the same as the pref)
//   --eval JS          run this JS in the page (after everything else, before the capture); console.log shows with --verbose
//   --memory GB        navigator.deviceMemory to report under --phone/--touch (2 = the attract mode skips itself)
//   --visible          park a real window off-screen instead of a hidden one (rAF runs at the display rate: for live frame-rate checks)
//   --query Q          append a query string to the page URL, e.g. --query '?gfxbench=quick' (the device benchmark) or '?gfxstats=1'
//   --gpu              leave Chromium hardware acceleration ON (default OFF): WebGL then runs on this machine's real GPU through ANGLE, not
//                      SwiftShader (the GPU path still needs --prefs '{"renderer":"gpu"}' or the benchmark; no allowSoftwareGl needed)
//   --timeout S        watchdog seconds (default 90)      --verbose  step log + page console      --keep-userdata  keep the temp profile
//
// Prints "[page error] ..." for every console error / uncaught exception; exit code 1 if there were any.
// The window is hidden (show:false, backgroundThrottling:false); webContents.capturePage() returns real pixels for it on this
// setup (a second DevTools Page.captureScreenshot did not return), so that is what is used. The DevTools protocol is only
// used for phone / reduced-motion emulation.
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')

function parseArgs(argv) {
  const val = {}, flags = new Set()
  const valued = new Set(['w', 'h', 'out', 'src', 'level', 'theme', 'attract-t', 'wait', 'eval', 'timeout', 'memory', 'prefs', 'ropts', 'query'])
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (!t.startsWith('--')) continue
    const k = t.slice(2)
    if (valued.has(k)) val[k] = argv[++i]
    else flags.add(k)
  }
  return { val, flags }
}
const { val, flags } = parseArgs(process.argv.slice(2))
const phone = flags.has('phone')
const touch = phone || flags.has('touch')   // --touch: touch emulation at any --w/--h (e.g. a landscape phone, 844x390)
const W = phone ? 390 : Number(val.w || 1280)
const H = phone ? 844 : Number(val.h || 720)
const outPng = val.out ? path.resolve(val.out) : null
const srcDir = path.resolve(val.src || path.join(__dirname, '..', '..', 'src', 'renderer'))
const levelArg = val.level
const wantStart = flags.has('start') || levelArg !== undefined
const errors = []
const log = (...a) => process.stderr.write(a.join(' ') + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (m) => { if (flags.has('verbose')) process.stderr.write('[step] ' + m + '\n') }

if (!outPng) { process.stderr.write('usage: electron tools/gfx/page.cjs --out <png> [--w 1280 --h 720] [--phone] [--start] [--level 0..3|null] [--theme X] [--demo] ...\n'); process.exit(2) }

if (!flags.has('gpu')) app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('force-color-profile', 'srgb')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// never touch the owner's real profile / saved game
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'backrooms-page-'))
app.setPath('userData', userData)

function finish(code) {
  if (!flags.has('keep-userdata')) { try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* the profile may still be locked */ } }
  app.exit(code)
}

setTimeout(() => { process.stderr.write('[page error] watchdog: page.cjs ran longer than ' + (Number(val.timeout || 90)) + 's\n'); finish(1) }, Number(val.timeout || 90) * 1000).unref()

async function main() {
  fs.mkdirSync(path.dirname(outPng), { recursive: true })
  await app.whenReady(); step('ready')

  // a phone reports its memory: navigator.deviceMemory is read-only, so a generated preload shadows it in the MAIN world before any page script runs
  const preload = path.join(userData, 'page-preload.cjs')
  const preJs = (touch ? `try { Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => ${Number(val.memory || 2)} }) } catch (e) {};` : '') + (val.ropts ? `window.__backroomsTestRun = true; window.__backroomsRenderOpts = ${JSON.stringify(JSON.parse(val.ropts))};` : '') + '0'
  fs.writeFileSync(preload, `const { webFrame } = require('electron'); webFrame.executeJavaScript(${JSON.stringify(preJs)})`)
  const win = new BrowserWindow({
    show: false, width: W, height: H, useContentSize: true, backgroundColor: '#000000',
    webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true, preload },
  })
  const wc = win.webContents
  // --visible: a real, composited window parked far off-screen, so requestAnimationFrame runs at the display rate (a hidden window
  // only produces frames on demand) — needed to measure a live loop's frame rate
  if (flags.has('visible')) { win.setPosition(-6000, -6000); win.showInactive() }
  wc.on('console-message', (...a) => {
    const d = a[0] && typeof a[0] === 'object' && 'message' in a[0] ? a[0] : { level: a[1], message: a[2] }
    const lvl = String(d.level)
    if (/willReadFrequently|Electron Security Warning|\[Violation\]/.test(String(d.message))) return
    if (lvl === 'error' || lvl === '3') { errors.push(String(d.message)); process.stderr.write('[page error] ' + d.message + '\n') }
    else if (lvl === 'warning' || lvl === '2') process.stderr.write('[page warn] ' + d.message + '\n')
    else if (flags.has('verbose') || /^\[(renderer|bench|gfx)\]/.test(String(d.message))) log('[page]', d.message)     // the game's renderer diagnostics, the benchmark report, levelstart.mjs numbers
  })
  wc.on('render-process-gone', (_e, d) => { errors.push('render-process-gone ' + JSON.stringify(d)); finish(1) })

  // ── DevTools protocol: emulation + capture ──
  wc.debugger.attach('1.3'); step('debugger attached')
  const cdp = (m, p) => wc.debugger.sendCommand(m, p || {})
  step('cdp ready')
  if (touch || flags.has('reduced-motion')) { await win.loadURL('about:blank'); step('blank loaded') }   // DevTools emulation needs a live target
  if (touch) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: true })
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  }
  if (flags.has('reduced-motion')) {
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  }

  const exec = (js) => wc.executeJavaScript(js, true)
  // Freeze the game loop: replace requestAnimationFrame, then WAIT until the callback already in flight has run once and tried to
  // reschedule (a hidden window runs rAF only when something forces a frame, so poll while forcing frames with capturePage).
  const freeze = async () => {
    await exec('window.__loopDone = false; window.requestAnimationFrame = () => { window.__loopDone = true; return 0 }; 0')
    for (let i = 0; i < 40; i++) { await wc.capturePage(); await sleep(100); if (await exec('window.__loopDone')) break }
    await sleep(100)
  }
  // a hidden window only paints on demand: the first capture after a DOM change can return the previous frame, so take a throwaway one first
  const snap = async () => { for (let i = 0; i < 3; i++) { wc.invalidate(); await wc.capturePage(); await sleep(200) } return (await wc.capturePage()).toPNG() }
  const url = pathToFileURL(path.join(srcDir, 'index.html')).href + (val.query ? (val.query.startsWith('?') ? val.query : '?' + val.query) : ''); step('loading ' + url)
  const loaded = () => new Promise((res) => wc.once('did-finish-load', res))

  let p = loaded(); await win.loadURL(url); await p; step('page loaded')

  // --prefs '{"graphicsQuality":"high","particles":false}' plants player preferences (prefs.js key backrooms:prefs) before the game boots
  if (val.prefs) {
    await exec(`localStorage.setItem('backrooms:prefs', ${JSON.stringify(val.prefs)})`)
    p = loaded(); wc.reload(); await p
  }

  // a planted save so CONTINUE lands on a real, chosen level (readSave runs at module load → reload after planting)
  if (levelArg !== undefined) {
    const lv = /^(null|∅|nul)$/i.test(levelArg) ? 4 : Number(levelArg)
    const save = {
      v: 1, level: lv, x: 33.5, y: 11.5, angle: 0, hp: 100, maxHp: 100,
      inventory: [{ type: 'almond-water' }, { type: 'glowstick' }, { type: 'bandage' }, { type: 'polaroid' }, { type: 'radio' }],
      selected: 1, pagesRead: [], worldSeed: null, anchor: null,
    }
    if (lv === 4) { save.x = undefined; save.y = undefined }   // let the fixed map place you at its authored spawn
    await exec(`localStorage.setItem('backrooms:save', ${JSON.stringify(JSON.stringify(save))})`)
    p = loaded(); wc.reload(); await p
  }

  // wait for the module script to wire up the title screen (or, with --query '?gfxbench=…', for the benchmark page that replaces it)
  for (let i = 0; i < 100; i++) { if (await exec(`!!((document.getElementById('btn-solo') && document.getElementById('btn-solo').onclick) || document.getElementById('gfx-bench'))`)) break; await sleep(100) }
  await sleep(300); step('title wired')

  if (val.theme !== undefined) {
    await exec(val.theme === 'none' ? 'delete document.body.dataset.level' : `document.body.dataset.level = ${JSON.stringify(val.theme)}`)
  }

  if (val['attract-t'] !== undefined) {
    const r = await exec(`(async () => {
      const m = await import('./gfx-attract.js')
      m.stopAttract()
      const c = document.getElementById('attract')
      const st = document.getElementById('start')
      const ok = await m.startAttract(c, { startTime: ${Number(val['attract-t'])}, still: true, onStop: () => st.classList.remove('has-attract') })
      if (ok) st.classList.add('has-attract')   // what index.html does when the attract is up
      return String(ok) + ' state=' + (c && c.dataset.state)
    })()`)
    log('attract:', r)
  } else if (!wantStart) {
    // let the attract mode run a moment so the capture has a real frame under the menu
    for (let i = 0; i < 60; i++) { const s = await exec(`(document.getElementById('attract') || {dataset:{}}).dataset.state || ''`); if (s && s !== 'starting') break; await sleep(100) }
  }

  if (wantStart) {
    if (levelArg !== undefined) await exec(`document.getElementById('btn-continue').click()`)
    else await exec(`document.getElementById('btn-solo').click()`)
    let up = false
    for (let i = 0; i < 150 && !up; i++) {
      up = await exec(`document.getElementById('start').style.display === 'none' && (document.getElementById('hud').textContent || '').length > 0`)
      if (!up) await sleep(100)
    }
    if (!up) { errors.push('the game did not come up (start screen still showing or the HUD is empty)'); process.stderr.write('[page error] game did not start\n') }
  }

  await sleep(Number(val.wait || (wantStart ? 1500 : 2500)))

  if (flags.has('note')) {
    await exec(`(() => { const c = document.getElementById('note-card'); document.getElementById('note-text').textContent = 'somebody wrote this in pencil.\\nthe carpet is damp here. keep to the left wall.\\nif you hear the humming stop, do not look up.'; document.getElementById('note-foot').textContent = '— a wanderer, 3 of 5'; c.style.display = 'flex' })()`)
  }
  if (flags.has('wish')) {
    await exec(`(() => { const d = document.getElementById('wish-dialog'); d.style.display = 'flex'; document.getElementById('wish-text').value = 'let the lights stay on.'; document.getElementById('wish-response').textContent = 'the hum considers it.' })()`)
  }
  if (flags.has('demo')) {
    await freeze()
    await exec(`(() => {
      const st = document.createElement('style'); st.textContent = '*, *::before, *::after { transition: none !important; animation-play-state: paused !important } #msg, #item-hint, #presence-hint, #exit-compass, #chat-log, #chat-typing { opacity: 1 !important }'   // (the game's own showMessage timer would otherwise fade #msg out under us); document.head.appendChild(st)
      const $ = (id) => document.getElementById(id)
      $('hp-fill').style.width = '64%'; $('san-fill').style.width = '41%'
      $('msg').textContent = 'the wallpaper is the same in every direction.'; $('msg').style.opacity = '1'
      $('item-hint').textContent = 'f · take the almond water'; $('item-hint').style.opacity = '1'
      $('presence-hint').style.opacity = '1'
      $('exit-compass').textContent = '↗  no-clip deeper  ·  34m'; $('exit-compass').style.opacity = '1'
      $('chat-log').innerHTML = '<div class="chat-sys">— connected — Enter to chat · /me to emote</div><div class="chat-line"><b style="color:hsl(200 72% 68%)">wanderer2</b> is anyone there?</div><div class="chat-me" style="color:hsl(30 72% 68%)">✦ wanderer waves at the dark</div>'
      $('chat-log').style.opacity = '1'; $('chat-typing').textContent = 'wanderer2 is typing…'; $('chat-typing').style.opacity = '1'
      $('stamina-wrap').style.opacity = '1'; $('stamina-fill').style.width = '55%'
    })()`)
    await sleep(200)
  }
  if (val.eval) { await exec(val.eval); await sleep(200) }

  if (flags.has('measure') && !flags.has('demo')) await freeze()
  step('capturing')
  // ── capture ──
  const png = await snap()   // works for a hidden window here (a 2nd DevTools screenshot did not return)
  fs.writeFileSync(outPng, png)
  log(`saved ${outPng} (${W}x${H}, ${(png.length / 1024).toFixed(0)} KB)`)

  if (flags.has('measure')) await measure(exec, wc, snap)

  if (flags.has('stats')) log('attract stats:', JSON.stringify(await exec(`import('./gfx-attract.js').then((m) => m.getAttractStats())`)))

  // a couple of facts worth printing every time
  const facts = await exec(`({ level: document.body.dataset.level || null, attract: (document.getElementById('attract') || {dataset:{}}).dataset.state || null,
    coarse: matchMedia('(pointer: coarse)').matches, mem: navigator.deviceMemory, cores: navigator.hardwareConcurrency, canvases: [...document.querySelectorAll('canvas')].map(c => c.id + ':' + c.width + 'x' + c.height + (getComputedStyle(c).display === 'none' ? ':hidden' : '')).join(' ') })`)
  log('facts:', JSON.stringify(facts))
  finish(errors.length ? 1 : 0)
}

// ── contrast measurement ─────────────────────────────────────────────────────────────────────────
// For each visible HUD text element: its computed text colour vs the pixels ACTUALLY behind the glyphs. The frame is captured twice
// (the game loop is frozen): once as shown, once with every measured element's text made transparent (backgrounds, plates, bars and
// text-shadow glows stay). Glyph pixels = where the two captures differ; the backdrop there is read from the text-less capture.
// Reported: the WCAG ratio at the median backdrop pixel and at the worst one (2nd / 98th percentile luminance, whichever is worse),
// so a busy scene under a translucent plate is judged by its worst patch, not its average.
const MEASURE_SELS = ['#hud', '#hp-label', '#san-label', '#exit-compass', '#msg', '#hint', '#presence-hint', '#item-hint',
  '#hotbar .slot', '#chat-log .chat-line', '#chat-log .chat-sys', '#chat-log .chat-me', '#chat-typing', '#btn-discard', '#btn-settings',
  '#note-text', '#note-foot', '#note-hint', '#wish-prompt', '#wish-response', '#start .title', '#start .sub', '#start .btns button', '#start #anchor-status', '#start #player-name', '#start #anchor-input', '#touch-actions .touch-btn']
async function measure(exec, wc, snap) {
  step('measure: start')
  const pngA = await snap()
  const items = await exec(`(() => {
    const out = []
    const vis = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return 0; o *= parseFloat(cs.opacity) } return o }
    for (const sel of ${JSON.stringify(MEASURE_SELS)}) for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el)
      let txt = (el.textContent || '').trim(), color = cs.color
      if (el.tagName === 'INPUT') { if (el.value || !el.placeholder) continue; txt = el.placeholder; color = getComputedStyle(el, '::placeholder').color }   // an empty field shows its placeholder
      if (r.width < 4 || r.height < 4 || !txt) continue
      const o = vis(el); if (o < 0.9) continue
      out.push({ sel, text: txt.slice(0, 28), x: r.left, y: r.top, w: r.width, h: r.height, color, fs: cs.fontSize, fw: cs.fontWeight })
    }
    return out
  })()`)
  await exec(`(() => { const st = document.createElement('style'); st.id = '__measure'; st.textContent = ${JSON.stringify(MEASURE_SELS.map((s) => s + ', ' + s + ' *').join(', '))} + ' { color: transparent !important; -webkit-text-fill-color: transparent !important }'; document.head.appendChild(st) })()`)
  step('measure: style injected'); await sleep(150)
  const pngB = await snap()
  step('measure: captured B'); await exec(`document.getElementById('__measure').remove()`)
  if (flags.has('keep-measure')) { fs.writeFileSync(outPng.replace(/.png$/, '.text.png'), pngA); fs.writeFileSync(outPng.replace(/.png$/, '.notext.png'), pngB) }   // the two captures the numbers come from
  const A = nativeImage.createFromBuffer(pngA), B = nativeImage.createFromBuffer(pngB)
  const size = A.getSize(), a = A.toBitmap(), b = B.toBitmap()   // BGRA
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
  const lum = (r, g, bl) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(bl)
  const ratio = (x, y) => (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  const rows = []
  for (const it of items) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(it.color)
    if (!m) continue
    const tr = +m[1], tg = +m[2], tb = +m[3], ta = m[4] === undefined ? 1 : +m[4]
    // (2 px in from the border box: a box's own border/outline can shift by a pixel between the two captures and is not text)
    const x0 = Math.max(0, Math.floor(it.x) + 2), y0 = Math.max(0, Math.floor(it.y) + 2), x1 = Math.min(size.width, Math.ceil(it.x + it.w) - 2), y1 = Math.min(size.height, Math.ceil(it.y + it.h) - 2)
    const ls = []
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const o = (y * size.width + x) * 4
      const d = Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2])
      if (d < 90) continue                                   // not a glyph pixel at all
      // ... and only the SOLID core of a glyph: the pixel in the text capture is (almost) the text colour itself
      if (ta >= 1 && Math.abs(a[o + 2] - tr) + Math.abs(a[o + 1] - tg) + Math.abs(a[o] - tb) > 60) continue
      ls.push(lum(b[o + 2], b[o + 1], b[o]))                 // the backdrop there, from the text-less capture
    }
    if (ls.length < 6) continue
    ls.sort((p, q) => p - q)
    const q = (pp) => ls[Math.min(ls.length - 1, Math.floor(pp * ls.length))]
    const tl = ta >= 1 ? lum(tr, tg, tb) : lum(tr * ta + 128 * (1 - ta), tg * ta + 128 * (1 - ta), tb * ta + 128 * (1 - ta))
    rows.push({ sel: it.sel, text: it.text, size: it.fs + '/' + it.fw, median: ratio(tl, q(0.5)), worst: Math.min(ratio(tl, q(0.02)), ratio(tl, q(0.98))), n: ls.length })
    if (flags.has('verbose')) log('   [' + it.sel + '] text L=' + tl.toFixed(3) + ' backdrop L p2/p50/p98 = ' + [q(0.02), q(0.5), q(0.98)].map((v) => v.toFixed(3)).join(' / '))
  }
  log('contrast — text colour vs the pixels behind its glyphs (AA = 4.5 body text / 3.0 large or bold >=14px):')
  for (const r of rows) log(`  ${r.sel.padEnd(22)} ${String(r.text).padEnd(30)} ${r.size.padEnd(9)} median ${r.median.toFixed(1).padStart(5)}:1   worst ${r.worst.toFixed(1).padStart(5)}:1  (n=${r.n})${Math.min(r.median, r.worst) < 4.5 ? '  <-- below AA' : ''}`)
  return rows
}

main().catch((e) => { process.stderr.write(String((e && e.stack) || e) + '\n'); finish(1) })
