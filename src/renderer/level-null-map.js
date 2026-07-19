// level-null-map.js — the hand-authored Harlem Park inner-block-park (Level ∅).
//
// A real place, grounded in the record: the 800-block of N Carey St, West
// Baltimore. A 1937 HOLC map graded it "hazardous"; a 1961 renewal plan erased
// the alley streets (Woodyear, Vincent) and left 29 "inner block parks" nobody
// asked for and the city never maintained. Front doors were later sealed with
// concrete block behind their original frames — so the only way in is the gap
// the paperwork left. See docs/superpowers/specs/2026-07-16-level-zero-*.md.
//
// This is a fixed grid (see fixedmap.js). Cell codes:
//   .  open floor (the park)          F  formstone (fake stone over brick)
//   C  CMU-sealed door (masoned shut) P  plywood board, house number sprayed on
//   B  brick                          W  black open upper window (no glass, no board)
//   O  occupied house (curtains, glass, a light on — nobody comes out)
//   M  marble stoop                   X  (reserved: out-of-bounds solid)
//
// The block is enclosed by rowhouse backs on all sides; the player stands in
// Woodyear Street. Woodyear Street is not there.
export const NULL_MAP = [
  'FOCPWBOFCPWBOFCPWBOFCPWB',   // 0  rowhouse backs (top)
  'F......................B',   // 1
  'O......................W',   // 2   ← spawn is in here
  'C......................P',   // 3
  'P......................C',   // 4
  'W.......FFF............O',   // 5  a rowhouse back juts into the park
  'B.......MMM............F',   // 6  marble stoops at its foot
  'F......................B',   // 7
  'O......................W',   // 8
  'C......................P',   // 9
  'P.............OOO......C',   // 10 an occupied row juts in — lights on
  'W.............MMM......O',   // 11 its stoops
  'B......................F',   // 12
  'F......................B',   // 13  ← the way down is in here
  'O......................W',   // 14
  'C......................P',   // 15
  'P......................C',   // 16
  'BWPCOFBWPCOFBWPCOFBWPCOF',   // 17 rowhouse backs (bottom)
]

// Spawn just inside, in the open park. Exit (the no-clip down into the lobby)
// sits deeper in — always reachable on foot (asserted in the test).
export const NULL_SPAWN = { x: 2.5, y: 2.5 }
export const NULL_EXIT  = { x: 18.5, y: 13.5 }
