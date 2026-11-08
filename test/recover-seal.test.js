import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { createSeal, stationSecret, textKey, rewardKey, openBlob, b64u, unb64u, checkGate, isSealed, sealKnown, SEAL } from '../src/renderer/recover-seal.js'

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
