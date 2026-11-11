// compose-wish.js — what a wish at the presence is. Pure: no DOM, no audio, no prefs, no net; per submit, so it may allocate.
//
// One router, in this order: close the file (compliance only) -> a name (the unnamed only: 'call me …' / 'my name is …') -> a
// status word ('extension', 'file me under litigation', …: the office's gates are status.js fileStatus's) -> the claim ('i was
// here', letters only) -> an ordinary wish. close / name / status are LOCAL: they carry no submit and the caller never sends
// them. claim and wish carry { text (plus the status trailer, '' for a notice never answered), meta (the column's) }. A claim
// re-files the claimant as processed (origin-processed.js claimRefile); the caller applies it before tryFinale().
import { parseNameWish } from './origin-unnamed.js'
import { claimRefile } from './origin-processed.js'
import { parseStatusWish, fileStatus, wishTrailer, stripTrailers } from './status.js'
import { isCloseWish, closeFile, closingReply } from './closings.js'

export const LEGACY_CLAIM_REPLY = 'you did not ask. you asserted. the file has no column to deny a claim made. received.'
export const LEGACY_WISH_REPLY = 'your request has been received. whether it is heard is another matter.'

// wish #20 ('hi'): the owner's answer to a wish that is nothing but a greeting. It is still filed as any wish is (the owner reads them
// all); only the presence's reply is the owner's. The wish carries no name and keeps no number, so this is how the answer reaches
// whoever says hi: the next time they do.
export const GREETING_REPLY = 'hello. make a real wish next time.'
const GREETING_WORDS = new Set(['hi', 'hello', 'hey', 'hiya', 'howdy', 'greetings', 'hola'])
// words that may ride along with one ('hi there', 'hello everyone'); never a greeting alone
const GREETING_FILLER = new Set(['there', 'everyone', 'everybody', 'all', 'yall', 'guys', 'friend', 'friends', 'world', 'again'])
// a few words, every one a greeting or its filler, at least one a greeting; punctuation and case do not count
export function isGreeting(text) {
  const words = String(text).toLowerCase().replace(/['’]/g, '').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean)
  if (words.length === 0 || words.length > 6) return false
  let greeted = false
  for (const w of words) {
    if (GREETING_WORDS.has(w)) greeted = true
    else if (!GREETING_FILLER.has(w)) return false
  }
  return greeted
}

// game.js's claim test, byte for byte: 'iwashere' anywhere in the letters ('i was not here' is not a claim)
export const isClaim = (t) => /iwashere/.test(String(t).toLowerCase().replace(/[^a-z]/g, ''))

// ctx: { text (trimmed, non-empty), origin, rules, file: { status, at, ledgerHeard, closing, redacted }, canFile, now, depth }
export function wishRoute(ctx) {
  const { text, origin, rules, file } = ctx
  if (isCloseWish(text) && file.status === 'compliance') return { kind: 'close', ...closeFile(file) }
  if (origin === 'unnamed') {
    const name = parseNameWish(text)
    if (name) return { kind: 'name', name }
  }
  const chosen = parseStatusWish(text)
  if (chosen) return { kind: 'status', chosen, ...fileStatus(file, chosen, ctx.now, ctx.canFile) }
  // a typed trailer line never reaches the docket (the last line wins, and a notice never answered appends none); a wish
  // that is nothing but such lines goes lowercased, which the parser does not read (R3SP-2)
  const body = stripTrailers(text) || text.toLowerCase()
  const submit = { text: body + wishTrailer(file.status, ctx.depth), meta: rules.wishMeta() }
  if (isClaim(text)) {
    return { kind: 'claim', submit, reply: rules.presenceReply('claim') ?? LEGACY_CLAIM_REPLY, refile: origin === 'processed' ? null : claimRefile(origin) }
  }
  if (isGreeting(text)) return { kind: 'wish', submit, reply: GREETING_REPLY }
  return { kind: 'wish', submit, reply: closingReply(file.closing) ?? rules.presenceReply('wish') ?? LEGACY_WISH_REPLY }
}
