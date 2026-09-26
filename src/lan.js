// LAN hosting for the desktop app's HOST LAN button (main process only).
// HOST and JOIN meet by default: the host listens on LAN_PORT when it is free
// and both sides use LAN_ROOM, so a friend can press JOIN LAN, type the address
// the host sees in its HUD, and keep the default room.

export const LAN_PORT = 8765
export const LAN_ROOM = 'backrooms'

// Rank of an IPv4 address as "the one a friend on the same network can reach": home routers
// hand out 192.168/16, then 10/8, then 172.16/12 (also used by Hyper-V / WSL adapters). A
// 169.254/16 link-local address (a disconnected adapter) is never reachable, so it is skipped.
function lanRank(addr) {
  const [a, b] = addr.split('.').map(Number)
  if (a === 169 && b === 254) return -1
  if (a === 192 && b === 168) return 3
  if (a === 10) return 2
  if (a === 172 && b >= 16 && b <= 31) return 1
  return 0
}

// Adapters a friend on the same network cannot reach: Hyper-V / WSL / Docker / VM host-only switches (they also hand out 172.16/12
// and 192.168 addresses, so the range alone cannot tell them from the real LAN). Chosen only when nothing else is up.
const VIRTUAL_ADAPTER = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|vboxnet|Docker|virbr|^br-|Loopback|Bluetooth/i

// The best non-internal IPv4 address from os.networkInterfaces() (the first one of the best
// rank above, real adapters before virtual ones), or null.
export function lanAddress(interfaces) {
  let best = null, bestRank = -Infinity
  for (const [name, list] of Object.entries(interfaces || {})) {
    for (const a of list || []) {
      const v4 = a && (a.family === 'IPv4' || a.family === 4)
      if (!v4 || a.internal || !a.address) continue
      let r = lanRank(a.address)
      if (r < 0) continue
      if (VIRTUAL_ADAPTER.test(name)) r -= 10
      if (r > bestRank) { best = a.address; bestRank = r }
    }
  }
  return best
}

// The ws:// URL a friend on the same network types into JOIN LAN, or null.
export function lanUrl(interfaces, port) {
  const addr = lanAddress(interfaces)
  return addr ? `ws://${addr}:${port}` : null
}

// One server per app: start() is idempotent (later HOST clicks get the same
// port back, concurrent clicks share one start), close() stops it on quit.
// Tries `port` first and falls back to an OS-assigned port only when it is taken.
export function createLanHost({ createServer, port = LAN_PORT, host } = {}) {
  let server = null
  let starting = null
  return {
    start() {
      if (!starting) {
        starting = (async () => {
          try {
            server = await createServer(port, host)
          } catch (e) {
            if (!e || e.code !== 'EADDRINUSE') throw e
            server = await createServer(0, host)
          }
          return server.address().port
        })().catch((e) => { starting = null; throw e })
      }
      return starting
    },
    async close() {
      const p = starting
      starting = null
      if (p) { try { await p } catch { /* it never started */ } }
      const s = server
      server = null
      if (s) await new Promise((resolve) => s.close(() => resolve()))
    },
    get running() { return !!server },
  }
}
