// scenes-int.js — integration scenes (poses/inputs that only misbehave when the tracks are combined).
// Prefix: int-. Registered from scenes.js. A scene spec may carry `timing: {t, dt}` (what game.js passes render()).
export function register(kit) {
  registerFlash(kit); registerLong(kit); registerDt(kit); registerGrid(kit)
  const at = (id, desc, opts, timing, ro) => {
    const s = kit.levelScene({ id, desc, level: 0, enemies: false, ...opts })
    const b = s.build
    s.build = (env) => ({ ...b(env), timing, ...(ro ? { renderOpts: { ...kit.RENDER_OPTS, ...ro } } : {}) })
    kit.SCENES.push(s)
  }
  // the pose page.cjs --level 0 starts a saved run at: near ceiling panels, so lit walls are at their brightest
  const pose = { x: 33.5, y: 11.5, angle: 0 }
  at('int-l0-np-t0',  'in-game start pose, t = 0.15 s (what the harness always used)', pose, null)
  at('int-l0-np-t4',  'in-game start pose, real time t = 4.0 s', pose, { t: 4.0, dt: 1 / 60 })
  at('int-l0-np-t6',  'in-game start pose, real time t = 6.5 s', pose, { t: 6.5, dt: 1 / 60 })
  at('int-l0-np-s60', 'in-game start pose, t = 6.5 s, explicit renderScale 0.6', pose, { t: 6.5, dt: 1 / 60 }, { renderScale: 0.6 })
}

// appended: the flashlight is ON by default in the real game (lights.flashlight = true), so the in-game start frame has it
export function registerFlash(kit) {
  const pose = { x: 33.5, y: 11.5, angle: 0 }
  for (const [id, lights] of [['int-l0-np-flash', { flashlight: true }], ['int-l0-np-glow', { glow: [80, 235, 110] }]]) {
    const s = kit.levelScene({ id, desc: 'in-game start pose with ' + Object.keys(lights)[0] + ' (the real game starts with the flashlight on)', level: 0, enemies: false, lights, ...pose })
    const b = s.build
    s.build = (env) => ({ ...b(env), timing: { t: 4.0, dt: 1 / 60 } })
    kit.SCENES.push(s)
  }
}

// long-run twins: the game has rendered hundreds of frames before you see one (catches frame-to-frame state / accumulation)
export function registerLong(kit) {
  for (const w of [60, 300]) {
    const s = kit.levelScene({ id: 'int-l0-np-flash-w' + w, desc: 'in-game start pose, flashlight on, after ' + w + ' frames', level: 0, enemies: false, lights: { flashlight: true }, x: 33.5, y: 11.5, angle: 0 })
    const b = s.build
    s.build = (env) => ({ ...b(env), timing: { t: 4.0, dt: 1 / 60 } })
    s.warmup = w
    kit.SCENES.push(s)
  }
}

// large-dt twins: a slow machine (or a hidden window) hands the renderer dt up to the 0.1 s cap
export function registerDt(kit) {
  for (const dt of [1 / 30, 0.1]) {
    const id = 'int-l0-np-dt' + Math.round(dt * 1000)
    const s = kit.levelScene({ id, desc: 'in-game start pose, high tier, frame time dt = ' + dt.toFixed(3) + ' s', level: 0, enemies: false, x: 33.5, y: 11.5, angle: 0 })
    const b = s.build
    let t = 0
    s.build = (env) => {
      const spec = b(env)
      // a timing object that advances by dt each time it is read (like game.js's reused {t, dt})
      spec.timing = { get t() { t += dt; return t }, dt }
      return spec
    }
    s.warmup = 60
    kit.SCENES.push(s)
  }
}

// bisect grid (fixed t): frame time x warm-up frames
export function registerGrid(kit) {
  for (const dtq of [60, 45, 30]) for (const w of [1, 9, 60]) {
    const dt = 1 / dtq
    const s = kit.levelScene({ id: `int-grid-dt${dtq}-w${w}`, desc: `dt=1/${dtq}, ${w} frames`, level: 0, enemies: false, x: 33.5, y: 11.5, angle: 0 })
    const b = s.build
    s.build = (env) => ({ ...b(env), timing: { t: 4.0, dt } })
    s.warmup = w
    kit.SCENES.push(s)
  }
}
