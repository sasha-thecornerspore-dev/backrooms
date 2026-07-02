let actx, humGain, humOsc

export function initAudio(config) {
  try {
    actx = new AudioContext()

    // Fluorescent hum
    humOsc  = actx.createOscillator()
    humGain = actx.createGain()
    const humFilter = actx.createBiquadFilter()
    humFilter.type = 'lowpass'
    humFilter.frequency.value = 400
    humOsc.type = 'sawtooth'
    humOsc.frequency.value = config.audio.humFrequency
    humGain.gain.value = 0.018
    humOsc.connect(humFilter)
    humFilter.connect(humGain)
    humGain.connect(actx.destination)
    humOsc.start()

    // Low drone
    const drone     = actx.createOscillator()
    const droneGain = actx.createGain()
    drone.type = 'sine'
    drone.frequency.value = config.audio.droneFrequency
    droneGain.gain.value  = 0.022
    drone.connect(droneGain)
    droneGain.connect(actx.destination)
    drone.start()

    scheduleDistant(config)
  } catch (e) {
    // Web Audio unavailable — silent fallback
  }
}

export function setFlicker(intensity) {
  if (!humOsc || !actx) return
  // Hum pitch drops slightly during flicker
  humOsc.frequency.setTargetAtTime(
    120 * (0.85 + intensity * 0.15),
    actx.currentTime,
    0.05
  )
}

// ── radio — a warbling music-box loop from somewhere that isn't here ──
const RADIO_NOTES = [220, 174.6, 196, 146.8, 220, 261.6, 196, 130.8]
let radioTimer = null
let radioStep = 0

export function setRadio(on) {
  if (!actx) return
  if (on && !radioTimer) {
    radioStep = 0
    radioTimer = setInterval(() => {
      try {
        const osc  = actx.createOscillator()
        const gain = actx.createGain()
        const filt = actx.createBiquadFilter()
        filt.type = 'bandpass'
        filt.frequency.value = 900
        filt.Q.value = 1.2
        osc.type = 'triangle'
        // detuned — the tune is almost right
        osc.frequency.value = RADIO_NOTES[radioStep % RADIO_NOTES.length] * (1 + (Math.random() - 0.5) * 0.02)
        gain.gain.setValueAtTime(0, actx.currentTime)
        gain.gain.linearRampToValueAtTime(0.03, actx.currentTime + 0.04)
        gain.gain.linearRampToValueAtTime(0, actx.currentTime + 0.42)
        osc.connect(filt); filt.connect(gain); gain.connect(actx.destination)
        osc.start()
        osc.stop(actx.currentTime + 0.5)
        radioStep++
      } catch { /* ignore */ }
    }, 480)
  } else if (!on && radioTimer) {
    clearInterval(radioTimer)
    radioTimer = null
  }
}

function scheduleDistant(config) {
  if (!actx) return
  const [minS, maxS] = config.audio.distantEventInterval
  const delay = (minS + Math.random() * (maxS - minS)) * 1000
  setTimeout(() => {
    playDistant()
    scheduleDistant(config)
  }, delay)
}

function playDistant() {
  if (!actx) return
  try {
    const osc    = actx.createOscillator()
    const gain   = actx.createGain()
    const filter = actx.createBiquadFilter()
    filter.type            = 'bandpass'
    filter.frequency.value = 150 + Math.random() * 250
    filter.Q.value         = 2.5
    osc.frequency.value    = 60 + Math.random() * 160
    osc.type               = 'sine'
    gain.gain.setValueAtTime(0, actx.currentTime)
    gain.gain.linearRampToValueAtTime(0.035, actx.currentTime + 0.6)
    gain.gain.linearRampToValueAtTime(0,     actx.currentTime + 3.5)
    osc.connect(filter)
    filter.connect(gain)
    gain.connect(actx.destination)
    osc.start()
    osc.stop(actx.currentTime + 4)
  } catch (e) { /* ignore */ }
}
