// bot.js — an in-page "new player" (injected by session.cjs into an INSTRUMENTED SCRATCH COPY of src/renderer, never the tree): runs
// once per game frame (a rAF wrapper), reads only what the screen would tell a player (the prompt plate, the compass line, what is in
// view through the raycaster's line of sight + view cone, the fog distance) plus the grid for its footing (a player sees corridors; the
// bot uses the grid to know where it can walk). It never presses a key a player could not.
// Exposes globalThis.__bot = { status(), drain(), summary(), audio() }. Config: globalThis.__botCfg = { seed, takeWays, followCompass }.
//   takeWays       it takes a way when it stands at one (a session that leaves the floor)
//   followCompass  with nothing in view worth walking to, it follows the compass arrow when the HUD shows one (the exact arrow to a way
//                  it has seen, or the faint pull) and explores otherwise: a player who follows the thread
(async () => {
  const P = globalThis.__pt
  if (!P) throw new Error('no __pt hook (run the bot on a copy instrumented by tools/pacing/bot/patch.mjs)')
  const cfgIn = globalThis.__botCfg || {}
  const { lineOfSight } = await import('./raycaster.js')
  const { CONTAINER_TYPES } = await import('./containers.js')
  const { hostile } = await import('./hunt.js')
  const { FOV } = await import('./gfx-frame.js')
  const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖']   // compass.js EXIT_DIRS, clockwise from straight ahead

  // ── a seeded rng so a run is reproducible ──
  let rs = (cfgIn.seed || 12345) >>> 0
  const rnd = () => { rs = (rs + 0x6D2B79F5) >>> 0; let t = rs; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }

  const LOG = []
  const T = () => +P.playT.toFixed(2)
  const log = (k, d) => LOG.push([T(), k, d])
  globalThis.__ptEv = (k, d) => log(k, d)

  // ── the screen: every text change on the HUD / cards ──
  const WATCH = ['msg', 'item-hint', 'presence-hint', 'hud', 'exit-compass', 'hotbar', 'note-text', 'note-foot', 'map-foot', 'chat-log', 'wish-prompt', 'wish-response', 'note-card', 'map-card', 'wish-dialog']
  const lastSeen = {}
  const visOf = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return 0; o *= parseFloat(cs.opacity) } return o }
  // the black veil a travel or a death draws (#fade, game.js createFader): what stacks under it (the base #msg, the HUD) is dimmed by it,
  // so a line the queue puts up while the screen is black is no plate. Cards stacked over it (the map, a note) are not dimmed. A text
  // only the veil hides logs '(veiled)': stats.mjs reads the same text given back after it as the same plate going on
  const fadeEl = document.getElementById('fade')
  const zOf = (el) => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const z = parseInt(getComputedStyle(e).zIndex, 10); if (Number.isFinite(z)) return z } return 0 }
  const veilZ = fadeEl ? zOf(fadeEl) : 0
  function sampleDom() {
    const veil = fadeEl ? (parseFloat(getComputedStyle(fadeEl).opacity) || 0) : 0
    for (const id of WATCH) {
      const el = document.getElementById(id); if (!el) continue
      const own = visOf(el), v = own * (veil > 0 && zOf(el) < veilZ ? 1 - veil : 1) > 0.15
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400)
      const key = v ? txt : own > 0.15 ? '(veiled)' : '(hidden)'
      if (lastSeen[id] !== key) { lastSeen[id] = key; log('dom:' + id, key) }
    }
  }

  // ── keys ──
  const held = new Set()
  const send = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true }))
  function setKey(code, on) { if (on && !held.has(code)) { held.add(code); send('keydown', code) } else if (!on && held.has(code)) { held.delete(code); send('keyup', code) } }
  const taps = []   // [code, framesLeft]
  function tap(code, why) { send('keydown', code); taps.push([code, 2]); log('key', code + (why ? ' · ' + why : '')) }
  function releaseMove() { for (const c of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight', 'ShiftLeft']) setKey(c, false) }

  const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a }
  const cellKey = (x, y) => x + ',' + y
  const visits = new Map()
  const blocked = new Map()   // cell -> penalty (furniture the grid does not know)
  const done = new Set()      // interest keys handled
  const seen = new Map()      // key -> first-seen t (things that came into view)
  const seenKinds = {}
  let lvlIdx = -1

  function floor(ix, iy) { try { return P.level.grid.floor(ix, iy) } catch { return false } }

  // what is on screen right now: decor + items + creatures within the fog, in the view cone, with a clear line
  function interests() {
    const L = P.level, d = L.decor, out = []
    const push = (kind, r, key) => out.push({ kind, x: r.x, y: r.y, key: kind + ':' + (key ?? r.key ?? (r.x.toFixed(1) + ',' + r.y.toFixed(1))), rec: r })
    for (const it of P.itemSys.getWorldItems()) push('item', it, it.key)
    for (const s of d.getScraps()) push(s.form ? 'form' : 'scrap', s)
    for (const m of d.getMachines()) push('machine', m)
    for (const n of d.getNpcs()) push('soul', n)
    for (const e of d.getExits()) push('way', e)
    for (const s of d.getStairs()) push('way', s, s.key ?? (s.kind + s.x + ',' + s.y))
    for (const s of d.getSights()) push('sight:' + (s.type || ''), s)
    for (const p of d.getProps()) push(CONTAINER_TYPES[p.type] !== undefined ? 'box' : 'prop:' + p.type, p, p.key)
    for (const e of L.entitySys.getEntities()) out.push({ kind: 'thing:' + e.variant, x: e.x, y: e.y, key: 'thing:' + (e.id ?? e.variant), rec: e, ent: true })
    return out
  }
  function inView(o, range) {
    const px = P.player.x, py = P.player.y, dx = o.x - px, dy = o.y - py, dd = Math.hypot(dx, dy)
    if (dd > range) return false
    const a = Math.abs(wrap(Math.atan2(dy, dx) - P.player.angle))
    if (a > FOV / 2 + 0.05) return false
    return lineOfSight(px, py, o.x, o.y, floor)
  }

  // ── BFS over the grid ──
  function bfs(maxD, targetFn) {
    const sx = Math.floor(P.player.x), sy = Math.floor(P.player.y)
    const prev = new Map(), dist = new Map(), q = [[sx, sy]]
    dist.set(cellKey(sx, sy), 0)
    let found = null
    while (q.length) {
      const [x, y] = q.shift(); const k = cellKey(x, y), dk = dist.get(k)
      if (targetFn && targetFn(x, y, dk)) { found = [x, y]; break }
      if (dk >= maxD) continue
      for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + ax, ny = y + ay, nk = cellKey(nx, ny)
        if (dist.has(nk) || !floor(nx, ny)) continue
        if ((blocked.get(nk) || 0) > 2) continue
        dist.set(nk, dk + 1); prev.set(nk, k); q.push([nx, ny])
      }
    }
    return { prev, dist, found }
  }
  function pathTo(prev, x, y) {
    const out = []; let k = cellKey(x, y)
    while (k) { const [a, b] = k.split(',').map(Number); out.push({ x: a + 0.5, y: b + 0.5 }); k = prev.get(k) }
    return out.reverse()
  }

  let path = null, goal = null, goalT = 0, mode = 'explore', intent = ''
  function planExplore() {
    const { prev, dist } = bfs(34)
    let best = null, bs = -1e9
    const ha = P.player.angle
    for (const [k, d] of dist) {
      if (d < 5) continue
      const [x, y] = k.split(',').map(Number)
      const v = visits.get(k) || 0
      const ang = Math.atan2(y + 0.5 - P.player.y, x + 0.5 - P.player.x)
      const fwd = Math.cos(wrap(ang - ha))
      // novelty first, then a lean to keep going the way you face (a player walks on, turns at a junction), a little chance
      const s = -v * 4 + Math.min(d, 22) * 0.35 + fwd * 2.2 + rnd() * 2.5 - (blocked.get(k) || 0) * 3
      if (s > bs) { bs = s; best = [x, y] }
    }
    if (!best) return false
    path = pathTo(prev, best[0], best[1]); goal = { kind: 'explore', x: best[0] + 0.5, y: best[1] + 0.5 }; goalT = T()
    intent = 'explore toward ' + best.join(',') + ' (' + path.length + ' steps)'
    return true
  }
  // the compass line as the HUD shows it: the first line's arrow, unless that line is only 'the way you came' -> a world heading, or null
  function compassHeading() {
    const el = document.getElementById('exit-compass')
    const line = el ? (el.textContent || '').split('\n')[0].trim() : ''
    if (!line || /the way you came/.test(line)) return null
    const i = ARROWS.indexOf(line[0])
    return i < 0 ? null : { heading: P.player.angle + i * Math.PI / 4, text: line }
  }
  let lastCompassLog = ''
  function planCompass() {
    const c = compassHeading()
    if (!c) return false
    const { prev, dist } = bfs(34)
    let best = null, bs = -1e9
    for (const [k, d] of dist) {
      if (d < 4) continue
      const [x, y] = k.split(',').map(Number)
      const ang = Math.atan2(y + 0.5 - P.player.y, x + 0.5 - P.player.x)
      const s = Math.cos(wrap(ang - c.heading)) * Math.min(d, 18) - (visits.get(k) || 0) * 3 - (blocked.get(k) || 0) * 3 + rnd() * 1.5
      if (s > bs) { bs = s; best = [x, y] }
    }
    if (!best) return false
    path = pathTo(prev, best[0], best[1]); goal = { kind: 'compass', x: best[0] + 0.5, y: best[1] + 0.5 }; goalT = T()
    intent = 'follows the compass: ' + c.text
    if (c.text !== lastCompassLog) { lastCompassLog = c.text; log('bot', 'follows the compass: "' + c.text + '"') }
    return true
  }
  function planTo(o) {
    const tx = Math.floor(o.x), ty = Math.floor(o.y)
    const { prev, found } = bfs(30, (x, y) => Math.abs(x - tx) + Math.abs(y - ty) <= 1 && Math.hypot(x + 0.5 - o.x, y + 0.5 - o.y) < 1.6)
    if (!found) return false
    path = pathTo(prev, found[0], found[1]); path.push({ x: o.x, y: o.y })
    goal = { kind: o.kind, key: o.key, x: o.x, y: o.y }; goalT = T()
    intent = 'walk to ' + o.kind + ' (' + path.length + ' steps)'
    return true
  }

  // ── timers for the "try the buttons" moments a new player has ──
  const sched = []   // [t, fn, label]
  const at = (t, label, fn) => sched.push([t, fn, label])
  let t0 = null
  const lv = () => P.level.index
  function setupSchedule() {
    const L = lv()
    at(20, 'light off (try l)', () => { if (P.flashlight) tap('KeyL', 'try the light') })
    at(27, 'light on', () => { if (!P.flashlight) tap('KeyL', 'light back on') })
    at(48, 'open the map', () => { if (!P.mapOpen) tap('Tab', 'look at the map') })
    at(53, 'fold the map', () => { if (P.mapOpen) tap('Tab', 'fold the map') })
    at(140, 'open the map', () => { if (!P.mapOpen) tap('Tab', 'look at the map') })
    at(145, 'fold the map', () => { if (P.mapOpen) tap('Tab', 'fold the map') })
    if (L >= 1) at(75, 'whistle', () => tap('KeyC', 'call out'))
    if (L >= 2) {
      at(35, 'glowstick', () => useType('glowstick', 'crack a glowstick'))
      at(60, 'radio on', () => useType('radio', 'turn the radio on'))
      at(115, 'radio off', () => useType('radio', 'turn the radio off'))
      at(100, 'light off in the dark', () => { if (P.flashlight) tap('KeyL', 'go dark') })
      at(108, 'light on', () => { if (!P.flashlight) tap('KeyL', 'light back on') })
    }
    if (L === 0) at(95, 'take a photo', () => useType('polaroid', 'take a photo of the hall'))
  }
  let pendingUse = null
  function useType(type, why) {
    const inv = P.itemSys.inventory
    const i = inv.findIndex((it) => it && it.type === type)
    if (i < 0) { log('bot', 'wanted ' + type + ' but has none'); return false }
    pendingUse = { slot: i, why, step: 0 }
    return true
  }

  // ── per-frame ──
  let lastPos = null, lastPosT = 0, stuckN = 0, unstickUntil = 0, unstickKey = null
  let lookUntil = 0, nextLook = 2.5, sprintSeg = false, nextSprintRoll = 0
  let readUntil = 0, dialogUntil = 0, searchHoldUntil = 0, interactCd = 0, wardCd = 0, photoCd = 0, fleeUntil = 0
  let lastStatusT = -1, lastSec = -1
  const visiblePerWin = new Map()   // window index -> Set of kinds in view
  const hintAtWayLogged = new Set()
  let presenceCd = 6, lastE = null, lastS = null, prevSteerT = -1

  function frame() {
    for (let i = taps.length - 1; i >= 0; i--) { if (--taps[i][1] <= 0) { send('keyup', taps[i][0]); taps.splice(i, 1) } }
    if (!P.level) return
    const t = P.playT
    if (lv() !== lvlIdx) { lvlIdx = lv(); log('level', P.level.cfg.levelName); visits.clear(); blocked.clear(); path = null; goal = null }
    if (t0 === null) { t0 = t; setupSchedule() }
    sampleDom()
    const px = P.player.x, py = P.player.y
    const ck = cellKey(Math.floor(px), Math.floor(py))
    const sec = Math.floor(t)
    if (sec !== lastSec) { lastSec = sec; visits.set(ck, (visits.get(ck) || 0) + 1) }

    // what is in view (fog-limited), for the emptiness count
    const fogD = (P.level.cfg.fogDistance || 14) * 1.05
    const all = interests()
    const win = Math.floor(t / 6)
    let vis = visiblePerWin.get(win); if (!vis) { vis = new Set(); visiblePerWin.set(win, vis) }
    const inSight = []
    for (const o of all) {
      if (!inView(o, o.kind === 'way' ? fogD * 1.6 : fogD)) continue
      inSight.push(o); vis.add(o.kind)
      if (!seen.has(o.key)) { seen.set(o.key, +t.toFixed(1)); seenKinds[o.kind] = (seenKinds[o.kind] || 0) + 1; log('seen', o.kind + ' @' + Math.hypot(o.x - px, o.y - py).toFixed(1)) }
    }
    if (t - lastStatusT >= 1) {
      lastStatusT = t
      const th = P.level.entitySys.getThreat()
      const ents = P.level.entitySys.getEntities()
      let nearest = Infinity, nearestKind = null, nearestAi = null
      for (const e of ents) { const dd = Math.hypot(e.x - px, e.y - py); if (dd < nearest) { nearest = dd; nearestKind = e.variant; nearestAi = e.ai } }
      log('tick', { x: +px.toFixed(2), y: +py.toFixed(2), a: +P.player.angle.toFixed(2), hp: Math.round(P.player.hp), san: Math.round(P.sanity), st: Math.round(P.stamina),
        lvl: lv(), cells: visits.size, ents: ents.length, near: nearest === Infinity ? null : +nearest.toFixed(1), nearKind: nearestKind, nearAi: nearestAi, hunted: !!th.hunted,
        light: P.flashlight, dread: P.dread == null ? null : +P.dread.toFixed(2), inv: P.itemSys.inventory.map((i) => i.type).join('|'), intent, mode, view: inSight.length })
    }

    // modals first: a page is read, the presence's box is closed unsent, the map folded
    if (P.noteOpen) {
      releaseMove()
      if (!readUntil) { readUntil = t + 4 + rnd() * 2; log('bot', 'reading the card') }
      if (t > readUntil) { tap('Escape', 'put the page back'); readUntil = 0 }
      return
    } else readUntil = 0
    if (P.dialogOpen) {
      releaseMove()
      if (!dialogUntil) { dialogUntil = t + 3; log('bot', 'the presence box is open: closing it unsent') }
      if (t > dialogUntil) { tap('Escape', 'close the wish box, nothing typed'); dialogUntil = 0 }
      return
    } else dialogUntil = 0
    if (P.transitioning) { releaseMove(); return }
    if (P.searchT > 0 || t < searchHoldUntil) { releaseMove(); intent = 'holding still at a drawer'; return }

    if (t - t0 < 2.5) { releaseMove(); intent = 'takes in the screen'; return }
    // scheduled "try a key" moments
    for (let i = sched.length - 1; i >= 0; i--) { if (t - t0 >= sched[i][0]) { const s = sched.splice(i, 1)[0]; log('bot', 'scheduled: ' + s[2]); try { s[1]() } catch (e) { log('bot', 'sched err ' + e) } } }
    if (pendingUse) {
      releaseMove()
      if (pendingUse.step === 0) { tap('Digit' + (pendingUse.slot + 1), 'select slot'); pendingUse.step = 1; pendingUse.t = t; return }
      if (pendingUse.step === 1 && t - pendingUse.t > 0.25) { tap('KeyQ', pendingUse.why); pendingUse.step = 2; pendingUse.t = t; return }
      if (pendingUse.step === 2 && t - pendingUse.t > 0.8) pendingUse = null
      return
    }

    // threats: a hostile thing close -> face it and ward; low hp -> run
    const ents = P.level.entitySys.getEntities()
    let foe = null, fd = Infinity
    for (const e of ents) { if (!hostile(e)) continue; const dd = Math.hypot(e.x - px, e.y - py); if (dd < fd) { fd = dd; foe = e } }
    if (foe && fd < 5.5 && lineOfSight(px, py, foe.x, foe.y, floor)) {
      const want = Math.atan2(foe.y - py, foe.x - px), err = wrap(want - P.player.angle)
      if (P.player.hp < 40 && t > fleeUntil) { fleeUntil = t + 6; log('bot', 'hp low: running from ' + foe.variant); path = null; mode = 'flee' }
      if (mode !== 'flee') {
        setKey('KeyW', false); setKey('ShiftLeft', false)
        setKey('ArrowLeft', err < -0.08); setKey('ArrowRight', err > 0.08)
        intent = 'facing the ' + foe.variant + ' (' + fd.toFixed(1) + ')'
        if (Math.abs(err) < 0.35 && t > wardCd) { wardCd = t + 1.4; tap('Space', 'ward the ' + foe.variant) }
        if (Math.abs(err) < 0.3 && t > photoCd && P.itemSys.inventory.some((i) => i.type === 'polaroid') && rnd() < 0.02) { photoCd = t + 30; useType('polaroid', 'flash the ' + foe.variant) }
        return
      }
    }
    if (mode === 'flee' && t > fleeUntil) mode = 'explore'

    // the prompt plate: what f / e would do here
    const hintEl = document.getElementById('item-hint'), presEl = document.getElementById('presence-hint')
    const hint = hintEl && hintEl.style.opacity === '1' ? hintEl.textContent : ''
    const pres = presEl && parseFloat(presEl.style.opacity || '0') > 0.5
    if (t > interactCd) {
      const here = Math.floor(px) + ',' + Math.floor(py)
      if (pres && t > presenceCd) { presenceCd = t + 90; interactCd = t + 1; releaseMove(); tap('KeyE', 'speak to the presence'); return }
      if (/^f · (take|draw)/.test(hint) && !/hands are full/.test(lastSeen['msg'] || '')) {
        const k = 'f:' + hint + ':' + here
        if (!done.has(k)) { done.add(k); interactCd = t + 0.8; releaseMove(); tap('KeyF', hint); if (goal) done.add(goal.key); path = null; goal = null; return }
      }
      if (/^f · search/.test(hint)) {
        const k = 'search:' + here
        if (!done.has(k) && !(lastS && lastS.hint === hint && Math.hypot(px - lastS.x, py - lastS.y) < 1.2)) { lastS = { hint, x: px, y: py }; done.add(k); interactCd = t + 1.5; releaseMove(); tap('KeyF', hint); searchHoldUntil = t + 1.3; if (goal) done.add(goal.key); path = null; goal = null; return }
      }
      if (/^e · (read|speak)/.test(hint)) {
        // which page or soul the prompt is for: the nearest one (two pages a few steps apart are two pages); without one, the old
        // guard (the same prompt again close by or soon is the same thing)
        const list = /^e · read/.test(hint) ? P.level.decor.getScraps() : P.level.decor.getNpcs()
        let rec = null, rd = 2.4
        for (const r of list) { const d = Math.hypot(r.x - px, r.y - py); if (d < rd) { rd = d; rec = r } }
        const rk = rec ? 'e:' + (rec.key ?? rec.x + ',' + rec.y) : null
        const again = rk ? done.has(rk) : lastE && lastE.hint === hint && (Math.hypot(px - lastE.x, py - lastE.y) < 4 || t - lastE.t < 20)
        if (!again) { if (rk) done.add(rk); lastE = { hint, x: px, y: py, t }; interactCd = t + 1; releaseMove(); tap('KeyE', hint); if (goal) done.add(goal.key); path = null; goal = null; return }
      }
      if (/^f · /.test(hint) && !/take|draw|search/.test(hint)) {
        const k = 'way:' + here
        if (!hintAtWayLogged.has(k)) { hintAtWayLogged.add(k); log('bot', 'standing at a way: "' + hint + '"' + (cfgIn.takeWays ? ' -> taking it' : ' -> not taking it (session stays on this floor)')) }
        if (cfgIn.takeWays && !done.has(k)) { done.add(k); releaseMove(); tap('KeyF', hint); return }
        if (goal && goal.kind === 'way') { done.add(goal.key); path = null; goal = null }
      }
    }

    // look around now and then (stand, turn a full circle)
    if (t - t0 >= nextLook && mode !== 'flee') { lookUntil = t + 2.65; nextLook = t - t0 + 28 + rnd() * 14; log('bot', 'stops and looks around') }
    if (t < lookUntil) { setKey('KeyW', false); setKey('ShiftLeft', false); setKey('ArrowLeft', false); setKey('ArrowRight', true); intent = 'looking around'; return }

    // pick a goal: something in view a player would walk up to, else the compass (when it follows one), else the unexplored
    const wantable = (o) => !done.has(o.key) && (o.kind === 'item' || o.kind === 'scrap' || o.kind === 'form' || o.kind === 'soul' || (o.kind === 'machine' && !(P.vended && P.vended.has(o.rec.key))) ||
      (o.kind === 'box' && !(P.searchLog && P.searchLog.isSearched && P.searchLog.isSearched(o.rec.key))) || o.kind === 'way' || o.kind.startsWith('sight'))
    const roaming = !goal || goal.kind === 'explore' || goal.kind === 'compass'
    if (mode !== 'flee' && roaming) {
      let best = null, bd = Infinity
      for (const o of inSight) { if (!wantable(o)) continue; const dd = Math.hypot(o.x - px, o.y - py) + (o.kind === 'box' ? 3 : 0) + (o.kind.startsWith('sight') ? 2 : 0); if (dd < bd) { bd = dd; best = o } }
      if (best && planTo(best)) log('bot', 'notices a ' + best.kind + ' ' + bd.toFixed(1) + ' away and walks over')
      else if (best) done.add(best.key)
    }
    if (goal && goal.kind !== 'explore' && goal.kind !== 'compass' && T() - goalT > 12) { log('bot', 'gives up on the ' + goal.kind); done.add(goal.key); path = null; goal = null }
    if (goal && goal.kind !== 'explore' && goal.kind !== 'compass' && Math.hypot(goal.x - px, goal.y - py) < 0.9 && !hint && !pres) { if (T() - goalT > 3) { done.add(goal.key); log('bot', 'reached the ' + goal.kind + ': no prompt here'); path = null; goal = null } }
    if (mode === 'flee' && !path) {
      const { prev, dist } = bfs(30); let best = null, bs = -1
      for (const [k, d] of dist) { const [x, y] = k.split(',').map(Number); const s = foe ? Math.hypot(x - foe.x, y - foe.y) : d; if (s > bs) { bs = s; best = [x, y] } }
      if (best) { path = pathTo(prev, best[0], best[1]); goal = { kind: 'explore', x: best[0] + 0.5, y: best[1] + 0.5 }; goalT = T(); intent = 'running away' }
    }
    const follow = !!cfgIn.followCompass && mode !== 'flee'
    let replan = !path || !path.length
    if (goal && (goal.kind === 'explore' || goal.kind === 'compass') && (Math.hypot(goal.x - px, goal.y - py) < 1 || T() - goalT > (goal.kind === 'compass' ? 4 : 14))) replan = true
    if (follow && goal && goal.kind === 'explore' && mode !== 'flee' && compassHeading()) replan = true   // the arrow just came up
    if (replan) { if (!(follow && planCompass()) && !planExplore()) { setKey('ArrowRight', true); return } }

    // steer along the path: aim at the farthest node within 3.5 cells you can see straight to
    while (path.length > 1 && Math.hypot(path[0].x - px, path[0].y - py) < 0.55) path.shift()
    if (t - prevSteerT > 0.25) { lastPos = null }   // a pause (reading, looking, a drawer) is not being stuck
    prevSteerT = t
    const losWide = (bx, by) => { const dx = bx - px, dy = by - py, L = Math.hypot(dx, dy) || 1, ox = -dy / L * 0.28, oy = dx / L * 0.28
      return lineOfSight(px, py, bx, by, floor) && lineOfSight(px + ox, py + oy, bx + ox, by + oy, floor) && lineOfSight(px - ox, py - oy, bx - ox, by - oy, floor) }
    let aim = path[0]
    for (let i = 0; i < path.length && i < 6; i++) { const n = path[i]; if (Math.hypot(n.x - px, n.y - py) > 3.5) break; if (losWide(n.x, n.y)) aim = n }
    const want = Math.atan2(aim.y - py, aim.x - px), err = wrap(want - P.player.angle)
    if (t < unstickUntil) { setKey('KeyW', false); setKey(unstickKey, true); return } else if (unstickKey) { setKey(unstickKey, false); setKey('KeyS', false); unstickKey = null }
    setKey('ArrowLeft', err < -0.07); setKey('ArrowRight', err > 0.07)
    setKey('KeyW', Math.abs(err) < 0.55)
    // sprint on a long straight run now and then
    if (t > nextSprintRoll) { nextSprintRoll = t + 4; sprintSeg = (mode === 'flee') || (path.length > 9 && rnd() < 0.3 && P.stamina > 55); if (sprintSeg) log('bot', mode === 'flee' ? 'sprints away' : 'breaks into a run') }
    setKey('ShiftLeft', sprintSeg && Math.abs(err) < 0.3 && P.stamina > 8 && !P.mapOpen)
    // stuck: barely moved in 1.8 s with W held
    if (!lastPos || t - lastPosT > 1.8) {
      if (lastPos && Math.hypot(px - lastPos[0], py - lastPos[1]) < 0.3) {
        stuckN++; const nk = cellKey(Math.floor(aim.x), Math.floor(aim.y)); blocked.set(nk, (blocked.get(nk) || 0) + 1.5)
        log('bot', 'stuck (no progress for 1.8 s) - backing off'); path = null; if (goal && goal.kind !== 'explore' && goal.kind !== 'compass' && stuckN % 2 === 0) { done.add(goal.key); goal = null }
        unstickKey = rnd() < 0.5 ? 'KeyA' : 'KeyD'; setKey('KeyS', true); unstickUntil = t + 0.5
      }
      lastPos = [px, py]; lastPosT = t
    }
  }

  // run once per game frame, before the game's own loop callback
  const orig = window.requestAnimationFrame.bind(window)
  let lastTs = -1
  window.requestAnimationFrame = (cb) => orig((ts) => { if (ts !== lastTs) { lastTs = ts; try { frame() } catch (e) { log('boterr', String(e && e.stack || e).slice(0, 300)) } } cb(ts) })
  globalThis.__bot = {
    status: () => ({ t: P.playT, lvl: P.level ? P.level.index : null, n: LOG.length }),
    drain: () => LOG.splice(0, LOG.length),
    summary: () => ({ seenKinds, seenCount: seen.size, cells: visits.size, windows: [...visiblePerWin.entries()].map(([w, s]) => [w, [...s]]), audio: globalThis.__ptAudioCount || {} }),
    audio: () => (globalThis.__ptAudio || []).splice(0),
  }
  log('bot', 'ready on ' + (P.level ? P.level.cfg.levelName : '?'))
})()
