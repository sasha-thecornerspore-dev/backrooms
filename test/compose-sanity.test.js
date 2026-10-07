// compose-sanity.js — the one sanity step: light, depth, hunt, gaze, leash, friends (legacy +3, or the company pool), down.
import { describe, it, expect } from 'vitest'
import { sanityStep, affinity, COMPANY, EXHAUSTED_LINE, DISAGREE_LINE } from '../src/renderer/compose-sanity.js'
import { LEGACY, rulesFor } from '../src/renderer/origin-rules.js'
import { statusMods } from '../src/renderer/status.js'
import { closingOverlay } from '../src/renderer/closings.js'
import { COMPANY as ROLLCALL_COMPANY, createCompany } from '../src/renderer/rollcall.js'

const DT = 1 / 60
const NM = statusMods('notice-mailed')

function mkCtx(over = {}) {
  return {
    rules: LEGACY, mods: NM, closingOverlay: closingOverlay(null), flashlight: true, litNear: false, index: 0, depth: 0,
    hunted: false, gaze: false, gazeRate: 0, origin: null, drift: 0, leashDebt: 0, leashCalm: 0, down: false,
    player: { x: 10, y: 10 }, self: { status: 'notice-mailed', aseed: null, origin: null, thin: false },
    remotes: [], fresh: null, onFloor: null, company: 60, companyWas: 60, disagreeSaid: false, dt: DT, ...over,
  }
}
// a fresh-bus fake: every listed id is fresh and on this floor unless told otherwise
function bus(freshIds, offFloor = []) {
  return { fresh: (id) => freshIds.includes(id), onFloor: (id) => !offFloor.includes(id) }
}
const peer = (id, dx, over = {}) => ({ id, x: 10 + dx, y: 10, name: id, stillFor: 0, ...over })

describe('the stand: while it is held the dark does not eat you (F2)', () => {
  it('standing zeroes a negative light term only; a positive one, the depth term and the hunt still count', () => {
    const T = rulesFor('tenant', false), EX = statusMods('extension')
    expect(sanityStep(mkCtx({ rules: T, mods: EX, flashlight: false, index: 3, depth: 3 })).delta).toBe(-3 + 0.75)
    expect(sanityStep(mkCtx({ rules: T, mods: EX, flashlight: false, index: 3, depth: 3, standing: true })).delta).toBe(0.75)
    expect(sanityStep(mkCtx({ rules: T, mods: EX, flashlight: false, index: 3, depth: 3, standing: true, hunted: true })).delta).toBe(0.75 - 3)
    expect(sanityStep(mkCtx({ rules: LEGACY, flashlight: false, index: 2, depth: 2, standing: true })).delta).toBe(-1)
    expect(sanityStep(mkCtx({ rules: rulesFor('tenant', true), flashlight: false, index: 2, depth: 2, standing: true })).delta).toBe(2 - 1)
    expect(sanityStep(mkCtx({ rules: LEGACY, flashlight: false, index: 2, depth: 2, standing: false })).delta).toBe(-2 - 1)
  })
})

describe('the light term is the block’s', () => {
  it('flashlight / litNear / depth pass through verbatim and the result is added (a fake thin block)', () => {
    const calls = []
    const rules = { ...LEGACY, lightTerm: (f, l, d) => { calls.push([f, l, d]); return f ? -2 : (l ? 0 : 2) } }
    const a = sanityStep(mkCtx({ rules, flashlight: true, litNear: false, depth: 2, index: 2 })).delta
    expect(a).toBe(-2 - 1)
    const b = sanityStep(mkCtx({ rules, flashlight: false, litNear: true, depth: 1, index: 1 })).delta
    expect(b).toBe(0 - 0.5)
    expect(calls).toEqual([[true, false, 2], [false, true, 1]])
  })
  it('thin flips only the light term (rulesFor(tenant, true) against rulesFor(tenant, false))', () => {
    const thin = sanityStep(mkCtx({ rules: rulesFor('tenant', true), flashlight: true, index: 1, depth: 1 })).delta
    const solid = sanityStep(mkCtx({ rules: rulesFor('tenant', false), flashlight: true, index: 1, depth: 1 })).delta
    expect(thin).toBe(-2 - 0.5)
    expect(solid).toBe(2 - 0.5)
  })
})

