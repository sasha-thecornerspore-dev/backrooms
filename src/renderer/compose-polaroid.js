// compose-polaroid.js — what the film develops. Pure: no DOM, no audio, no prefs, no net; per shot, so it may allocate.
//
// firePolaroid keeps the capture, the flash, the shutter's noise and the flash on the things; this decides the caption, the
// sanity it gives back (+8, the core's; litigation's thin-figure bonus on top), whether the letter advances, the photo a friend
// in frame is sent, and the calm a pin caption buys. First match wins:
//   (1) a friend in frame (W7's record, read in the call)   (2) the column's own film (rules.polaroid: thin's first shot, the
//   anchored pin, the unnamed's letter that is not theirs)   (3) a lost soul in frame   (4) the thin figure beside you
//   (5) no claim develops: compliance's honest film, else the finalizing hall   (6) the letter.
// Under LEGACY with nobody in frame this is the core's three captions, by its precedence (thinNear > finalizing > letter).
export const LINES = Object.freeze({
  SUBJECT_DOWN: 'the film develops {name}, where they fell. they are counted.',
  SUBJECT_THIN: 'the film develops {name}. you can see the wall through them.',
  SUBJECT_PIN: 'the film develops {name}. the film shows your pin.',
  SUBJECT_PROCESSED: 'the film develops {name}. there is a stamp on them.',
  SUBJECT_ANCHORED: 'the film develops {name}. the film shows a pin, and a distance.',
  SUBJECT_TENANT: 'the film develops {name}. there is an address under them. the street is not there.',
  SUBJECT_UNNAMED: 'the film develops {name}. the caption did not develop.',
  SUBJECT_UNKNOWN: 'the film develops {name}. the file has not finished with them.',
  SUBJECT_GLYPH: ' one letter developed beside them: "{g}".',
  SOUL_DOOR: 'the film shows them, and behind them, faintly, a door: {arrow}',
  SOUL_NONE: 'the film shows them, and nothing behind them.',
  THIN_NEAR: 'the film shows someone who was not in the room. you can see the wall through them.',
  EVIDENCE_SUFFIX: ' evidence.',
  HONEST_FILM: 'the film shows the hall as it is. nothing that was not in the room.',
  FINALIZING: 'the film shows the hall as it will finalize: darker, one door fewer.',
  GLYPH: 'the film develops one letter that was not in the room: "{g}". transcribe it.',
})

const PHOTO_SANITY = 8          // a capture is a small counter-claim: it steadies you (game.js's +8)
const CLAIM = 'iwashere'

// a function replacer: a name is spliced verbatim, whatever `$` patterns it holds
const fill = (s, key, v) => s.replace(key, () => String(v))

export function glyph(photoIdx) { return CLAIM[photoIdx % 8] }

// the column can develop a claim (the unnamed have no letter) AND the status lets the film develop one
export function developsClaim(rules, mods, index, depth, sanity) {
  return !!(rules.canDevelopClaim && mods.polaroidGlyph(index, depth, sanity))
}

// the friend's 'here' carries their pin's TAG (anchor.js pinTag, room-salted), so it is your own tag it is held against
function subjectLine(s, tag) {
  if (s.thin === true) return LINES.SUBJECT_THIN
  if (tag != null && s.aseed != null && s.aseed === tag) return LINES.SUBJECT_PIN   // same pin, never same maze
  if (s.origin === 'processed') return LINES.SUBJECT_PROCESSED
  if (s.origin === 'anchored') return LINES.SUBJECT_ANCHORED
  if (s.origin === 'tenant') return LINES.SUBJECT_TENANT
  if (s.origin === 'unnamed') return LINES.SUBJECT_UNNAMED
  return LINES.SUBJECT_UNKNOWN
}

// ctx: { rules, mods, subject, soul, doorArrow, thinNear, status, index, depth, sanity (before this shot), origin, thin,
//        thinFirstShot, anchor, pinTag (your pin's tag, or null), D, firstShotOfLevel, photoIdx, player, lvl }
// -> { cap, glyphAdvance, emitPhoto: { of, x, y, lvl } | null, sanity (to add), leashCalm (0 or the seconds to set) }
export function polaroidCaption(ctx) {
  const { rules, mods, index, depth, sanity } = ctx
  const g = glyph(ctx.photoIdx)
  const dev = developsClaim(rules, mods, index, depth, sanity)
  const r = { cap: '', glyphAdvance: false, emitPhoto: null, sanity: PHOTO_SANITY, leashCalm: 0 }

  // (1) a friend in frame: the photo goes to them; a downed one is counted, never lettered
  const s = ctx.subject
  if (s) {
    r.emitPhoto = { of: s.id, x: ctx.player.x, y: ctx.player.y, lvl: ctx.lvl }
    if (s.st === 'down') { r.cap = fill(LINES.SUBJECT_DOWN, '{name}', s.name); return r }
    r.cap = fill(subjectLine(s, ctx.pinTag ?? null), '{name}', s.name)
    if (dev) { r.cap += fill(LINES.SUBJECT_GLYPH, '{g}', g); r.glyphAdvance = true }
    return r
  }

  // (2) the column's own film, handed the letter this film WOULD develop under the status and the thin figure
  const finalizing = sanity < 40 || index >= 3
  const gWould = (!ctx.thinNear && mods.polaroidGlyph(index, depth, sanity)) ? g : null
  const o = rules.polaroid({ depth, index, sanity, anchor: ctx.anchor, D: ctx.D, firstShotOfLevel: ctx.firstShotOfLevel,
    thinFirstShot: ctx.thinFirstShot, glyph: gWould, finalizing, thinNear: ctx.thinNear })
  if (o != null) {
    r.cap = o.cap
    r.glyphAdvance = o.advance === true
    r.leashCalm = o.leashCalm ?? 0
    return r
  }

  // (3) a lost soul in frame, and the door behind them when one is known
  if (ctx.soul != null) {
    r.cap = ctx.doorArrow ? fill(LINES.SOUL_DOOR, '{arrow}', ctx.doorArrow) : LINES.SOUL_NONE
    return r
  }

  // (4) the thin figure; under litigation it is evidence
  if (ctx.thinNear) {
    r.cap = LINES.THIN_NEAR
    if (mods.thinSanity > 0) { r.cap += LINES.EVIDENCE_SUFFIX; r.sanity = PHOTO_SANITY + mods.thinSanity }
    return r
  }

  // (5) no claim develops: compliance's film is honest; everyone else's shows the hall finalizing
  if (!dev) {
    r.cap = ctx.status === 'compliance' ? LINES.HONEST_FILM : LINES.FINALIZING
    return r
  }

  // (6) the letter
  r.cap = fill(LINES.GLYPH, '{g}', g)
  r.glyphAdvance = true
  return r
}
