import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  validateStratum, validateBeacon, validateBeaconSet,
  orderStrata, beaconStyle, stratumLabel, beaconIdFromHash,
} from './atlas-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`) }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// validateStratum
check('stratum ok',            validateStratum({ tier: 'deep', ts: '2026-07-25T00:00:00Z', fragment: 'x' }).ok)
check('stratum bad tier',     !validateStratum({ tier: 'nope', ts: '2026-07-25', fragment: 'x' }).ok)
check('stratum bad ts',       !validateStratum({ tier: 'deep', ts: 'not-a-date', fragment: 'x' }).ok)
check('stratum empty fragment', !validateStratum({ tier: 'deep', ts: '2026-07-25', fragment: '' }).ok)

// validateBeacon
const good = { id: 'x', kind: 'genesis', name: 'X', lat: 39.3, lng: -76.6, strata: [] }
check('beacon ok',            validateBeacon(good).ok)
check('beacon bad kind',     !validateBeacon({ ...good, kind: 'zzz' }).ok)
check('beacon lat range',    !validateBeacon({ ...good, lat: 200 }).ok)
check('beacon lng range',    !validateBeacon({ ...good, lng: 999 }).ok)
check('beacon sealed type',  !validateBeacon({ ...good, sealed: 'yes' }).ok)
check('beacon subtitle type',!validateBeacon({ ...good, subtitle: 5 }).ok)
check('beacon missing name', !validateBeacon({ ...good, name: '' }).ok)
check('beacon strata !array',!validateBeacon({ ...good, strata: 'no' }).ok)

// validateBeaconSet
check('set ok',    validateBeaconSet({ beacons: [good] }).ok)
check('set count', validateBeaconSet({ beacons: [good] }).count === 1)
check('set dup id',!validateBeaconSet({ beacons: [good, { ...good }] }).ok)
check('set !doc',  !validateBeaconSet([]).ok)

// orderStrata — newest first, non-mutating, deterministic tie-break
const s1 = { tier: 'deep',  ts: '2026-01-01T00:00:00Z', fragment: 'a' }
const s2 = { tier: 'faint', ts: '2026-06-01T00:00:00Z', fragment: 'b' }
const ordered = orderStrata([s1, s2])
check('orderStrata newest first', ordered[0].fragment === 'b' && ordered[1].fragment === 'a')
check('orderStrata no mutate',    eq([s1, s2].map(s => s.fragment), ['a', 'b']))

// beaconStyle
check('style genesis gold',  beaconStyle({ kind: 'genesis' }).color === '#c9ba72')
check('style organic green', beaconStyle({ kind: 'organic' }).color === '#8fdcac')
check('style sealed rust',   beaconStyle({ kind: 'genesis', sealed: true }).color === '#a05a3a')

// stratumLabel
check('stratum label', stratumLabel({ tier: 'deep', ts: '2026-07-25T12:00:00Z', fragment: 'x' }, 0)
                        === 'layer 001 · deep · 2026-07-25')

// beaconIdFromHash — shareable-link parsing, injection-safe
check('hash id ok',      beaconIdFromHash('#806-n-carey') === '806-n-carey')
check('hash no prefix',  beaconIdFromHash('806-n-carey') === '806-n-carey')
check('hash empty null', beaconIdFromHash('#') === null)
check('hash bad chars',  beaconIdFromHash('#a/b') === null)
check('hash uppercase',  beaconIdFromHash('#ABC') === null)
check('hash non-string', beaconIdFromHash(null) === null)

// the real shipped data validates
const doc = JSON.parse(readFileSync(join(HERE, 'beacons.json'), 'utf8'))
check('beacons.json validates', validateBeaconSet(doc).ok)
check('beacons.json has 806 sealed genesis',
  doc.beacons.some(b => b.id === '806-n-carey' && b.sealed === true && b.kind === 'genesis'))
check('beacons.json every sealed beacon has strata',
  doc.beacons.filter(b => b.sealed).every(b => Array.isArray(b.strata) && b.strata.length > 0))

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
