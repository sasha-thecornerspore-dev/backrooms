// relay/wishgate.js — the pure half of the relay's POST /wish (and the gate GET /maps shares).
//
// A wish used to be filed by the desktop app itself, with a GitHub token baked into every installer — anyone could lift it
// out of app.asar. Now the app and the browser both POST { text, meta, version } here, and only the relay holds a key
// (env.GITHUB_TOKEN, a wrangler secret). This file decides everything that can be decided without the network: the body's
// shape, a short word filter, the issue the app has always filed, the one request that carries the token, the per-address
// limiter's arithmetic and the origins a browser may call from. relay.js does the I/O.
//
// Title and labels are src/wish-labels.js's, imported, not copied: one builder for the issue, and its trailer parser is
// status.js's (the docket tool reads the same one). The labels can only ever be the six the pipeline knows — a stranger's
// text never names one, so no body can label an issue 'granted'.
import { wishTitle, wishLabels } from '../src/wish-labels.js'
import { ORIGINS } from '../src/renderer/origin-intake.js'

export const WISH_MAX = 500                                // the dialog caps at 280; the trailer and some slack ride on top
export const BODY_MAX = 4096                               // bytes of request body the relay will read at all
export const DEFAULT_REPO = 'sasha-thecornerspore-dev/backrooms'
export const DAY_MS = 86_400_000

// the site, the itch CDN (an itch HTML game is served from these), and the desktop app's file:// page ('null' to a browser).
// A request with no Origin at all is the desktop app's main process (or a script): CORS is a browser's rule, the gate is ours.
export const ALLOWED_ORIGINS = Object.freeze(['https://backrooms.thecornerspore.dev', 'https://html-classic.itch.zone', 'https://html.itch.zone',
  'https://v6p9d9t4.ssl.hwcdn.net', 'null', 'file://'])
// POST /wish is narrower: the site and the itch CDN only. Nothing real files a wish with Origin 'null' or 'file://' (the desktop app
// files from its main process, which sends none), while any page can send one — a sandboxed iframe or a data: URL is 'null' — and so
// turn its visitors into a flood of wishes under the owner's token, each from a fresh address. GET /maps keeps the desktop page's two.
export const WISH_ORIGINS = Object.freeze(ALLOWED_ORIGINS.filter((o) => o.startsWith('https://')))

export function originOk(origin, allowed = ALLOWED_ORIGINS) {
  return origin == null || allowed.includes(origin)
}

export function corsHeaders(origin, allowed = ALLOWED_ORIGINS) {
  if (origin == null || !allowed.includes(origin)) return { Vary: 'Origin' }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

// ── the body ─────────────────────────────────────────────────────────────────────────────────
const KEYS = new Set(['text', 'meta', 'version'])
const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,32})?$/
// no control characters but the newline before a trailer and a tab: the issue is read by a person and by the docket tool
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/

// → { ok: true, wish: { text, meta: { origin }, version } } | { ok: false, reason: 'body' | 'text' | 'meta' | 'version' }
export function validateWish(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'body' }
  for (const k of Object.keys(body)) if (!KEYS.has(k)) return { ok: false, reason: 'body' }
  const { text, meta, version } = body
  if (typeof text !== 'string' || !text.trim() || text.length > WISH_MAX || CONTROL_RE.test(text)) return { ok: false, reason: 'text' }
  // the shape compose-wish.js sends: rules.wishMeta() is { origin } — null, or one of origin-intake.js's four
  let origin = null
  if (meta != null) {
    if (typeof meta !== 'object' || Array.isArray(meta)) return { ok: false, reason: 'meta' }
    for (const k of Object.keys(meta)) if (k !== 'origin') return { ok: false, reason: 'meta' }
    if (meta.origin != null && !ORIGINS.includes(meta.origin)) return { ok: false, reason: 'meta' }
    origin = meta.origin ?? null
  }
  if (version != null && (typeof version !== 'string' || !VERSION_RE.test(version))) return { ok: false, reason: 'version' }
  return { ok: true, wish: { text, meta: { origin }, version: version ?? null } }
}

