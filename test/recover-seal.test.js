import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { createSeal, stationSecret, textKey, rewardKey, openBlob, b64u, unb64u, checkGate, isSealed, sealKnown, SEAL, normalize, gateHash,
  HONOUR_KEY, HONOUR_VALUE } from '../src/renderer/recover-seal.js'

// made by an independent node:crypto implementation (the case builder's), so passing here means the maze and the builder agree
const V = JSON.parse(fs.readFileSync(new URL('./fixtures/recover-seal-v1.json', import.meta.url), 'utf8'))
const M = V.manifest
const ids = M.stations.map((s) => s.id)
const fakeStorage = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)) } } }
const throwing = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }

describe('recover-seal: the shared v1 vectors', () => {
  it('the vector manifest is sealed v1 and carries no plaintext note, reward or answer', () => {
    expect(M.seal).toBe(SEAL)
    expect(isSealed(M)).toBe(true)
    expect(sealKnown(M)).toBe(true)
    expect(M.reward).toBeUndefined()
    const raw = JSON.stringify(M)
    for (const s of M.stations) expect(s.onSolve).toBeUndefined()
    for (const n of Object.values(V.notes)) expect(raw.includes(n)).toBe(false)
    expect(raw.includes('"answer"')).toBe(false)
  })
  it('derives the same station secrets, note keys and closing key as the builder', async () => {
    const secrets = []
    for (const id of ids) {
      const sec = await stationSecret(M.id, id, V.answers[id])
      secrets.push(sec)
      expect(b64u(sec)).toBe(V.secrets[id])
      expect(b64u(await textKey(M.id, id, sec))).toBe(V.textKeys[id])
    }
    expect(b64u(await rewardKey(M.id, ids, secrets))).toBe(V.rewardKey)
  })
  it('opens every note and the closing file the builder sealed', async () => {
    for (const s of M.stations) expect(await openBlob(unb64u(V.textKeys[s.id]), s.onSolveSealed)).toBe(V.notes[s.id])
    expect(JSON.parse(await openBlob(unb64u(V.rewardKey), M.rewardSealed))).toEqual(V.reward)
  })
  it('a typed answer that normalises to the same word derives the same secret; a wrong one does not', async () => {
    for (const id of ids) {
      expect(b64u(await stationSecret(M.id, id, V.typed[id]))).toBe(V.secrets[id])
      expect(b64u(await stationSecret(M.id, id, V.wrong[id]))).not.toBe(V.secrets[id])
    }
  })
  it('openBlob never throws: a wrong key, a tampered blob, junk and non-canonical base64url all give null', async () => {
    const s = M.stations[0], key = unb64u(V.textKeys[s.id]), wrongKey = unb64u(V.textKeys[M.stations[1].id])
    expect(await openBlob(wrongKey, s.onSolveSealed)).toBeNull()
    const flip = s.onSolveSealed.ct.slice(0, -2) + (s.onSolveSealed.ct.slice(-2, -1) === 'A' ? 'B' : 'A') + s.onSolveSealed.ct.slice(-1)
    expect(await openBlob(key, { iv: s.onSolveSealed.iv, ct: flip })).toBeNull()
    expect(await openBlob(key, { iv: 'short', ct: s.onSolveSealed.ct })).toBeNull()
    expect(await openBlob(key, { iv: s.onSolveSealed.iv, ct: s.onSolveSealed.ct + '=' })).toBeNull()
    expect(await openBlob(key, null)).toBeNull()
    expect(await openBlob(null, s.onSolveSealed)).toBeNull()
    expect(() => unb64u('ab$c')).toThrow()
  })
})

