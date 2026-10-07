// docket.mjs — recount the docket from the wish issues and write it into world.json.
//
// Every wish filed under a status ends with a trailer ('filed under: EXTENSION · level 2',
// status.js wishTrailer). The docket is the count of those per floor and status, recounted
// from scratch on every grant (never incremented), so it is a pure function of the issue
// list: a denied wish, a pull request, a trailer-less wish or a malformed trailer counts
// nothing. Both wish workflows run this right after the arbiter rewrites world.json (which
// may drop the key) and before the validator. Run:  node tools/docket.mjs  (needs GH_TOKEN)
import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { EMPTY_DOCKET, STATUS_KEYS } from '../src/renderer/docket.js'
import { parseTrailer } from '../src/renderer/status.js'

const labelsOf = (issue) => (issue?.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name))

// issues → { '0'..'3': { extension, compliance, litigation } }, a fresh object every call
export function recount(issues) {
  const docket = {}
  for (const k of Object.keys(EMPTY_DOCKET)) docket[k] = { ...EMPTY_DOCKET[k] }
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (!issue || issue.pull_request) continue
    const labels = labelsOf(issue)
    if (!labels.includes('wish') || labels.includes('denied')) continue
    const t = parseTrailer(issue.body ?? '')
    if (!t || !Number.isInteger(t.level) || t.level < 0 || t.level > 3 || !STATUS_KEYS.includes(t.status)) continue
    docket[String(t.level)][t.status]++
  }
  return docket
}

// the in-place write: key order is not sacred (the arbiter rewrites the file with jq anyway);
// the one invariant is that `docket` is present and correct
export function withDocket(worldText, docket) {
  const obj = JSON.parse(worldText)
  obj.docket = docket
  return JSON.stringify(obj, null, 2) + '\n'
}

// `gh api --paginate --jq` prints one JSON array per page; read every top-level value in the
// stream (compact or pretty) and flatten the arrays
export function parsePages(text) {
  const out = []
  const s = String(text ?? '')
  let depth = 0, start = -1, inStr = false, esc = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '[' || ch === '{') { if (depth++ === 0) start = i; continue }
    if (ch === ']' || ch === '}') {
      if (--depth === 0) {
        const v = JSON.parse(s.slice(start, i + 1))
        if (Array.isArray(v)) out.push(...v); else out.push(v)
      }
    }
  }
  return out
}

function isMain() {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) }
  catch { return false }
}

if (isMain()) {
  const world = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'world.json')
  let raw
  try {
    raw = execFileSync('gh', [
      'api', '--paginate', '-X', 'GET', '/repos/{owner}/{repo}/issues',
      '-f', 'labels=wish', '-f', 'state=all', '-f', 'per_page=100',
      '--jq', '[.[] | {number, body, labels: [.labels[].name], pull_request}]',
    ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    // a failed read is a failed grant, never a silent zero docket
    console.error('docket: gh failed — ' + (e.stderr ? String(e.stderr).trim() : e.message))
    process.exit(1)
  }
  const issues = parsePages(raw)
  if (issues.length >= 500) console.error('docket: 500+ wish issues; check pagination')
  const docket = recount(issues)
  writeFileSync(world, withDocket(readFileSync(world, 'utf8'), docket))
  for (const k of Object.keys(docket)) {
    const r = docket[k]
    console.log(`docket level ${k}: extension ${r.extension} · compliance ${r.compliance} · litigation ${r.litigation}`)
  }
}
