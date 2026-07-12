// src/net/client.js — multiplayer client.
// Speaks one small JSON protocol that both the bundled Node server and the
// Cloudflare Durable-Object relay understand:
//   → join {roomId, worldSeed?, name}  → pos {x,y,angle}  → chat {text}  → typing {on}
//   ← welcome {playerId, worldSeed}     ← players [{id,x,y,angle,name}]
//   ← joined/left {id,name}  ← chat {id,name,text}  ← typing {id,name,on}
export function createMultiplayerClient(serverUrl) {
  let ws = null
  let connected = false
  let playerId = null
  let selfName = 'wanderer'
  const remotePlayers = new Map()  // id → {id, x, y, angle, name, chatText?, chatAt?}
  const chatCbs = []               // (from, text, isSystem) => void
  const typingCbs = []             // (name, isOn) => void

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  const emitChat = (from, text, sys) => { for (const cb of chatCbs) { try { cb(from, text, sys) } catch {} } }
  const emitTyping = (name, on) => { for (const cb of typingCbs) { try { cb(name, on) } catch {} } }

  function connect(roomId, worldSeed = null, name = 'wanderer') {
    selfName = String(name || 'wanderer').slice(0, 24)
    if (ws) { try { ws.close() } catch {} ws = null; connected = false; remotePlayers.clear() }
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

        if (msg.type === 'welcome') {
          settled = true; connected = true; playerId = msg.playerId
          resolve({ worldSeed: msg.worldSeed, playerId: msg.playerId, roomId: msg.roomId })
        } else if (msg.type === 'players') {
          const incoming = new Set(msg.list.map(p => p.id))
          for (const id of remotePlayers.keys()) if (!incoming.has(id)) remotePlayers.delete(id)
          for (const p of msg.list) {
            if (p.id === playerId) continue
            const ex = remotePlayers.get(p.id)
            // preserve the floating speech bubble across position updates
            remotePlayers.set(p.id, ex ? Object.assign(ex, p) : p)
          }
        } else if (msg.type === 'joined') {
          emitChat(msg.name || 'someone', 'entered the level.', true)
        } else if (msg.type === 'left') {
          remotePlayers.delete(msg.id)
          emitChat(msg.name || 'someone', 'no-clipped away.', true)
        } else if (msg.type === 'chat') {
          if (msg.id === playerId) return
          const rp = remotePlayers.get(msg.id)
          if (rp) { rp.chatText = String(msg.text ?? ''); rp.chatAt = now() }
          emitChat(msg.name || 'someone', String(msg.text ?? ''), false)
        } else if (msg.type === 'typing') {
          if (msg.id !== playerId) emitTyping(msg.name || 'someone', !!msg.on)
        }
      }

      ws.onerror = (e) => { if (!settled) { settled = true; connected = false; reject(e) } }
      ws.onclose = () => {
        if (!settled) { settled = true; reject(new Error('connection closed before welcome')) }
        connected = false; remotePlayers.clear()
      }
    })
  }

  function sendPos(x, y, angle) {
    if (ws && connected) { try { ws.send(JSON.stringify({ type: 'pos', x, y, angle })) } catch {} }
  }

  function sendChat(text) {
    const t = String(text ?? '').slice(0, 200).trim()
    if (!t) return
    emitChat(selfName, t, false)   // echo locally so the sender sees it instantly
    if (ws && connected) { try { ws.send(JSON.stringify({ type: 'chat', text: t })) } catch {} }
  }

  function sendTyping(on) {
    if (ws && connected) { try { ws.send(JSON.stringify({ type: 'typing', on: !!on })) } catch {} }
  }

  function onChat(cb)   { if (typeof cb === 'function') chatCbs.push(cb) }
  function onTyping(cb) { if (typeof cb === 'function') typingCbs.push(cb) }

  function disconnect() {
    connected = false
    try { ws?.close() } catch {}
    ws = null
    remotePlayers.clear()
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

  return { connect, sendPos, sendChat, sendTyping, onChat, onTyping, disconnect, getRemotePlayers, isConnected, getName }
}
