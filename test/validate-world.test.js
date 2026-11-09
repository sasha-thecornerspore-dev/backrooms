import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'fs'
import { execFileSync, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import { join } from 'path'
import { validateWorld, NET_WISH } from '../tools/validate-world.mjs'

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

  it('the kill switch for the floor feelings is true or false (or absent); anything else is refused', () => {
    expect(validateWorld({ ...shipped(), feelings: false })).toEqual({ ok: true })
    expect(validateWorld({ ...shipped(), feelings: true })).toEqual({ ok: true })
    const { feelings: _f, ...without } = shipped()
    expect(validateWorld(without)).toEqual({ ok: true })
    for (const feelings of ['false', 0, 1, null, {}, []]) expect(validateWorld({ ...shipped(), feelings })).toEqual({ ok: false, reason: 'feelings must be true or false' })
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

// a granted wish may not change the movement rate: on the wish path (wish: true, the CLI's --wish) any difference in `net` from HEAD
// is refused; the owner's own edit is held only to the bounds (5..20); a checkout without git skips it, as it skips the docket's drop
describe('the wish path leaves the movement rate alone', () => {
  const NO = { ok: false, reason: NET_WISH }
  it('says why in plain words', () => {
    expect(NET_WISH).toBe("net changed: the movement rate is the owner's to set")
  })

  it('a wish that moves net is refused: a field changed, net added, net dropped, a field added', () => {
    const head = shipped()
    const { net: _n, ...noNet } = head
    expect(head.net).toEqual({ posHz: 20 })
    for (const net of [{ posHz: 10 }, { posHz: 5 }, { posHz: 19 }, { posHz: 20, burst: 2 }, {}, { posHz: '20' }, 20, null]) {
      expect(validateWorld({ ...head, net }, { headRaw: head, wish: true }), JSON.stringify(net)).toEqual(NO)
    }
    expect(validateWorld(noNet, { headRaw: head, wish: true })).toEqual(NO)                            // dropped
    expect(validateWorld({ ...noNet, net: { posHz: 20 } }, { headRaw: noNet, wish: true })).toEqual(NO)  // added where HEAD has none
    // out of bounds too: the wish path names the rule a wish broke before the bounds are read
    expect(validateWorld({ ...head, net: { posHz: 99 } }, { headRaw: head, wish: true })).toEqual(NO)
  })

  it('a wish that leaves net alone passes, whatever else it drifts', () => {
    const head = shipped()
    expect(validateWorld(head, { headRaw: head, wish: true })).toEqual({ ok: true })
    expect(validateWorld({ ...head, fogDistance: head.fogDistance + 1, net: { ...head.net } }, { headRaw: head, wish: true })).toEqual({ ok: true })
    const { net: _n, ...noNet } = head
    expect(validateWorld({ ...noNet, feelings: false }, { headRaw: noNet, wish: true })).toEqual({ ok: true })   // absent in both
    // its other rules still hold on the wish path
    expect(validateWorld({ ...head, fogDistance: -1 }, { headRaw: head, wish: true })).toEqual({ ok: false, reason: 'fogDistance must be a positive number' })
  })

  it("the owner's own edit may change net within its bounds, and only within them", () => {
    const head = shipped()
    for (const posHz of [5, 10, 20]) expect(validateWorld({ ...head, net: { posHz } }, { headRaw: head })).toEqual({ ok: true })
    expect(validateWorld({ ...head, net: { posHz: 10 } }, { headRaw: head, wish: false })).toEqual({ ok: true })
    const { net: _n, ...noNet } = head
    expect(validateWorld(noNet, { headRaw: head })).toEqual({ ok: true })
    expect(validateWorld({ ...head, net: { posHz: 21 } }, { headRaw: head })).toEqual({ ok: false, reason: 'net.posHz must be an integer from 5 to 20' })
  })

  it('a checkout with no git HEAD skips the rule, the way the docket rule is skipped', () => {
    const { net: _n, docket: _d, ...bare } = shipped()
    for (const headRaw of [null, undefined]) {
      expect(validateWorld({ ...bare, net: { posHz: 10 } }, { headRaw, wish: true })).toEqual({ ok: true })
      expect(validateWorld(bare, { headRaw, wish: true })).toEqual({ ok: true })
    }
    expect(validateWorld({ ...bare, net: { posHz: 10 } }, { wish: true })).toEqual({ ok: true })
  })
})

// the CLI as the workflows run it, against a HEAD of the test's own making: GIT_DIR points `git show HEAD:…` at a scratch repository
// whose one commit holds the world.json given, so the working tree's file is checked against it and the repo's own HEAD is never used
describe('the CLI: --wish asks for the stricter check', () => {
  let dir, moved, same, none
  const file = () => readFileSync(new URL('../src/renderer/world.json', import.meta.url), 'utf8')
  // git for the scratch repository alone: none of this machine's config (no signing, no hooks path) and a throwaway name
  const git = (repo, args) => execFileSync('git', args, {
    cwd: repo, stdio: 'ignore',
    env: {
      ...process.env, GIT_DIR: join(repo, '.git'), GIT_WORK_TREE: repo, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'empty.gitconfig'),
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@invalid',
    },
  })
  // a scratch repository whose HEAD holds `world` as src/renderer/world.json -> its .git
  const headOf = (name, world) => {
    const repo = join(dir, name)
    mkdirSync(join(repo, 'src', 'renderer'), { recursive: true })
    writeFileSync(join(repo, 'src', 'renderer', 'world.json'), JSON.stringify(world, null, 2) + '\n')
    git(repo, ['init', '-q'])
    git(repo, ['add', 'src/renderer/world.json'])
    git(repo, ['commit', '-q', '-m', 'head'])
    return join(repo, '.git')
  }
  const cli = (args, gitDir) => spawnSync(process.execPath, ['tools/validate-world.mjs', ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GIT_DIR: gitDir },
  })
  // six git calls: on a loaded Windows desk they can run past vitest's default 10 s hook timeout (vitest.config.js raises only the
  // tests'), so the hook gets the same explicit allowance as build-web.test.js's: it fails on what it builds, not on a slow machine
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'validate-world-'))
    writeFileSync(join(dir, 'empty.gitconfig'), '')
    const world = JSON.parse(file())
    moved = headOf('moved', { ...world, net: { posHz: world.net?.posHz === 10 ? 20 : 10 } })   // HEAD's rate is not the file's
    same = headOf('same', { ...world, fogDistance: world.fogDistance + 1 })                      // HEAD differs, but not in net
    none = join(dir, 'no-such-repo', '.git')                                                     // no HEAD to read
  }, 120000)
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('a wish that moved net is refused with the plain message, and exits non-zero', () => {
    const r = cli(['--wish'], moved)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('world.json REJECTED: ' + NET_WISH)
  })
  it("the owner's run, without the flag, passes the same change within its bounds", () => {
    const r = cli([], moved)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('world.json OK — merges cleanly and all levels build.')
  })
  it('a wish that left net alone passes', () => {
    const r = cli(['--wish'], same)
    expect([r.status, r.stdout.includes('world.json OK')]).toEqual([0, true])
  })
  it('with no git HEAD the rule is skipped', () => {
    const r = cli(['--wish'], none)
    expect([r.status, r.stdout.includes('world.json OK')]).toEqual([0, true])
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
    expect(body).toMatch(/run: node tools\/docket\.mjs && node tools\/validate-world\.mjs --wish\r?\n/)
  })

  it("wish-auto.yml recounts inside the test group", () => {
    expect(auto).toContain('if ! ( jq . src/renderer/world.json >/dev/null 2>&1 && node tools/docket.mjs && node tools/validate-world.mjs --wish && npm test ); then')
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
