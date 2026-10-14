// wish-post.js — a wish leaves the room: one POST to the relay's /wish, which files it where someone reads it.
//
// The one path for both builds: the desktop app's main process ('submit-wish' in main.js) and a browser, where game.js has no
// window.backrooms to hand it to. Neither carries a key: the relay holds the only one (relay/relay.js, env.GITHUB_TOKEN) and
// builds the issue itself from { text, meta } (relay/wishgate.js) — title, labels and all — so nothing a client sends can
// label an issue. A browser sends no version; the issue says it came from the web. Pure but for the fetch it is handed.

export const WISH_URL = 'https://backrooms-relay.jeff-schatz112.workers.dev/wish'

// → the relay's answer, { ok: true, number } | { ok: false, reason }; a network failure rejects (the callers stay silent)
export async function postWish(text, meta, { version = null, fetch: f = globalThis.fetch } = {}) {
  const res = await f(WISH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, meta: meta ?? null, ...(version ? { version } : {}) }),
  })
  let out = null
  try { out = await res.json() } catch { /* not the relay's answer */ }
  return out && typeof out.ok === 'boolean' ? out : { ok: false, reason: `http ${res.status}` }
}
