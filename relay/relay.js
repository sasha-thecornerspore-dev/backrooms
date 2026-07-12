// backrooms-relay — a Cloudflare Worker + Durable Object that relays a small
// multiplayer room over WebSockets. One public wss:// URL, one room code, no
// host and no port-forwarding: everyone connects here and shares a world.
//
// Speaks the exact same JSON protocol as server/index.js:
//   → join {roomId, worldSeed?, name}  → pos {x,y,angle}  → chat {text}
//   ← welcome {playerId, worldSeed}     ← players [...]     ← joined/left/chat
//
// Uses the WebSocket Hibernation API + a SQLite-backed class so it runs on the
// Workers free plan. Per-connection state (id, name, position) rides in each
// socket's attachment, so it survives hibernation between bursts of traffic.
import { DurableObject } from 'cloudflare:workers'

export class Room extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url)
    const seedParam = Number(url.searchParams.get('seed'))
    // first connection into an empty room fixes the world seed
    let seed = await this.ctx.storage.get('seed')
    if (seed == null) {
      seed = (Number.isInteger(seedParam) && seedParam > 0 && seedParam <= 0xFFFFFFFF)
        ? seedParam
        : (Math.floor(Math.random() * 0xFFFFFFFF) + 1)
      await this.ctx.storage.put('seed', seed)
    }

    const pair = new WebSocketPair()
    const client = pair[0], server = pair[1]
    const id = crypto.randomUUID().slice(0, 12)
    server.serializeAttachment({ id, name: 'wanderer', x: 0, y: 0, angle: 0 })
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws, raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    const att = ws.deserializeAttachment() || {}

    if (msg.type === 'join') {
      att.name = String(msg.name || 'wanderer').slice(0, 24)
      ws.serializeAttachment(att)
      const seed = await this.ctx.storage.get('seed')
      ws.send(JSON.stringify({ type: 'welcome', playerId: att.id, worldSeed: seed, roomId: '' }))
      this.broadcast({ type: 'joined', id: att.id, name: att.name }, att.id)
      this.pushPlayers()
    } else if (msg.type === 'pos') {
      att.x = +msg.x || 0; att.y = +msg.y || 0; att.angle = +msg.angle || 0
      ws.serializeAttachment(att)
      this.pushPlayers()
    } else if (msg.type === 'chat') {
      const text = String(msg.text ?? '').slice(0, 200)
      if (text.trim()) this.broadcast({ type: 'chat', id: att.id, name: att.name, text }, att.id)
    } else if (msg.type === 'typing') {
      this.broadcast({ type: 'typing', id: att.id, name: att.name, on: !!msg.on }, att.id)
    }
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {}
    this.broadcast({ type: 'left', id: att.id, name: att.name }, att.id)
    // if the last player is gone, forget the world so the room can be reborn
    if (this.ctx.getWebSockets().length <= 1) {
      try { await this.ctx.storage.delete('seed') } catch { /* ignore */ }
    }
  }

  webSocketError() { /* close handler does the cleanup */ }

  broadcast(obj, exceptId) {
    const raw = JSON.stringify(obj)
    for (const s of this.ctx.getWebSockets()) {
      const a = s.deserializeAttachment() || {}
      if (a.id !== exceptId) { try { s.send(raw) } catch { /* ignore */ } }
    }
  }

  pushPlayers() {
    const sockets = this.ctx.getWebSockets()
    const list = sockets.map(s => {
      const a = s.deserializeAttachment() || {}
      return { id: a.id, x: a.x, y: a.y, angle: a.angle, name: a.name }
    })
    const raw = JSON.stringify({ type: 'players', list })
    for (const s of sockets) { try { s.send(raw) } catch { /* ignore */ } }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('the backrooms relay is running.\nconnect a websocket: wss://<this-host>/?room=CODE', {
        status: 200, headers: { 'content-type': 'text/plain' },
      })
    }
    const room = (url.searchParams.get('room') || 'default').slice(0, 32)
    const stub = env.ROOM.get(env.ROOM.idFromName(room))
    return stub.fetch(request)
  },
}
