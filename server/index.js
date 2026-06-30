// server/index.js
import { WebSocketServer, WebSocket } from 'ws'
import { createServer as createHttpServer } from 'http'
import { randomBytes } from 'crypto'

const PORT = parseInt(process.env.PORT ?? '8765', 10)

const rooms = new Map()  // roomId → { worldSeed, players: Map<id,{ws,x,y,angle}>, expireTimer }

function uuid() { return randomBytes(6).toString('hex') }
function seed32() { return (randomBytes(4).readUInt32BE(0)) }

function broadcast(room, msg, excludeId) {
  const raw = JSON.stringify(msg)
  for (const [id, p] of room.players) {
    if (id !== excludeId && p.ws.readyState === WebSocket.OPEN) p.ws.send(raw)
  }
}

function startBroadcastLoop(room) {
  if (room._ticker) return
  room._ticker = setInterval(() => {
    if (room.players.size === 0) return
    const list = [...room.players.entries()].map(([id, p]) => ({ id, x: p.x, y: p.y, angle: p.angle }))
    broadcast(room, { type: 'players', list })
  }, 50)  // 20Hz
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { worldSeed: seed32(), players: new Map(), expireTimer: null, _ticker: null })
  }
  const room = rooms.get(roomId)
  if (room.expireTimer) { clearTimeout(room.expireTimer); room.expireTimer = null }
  return room
}

function handleLeave(room, roomId, playerId) {
  room.players.delete(playerId)
  broadcast(room, { type: 'left', id: playerId })
  if (room.players.size === 0) {
    clearInterval(room._ticker); room._ticker = null
    room.expireTimer = setTimeout(() => rooms.delete(roomId), 30000)
  }
}

export function createServer(port = PORT) {
  const http = createHttpServer()
  const wss = new WebSocketServer({ server: http })

  wss.on('connection', (ws) => {
    let playerId = null
    let roomId = null
    let room = null

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }

      if (msg.type === 'join' && !playerId) {
        roomId = String(msg.roomId || 'default').slice(0, 32)
        room = getOrCreateRoom(roomId)
        playerId = uuid()
        room.players.set(playerId, { ws, x: 0, y: 0, angle: 0 })
        ws.send(JSON.stringify({ type: 'welcome', playerId, worldSeed: room.worldSeed, roomId }))
        broadcast(room, { type: 'joined', id: playerId }, playerId)
        startBroadcastLoop(room)
        return
      }

      if (msg.type === 'pos' && playerId && room) {
        const p = room.players.get(playerId)
        if (p) { p.x = +msg.x || 0; p.y = +msg.y || 0; p.angle = +msg.angle || 0 }
      }
    })

    ws.on('close', () => { if (playerId && room) handleLeave(room, roomId, playerId) })
    ws.on('error', () => { if (playerId && room) handleLeave(room, roomId, playerId) })
  })

  return new Promise((resolve) => http.listen(port, () => resolve(http)))
}

// start when run directly
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  createServer().then(s => console.log(`backrooms server on :${s.address().port}`))
}
