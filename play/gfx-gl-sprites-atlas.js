// gfx-gl-sprites-atlas.js — the GPU sprite atlas's bookkeeping: a shelf packer and the manager that maps a sprite layer's mip (the premultiplied
// ABGR Uint32 texels gfx-sprites.js builds) to a rectangle of the atlas texture, uploading it the first time it is asked for. Pure: the actual
// texSubImage2D lives behind an `upload` callback, so this is unit-tested in Node (test/gfx-gl-sprites-atlas.test.js) and the GL pass only
// supplies the callback.
//
//   * Mips are uploaded ON DEMAND (the CPU picks one mip per sprite from its on-screen height, exactly as pickMip does for the CPU blitter), so
//     the atlas holds what the current view needs, not every frame the level could ever show.
//   * Each rectangle has a 1-texel transparent gutter around it so bilinear filtering never bleeds a neighbour in.
//   * Atlas full -> rectFor() returns null; the caller flush()es (forgets every rect; the next frame re-uploads what it needs) and plans again.

// A shelf packer. Items are placed left to right on horizontal shelves; a new shelf is opened when nothing fits. `gap` texels of padding
// are added on the right and bottom of every item (gutters are shared: the item's own gutter is its right/bottom neighbour's left/top one).
export class ShelfPacker {
  constructor(w, h, gap = 1) { this.w = w; this.h = h; this.gap = gap; this.reset() }
  reset() { this.shelves = []; this.nextY = 0; this.used = 0 }
  // -> { x, y } of the item's top-left texel (the gap lies to its right and below), or null when it does not fit
  alloc(iw, ih) {
    const g = this.gap, pw = iw + g, ph = ih + g
    if (iw <= 0 || ih <= 0 || pw > this.w || ph > this.h) return null
    let best = null, bestWaste = Infinity
    for (let i = 0; i < this.shelves.length; i++) {
      const s = this.shelves[i]
      if (s.h >= ph && s.x + pw <= this.w && s.h <= ph * 1.6 + 8) {       // do not park a tiny item on a very tall shelf
        const waste = s.h - ph
        if (waste < bestWaste) { bestWaste = waste; best = s }
      }
    }
    if (best === null) {
      if (this.nextY + ph > this.h) {
        // no room for a new shelf: fall back to ANY shelf that is tall enough
        for (let i = 0; i < this.shelves.length; i++) { const s = this.shelves[i]; if (s.h >= ph && s.x + pw <= this.w) { best = s; break } }
        if (best === null) return null
      } else {
        best = { y: this.nextY, h: ph, x: 0 }
        this.shelves.push(best); this.nextY += ph
      }
    }
    const x = best.x; best.x += pw
    this.used += iw * ih
    return { x, y: best.y }
  }
  get fill() { return this.used / (this.w * this.h) }
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1
export const isLittleEndian = () => LITTLE_ENDIAN

// upload(x, y, w, h, rgba8 (Uint8Array view of the mip's texels), rim8 (Uint8Array | null))
// The atlas starts at `size` and may GROW (double, up to maxSize) when it fills again soon after a flush: `resize(newSize)` reallocates the textures
// (it may throw, e.g. out of memory: the atlas then keeps its size and never tries again). A flush is the normal reclaim (the mips a moving camera
// stops asking for are dropped); growing is only for a working set that does not fit.
export const THRASH_FRAMES = 240
export function createAtlasManager({ size, maxSize = size, upload, resize = null }) {
  let packer = new ShelfPacker(size, size, 1)
  let rects = new WeakMap()
  const st = { size, generation: 0, uploads: 0, flushes: 0, grows: 0, texels: 0 }
  let lastFlush = -Infinity, growable = !!resize && maxSize > size
  const api = {
    st,
    get packer() { return packer },
    get size() { return size },
    get canGrow() { return growable && size < maxSize },
    // the rectangle of a mip in the atlas: { x, y, w, h, rim } (texel coordinates of the interior), or null when the atlas is full
    rectFor(mip) {
      let r = rects.get(mip)
      if (r !== undefined) return r
      const p = packer.alloc(mip.w + 1, mip.h + 1)      // +1: a leading gutter texel (the trailing one is the packer's gap)
      if (p === null) return null
      r = { x: p.x + 1, y: p.y + 1, w: mip.w, h: mip.h, rim: !!mip.rim }
      const px = mip.px
      upload(r.x, r.y, r.w, r.h, new Uint8Array(px.buffer, px.byteOffset, px.byteLength), mip.rim || null)
      rects.set(mip, r)
      st.uploads++; st.texels += mip.w * mip.h
      return r
    },
    // forget everything; the caller re-plans and the needed mips are uploaded again. (The texture is not cleared: stale texels are never read,
    // because a rect is only ever sampled inside its own interior.)
    flush() { packer.reset(); rects = new WeakMap(); st.generation++; st.flushes++ },
    // a bigger, empty atlas (every rect is forgotten, like a flush). false when it cannot grow (already at maxSize, or the reallocation failed)
    grow() {
      if (!api.canGrow) return false
      const n = Math.min(maxSize, size * 2)
      try { resize(n) } catch { growable = false; return false }
      size = n; st.size = n; st.grows++
      packer = new ShelfPacker(n, n, 1); rects = new WeakMap(); st.generation++
      return true
    },
    // the atlas is full at `frame`: grow when it filled again within THRASH_FRAMES of the last flush (or when `must`: one frame alone did not fit),
    // otherwise flush. Returns 'grow' | 'flush'.
    recover(frame, must = false) {
      const thrash = frame - lastFlush < THRASH_FRAMES
      lastFlush = frame
      if ((must || thrash) && api.grow()) return 'grow'
      api.flush()
      return 'flush'
    },
  }
  return api
}
