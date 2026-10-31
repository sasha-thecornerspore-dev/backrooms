'use strict'
// session.cjs — one scripted play session, as a tools/gfx/page.cjs --drive module: page.cjs opens the REAL page (an instrumented scratch
// copy of src/renderer, see patch.mjs), plants the save or clicks SOLO, and hands over; this injects the in-page bot (bot.js), pumps
// frames until PT_SECONDS of GAME time (the play clock), saves a frame every PT_EVERY s of game time plus one shortly after each new
// line or happening, and writes every HUD text change, game event, spoken line, plate decision and audio call to <PT_OUT>/log.jsonl,
// and the bot's summary to <PT_OUT>/summary.json. From here on every request that is not file:, data:, blob: or devtools: is cancelled.
//
// Configured by the environment (page.cjs owns the command line): PT_OUT (required), PT_SECONDS (180), PT_EVERY (6), PT_SEED (1234),
// PT_TAKE_WAYS (1 = take a way when standing at one), PT_FOLLOW (1 = follow the compass), PT_BOT (bot.js beside this file).
const fs = require('fs')
const path = require('path')

module.exports = async (ctx) => {
  const { exec, wc, log, sleep } = ctx
  const outDir = process.env.PT_OUT
  if (!outDir) throw new Error('session.cjs: set PT_OUT')
  const SECONDS = Number(process.env.PT_SECONDS || 180), EVERY = Number(process.env.PT_EVERY || 6)
  const botFile = process.env.PT_BOT || path.join(__dirname, 'bot.js')
  fs.mkdirSync(path.join(outDir, 'frames'), { recursive: true })
  const logPath = path.join(outDir, 'log.jsonl')
  fs.writeFileSync(logPath, '')
  const out = (o) => fs.appendFileSync(logPath, JSON.stringify(o) + '\n')
  wc.session.webRequest.onBeforeRequest((d, cb) => {
    const ok = /^(file|data|blob|devtools|chrome-extension):/.test(d.url)
    if (!ok) out({ k: 'net-blocked', url: d.url.slice(0, 160) })
    cb({ cancel: !ok })
  })
  wc.on('console-message', (...a) => {
    const d = a[0] && typeof a[0] === 'object' && 'message' in a[0] ? a[0] : { level: a[1], message: a[2] }
    if (String(d.level) === 'error' || String(d.level) === '3') out({ k: 'console-error', m: String(d.message).slice(0, 400) })
  })
  const pump = async () => { const img = await wc.capturePage(); await sleep(20); return img }

  const up = await exec('!!globalThis.__pt && !!globalThis.__pt.level')
  if (!up) { out({ k: 'fail', why: 'no __pt: is --src an instrumented copy?' }); ctx.errors.push('session: the instrumented game is not up'); return }
  const cfg = { seed: Number(process.env.PT_SEED || 1234), takeWays: process.env.PT_TAKE_WAYS === '1', followCompass: process.env.PT_FOLLOW === '1' }
  await exec(`globalThis.__botCfg = ${JSON.stringify(cfg)}; 0`)
  await exec(fs.readFileSync(botFile, 'utf8'))
  for (let i = 0; i < 50; i++) { if (await exec('!!globalThis.__bot')) break; await pump() }
  const wall0 = Date.now()
  out({ k: 'start', wall: wall0, cfg, level: process.env.PT_LEVEL ?? 'fresh' })
  let nextShot = 0, frames = 0, extraNext = -1, lastExtra = -10, msgPrev = ''
  let st = await exec('globalThis.__bot.status()')
  const flush = async () => {
    const logs = await exec('globalThis.__bot.drain()')
    for (const l of logs) {
      out({ t: l[0], k: l[1], d: l[2] })
      // a new line mid-screen: grab a frame of it once it has faded in; a happening: a frame just after
      if (l[1] === 'dom:msg' && l[2] !== '(hidden)' && l[2] !== msgPrev && st.t - lastExtra > 2.5 && extraNext < 0) { msgPrev = l[2]; extraNext = l[0] + 0.7 }
      if ((l[1] === 'event' || l[1] === 'haunt' || l[1] === 'die' || l[1] === 'tell' || (l[1] === 'seen' && /^thing|^soul|^way|^sight/.test(String(l[2])))) && st.t - lastExtra > 2.5 && extraNext < 0) extraNext = l[0] + 0.4
    }
    const aud = await exec('globalThis.__bot.audio()')
    for (const a of aud) out({ t: +Number(a[0]).toFixed(2), k: 'audio', d: a[1] + (a[2] ? '(' + a[2] + ')' : '') })
  }
  while (st.t < SECONDS) {
    const img = await pump(); frames++
    st = await exec('globalThis.__bot.status()')
    if (st.t >= nextShot) {
      const name = `f_${String(Math.round(st.t)).padStart(3, '0')}s_L${st.lvl}.jpg`
      fs.writeFileSync(path.join(outDir, 'frames', name), img.toJPEG(82)); out({ k: 'frame', t: +st.t.toFixed(2), file: name })
      nextShot += EVERY
    }
    if (extraNext > 0 && st.t >= extraNext) {
      const name = `e_${st.t.toFixed(1).padStart(5, '0')}s_L${st.lvl}.jpg`
      fs.writeFileSync(path.join(outDir, 'frames', name), img.toJPEG(82)); out({ k: 'frame', t: +st.t.toFixed(2), file: name, extra: true })
      extraNext = -1; lastExtra = st.t
    }
    if (frames % 10 === 0 || st.n > 200) await flush()
    if (frames % 600 === 0) log(`[pt] t=${st.t.toFixed(1)} lvl=${st.lvl} frames=${frames} wall=${((Date.now() - wall0) / 1000).toFixed(0)}s`)
  }
  await flush()
  const sum = await exec('globalThis.__bot.summary()')
  sum.frames = frames; sum.wallS = (Date.now() - wall0) / 1000; sum.gameS = st.t; sum.cfg = cfg
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(sum, null, 1))
  log(`[pt] done: ${frames} frames, game ${st.t.toFixed(1)} s, wall ${sum.wallS.toFixed(0)} s`)
}
