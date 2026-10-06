// Fakes shared by the audio tests (not a test file itself): a minimal AudioContext that is good enough to CREATE and RUN audio.js in Node.
// Nothing is heard; the point is the graph (every connect() edge), the params scheduled and the sources started / stopped. Mirrors
// gfx-hp-fakes.js, which does the same for the 2D document and WebGL2.
//
// installFakeAudioContext() -> { nodes, restore }
//   installs globalThis.AudioContext (sampleRate 48000, currentTime a plain writable number starting at 0, destination a node of kind
//   'destination'); nodes = { all, edges, ctxs }: all lists every node created in order (kind, out = its connect() targets; sources also
//   started / stopped), edges lists [from, to] for every connect() (to is a node or an AudioParam), ctxs the contexts constructed.
//   restore() puts the previous global back, or removes it when there was none.
export function installFakeAudioContext() {
  const nodes = { all: [], edges: [], ctxs: [] }

  // an AudioParam: keeps the last value scheduled and logs every call as [name, ...args]
  function param(value) {
    const p = { kind: 'param', value, calls: [] }
    const sched = (name) => (v, ...rest) => { p.calls.push([name, v, ...rest]); p.value = v; return p }
    p.setValueAtTime = sched('setValueAtTime')
    p.linearRampToValueAtTime = sched('linearRampToValueAtTime')
    p.exponentialRampToValueAtTime = sched('exponentialRampToValueAtTime')
    p.setTargetAtTime = sched('setTargetAtTime')
    p.cancelScheduledValues = (t) => { p.calls.push(['cancelScheduledValues', t]); return p }
    p.setValueCurveAtTime = (curve, t, d) => { p.calls.push(['setValueCurveAtTime', curve, t, d]); p.value = curve[curve.length - 1]; return p }
    return p
  }

  function node(kind, fields, track = true) {
    const n = Object.assign({ kind, out: [] }, fields)
    n.connect = (to) => { n.out.push(to); nodes.edges.push([n, to]); return to }
    n.disconnect = (to) => { if (to === undefined) n.out.length = 0; else { const i = n.out.indexOf(to); if (i >= 0) n.out.splice(i, 1) } }
    if (track) nodes.all.push(n)
    return n
  }
  function source(kind, fields) {
    const n = node(kind, Object.assign({ started: [], stopped: [], onended: null }, fields))
    n.start = (t = 0) => { n.started.push(t) }
    n.stop = (t = 0) => { n.stopped.push(t) }
    return n
  }

  class FakeAudioContext {
    constructor() {
      this.sampleRate = 48000
      this.currentTime = 0
      this.state = 'running'
      this.destination = node('destination', {}, false)
      nodes.ctxs.push(this)
    }
    createGain()          { return node('gain', { gain: param(1) }) }
    createOscillator()    { return source('oscillator', { type: 'sine', frequency: param(440), detune: param(0) }) }
    createBiquadFilter()  { return node('biquad', { type: 'lowpass', frequency: param(350), Q: param(1), gain: param(0), detune: param(0) }) }
    createStereoPanner()  { return node('panner', { pan: param(0) }) }
    createConvolver()     { return node('convolver', { buffer: null, normalize: true }) }
    createBufferSource()  { return source('buffer-source', { buffer: null, loop: false, playbackRate: param(1), detune: param(0) }) }
    createBuffer(numberOfChannels, length, sampleRate) {
      const data = []
      return { numberOfChannels, length, sampleRate, duration: length / sampleRate,
               getChannelData(i) { return data[i] || (data[i] = new Float32Array(length)) } }
    }
    resume()  { this.state = 'running'; return Promise.resolve() }
    suspend() { this.state = 'suspended'; return Promise.resolve() }
    close()   { this.state = 'closed'; return Promise.resolve() }
  }

  const had = 'AudioContext' in globalThis, prev = globalThis.AudioContext
  globalThis.AudioContext = FakeAudioContext
  function restore() { if (had) globalThis.AudioContext = prev; else delete globalThis.AudioContext }
  return { nodes, restore }
}
