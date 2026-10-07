// wish-labels.js — the issue's title and labels for a submitted wish (main process).
//
// Pure, beside webhook.js, so it is testable without Electron. A wish filed under a status
// carries a trailer as its last line ('filed under: EXTENSION · level 2' — status.js
// wishTrailer); the title keeps the FIRST line only, so the grant workflow's slug and the
// arbiter's view never carry it, and the labels read it through status.js's one parser.
import { parseTrailer } from './renderer/status.js'

// a plain one-line wish yields today's title byte for byte
export function wishTitle(text) {
  return `[WISH] ${String(text).split('\n')[0].slice(0, 120)}`
}

// ['wish', 'pending'] for a plain wish; + 'status:<s>' for a trailer; + 'amendment' for a processed wanderer
export function wishLabels(text, meta) {
  const t = parseTrailer(text)
  return [
    'wish', 'pending',
    ...(t ? [`status:${t.status}`] : []),
    ...(meta?.origin === 'processed' ? ['amendment'] : []),
  ]
}
