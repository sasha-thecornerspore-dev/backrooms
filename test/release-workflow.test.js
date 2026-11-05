// The release workflow's browser zip and its itch.io mirror (growth-spec §3.4), and the wish auto-arbiter paused for the launch (owner
// decision 2026-10-13: a person reads every wish and grants it by hand through wish-grant.yml's PR). Text assertions on the YAML, plus a
// real parse when js-yaml is installed (it comes with electron-builder).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
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
    expect(itch).toContain("    if: ${{ !cancelled() && needs.prepare.outputs.publish == 'true' && needs.publish.result == 'success' }}\n")
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
  it('publish waits for mac but gates on the Windows/Linux build alone, with !cancelled(), so a mac job that fails or that GitHub cancels skips nothing', () => {
    expect(head('publish')).toContain('    needs: [prepare, build, mac]\n')
    expect(head('publish')).toContain("    if: ${{ !cancelled() && needs.prepare.outputs.publish == 'true' && needs.build.result == 'success' }}\n")
    expect(rel).not.toContain('needs.mac.')
    expect(head('itch')).toContain("    if: ${{ !cancelled() && needs.prepare.outputs.publish == 'true' && needs.publish.result == 'success' }}\n")
  })
  // always() is true in a run a person cancelled too: with it, cancelling once Windows and Linux were green still published
  it('a cancelled run publishes nothing: no always() anywhere, and the two jobs behind the builds each carry !cancelled()', () => {
    const code = rel.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
    expect(code).not.toContain('always()')
    // a status function has to be there: without one GitHub adds success(), and a mac job that did not succeed would skip the publish
    for (const job of ['publish', 'itch']) expect(head(job), job).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) && /m)
    expect(code.match(/cancelled\(\)/g)).toHaveLength(2)
    // a plain scalar that opens with ! is a YAML tag, so the whole condition sits inside ${{ }}
    expect(code).not.toMatch(/^\s*if: !/m)
  })
  it.skipIf(!yaml)('parsed: the mac job\'s steps are the build job\'s, and the needs say the same as the text', () => {
    const doc = yaml.load(rel)
    expect(doc.jobs.build.strategy.matrix.include.map((m) => m.platform)).toEqual(['win', 'linux'])
    expect(doc.jobs.mac.strategy.matrix.include.map((m) => m.platform)).toEqual(['mac'])
    expect(doc.jobs.mac.steps).toEqual(doc.jobs.build.steps)
    expect(doc.jobs.mac['continue-on-error']).toBe(true)
    expect(doc.jobs.publish.needs).toEqual(['prepare', 'build', 'mac'])
    expect(doc.jobs.publish.if).toBe("${{ !cancelled() && needs.prepare.outputs.publish == 'true' && needs.build.result == 'success' }}")
    expect(doc.jobs.itch.if).toBe("${{ !cancelled() && needs.prepare.outputs.publish == 'true' && needs.publish.result == 'success' }}")
  })
})

