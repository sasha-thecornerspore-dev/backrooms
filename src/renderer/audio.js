let actx, humGain, humOsc, ambienceGain

export function initAudio(config) {
  try {
    actx = new AudioContext()

    // Ambience bus — hum, drone and distant events route through here so the
    // whole environmental layer can be toggled independently of the music.
    ambienceGain = actx.createGain()
    ambienceGain.gain.value = 1
    ambienceGain.connect(actx.destination)

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
    humGain.connect(ambienceGain)
    humOsc.start()

    // Low drone
    const drone     = actx.createOscillator()
    const droneGain = actx.createGain()
    drone.type = 'sine'
    drone.frequency.value = config.audio.droneFrequency
    droneGain.gain.value  = 0.022
    drone.connect(droneGain)
    droneGain.connect(ambienceGain)
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

// ── generative weirdcore music ────────────────────────────────────────────
// No files, no loops — a self-generating ambient bed. Detuned breathing pads
// under a "wrong" music-box melody drawn from a per-level scale, washed through
// a generated reverb with tape wow/flutter, a drifting low-pass, and the odd
// pitch-drop. It never repeats and never ends; each level sets its own mood.

// Pure helper (unit-tested): frequency of a scale degree above a root, in Hz.
// Degrees beyond the scale length wrap up through the octaves.
export function scaleFrequency(root, scale, degree, octave = 0) {
  const n = scale.length
  const idx = ((degree % n) + n) % n
  const wraps = Math.floor(degree / n)
  const semis = scale[idx] + 12 * (octave + wraps)
  return root * Math.pow(2, semis / 12)
}

let music = null

function buildReverb(seconds = 3.2, decay = 2.6) {
  const rate = actx.sampleRate
  const len = Math.floor(rate * seconds)
  const buf = actx.createBuffer(2, len, rate)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay)
  }
  const conv = actx.createConvolver()
  conv.buffer = buf
  return conv
}

function initMusic() {
  if (!actx || music) return
  const master = actx.createGain(); master.gain.value = 0        // faded in by setMusic
  const reverb = buildReverb()
  const wet = actx.createGain(); wet.gain.value = 0.5
  const dry = actx.createGain(); dry.gain.value = 0.62
  const bus = actx.createBiquadFilter(); bus.type = 'lowpass'; bus.frequency.value = 1200; bus.Q.value = 0.4
  bus.connect(dry); bus.connect(reverb)
  reverb.connect(wet); wet.connect(master); dry.connect(master)
  master.connect(actx.destination)

  // three sustained pad voices — the chord
  const pad = [0, 1, 2].map(() => {
    const o = actx.createOscillator(); o.type = 'triangle'
    const g = actx.createGain(); g.gain.value = 0
    o.connect(g); g.connect(bus); o.start()
    return { o, g }
  })

  // bass voice — the chord root an octave down, giving the music a floor
  const bassOsc = actx.createOscillator(); bassOsc.type = 'triangle'
  const bassGain = actx.createGain(); bassGain.gain.value = 0
  bassOsc.connect(bassGain); bassGain.connect(bus); bassOsc.start()

  // tape wow/flutter — a slow LFO nudging every pad voice's detune
  const flutter = actx.createOscillator(); flutter.type = 'sine'; flutter.frequency.value = 0.17
  const flutterAmt = actx.createGain(); flutterAmt.gain.value = 6   // cents
  flutter.connect(flutterAmt); pad.forEach(p => flutterAmt.connect(p.o.detune)); flutter.start()

  // slow filter drift — the muffled dream tide
  const drift = actx.createOscillator(); drift.type = 'sine'; drift.frequency.value = 0.045
  const driftAmt = actx.createGain(); driftAmt.gain.value = 300
  drift.connect(driftAmt); driftAmt.connect(bus.frequency); drift.start()

  music = { master, bus, pad, bass: bassOsc, bassGain, mood: null, enabled: true,
            volScale: 1, beatTimer: null, beat: 0, chordTones: [0, 2, 4] }
}

// Move pads + bass to the next chord of the progression (a triad stacked within
// the scale). Glides rather than jumps.
function goToChord(progStep) {
  const m = music, mood = m.mood
  const prog = (mood.progression && mood.progression.length) ? mood.progression : [0]
  const rootDeg = prog[((progStep % prog.length) + prog.length) % prog.length]
  m.chordTones = [rootDeg, rootDeg + 2, rootDeg + 4]
  const t = actx.currentTime
  m.pad.forEach((p, i) => {
    const f = scaleFrequency(mood.root, mood.scale, m.chordTones[i]) * (1 + (Math.random() - 0.5) * 0.004)
    p.o.frequency.setTargetAtTime(f, t, 0.7)
    p.g.gain.setTargetAtTime(0.013, t, 1.0)
  })
  m.bass.frequency.setTargetAtTime(scaleFrequency(mood.root, mood.scale, rootDeg, -1), t, 0.25)
  m.bassGain.gain.setTargetAtTime(0.06, t, 0.4)
}

