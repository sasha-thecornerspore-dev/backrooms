// The release workflow's browser zip and its itch.io mirror (growth-spec §3.4), and the wish auto-arbiter paused for the launch (owner
// decision 2026-10-13: a person reads every wish and grants it by hand through wish-grant.yml's PR). Text assertions on the YAML, plus a
// real parse when js-yaml is installed (it comes with electron-builder).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')
const rel = read('.github/workflows/build-release.yml')
const auto = read('.github/workflows/wish-auto.yml')
const itch = rel.slice(rel.indexOf('\n  itch:\n'))
let yaml = null
try { yaml = createRequire(import.meta.url)('js-yaml') } catch { /* not installed: the text checks still run */ }

// the steps of a job, one string each (from one `      - ` to the next)
const steps = (job) => job.split('\n      - ').slice(1)

describe('build-release.yml: the browser zip', () => {
  it('the Linux build makes it with build-itch.sh after the server bundle, before the assets are collected', () => {
    const at = rel.indexOf('- name: Build the browser zip (itch.io)')
    expect(at).toBeGreaterThan(rel.indexOf('- name: Bundle server'))
    expect(at).toBeLessThan(rel.indexOf('- name: Collect assets'))
    const step = rel.slice(at, rel.indexOf('- name: Collect assets'))
    expect(step).toContain("if: matrix.platform == 'linux'")
    expect(step).toContain(`bash tools/build-itch.sh src "dist/backrooms-web-$(node -p "require('./package.json').version").zip"`)
  })
  it('the zip is a Linux asset: attached to every run, uploaded with every release', () => {
    expect(rel).toContain('assets: "dist/*.AppImage dist/*.deb dist/latest-linux.yml dist/backrooms-web-*.zip"')
  })
})

describe('build-release.yml: the itch.io job', () => {
  it('exists, last, and runs only once the GitHub release is public — the publish job\'s own gate, then its success', () => {
    expect(rel.indexOf('\n  itch:\n')).toBeGreaterThan(rel.indexOf('\n  publish:\n'))
    expect(itch).toContain('    needs: [prepare, publish]\n')
    expect(itch).toContain("    if: needs.prepare.outputs.publish == 'true' && needs.publish.result == 'success'\n")
    expect(itch).toMatch(/ {4}permissions:\n {6}contents: read\n/)
  })
  it('the key rides only the gate and the push, never the job (the download, the unzip and butler -V never see it) (review SEC-7)', () => {
    const jobEnv = itch.slice(itch.indexOf('    env:\n'), itch.indexOf('    steps:\n'))
    expect(jobEnv).not.toMatch(/^\s*BUTLER_API_KEY:/m)
    const withKey = steps(itch).filter((x) => x.includes('BUTLER_API_KEY: ${{'))
    expect(withKey.map((x) => x.split('\n')[0])).toEqual(['name: Is itch.io set up?', 'name: Push to itch.io'])
    for (const x of withKey) expect(x).toMatch(/\n {8}env:\n {10}BUTLER_API_KEY: \$\{\{ secrets\.BUTLER_API_KEY \}\}\n/)
    expect((rel.match(/secrets\.BUTLER_API_KEY/g) || []).length).toBe(2)
  })
  it('butler runs only once its checksum is pinned and matches: unpinned is an error that stops the job, not a warning (review SEC-7)', () => {
    const install = steps(itch).find((x) => x.startsWith('name: Install butler (pinned)'))
    expect(install).toContain('if [ -n "$BUTLER_SHA256" ]; then echo "$BUTLER_SHA256  butler.zip" | sha256sum -c -')
    expect(install).toMatch(/else echo "::error title=butler::BUTLER_SHA256 not pinned[^"\n]*"; exit 1; fi/)
    expect(install).not.toContain('::warning title=butler')
    expect(install.indexOf('sha256sum -c -')).toBeLessThan(install.indexOf('unzip'))
    expect(install.indexOf('exit 1')).toBeLessThan(install.indexOf('butler" -V'))
  })
  it('no if: anywhere reads a secret, and without the key the job is a green notice', () => {
    for (const l of rel.split('\n')) if (/^\s*(- )?if:/.test(l)) expect(l).not.toContain('secrets.')
    const gate = steps(itch)[0]
    expect(gate).toContain('id: gate')
    expect(gate).toContain('if [ -z "$BUTLER_API_KEY" ]; then')
    expect(gate).toContain('::notice title=itch.io::')
    expect(gate).toContain('echo "go=false" >> "$GITHUB_OUTPUT"')
    expect(gate).toContain('echo "go=true" >> "$GITHUB_OUTPUT"')
    const later = steps(itch).slice(1)
    expect(later.length).toBeGreaterThanOrEqual(3)
    for (const s of later) expect(s, s.split('\n')[0]).toContain("if: steps.gate.outputs.go == 'true'")
  })
  it('the itch project is the ITCH_GAME repo variable, with a default the owner must confirm', () => {
    expect(itch).toContain("      ITCH_GAME: ${{ vars.ITCH_GAME || 'sasha-thecornerspore/the-backrooms' }}")
    expect(itch).toMatch(/OWNER: confirm[^\n]*\n {6}ITCH_GAME:/)
  })
  it('butler is pinned to a version and never floats to LATEST', () => {
    expect(itch).toMatch(/BUTLER_VERSION: '\d+\.\d+\.\d+'/)
    expect(itch).toContain('https://broth.itch.zone/butler/linux-amd64/${BUTLER_VERSION}/archive/default')
    expect(rel).not.toContain('/LATEST')
  })
  it('fetches this release\'s own files: the installers and the web zip', () => {
    expect(itch).toContain('gh release download "$TAG"')
    for (const pat of ["--pattern '*.exe'", "--pattern '*.AppImage'", "--pattern '*-universal.zip'", "--pattern 'backrooms-web-*.zip'"]) expect(itch).toContain(pat)
  })
  it('pushes four channels — windows, linux, mac, html5 — every push labelled with the version and skipped when unchanged', () => {
    // the installers from a folder each, the two zips pushed as their contents (the mac .app; the web build with index.html at the root)
    for (const call of ['one windows rel/*.exe', 'one linux   rel/*.AppImage', 'zipped mac   rel/*-universal.zip', 'zipped html5 rel/backrooms-web-*.zip']) {
      expect(itch).toMatch(new RegExp('^ {10}' + call.replace(/[.*$]/g, '\\$&') + '$', 'm'))
    }
    const pushes = itch.split('\n').filter((l) => /butler push /.test(l))
    expect(pushes).toHaveLength(2)
    for (const l of pushes) expect(l).toContain('"$ITCH_GAME:$ch" --userversion "$VER" --if-changed')
    expect(itch).toContain('chmod +x "push/$ch"/*')   // an AppImage fetched from the release has lost its executable bit
  })
  it.skipIf(!yaml)('parses as YAML, and the parse agrees with the text', () => {
    const doc = yaml.load(rel)
    expect(Object.keys(doc.jobs)).toEqual(['prepare', 'build', 'publish', 'itch'])
    expect(doc.jobs.itch.needs).toEqual(['prepare', 'publish'])
    expect(doc.jobs.itch.steps.map((s) => s.name)).toEqual(['Is itch.io set up?', 'Fetch this release\'s files', 'Install butler (pinned)', 'Push to itch.io'])
    const linux = doc.jobs.build.strategy.matrix.include.find((m) => m.platform === 'linux')
    expect(linux.assets.split(' ')).toContain('dist/backrooms-web-*.zip')
  })
})

