// src/net/client.js
export function createMultiplayerClient(serverUrl) {
  let ws = null
  let connected = false
  let playerId = null
  const remotePlayers = new Map()  // id → {id, x, y, angle}

  function connect(roomId, worldSeed = null) {
    if (ws) { ws.close(); ws = null; connected = false; remotePlayers.clear() }
    return new Promise((resolve, reject) => {
      let settled = false
      // renderer has no `global`; Node test env has no `window`
      const WS = (typeof globalThis !== 'undefined' && globalThis.WebSocket) ||
                 (typeof window !== 'undefined' && window.WebSocket)
      ws = new WS(serverUrl)

      ws.onopen = () => {
        const join = { type: 'join', roomId: String(roomId) }
        if (worldSeed != null) join.worldSeed = worldSeed
        ws.send(JSON.stringify(join))
      }

      ws.onmessage = ({ data }) => {
        let msg
        try { msg = JSON.parse(data) } catch { return }

        if (msg.type === 'welcome') {
          settled = true
          connected = true
          playerId = msg.playerId
          resolve({ worldSeed: msg.worldSeed, playerId: msg.playerId, roomId: msg.roomId })
        } else if (msg.type === 'players') {
          const incoming = new Set(msg.list.map(p => p.id))
          for (const id of remotePlayers.keys()) if (!incoming.has(id)) remotePlayers.delete(id)
          for (const p of msg.list) {
            if (p.id !== playerId) remotePlayers.set(p.id, p)
          }
        } else if (msg.type === 'left') {
          remotePlayers.delete(msg.id)
        }
      }

      ws.onerror = (e) => { if (!settled) { settled = true; connected = false; reject(e) } }
      ws.onclose = () => { if (!settled) { settled = true; reject(new Error('connection closed before welcome')) } connected = false; remotePlayers.clear() }
    })
  }

  function sendPos(x, y, angle) {
    if (ws && connected) ws.send(JSON.stringify({ type: 'pos', x, y, angle }))
  }

  function disconnect() {
    connected = false
    ws?.close()
    ws = null
    remotePlayers.clear()
  }

  function getRemotePlayers() { return [...remotePlayers.values()] }
  function isConnected() { return connected }

  return { connect, sendPos, disconnect, getRemotePlayers, isConnected }
}