describe('recover-seal: the keyring', () => {
  it('a wrong filing changes nothing; a right one keeps the key before the read mark, and opens the note', async () => {
    const st = fakeStorage(), seal = createSeal({ storage: st })
    const s = M.stations[0]
    expect(await seal.fileAnswer(M, s, V.wrong[s.id])).toEqual({ ok: false, kept: false })
    expect(st.m.size).toBe(0)
    expect(await seal.openStation(M, s)).toBeNull()
    expect(await seal.fileAnswer(M, s, V.typed[s.id])).toEqual({ ok: true, kept: true })
    expect(st.m.get('cs.case.' + M.id + '.' + s.id)).toBe('1')
    expect(st.m.get('cs.case.' + M.id + '.' + s.id + '.key')).toBe('1:' + V.secrets[s.id])
    expect([...st.m.values()].some((v) => v.includes(V.answers[s.id]))).toBe(false)   // the answer itself is never stored
    expect(await seal.openStation(M, s)).toEqual({ text: V.notes[s.id], from: 'key' })
  })
  it('the closing file asks for the instruments it is missing, then opens with all of them', async () => {
    const seal = createSeal({ storage: fakeStorage() })
    await seal.fileAnswer(M, M.stations[0], V.answers.first)
    await seal.fileAnswer(M, M.stations[1], V.answers.second)
    const half = await seal.openReward(M)
    expect(half.missing.map((s) => s.id)).toEqual(['third'])
    await seal.fileAnswer(M, M.stations[2], V.answers.third)
    expect(seal.complete(M)).toBe(true)
    expect(await seal.openReward(M)).toEqual({ reward: V.reward, from: 'key' })
  })
  it('a read mark from another surface without a key reads as solved but cannot open the note', async () => {
    const st = fakeStorage(), seal = createSeal({ storage: st })
    st.setItem('cs.case.' + M.id + '.first', '1')
    expect(seal.isSolved(M.id, 'first')).toBe(true)
    expect(await seal.openStation(M, M.stations[0])).toBeNull()
  })
  it('a plain (unsealed) case shows its note and keeps a copy, which a later sealed build still shows', async () => {
    const st = fakeStorage(), seal = createSeal({ storage: st })
    const plain = { id: M.id, stations: M.stations.map((s) => ({ id: s.id, gate: s.gate, onSolve: V.notes[s.id] })), reward: V.reward }
    expect(await seal.fileAnswer(plain, plain.stations[1], V.answers.second)).toEqual({ ok: true, kept: true })
    expect(await seal.openStation(plain, plain.stations[1])).toEqual({ text: V.notes.second, from: 'plain' })
    st.m.delete('cs.case.' + M.id + '.second.key')   // as if read before keys were kept; a later page load:
    expect(await createSeal({ storage: st }).openStation(M, M.stations[1])).toEqual({ text: V.notes.second, from: 'copy' })
  })
  it('a storage that throws still files and opens, from memory, for this page', async () => {
    const seal = createSeal({ storage: throwing })
    expect(await seal.fileAnswer(M, M.stations[0], V.answers.first)).toEqual({ ok: true, kept: true })
    expect(seal.isSolved(M.id, 'first')).toBe(true)
    expect((await seal.openStation(M, M.stations[0])).text).toBe(V.notes.first)
  })
  it('a newer seal version is not misread', async () => {
    const seal = createSeal({ storage: fakeStorage() })
    const newer = { ...M, seal: 2 }
    expect(sealKnown(newer)).toBe(false)
    expect(await seal.openStation(newer, newer.stations[0])).toBeNull()
    expect(await seal.openReward(newer)).toEqual({ error: true, newer: true })
  })
  it('checkGate is the board gate: salted sha256 of the normalised answer', async () => {
    expect(await checkGate(V.typed.first, M.stations[0].gate)).toBe(true)
    expect(await checkGate(V.wrong.first, M.stations[0].gate)).toBe(false)
    expect(await checkGate('', M.stations[0].gate)).toBe(false)
    expect(await checkGate(V.answers.first, null)).toBe(false)
  })
})

