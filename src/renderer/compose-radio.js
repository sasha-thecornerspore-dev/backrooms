// compose-radio.js — what the radio says when you turn it. Pure: no DOM, no audio, no prefs, no net; per press, so it may allocate.
//
// Off: silence. On, the mode is the status's (statusMods(status).radioMode(depth)): 'crackle' on the near floors for whoever
// never answered the notice, 'roll' there for a filed status (the docket's roll call, handed in as a string), 'ledger' on
// floors 2-3 for everyone: the station reads one group a turn, counting down to your line. The column decides the heartbeat
// and the follow-up (rules.radio: the legacy 'that one was yours.', the unnamed's 'it did not say whose.', the processed key
// line once); the roll call's count of the living layers over the legacy last line only. The caller plays blip / heartbeat,
// shows the follow-ups after their ms, advances stationIdx on `advance`, and writes ledgerHeard / clears firstDeepHearing.
import { LEGACY_LAST_LINE } from './origin-rules.js'
import { RADIO_KEY_LINE } from './origin-processed.js'

// the ledger the station reads (game.js's RADIO_GROUPS, the same four strings)
export const RADIO_GROUPS = Object.freeze(['12 26 04 22 11 08', '21 08 19 24 23 12', '23 12 17 23 11 08', '09 12 15 08'])

const ONES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen',
  'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']
// one .. thirty-two (a whistle's payload caps the count at 32)
export const WORDS = Object.freeze([...ONES,
  ...ONES.slice(0, 9).map((w) => 'twenty-' + w), 'thirty', 'thirty-one', 'thirty-two'])

export function words(n) {
  return Number.isInteger(n) && n >= 1 && n <= WORDS.length ? WORDS[n - 1] : 'many'
}

export function COUNT_LINE(n) {
  return `it reads the last group, then stops. those were yours — ${words(n)} of you.`
}

const SILENT = 'the radio falls silent.'
const CRACKLE = 'the radio crackles to life.'
const FOLLOW_MS = 1900

// ctx: { on, rules, mode, stationIdx, groups, count, firstDeepHearing, rollLine }
// -> { message, blip, heartbeat (beat now), followUps: [{ text, ms }], advance, ledgerHeardNow, keyLineNow }
export function radioLine(ctx) {
  const r = { message: SILENT, blip: false, heartbeat: false, followUps: [], advance: false, ledgerHeardNow: false, keyLineNow: false }
  if (!ctx.on) return r
  if (ctx.mode === 'roll') { r.message = ctx.rollLine ?? CRACKLE; r.blip = true; return r }
  if (ctx.mode !== 'ledger') { r.message = CRACKLE; return r }

  const groups = ctx.groups, i = ctx.stationIdx
  const last = i === groups.length - 1
  r.message = `the station counts, slow and patient: ${groups[i]}${last ? '' : ' …'}   [${i + 1}/${groups.length}]`
  r.blip = true
  r.advance = true
  r.ledgerHeardNow = last
  const b = ctx.rules.radio({ last, firstDeepHearing: ctx.firstDeepHearing })   // the block's reused object: read it here, keep nothing
  r.heartbeat = b.heartbeat === 'every' || (b.heartbeat === 'last' && last)
  const f = b.followUp
  if (f != null) r.followUps.push({ text: (f === LEGACY_LAST_LINE && ctx.count >= 2) ? COUNT_LINE(ctx.count) : f, ms: FOLLOW_MS })
  r.keyLineNow = f === RADIO_KEY_LINE
  return r
}
