// patch.mjs — copy a tree's src/renderer and src/net into a SCRATCH folder and instrument the copy (never the tree): read-only hooks
// that expose state to the bot and log calls. Behaviour is unchanged except that postWish never touches the network.
//
//   node tools/pacing/bot/patch.mjs --src <tree>/src --out <scratch>/src
//
// Anchors that every tree has must match exactly once (a miss fails loudly: game.js moved, update the anchor). Anchors marked optional
// exist only in some trees (2.0.4's plate budget and teller) and are skipped where absent.
import { readFileSync, writeFileSync, cpSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from '../lib.mjs'

// a Windows checkout has CRLF line ends: the copy is patched (and written) with LF, which the page does not mind
const lf = (s) => s.replace(/\r\n/g, '\n')

function subOnce(text, old, neu, name, optional = false) {
  const n = typeof old === 'string' ? text.split(old).length - 1 : (text.match(new RegExp(old.source, old.flags.includes('g') ? old.flags : old.flags + 'g')) || []).length
  if (n === 0 && optional) return { text, applied: false }
  if (n !== 1) throw new Error(`patch ${name}: anchor found ${n} times: ${String(old).slice(0, 80)}`)
  return { text: text.replace(old, neu), applied: true }
}

const EXPOSE = '  globalThis.__pt = { player, get itemSys() { return itemSys }, get fog() { return fog }, get mem() { return mem }, get level() { return level }, get playT() { return playT }, get sanity() { return sanity },' +
  ' get stamina() { return stamina }, get flashlight() { return flashlight }, get noteOpen() { return noteOpen }, get dialogOpen() { return dialogOpen },' +
  ' get mapOpen() { return mapOpen }, get transitioning() { return transitioning }, get searchT() { return searchT }, get deaths() { return deaths },' +
  ' get readCount() { return readSet.size }, get origin() { return origin }, get filed() { return filed }, get ephemera() { return ephemera },' +
  ' get vended() { return vendedSet }, get searchLog() { return searchLog }, get dread() { return typeof dreadOut === "undefined" ? null : dreadOut.dread } }\n'

// game.js: the expose block and the call hooks -> { text, applied: [names] }
export function patchGame(g) {
  g = lf(g)
  const applied = []
  const step = (old, neu, name, optional = false) => { const r = subOnce(g, old, neu, name, optional); g = r.text; if (r.applied) applied.push(name) }
  step('  let spawnX = player.x, spawnY = player.y\n', '  let spawnX = player.x, spawnY = player.y\n' + EXPOSE, 'expose')
  step('  function travel(way) {\n', '  function travel(way) { globalThis.__ptEv?.(\'travel\', way && (way.kind || way.key || null));\n', 'travel')
  step('  function die(d = null) {\n', '  function die(d = null) { globalThis.__ptEv?.(\'die\', null);\n', 'die')
  // fireEvent(id, prio[, kind]): 2.0.4 passes no kind for the arrival's sound-only event
  step(/^ {2}function fireEvent\(id, prio = PRIO\.ambient(, kind = 'event')?\) \{\n/m, (m, k) => `  function fireEvent(id, prio = PRIO.ambient${k ?? ''}) { globalThis.__ptEv?.('event', ${k ? "kind === null ? id + ' (sound-only)' : id" : 'id'});\n`, 'fireEvent')
  step('  function showMessage(text, prio = PRIO.interaction) { if (text) msgQ.push(String(text), prio) }\n',
    '  function showMessage(text, prio = PRIO.interaction) { globalThis.__ptEv?.(\'say\', [String(text), prio]); if (text) msgQ.push(String(text), prio) }\n', 'showMessage')
  step('  function startSearch(p, th) {\n', '  function startSearch(p, th) { globalThis.__ptEv?.(\'search\', p && p.type);\n', 'startSearch')
  step('  function dispenseFromMachine(m) {\n', '  function dispenseFromMachine(m) { globalThis.__ptEv?.(\'machine\', m && m.key);\n', 'machine')
  step('  function applyItemEffect(eff) {\n', '  function applyItemEffect(eff) { globalThis.__ptEv?.(\'use\', eff ? (eff.type || eff.kind || JSON.stringify(eff).slice(0, 60)) : null);\n', 'use')
  step(/^ {2}function applyHaunt\(fx(, kind = 'haunt')?\) \{\n/m, (m, k) => `  function applyHaunt(fx${k ?? ''}) { globalThis.__ptEv?.('haunt', fx ? JSON.stringify(fx).slice(0, 120) : null);\n`, 'haunt')
  // 2.0.4: every plate decision (kind, line, show / queue / none), and every tell the teller plays
  // (the review's plate() checks kind and text a few lines earlier, and refuses an ambient line the queue would drop before it asks)
  step(/^ {4}if \((!kind \|\| !text \|\| )?plates\.admit\(kind, playT, keep \? text : null\) !== 'show'\) return false\n/m,
    (m, pre) => `    const __adm = ${pre ? "(!kind || !text) ? 'none' : " : ''}plates.admit(kind, playT, keep ? text : null); globalThis.__ptEv?.('plate', [kind, String(text).slice(0, 80), __adm]); if (__adm !== 'show') return false\n`, 'plate', true)
  step('      if (tell) call(tell.sound, tell.gain, tell.pan)\n', "      if (tell) { globalThis.__ptEv?.('tell', tell.variant + '/' + tell.sound); call(tell.sound, tell.gain, tell.pan) }\n", 'tell', true)
  return { text: g, applied }
}

// audio.js: every exported function counted, and logged with the play clock (the per-frame ones counted only)
export function patchAudio(a) {
  a = lf(a)
  const head = "const __alog = (n, a) => { try { const c = (globalThis.__ptAudioCount ||= {}); c[n] = (c[n] || 0) + 1;" +
    " if (!/^(setFlicker|setMood|scaleFrequency|isMusicOn|setRadio|step|setHum)$/.test(n)) (globalThis.__ptAudio ||= []).push([globalThis.__pt ? globalThis.__pt.playT : -1, n, a.length ? String(a[0]).slice(0, 24) : '']) } catch (e) { /* never */ } }\n"
  let n = 0
  const text = head + a.replace(/^export function (\w+)\((.*)\) \{(?=\s*$)/gm, (m, name) => { n++; return `${m} __alog('${name}', arguments);` })
  return { text, wrapped: n }
}

export function patchWish(w) {
  w = lf(w)
  return subOnce(w, 'export async function postWish(text, meta, { version = null, fetch: f = globalThis.fetch } = {}) {\n',
    "export async function postWish(text, meta, { version = null, fetch: f = globalThis.fetch } = {}) {\n  globalThis.__ptEv?.('wish-blocked', String(text).slice(0, 40)); return { ok: false, reason: 'playtest' }\n", 'wish').text
}

// containers.js: what every search actually rolled
export function patchContainers(c) {
  c = lf(c)
  return subOnce(c, 'export function applyRoll(roll, api) {\n', "export function applyRoll(roll, api) {\n  globalThis.__ptEv?.('roll', roll ? roll.kind + (roll.type ? ':' + roll.type : '') : null)\n", 'applyRoll').text
}

// patchTree(srcDir, outDir): copy <src>/renderer and <src>/net to <out>, then instrument the copy -> a report
export function patchTree(srcDir, outDir) {
  const src = path.resolve(srcDir), out = path.resolve(outDir)
  if (!existsSync(path.join(src, 'renderer', 'game.js'))) throw new Error(`patchTree: ${src} has no renderer/game.js (give the tree's src folder)`)
  const rel = path.relative(path.dirname(src), out)   // the tree's root: <tree>/src -> <tree>
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error('patchTree: the output must lie outside the tree (a scratch folder)')
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true })
  cpSync(path.join(src, 'renderer'), path.join(out, 'renderer'), { recursive: true })
  if (existsSync(path.join(src, 'net'))) cpSync(path.join(src, 'net'), path.join(out, 'net'), { recursive: true })
  const R = path.join(out, 'renderer')
  const g = patchGame(readFileSync(path.join(R, 'game.js'), 'utf8')); writeFileSync(path.join(R, 'game.js'), g.text)
  const a = patchAudio(readFileSync(path.join(R, 'audio.js'), 'utf8')); writeFileSync(path.join(R, 'audio.js'), a.text)
  writeFileSync(path.join(R, 'wish-post.js'), patchWish(readFileSync(path.join(R, 'wish-post.js'), 'utf8')))
  writeFileSync(path.join(R, 'containers.js'), patchContainers(readFileSync(path.join(R, 'containers.js'), 'utf8')))
  return { renderer: R, gameHooks: g.applied, audioWrapped: a.wrapped }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { val } = parseArgs(process.argv.slice(2), ['src', 'out'])
  if (!val.src || !val.out) { process.stderr.write('usage: node tools/pacing/bot/patch.mjs --src <tree>/src --out <scratch>/src\n'); process.exit(2) }
  console.log(JSON.stringify(patchTree(val.src, val.out)))
}
