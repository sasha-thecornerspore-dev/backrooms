// src/net/client.js — multiplayer client.
// Speaks one small JSON protocol that both the bundled Node server (server/index.js) and the Cloudflare Durable-Object relay
// (relay/relay.js) understand:
//   → join {roomId, worldSeed?, name}   → pos {x, y, angle, hp}   → chat {text}   → typing {on}
//   → ev {kind, payload, keep?, drop?}
//   ← welcome {playerId, worldSeed, roomId, first?}   ← players {list: [{id, x, y, angle, name, hp}]}
//   ← joined / left {id, name}   ← chat {id, name, text}   ← typing {id, name, on}
//   ← ev {id, name, kind, payload, t, replay?}
//   ← a close with code FLOOD_CLOSE (4029, reason 'too fast'): the room shut this socket for sending faster than it allows. Never retried
// Unknown message types are ignored, so an old client rides a new server and a new client rides an old one (no 'ev', no welcome.first,
// no flood close) with no error.
// join.worldSeed is whatever the caller hands connect(): index.html hands it a pin's neighbourhood seed (anchor.js neighbourhoodSeed),
// never the pin's own. A rejoin asks with the very same one.
//
// The dropped line: a close after welcome that the game did not ask for (disconnect()) empties the players list and is told to onLine
// ('dropped'). Then the SAME room is asked for again, under the SAME name, with the SAME requested seed — the tries spaced about 1 s, 2 s,
// 4 s … up to 30 s apart, each ±25 % (rejoinDelay), for four minutes at most; then it stops and says so ('gave-up'). A try that fails says
// 'retrying'; one the room welcomes says 'back', and the next players list fills the room again. rejoinNow() starts the spacing over and
// tries at once, after a give-up too. A flood close is its own state ('flood') and is never tried again, by the client or by rejoinNow().
// A rejoin is not an arrival: arrival() keeps what the first join made it — after a relay deploy the first socket back is told
// first: true, and a player who comes back alone has not walked in. The relay's replay after the welcome reaches the listener as it always
// did (the bus and the cache ledger tell a replay of what is already here); frames held for a listener that has not come yet are let go
// with the socket they came on, since the next one replays them again.
//
// A friend's line: a 'left' and then a 'joined' under the same name within COMEBACK_MS is one line — CAME_BACK_LINE ("— maddie's line came
// back.") in place of 'entered the level.' (the game folds the 'no-clipped away.' it said before: foldChat). So is a name that was in the room
// when your own line dropped, coming in after you. Keyed by name, here only; nothing about it goes on the wire. Never for the blank name
// many share (SHARED_NAMES, as caches.js NAME_CAP_EXEMPT): one 'wanderer' leaving and another arriving are two people. And a name the room
// lists is not gone: the list after your own rejoin holds those who never left, and the room never says 'joined' of them.

// the room closed this socket for flooding it (relay/relay.js and server/index.js close with the same code, reason 'too fast')
export const FLOOD_CLOSE = 4029

// the rejoin's spacing: the first try FIRST_MS after the drop, doubling to CAP_MS, each ±JITTER; no try starts later than FOR_MS after the
// drop. A try the room has not welcomed in TRY_MS is given up on. A line that falls again within STEADY_MS of coming back keeps the spacing
// it had (a room that lets you in and throws you out again is not hammered every second)
export const REJOIN = Object.freeze({ FIRST_MS: 1000, CAP_MS: 30_000, JITTER: 0.25, FOR_MS: 4 * 60_000, TRY_MS: 10_000, STEADY_MS: 20_000 })

// a friend who left and came back under the same name within this long reads as their line coming back
export const COMEBACK_MS = 90_000
// the blank name many strangers share (index.html getName's default, the relay's and the LAN server's): never one friend's line
export const SHARED_NAMES = Object.freeze(['wanderer'])
const named = (n) => typeof n === 'string' && n !== '' && !SHARED_NAMES.includes(n)

// the room's people lines (chat-sys: '— maddie no-clipped away.'); CAME_BACK_LINE joins its name with no space: '— maddie's line came back.'
export const JOINED_LINE = 'entered the level.'
export const LEFT_LINE = 'no-clipped away.'
export const CAME_BACK_LINE = "'s line came back."

// what the game says of its own line (game.js: the plate in the chat stack holds the state, #msg says the change once)
export const LINE = Object.freeze({
  DEAD: 'the line went dead. the others are gone.',
  TRYING: 'still trying the line.',
  GAVE_UP: 'the line stays dead. nobody is trying it now.',
  BACK: 'the line holds again.',
  FLOOD: 'the line was cut. too much went down it, too fast. leave it be a while.',
  PRESS_KEY: 'r · call the line back',
  PRESS_TAP: 'tap · call the line back',
})