describe('the depth term: the closing overlay wins over the status', () => {
  it('closingOverlay.sanityDepthTerm present -> mods.sanityDepthTerm is never called', () => {
    let modsCalled = 0
    const mods = { ...NM, sanityDepthTerm: () => { modsCalled++; return -99 } }
    const d = sanityStep(mkCtx({ mods, closingOverlay: closingOverlay('extension'), index: 3, depth: 3 })).delta
    expect(modsCalled).toBe(0)
    expect(d).toBe(2 + 0.75)
    const e = sanityStep(mkCtx({ mods, closingOverlay: closingOverlay(null), index: 3, depth: 3 })).delta
    expect(modsCalled).toBe(1)
    expect(e).toBe(2 - 99)
  })
  it("extension's own depth term through statusMods (∅ -1.0, (depth - 1.5) x 0.5)", () => {
    const ext = statusMods('extension')
    expect(sanityStep(mkCtx({ mods: ext, index: 4, depth: 0 })).delta).toBe(2 - 1)
    expect(sanityStep(mkCtx({ mods: ext, index: 3, depth: 3 })).delta).toBe(2 + 0.75)
  })
})

describe('hunt and gaze', () => {
  it('hunted -3, gaze -gazeRate', () => {
    expect(sanityStep(mkCtx({ hunted: true })).delta).toBe(-1)
    expect(sanityStep(mkCtx({ gaze: true, gazeRate: 1.5 })).delta).toBe(0.5)
    expect(sanityStep(mkCtx({ gaze: false, gazeRate: 3 })).delta).toBe(2)
  })
})

describe('down', () => {
  it('-1 flat; nothing else is evaluated', () => {
    const rules = { ...LEGACY, lightTerm: () => { throw new Error('not while down') } }
    const s = sanityStep(mkCtx({ rules, down: true, hunted: true, gaze: true, gazeRate: 3, remotes: [peer('a', 1)], ...bus(['a']) }))
    expect(s.delta).toBe(-1)
    expect(s.companyDelta).toBe(0)
    expect(s.exhaustedNow).toBe(false)
    expect(s.disagreeNow).toBe(false)
    expect(s.nearestFriendId).toBe(null)
  })
})

describe('the leash (W2: rules.leash, leashDrain)', () => {
  const anchored = rulesFor('anchored', false)
  it('600 m -> -1, 1000 m -> -2, 199 m -> 0, a calm caption -> 0', () => {
    expect(sanityStep(mkCtx({ rules: anchored, drift: 600 })).delta).toBe(2 - 1)
    expect(sanityStep(mkCtx({ rules: anchored, drift: 1000 })).delta).toBe(2 - 2)
    expect(sanityStep(mkCtx({ rules: anchored, drift: 199 })).delta).toBe(2)
    expect(sanityStep(mkCtx({ rules: anchored, drift: 1000, leashCalm: 0.1 })).delta).toBe(2)
  })
  it('the debt adds to the drift; a block without the leash ignores both', () => {
    expect(sanityStep(mkCtx({ rules: anchored, drift: 400, leashDebt: 200 })).delta).toBe(2 - 1)
    expect(sanityStep(mkCtx({ rules: rulesFor('tenant', false), drift: 5000, leashDebt: 5000 })).delta).toBe(2)
    expect(sanityStep(mkCtx({ rules: LEGACY, drift: 5000 })).delta).toBe(2)
  })
})

