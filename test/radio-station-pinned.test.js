// The numbers station is not touched by the static (M21): its groups, its lines, its timing and the docket's roll call read byte for
// byte as they did at 36ac9a4 (2.0.4 "pulse"). A sweep of compose-radio.js radioLine over every block, mode, group, count, hearing and
// roll line, words / COUNT_LINE, docket.js rollCall over a sweep of standings and status.js's radio modes is hashed and pinned against
// the hash the same sweep gave on 36ac9a4's tree; game.js's readRadio (what it shows, blips, beats, when the follow-ups land) and
// audio.js's setRadio (the tune) are pinned the same way, CRLF folded. A change to any of them turns this red on purpose.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { radioLine, words, WORDS, RADIO_GROUPS, COUNT_LINE } from '../src/renderer/compose-radio.js'
import { LEGACY, rulesFor } from '../src/renderer/origin-rules.js'
import { ORIGINS } from '../src/renderer/origin-intake.js'
import { standingOf, rollCall } from '../src/renderer/docket.js'
import { STATUSES, statusMods } from '../src/renderer/status.js'

const sha = (s) => createHash('sha256').update(s).digest('hex')
const read = (f) => fs.readFileSync(new URL(`../src/renderer/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
// a function's text: from its head to its closing brace at the head's own indent
function fn(src, head) {
  const a = src.indexOf(head)
  expect(a, head).toBeGreaterThanOrEqual(0)
  const indent = /^ */.exec(head)[0]
  const b = src.indexOf(`\n${indent}}\n`, a)
  return src.slice(a, b + indent.length + 2)
}

// 36ac9a4's numbers (the same sweep, run on `git archive 36ac9a4 src/renderer`)
const AT_36AC9A4 = Object.freeze({
  sweep: { rows: 10806, chars: 2310218, sha: '3b7a2d59319b261579324026cd7108daf03025ff4a3c259d04c955af2df7579b' },
  readRadio: { chars: 665, sha: 'eaf7f6012882994b6534bd671dc5014f613673b61950b7c2c998209070bc3e20' },
  setRadio: { chars: 1046, sha: 'ed00478de23bcee835501fdf69d7599b0c402827a5482872161a367ba969c3dd' },
})

function sweep() {
  const rows = []
  const RULES = [['legacy', LEGACY], ...ORIGINS.flatMap((o) => [[o, rulesFor(o, false)], [o + '+thin', rulesFor(o, true)]])]
  for (const on of [false, true]) for (const [name, rules] of RULES) for (const mode of ['crackle', 'roll', 'ledger', null, 'other'])
    for (let stationIdx = 0; stationIdx < RADIO_GROUPS.length; stationIdx++) for (const count of [0, 1, 2, 3, 7, 32, 33])
      for (const firstDeepHearing of [false, true]) for (const rollLine of [null, 'the station reads the floor. nothing is filed here.'])
        rows.push([on, name, mode, stationIdx, count, firstDeepHearing, rollLine,
          radioLine({ on, rules, mode, stationIdx, groups: RADIO_GROUPS, count, firstDeepHearing, rollLine })])
  for (let n = -1; n <= 40; n++) rows.push(['words', n, words(n)])
  for (let n = 1; n <= 33; n++) rows.push(['count', n, COUNT_LINE(n)])
  for (let e = 0; e <= 4; e++) for (let c = 0; c <= 4; c++) for (let l = 0; l <= 4; l++) for (const depth of [null, 0, 1, 2, 3])
    rows.push(['roll', e, c, l, depth, rollCall(standingOf({ extension: e, compliance: c, litigation: l }, depth))])
  rows.push(['roll-null', rollCall(null)])
  for (const s of STATUSES) for (const depth of [null, 0, 1, 2, 3, 4]) rows.push(['mode', s, depth, statusMods(s).radioMode(depth)])
  rows.push(['groups', RADIO_GROUPS, WORDS])
  return rows
}

describe('the numbers station, as it was at 36ac9a4', () => {
  it('radioLine, the words, the count line, the docket\'s roll call and the radio modes: the same bytes over the sweep', () => {
    const rows = sweep(), json = JSON.stringify(rows)
    expect([rows.length, json.length, sha(json)]).toEqual([AT_36AC9A4.sweep.rows, AT_36AC9A4.sweep.chars, AT_36AC9A4.sweep.sha])
  })
  it('the groups themselves', () => {
    expect(RADIO_GROUPS).toEqual(['12 26 04 22 11 08', '21 08 19 24 23 12', '23 12 17 23 11 08', '09 12 15 08'])
  })
  it('game.js reads the station as it did: the same readRadio, byte for byte', () => {
    const s = fn(read('game.js'), '  function readRadio(on) {')
    expect([s.length, sha(s)]).toEqual([AT_36AC9A4.readRadio.chars, AT_36AC9A4.readRadio.sha])
  })
  it('audio.js plays the tune as it did: the same setRadio, byte for byte', () => {
    const s = fn(read('audio.js'), 'export function setRadio(on) {')
    expect([s.length, sha(s)]).toEqual([AT_36AC9A4.setRadio.chars, AT_36AC9A4.setRadio.sha])
  })
})