// the movement send rate (world.json net.posHz, the owner's switch, default 20 a second): an integer 5..20, anything else is 20
export const POS_HZ = 20
export function posHz(net) {
  const v = net && typeof net === 'object' ? net.posHz : undefined
  return Number.isInteger(v) && v >= 5 && v <= 20 ? v : POS_HZ
}
// the seconds between two position frames (game.js netTimer): at 20, 0.05 exactly as it always was
export function posGapS(net) { return 1 / posHz(net) }

// the wait before rejoin try number `attempt` + 1 (0: the first try after the drop): FIRST_MS doubled `attempt` times, at most CAP_MS,
// then ±JITTER by `random` (0..1)
export function rejoinDelay(attempt, random = Math.random) {
  const n = Number.isInteger(attempt) && attempt > 0 ? Math.min(attempt, 16) : 0
  const base = Math.min(REJOIN.CAP_MS, REJOIN.FIRST_MS * 2 ** n)
  const r = Number(random())
  const u = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0.5
  return Math.round(base * (1 + (u * 2 - 1) * REJOIN.JITTER))
}

// the plate's rows for a line state (lineState()), or null when there is nothing to say: down, the press that calls it back (R, or a tap
// on the plate itself on a touch screen); cut for flooding, no press at all
export function lineNotice(state, touch = false) {
  const press = touch ? LINE.PRESS_TAP : LINE.PRESS_KEY
  if (state === 'retrying') return [LINE.DEAD, LINE.TRYING, press]
  if (state === 'gave-up') return [LINE.DEAD, LINE.GAVE_UP, press]
  if (state === 'flood') return [LINE.FLOOD]
  return null
}

// the chat log as it reads: a friend's 'no-clipped away.' answered by their line coming back is folded into that one line. `lines` is
// the game's [{from, text, sys}]; the same array comes back when nothing folds
export function foldChat(lines) {
  let drop = null
  for (let j = 0; j < lines.length; j++) {
    const m = lines[j]
    if (!m || !m.sys || m.text !== CAME_BACK_LINE) continue
    for (let i = j - 1; i >= 0; i--) {
      const l = lines[i]
      if (!l || !l.sys || l.from !== m.from) continue
      if (l.text === LEFT_LINE) (drop ??= new Set()).add(i)
      break                                   // their nearest line before it: the leave it answers, or something else (nothing folds)
    }
  }
  return drop ? lines.filter((_, i) => !drop.has(i)) : lines
}

// a chat-sys line's text: '— maddie no-clipped away.', and the line that hangs on a name: "— maddie's line came back."
export function sysText(from, text) {
  const t = String(text ?? '')
  return `— ${from ?? ''}${t.startsWith("'") ? '' : ' '}${t}`
}