// 2.0.5's review: a draft a failed run left keeps that run's commit (the tag it will create when published) and that run's files. When
// the fix is a new commit the guard deletes the draft and makes it again here; the same commit run again keeps it, so it stays repairable.
describe('build-release.yml: a leftover draft from another commit is made again', () => {
  const at = rel.indexOf('      - name: Check for existing release')
  const step = rel.slice(at, rel.indexOf('\n  build:\n'))
  const script = step.slice(step.indexOf('        run: |\n') + '        run: |\n'.length).split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n')

  it('reads the commit the draft points at, compares it with this run\'s, and deletes only a draft', () => {
    expect(at).toBeGreaterThan(-1)
    expect(step).toContain('AT=$(gh release view "$TAG" --repo "${{ github.repository }}" --json targetCommitish -q .targetCommitish)')
    expect(step).toContain('if [ "$AT" != "${{ github.sha }}" ]; then')
    expect(step).toContain('gh release delete "$TAG" --yes --repo "${{ github.repository }}"')
    expect(step).not.toContain('--cleanup-tag')                     // a draft has no tag yet, and a tag is never this step's to remove
    expect(step.match(/gh release delete /g)).toHaveLength(1)
    // a published release has left the step (exit 0) before the delete is reached; the fresh draft is made after it
    const published = step.indexOf('if [ "$IS_DRAFT" = "false" ]; then'), del = step.indexOf('gh release delete '), create = step.indexOf('gh release create ')
    expect(published).toBeGreaterThan(-1)
    expect(step.slice(published, del)).toMatch(/exit 0\n\s*fi\n/)
    expect(del).toBeLessThan(create)
    const creates = step.split('\n').filter((l) => l.includes('gh release create '))
    expect(creates).toHaveLength(2)
    for (const l of creates) { expect(l).toContain('--draft --title "$VER"'); expect(l).toContain('--target "${{ github.sha }}"') }
    expect(step).toContain('gh release edit "$TAG" --notes-file "$NOTES" --repo "${{ github.repository }}"')   // a draft that is kept still picks up edited notes
  })

  // the step itself, run: a stand-in gh answers `release view` from GH_STATE (missing | published | draft:<target>) and logs every call
  const findBash = () => {   // a bare `bash` on Windows is WSL's (system32): use Git's own, found beside git (as test/build-web.test.js does)
    if (process.platform !== 'win32') return spawnSync('bash', ['-c', 'true']).status === 0 ? 'bash' : null
    const ex = spawnSync('git', ['--exec-path'], { encoding: 'utf8' })
    if (ex.status !== 0) return null
    const gitRoot = path.resolve(ex.stdout.trim(), '..', '..', '..')
    return [path.join(gitRoot, 'bin', 'bash.exe'), path.join(gitRoot, 'usr', 'bin', 'bash.exe')].find((p) => fs.existsSync(p)) || null
  }
  const BASH = findBash()
  const fwd = (p) => p.replace(/\\/g, '/')
  const SHA = 'f'.repeat(40), OLD = '0'.repeat(40)
  const GH = [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$*" >> "$GH_LOG"`,
    'if [ "$1 $2" = "release view" ]; then',
    '  case "$GH_STATE" in',
    '    missing) echo "release not found" >&2; exit 1 ;;',
    '    published) case "$*" in *isDraft*) echo false ;; *) echo "$GH_STATE" ;; esac ;;',
    '    draft:*) case "$*" in *isDraft*) echo true ;; *) [ -z "$GH_TARGET_FAILS" ] || exit 1; echo "${GH_STATE#draft:}" ;; esac ;;',
    '  esac',
    'fi',
    'exit 0',
    '',
  ].join('\n')
  function guard({ event = 'push', state, notes = true, targetFails = false }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backrooms-guard-'))
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{ "version": "9.9.9" }')
      if (notes) { fs.mkdirSync(path.join(dir, 'docs', 'release-notes'), { recursive: true }); fs.writeFileSync(path.join(dir, 'docs', 'release-notes', 'v9.9.9.md'), 'notes\n') }
      fs.mkdirSync(path.join(dir, 'bin'))
      fs.writeFileSync(path.join(dir, 'bin', 'gh'), GH, { mode: 0o755 })
      const sh = script.replaceAll('${{ github.event_name }}', event).replaceAll('${{ github.repository }}', 'o/r').replaceAll('${{ github.sha }}', SHA)
      expect(sh).not.toContain('${{')                                // every expression the step uses is one of those three
      fs.writeFileSync(path.join(dir, 'guard.sh'), sh)
      const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH'
      const env = { ...process.env, [pathKey]: path.join(dir, 'bin') + path.delimiter + process.env[pathKey], GITHUB_OUTPUT: fwd(path.join(dir, 'out')), GH_LOG: fwd(path.join(dir, 'gh.log')), GH_STATE: state, GH_TARGET_FAILS: targetFails ? '1' : '' }
      const r = spawnSync(BASH, ['-e', 'guard.sh'], { cwd: dir, encoding: 'utf8', env })   // GitHub runs a step that names no shell as `bash -e`
      const text = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8').trim() } catch { return '' } }
      const calls = text('gh.log').split('\n').filter(Boolean)
      const out = Object.fromEntries(text('out').split('\n').filter(Boolean).map((l) => l.split('=')))
      return { status: r.status, log: r.stdout + r.stderr, calls, out, did: (verb) => calls.filter((c) => c.startsWith(`release ${verb} `)) }
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }
  const VIEW = 'release view v9.9.9 --repo o/r --json isDraft -q .isDraft'
  const CREATE = `release create v9.9.9 --draft --title 9.9.9 --notes-file docs/release-notes/v9.9.9.md --target ${SHA} --repo o/r`

  it.skipIf(!BASH)('not a push: builds, publishes nothing, and never asks about a release', () => {
    const r = guard({ event: 'pull_request', state: 'draft:' + OLD })
    expect(r.status, r.log).toBe(0)
    expect(r.out).toEqual({ tag: 'v9.9.9', build: 'true', publish: 'false' })
    expect(r.calls).toEqual([])
  })
  it.skipIf(!BASH)('no release yet: a draft is made at this commit', () => {
    const r = guard({ state: 'missing' })
    expect(r.status, r.log).toBe(0)
    expect(r.out).toEqual({ tag: 'v9.9.9', build: 'true', publish: 'true' })
    expect(r.calls).toEqual([VIEW, CREATE])
  })
  it.skipIf(!BASH)('already published: skipped exactly as before, and nothing is deleted, made or edited', () => {
    const r = guard({ state: 'published' })
    expect(r.status, r.log).toBe(0)
    expect(r.out).toEqual({ tag: 'v9.9.9', build: 'false', publish: 'false' })
    expect(r.calls).toEqual([VIEW])
  })
  it.skipIf(!BASH)('a draft at this very commit (the run, run again) is kept with its files, and picks up the notes', () => {
    const r = guard({ state: 'draft:' + SHA })
    expect(r.status, r.log).toBe(0)
    expect(r.out).toEqual({ tag: 'v9.9.9', build: 'true', publish: 'true' })
    expect(r.did('delete')).toEqual([])
    expect(r.did('create')).toEqual([])
    expect(r.did('edit')).toEqual(['release edit v9.9.9 --notes-file docs/release-notes/v9.9.9.md --repo o/r'])
  })
  it.skipIf(!BASH)('a draft at another commit (the fix was a new commit) is deleted, files and all, and made again at this one', () => {
    const r = guard({ state: 'draft:' + OLD })
    expect(r.status, r.log).toBe(0)
    expect(r.out).toEqual({ tag: 'v9.9.9', build: 'true', publish: 'true' })
    expect(r.calls).toEqual([VIEW, 'release view v9.9.9 --repo o/r --json targetCommitish -q .targetCommitish', 'release delete v9.9.9 --yes --repo o/r', CREATE])
    expect(r.log).toContain(OLD)                                     // the run's log says which commit the old draft pointed at
  })
  it.skipIf(!BASH)('a draft that names a branch (made by hand) is not this commit either: made again, so the tag cannot land wherever the branch is by then', () => {
    const r = guard({ state: 'draft:main', notes: false })
    expect(r.status, r.log).toBe(0)
    expect(r.did('delete')).toEqual(['release delete v9.9.9 --yes --repo o/r'])
    expect(r.did('create')).toEqual([`release create v9.9.9 --draft --title 9.9.9 --notes  --target ${SHA} --repo o/r`])   // no notes file: empty notes
    expect(r.did('edit')).toEqual([])
  })
  it.skipIf(!BASH)('when the draft\'s target cannot be read the step fails, and nothing is deleted or built', () => {
    for (const r of [guard({ state: 'draft:' + OLD, targetFails: true }), guard({ state: 'draft:' })]) {
      expect(r.status, r.log).not.toBe(0)
      expect(r.did('delete')).toEqual([])
      expect(r.did('create')).toEqual([])
      expect(r.out).toEqual({ tag: 'v9.9.9' })                       // no build output: the build, mac and publish jobs are all skipped
    }
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
