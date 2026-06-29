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
