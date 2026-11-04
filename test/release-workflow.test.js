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
    expect(itch).toContain("    if: always() && needs.prepare.outputs.publish == 'true' && needs.publish.result == 'success'\n")
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
    expect(Object.keys(doc.jobs)).toEqual(['prepare', 'build', 'mac', 'publish', 'itch'])
    expect(doc.jobs.itch.needs).toEqual(['prepare', 'publish'])
    expect(doc.jobs.itch.steps.map((s) => s.name)).toEqual(['Is itch.io set up?', 'Fetch this release\'s files', 'Install butler (pinned)', 'Push to itch.io'])
    const linux = doc.jobs.build.strategy.matrix.include.find((m) => m.platform === 'linux')
    expect(linux.assets.split(' ')).toContain('dist/backrooms-web-*.zip')
  })
})

// 2.0.4's mac leg was cancelled three times (GitHub had no runner free): continue-on-error covers a failed leg, not a cancelled one, so
// the build matrix came out cancelled and the publish was skipped for Windows and Linux too. macOS is a job of its own since 2.0.5.
describe('build-release.yml: macOS cannot hold the release back', () => {
  const head = (name) => {   // the job's own keys (four spaces in), not its steps or its matrix
    const lines = rel.split('\n')
    const out = []
    for (let i = lines.indexOf(`  ${name}:`) + 1; i < lines.length && !/^ {2}\S/.test(lines[i]); i++) if (/^ {4}\S/.test(lines[i])) out.push(lines[i])
    return out.join('\n') + '\n'
  }
  it('the build matrix is Windows and Linux; macOS is the mac job, after it, on the same trigger', () => {
    const build = rel.slice(rel.indexOf('\n  build:\n'), rel.indexOf('\n  mac:\n'))
    expect(build).toContain('platform: win')
    expect(build).toContain('platform: linux')
    expect(build).not.toContain('platform: mac')
    const mac = rel.slice(rel.indexOf('\n  mac:\n'), rel.indexOf('\n  publish:\n'))
    expect(mac).toContain('platform: mac')
    expect(mac).toContain('assets: "dist/*.dmg dist/*.zip dist/*.zip.blockmap dist/latest-mac.yml"')
    expect(head('mac')).toContain('    needs: prepare\n')
    expect(head('mac')).toContain("    if: needs.prepare.outputs.build == 'true'")
    expect(head('build')).toContain("    if: needs.prepare.outputs.build == 'true'")
  })
  it('the mac job runs the build job\'s own steps (one list, a YAML alias), and only it may fail without failing the run', () => {
    expect(head('build')).toContain('    steps: &installer-steps')
    expect(head('mac')).toMatch(/^ {4}steps: \*installer-steps(\s|$)/m)
    expect(head('mac')).toMatch(/^ {4}continue-on-error: true(\s|$)/m)
    expect(head('build')).not.toContain('continue-on-error')
    expect(rel).not.toContain('matrix.optional')
    expect(rel.match(/^ {4}continue-on-error:/gm)).toHaveLength(1)
  })
  it('publish waits for mac but gates on the Windows/Linux build alone, with always(), so a mac job that is cancelled or fails skips nothing', () => {
    expect(head('publish')).toContain('    needs: [prepare, build, mac]\n')
    expect(head('publish')).toContain("    if: always() && needs.prepare.outputs.publish == 'true' && needs.build.result == 'success'")
    expect(rel).not.toContain('needs.mac.')
    expect(head('itch')).toContain("    if: always() && needs.prepare.outputs.publish == 'true' && needs.publish.result == 'success'")
  })
  it.skipIf(!yaml)('parsed: the mac job\'s steps are the build job\'s, and the needs say the same as the text', () => {
    const doc = yaml.load(rel)
    expect(doc.jobs.build.strategy.matrix.include.map((m) => m.platform)).toEqual(['win', 'linux'])
    expect(doc.jobs.mac.strategy.matrix.include.map((m) => m.platform)).toEqual(['mac'])
    expect(doc.jobs.mac.steps).toEqual(doc.jobs.build.steps)
    expect(doc.jobs.mac['continue-on-error']).toBe(true)
    expect(doc.jobs.publish.needs).toEqual(['prepare', 'build', 'mac'])
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

describe('build-release.yml: every run step works in macOS bash 3.2', () => {
  it('no mapfile / readarray (bash 4+): 2.0.0\'s mac upload died on mapfile, exit 127, and shipped without a .dmg', () => {
    const code = rel.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
    expect(code).not.toMatch(/\b(mapfile|readarray)\b/)
  })
  it('the upload step collects the asset list with a plain while-read loop', () => {
    const at = rel.indexOf('- name: Upload to draft release')
    const step = rel.slice(at, rel.indexOf('\n      - ', at + 1))
    expect(step).toContain('while IFS= read -r f; do [ -n "$f" ] && FILES+=( "$f" ); done <<<')
    expect(step).toContain('gh release upload "${{ needs.prepare.outputs.tag }}" "${FILES[@]}" --clobber')
  })
})

describe('site-deploy.yml: the build job runs nothing from the requested ref (CodeQL cache poisoning)', () => {
  const site = read('.github/workflows/site-deploy.yml')
  const build = site.slice(site.indexOf('\n  build:\n'), site.indexOf('\n  publish:\n'))
    .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')   // the code only, not the comments that explain it
  it('no node, npm, npx or setup-node in the job that checks out the requested ref', () => {
    expect(build).not.toMatch(/setup-node|\bnpm\b|\bnpx\b|\bnode\b/)
  })
  it('nothing under src-tree is executed or required; the tools come from the workflow\'s own checkout', () => {
    expect(build).not.toMatch(/require\(|(^|\s)(bash|sh|source|\.) +\.?\/?src-tree\/|\.\/src-tree\/[^ ]*\.(js|sh|mjs|cjs)/m)
    expect(build).toContain('bash trusted/tools/build-play.sh src-tree/src')
  })
})