// ── the word filter ──────────────────────────────────────────────────────────────────────────
// Short and conservative on purpose: a person reads every wish before anything is granted, so this only keeps the worst out
// of a public issue tracker. Whole words only (a niggling hum, a spicy smell and the crypt all pass); a scream passes.
const WORDS = [
  /\bn+[i1!|]+g{2,}(?:[e3]+r+|a+|ah|uh)s?\b/,
  /\bf+[a@4]+g{2,}[o0]+t+s?\b/,
  /\bk[i1]kes?\b/,
  /\bsp[i1]cs?\b/,
  /\btr[a@4]nn(?:y|ies)\b/,
  /\bwetbacks?\b/,
  /\bgooks?\b/,
  /\bheil\s+hitler\b/,
  /\bsieg\s+heil\b/,
]
const SPAM = [
  /https?:\/\//,
  /\bwww\./,
  /\bdiscord\.(?:gg|com\/invite)\b/,
  /\bt\.me\//,
  /\b(?:bit\.ly|tinyurl\.com)\b/,
  /[\w.+-]+@[\w-]+\.[a-z]{2,}/,                              // an address in a public issue is someone's privacy
  // (a @mention is not refused: buildIssue quiets every one, so '@3am' still reaches the person who reads the wishes)
  /&(?:#0*64|#x0*40|commat);/,                                 // an '@' spelled as an entity renders as one, past buildIssue's quieting
  /\b[\w.-]+\/[\w.-]+#\d+/,                                   // owner/repo#1: a cross-reference on a stranger's issue, from the owner's account
  /<[a-z!\/?]/,                                                // any tag or <!-- comment -->: text the person who reads the wish would not see
  /\]\s*\(/,                                                   // a markdown link
  /(?:^|[\s("'=])\/\/[a-z0-9-]+\.[a-z]/,                       // a protocol-relative link (//host.example)
  /\bfree\s+(?:robux|v-?bucks|nitro)\b/,
  /\bonlyfans\b/,
  /\b(?:viagra|cialis)\b/,
  /\bporn/,
]

// → null (it may be filed) | 'words' | 'spam'
export function filterWish(text) {
  const t = String(text).toLowerCase()
  if (WORDS.some((re) => re.test(t))) return 'words'
  if (SPAM.some((re) => re.test(t))) return 'spam'
  return null
}

// ── the issue ────────────────────────────────────────────────────────────────────────────────
// An '@' a name could follow gets a zero-width space after it, so GitHub links no mention: '@someone', '@@someone' and '@org/team'
// ping nobody from the owner's account, and a sincere '@3am' or '@midnight' is still filed, reading the same. The trailer has no '@'.
const MENTION_RE = /@(?=[a-z0-9])/gi
export function quietMentions(text) { return String(text).replace(MENTION_RE, '@​') }

// the desktop app's issue, byte for byte (the body's last line says where it came from: a browser sends no version), its mentions quiet
export function buildIssue({ text: said, meta, version }) {
  const text = quietMentions(said)
  const appVersion = version
  return {
    title: wishTitle(text),
    body: appVersion ? `${text}\n\n---\nsubmitted from backrooms v${appVersion}` : `${text}\n\n---\nsubmitted from backrooms on the web`,
    labels: wishLabels(text, meta),
  }
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
// the one request that carries the token — in the Authorization header, never in the body or the URL
export function issueRequest(issue, { repo, token } = {}) {
  const slug = typeof repo === 'string' && REPO_RE.test(repo) && !repo.includes('..') ? repo : DEFAULT_REPO
  return {
    url: `https://api.github.com/repos/${slug}/issues`,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'backrooms-relay',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ title: issue.title, body: issue.body, labels: issue.labels }),
    },
  }
}

// ── the gate's arithmetic ────────────────────────────────────────────────────────────────────
// Every rule is { windowMs, max }: at most max takes in any window of windowMs. The Gate durable object (relay.js) keeps one
// list of take times per bucket per hashed address and wipes it all a day after the last take. wishAll is the one bucket every
// sender shares (the Gate named GLOBAL_GATE): however many addresses someone has, the relay files at most that many wishes a day.
const MIN = 60_000
export const GLOBAL_GATE = 'global'
export const GATE_RULES = Object.freeze({
  wish: Object.freeze([Object.freeze({ windowMs: 10 * MIN, max: 3 }), Object.freeze({ windowMs: DAY_MS, max: 10 })]),
  wishAll: Object.freeze([Object.freeze({ windowMs: DAY_MS, max: 300 })]),
  maps: Object.freeze([Object.freeze({ windowMs: 10 * MIN, max: 12 }), Object.freeze({ windowMs: DAY_MS, max: 60 })]),
})

// stamps: the stored take times (anything else reads as none). → { ok, stamps (pruned to the longest window, plus now when
// ok), retryMs (0 when ok; else how long until the oldest blocking take leaves its window) }. Never mutates its input.
export function gateTake(stamps, now, rules) {
  const longest = Math.max(...rules.map((r) => r.windowMs))
  const kept = (Array.isArray(stamps) ? stamps : []).filter((t) => typeof t === 'number' && Number.isFinite(t) && t > now - longest)
  kept.sort((a, b) => a - b)
  let retryMs = 0
  for (const r of rules) {
    const inWin = kept.filter((t) => t > now - r.windowMs)
    if (inWin.length >= r.max) retryMs = Math.max(retryMs, inWin[inWin.length - r.max] + r.windowMs - now)
  }
  if (retryMs > 0) return { ok: false, stamps: kept, retryMs }
  kept.push(now)
  return { ok: true, stamps: kept, retryMs: 0 }
}

// Who one sender is: an IPv4 address, or an IPv6 address's /64. A home line or a VPS is handed a whole /64 (2^64 addresses to pick
// from at will), so keying on the full IPv6 address would be a fresh gate per request. An IPv4-mapped address (::ffff:a.b.c.d) is that
// IPv4. What does not read as an address is kept as it came (it still gets a gate of its own).
const HEX4 = /^[0-9a-f]{1,4}$/
const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
export function gateKey(ip) {
  const raw = String(ip ?? '').trim().toLowerCase()
  if (!raw.includes(':')) return raw
  const a = raw.replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  const halves = a.split('::')
  if (halves.length > 2) return raw
  const part = (h) => (h ? h.split(':') : [])
  const head = part(halves[0]), tail = part(halves[1])
  const last = halves.length === 2 ? tail : head
  const v4 = last.length ? last[last.length - 1].match(V4) : null
  if (v4) {
    const n = v4.slice(1).map(Number)
    if (n.some((x) => x > 255)) return raw
    last.splice(-1, 1, ((n[0] << 8) | n[1]).toString(16), ((n[2] << 8) | n[3]).toString(16))
  }
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0 || (halves.length === 2 && fill === 0)) return raw
  const g = [...head, ...Array(fill).fill('0'), ...tail]
  if (g.length !== 8 || !g.every((x) => HEX4.test(x))) return raw
  const w = g.map((x) => parseInt(x, 16))
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return `${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`
  return w.slice(0, 4).map((x) => x.toString(16)).join(':') + '::/64'
}

// the gate's name: a salted SHA-256 of the sender (gateKey of CF-Connecting-IP), cut to 128 bits. The address itself is never stored.
export async function hashIp(ip, salt) {
  const data = new TextEncoder().encode(`${salt}|${ip || 'unknown'}`)
  const buf = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  let hex = ''
  for (let i = 0; i < 16; i++) hex += buf[i].toString(16).padStart(2, '0')
  return hex
}
