import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  validateStratum, validateBeacon, validateBeaconSet,
  orderStrata, beaconStyle, stratumLabel, beaconIdFromHash,
  isPresence, doorTier, recencyBucket, visibleStrata, haversineM, nearbyCases, mergeRegistries,
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

// layered doors — presence-only, distinct-day, decaying
const NOW = Date.parse('2026-09-16T12:00:00Z')
const day = (n) => new Date(NOW - n * 86400000).toISOString()
const stood = (n) => ({ tier: 'faint', ts: day(n), fragment: 'someone stood at the door.', src: 'presence' })
const reached = (n) => ({ tier: 'faint', ts: day(n), fragment: 'someone reached the door from far off.', src: 'presence' })
const deep = { tier: 'deep', ts: '1937-01-01T00:00:00Z', fragment: 'the map.' }
check('isPresence by src',            isPresence(stood(0)))
check('isPresence by fragment',       isPresence({ tier: 'faint', ts: day(0), fragment: 'someone stood at the door.' }))
check('authored is not presence',    !isPresence(deep))
check('stratum src optional string',  validateStratum({ ...stood(0) }).ok && !validateStratum({ ...stood(0), src: 5 }).ok)
check('tier 0 with no presence',      doorTier([deep], NOW).tier === 0 && doorTier([deep], NOW).label === 'a door')
check('burst in one day = 1 day',     doorTier([stood(0), stood(0), stood(0), stood(0)], NOW).days === 1)
check('tier 1 walked',                doorTier([stood(0), stood(1)], NOW).tier === 1)
check('tier 2 worn at weight 3',      doorTier([stood(0), stood(1), stood(2)], NOW).tier === 2)
check('reached weighs half',          doorTier([reached(0), reached(1)], NOW).weight === 1 && doorTier([reached(0), reached(1)], NOW).tier === 1)
check('stood beats reached same day', doorTier([reached(0), stood(0)], NOW).weight === 1)
check('tier 3 thick at weight 6',     doorTier([0,1,2,3,4,5].map(stood), NOW).tier === 3)
check('tier 4 layered at weight 10',  doorTier([0,1,2,3,4,5,6,7,8,9].map(stood), NOW).tier === 4)
check('old marks roll out of window', doorTier([stood(15), stood(20), stood(40)], NOW).tier === 0)
check('fading after 10 quiet days',   doorTier([stood(11), stood(12)], NOW).fading === true && doorTier([stood(0), stood(12)], NOW).fading === false)
check('future-dated marks ignored',   doorTier([stood(-5)], NOW).tier === 0)
check('recency buckets',              recencyBucket(day(0), NOW) === 'today' && recencyBucket(day(3), NOW) === 'this week' && recencyBucket(day(20), NOW) === 'this month' && recencyBucket(day(90), NOW) === 'older')
const vis = visibleStrata([deep, stood(0), stood(3), reached(9)], NOW)
check('presence collapses to one line', vis.length === 2 && vis[0].collapsed === true && vis[0].count === 3 && vis[0].fragment === '3 marks · last today')
check('authored strata never hidden',  vis[1].fragment === 'the map.')
check('no presence → authored only',   visibleStrata([deep], NOW).length === 1 && !visibleStrata([deep], NOW)[0].collapsed)
check('haversine ~2.2km 806→MtVernon', Math.abs(haversineM(39.2966, -76.6414, 39.2977, -76.6155) - 2230) < 60)
const door = { id: 'lib', lat: 39.2900, lng: -76.6200 }
const cases = [{ id: 'a', geo: { beacon: 'lib', lat: 0, lng: 0 } }, { id: 'b', geo: { lat: 39.2901, lng: -76.6201 } }, { id: 'c', geo: { lat: 39.3000, lng: -76.6200 } }, { id: 'd' }]
check('nearbyCases by id or distance', nearbyCases(door, cases).map(c => c.id).join(',') === 'a,b')
const merged = mergeRegistries({ beacons: [{ id: 'x', name: 'live' }] }, { beacons: [{ id: 'x', name: 'old' }, { id: 'y', name: 'bundled' }] })
check('merge: live wins, bundled flagged', merged.beacons.length === 2 && merged.beacons.find(b => b.id === 'x').name === 'live' && merged.beacons.find(b => b.id === 'x').bundled === false && merged.beacons.find(b => b.id === 'y').bundled === true)

// the real shipped data validates
const doc = JSON.parse(readFileSync(join(HERE, 'beacons.json'), 'utf8'))
check('beacons.json validates', validateBeaconSet(doc).ok)
check('beacons.json has 806 sealed genesis',
  doc.beacons.some(b => b.id === '806-n-carey' && b.sealed === true && b.kind === 'genesis'))
check('beacons.json every sealed beacon has strata',
  doc.beacons.filter(b => b.sealed).every(b => Array.isArray(b.strata) && b.strata.length > 0))

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
