import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { validateWorld } from '../tools/validate-world.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
const shipped = () => JSON.parse(read('src/renderer/world.json'))
const zeros = () => ({
  '0': { extension: 0, compliance: 0, litigation: 0 },
  '1': { extension: 0, compliance: 0, litigation: 0 },
  '2': { extension: 0, compliance: 0, litigation: 0 },
  '3': { extension: 0, compliance: 0, litigation: 0 },
})
const DOCKET_BAD = 'docket must be four level rows of three non-negative integers'

describe('validateWorld', () => {
  it('passes the shipped world.json', () => {
    expect(validateWorld(shipped())).toEqual({ ok: true })
    expect(validateWorld(shipped(), { headRaw: shipped() })).toEqual({ ok: true })
  })

  it('rejects a docket that is not four rows of three non-negative integers', () => {
    const bad = []
    let d
    d = zeros(); d['1'].extension = -1; bad.push(d)
    d = zeros(); d['1'].compliance = '2'; bad.push(d)
    d = zeros(); d['2'].litigation = 3.5; bad.push(d)
    d = zeros(); d['4'] = { extension: 0, compliance: 0, litigation: 0 }; bad.push(d)
    d = zeros(); delete d['3'].litigation; bad.push(d)
    d = zeros(); d['0'].notice = 0; bad.push(d)
    d = zeros(); delete d['2']; bad.push(d)
    d = zeros(); d['1'] = [0, 0, 0]; bad.push(d)
    bad.push([zeros()['0'], zeros()['1'], zeros()['2'], zeros()['3']])
    bad.push(null, 7, 'docket')
    for (const docket of bad) expect(validateWorld({ ...shipped(), docket })).toEqual({ ok: false, reason: DOCKET_BAD })
  })

  it('accepts real counts', () => {
    const d = zeros(); d['2'].extension = 14; d['0'].compliance = 3
    expect(validateWorld({ ...shipped(), docket: d })).toEqual({ ok: true })
  })

  it('a drift that drops the docket HEAD carries is rejected; without a HEAD docket it is fine', () => {
    const { docket: _d, ...noDocket } = shipped()
    expect(validateWorld(noDocket, { headRaw: { ...noDocket, docket: zeros() } })).toEqual({ ok: false, reason: 'docket was dropped (HEAD has one)' })
    expect(validateWorld(noDocket, { headRaw: null })).toEqual({ ok: true })
    expect(validateWorld(noDocket, { headRaw: noDocket })).toEqual({ ok: true })
    expect(validateWorld(noDocket)).toEqual({ ok: true })
  })

  it('the pre-existing rules keep their exact reasons', () => {
    expect(validateWorld({ palette: { wall: 'yellow' } })).toEqual({ ok: false, reason: 'palette needs wall/ceiling/floor/fog as #rrggbb hex' })
    expect(validateWorld({ items: { types: [] } })).toEqual({ ok: false, reason: 'items.types must be a non-empty array' })
    expect(validateWorld({ fogDistance: -2 })).toEqual({ ok: false, reason: 'fogDistance must be a positive number' })
    expect(validateWorld({ wallDensity: 1.5 })).toEqual({ ok: false, reason: 'wallDensity must be between 0 and 1' })
    expect(validateWorld({ flicker: { rate: 'x' } })).toEqual({ ok: false, reason: 'flicker needs numeric rate/depth/recoverySpeed' })
    expect(validateWorld({ messages: [] })).toEqual({ ok: false, reason: 'messages must be a non-empty array of strings' })
    expect(validateWorld([])).toEqual({ ok: false, reason: 'must be a JSON object' })
    expect(validateWorld(null)).toEqual({ ok: false, reason: 'must be a JSON object' })
  })

  it('the CLI passes the repo and prints the old line', () => {
    const out = execFileSync(process.execPath, ['tools/validate-world.mjs'], { cwd: root, encoding: 'utf8' })
    expect(out).toContain('world.json OK — merges cleanly and all levels build.')
  })
})

describe('the workflows recount the docket', () => {
  const grant = read('.github/workflows/wish-grant.yml')
  const auto = read('.github/workflows/wish-auto.yml')

  it("wish-grant.yml recounts and validates between the Claude step and the PR", () => {
    const claude = grant.indexOf('- name: Call Claude (subscription) to modify world.json')
    const step = grant.indexOf('- name: recount the docket')
    const pr = grant.indexOf('- name: Create branch and PR')
    expect(claude).toBeGreaterThan(-1)
    expect(step).toBeGreaterThan(claude)
    expect(pr).toBeGreaterThan(step)
    const body = grant.slice(step, pr)
    expect(body).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}')
    expect(body).toMatch(/run: node tools\/docket\.mjs && node tools\/validate-world\.mjs/)
  })

  it("wish-auto.yml recounts inside the test group", () => {
    expect(auto).toContain('if ! ( jq . src/renderer/world.json >/dev/null 2>&1 && node tools/docket.mjs && node tools/validate-world.mjs && npm test ); then')
  })

  it('both arbiters are told to leave the docket alone and lean the drift', () => {
    for (const y of [grant, auto]) {
      expect(y).toContain('Never change `docket`')
      expect(y).toContain('lean the drift the way that status wants')
      expect(y).toContain('(EXTENSION: staying; COMPLIANCE: quiet; LITIGATION: naming things).')
    }
    // the arbiter's schema sentence survives
    expect(auto).toContain('{"verdict":"grant"|"partial"|"deny","world":<the full modified world.json of the SAME schema, or null when denying>')
    expect(grant).toContain('You must return ONLY valid JSON matching the input schema exactly')
  })

  it('wish-auto.yml creates the status and amendment labels', () => {
    for (const name of ['amendment', 'status:extension', 'status:compliance', 'status:litigation']) {
      const line = auto.split('\n').find((l) => l.includes('gh label create ' + name + ' '))
      expect(line, name).toBeTruthy()
      expect(line).toContain('--force >/dev/null 2>&1 || true')
    }
  })
})
