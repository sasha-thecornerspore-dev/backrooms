// backrooms-relay — a Cloudflare Worker + Durable Object that relays a small
// multiplayer room over WebSockets. One public wss:// URL, one room code, no
// host and no port-forwarding: everyone connects here and shares a world.
//
// Speaks the exact same JSON protocol as server/index.js:
//   → join {roomId, worldSeed?, name}  → pos {x,y,angle}  → chat {text}
//   → ev {kind, payload, keep?, drop?}
//   ← welcome {playerId, worldSeed, first}  ← players [...]  ← joined/left/chat
//   ← ev {id, name, kind, payload, t, replay?}
//
// Uses the WebSocket Hibernation API + a SQLite-backed class so it runs on the
// Workers free plan. Per-connection state (id, name, position, the ev token
// bucket) rides in each socket's attachment, so it survives hibernation
// between bursts of traffic.
import { DurableObject } from 'cloudflare:workers'
import { roomSeed } from './seed.js'
import { evKindOk, evFrameOk, evBucket } from './evguard.js'
import { createEvLog } from './evlog.js'

export class Room extends DurableObject {
  async fetch(request) {
    // No seed logic here. This is the WebSocket upgrade, and the join message
    // carrying the client's requested seed has not arrived yet — which is why
    // the old ?seed= param could never work: index.html never sent one, so
    // Number(null) === 0 failed the guard and every room fell to Math.random()
    // while the HUD reported the player's real anchor. The world is decided in
    // webSocketMessage('join') instead.
    const pair = new WebSocketPair()
    const client = pair[0], server = pair[1]
    const id = crypto.randomUUID().slice(0, 12)
    server.serializeAttachment({ id, name: 'wanderer', x: 0, y: 0, angle: 0 })
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  // The keep/drop log (relay/evlog.js) — the only server state the ev
  // substrate adds, behind the owner's opt-in (wrangler var EV_LOG; '0' turns
  // it off). It lives in this instance's memory: a hibernated or evicted
  // object forgets it, which is acceptable for a leave-behind log.
  evLog() {
    if (!this._evLog) this._evLog = createEvLog({ max: 64, perName: 6 })
    return this._evLog
  }

  async webSocketMessage(ws, raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    const att = ws.deserializeAttachment() || {}
    const env = this.env || {}
    const LOG = env.EV_LOG !== '0'

    if (msg.type === 'join') {
      att.name = String(msg.name || 'wanderer').slice(0, 24)
      ws.serializeAttachment(att)
      const roomId = String(msg.roomId || 'default').slice(0, 32)
      // The first joiner into a virgin room fixes its world — from their anchor
      // if they sent one, mirroring server/index.js:72-77. Durable Object input
      // gates make this get/put atomic: no other event is delivered while a
      // storage op is in flight, so two simultaneous joins cannot interleave.
      const stored = await this.ctx.storage.get('seed')
      const seed = roomSeed(msg.worldSeed, stored)
      if (stored == null) await this.ctx.storage.put('seed', seed)
      // first = no OTHER live socket in the room at join (the accepting socket is
      // already in the list). NOT `stored == null`: the seed is kept forever, which
      // would mint every returning visitor to an empty room thin.
      ws.send(JSON.stringify({ type: 'welcome', playerId: att.id, worldSeed: seed, roomId, first: this.ctx.getWebSockets().length === 1 }))
      if (LOG) for (const f of this.evLog().replay()) { try { ws.send(JSON.stringify({ ...f, replay: true })) } catch { /* ignore */ } }
      this.broadcast({ type: 'joined', id: att.id, name: att.name }, att.id)
      this.pushPlayers()
    } else if (msg.type === 'pos') {
      att.x = +msg.x || 0; att.y = +msg.y || 0; att.angle = +msg.angle || 0; att.hp = (msg.hp == null ? 100 : +msg.hp)
      ws.serializeAttachment(att)
      this.pushPlayers()
    } else if (msg.type === 'chat') {
      const text = String(msg.text ?? '').slice(0, 200)
      if (text.trim()) this.broadcast({ type: 'chat', id: att.id, name: att.name, text }, att.id)
    } else if (msg.type === 'typing') {
      this.broadcast({ type: 'typing', id: att.id, name: att.name, on: !!msg.on }, att.id)
    } else if (msg.type === 'ev') {
      // one generic relayed event — mirrored textually in server/index.js. The relay
      // never inspects kind semantics or payload: size, spelling, rate, attach, forward.
      if (!evFrameOk(raw)) return
      const kind = typeof msg.kind === 'string' ? msg.kind : ''
      if (!evKindOk(kind)) return
      const ok = evBucket(att, Date.now())
      ws.serializeAttachment(att)                  // evTok/evT ride the attachment
      if (!ok) return
      const out = { type: 'ev', id: att.id, name: att.name, kind, payload: msg.payload, t: Date.now() }
      if (LOG && typeof msg.keep === 'string') this.evLog().keep(msg.keep.slice(0, 48), att.name, out)
      else if (LOG && typeof msg.drop === 'string') this.evLog().drop(msg.drop.slice(0, 48))
      this.broadcast(out, att.id)
    }
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {}
    this.broadcast({ type: 'left', id: att.id, name: att.name }, att.id)
    // The world is NEVER forgotten. A room is a persistent place.
    // This used to delete the seed once the last player left, so the same room
    // code produced a different maze tomorrow — and nothing persistent (least
    // of all territory) can be built on a room that erases itself.
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
      return { id: a.id, x: a.x, y: a.y, angle: a.angle, name: a.name, hp: a.hp ?? 100 }
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
