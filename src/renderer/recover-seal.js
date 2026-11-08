// recover-seal.js — the note seal (v1), the maze's half.
//
// A recovery case may ship SEALED: each instrument's note as onSolveSealed and the closing file as rewardSealed, both AES-256-GCM
// ({ iv, ct } in base64url, ct = ciphertext || 16-byte tag). A correct filing derives that instrument's key from (case, instrument,
// normalized answer) with HKDF-SHA-256 and keeps the KEY — never the answer — beside the read mark:
//   cs.case.<case>.<station>      = '1'                       the read mark (every counter of read marks counts these)
//   cs.case.<case>.<station>.key  = '1:' + base64url(secret)  the kept key (dotted, never '1', so no counter counts it)
//   cs.case.<case>.<station>.note = the note text              this browser's copy of a note it read while the case shipped plain
//   cs.case.<case>.reward.seen    = the closing file as JSON   the same, for the closing file
// The closing file opens only with the keys of every instrument. This stops READING a file, not SEARCHING it: a short answer can still
// be found offline against the public gate hash.
//
// This is the same code as the board's recover/engine.js ('the note seal') on the site: the same salt, the same HKDF info strings, the
// same storage names, so a case filed in the maze opens on the board and the other way round (they share an origin on the site). The
// vectors in test/fixtures/recover-seal-v1.json were made by an independent node:crypto implementation and prove the two agree.
//
// Pure apart from WebCrypto and the storage it is handed. createSeal({ storage }) -> the keyring; the helpers below it are exported
// for the tests and for anything that wants to read a case without a keyring.

export const SEAL = 1
const SEAL_SALT = 'cornerspore:seal:1'
const GATE_SALT = 'cornerspore:'
const REWARD_FIELDS = ['title', 'text', 'fieldText', 'key', 'href', 'linkLabel']

export function normalize(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '') }
const utf8 = (s) => new TextEncoder().encode(String(s))
const subtle = () => (globalThis.crypto && globalThis.crypto.subtle) || null

export function b64u(u8) {
  let s = ''
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
// strict: refuses anything but canonical base64url, exactly like the board
export function unb64u(str) {
  str = String(str == null ? '' : str)
  if (!/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) throw new Error('bad base64url')
  let s = str.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  const bin = atob(s), out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  if (b64u(out) !== str) throw new Error('non-canonical base64url')
  return out
}
function concatBytes(list) {
  let n = 0
  for (const x of list) n += x.length
  const out = new Uint8Array(n)
  let o = 0
  for (const x of list) { out.set(x, o); o += x.length }
  return out
}

async function hkdf(ikm, info) {
  const k = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: utf8(SEAL_SALT), info: utf8(info) }, k, 256))
}
export function stationSecret(caseId, stationId, answer) {
  const n = normalize(answer)
  if (!n) return Promise.reject(new Error('empty answer'))
  return hkdf(utf8(n), 'station|' + caseId + '|' + stationId)
}
export function textKey(caseId, stationId, secret) { return hkdf(secret, 'onSolve|' + caseId + '|' + stationId) }
export async function rewardKey(caseId, stationIds, secrets) {
  if (!secrets.length || secrets.some((x) => !x || !ArrayBuffer.isView(x) || x.length !== 32)) throw new Error('need one 32-byte secret per instrument')
  return hkdf(concatBytes(secrets), 'reward|' + caseId + '|' + stationIds.join(','))
}
// the plaintext, or null on ANY failure — never throws
export async function openBlob(keyBytes, blob) {
  try {
    if (!keyBytes || !blob || typeof blob.iv !== 'string' || typeof blob.ct !== 'string') return null
    const iv = unb64u(blob.iv), ct = unb64u(blob.ct)
    if (iv.length !== 12 || ct.length < 17) return null
    const k = await subtle().importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt'])
    return new TextDecoder('utf-8', { fatal: true }).decode(await subtle().decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, k, ct))
  } catch (e) { return null }
}

async function sha256hex(str) {
  const buf = await subtle().digest('SHA-256', utf8(str))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}
export async function gateHash(answer) { return sha256hex(GATE_SALT + normalize(answer)) }
export async function checkGate(input, gate) {
  if (!gate || !normalize(input)) return false
  if (gate.type === 'sha256') return (await gateHash(input)) === String(gate.hash || '').toLowerCase()
  return false
}

// a manifest this build can read (no seal, or seal v1) / one that is sealed
export const sealKnown = (m) => !!m && (m.seal == null || m.seal === SEAL)
export const isSealed = (m) => !!m && m.seal === SEAL

function rewardJson(r) { const o = {}; for (const k of REWARD_FIELDS) if (r && r[k] !== undefined) o[k] = r[k]; return JSON.stringify(o) }
function memoryStorage() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)) } } }
function defaultStorage() { try { return globalThis.localStorage || memoryStorage() } catch (e) { return memoryStorage() } }