// opts (tests): { WebSocket, setTimeout, clearTimeout, now, random } — the page's own when left out
export function createMultiplayerClient(serverUrl, opts = {}) {
  const setT = typeof opts.setTimeout === 'function' ? opts.setTimeout : (fn, ms) => setTimeout(fn, ms)
  const clearT = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : (id) => clearTimeout(id)
  const now = typeof opts.now === 'function' ? opts.now : () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  const random = typeof opts.random === 'function' ? opts.random : Math.random

  let ws = null
  let connected = false
  let playerId = null
  let selfName = 'wanderer'
  const remotePlayers = new Map()  // id → {id, x, y, angle, name, hp, chatText?, chatAt?, stillSince, …fields the bus writes}
  const chatCbs = []               // (from, text, isSystem, id) => void
  const typingCbs = []             // (name, isOn) => void
  const evCbs = []                 // (msg) => void
  const lineCbs = []               // (state, info) => void: 'dropped' | 'retrying' | 'back' | 'flood' | 'gave-up'
  // 'ev' frames that land before anyone listens: the relay replays its kept caches straight after welcome, while the
  // game is still loading its world — held (bounded) and handed to the first listener on the next tick
  const evEarly = []
  const EV_EARLY_MAX = 256
  // 'walked' into an empty room or 'dropped' in on someone (welcome.first); an
  // old server omits first, so the first players list after welcome decides,
  // within ARRIVAL_WAIT_MS, default 'walked'. Fixed by the first join: a rejoin never moves it.
  let arrivalV = null
  let arrivalTimer = null

  // the line: 'off' (never joined, or disconnect()) | 'joining' | 'live' | 'retrying' | 'gave-up' | 'flood'
  let line = 'off'
  let joinArgs = null              // { roomId, worldSeed, name }: what every rejoin asks with
  let worldV = null                // the world the first welcome gave
  const retry = { attempt: 0, since: 0, timer: null }
  let backAt = -Infinity
  // my own ids this session: a socket the room has not noticed is dead yet still lists me (a ghost of me) and says I left
  const pastIds = new Set()
  // name → when it left (a 'left', or in the room when my own line dropped); never a shared name, never a name the room lists
  const goneAt = new Map()
  const GONE_MAX = 64

  const ARRIVAL_WAIT_MS = 400
  const STILL_EPS = 0.02

  const emitChat = (from, text, sys, id) => { for (const cb of chatCbs) { try { cb(from, text, sys, id) } catch {} } }
  const emitTyping = (name, on) => { for (const cb of typingCbs) { try { cb(name, on) } catch {} } }
  const emitEv = (msg) => { for (const cb of evCbs) { try { cb(msg) } catch {} } }
  const emitLine = (state, info = {}) => { for (const cb of lineCbs) { try { cb(state, info) } catch {} } }

  function settleArrival(v) {
    if (arrivalV != null) return
    arrivalV = v
    if (arrivalTimer) { clearT(arrivalTimer); arrivalTimer = null }
  }

  function stopRetry() {
    if (retry.timer) { clearT(retry.timer); retry.timer = null }
  }

  function noteGone(name, t) {
    if (!named(name)) return
    goneAt.delete(name)
    goneAt.set(name, t)
    for (const [n, at] of goneAt) { if (goneAt.size <= GONE_MAX && t - at <= COMEBACK_MS) break; goneAt.delete(n) }
  }

  function connect(roomId, worldSeed = null, name = 'wanderer') {
    selfName = String(name || 'wanderer').slice(0, 24)
    stopRetry()
    if (ws) { const old = ws; ws = null; try { old.close() } catch {} }
    connected = false; remotePlayers.clear()
    evEarly.length = 0
    goneAt.clear()
    arrivalV = null
    if (arrivalTimer) { clearT(arrivalTimer); arrivalTimer = null }
    joinArgs = { roomId: String(roomId), worldSeed, name: selfName }
    line = 'joining'
    return new Promise((resolve, reject) => { open({ rejoin: false, resolve, reject }) })
  }

  // one socket, for the first join (att.resolve / att.reject: connect()'s promise) or for a rejoin try. Only the socket in `ws` speaks:
  // one the client has let go of (a new connect, a try given up on, disconnect()) is ignored to the end, though its promise still settles
  function open(att) {
    const WS = opts.WebSocket || (typeof globalThis !== 'undefined' && globalThis.WebSocket) ||
               (typeof window !== 'undefined' && window.WebSocket)
    let sock
    try { sock = new WS(serverUrl) } catch (e) {
      if (att.reject) { line = 'off'; att.reject(e) } else tryFailed(0)
      return
    }
    ws = sock
    att.sock = sock
    let settled = false, welcomed = false
    const mine = () => ws === sock
    if (att.rejoin) att.timer = setT(() => {
      att.timer = null
      if (!mine() || welcomed) return
      ws = null
      try { sock.close() } catch {}
      tryFailed(0)
    }, REJOIN.TRY_MS)

    sock.onopen = () => {
      if (!mine()) return
      const join = { type: 'join', roomId: joinArgs.roomId, name: joinArgs.name }
      if (joinArgs.worldSeed != null) join.worldSeed = joinArgs.worldSeed
      try { sock.send(JSON.stringify(join)) } catch {}
    }

    sock.onmessage = ({ data }) => {
      if (!mine()) return
      let msg
      try { msg = JSON.parse(data) } catch { return }
      if (!msg || typeof msg !== 'object') return

      if (msg.type === 'welcome') {
        if (welcomed) return
        welcomed = true; settled = true; connected = true
        if (playerId != null && playerId !== msg.playerId) pastIds.add(playerId)
        playerId = msg.playerId
        const first = typeof msg.first === 'boolean' ? msg.first : undefined
        if (att.rejoin) {
          // back: the arrival stays the first join's (first: true here is the relay's own restart, or a room you came back to alone).
          // sameWorld: the room still keeps the world you walk (the relay never forgets one; a LAN server started again may not)
          if (att.timer) { clearT(att.timer); att.timer = null }
          stopRetry()
          line = 'live'; backAt = now()
          emitLine('back', { attempt: retry.attempt, sameWorld: msg.worldSeed === worldV })
          return
        }
        line = 'live'; worldV = msg.worldSeed
        if (first !== undefined) settleArrival(first ? 'walked' : 'dropped')
        else arrivalTimer = setT(() => settleArrival('walked'), ARRIVAL_WAIT_MS)
        att.resolve({ worldSeed: msg.worldSeed, playerId: msg.playerId, roomId: msg.roomId, first })
      } else if (msg.type === 'players') {
        if (!Array.isArray(msg.list)) return
        const t = now()
        const incoming = new Set(msg.list.map(p => p.id))
        for (const id of remotePlayers.keys()) if (!incoming.has(id)) remotePlayers.delete(id)
        let others = false
        for (const p of msg.list) {
          if (p.id === playerId || pastIds.has(p.id)) continue
          others = true
          // listed, so not gone: someone the room still had when your own line came back never left it (its 'joined', if any, came first)
          if (goneAt.size) goneAt.delete(p.name)
          const ex = remotePlayers.get(p.id)
          if (ex) {
            // stillness from successive list positions: parked when the list barely moves (stillFor is read from stillSince: getRemotePlayers)
            const moved = Math.hypot((+p.x || 0) - (+ex.x || 0), (+p.y || 0) - (+ex.y || 0)) >= STILL_EPS
            if (moved || ex.stillSince == null) ex.stillSince = t
            // preserve the floating speech bubble and the bus's fields across position updates
            Object.assign(ex, p)
          } else {
            remotePlayers.set(p.id, Object.assign(p, { stillSince: t }))
          }
        }
        if (arrivalV == null) settleArrival(others ? 'dropped' : 'walked')
      } else if (msg.type === 'joined') {
        const n = msg.name || 'someone', at = named(msg.name) ? goneAt.get(n) : undefined
        if (at != null && now() - at <= COMEBACK_MS) { goneAt.delete(n); emitChat(n, CAME_BACK_LINE, true, msg.id) }
        else emitChat(n, JOINED_LINE, true, msg.id)
      } else if (msg.type === 'left') {
        remotePlayers.delete(msg.id)
        if (pastIds.has(msg.id)) return            // my own old socket, noticed late: I am still here
        noteGone(msg.name, now())                  // a name only: the blank one, or none ('someone'), is nobody in particular
        emitChat(msg.name || 'someone', LEFT_LINE, true, msg.id)
      } else if (msg.type === 'chat') {
        if (msg.id === playerId) return
        const rp = remotePlayers.get(msg.id)
        if (rp) { rp.chatText = String(msg.text ?? ''); rp.chatAt = now() }
        emitChat(msg.name || 'someone', String(msg.text ?? ''), false, msg.id)
      } else if (msg.type === 'typing') {
        if (msg.id !== playerId) emitTyping(msg.name || 'someone', !!msg.on)
      } else if (msg.type === 'ev') {
        if (msg.id === playerId) return
        if (evCbs.length) emitEv(msg)
        else if (evEarly.length < EV_EARLY_MAX) evEarly.push(msg)
      }
    }

    sock.onerror = (e) => {
      if (att.reject && !settled) { settled = true; if (mine()) { connected = false; line = 'off' } att.reject(e) }
    }
    sock.onclose = (e) => {
      const code = e && typeof e.code === 'number' ? e.code : 0
      if (att.reject && !settled) {
        settled = true
        if (mine()) line = 'off'
        att.reject(new Error(code === FLOOD_CLOSE ? 'too fast' : 'connection closed before welcome'))
      }
      if (!mine()) return
      ws = null; connected = false
      if (att.timer) { clearT(att.timer); att.timer = null }
      if (!welcomed) { remotePlayers.clear(); if (att.rejoin) tryFailed(code); return }   // a first join that failed was connect()'s to say
      dropped(code)
    }
  }

  // the line went dead under the game: who was here is gone with it, and the tries begin (never after a flood close)
  function dropped(code) {
    const t = now()
    for (const p of remotePlayers.values()) if (p) noteGone(p.name, t)
    remotePlayers.clear()
    if (!evCbs.length) evEarly.length = 0
    if (arrivalV == null) settleArrival('walked')
    if (code === FLOOD_CLOSE) { flood(); return }
    if (t - backAt >= REJOIN.STEADY_MS) { retry.attempt = 0; retry.since = t }
    line = 'retrying'
    const inMs = schedule()
    emitLine('dropped', { attempt: retry.attempt, inMs })
    if (inMs === null && line === 'retrying') giveUp()
  }

  // the next try, after its spacing — or none, past FOR_MS. -> its wait, or null
  function schedule() {
    stopRetry()
    const d = rejoinDelay(retry.attempt, random)
    if (now() - retry.since + d > REJOIN.FOR_MS) return null
    retry.timer = setT(tryNow, d)
    return d
  }
  function giveUp() { stopRetry(); line = 'gave-up'; emitLine('gave-up', { attempt: retry.attempt }) }
  function flood() { stopRetry(); line = 'flood'; emitLine('flood') }

  function tryNow() {
    retry.timer = null
    if (line !== 'retrying') return
    retry.attempt++
    open({ rejoin: true })
  }

  function tryFailed(code) {
    if (line !== 'retrying') return                // disconnect(), or the line is back by another try
    if (code === FLOOD_CLOSE) { flood(); return }
    const inMs = schedule()
    if (inMs === null) giveUp()
    else emitLine('retrying', { attempt: retry.attempt, inMs })
  }

  // the one press: the spacing starts over and a try goes now (one already under way is that try). Not while the line holds, not after
  // a flood close, not after disconnect(). -> whether a try is under way
  function rejoinNow() {
    if (!joinArgs || (line !== 'retrying' && line !== 'gave-up')) return false
    stopRetry()
    retry.attempt = 0; retry.since = now()
    const was = line
    line = 'retrying'
    if (was === 'gave-up') emitLine('retrying', { attempt: 0, inMs: 0 })
    if (!ws) tryNow()
    return true
  }

  function sendPos(x, y, angle, hp) {
    if (ws && connected) { try { ws.send(JSON.stringify({ type: 'pos', x, y, angle, hp })) } catch {} }
  }

  function sendChat(text) {
    const t = String(text ?? '').slice(0, 200).trim()
    if (!t) return
    emitChat(selfName, t, false, playerId)   // echo locally so the sender sees it instantly
    if (ws && connected) { try { ws.send(JSON.stringify({ type: 'chat', text: t })) } catch {} }
  }

  function sendTyping(on) {
    if (ws && connected) { try { ws.send(JSON.stringify({ type: 'typing', on: !!on })) } catch {} }
  }

  // one generic relayed event; opts carries keep/drop for the server's log
  function sendEv(kind, payload, opts) {
    if (ws && connected) { try { ws.send(JSON.stringify({ type: 'ev', kind, payload, ...opts })) } catch {} }
  }

  function onChat(cb)   { if (typeof cb === 'function') chatCbs.push(cb) }
  function onTyping(cb) { if (typeof cb === 'function') typingCbs.push(cb) }
  function onLine(cb)   { if (typeof cb === 'function') lineCbs.push(cb) }
  // the first listener gets what came early, asynchronously: after the caller's synchronous setup (the game's first floor) is done
  function onEv(cb) {
    if (typeof cb !== 'function') return
    evCbs.push(cb)
    if (evEarly.length) setT(() => { for (const m of evEarly.splice(0)) emitEv(m) }, 0)
  }

  // 'walked' | 'dropped' — fixed at join; 'walked' until known
  function arrival() { return arrivalV ?? 'walked' }

  // the bus writes what a friend's heartbeat says onto their record so the
  // renderer reads origin/thin/status/aseed/lit/st/seen off getRemotePlayers()
  function mergeRemote(id, fields) {
    const rp = remotePlayers.get(id)
    if (rp && fields && typeof fields === 'object') Object.assign(rp, fields)
  }

  function disconnect() {
    stopRetry()
    connected = false
    const s = ws
    ws = null
    try { s?.close() } catch {}
    remotePlayers.clear()
    evEarly.length = 0
    if (arrivalTimer) { clearT(arrivalTimer); arrivalTimer = null }
    line = 'off'
  }

  // Attach the live "speech bubble" (recent chat, within `ttlMs`) to each remote player so the renderer can float it over their head,
  // and how long they have stood still, read now: a friend parked between two lists is still all the while
  function getRemotePlayers(ttlMs = 6000) {
    const t = now()
    return [...remotePlayers.values()].map(p => ({
      ...p,
      stillFor: p.stillSince == null ? 0 : Math.max(0, (t - p.stillSince) / 1000),
      chatText: (p.chatAt && (t - p.chatAt) < ttlMs) ? p.chatText : null,
    }))
  }
  function isConnected() { return connected }
  function lineState() { return line }
  function getName() { return selfName }
  function getId() { return playerId }

  return {
    connect, sendPos, sendChat, sendTyping, sendEv, onChat, onTyping, onEv, onLine, arrival, mergeRemote,
    disconnect, rejoinNow, getRemotePlayers, isConnected, lineState, getName, getId,
    get id() { return playerId },
  }
}
