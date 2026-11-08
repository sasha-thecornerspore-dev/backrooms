// scenes-look.js — vertical look (look.js / gfx-frame.js: a y-shear of the frame). Prefix: look-. Registered from scenes.js.
//
// The base poses with the view tilted up and down by most of the game's range (PITCH_MAX 0.32), so tools/gfx/parity.mjs can hold the GPU
// pass to the CPU one on a pitched horizon: the floor / ceiling span, the walls and the sprites moved with the horizon, the flashlight's beam
// and the sky's gradient where the shear says (from the centre row). The player's pitch rides on the player record, exactly as game.js
// hands it to render(); nothing else about a scene changes.
//   look-l0-up / look-l0-down        the l0-corridor view (lit lobby, panels), up 0.28 / down 0.28
//   look-l0-flash-up / -down         the same with the flashlight on: the beam stays in the hand
//   look-l2-up                       pipe dreams with its creature and props, looking up (the sprites stand on the pitched floor)
//   look-lnull-up / look-lnull-down  the yard (open sky, lit windows), looking up into the overcast and down at the ground
export function register(kit) {
  const tilt = (id, desc, opts, pitch) => {
    const s = kit.levelScene({ id, desc, ...opts })
    const b = s.build
    s.build = (env) => { const spec = b(env); spec.player.pitch = pitch; return spec }
    s.group = 'look'
    kit.SCENES.push(s)
  }
  const corridor = { level: 0, x: 11.5, y: 19.5, angle: 90 }
  tilt('look-l0-up', 'level 0 corridor, looking up 0.28 of the view: more drop-ceiling, the walls and the floor line lower', corridor, 0.28)
  tilt('look-l0-down', 'level 0 corridor, looking down 0.28: the carpet fills the view, the ceiling a band at the top', corridor, -0.28)
  tilt('look-l0-flash-up', 'level 0 corridor, flashlight on, looking up 0.28: the beam stays where you look, on the walls and ceiling', { ...corridor, lights: { flashlight: true } }, 0.28)
  tilt('look-l0-flash-down', 'level 0 corridor, flashlight on, looking down 0.28: the beam pools on the carpet just ahead', { ...corridor, lights: { flashlight: true } }, -0.28)
  tilt('look-l2-up', 'level 2 pipes with the toolbox, the drum and a lurker, looking up 0.22: the sprites stand on the pitched floor',
    { level: 2, x: 33.5, y: -3.5, angle: 270, extra: () => [kit.makeEnemy('lurker', 34.5, -8.5)] }, 0.22)
  tilt('look-lnull-up', 'level null yard, looking up 0.28: more of the overcast, the gradient anchored to the elevation', { level: 4, x: 4.5, y: 15.0, angle: -20 }, 0.28)
  tilt('look-lnull-down', 'level null yard, looking down 0.25: the ground, a band of sky at the top', { level: 4, x: 4.5, y: 15.0, angle: -20 }, -0.25)
}