// the keyring over one storage (localStorage in the game). Every read and write is wrapped: a storage that throws (private windows,
// blocked site data) falls back to memory for this page, and a filing never costs progress.
export function createSeal({ storage = defaultStorage() } = {}) {
  const mem = new Map()
  const get = (k) => { try { const v = storage.getItem(k); if (v != null) return v } catch (e) {} return mem.has(k) ? mem.get(k) : null }
  const set = (k, v) => { mem.set(k, v); try { storage.setItem(k, v); return true } catch (e) { return false } }
  const kkey = (c, s) => 'cs.case.' + c + '.' + s
  const isSolved = (c, s) => get(kkey(c, s)) === '1'
  const markSolved = (c, s) => { set(kkey(c, s), '1') }
  const keepSecret = (c, s, secret) => set(kkey(c, s) + '.key', SEAL + ':' + b64u(secret))
  function secretOf(c, s) {
    const v = get(kkey(c, s) + '.key')
    if (typeof v !== 'string' || v.indexOf(SEAL + ':') !== 0) return null
    try { const b = unb64u(v.slice(String(SEAL).length + 1)); return b.length === 32 ? b : null } catch (e) { return null }
  }
  const noteCopy = (c, s) => { const v = get(kkey(c, s) + '.note'); return typeof v === 'string' && v ? v : null }
  const keepNoteCopy = (c, s, text) => { if (typeof text === 'string' && text && noteCopy(c, s) !== text) set(kkey(c, s) + '.note', text) }
  const rewardName = (c) => 'cs.case.' + c + '.reward.seen'
  function rewardCopy(c) {
    try { const r = JSON.parse(get(rewardName(c))); return r && typeof r === 'object' && typeof r.title === 'string' && typeof r.text === 'string' ? r : null } catch (e) { return null }
  }
  const keepRewardCopy = (c, r) => { if (r && typeof r.title === 'string') { const v = rewardJson(r); if (get(rewardName(c)) !== v) set(rewardName(c), v) } }
  const complete = (m) => { const st = (m && m.stations) || []; return st.length > 0 && st.every((s) => isSolved(m.id, s.id)) }

  // file an answer: the gate decides; on a pass the key is derived and kept BEFORE the read mark is set.
  // -> { ok: false } | { ok: true, kept }. kept is false only when this browser cannot derive keys; the read mark is set anyway.
  async function fileAnswer(manifest, station, input) {
    if (!(await checkGate(input, station.gate))) return { ok: false, kept: false }
    let kept = false
    try { keepSecret(manifest.id, station.id, await stationSecret(manifest.id, station.id, input)); kept = true } catch (e) {}
    markSolved(manifest.id, station.id)
    return { ok: true, kept }
  }
  const opened = new Map()
  async function openByKey(manifest, station) {
    const sec = secretOf(manifest.id, station.id), blob = station.onSolveSealed || {}
    if (!sec) return null
    const memo = manifest.id + '|' + station.id + '|' + b64u(sec) + '|' + blob.iv + '|' + blob.ct
    if (!opened.has(memo)) { try { opened.set(memo, await openBlob(await textKey(manifest.id, station.id, sec), blob)) } catch (e) { return null } }
    return opened.get(memo)
  }
  // a read instrument's note -> { text, from: 'plain' | 'key' | 'copy' } | null (nothing this browser can open)
  async function openStation(manifest, station) {
    try {
      if (!sealKnown(manifest)) return null
      if (!isSealed(manifest)) {
        const t = String(station.onSolve || '')
        if (isSolved(manifest.id, station.id)) keepNoteCopy(manifest.id, station.id, t)
        return { text: t, from: 'plain' }
      }
      const k = await openByKey(manifest, station)
      if (k != null) return { text: k, from: 'key' }
      const c = noteCopy(manifest.id, station.id)
      return c != null ? { text: c, from: 'copy' } : null
    } catch (e) { return null }
  }
  // the closing file -> { none } · { reward, from } · { missing: [stations] } · { error, newer? }
  async function openReward(manifest) {
    try {
      if (!sealKnown(manifest)) return { error: true, newer: true }
      if (!isSealed(manifest)) {
        if (!manifest.reward) return { none: true }
        if (complete(manifest)) keepRewardCopy(manifest.id, manifest.reward)
        return { reward: manifest.reward, from: 'plain' }
      }
      if (!manifest.rewardSealed) return { none: true }
      const st = manifest.stations || [], missing = [], secrets = []
      for (const s of st) { if ((await openByKey(manifest, s)) != null) secrets.push(secretOf(manifest.id, s.id)); else missing.push(s) }
      if (missing.length) { const copy = rewardCopy(manifest.id); return copy ? { reward: copy, from: 'copy' } : { missing } }
      const txt = await openBlob(await rewardKey(manifest.id, st.map((s) => s.id), secrets), manifest.rewardSealed)
      const rw = JSON.parse(txt)
      if (rw && typeof rw === 'object' && typeof rw.title === 'string' && typeof rw.text === 'string') return { reward: rw, from: 'key' }
    } catch (e) {}
    return { error: true }
  }
  return { isSolved, markSolved, keepSecret, secretOf, noteCopy, rewardCopy, complete, fileAnswer, openStation, openReward }
}
