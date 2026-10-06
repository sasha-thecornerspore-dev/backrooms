// messages.js — the one voice of the building: a priority queue for the HUD line, so nothing talks over 'it has you.'
//
// PRIO: ambient 0 (floor murmurs) < discovery 1 (what you found) < interaction 2 (what you did) < combat 3 (what has you).
// createMessageQueue({ dwellS, holdS, discoveryGapS }) -> { push(text, prio), tick(dt) -> null | { text, show }, clear() }
//   - a line holds holdS seconds, then ONE tick returns { show: false } so the caller fades the element
//   - a push above the current priority replaces it at once; at or below, it waits until the current line has been visible dwellS
//   - discovery lines queue FIFO, deduped by exact text, never dropped, at most one shown per discoveryGapS
//   - ambient lines are dropped unless the queue is idle (nothing showing, nothing waiting)
//   - interaction lines queue behind a combat line; past 2 waiting the OLDEST goes (the player acted again: that result is stale)
//   - the same text pushed while it shows re-arms its hold (no flicker)
//   - tick() hands back ONE reused result object or null; the idle path allocates nothing
export const PRIO = Object.freeze({ ambient: 0, discovery: 1, interaction: 2, combat: 3 })

const MAX_WAITING_INTERACTION = 2

export function createMessageQueue({ dwellS = 1.6, holdS = 4.2, discoveryGapS = 6 } = {}) {
  const qCombat = [], qInteraction = [], qDiscovery = []     // texts only: the queue a line waits in IS its priority
  const res = { text: '', show: false }
  let cur = null, curPrio = -1                                // the line on screen (null = idle)
  let visT = 0                                                // how long cur has been reported visible
  let holdLeft = 0                                            // time until cur fades
  let sinceDisc = Infinity                                    // time since a discovery line was shown (Infinity: never, so the first is free)
  let dirty = false                                           // cur changed since a tick last reported it
  let hideText = null                                         // clear() while a line showed: report one hide

  function setCur(text, prio) { cur = text; curPrio = prio; visT = 0; holdLeft = holdS; dirty = true }
  const waiting = () => qCombat.length + qInteraction.length + qDiscovery.length

  function push(text, prio) {
    if (!text) return
    if (cur !== null && text === cur) { holdLeft = holdS; return }                      // re-arm the hold, no flicker
    if (prio === PRIO.ambient) { if (cur === null && waiting() === 0) setCur(text, prio); return }
    if (prio === PRIO.discovery) {
      if (qDiscovery.indexOf(text) !== -1) return                                        // deduped by exact text
      if ((cur === null || prio > curPrio) && sinceDisc >= discoveryGapS) setCur(text, prio)
      else qDiscovery.push(text)                                                         // never dropped
      return
    }
    if (cur === null || prio > curPrio) { setCur(text, prio); return }                 // combat always wins instantly
    if (prio >= PRIO.combat) { qCombat.push(text); return }
    qInteraction.push(text)
    while (qInteraction.length > MAX_WAITING_INTERACTION) qInteraction.shift()          // the oldest result is stale
  }

  // the next waiting line, highest queue first; a discovery only once its gap has passed
  function promote() {
    if (qCombat.length) setCur(qCombat.shift(), PRIO.combat)
    else if (qInteraction.length) setCur(qInteraction.shift(), PRIO.interaction)
    else if (qDiscovery.length && sinceDisc >= discoveryGapS) setCur(qDiscovery.shift(), PRIO.discovery)
  }

  function tick(dt) {
    if (hideText !== null) { res.text = hideText; res.show = false; hideText = null; return res }
    if (cur !== null && !dirty) { visT += dt; holdLeft -= dt }                           // a line not yet reported has not been seen
    sinceDisc += dt
    if (cur === null || visT >= dwellS) promote()
    if (cur !== null && holdLeft <= 0) { res.text = cur; res.show = false; cur = null; curPrio = -1; return res }
    if (dirty) {
      dirty = false
      if (curPrio === PRIO.discovery) sinceDisc = 0                                      // the gap runs from when it was shown
      res.text = cur; res.show = true
      return res
    }
    return null
  }

  function clear() {
    qCombat.length = 0; qInteraction.length = 0; qDiscovery.length = 0
    if (cur !== null && !dirty) hideText = cur                                           // it was on screen: fade it once
    cur = null; curPrio = -1; visT = 0; holdLeft = 0; dirty = false; sinceDisc = Infinity
  }

  return { push, tick, clear }
}