describe('friends: one counted, legacy +3 or the company pool', () => {
  it('a legacy peer (no bus) within 6 gives a flat +3 and the pool refills; at d² 36.1 nothing', () => {
    const s = sanityStep(mkCtx({ remotes: [peer('a', 5.99)] }))
    expect(s.delta).toBe(5)
    expect(s.companyDelta).toBe(0.75 * DT)
    expect(s.nearestFriendId).toBe(null)
    expect(sanityStep(mkCtx({ remotes: [peer('a', Math.sqrt(36.1))] })).delta).toBe(2)
  })
  it('a peer with no fresh here (bus present, fresh(id) false) is a legacy friend', () => {
    const s = sanityStep(mkCtx({ remotes: [peer('a', 3)], ...bus([]), company: 0, companyWas: 0 }))
    expect(s.delta).toBe(5)
    expect(s.companyDelta).toBe(0.75 * DT)
  })
  it('a fresh peer off this floor is skipped even within 6', () => {
    const s = sanityStep(mkCtx({ remotes: [peer('a', 1, { status: 'notice-mailed' })], ...bus(['a'], ['a']) }))
    expect(s.delta).toBe(2)
    expect(s.nearestFriendId).toBe(null)
    expect(s.companyDelta).toBe(0.75 * DT)
  })
  it('a fresh friend draws the pool: +rate while it lasts, -3/s off the pool', () => {
    const s = sanityStep(mkCtx({ remotes: [peer('a', 2, { status: 'notice-mailed' })], ...bus(['a']) }))
    expect(s.delta).toBe(5)
    expect(s.companyDelta).toBe(-3 * DT)
    expect(s.nearestFriendId).toBe('a')
    const empty = sanityStep(mkCtx({ remotes: [peer('a', 2, { status: 'notice-mailed' })], ...bus(['a']), company: 0, companyWas: 0 }))
    expect(empty.delta).toBe(2)
    expect(empty.companyDelta).toBe(0)
    expect(empty.nearestFriendId).toBe('a')
  })
  it('the pool drains 60 -> 0 in 20 s at +3/s, exhaustedNow fires on one frame, refills in 80 s, and fires again on the next drain', () => {
    const company = createCompany()
    const ctx = mkCtx({ remotes: [peer('a', 2, { status: 'notice-mailed' })], ...bus(['a']) })
    const step = () => { ctx.company = ctx.companyWas = company.value; const s = sanityStep(ctx); company.add(s.companyDelta); return s }
    const fires = []
    let gain = 0
    for (let i = 0; i < 1300; i++) { const s = step(); gain += s.delta - 2; if (s.exhaustedNow) fires.push(i) }
    expect(fires.length).toBe(1)
    expect(Math.abs(fires[0] - 1199)).toBeLessThanOrEqual(1)     // the 1200th frame of 1/60: 20 s
    expect(company.value).toBe(0)
    expect(gain).toBeCloseTo(3 * (fires[0] + 1) * 1, 6)             // +3 every frame the pool had something
    // walk away: no fresh friend within 6
    ctx.remotes = [peer('a', 20, { status: 'notice-mailed' })]
    let full = -1
    for (let i = 0; i < 5000 && full < 0; i++) { const s = step(); expect(s.exhaustedNow).toBe(false); if (company.value >= 60) full = i }
    expect(Math.abs(full - 4799)).toBeLessThanOrEqual(1)            // 80 s of 1/60
    ctx.remotes = [peer('a', 2, { status: 'notice-mailed' })]
    const again = []
    for (let i = 0; i < 1300; i++) if (step().exhaustedNow) again.push(i)
    expect(again.length).toBe(1)
  })
  it('affinity: 1 for equal or notice-mailed on either side, 0.5 otherwise', () => {
    expect(affinity('extension', 'compliance')).toBe(0.5)
    expect(affinity('litigation', 'litigation')).toBe(1)
    expect(affinity('notice-mailed', 'compliance')).toBe(1)
    expect(affinity('extension', 'notice-mailed')).toBe(1)
    const s = sanityStep(mkCtx({ self: { status: 'extension', aseed: null }, remotes: [peer('a', 2, { status: 'compliance' })], ...bus(['a']) }))
    expect(s.delta).toBe(2 + 1.5)
  })
  it("a thin giver (the REMOTE's flag) gives 0 moving and the full rate standing still 0.6 s", () => {
    const moving = sanityStep(mkCtx({ remotes: [peer('a', 2, { status: 'notice-mailed', thin: true, stillFor: 0.3 })], ...bus(['a']) }))
    expect(moving.delta).toBe(2)
    const still = sanityStep(mkCtx({ remotes: [peer('a', 2, { status: 'notice-mailed', thin: true, stillFor: 0.6 })], ...bus(['a']) }))
    expect(still.delta).toBe(5)
    // the self's own thin block does not decide it
    const selfThin = sanityStep(mkCtx({ rules: rulesFor('tenant', true), flashlight: false, remotes: [peer('a', 2, { status: 'notice-mailed', stillFor: 0 })], ...bus(['a']) }))
    expect(selfThin.delta).toBe(2 + 3)
  })
  it('the base is rules.friendBase({ rp, selfAseed }): anchored 5 on the same pin, 3 otherwise; unnamed 4', () => {
    const seen = []
    const rules = { ...LEGACY, friendBase: (c) => { seen.push([c.rp.id, c.selfAseed]); return 3 } }
    sanityStep(mkCtx({ rules, self: { status: 'notice-mailed', aseed: 77 }, remotes: [peer('a', 2, { status: 'notice-mailed' })], ...bus(['a']) }))
    expect(seen).toEqual([['a', 77]])
    const anchored = rulesFor('anchored', false)
    const same = sanityStep(mkCtx({ rules: anchored, self: { status: 'notice-mailed', aseed: 77 }, remotes: [peer('a', 2, { status: 'notice-mailed', aseed: 77 })], ...bus(['a']) }))
    expect(same.delta).toBe(2 + 5)
    const other = sanityStep(mkCtx({ rules: anchored, self: { status: 'notice-mailed', aseed: 77 }, remotes: [peer('a', 2, { status: 'notice-mailed', aseed: 78 })], ...bus(['a']) }))
    expect(other.delta).toBe(2 + 3)
    const nul = sanityStep(mkCtx({ rules: anchored, self: { status: 'notice-mailed', aseed: null }, remotes: [peer('a', 2, { status: 'notice-mailed', aseed: null })], ...bus(['a']) }))
    expect(nul.delta).toBe(2 + 3)
    const un = sanityStep(mkCtx({ rules: rulesFor('unnamed', false), remotes: [peer('a', 2, { status: 'notice-mailed' })], ...bus(['a']) }))
    expect(un.delta).toBe(2 + 4)
  })
  it('one friend: a legacy peer found first makes a fresh one behind it irrelevant; the best fresh rate wins', () => {
    const a = sanityStep(mkCtx({ rules: rulesFor('unnamed', false), remotes: [peer('old', 3), peer('new', 2, { status: 'notice-mailed' })], ...bus(['new']) }))
    expect(a.delta).toBe(2 + 3)
    expect(a.companyDelta).toBe(0.75 * DT)
    expect(a.nearestFriendId).toBe(null)
    const self = { status: 'extension', aseed: null }
    const b = sanityStep(mkCtx({ self, remotes: [peer('x', 1, { status: 'compliance' }), peer('y', 4, { status: 'extension' }), peer('z', 5, { status: 'litigation' })], ...bus(['x', 'y', 'z']) }))
    expect(b.delta).toBe(2 + 3)
    expect(b.nearestFriendId).toBe('y')
  })
  it('disagreeNow once: both filed and different, only while disagreeSaid is false', () => {
    const ctx = mkCtx({ self: { status: 'extension', aseed: null }, remotes: [peer('a', 2, { status: 'litigation' })], ...bus(['a']) })
    expect(sanityStep(ctx).disagreeNow).toBe(true)
    ctx.disagreeSaid = true
    expect(sanityStep(ctx).disagreeNow).toBe(false)
    const agree = mkCtx({ self: { status: 'extension', aseed: null }, remotes: [peer('a', 2, { status: 'extension' })], ...bus(['a']) })
    expect(sanityStep(agree).disagreeNow).toBe(false)
    const mailed = mkCtx({ self: { status: 'notice-mailed', aseed: null }, remotes: [peer('a', 2, { status: 'litigation' })], ...bus(['a']) })
    expect(sanityStep(mailed).disagreeNow).toBe(false)
    const legacyPeer = mkCtx({ self: { status: 'extension', aseed: null }, remotes: [peer('a', 2, { status: 'litigation' })] })
    expect(sanityStep(legacyPeer).disagreeNow).toBe(false)
  })
  it('dt scales companyDelta linearly', () => {
    expect(sanityStep(mkCtx({ dt: 0.5 })).companyDelta).toBe(0.375)
    expect(sanityStep(mkCtx({ dt: 0.5, remotes: [peer('a', 2, { status: 'notice-mailed' })], ...bus(['a']) })).companyDelta).toBe(-1.5)
  })
})

describe('the result object, the lines, the pool numbers', () => {
  it('one reused object across 10000 calls', () => {
    const ctx = Object.freeze(mkCtx({ remotes: Object.freeze([peer('a', 2, { status: 'notice-mailed' })]), ...bus(['a']) }))
    const first = sanityStep(ctx)
    let same = true
    for (let i = 0; i < 10000; i++) if (sanityStep(ctx) !== first) same = false
    expect(same).toBe(true)
  })
  it('COMPANY equals the roll call’s numbers; the two lines are lowercase', () => {
    expect(COMPANY).toEqual({ max: 60, drain: 3, refill: 0.75 })
    expect(Object.isFrozen(COMPANY)).toBe(true)
    expect(COMPANY.max).toBe(ROLLCALL_COMPANY.max)
    expect(COMPANY.drain).toBe(ROLLCALL_COMPANY.drain)
    expect(COMPANY.refill).toBe(ROLLCALL_COMPANY.refill)
    expect(EXHAUSTED_LINE).toBe('you have been standing together a long time. it stops helping.')
    expect(DISAGREE_LINE).toBe('you disagree about the file. it is still easier together.')
  })
})
