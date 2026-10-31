// walks.mjs — seeded walks through each floor of ONE tree (--src) with that tree's own systems running at 60 Hz: the creatures
// (entities.js / hunt.js / variants.js, hunt path, obstacles on), footstep noise, the threat record -> damage / tension / sanity
// (compose-sanity.js, LEGACY rules), the Living Atmosphere scheduler (events.js) with game.js's 12 s / 20 s dread quiet, the placed
// hauntings behind game.js's calm gate, the floor murmurs, the flicker machine, the distant swell, and the message queue (messages.js)
// that decides which lines are actually shown. Sightings use sightpins.visibleWays — the cone + line of sight the game pins the map with.
//
// What the tree's game.js wires decides what the walker meets (lib.mjs WIRING): on 2.0.4 the faint pull waits (PULL_WAIT_S, 120 s on a fresh
// lobby, sooner after a hint), shows no metres, wobbles and never names a stair up; the plate budget, the arrival event, the murmur bag,
// the seen line and its tell, dread with the teller and the dread heartbeat, the flashlight and smiler lines once a run. On 2.0.3 none.
//
// Two walkers: explore (novelty-seeking wander) and seek (a compass follower: the arrow when the HUD shows one — the BFS route to a way
// it has seen, a greedy lean toward the faint pull's wobbled bearing — and the explore wander when it shows nothing). The light goes off
// for a share of the time (--light-off, default 0.15, in 6-14 s stretches), as a player saves it or tries it.
//
//   node tools/pacing/walks.mjs --src <tree>/src/renderer --out <walks.json> [--seconds 300] [--seeds 20] [--floors 0,1,2,3]
//                               [--modes explore,seek] [--light-off 0.15] [--legacy]
//   --legacy  the 2.0.3-era walker exactly (light always on, no floor plate, no reading): reproduces catchup/pacing/walks.json
//   VARIANT='{"name":"dense","spawnDenom":{"1":4},"wanderer":{"2":["crawler","watcher"]},"tension":0.6}' what-if knobs, as before
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { loadTree, parseArgs, mulberry, pathTo } from './lib.mjs'

const { val, flags } = parseArgs(process.argv.slice(2), ['src', 'out', 'seconds', 'seeds', 'floors', 'modes', 'light-off'])
const T = await loadTree(val.src)
const { CHUNK, has } = T
const LEGACY = flags.has('legacy')
const WALK_S = Number(val.seconds ?? 300)
const NSEEDS = Number(val.seeds ?? 20)
const LIGHT_OFF = LEGACY ? 0 : Number(val['light-off'] ?? 0.15)
const FLOORS = (val.floors ?? '0,1,2,3').split(',').map(Number)
const MODES = (val.modes ?? 'explore,seek').split(',')
const OUTFILE = path.resolve(val.out ?? 'walks.json')
const VARIANT = process.env.VARIANT ? JSON.parse(process.env.VARIANT) : null
const mutateFor = (index) => (cfg) => { if (VARIANT?.spawnDenom?.[index] && cfg.entities?.enabled) cfg.entities = { ...cfg.entities, spawnDenom: VARIANT.spawnDenom[index] }; if (VARIANT?.wanderer?.[index] && cfg.entities?.enabled) cfg.entities = { ...cfg.entities, wandererVariants: VARIANT.wanderer[index] } }
const SEEDS = [null, ...Array.from({ length: NSEEDS - 1 }, (_, i) => i + 1)]
const DT = 1 / 60
const WALK = 0.05 * 60          // game.js SPEED 0.05 per 60 Hz frame -> 3.0 u/s
const HF = T.FRM.HF
const PRIO = T.MSG.PRIO
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]
const DREAD_CLOCK = T.DRD?.DREAD_CLOCK ?? { tick: 0.25, build: 0.5 }
const FX_FLICK_S = T.EVT.FX_PLAY?.flickS ?? 0.6
const LIGHT_ON_LINE = 'flashlight on.'
const LIGHT_OFF_LINE = T.LSH?.litOffLine ? T.LSH.litOffLine(null) : 'flashlight off — the dark leans in.'
const SMILER_LINE = 'it stops when you look. do not look away.'
const OFF_S = [6, 14]          // a light-off stretch; the on stretches between are drawn so the share comes out at LIGHT_OFF

// the arrival on floor `index` for world `seed`: the lobby origin, else the chain of nearest exits down from it (like a run that dives)
function arrival(index, seed, clock, fresh) {
  if (index === 0) { const f = T.buildFloor(0, seed, { cx: 0, cy: 0 }, { clock, mutate: mutateFor(0), fresh }); return { f, at: f.spawn } }
  let f = T.buildFloor(0, seed, { cx: 0, cy: 0 }), sx = f.spawn.x, sy = f.spawn.y
  for (let k = 1; k <= index; k++) {
    const field = T.bfs(f.grid, sx, sy, Math.floor(sx / CHUNK), Math.floor(sy / CHUNK), 3)
    let best = null, bd = Infinity
    for (const e of f.decor.getExits()) { const d = field.at(e.x, e.y); if (d >= 0 && d < bd) { bd = d; best = e } }
    if (!best) best = f.decor.getExits()[0]
    const a = T.arrivalFrom(k, seed, best)
    f = a.floor; sx = a.at.x; sy = a.at.y
  }
  const sc = { cx: Math.floor(sx / CHUNK), cy: Math.floor(sy / CHUNK) }
  const f2 = T.buildFloor(index, seed, sc, { clock, mutate: mutateFor(index) })
  return { f: f2, at: { x: sx, y: sy } }
}