// A single soft plucked note (used for the arpeggio and the lead melody).
function playPluck(freq, peak, len, bendProb) {
  try {
    const o = actx.createOscillator(), g = actx.createGain()
    o.type = Math.random() < 0.5 ? 'triangle' : 'sine'
    const t = actx.currentTime
    o.frequency.setValueAtTime(freq, t)
    if (bendProb && Math.random() < bendProb) o.frequency.exponentialRampToValueAtTime(freq * 0.5, t + len)
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(peak, t + 0.015)
    g.gain.exponentialRampToValueAtTime(0.0006, t + len)
    o.connect(g); g.connect(music.bus)
    o.start(t); o.stop(t + len + 0.05)
  } catch { /* ignore */ }
}

// One beat: advance the chord on the bar line, ripple an arpeggio up the current
// chord, and occasionally drop a higher lead note. This is what makes it read as
// music instead of random tones.
function onBeat() {
  const m = music, mood = m.mood
  if (!m.enabled) { m.beat++; return }
  const bpc = mood.beatsPerChord ?? 8
  if (m.beat % bpc === 0) goToChord(Math.floor(m.beat / bpc))

  const tones = m.chordTones
  const idx = m.beat % (tones.length * 2)
  const tone = tones[idx % tones.length]
  const oct = 1 + (idx >= tones.length ? 1 : 0)          // arp rises across two octaves
  const af = scaleFrequency(mood.root, mood.scale, tone, oct) * (1 + (Math.random() - 0.5) * (mood.wobble ?? 0.006))
  playPluck(af, 0.03, mood.arpLen ?? 0.55, 0)

  if (m.beat % 4 === 2 && Math.random() < (mood.leadChance ?? 0.35)) {
    const lt = tones[(Math.random() * tones.length) | 0] + (Math.random() < 0.5 ? 1 : 0)
    const lf = scaleFrequency(mood.root, mood.scale, lt, 2) * (1 + (Math.random() - 0.5) * (mood.wobble ?? 0.008))
    playPluck(lf, 0.04, mood.noteLen ?? 1.4, mood.bend ?? 0.12)   // the lead is the one allowed to bend "wrong"
  }
  m.beat++
}

function restartSchedulers() {
  const mood = music.mood
  clearInterval(music.beatTimer)
  music.beat = 0
  goToChord(0)
  music.beatTimer = setInterval(onBeat, mood.tempo ?? 440)
}

// Set the level's mood — the engine morphs into it without stopping.
export function setMusic(mood) {
  if (!actx || !mood) return
  initMusic()
  if (!music) return
  music.mood = mood
  if (music.bus) music.bus.frequency.setTargetAtTime(mood.brightness ?? 1200, actx.currentTime, 2)
  music.master.gain.setTargetAtTime(music.enabled ? (mood.volume ?? 0.06) * music.volScale : 0, actx.currentTime, 2.0)
  restartSchedulers()
}

export function setMusicEnabled(on) {
  if (!music) return
  music.enabled = on
  const vol = on ? (music.mood?.volume ?? 0.06) * music.volScale : 0
  music.master.gain.setTargetAtTime(vol, actx.currentTime, 0.8)
}

// Scale the music level as a percentage (0–150) of each level's base volume.
export function setMusicVolume(pct) {
  if (!music || !actx) return
  music.volScale = Math.max(0, Math.min(1.5, (pct ?? 100) / 100))
  const vol = music.enabled ? (music.mood?.volume ?? 0.06) * music.volScale : 0
  music.master.gain.setTargetAtTime(vol, actx.currentTime, 0.5)
}

export function toggleMusic() {
  if (!music) return false
  setMusicEnabled(!music.enabled)
  return music.enabled
}

export function isMusicOn() { return !!(music && music.enabled) }

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
    gain.connect(ambienceGain || actx.destination)
    osc.start()
    osc.stop(actx.currentTime + 4)
  } catch (e) { /* ignore */ }
}

// Toggle the whole environmental layer (hum / drone / distant events).
export function setAmbience(on) {
  if (!ambienceGain || !actx) return
  ambienceGain.gain.setTargetAtTime(on ? 1 : 0, actx.currentTime, 0.5)
}