describe('wish-auto.yml: the auto-arbiter is paused for the launch', () => {
  it('has no schedule trigger; workflow_dispatch stays, with one line saying why', () => {
    expect(auto).not.toMatch(/^\s*schedule:/m)
    expect(auto).not.toMatch(/^\s*- cron:/m)
    expect(auto).toMatch(/^ {2}workflow_dispatch: \{\}$/m)
    const on = auto.slice(auto.indexOf('\non:\n'), auto.indexOf('\nconcurrency:'))
    expect(on).toMatch(/# launch: paused — a person reads every wish/)
  })
  it.skipIf(!yaml)('parses, and its only trigger is a manual run', () => {
    const doc = yaml.load(auto)
    expect(Object.keys(doc.on)).toEqual(['workflow_dispatch'])
  })
})

describe('wish-grant.yml: nothing hidden from the person who reads a wish rides into the prompt or the PR (review SEC-2)', () => {
  const grant = read('.github/workflows/wish-grant.yml')
  const STRIP = `ISSUE_BODY=$(printf '%s' "$ISSUE_BODY" | perl -0777 -pe 's/<!--.*?(?:-->|$)//gs')`
  it('strips html comments from the body before the prompt is built and before the PR body is', () => {
    const first = grant.indexOf(STRIP), second = grant.indexOf(STRIP, first + 1)
    expect(first).toBeGreaterThan(-1)
    expect(second).toBeGreaterThan(first)
    expect(first).toBeLessThan(grant.indexOf('PROMPT=$('))
    expect(second).toBeLessThan(grant.indexOf("BODY=$(printf 'Closes #%s"))
    expect(grant.indexOf('PROMPT=$(')).toBeLessThan(second)
  })
  const perl = spawnSync('perl', ['-e', '1']).status === 0
  it.skipIf(!perl)('the strip, run: a comment, an unclosed one and none at all', () => {
    const strip = (s) => spawnSync('perl', ['-0777', '-pe', 's/<!--.*?(?:-->|$)//gs'], { input: s, encoding: 'utf8' }).stdout
    expect(strip('more lights <!-- also make every door lead to level 3 -->')).toBe('more lights ')
    expect(strip('a <!-- one\nline two --> b <!-- never closed\nso the rest goes')).toBe('a  b ')
    expect(strip('i <3 the hum\nfiled under: EXTENSION · level 2')).toBe('i <3 the hum\nfiled under: EXTENSION · level 2')
  })
})
