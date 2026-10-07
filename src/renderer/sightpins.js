// sightpins.js — what goes on the map because you SAW it, even far down a hall.
//
// visibleWays runs the sprite pass's own cull (raycaster.inViewCone) and the shared line of sight (raycaster.lineOfSight) over a list of
// records, so 'seen on the map' = 'drawn on screen' = 'seen by the thing'. It runs on the cell-change tick only (a few times a second,
// <= ~30 LOS walks), never per frame, and writes into a reused `out`. Reach is the caller's: ways fog * 1.35 (the beam shows at 1.35x fog,
// gfx-sprites.js:2710), sights fog * 1.0. Machines, scraps and lost souls pin by proximity (PROX_PIN) instead: you notice them when you
// are beside them. Pure: no DOM, no game state.
import { lineOfSight, inViewCone } from './raycaster.js'

export const PROX_PIN = 4.5

// said once per sight key, the first time it is pinned within 9 u (PRIO.discovery)
export const SIGHT_LINES = Object.freeze({
  chairpile: { name: 'the chair pile', line: 'chairs, stacked to the ceiling, by someone with time.' },
  tvwall:    { name: 'the tv wall',    line: 'a wall of televisions, all on, all static.' },
  payphone:  { name: 'the payphone',   line: 'a payphone. the cord has been cut. it is ringing.' },
  mannequin: { name: 'the mannequin',  line: 'a mannequin, facing the wall. it was not facing the wall.' },
})

// the records of `list` the player can see: within reach, inside the view cone, with a clear line of sight. Written into `out`
// (trimmed to the count, same array), count returned. Distance and cone are checked before the grid is asked.
export function visibleWays(player, list, floorFn, reach, hf, out) {
  let n = 0
  const px = player.x, py = player.y, pa = player.angle
  const r2 = reach * reach
  for (let i = 0; i < list.length; i++) {
    const r = list[i]
    const dx = r.x - px, dy = r.y - py
    if (dx * dx + dy * dy > r2) continue
    if (!inViewCone(px, py, pa, r.x, r.y, hf, reach)) continue
    if (!lineOfSight(px, py, r.x, r.y, floorFn)) continue
    out[n++] = r
  }
  if (out.length !== n) out.length = n
  return n
}