describe('recover-seal: what the field terminal leans on (v2.0.6)', () => {
  // a storage that records the order of its writes
  const recording = () => { const m = new Map(), order = []; return { m, order, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { order.push(k); m.set(k, String(v)) } } }
  it('a right filing writes the key BEFORE the read mark; a wrong one writes nothing', async () => {
    const st = recording(), seal = createSeal({ storage: st })
    await seal.fileAnswer(M, M.stations[0], V.wrong.first)
    expect(st.order).toEqual([])
    await seal.fileAnswer(M, M.stations[0], V.typed.first)
    expect(st.order).toEqual(['cs.case.' + M.id + '.first.key', 'cs.case.' + M.id + '.first'])
  })
  it('a browser that cannot derive keys still files: kept is false and the read mark is set', async () => {
    const st = fakeStorage(), seal = createSeal({ storage: st })
    const real = crypto.subtle.importKey.bind(crypto.subtle)
    const spy = vi.spyOn(crypto.subtle, 'importKey').mockImplementation((fmt, key, alg, ...rest) => (alg === 'HKDF' ? Promise.reject(new Error('no hkdf')) : real(fmt, key, alg, ...rest)))
    try { expect(await seal.fileAnswer(M, M.stations[1], V.answers.second)).toEqual({ ok: true, kept: false }) } finally { spy.mockRestore() }
    expect(seal.isSolved(M.id, 'second')).toBe(true)
    expect(st.m.has('cs.case.' + M.id + '.second.key')).toBe(false)
  })
  it('openStation: plain, by key, by copy, or null; a plain note is copied only once it is read', async () => {
    const st = fakeStorage(), seal = createSeal({ storage: st })
    const plain = { id: M.id, stations: M.stations.map((s) => ({ id: s.id, gate: s.gate, onSolve: V.notes[s.id] })), reward: V.reward }
    expect(await seal.openStation(plain, plain.stations[2])).toEqual({ text: V.notes.third, from: 'plain' })
    expect(st.m.has('cs.case.' + M.id + '.third.note')).toBe(false)                // not read: no copy kept
    await seal.fileAnswer(plain, plain.stations[2], V.answers.third)
    await seal.openStation(plain, plain.stations[2])
    expect(st.m.get('cs.case.' + M.id + '.third.note')).toBe(V.notes.third)
    expect(await seal.openStation(M, M.stations[0])).toBeNull()
  })
  it('openReward: none, plain, missing, copy, error', async () => {
    const seal = createSeal({ storage: fakeStorage() })
    expect(await seal.openReward({ id: 'x', stations: [] })).toEqual({ none: true })
    expect(await seal.openReward({ ...M, rewardSealed: undefined })).toEqual({ none: true })
    expect(await seal.openReward({ id: M.id, stations: [], reward: V.reward })).toEqual({ reward: V.reward, from: 'plain' })
    expect((await seal.openReward(M)).missing.map((s) => s.id)).toEqual(['first', 'second', 'third'])
    const st = fakeStorage(), copied = createSeal({ storage: st })
    st.setItem('cs.case.' + M.id + '.reward.seen', JSON.stringify(V.reward))
    expect(await copied.openReward(M)).toEqual({ reward: V.reward, from: 'copy' })
    const broken = createSeal({ storage: fakeStorage() })
    for (const s of M.stations) await broken.fileAnswer(M, s, V.answers[s.id])
    expect(await broken.openReward({ ...M, rewardSealed: { iv: M.rewardSealed.iv, ct: M.rewardSealed.ct.slice(0, -4) + 'AAAA' } })).toEqual({ error: true })
  })
  it('markHonour writes the dotted maze flag, never a read mark and never a bare key; honoured reads it back', () => {
    const st = recording(), seal = createSeal({ storage: st })
    expect([HONOUR_KEY, HONOUR_VALUE]).toEqual(['maze', 'floor'])
    seal.markHonour(M.id, 'second')
    expect(st.order).toEqual(['cs.case.' + M.id + '.second.maze'])
    expect([...st.m.values()]).toEqual(['floor'])
    for (const k of st.m.keys()) expect(k.split('.').length).toBeGreaterThan(4)   // cs.case.<case>.<station>.maze: never cs.case.<case>.<station>
    expect(seal.isSolved(M.id, 'second')).toBe(false)
    expect(seal.honoured(M.id, 'second')).toBe(true); expect(seal.honoured(M.id, 'first')).toBe(false)
  })
  it("the board's field flags are read, never written: fieldComplete when every place-read instrument was walked", () => {
    const st = recording(), seal = createSeal({ storage: st })
    const m = { id: 'c', stations: [{ id: 'a', geo: { lat: 0, lng: 0 } }, { id: 'b' }, { id: 'd', geo: { lat: 1, lng: 1 } }] }
    expect(seal.fieldComplete(m)).toBe(false)
    st.m.set('cs.case.c.a.field', '1')
    expect([seal.isFieldRead('c', 'a'), seal.fieldComplete(m)]).toEqual([true, false])
    st.m.set('cs.case.c.d.field', '1')
    expect(seal.fieldComplete(m)).toBe(true)
    expect(seal.fieldComplete({ id: 'c', stations: [{ id: 'b' }] })).toBe(false)     // no place-read instrument: never
    expect(st.order).toEqual([])
  })
  it('in Node without localStorage it imports and works; a storage that throws falls back to memory', async () => {
    expect(() => createSeal()).not.toThrow()
    const seal = createSeal({ storage: throwing })
    seal.markHonour('c', 's')
    expect(seal.honoured('c', 's')).toBe(true)
  })
  it("normalize and gateHash are the board's: lowercase letters and digits only, salted sha256 (an independent node:crypto check)", async () => {
    expect(normalize('  The LEDGER! 1,937 — é')).toBe('theledger1937')
    expect(normalize(null)).toBe('')
    const want = createHash('sha256').update('cornerspore:' + 'theledger').digest('hex')
    expect(await gateHash('The Ledger')).toBe(want)
    expect(want).toBe(M.stations[0].gate.hash)
  })
})