function runWalk(index, seed, mode) {
  let playT = 0
  const clock = () => playT
  // the first run's thread (2.0.4): on only on a fresh run's lobby (the fixed world, worldSeed null)
  const firstRun = has.firstRun ? T.FR.createFirstRun({ fresh: index === 0 && seed === null, worldSeed: seed, room: false }) : null
  firstRun?.onLevel(index)
  const freshLobby = () => index === 0 && !!firstRun && firstRun.on()
  const { f, at } = arrival(index, seed, clock, freshLobby())
  const cfg = f.cfg, fog = cfg.fogDistance, grid = f.grid
  const creaturesLive = !!cfg.entities?.enabled
  const rnd = mulberry(((seed ?? 0) * 7919 + index * 131 + (mode === 'seek' ? 17 : 3)) >>> 0)
  // the new draws (the light, the pull's lean, the teller, the murmur bag) come from their own streams, so the walk's own choices stay
  // the 2.0.3 walker's draw for draw
  const aux = mulberry(((seed ?? 0) * 104729 + index * 7 + (mode === 'seek' ? 5 : 11)) >>> 0)
  const lrnd = mulberry(((seed ?? 0) * 15485863 + index * 31 + (mode === 'seek' ? 2 : 9)) >>> 0)
  const player = { x: at.x, y: at.y, angle: 0, hp: 100, maxHp: 100, moving: true, bob: 0 }
  // face the most open way out of the arrival cell
  { let best = 0, bn = -1; for (let k = 0; k < 4; k++) { let n = 0; while (n < 12 && grid.floor(Math.floor(at.x) + DIRS[k][0] * (n + 1), Math.floor(at.y) + DIRS[k][1] * (n + 1))) n++; if (n > bn) { bn = n; best = k } } player.angle = Math.atan2(DIRS[best][1], DIRS[best][0]) }
  const events = []
  const ev = (kind, tier, detail) => events.push(detail === undefined ? { t: +playT.toFixed(2), kind, tier } : { t: +playT.toFixed(2), kind, tier, detail })

  // ── the game's per-run state, as that tree's game.js keeps it ──
  const evConfig = { events: T.EVT.EVENTS, tension: VARIANT?.tension ?? 0 }
  const sched = T.EVT.createEventScheduler({ rng: rnd, config: evConfig })
  const hauntTr = T.HNT.createHauntTracker({ now: clock })
  const tension = T.TEN.createTension()
  const msgQ = T.MSG.createMessageQueue()
  const fk = T.GQ.createFlickerState()
  let flicker = 1, flickTgt = 1, flickTimer = 0, dipWas = false
  let sanity = 100, stamina = 100, invuln = 0, regenDelay = 0, lastHitT = -Infinity, dreadQuietT = 0
  let msgTimer = 0
  const MI = T.W.DEFAULT_CONFIG.messageInterval
  let msgNext = MI[0] + rnd() * (MI[1] - MI[0])
  const murmurs = [...(cfg.messages || []), cfg.exit?.hint].filter(Boolean)
  const murmurBag = has.murmurBag ? T.EVT.createBag(murmurs.length, aux) : null
  const DI = T.W.DEFAULT_CONFIG.audio.distantEventInterval
  let distantNext = DI[0] + rnd() * (DI[1] - DI[0]), distantT = 0
  let lastSeenLine = -Infinity, lastFarLine = -Infinity, turnSaid = false, houndTold = false, passTold = false, smilerTold = false
  const turningSaid = new Set()
  let wardCd = 0
  const rules = T.RUL.LEGACY, mods = T.STA.statusMods('notice-mailed'), co = T.CLO.closingOverlay(null)
  const sanCtx = { down: false, rules, standing: false, closingOverlay: co, mods, index, depth: T.STA.depthOf(index), flashlight: true, litNear: false,
    drift: 0, leashDebt: 0, leashCalm: 0, remotes: null, company: 60, companyWas: 60, disagreeSaid: false, origin: null }
  const aiCtx = { flashlight: true, sprinting: false, dark: !cfg.lights, fog, radioOn: false, lures: [], t: 0, hf: HF, playerAngle: 0, player,
    damage: cfg.entities?.damage ?? 16, sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1 }
  // the message line: every push remembers what kind of line it is, so the analysis can tell a murmur from your own light
  const clsOf = new Map()
  const show = (text, prio, cls = 'other') => { if (text) { msgQ.push(String(text), prio); clsOf.set(String(text), cls) } }
  const linesShown = []

  // ── the plate budget (2.0.4 game.js plate()): arrival and unprompted lines only; a line held back is let go (keep false) or waits ──
  const plates = has.plates ? T.PLT.createPlateBudget() : null
  const plate = (kind, text, prio, keep, cls) => {
    if (!plates) { show(text, prio, cls); return true }
    if (has.ambientIdle && prio === PRIO.ambient && !msgQ.idle()) return false
    if (!kind || !text || plates.admit(kind, playT, keep ? text : null) !== 'show') return false
    show(text, prio, cls); return true
  }
  const heldCls = new Map()
  // startVisit(): the window opens, the floor's own line (the sub-line on a first visit), the arrival event, the fresh lobby's held hint
  if (plates) plates.arrive(0)
  if (!LEGACY) {
    const line = has.floorPlate ? T.PLT.arrivalPlate(cfg, true) : cfg.levelName
    if (has.floorPlate) plate('floor', line, PRIO.combat, true, 'floor'); else show(line, PRIO.combat, 'floor')
  }
  if (has.eventArrive) sched.arrive(index, sanity)
  let hintHeld = has.hintHold && freshLobby() && !!cfg.exit?.hint
  let lostSaid = false, floorHinted = false, pullAt = null
  const pullPhase = aux() * Math.PI * 2

  // ── dread (2.0.4): the 4 Hz read, the path field at most twice a second, the teller; and the heart, in either tree ──
  const pathField = has.dread ? T.PF.createPathField() : null
  const teller = has.dread ? T.DRD.createTeller({ rng: aux }) : null
  const dreadOut = { dread: 0, x: 0, y: 0, variant: null, d: -1, los: false }
  let dreadT = 0, fieldT = -Infinity, fieldOn = false, maxDread = 0, heartT = 0, lastDreadT = -Infinity

  // ── the light: off for a share of the time; a haunt's dark holds it off a while ──
  let light = true, lightSaid = false, lightOffS = 0, hauntDarkT = 0
  const onMean = LIGHT_OFF > 0 ? ((OFF_S[0] + OFF_S[1]) / 2) * (1 - LIGHT_OFF) / LIGHT_OFF : Infinity
  let lightNext = LIGHT_OFF > 0 ? onMean * (0.5 + lrnd()) : Infinity
  function toggleLight() {
    light = !light
    lightNext = playT + (light ? onMean * (0.5 + lrnd()) : OFF_S[0] + lrnd() * (OFF_S[1] - OFF_S[0]))
    if (!has.lightOnce || !lightSaid) { lightSaid = true; show(light ? LIGHT_ON_LINE : LIGHT_OFF_LINE, PRIO.interaction, 'light') }
    ev(light ? 'light:on' : 'light:off', 'X')
  }

  // ── what the player has seen ──
  const seenEnt = new Map()     // id -> last seen t
  const seenKeys = new Set()
  const out = []
  const trail = []              // newest first, cells (fogmap.js lastTrail)
  const visits = new Map()
  const vkey = (ix, iy) => ix * 100003 + iy
  let cellsWalked = 0, lastCell = null
  let hunted = 0, gazeS = 0, tensionAudible = 0, hits = 0, deaths = 0, minHp = 100, minSan = 100, sanSum = 0, samples = 0
  const roomsDone = new Set(), roomCache = new Map()
  let pcxWas = NaN, pcyWas = NaN
  const chunksSeen = new Set(); let maxDisp = 0, secT = 0
  const nearestSeries = [], countSeries = []
  const readKeys = new Set(), spoke = new Set()

  // ── the compass (compass.js as that tree's game.js feeds it) ──
  const knownWays = new Map(), declined = new Set()
  const leadsOn = (k) => k === 'down' || k === 'lift' || k === 'ring'
  const newCompass = has.pull || has.nearestWayOn
  let misled = 0, sentUp = 0, reachedAt = null, reachedKind = null, bfsPath = null, bfsTarget = null, faintKey = null
  // what the HUD shows now: the nearest seen way that leads on (exact arrow + metres), else the faint pull when it is shown
  const cState = { known: null, pullShown: true, fb: null }
  function compassNow() {
    let best = null, bd = Infinity
    for (const w of knownWays.values()) {
      if (!leadsOn(w.kind)) continue
      const d = (w.x - player.x) ** 2 + (w.y - player.y) ** 2
      if (d < bd) { bd = d; best = w }
    }
    cState.known = best
    cState.pullShown = has.pull ? T.CMP.pullVisible({ floorT: playT, hinted: floorHinted, fresh: freshLobby(), step: firstRun ? firstRun.step() : 0 }) : true
    if (has.nearestWayOn) { const room = firstRun?.toward?.(); cState.fb = room ?? f.decor.nearestWayOn(player.x, player.y)?.rec ?? null }
    else cState.fb = f.decor.nearestWayAny(player.x, player.y)?.rec ?? null
    if (cState.pullShown && pullAt === null) pullAt = +playT.toFixed(2)
    return cState
  }
  compassNow()

  // movement
  let tx = Math.floor(player.x) + 0.5, ty = Math.floor(player.y) + 0.5, fromX = NaN, fromY = NaN
  let stepAcc = 0

  function nextCellExplore(ix, iy) {
    const opts = []
    const fwd = Math.round(((player.angle % (2 * Math.PI)) + 2 * Math.PI) / (Math.PI / 2)) % 4
    for (let k = 0; k < 4; k++) {
      const nx = ix + DIRS[k][0], ny = iy + DIRS[k][1]
      if (!grid.floor(nx, ny)) continue
      const back = nx + 0.5 === fromX && ny + 0.5 === fromY
      const base = k === fwd ? 1.0 : ((k + 2) % 4 === fwd ? 0.08 : 0.55)
      const v = visits.get(vkey(nx, ny)) ?? 0
      opts.push({ nx, ny, w: (back ? 0.05 : 1) * base / (1 + 2.5 * v) })
    }
    if (!opts.length) return null
    let tot = 0; for (const o of opts) tot += o.w
    let r = rnd() * tot
    for (const o of opts) { r -= o.w; if (r <= 0) return o }
    return opts[opts.length - 1]
  }
  function nextCellToward(ix, iy, want) {
    let best = null, bs = -Infinity
    for (let k = 0; k < 4; k++) {
      const nx = ix + DIRS[k][0], ny = iy + DIRS[k][1]
      if (!grid.floor(nx, ny)) continue
      const back = nx + 0.5 === fromX && ny + 0.5 === fromY
      const a = Math.atan2(DIRS[k][1], DIRS[k][0])
      const v = visits.get(vkey(nx, ny)) ?? 0
      const s = Math.cos(a - want) - 0.7 * v - (back ? 0.5 : 0) + rnd() * 0.15
      if (s > bs) { bs = s; best = { nx, ny } }
    }
    return best
  }
  const nextCellGreedy = (ix, iy, gx, gy) => nextCellToward(ix, iy, Math.atan2(gy - (iy + 0.5), gx - (ix + 0.5)))
  function routeTo(w, ix, iy) {
    if (bfsTarget !== w.key || !bfsPath || !bfsPath.length) {
      const field = T.bfs(grid, w.x, w.y, Math.floor(w.x / CHUNK), Math.floor(w.y / CHUNK), 3)
      const p = pathTo(field, grid, ix + 0.5, iy + 0.5)
      bfsPath = p ? p.reverse().slice(1) : null; bfsTarget = w.key
    }
    if (bfsPath && bfsPath.length) { const [nx, ny] = bfsPath.shift(); return { nx, ny } }
    return null
  }
  // 2.0.3's compass as the walker always read it: the nearest SEEN way that leads on, else the nearest loaded way of ANY kind
  // (decor.nearestWayAny, stairs up included), minus the ones this walker already walked up to and refused
  function compassTargetLegacy() {
    let best = null, bd = Infinity
    for (const w of knownWays.values()) {
      if (!leadsOn(w.kind) || declined.has(w.key)) continue
      const d = (w.x - player.x) ** 2 + (w.y - player.y) ** 2
      if (d < bd) { bd = d; best = w }
    }
    if (best) return { rec: best, known: true }
    let fb = null; bd = Infinity
    for (const w of [...f.decor.getExits(), ...f.decor.getStairs()]) {
      if (declined.has(w.key)) continue
      const d = (w.x - player.x) ** 2 + (w.y - player.y) ** 2
      if (d < bd) { bd = d; fb = w }
    }
    return fb ? { rec: fb, known: false } : null
  }
  function planSeek(ix, iy) {
    if (!newCompass) {
      const tgt = compassTargetLegacy()
      if (!tgt) return nextCellExplore(ix, iy)
      const w = tgt.rec
      if (tgt.known) { const s = routeTo(w, ix, iy); if (s) return s }
      else faintKey = w.key + ':' + w.kind
      return nextCellGreedy(ix, iy, w.x, w.y)
    }
    const c = compassNow()
    if (c.known) { const s = routeTo(c.known, ix, iy); if (s) return s; return nextCellGreedy(ix, iy, c.known.x, c.known.y) }
    if (c.pullShown && c.fb) {
      faintKey = c.fb.key + ':' + c.fb.kind
      const wob = has.pull ? T.CMP.pullWobble(playT, pullPhase) : 0
      return nextCellToward(ix, iy, Math.atan2(c.fb.y - (iy + 0.5), c.fb.x - (ix + 0.5)) + wob)
    }
    return nextCellExplore(ix, iy)
  }

  function onEntityEvent(e) {
    switch (e.kind) {
      case 'seen':
        turningSaid.delete(e.id)
        if (e.d <= fog * 1.1) {
          if (playT - lastSeenLine > 8) {
            lastSeenLine = playT
            if (has.seenLine) {
              const onScreen = T.RAY.inViewCone(player.x, player.y, player.angle, e.x, e.y, HF, fog * 1.1) && T.RAY.lineOfSight(player.x, player.y, e.x, e.y, grid.floor)
              show(T.CMP.seenLine(onScreen), PRIO.combat, 'hunt')
              if (!onScreen) ev('tell:seen', 'X', e.variant)
            } else show('it has seen you.', PRIO.combat, 'hunt')
            ev('hunt:seen-line', 'A')
          }
        }
        else if (playT - lastFarLine > 30) { lastFarLine = playT; show('something, far off, stops.', PRIO.ambient, 'hunt'); ev('hunt:far-line', 'A') }
        else ev('hunt:seen-silent', 'X')
        break
      case 'lost': show('you have lost it. it is still looking.', PRIO.discovery, 'hunt'); ev('hunt:lost', 'A'); break
      case 'alert': if (e.d <= fog) ev('hunt:alert-footfall', 'A'); else ev('hunt:alert-unheard', 'X'); break
      case 'turn': if (!turnSaid) { turnSaid = true; show('it has nowhere to go. it turns.', PRIO.interaction, 'hunt'); ev('hunt:turn', 'A') } break
      case 'turning': if (e.d <= fog && !turningSaid.has(e.id)) { turningSaid.add(e.id); show('it stops. it turns.', PRIO.interaction, 'hunt'); ev('hunt:turning', 'A') } break
      case 'smiler-freeze': if (!has.smilerOnce || !smilerTold) { smilerTold = true; show(SMILER_LINE, PRIO.discovery, 'hunt') } ev('hunt:smiler-freeze', 'A'); break
      case 'hound-windup': if (!houndTold) { houndTold = true; show('it gathers itself. push now.', PRIO.urgent, 'hunt') } ev('hunt:hound-windup', 'A'); break
      case 'hound-pass': if (!passTold) { passTold = true; show('it skids past.', PRIO.interaction, 'hunt') } ev('hunt:hound-pass', 'A'); break
      case 'lurker-hunt': ev('hunt:lurker-hum-duck', 'A'); break
      case 'crawler': sanity = Math.max(0, sanity - 8); show('something takes your ankles.', PRIO.urgent, 'hunt'); ev('hunt:crawler', 'A'); break
      case 'watcher-dispelled': sanity = Math.min(100, sanity + 12); show('it looks away first.', PRIO.interaction, 'hunt'); ev('hunt:watcher-dispelled', 'A'); break
      case 'arc': ev('hunt:arc', 'A'); break
      default: ev('hunt:' + e.kind, 'X')
    }
  }
  // fireEvent: the six hand-wired events and (2.0.4) the data events; the arrival's event is heard, not read
  function fireEvent(id, soundOnly) {
    const kind = soundOnly ? null : 'event'
    const say = (text, prio) => plate(kind, text, prio, false, 'event')
    if (id === 'lights-cascade') { flickTgt = 0.14; flickTimer = 0.7; say('the lights go out ahead of you, one by one. then, slowly, they come back.', PRIO.ambient) }
    else if (id === 'door-slam') say('somewhere behind you, a door slams shut.', PRIO.interaction)
    else if (id === 'hum-stops') say('the hum stops. the silence has a shape. then it resumes, as if something had been listening.', PRIO.ambient)
    else if (id === 'cold-spot') { sanity = Math.max(0, sanity - 4); say('a cold spot. your breath fogs where there is nothing cold enough to fog it.', PRIO.ambient) }
    else if (id === 'footsteps') say('footsteps. not yours. they keep your pace, and stop when you stop.', PRIO.ambient)
    else if (id === 'crosser') say('far down the hall, something crosses the intersection. the hall is empty when you look again.', PRIO.interaction)
    else if (has.fxEvents) { const fx = T.EVT.eventFx(id, evConfig.events); if (fx?.sound) { if (fx.flick) { flickTgt = fx.flick; flickTimer = FX_FLICK_S } say(fx.line, PRIO.ambient) } }
    ev('dread:' + id, 'A', soundOnly ? 'sound-only' : undefined)
  }
  function roomsOf(cx, cy) {
    const k = cx + ',' + cy
    let r = roomCache.get(k)
    if (!r) { r = T.DRS.findRooms(grid.floor, cx, cy).map((rm, i) => { const c = rm.cells; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const q of c) { x0 = Math.min(x0, q.wx); y0 = Math.min(y0, q.wy); x1 = Math.max(x1, q.wx); y1 = Math.max(y1, q.wy) } return { key: k + ':' + i, x0, y0, x1, y1, size: rm.size } }); roomCache.set(k, r) }
    return r
  }
  // the nearest creature by path through the maze (cells), -1 when none within the window: what a heartbeat is checked against
  function nearestPathD() {
    const ents = f.entitySys.getEntities()
    if (!ents.length) return -1
    const field = T.bfs(grid, player.x, player.y, Math.floor(player.x / CHUNK), Math.floor(player.y / CHUNK), 2)
    let best = -1
    for (const e of ents) { const d = field.at(e.x, e.y); if (d >= 0 && (best < 0 || d < best)) best = d }
    return best
  }

  const decorLists = () => ({
    item: f.itemSys.getWorldItems(), scrap: f.decor.getScraps(), machine: f.decor.getMachines(), sight: f.decor.getSights(), npc: f.decor.getNpcs(),
  })
  let lists = null, sightT = 0
  const entEvents = []
  const sightingMinGap = 15

  const maxT = WALK_S
  while (playT < maxT) {
    playT += DT
    // ── movement: cell to cell at walk speed x clutter (collide.clutterAt: 0.55 inside clutter) ──
    const sp = WALK * f.solid.clutterAt(player.x, player.y) * DT
    const dx = tx - player.x, dy = ty - player.y, dd = Math.hypot(dx, dy)
    if (dd <= sp) {
      player.x = tx; player.y = ty
      const cix = Math.floor(tx), ciy = Math.floor(ty)
      const nx = mode === 'seek' ? planSeek(cix, ciy) : nextCellExplore(cix, ciy)
      if (nx) { fromX = tx; fromY = ty; tx = nx.nx + 0.5; ty = nx.ny + 0.5 }
    } else { player.x += dx / dd * sp; player.y += dy / dd * sp }
    // facing turns toward the heading at up to 6 rad/s (a mouse turn), so the cone sweeps rather than snaps
    { const want = Math.atan2(ty - player.y, tx - player.x); let da = want - player.angle; da = Math.atan2(Math.sin(da), Math.cos(da)); const m = 6 * DT; player.angle += Math.max(-m, Math.min(m, da)) }
    aiCtx.playerAngle = player.angle
    const cix = Math.floor(player.x), ciy = Math.floor(player.y)
    if (lastCell === null || lastCell[0] !== cix || lastCell[1] !== ciy) {
      lastCell = [cix, ciy]; cellsWalked++
      visits.set(vkey(cix, ciy), (visits.get(vkey(cix, ciy)) ?? 0) + 1)
      trail.unshift({ x: cix + 0.5, y: ciy + 0.5 }); if (trail.length > 8) trail.length = 8
      const rcx = Math.floor(cix / CHUNK), rcy = Math.floor(ciy / CHUNK)
      for (const rm of roomsOf(rcx, rcy)) if (cix >= rm.x0 && cix <= rm.x1 && ciy >= rm.y0 && ciy <= rm.y1 && !roomsDone.has(rm.key)) { roomsDone.add(rm.key); ev('room:' + rm.size + 'x' + rm.size, 'C') }
      if (firstRun) { const rl = firstRun.onEnter(cix, ciy); if (rl) ev('firstrun:room', 'X') }
    }
    const pcx = Math.floor(player.x / CHUNK), pcy = Math.floor(player.y / CHUNK)
    if (pcx !== pcxWas || pcy !== pcyWas) { chunksSeen.add(pcx + ',' + pcy); pcxWas = pcx; pcyWas = pcy; if (has.dread) f.cache.preload(pcx, pcy); f.decor.update(pcx, pcy); f.itemSys.update(pcx, pcy); lists = decorLists() }
    f.grid.setPlayerChunk(pcx, pcy)
    firstRun?.tick(DT)

    // ── the light ──
    if (playT >= lightNext) toggleLight()
    if (hauntDarkT > 0) hauntDarkT -= DT
    const lit = light && hauntDarkT <= 0
    if (!lit) lightOffS += DT
    aiCtx.flashlight = lit; sanCtx.flashlight = lit

    // footsteps: a noise of 3 every half bob cycle (0.44 s)
    player.bob += 0.12 * DT * 60
    stepAcc += DT
    if (stepAcc >= Math.PI / 7.2) { stepAcc = 0; if (cfg.entities?.enabled) f.entitySys.noise(player.x, player.y, 3) }

    // ── the things ──
    aiCtx.t = playT
    const th = f.entitySys.update(DT, player, pcx, pcy, aiCtx)
    const nEv = f.entitySys.drainEvents(entEvents)
    for (let i = 0; i < nEv; i++) onEntityEvent(entEvents[i])
    if (th.hunted) hunted += DT
    secT += DT
    if (secT >= 1) { secT = 0; maxDisp = Math.max(maxDisp, Math.hypot(player.x - at.x, player.y - at.y)); let nd = Infinity; for (const e of f.entitySys.getEntities()) { const d = Math.hypot(e.x - player.x, e.y - player.y); if (d < nd) nd = d } nearestSeries.push(Number.isFinite(nd) ? +nd.toFixed(1) : null); countSeries.push(f.entitySys.getEntities().length) }
    if (th.gaze) gazeS += DT
    // the reflex a player has: a hostile within 2.4 -> turn to it and tap the ward (ward.js tap: 20 stamina, 0.65 s cooldown)
    wardCd -= DT
    if (cfg.entities?.enabled && th.nearestEntity && th.nearest < 2.4 && wardCd <= 0 && stamina >= 20 && T.HUNT.hostile(th.nearestEntity)) {
      const ne = th.nearestEntity
      player.angle = Math.atan2(ne.y - player.y, ne.x - player.x)
      const r = f.entitySys.ward(player, T.WARD.wardOpts(false))
      f.entitySys.noise(player.x, player.y, 12)
      stamina -= 20; wardCd = 0.65
      ev(r.dispelled ? 'ward:dispel' : r.hit ? 'ward:hit' : 'ward:miss', 'A')
      if (r.dispelled) sanity = Math.min(100, sanity + 10 * r.dispelled)
    }
    stamina = Math.min(100, stamina + 9 * DT)
    // ── HP ──
    if (invuln > 0) invuln -= DT
    if (cfg.entities?.enabled && invuln <= 0 && th.dmg > 0) {
      player.hp -= th.dmg; invuln = 0.7; regenDelay = 6; lastHitT = playT; hits++
      show(th.dmgKind === 'arc' ? 'the current finds you.' : 'it has you.', PRIO.urgent, 'hunt')
      ev('hit:' + th.dmgKind, 'A', Math.round(th.dmg))
    }
    if (regenDelay > 0) regenDelay -= DT
    else if (player.hp < player.maxHp) player.hp = Math.min(player.maxHp, player.hp + 3.5 * DT)
    if (player.hp <= 0) { deaths++; ev('death', 'A'); player.hp = 100 }
    minHp = Math.min(minHp, player.hp)
    // ── dread (2.0.4): its own 4 Hz clock; the field flooded only while something that could count is near in a straight line ──
    if (has.dread && (dreadT -= DT) <= 0) {
      dreadT += DREAD_CLOCK.tick
      const ents = f.entitySys.getEntities()
      const near = creaturesLive && T.DRD.dreadNear(ents, player)
      if (near && (!fieldOn || playT - fieldT >= DREAD_CLOCK.build)) { pathField.build(player.x, player.y, f.cache); fieldT = playT }
      fieldOn = near
      T.DRD.dreadFrom(ents, near ? pathField : null, player, dreadOut)
      if (dreadOut.dread > maxDread) maxDread = dreadOut.dread
      if (dreadOut.dread > 0) lastDreadT = playT
      const tell = teller.tick(DREAD_CLOCK.tick, dreadOut, player)
      if (tell) ev('tell', 'X', tell.variant + '/' + tell.sound + '@' + dreadOut.d)
    }
    // ── tension and the heart (game.js: heartT counts down, a beat each tn.beat while it is finite) ──
    const tn = tension.tick(DT, creaturesLive ? th : null, player.hp, has.dread && creaturesLive ? dreadOut.dread : 0)
    if (tn.level >= 0.15) tensionAudible += DT
    if (tn.just === 'enter') ev('music:hunt', 'A')
    if (tn.close && playT - lastSeenLine > 1.6) { show('it is close.', PRIO.combat, 'hunt'); ev('hunt:close-line', 'A') }
    heartT -= DT
    if (tn.beat < Infinity && heartT <= 0) {
      heartT = tn.beat
      // h: hunted now; dr / dd: the last 4 Hz dread read and its nearest contributor's path cells; since: s since dread was last
      // above 0; lv: tension's level; hl: its level without the dread term (2.0.4 tension.js huntLevel; null before): a beat is
      // dread's own when hl is under the beat floor; pd: the nearest creature by path now (-1: none within the window)
      ev('heartbeat', 'X', { h: th.hunted ? 1 : 0, dr: +dreadOut.dread.toFixed(2), dd: dreadOut.d, since: Number.isFinite(lastDreadT) ? +(playT - lastDreadT).toFixed(2) : null,
        lv: +tn.level.toFixed(2), hl: tn.huntLevel === undefined ? null : +tn.huntLevel.toFixed(2), pd: nearestPathD() })
    }
    // ── sanity (compose-sanity.js) ──
    sanCtx.hunted = th.hunted; sanCtx.gaze = th.gaze; sanCtx.gazeRate = th.gazeRate; sanCtx.dt = DT
    const s = T.SAN.sanityStep(sanCtx)
    sanity = Math.max(0, Math.min(100, sanity + s.delta * DT))
    minSan = Math.min(minSan, sanity); sanSum += sanity; samples++
    // ── the murmurs: a coin (2.0.3) or a bag (2.0.4), through the plate budget, the held exit hint skipped ──
    msgTimer += DT
    if (msgTimer >= msgNext) {
      msgTimer = 0; msgNext = MI[0] + rnd() * (MI[1] - MI[0])
      const m = murmurBag ? murmurs[murmurBag.next()] : murmurs[Math.floor(rnd() * murmurs.length)]
      if (!hintHeld || m !== cfg.exit?.hint) plate('murmur', m, PRIO.ambient, false, 'murmur')
      ev('murmur-pushed', 'X')
    }
    if (plates) { const held = plates.drain(playT); if (held) show(held, PRIO.discovery, heldCls.get(held) ?? 'arrival') }
    // ── Living Atmosphere ──
    const evCanFire = dreadQuietT <= 0
    const id = sched.tick(DT, { level: index, sanity, canFire: evCanFire })
    if (id) { fireEvent(id, has.soundOnly && sched.soundOnly); dreadQuietT = 12 }
    dreadQuietT = Math.max(0, dreadQuietT - DT)
    // ── the hauntings ──
    const hauntCalm = evCanFire && dreadQuietT <= 0 && !th.hunted && th.nearest >= 14 && playT - lastHitT > 20
    const h = hauntCalm ? hauntTr.check(player.x, player.y, f.decor.getHaunts(), true) : null
    if (h) {
      const fx = T.HNT.hauntEffects(h.id, { player, props: f.decor.getProps(), isOpen: (x, y) => grid.floor(Math.floor(x), Math.floor(y)), trail: trail.slice(0, 6) })
      if (fx) {
        hauntTr.fire(h.key); dreadQuietT = 20
        plate('haunt', fx.message, PRIO.discovery, false, 'haunt')
        sanity = Math.max(0, Math.min(100, sanity + fx.sanity)); ev('haunt:' + h.id, 'A')
        if (fx.flashlightOff && !LEGACY) hauntDarkT = fx.flashlightOff
      }
      else ev('haunt-null:' + h.id, 'X')
    }
    // ── flicker ──
    fk.value = flicker; fk.target = flickTgt; fk.timer = flickTimer
    T.GQ.stepFlicker(fk, DT, cfg.flicker, rnd, false, false)
    flicker = fk.value; flickTgt = fk.target; flickTimer = fk.timer
    const dip = flicker < 0.8
    if (dip && !dipWas) ev('flicker-dip', 'C')
    dipWas = dip
    // ── the distant swell ──
    distantT += DT
    if (distantT >= distantNext) { distantT = 0; distantNext = DI[0] + rnd() * (DI[1] - DI[0]); ev('distant-swell', 'C') }
    // ── the held exit hint and the setting's line (2.0.4), read off the compass the HUD would show ──
    if (hintHeld && cState.pullShown) { hintHeld = false; plate('arrival', cfg.exit.hint, PRIO.discovery, true, 'arrival'); heldCls.set(cfg.exit.hint, 'arrival') }
    const lostWaits = has.lostWait && (playT < T.CMP.LOST_AFTER_S || floorHinted || (!!firstRun && firstRun.step() > 0))
    if (has.lostLine && index === 0 && !lostSaid && !lostWaits && !cState.known && !(cState.pullShown && cState.fb)) {
      if (plate('murmur', T.LV.LOST_LINE, PRIO.discovery, false, 'lost')) lostSaid = true
    }
    // ── the message line ──
    const mq = msgQ.tick(DT)
    if (mq && mq.show) linesShown.push({ t: +playT.toFixed(2), text: mq.text, cls: clsOf.get(mq.text) ?? 'other' })

    // ── sightings, every 0.1 s ──
    sightT += DT
    if (sightT >= 0.1) {
      sightT = 0
      const ents = f.entitySys.getEntities()
      let n = T.SPR.visibleWays(player, ents, grid.floor, fog, HF, out)
      for (let i = 0; i < n; i++) {
        const e = out[i]
        const last = seenEnt.get(e.id)
        if (last === undefined) ev('creature-sighted', 'A', e.variant)
        else if (playT - last > sightingMinGap) ev('creature-again', 'A', e.variant)
        seenEnt.set(e.id, playT)
      }
      // ways: pinned at 1.35x the fog (game.js pinSeen)
      const ways = [...f.decor.getExits(), ...f.decor.getStairs()]
      n = T.SPR.visibleWays(player, ways, grid.floor, fog * 1.35, HF, out)
      for (let i = 0; i < n; i++) {
        const w = out[i]
        const k = 'w:' + w.key + ':' + w.kind
        if (!seenKeys.has(k)) { seenKeys.add(k); ev('find:' + (w.kind === 'down' || w.kind === 'ring' ? 'exit' : w.kind === 'up' ? 'stair-up' : w.kind), 'B') }
        knownWays.set(w.key + ':' + w.kind, { ...w, key: w.key + ':' + w.kind })
      }
      for (const [kind, list] of Object.entries(lists)) {
        n = T.SPR.visibleWays(player, list, grid.floor, fog, HF, out)
        for (let i = 0; i < n; i++) {
          const r = out[i], k = kind + ':' + r.key
          if (seenKeys.has(k)) continue
          seenKeys.add(k); ev('find:' + kind, 'B', kind === 'item' ? r.type : kind === 'sight' ? r.type : undefined)
        }
      }
      const props = f.decor.getProps()
      n = T.SPR.visibleWays(player, props, grid.floor, Math.min(8, fog), HF, out)
      for (let i = 0; i < n; i++) {
        const r = out[i], k = 'p:' + r.key
        if (seenKeys.has(k)) continue
        seenKeys.add(k); ev(T.CON.CONTAINER_TYPES[r.type] !== undefined ? 'find:container' : 'find:prop', 'C', r.type)
      }
      for (let ddy = -1; ddy <= 1; ddy++) for (let ddx = -1; ddx <= 1; ddx++) {
        const cx = pcx + ddx, cy = pcy + ddy
        if (!T.chunkHasPresence(cx, cy)) continue
        const mx = cx * CHUNK + CHUNK / 2, my = cy * CHUNK + CHUNK / 2
        if ((player.x - mx) ** 2 + (player.y - my) ** 2 < 4 && !seenKeys.has('pr:' + cx + ',' + cy)) { seenKeys.add('pr:' + cx + ',' + cy); ev('presence', 'B') }
      }
      // ── the seek walker reads what it passes (2.0.4: a page read or a soul's word is the floor's hint; the first run's note and soul) ──
      if (mode === 'seek' && has.pull && !LEGACY) {
        const sc = f.decor.nearestScrap(player.x, player.y, 1.5)
        if (sc && !readKeys.has(sc.key)) { readKeys.add(sc.key); if (sc.firstrun) firstRun?.onRead('firstrun'); else if (!sc.form) floorHinted = true; ev('read', 'X') }
        const np = f.decor.nearestNpc(player.x, player.y, 1.5)
        if (np && !spoke.has(np.key)) { spoke.add(np.key); floorHinted = true; firstRun?.onSoul(np.key); ev('speak', 'X') }
      }
      if (newCompass) compassNow()
      // ── the seek walker: arrived at a way? ──
      if (mode === 'seek' && reachedAt === null) {
        const w = f.decor.nearestWay(player.x, player.y, 1.6)
        if (w) {
          if (leadsOn(w.kind)) { reachedAt = playT; reachedKind = w.kind; ev('reached:' + w.kind, 'B'); break }
          const k = w.key + ':' + w.kind
          if (!declined.has(k) && !declined.has(w.key)) {
            declined.add(k); declined.add(w.key); misled++
            if (faintKey === k) sentUp++
            ev('compass-misled:' + w.kind, 'X', faintKey === k ? 'sent' : 'wandered')
          }
        }
      }
    }
  }
  return {
    index, seed, mode, seconds: +playT.toFixed(2), cellsWalked, events, linesShown,
    reachedAt: reachedAt === null ? null : +reachedAt.toFixed(2), reachedKind, misled, sentUp, pullAt, hinted: floorHinted,
    firstRunStep: firstRun ? firstRun.step() : null, lightOffS: +lightOffS.toFixed(1), maxDread: +maxDread.toFixed(3),
    huntedS: +hunted.toFixed(1), gazeS: +gazeS.toFixed(1), tensionAudibleS: +tensionAudible.toFixed(1), hits, deaths, minHp: Math.round(minHp),
    minSanity: Math.round(minSan), meanSanity: Math.round(sanSum / Math.max(1, samples)), endSanity: Math.round(sanity),
    creaturesSpawnedAtEnd: f.entitySys.getEntities().length, distinctCells: visits.size, chunksVisited: chunksSeen.size, maxDisplacement: +maxDisp.toFixed(1),
    nearestCreatureEachSecond: nearestSeries, creaturesInWindowEachSecond: countSeries, spawnAt: { x: +at.x.toFixed(1), y: +at.y.toFixed(1) },
  }
}

const all = []
const t0 = Date.now()
process.stderr.write(`[walks] ${T.dir} (package ${T.version}) wiring ${JSON.stringify(has)}\n`)
for (const index of FLOORS) {
  for (const seed of SEEDS) for (const mode of (VARIANT?.modes ?? MODES)) all.push(runWalk(index, seed, mode))
  process.stderr.write(`[walks] L${index} done (${((Date.now() - t0) / 1000).toFixed(1)} s)\n`)
}
mkdirSync(path.dirname(OUTFILE), { recursive: true })
writeFileSync(OUTFILE, JSON.stringify({ src: T.dir, version: T.version, wiring: has, walkSeconds: WALK_S, seeds: SEEDS, lightOff: LIGHT_OFF, legacy: LEGACY, variant: VARIANT, floors: FLOORS, runs: all }))
process.stderr.write(`[walks] wrote ${OUTFILE}: ${all.length} walks\n`)
