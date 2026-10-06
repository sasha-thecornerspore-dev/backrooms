// src/net/client.js — multiplayer client.
// Speaks one small JSON protocol that both the bundled Node server and the
// Cloudflare Durable-Object relay understand:
//   → join {roomId, worldSeed?, name}  → pos {x,y,angle}  → chat {text}  → typing {on}
//   → ev {kind, payload, keep?, drop?}
//   ← welcome {playerId, worldSeed, first?}  ← players [{id,x,y,angle,name}]
//   ← joined/left {id,name}  ← chat {id,name,text}  ← typing {id,name,on}
//   ← ev {id, name, kind, payload, t, replay?}
// Unknown message types are ignored, so an old client rides a new server and
// a new client rides an old one (no 'ev', no welcome.first) with no error.
export function createMultiplayerClient(serverUrl) {
  let ws = null
  let connected = false
  let playerId = null
  let selfName = 'wanderer'
  const remotePlayers = new Map()  // id → {id, x, y, angle, name, chatText?, chatAt?, stillFor, …fields the bus writes}
  const chatCbs = []               // (from, text, isSystem, id) => void
  const typingCbs = []             // (name, isOn) => void
  const evCbs = []                 // (msg) => void
  // 'walked' into an empty room or 'dropped' in on someone (welcome.first); an
  // old server omits first, so the first players list after welcome decides,
  // within ARRIVAL_WAIT_MS, default 'walked'.
  let arrivalV = null
  let arrivalTimer = null

  const ARRIVAL_WAIT_MS = 400
  const STILL_EPS = 0.02

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  const emitChat = (from, text, sys, id) => { for (const cb of chatCbs) { try { cb(from, text, sys, id) } catch {} } }
  const emitTyping = (name, on) => { for (const cb of typingCbs) { try { cb(name, on) } catch {} } }
  const emitEv = (msg) => { for (const cb of evCbs) { try { cb(msg) } catch {} } }

  function settleArrival(v) {
    if (arrivalV != null) return
    arrivalV = v
    if (arrivalTimer) { clearTimeout(arrivalTimer); arrivalTimer = null }
  }

  function connect(roomId, worldSeed = null, name = 'wanderer') {
    selfName = String(name || 'wanderer').slice(0, 24)
    if (ws) { try { ws.close() } catch {} ws = null; connected = false; remotePlayers.clear() }
    arrivalV = null
    if (arrivalTimer) { clearTimeout(arrivalTimer); arrivalTimer = null }
    return new Promise((resolve, reject) => {
      let settled = false
      const WS = (typeof globalThis !== 'undefined' && globalThis.WebSocket) ||
                 (typeof window !== 'undefined' && window.WebSocket)
      ws = new WS(serverUrl)

      ws.onopen = () => {
        const join = { type: 'join', roomId: String(roomId), name: selfName }
        if (worldSeed != null) join.worldSeed = worldSeed
        ws.send(JSON.stringify(join))
      }

      ws.onmessage = ({ data }) => {
        let msg
        try { msg = JSON.parse(data) } catch { return }
        if (!msg || typeof msg !== 'object') return

        if (msg.type === 'welcome') {
          settled = true; connected = true; playerId = msg.playerId
          const first = typeof msg.first === 'boolean' ? msg.first : undefined
          if (first !== undefined) settleArrival(first ? 'walked' : 'dropped')
          else arrivalTimer = setTimeout(() => settleArrival('walked'), ARRIVAL_WAIT_MS)
          resolve({ worldSeed: msg.worldSeed, playerId: msg.playerId, roomId: msg.roomId, first })
        } else if (msg.type === 'players') {
          if (!Array.isArray(msg.list)) return
          const t = now()
          const incoming = new Set(msg.list.map(p => p.id))
          for (const id of remotePlayers.keys()) if (!incoming.has(id)) remotePlayers.delete(id)
          let others = false
          for (const p of msg.list) {
            if (p.id === playerId) continue
            others = true
            const ex = remotePlayers.get(p.id)
            if (ex) {
              // stillness from successive list positions: parked when the list barely moves
              const moved = Math.hypot((+p.x || 0) - (+ex.x || 0), (+p.y || 0) - (+ex.y || 0)) >= STILL_EPS
              if (moved || ex.stillSince == null) ex.stillSince = t
              ex.stillFor = (t - ex.stillSince) / 1000
              // preserve the floating speech bubble and the bus's fields across position updates
              Object.assign(ex, p)
            } else {
              remotePlayers.set(p.id, Object.assign(p, { stillSince: t, stillFor: 0 }))
            }
          }
          if (arrivalV == null) settleArrival(others ? 'dropped' : 'walked')
        } else if (msg.type === 'joined') {
          emitChat(msg.name || 'someone', 'entered the level.', true, msg.id)
        } else if (msg.type === 'left') {
          remotePlayers.delete(msg.id)
          emitChat(msg.name || 'someone', 'no-clipped away.', true, msg.id)
        } else if (msg.type === 'chat') {
          if (msg.id === playerId) return
          const rp = remotePlayers.get(msg.id)
          if (rp) { rp.chatText = String(msg.text ?? ''); rp.chatAt = now() }
          emitChat(msg.name || 'someone', String(msg.text ?? ''), false, msg.id)
        } else if (msg.type === 'typing') {
          if (msg.id !== playerId) emitTyping(msg.name || 'someone', !!msg.on)
        } else if (msg.type === 'ev') {
          if (msg.id !== playerId) emitEv(msg)
        }
      }

      ws.onerror = (e) => { if (!settled) { settled = true; connected = false; reject(e) } }
      ws.onclose = () => {
        if (!settled) { settled = true; reject(new Error('connection closed before welcome')) }
        connected = false; remotePlayers.clear()
      }
    })
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
  function onEv(cb)     { if (typeof cb === 'function') evCbs.push(cb) }

  // 'walked' | 'dropped' — fixed at join; 'walked' until known
  function arrival() { return arrivalV ?? 'walked' }

  // the bus writes what a friend's heartbeat says onto their record so the
  // renderer reads origin/thin/status/aseed/lit/st/seen off getRemotePlayers()
  function mergeRemote(id, fields) {
    const rp = remotePlayers.get(id)
    if (rp && fields && typeof fields === 'object') Object.assign(rp, fields)
  }

  function disconnect() {
    connected = false
    try { ws?.close() } catch {}
    ws = null
    remotePlayers.clear()
    if (arrivalTimer) { clearTimeout(arrivalTimer); arrivalTimer = null }
  }

  // Attach the live "speech bubble" (recent chat, within `ttlMs`) to each remote
  // player so the renderer can float it over their head.
  function getRemotePlayers(ttlMs = 6000) {
    const t = now()
    return [...remotePlayers.values()].map(p => ({
      ...p,
      chatText: (p.chatAt && (t - p.chatAt) < ttlMs) ? p.chatText : null,
    }))
  }
  function isConnected() { return connected }
  function getName() { return selfName }
  function getId() { return playerId }

  return {
    connect, sendPos, sendChat, sendTyping, sendEv, onChat, onTyping, onEv, arrival, mergeRemote,
    disconnect, getRemotePlayers, isConnected, getName, getId,
    get id() { return playerId },
  }
}
