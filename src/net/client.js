// src/net/client.js
export function createMultiplayerClient(serverUrl) {
  let ws = null
  let connected = false
  let playerId = null
  const remotePlayers = new Map()  // id → {id, x, y, angle}

  function connect(roomId) {
    return new Promise((resolve, reject) => {
      ws = new (global.WebSocket ?? window.WebSocket)(serverUrl)

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join', roomId: String(roomId) }))
      }

      ws.onmessage = ({ data }) => {
        let msg
        try { msg = JSON.parse(data) } catch { return }

        if (msg.type === 'welcome') {
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

      ws.onerror = (e) => { connected = false; reject(e) }
      ws.onclose = () => { connected = false; remotePlayers.clear() }
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
