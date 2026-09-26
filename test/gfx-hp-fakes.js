// Fakes shared by the track HP tests (not a test file itself): a recording 2D document and a WebGL2 context that is good enough to CREATE and
// RUN the GPU post pass (gfx-gl-post.js) in Node. Nothing is drawn; the point is lifecycle, bookkeeping and the calls made.

// A document whose canvases hand out a recording 2D context. doc.created counts canvases (doc.canvases lists them); each context counts its gradients (ctx.gradients) and
// logs its calls (ctx.calls: [name, ...args]); doc.gradients is the total.
export function fakeDoc2d() {
  const doc = { created: 0, gradients: 0, canvases: [] }
  const mkCtx = (canvas) => {
    const calls = []
    const t = { canvas, calls, gradients: 0 }
    const grad = () => { t.gradients++; doc.gradients++; return { addColorStop() {} } }
    return new Proxy(t, {
      get(o, k) {
        if (k in o) return o[k]
        if (k === 'createLinearGradient' || k === 'createRadialGradient') return grad
        if (k === 'createPattern') return () => ({})
        if (k === 'measureText') return () => ({ width: 10 })
        if (k === 'createImageData' || k === 'getImageData') return (...a) => { const [w, h] = k === 'createImageData' ? a : a.slice(2); calls.push([k, ...a]); return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h } }
        return (...a) => { calls.push([k, ...a]) }
      },
      set(o, k, v) { o[k] = v; return true },
    })
  }
  doc.createElement = () => {
    doc.created++
    let ctx = null
    const c = {
      width: 300, height: 150, style: {}, dataset: {}, parentNode: null, ownerDocument: doc,
      setAttribute() {}, remove() {}, addEventListener() {},
      getContext() { return ctx || (ctx = mkCtx(c)) },
    }
    doc.canvases.push(c)
    return c
  }
  return doc
}

// Every uniform a GLSL source declares (`uniform vec3 uA, uB;` included), array names with the "[0]" a driver reports.
function uniformsOf(src) {
  const out = []
  for (const m of src.matchAll(/^\s*uniform\s+(?:(?:highp|mediump|lowp)\s+)?\w+\s+([^;]+);/gm)) {
    for (const part of m[1].split(',')) { const n = part.trim(); const a = /^(\w+)\s*\[/.exec(n); out.push(a ? `${a[1]}[0]` : n) }
  }
  return out
}

// A fake WebGL2 context. `o.parallel` exposes KHR_parallel_shader_compile (COMPLETION_STATUS_KHR answers `state.ready(program)`), `o.failCompile`
// = a source substring whose FRAGMENT shader fails to compile, `o.failLink` = a source substring whose program fails to link, `o.dropUniform` = a
// uniform the "driver" optimised away (never reported active). state: counters and
// logs (compiles, links, statusQueries, deleted programs).
export function fakeGl(o = {}) {
  const ids = new Map()
  const K = (name) => { if (!ids.has(name)) ids.set(name, 0x1000 + ids.size); return ids.get(name) }
  const state = { shaders: 0, programs: [], statusQueries: 0, deletedPrograms: 0, deletedShaders: 0, ready: () => true, calls: [] }
  const PARALLEL = { COMPLETION_STATUS_KHR: 0x91B1 }
  const t = {
    state,
    NO_ERROR: 0, drawingBufferWidth: 1, drawingBufferHeight: 1,
    isContextLost: () => false, getError: () => 0,
    getExtension: (n) => (n === 'KHR_parallel_shader_compile' ? (o.parallel ? PARALLEL : null) : n.startsWith('EXT_color_buffer') ? {} : null),
    getParameter: () => 4096,
    createShader: (type) => { state.shaders++; return { type, src: '', ok: true } },
    shaderSource: (s, src) => { s.src = src },
    compileShader: (s) => { s.ok = !(o.failCompile && s.type === proxy.FRAGMENT_SHADER && s.src.includes(o.failCompile)) },
    getShaderParameter: (s) => s.ok,
    getShaderInfoLog: () => 'fake compile log',
    deleteShader: () => { state.deletedShaders++ },
    createProgram: () => { const p = { shaders: [], linked: false }; state.programs.push(p); return p },
    attachShader: (p, s) => { p.shaders.push(s) },
    linkProgram: (p) => {
      p.linked = true
      p.uniforms = [...new Set(p.shaders.flatMap((s) => uniformsOf(s.src)))].filter((n) => n !== o.dropUniform)
      p.ok = p.shaders.every((s) => s.ok) && !(o.failLink && p.shaders.some((s) => s.src.includes(o.failLink)))
    },
    getProgramParameter: (p, pn) => {
      if (pn === PARALLEL.COMPLETION_STATUS_KHR) return state.ready(p)
      state.statusQueries++
      if (pn === proxy.LINK_STATUS) return p.ok
      if (pn === proxy.ACTIVE_UNIFORMS) return p.uniforms.length
      return 0
    },
    getProgramInfoLog: () => 'fake link log',
    getActiveUniform: (p, i) => ({ name: p.uniforms[i] }),
    getUniformLocation: (p, n) => ({ n }),
    deleteProgram: () => { state.deletedPrograms++ },
    checkFramebufferStatus: () => proxy.FRAMEBUFFER_COMPLETE,
  }
  const proxy = new Proxy(t, {
    get(obj, k) {
      if (k in obj) return obj[k]
      if (typeof k === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k)) return K(k)
      return (...a) => { state.calls.push(k); return k.startsWith('create') ? {} : null }
    },
  })
  return proxy
}
