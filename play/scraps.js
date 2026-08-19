// scraps.js — the ones before you.
//
// Scattered found notes and scratched wall-messages left by earlier wanderers.
// A finite, curated pool that assembles — out of order — into one quiet story:
// the journal of someone who signs "m.", plus standalone tallies and graffiti
// that answer each other across the dark. Pure and deterministic; decor.js
// places them by chunk, game.js reads them. Kept separate so the lore stays
// unit-testable and decor.js stays about placement.

export const SCRAPS = [
  'day one. i took the wrong door out of the break room. i am not worried yet. someone will notice the empty desk.',
  'the carpet here is the exact yellow of my first office. i keep waiting for the copier to hum.',
  'scratched into the pillar: forty-one marks. i did not make all of them.',
  'rule i learned today: the almond water is real. drink it. the dark drinks you back if you do not.',
  'i pressed my ear to the wallpaper to hear the voices behind it. the voices were mine, from yesterday.',
  'we found each other by the pipes. three of us now. it is easier to be lost together.',
  'j. went ahead to scout the wet corridor. we agreed to whistle every minute. it has been an hour of quiet.',
  'if you are reading this: there is no way up. i am sorry. there is only further in — and further in is not always worse.',
  'note left under the tally: i counted too. i think the marks are days. i think we have been kind to ourselves about the number.',
  "a child's drawing was taped to a door. a house, a sun, four stick people. i left it where it was. some doors you knock on and walk past.",
  'the humming got into my sleep, and now i hum it awake. i am not afraid of it anymore. that frightens me more than the fear did.',
  "to the one who signs every page 'm.': i am following your notes like breadcrumbs. keep writing. i am close behind.",
  'last full page. i left the lantern and most of the water at the fork. take the left. the right only loops back here, to me. — m.',
  "someone scratched one fresh word over m.'s last page: 'out.' with an arrow. i am choosing to believe the arrow.",

  // ── the deeper thread — the reality-tunneling arc, found further in ──
  'i measured the hum today, the way you would measure a fever. it is a little higher than last week. it is higher every week.',
  'the dark used to give ground when i walked. now it gives less. i think the room is getting smaller in a way rooms are not supposed to.',
  'a man dropped in near me from somewhere warm and far. i could see through him like tracing paper. he did not know he was thin. i did not tell him.',
  'here is the thing no one wants written down: the deeper i go, the more real it gets. the grit under my nails. up top everything was cheap. down here it is true.',
  'so further in was never the wrong way. it was the only way that is still honest.',
  'the radio in the wall counts. not words. numbers, slow, patient, one after another, closing. i think it is reading a list. i am waiting to hear my line.',
  'i worked out what the counting counts down to. i did the arithmetic three times because i did not want it to be right. it is a date.',
  'we were told the world was old and settling, like a house. it is not settling. someone is spending it. i think the someone is all of us, arriving.',
  'when i stand still and mean it — really here, both feet, my whole weight — the lights hold. absence is what the dark eats. presence it cannot touch.',
  'out does not mean the stairs. there are no stairs. out is through the floor, past the last grain, into whatever we have been digging toward since before we had the word for time.',
]

// Same hash shape as items.js / decor.js (identical byte behaviour, seed 0 safe),
// but a FRESH channel (offsets 1213 / 3739) so scrap placement never collides
// with the prop / item / exit / npc streams.
function hash(a, b, c = 0) {
  let h = (a * 2654435761 ^ b * 2246822519 ^ Math.imul(c, 3266489917)) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

// Deterministic index into SCRAPS for a chunk. Pure function of (cx,cy,seed,salt).
export function fragmentAt(cx, cy, seed = 0, salt = 0) {
  return hash(cx + 1213 + salt, cy + 3739 + salt, seed) % SCRAPS.length
}
