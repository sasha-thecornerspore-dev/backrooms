// gfx-block-facade.js — Level ∅ ("the block"): the facade recipes and the bay compositor, the procedural art of the block in its Harlem
// Park look (rowhouse backs of brick, painted brick, formstone and marble; sealed and boarded doors, windows, the yard).
//
// Parts I–III are the recipe set: a core (conventions, noise, rasters, exact coverage, layouts, the colour rule, decals, the glyph test)
// and the painters built on it. Each painter is a recipe (w_m, h_m, tpm, seed, matHex, opts) → raster, and the same arguments give the
// same texels at any texel density (VERSION and VERSIONS name the set and its three parts). The noise grids are filled only where a
// sample reads them (§2), and every painter, the passes it runs and the compositor are generators that can pause between raster rows
// (§3b), so the game can build the block's tiles a few ms at a time while its title is up; the plain calls (recipe(...),
// paintBayElevation(...)) run them in one go.
// Part IV is paintBayElevation, the compositor that lays the recipes into one bay's elevation (a cladding field with pieces cut into
// it: a door, a board, a window, a sill), which gfx-textures.js builds the block's material tiles with (MATERIAL_STYLES_HP).
//
// Pure, seeded, resolution-independent (every layout in metres) and Node-safe: no DOM, no Math.random, no image reads, no file I/O, no
// state that outlives a call. Nothing here paints a digit, a letter, a word or a symbol: the crew mark is re-rolled until it clears the
// glyph test (§11) and the placard is a plain sheet with one band.
//
//   PART I    the core: conventions, PRNG and hashing, periodic noise, rasters, exact coverage, layouts, the colour rule, decals and masks,
//             EDGE, the recipe scaffold, the glyph test
//   PART II   the masonry painters: pressed / common / painted brick, formstone, marble, CMU, parge and party walls, arch bands
//   PART III  the surface painters: the crew mark, plywood, the placard, painted wood, door leaf, vent panel, asphalt, concrete, granite,
//             the yard, windows
//   PART IV   the bay compositor (paintBayElevation)

export const VERSION = 'gfx-block-facade 1'
export const VERSIONS = Object.freeze({ core: 'gfx-block-facade core 1', masonry: 'gfx-block-facade masonry 1', surface: 'gfx-block-facade surface 1' })

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  PART I — THE CORE: what every recipe shares (conventions, noise, rasters, exact coverage, layouts, the colour rule, decals, the recipe
//  scaffold, the glyph test). The painters of parts II and III are built ON it, so everything exported below is a stable contract: add,
//  never change.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// Pure, seeded and Node-safe, in the style of gfx-textures.js: no DOM, no Math.random, no image reads, no imports, no state that outlives
// a call (only the polygon clipper's scratch buffers and a layer index's query stamp, neither of which can change an output). Nothing
// here touches a file.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  CONVENTIONS (every function below follows them)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  Units    METRES everywhere: layouts, noise periods and feature sizes, decal sizes, the height channel. tpm = texels per metre:
//           JS_TPM 32 (the game's 64 texels per 2 m cell), FINE_TPM 128 (the fine density; REF_TPM, the filter's reference, is the same).
//  Axes     x runs right along the face, y runs DOWN from the top edge of the tile: (0, 0) is the top-left corner and y = h_m is the
//           FOOT of the wall. Texel (tx, ty) covers [tx·sx, (tx+1)·sx) × [ty·sy, (ty+1)·sy), sx = w_m / w, sy = h_m / h. Row 0 is the
//           top, as in gfx-textures.js (gfx-world.js:320). Mirroring on east/north faces is the renderer's business, never a recipe's.
//  Raster   { w, h, w_m, h_m, tpm, sx, sy, rgb, cav, height, meta? }   (newRaster)
//             w = round(w_m·tpm), h = round(h_m·tpm)
//             rgb     Float32Array(w·h·3)  display-referred values, 0..255 (used as they are: no colour-space conversion)
//             cav     Float32Array(w·h)    cavity / AO, 0..1: 1 = open face, lower = joint, pit, recess (no light direction)
//             height  Float32Array(w·h) | null   metres relative to the face plane: + proud, − recessed (a 4 mm deep joint = −0.004)
//  Recipe   (w_m, h_m, tpm, seed, matHex, opts) → Raster          (makeRecipe builds one from a paint(ctx) function)
//  Layout   plain, JSON-serialisable data computed in METRES from the seed BEFORE any rasterisation (§5), so the same seed gives the same
//           bricks, stones, blocks, sheets and grain at 32 tpm and at 128 tpm. A periodic layout repeats with period (w, h) in
//           x AND y; its units may run past the right / bottom edge (they wrap) and every unit's bbox corner (x0, y0) lies in [0,w)×[0,h).
//  Periodic a periodic recipe's raster wraps: column w−1 continues into column 0 and row h−1 into row 0, with no seam (tests pin it).
//  Seeds    uint32. Derive every independent stream with subSeed(seed, 'tag'); never share one PRNG stream between two features, so adding
//           a feature can never move another one. Per-unit randomness comes from hashes of the unit id (unitRnd), never from draw order.
//  Colour   the colour rule: a recipe colour = target × (materialHex / stockHex), per channel (relColour). STOCK_HEX holds the
//           levels.js '∅' materials, so at the stock hexes every colour target comes out exactly, and a drifted hex drifts the recipe.
//  Filter   rasterize() box-filters: each texel = the mean of ss×ss sub-samples, and each sub-sample's layout coverage is the EXACT area of
//           its square footprint covered by each unit (analytic for rects, exact polygon clipping for polygons). With ss = 'auto'
//           (round(128 / tpm)) the 32 tpm sub-samples sit exactly on the 128 tpm texel centres with the same footprints, so a 32 tpm
//           render equals the 128 tpm render box-downsampled 4× up to float rounding. With ss = 1 the coverage is still exact; only the
//           in-unit shading is point-sampled (cheaper: the game renders its tiles this way).
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  API
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §1 PRNG, hashing, small maths
//   mulberry32(seed) → () => [0, 1)               byte-for-byte gfx-util.js's (gfx-util.js:17-25)
//   hash2(a, b, c = 0) → uint32                   byte-for-byte gfx-util.js's (gfx-util.js:42-47); integer inputs
//   hashF(a, b, c = 0) → [0, 1)                   hash2 / 2^32
//   strHash(str) → uint32                         FNV-1a over UTF-16 code units (stable tag hashing)
//   subSeed(seed, tag) → uint32                   an independent seed for a named (string) or numbered sub-stream
//   unitRnd(seed, id) → [r0, r1, r2, r3]          four independent [0, 1) values for unit `id` (order-independent)
//   c01(v), sstep(a, b, v), lerp(a, b, t), hyp(a, b), mix3(a, b, t), scale3(c, k), mul3(a, b), lum(c), desat(c, k)
//                                                 as in gfx-textures.js (lum = Rec.601 luma; desat pulls toward the luma grey)
//   wrapM(v, p) → [0, p)      wrapD(d, p) → [−p/2, p/2]      (periodic position / periodic difference)
//
//  §2 Periodic noise (all periodic in x AND y over (periodX, periodY) metres; all deterministic in (seed, options))
//   Options shared by §2 makers: { periodX, periodY (or period: both), feature | featureX/featureY (metres, the lattice cell size; it
//     is snapped so an integer number of cells fits the period) | cellsX/cellsY (explicit lattice counts) }.
//   Every sampler takes an optional `texel` (metres per sample, pass s.fx from rasterize): lattice scales finer than 2 texels fade out
//   (band limiting), so a coarse render approximates the box-filtered fine one instead of aliasing.
//   makeValueNoise(seed, o) → f(x, y, texel?) → [0, 1]   smoothstep-interpolated value noise (gfx-textures.js's vnoise, in metres).
//     f.cellsX, f.cellsY, f.cellW, f.cellH (metres) describe the lattice.
//   makeFbm(seed, o) → f(x, y, texel?) → [−1, 1]          o += { octaves = 4, lacunarity = 2, gain = 0.5 }. Σ amp·(2n−1) / Σ amp, so it
//     never leaves [−1, 1]; its typical spread is about ±0.35, scale it yourself. Octave k uses seed + 977k (as gfx-textures.js's fbm).
//   makeVoronoi(seed, o) → f(x, y, out = {}) → out   o += { jitter = 1 (0 = a regular grid), search = 2 (5×5 cells) }. (No band
//     limiting: f1 / f2 / edge are distances, smooth at every scale.)
//     out.id    the nearest feature point's cell id, 0 .. cellsX·cellsY−1 (unique within one period; stable)
//     out.id2   the second-nearest point's id
//     out.f1, out.f2  distances (metres) to the nearest and second-nearest points
//     out.edge  distance (metres) from (x, y) to the nearest Voronoi cell edge (the exact bisector distance, Quilez's method)
//     out.dx, out.dy  vector (metres) from (x, y) to the nearest point
//     f.point(id) → [x, y]  the feature point of cell id (metres, inside its own cell of the first period)
//   makeWarp(seed, o) → f(x, y, out = {}, texel?) → out   o = §2 options + fbm options + { amp | ampX/ampY (metres) }. out.x/out.y =
//     the domain-warped position (x + ampX·fbmA, y + ampY·fbmB). Feed it to any periodic sampler; periodicity is preserved.
//
//  §3 Raster
//   JS_TPM = 32, FINE_TPM = 128, REF_TPM = 128
//   rasterSize(w_m, h_m, tpm) → [w, h]
//   newRaster(w_m, h_m, tpm, { height = true } = {}) → Raster (rgb 0, cav 1, height 0)
//   cloneRaster(R) → Raster         a deep copy (meta is shared, not copied)
//   autoSS(tpm) → round(REF_TPM / tpm) clamped to 1..8 (32 → 4, 64 → 2, 128 → 1)
//   rasterize(R, shader, o = {}) → R          (rasterizeSteps(R, shader, o): the same pass as a stepped job, §3b)
//     o.layers  [LayerIndex, ...] from indexUnits (§4): each sub-sample gets the exact coverage of every layer over its footprint
//     o.ss      'auto' (default) | integer sub-samples per axis per texel
//     o.over    false (default): each sub-sample starts at r = g = b = 0, cav = 1, h = 0. true: it starts at R's current texel value
//               (paint decorations over a substrate; the result is the mean over the texel's sub-samples)
//     o.origin  [ox, oy] metres added to every sample position (default [0, 0]); o.wrap (default true) wraps positions into the tile.
//               With wrap false the positions run past the tile; periodic layers still answer at any distance (each query is folded
//               into the first period) and §2 samplers are periodic, so a periodic recipe renders the same pattern one period over.
//     o.rect    [tx0, ty0, tx1, ty1] texels to paint (end exclusive; default the whole raster)
//     shader(s) is called once per sub-sample with ONE reused record s (copy anything you keep):
//       s.x, s.y     the sub-sample centre (metres, in [0, w_m) × [0, h_m) when wrapped)
//       s.fx, s.fy   the sub-sample footprint size (metres). Pass s.fx as `texel` to §2 samplers.
//       s.tx, s.ty   the output texel;   s.R  the raster
//       s.hits[l]    the Hits of o.layers[l] over this footprint (below)
//       s.r, s.g, s.b, s.cav, s.h   the outputs: write them
//     Hits = { n, unit: Int32Array, area, lx, ly, ed: Float64Array, sum, top }    (at most MAX_HITS = 8 entries)
//       n          number of units overlapping the footprint
//       unit[k]    index into the layer's units array (layout.units[unit[k]])
//       area[k]    fraction 0..1 of the footprint that unit covers (exact)
//       lx[k], ly[k]  the sub-sample centre in the unit's own frame: metres from the unit's bbox corner (x0, y0); for a unit that wraps
//                  around the tile the copy that overlaps the footprint is used, so lx/ly are continuous across the seam
//       ed[k]      signed distance (metres) from the sub-sample centre to the unit's outline: + inside, − outside (for bevels, rounded
//                  arrises, edge wear)
//       sum        Σ area over ALL overlapping units (≤ 1); 1 − sum is the joint / mortar / background fraction
//       top        k of the largest area, −1 if none
//   blendHits(s, H, unit, joint)   area-weighted blend into s.r/g/b/cav/h: unit(k, C) and joint(C) write C[0..4] = r, g, b, cav, h for
//     hit k and for the uncovered fraction (C arrives as 0, 0, 0, 1, 0). joint() is skipped when 1 − H.sum = 0.
//   coverageOf(index, R, o?) → Float64Array(w·h)   each texel's Σ area: the layout's exact box-filtered coverage (R only gives the
//     grid; o.ss, o.origin and o.wrap as for rasterize)
//   downsampleBox(R, f) → Raster    the f×f box average (w and h must divide by f); tpm / f
//   meanAbsDiff(A, B) → { rgb, cav, height, maxRgb }   mean absolute differences (rgb in 0..255 units) of two same-size rasters
//   rollRaster(R, dx, dy) → Raster  circular shift: out(x, y) = R((x + dx) mod w, (y + dy) mod h)
//   seamStats(R) → { colWrap, colMin, colMax, colMean, rowWrap, rowMin, rowMax, rowMean }: mean |Δrgb| across the wrap seam (last →
//     first column / row) next to the min / max / mean over every interior neighbour pair. A seamless tile has colWrap ≤ colMax.
//   toRGB8(R) → Uint8Array(w·h·3)   toRGBA8(R) → Uint8Array(w·h·4) (A = cav·255)   toGray8(values, k = 255) → Uint8Array
//     (rounding as gfx-textures.js finish(): v + 0.5 truncated, clamped to 0..255)
//
//  §4 Layer index and exact coverage
//   MAX_HITS = 8
//   indexUnits(layoutOrUnits, o = {}) → LayerIndex   spatial index of disjoint units for rasterize. Takes a layout (uses its units, w, h,
//     periodic) or a units array plus o = { w, h, periodic = false }. A unit is { x0, y0, x1, y1 } (a rectangle) or additionally
//     { poly: [x0, y0, x1, y1, ...] } (a simple polygon in the same absolute metres; x0..y1 is then its bbox). Units in one layer must not
//     overlap (coverage is summed); put overlays (patches, bolts, marks) in their own layer.
//   discUnits(items, radiusKey = 'r', n = 24) → units   polygon discs (area-corrected n-gons) for items { id, x, y, [radiusKey] }
//   polyArea(poly) → signed area (+ for the vertex order the layouts use);  polyDist(poly, x, y) → signed distance (+ inside)
//
//  §5 Layouts (plain data; `periodic` ones repeat with period (w, h); sizes in METRES)
//   Every unit: { id, kind, x0, y0, x1, y1, rnd: [4 × [0,1)], ... }; ids are 0..n−1 in generation order; rnd = unitRnd(sub-seed, id).
//   Snapping: a periodic layout fits a whole number of modules into the tile, so its module sizes (layout.module) differ from the
//   nominal ones (layout.nominal) by at most half a module per tile (2 m: pressed course 6.25 cm, stretcher 22.2 cm; CMU 40 × 20 cm).
//   PRESSED_BRICK, COMMON_BRICK, CMU, FORMSTONE, PLYWOOD   the nominal specs
//   layoutBrick(w, h, seed, o = {}) → { kind 'brick', bond, w, h, periodic, seed, nominal, module, joint, units }
//     o.bond 'running' (default: pressed face brick, course 6.2 cm, stretcher 21.3 cm, joint 0.48 cm, half-bond) |
//            'common'  (common bond: a header course every 6th course, course 6.7 cm, stretcher 21.4 cm, joints 1.0–1.3 cm, recessed)
//     o.periodic (default true), o.course, o.stretcher, o.joint (number | [min, max]), o.headerEvery, o.offset (running-bond offset as a
//       fraction of the stretcher, default 0.5)
//     units: { kind 'stretcher' | 'header', course, col, cell: [x0, y0, x1, y1] (the module cell the joints are centred on), cut }
//     module: { course, stretcher, header, courses, perCourse };  joint: { min, max, depth, recessShade }
//     Periodic: course 0 is at the top (y = 0). Non-periodic (o.periodic false, e.g. an infill): course 0 sits on the foot (y = h) and the
//     courses rise; units are clipped to the tile and flagged cut.
//   layoutCmu(w, h, seed, o = {}) → { kind 'cmu', ... same fields }   module 40.64 × 20.32 cm, units 39.69 × 19.37, joints 0.95 cm,
//     running bond. o.periodic false = an infill laid from the foot, alternate courses starting with a cut half block (cut half-blocks
//     at the frame, as a door or window is sealed). units: { kind 'block', course, col, cell, cut }
//   layoutFormstone(w, h, seed, o = {}) → { kind 'formstone', w, h, periodic: true, seed, nominal, courses, units }
//     Loose courses of stones 20–60 cm wide, 12–30 cm tall (the stone faces; a module adds the mean joint; course heights and stone
//     widths are adjusted to sum exactly to the tile while staying in range, and the joints' own widths, the 3 cm head-joint slant and the
//     course-line wobble move a stone's bbox by a few cm). A quarter of the tall slots are split into two stacked stones. Joints
//     1.5–2.5 cm wide (each stone side gets its own half-width), wobbling course lines, slanted head joints, rounded corners 1–3 cm.
//     courses: [{ top, height, stones }] per course.
//     units: { kind 'stone', course, col, split (0 whole, 1 upper, 2 lower, 3 lower-right), poly, jointDepth (0.003–0.006 m: the joint
//       depth around this stone), radius (its corner radius), rnd }. The lumps (fbm, 3 octaves, ±4 mm: FORMSTONE.lumpAmp) are the painter's.
//     o overrides any FORMSTONE field (rMin, rMax, wobble, lineStep, split, ...), plus (added; the defaults keep the layout unchanged):
//       o.wobbleShare (0.12) the course-line wobble is capped at this share of the courses either side of the line;
//       o.splitHead ([lo, hi] | null, default null) a split slot's LOWER stone, if at least 1.8·wMin wide, is itself cut by a head joint
//         at lo..hi of its width (split 2 left, split 3 right), so the stacked pair does not read as a shim.
//   layoutPlywood(w, h, seed, o = {}) → { kind 'plywood', w, h, periodic: false, seed, orient, nominal, opening, age, units, patches,
//       strongbacks, bolts, screws, mark, waterLine, delam }       (w × h = the board: the opening plus its overlap)
//     o.opening {x0, y0, x1, y1} (default: the board inset by o.overlap = 0.15 m), o.orient 'auto' | 'vertical' | 'horizontal'
//     units    sheets 1.219 × 2.438 m from the top-left, cut at the right / bottom ({ kind 'sheet', col, course, cut, grain 'y'|'x',
//              age }); 2 mm gaps between sheets
//     patches  oval (boat) veneer patches along the grain: { id, kind 'patch', sheet, x, y, rx, ry, tilt, poly, x0..y1, rnd }
//     strongbacks [{ id, y, x0, x1, depth }] behind the board at 1/3 and 2/3 of the opening height (for reference)
//     bolts    [{ id, x, y, headR 0.0125, washerR 0.019, strongback, rnd }]: two per strongback at ±1/4 of the opening width
//     screws   [{ id, x, y, r 0.0045, sheet, rnd }]: every ≤ 30 cm, 2 cm in from every sheet edge, corners included
//     mark     { present, x, y }: the crew-mark anchor, seeded in the board's upper middle, present on about half the boards (§11)
//     waterLine metres of dark water line at the foot (0.10–0.20);  delam [tl, tr, bl, br] delaminated corners;  age 0.3–0.9 (the
//              mix from fresh wood to silver-grey; each sheet's own age is ±0.06 around it)
//
//  §6 Colour rule
//   STOCK_HEX = { F, C, P, B, W, O, M, floor }    the levels.js '∅' materials and palette.floor
//   hexToRgb(hex) → [r, g, b] | null              '#rrggbb' or 'rrggbb'; null if unparsable
//   relColour(target, matHex, stockHex) → [r, g, b] floats   target (hex or [r, g, b]) × matHex / stockHex per channel. A missing or bad
//     matHex counts as the stock (identity); a stock channel of 0 leaves that channel at the target.
//   stockOf(codeOrHex) → hex                       'B' → '#8A4A3A'; a hex passes through
//
//  §7 Decals and masks (seeded, in metres; each returns a sampler f(x, y, texel?) → 0..1 with its plain data on a property)
//   Common options: { w, h, periodic = true (wrap in x) }. Masks are anchored to the top or the foot, so they never wrap in y.
//   avoidEdges (default true) keeps a decal's footprint out of the EDGE band, as gfx-textures.js designs its decorations.
//   makeSootStreaks(seed, { w, h, count = 6, lenMin = 0.35, lenMax = 1.3, widthMin = 0.03, widthMax = 0.09, top = 0, strength = 1 })
//     streaks hanging from y = top, (1 − t)^1.2 down their length, smooth across, a slow wobble. f.streaks = the data.
//     Added options (the defaults keep the old streaks): amp ([0.005, 0.02] m, the wobble amplitude range), spread (0: the half-width
//     grows to hw·(1 + spread·t) down the streak), edge ('smooth' q²(3 − 2q) across | 'linear' q: a feathered edge).
//   makeDampFoot(seed, { w, h, height = 0.40, jag = 0.04, feature = 0.3, tide = 0.012 }) → wetness: 0 above the tide line, 0.75 → 1
//     toward the foot, a 0.9 tide mark at the line (a painter darkens by it: a damp foot 40 cm tall at −8% value = value × (1 − 0.08·f))
//   makeRustRuns(seed, { w, h, sources: [[x, y] | {x, y}, ...], lenMin = 0.06, lenMax = 0.30, width = 0.010, strength = 1 })
//     a small bloom at each source and a narrowing, fading run below it. f.runs = the data. Added options (the defaults keep the old
//     runs): amp ([0.001, 0.004] m, the sideways wander range of a run), wl ([0.05, 0.12] m, the wander's wavelength range: a long one
//     hangs nearly plumb with a slow wander, a short one coils), head ([0.8, 0.9]: the source bloom's strength and its radius as a
//     share of the run width; [0.5, 0.45] gives a small bloom, not a round head).
//   makeEfflorescence(seed, { w, h, height = 0.30, density = 0.5, feature = 0.08, grain = 0.006, foot = h, x0?, x1?, soft = 0.05 })
//     white salt crust: blotches strongest at the foot (y = foot), gone by `height` above it, speckled; optionally limited to x0..x1.
//   edgeFade(v, size, m0 = 4/32, m1 = 10/32) → 0..1   0 within m0 metres of either end of [0, size], 1 beyond m1 (gfx-textures.js's
//     edgeFade(v, 4, 10) in metres)
//
//  §8 EDGE (variants seam with their substrate)
//   EDGE = 3 (texels at 32 tpm, gfx-textures.js:186);  EDGE_M = 3/32 = 0.09375 m
//   edgeTexels(tpm, m = EDGE_M) → round(m · tpm)   (32 → 3, 64 → 6, 128 → 12)
//   restoreEdges(V, S, { cols = EDGE_M, rows = 0 } = {}) → V   copies the outer columns (and rows: the storey bands use rows = 2/32) of rgb,
//     cav and height from the substrate S back into the variant V. Paint every variant over a copy of S, then restore.
//
//  §9 Recipe scaffold
//   makeRecipe({ name, stock, height = true, periodic = true, paint(ctx) }) → recipe(w_m, h_m, tpm, seed, matHex, opts = {}) → Raster
//     stock: a material code of STOCK_HEX ('F', 'C', 'P', 'B', 'W', 'O', 'M', 'floor') or a hex: the colour rule's reference.
//     ctx = { R, w_m, h_m, tpm, seed, matHex, stockHex, opts, ss,
//             col(target) → relColour(target, matHex, stockHex),   sub(tag) → subSeed(seed, tag),   rng(tag) → mulberry32(sub(tag)),
//             fbm(tag, o), noise(tag, o), voronoi(tag, o), warp(tag, o)   (the §2 makers with periodX/periodY = the tile),
//             raster(shader, o)   (rasterize(R, shader, { ss, origin: opts.origin, wrap: opts.wrap, ...o })) }
//     opts.ss, opts.origin and opts.wrap are honoured by ctx.raster (opts.origin with opts.wrap false renders the periodic pattern past
//     the tile edge: the periodicity test). paint's return value is stored as R.meta. The scaffold then clamps rgb to
//     0..255 and cav to 0..1 and throws on any non-finite value. recipe.recipeName, recipe.stock and recipe.periodic describe it.
//     A generator *paint(ctx) runs its passes as `yield* ctx.raster(...)` (§3b); recipe.steps(...) is the same build as a stepped job.
//
//  §10 (none: nothing here reads or writes a file)
//
//  §11 The glyph test (every mark must differ by ≥ 6 cells from every digit and letter in a 5 × 7 rendering, so none reads as one)
//   FONT_5X7 { '0'..'9', 'A'..'Z': [7 strings of 5, '#' = on] };  GLYPHS = its keys;  GLYPH_MIN_DISTANCE = 6
//   toBits5x7(mask) → Uint8Array(35)   accepts 35 values (truthy = on), 7 strings ('#' or '1' = on) or 7 arrays of 5
//   glyphDistance(mask, glyph) → number of differing cells (either argument may be a GLYPHS key or a mask)
//   mirror5x7(mask) → Uint8Array(35)  (left-right; the P tile reads mirrored on east and north faces)
//   maskTo5x7(sample, x0, y0, x1, y1, { thr = 0.5, ss = 8 }) → Uint8Array(35)   box-averages sample(x, y) → 0..1 over each of the 5 × 7
//     cells of the rectangle and thresholds it
//   fitMaskTo5x7(values, w, h, { on = 0.5, thr = 0.5 }) → Uint8Array(35)   crops a w × h coverage array to the bbox of its values ≥ on
//     and area-resamples that box to 5 × 7, then thresholds
//   glyphTest(mask, { min = 6, mirror = true }) → { pass, distance, nearest, mirrored }   the smallest distance over every glyph (and
//     over the mirrored mask), the glyph it came from, and whether the mirror gave it
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════


// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §1 PRNG, hashing, small maths
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export function mulberry32(seed) {
  let s = seed >>> 0
  return () => {
    s += 0x6D2B79F5
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export function hash2(a, b, c = 0) {
  let h = (Math.imul(a, 2654435761) ^ Math.imul(b, 2246822519) ^ Math.imul(c, 3266489917)) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}
export const hashF = (a, b, c = 0) => hash2(a, b, c) / 4294967296
export function strHash(str) {
  let h = 0x811C9DC5
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}
export function subSeed(seed, tag) {
  return hash2(seed >>> 0, typeof tag === 'number' ? tag >>> 0 : strHash(String(tag)), 0x5EED0B10)
}
export function unitRnd(seed, id) {
  const k = hash2(seed >>> 0, id, 0x0B10C)
  return [hashF(k, 1, 0x51), hashF(k, 2, 0x51), hashF(k, 3, 0x51), hashF(k, 4, 0x51)]
}

export const c01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
export const sstep = (a, b, v) => { const t = c01((v - a) / (b - a)); return t * t * (3 - 2 * t) }
export const lerp = (a, b, t) => a + (b - a) * t
export const hyp = (a, b) => Math.sqrt(a * a + b * b)
export const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
export const scale3 = (c, k) => [c[0] * k, c[1] * k, c[2] * k]
export const mul3 = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]]
export const lum = (c) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114
export const desat = (c, k) => { const l = lum(c); return [lerp(c[0], l, k), lerp(c[1], l, k), lerp(c[2], l, k)] }
export const wrapM = (v, p) => { let r = v - p * Math.floor(v / p); if (r >= p) r -= p; if (r < 0) r = 0; return r }
export const wrapD = (d, p) => d - p * Math.round(d / p)
const pmodi = (i, n) => { const r = i % n; return r < 0 ? r + n : r }

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §2 Periodic noise in metres
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const cellsFor = (period, feature) => {
  if (!(feature > 0)) throw new Error('noise: feature (metres) or cellsX/cellsY required')
  return Math.max(1, Math.round(period / feature))
}
function periodOf(o) {
  const PX = o.periodX ?? o.period, PY = o.periodY ?? o.period
  if (!(PX > 0) || !(PY > 0)) throw new Error('noise: periodX / periodY (metres) required')
  return [PX, PY]
}
function latticeOf(o, PX, PY) {
  const cx = o.cellsX ?? cellsFor(PX, o.featureX ?? o.feature), cy = o.cellsY ?? cellsFor(PY, o.featureY ?? o.feature)
  if (!(cx >= 1 && cy >= 1 && cx === Math.floor(cx) && cy === Math.floor(cy))) throw new Error('noise: lattice counts must be positive integers')
  return [cx, cy]
}
// band limiting: a lattice scale of q texels keeps its full weight from q = 2 up and fades to nothing at q = 1
const bandWeight = (cell, texel) => (texel > 0 ? sstep(1, 2, cell / texel) : 1)

// Speed (2026-11-17, the block's texture build; the same values, byte for byte, as filling every lattice up front): a lattice is
// filled the first time a sample reads it (the same seed and stream, so the same values; a detail
// faded to nothing at the render's texel never fills its lattice: 0.5 + (v − 0.5)·0 is exactly 0.5 for any finite sample), the band
// weights are computed once per footprint size, not per sample, an index already in range skips the wrap, and fbm reads its octaves'
// lattices directly with the same arithmetic in the same order.
export function makeValueNoise(seed, o) {
  const [PX, PY] = periodOf(o), [cx, cy] = latticeOf(o, PX, PY)
  let lat = null
  const fill = () => {
    lat = new Float64Array(cx * cy)
    const r = mulberry32((seed ^ Math.imul(cx, 0x9E3779B1) ^ Math.imul(cy, 0x85EBCA77)) >>> 0)
    for (let i = 0; i < lat.length; i++) lat[i] = r()
  }
  const kx = cx / PX, ky = cy / PY, cell = Math.min(PX / cx, PY / cy)
  let lastT = -1, lastW = 1
  const f = (x, y, texel = 0) => {
    let bw = 1
    if (texel > 0) { if (texel !== lastT) { lastT = texel; lastW = bandWeight(cell, texel) } bw = lastW; if (bw === 0 && x - x === 0 && y - y === 0) return 0.5 }
    if (lat === null) fill()
    const fx = x * kx, fy = y * ky, ix = Math.floor(fx), iy = Math.floor(fy)
    let tx = fx - ix, ty = fy - iy
    tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty)
    const x0 = ix >= 0 && ix < cx ? ix : pmodi(ix, cx), x1 = x0 + 1 === cx ? 0 : x0 + 1
    const y0 = iy >= 0 && iy < cy ? iy : pmodi(iy, cy), r0 = y0 * cx, r1 = (y0 + 1 === cy ? 0 : y0 + 1) * cx
    const a = lat[r0 + x0] + (lat[r0 + x1] - lat[r0 + x0]) * tx
    const b = lat[r1 + x0] + (lat[r1 + x1] - lat[r1 + x0]) * tx
    const v = a + (b - a) * ty
    return texel > 0 ? 0.5 + (v - 0.5) * bw : v
  }
  f.cellsX = cx; f.cellsY = cy; f.cellW = PX / cx; f.cellH = PY / cy
  Object.defineProperty(f, '_vn', { value: { kx, ky, cx, cy, lat: () => { if (lat === null) fill(); return lat } } })
  return f
}

export function makeFbm(seed, o) {
  const [PX, PY] = periodOf(o)
  const oct = o.octaves ?? 4, lac = o.lacunarity ?? 2, gain = o.gain ?? 0.5
  const fX = o.featureX ?? o.feature, fY = o.featureY ?? o.feature
  const layers = [], amps = [], cells = []
  let a = 1, tot = 0
  for (let k = 0; k < oct; k++) {
    const s = Math.pow(lac, k)
    const lo = o.cellsX != null ? { periodX: PX, periodY: PY, cellsX: Math.max(1, Math.round(o.cellsX * s)), cellsY: Math.max(1, Math.round(o.cellsY * s)) }
      : { periodX: PX, periodY: PY, cellsX: cellsFor(PX, fX / s), cellsY: cellsFor(PY, fY / s) }
    const n = makeValueNoise((seed + k * 977) >>> 0, lo)
    layers.push(n); amps.push(a); cells.push(Math.min(n.cellW, n.cellH)); tot += a; a *= gain
  }
  const WT = new Float64Array(oct)
  const VN = layers.map((n) => n._vn), KX = new Float64Array(VN.map((q) => q.kx)), KY = new Float64Array(VN.map((q) => q.ky))
  const CX = new Int32Array(VN.map((q) => q.cx)), CY = new Int32Array(VN.map((q) => q.cy)), LAT = new Array(oct).fill(null)
  let lastT = -2
  const f = (x, y, texel = 0) => {
    if (texel !== lastT) { lastT = texel; for (let k = 0; k < oct; k++) WT[k] = texel > 0 ? amps[k] * bandWeight(cells[k], texel) : amps[k] }
    let v = 0
    for (let k = 0; k < oct; k++) {
      const w = WT[k]
      if (w > 0) {
        const lat = LAT[k] ?? (LAT[k] = VN[k].lat()), cx = CX[k], cy = CY[k]
        const fx = x * KX[k], fy = y * KY[k], ix = Math.floor(fx), iy = Math.floor(fy)
        let tx = fx - ix, ty = fy - iy
        tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty)
        const x0 = ix >= 0 && ix < cx ? ix : pmodi(ix, cx), x1 = x0 + 1 === cx ? 0 : x0 + 1
        const y0 = iy >= 0 && iy < cy ? iy : pmodi(iy, cy), r0 = y0 * cx, r1 = (y0 + 1 === cy ? 0 : y0 + 1) * cx
        const a = lat[r0 + x0] + (lat[r0 + x1] - lat[r0 + x0]) * tx
        const b = lat[r1 + x0] + (lat[r1 + x1] - lat[r1 + x0]) * tx
        const n = a + (b - a) * ty
        v += (n - 0.5) * 2 * w
      }
    }
    return v / tot
  }
  f.octaves = layers.map((n, k) => ({ cellsX: n.cellsX, cellsY: n.cellsY, amp: amps[k] }))
  return f
}

export function makeVoronoi(seed, o) {
  const [PX, PY] = periodOf(o), [cx, cy] = latticeOf(o, PX, PY)
  const cw = PX / cx, ch = PY / cy, jit = o.jitter ?? 1, S = o.search ?? 2
  const ptx = new Float64Array(cx * cy), pty = new Float64Array(cx * cy)
  const sy = (seed ^ 0x68E31DA4) >>> 0
  for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    const k = j * cx + i
    ptx[k] = 0.5 + (hashF(i, j, seed) - 0.5) * jit
    pty[k] = 0.5 + (hashF(i, j, sy) - 0.5) * jit
  }
  const f = (x, y, out = {}) => {
    const gx = Math.floor(x / cw), gy = Math.floor(y / ch)
    let d1 = Infinity, d2 = Infinity, id1 = -1, id2 = -1, bi = 0, bj = 0, mx = 0, my = 0
    for (let dj = -S; dj <= S; dj++) for (let di = -S; di <= S; di++) {
      const i = gx + di, j = gy + dj, k = (j >= 0 && j < cy ? j : pmodi(j, cy)) * cx + (i >= 0 && i < cx ? i : pmodi(i, cx))
      const vx = (i + ptx[k]) * cw - x, vy = (j + pty[k]) * ch - y, d = vx * vx + vy * vy
      if (d < d1) { d2 = d1; id2 = id1; d1 = d; id1 = k; bi = i; bj = j; mx = vx; my = vy } else if (d < d2) { d2 = d; id2 = k }
    }
    let e = Infinity
    for (let dj = -S; dj <= S; dj++) for (let di = -S; di <= S; di++) {
      if (di === 0 && dj === 0) continue
      const i = bi + di, j = bj + dj, k = (j >= 0 && j < cy ? j : pmodi(j, cy)) * cx + (i >= 0 && i < cx ? i : pmodi(i, cx))
      const vx = (i + ptx[k]) * cw - x, vy = (j + pty[k]) * ch - y
      const ex = vx - mx, ey = vy - my, el = Math.sqrt(ex * ex + ey * ey)
      if (el < 1e-12) continue
      const d = ((mx + vx) * 0.5 * ex + (my + vy) * 0.5 * ey) / el
      if (d < e) e = d
    }
    out.id = id1; out.id2 = id2; out.f1 = Math.sqrt(d1); out.f2 = Math.sqrt(d2); out.edge = e; out.dx = mx; out.dy = my
    return out
  }
  f.cellsX = cx; f.cellsY = cy; f.cellW = cw; f.cellH = ch
  f.point = (id) => { const i = id % cx, j = (id - i) / cx; return [(i + ptx[id]) * cw, (j + pty[id]) * ch] }
  return f
}

export function makeWarp(seed, o) {
  const fa = makeFbm(subSeed(seed, 'warp-x'), o), fb = makeFbm(subSeed(seed, 'warp-y'), o)
  const ax = o.ampX ?? o.amp, ay = o.ampY ?? o.amp
  if (!(ax >= 0) || !(ay >= 0)) throw new Error('makeWarp: amp (metres) required')
  return (x, y, out = {}, texel = 0) => { out.x = x + ax * fa(x, y, texel); out.y = y + ay * fb(x, y, texel); return out }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §3 Raster
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export const JS_TPM = 32, FINE_TPM = 128, REF_TPM = 128

export function rasterSize(w_m, h_m, tpm) {
  if (!(w_m > 0) || !(h_m > 0) || !(tpm > 0)) throw new Error('raster: w_m, h_m and tpm must be positive')
  return [Math.max(1, Math.round(w_m * tpm)), Math.max(1, Math.round(h_m * tpm))]
}
export function newRaster(w_m, h_m, tpm, o = {}) {
  const [w, h] = rasterSize(w_m, h_m, tpm)
  return { w, h, w_m, h_m, tpm, sx: w_m / w, sy: h_m / h,
    rgb: new Float32Array(w * h * 3), cav: new Float32Array(w * h).fill(1), height: o.height === false ? null : new Float32Array(w * h) }
}
export function cloneRaster(R) {
  return { ...R, rgb: R.rgb.slice(), cav: R.cav.slice(), height: R.height ? R.height.slice() : null }
}
export const autoSS = (tpm) => Math.max(1, Math.min(8, Math.round(REF_TPM / tpm)))

export const MAX_HITS = 8
function newHits() {
  return { n: 0, sum: 0, top: -1, unit: new Int32Array(MAX_HITS), area: new Float64Array(MAX_HITS),
    lx: new Float64Array(MAX_HITS), ly: new Float64Array(MAX_HITS), ed: new Float64Array(MAX_HITS) }
}

// rasterize in two parts: rasterJob sets one pass up (ONE record s and one Hits per layer, as the shader contract says), rasterRows paints
// rows [ya, yb) of its rect. Painting the rect in one go (rasterize) or a row at a time (rasterizeSteps) calls the shader with the same
// records, the same values and in the same order, so the texels are the same.
function rasterJob(R, shader, o) {
  const ss = o.ss == null || o.ss === 'auto' ? autoSS(R.tpm) : Math.max(1, o.ss | 0)
  const layers = o.layers || [], NL = layers.length, hits = layers.map(newHits)
  const over = !!o.over, wrap = o.wrap !== false
  const ox = o.origin ? o.origin[0] : 0, oy = o.origin ? o.origin[1] : 0
  const W = R.w, wm = R.w_m, hm = R.h_m
  const stX = wm / (W * ss), stY = hm / (R.h * ss), hx = stX / 2, hy = stY / 2, inv = 1 / (ss * ss)
  const [tx0, ty0, tx1, ty1] = o.rect || [0, 0, W, R.h]
  const s = { x: 0, y: 0, fx: stX, fy: stY, tx: 0, ty: 0, hits, r: 0, g: 0, b: 0, cav: 1, h: 0, R }
  return { R, shader, ss, layers, NL, hits, over, wrap, ox, oy, W, wm, hm, stX, stY, hx, hy, inv, tx0, ty0, tx1, ty1, s }
}
export function rasterize(R, shader, o = {}) {
  const J = rasterJob(R, shader, o)
  rasterRows(J, J.ty0, J.ty1)
  return R
}
// rasterize a few texels at a time (RASTER_RUN, in the same row-major order), yielding between runs when the stepping driver's slice is up
// (§3b below): the same texels as rasterize. (A run, not a row: one row of exact polygon coverage, formstone's, can take several ms, and
// a run of 4 texels of the dearest shader well under one.) It may also pause once before its first run, so the set-up that comes before a
// pass and the pass's first texels need not share one slice.
const RASTER_RUN = 4
export function* rasterizeSteps(R, shader, o = {}) {
  const J = rasterJob(R, shader, o), rw = J.tx1 - J.tx0
  if (!(rw > 0)) return R
  if (due()) yield
  for (let ty = J.ty0; ty < J.ty1; ty++) for (let tx = J.tx0; tx < J.tx1; tx += RASTER_RUN) {
    rasterRows(J, ty, ty + 1, tx, Math.min(J.tx1, tx + RASTER_RUN))
    if (due()) yield
  }
  return R
}
// rows [ya, yb) of the rect, or with xa / xb the texels [xa, xb) of the one row ya
function rasterRows(J, ya, yb, xa = J.tx0, xb = J.tx1) {
  const { R, shader, ss, layers, NL, hits, over, wrap, ox, oy, W, wm, hm, stX, stY, hx, hy, inv, s } = J
  const rgb = R.rgb, cav = R.cav, hgt = R.height
  for (let ty = ya; ty < yb; ty++) for (let tx = xa; tx < xb; tx++) {
    const t = ty * W + tx, t3 = t * 3
    const br = rgb[t3], bg = rgb[t3 + 1], bb = rgb[t3 + 2], bc = cav[t], bh = hgt ? hgt[t] : 0
    let ar = 0, ag = 0, ab = 0, ac = 0, ah = 0
    for (let j = 0; j < ss; j++) {
      let y = oy + (ty * ss + j + 0.5) * stY
      if (wrap && (y < 0 || y >= hm)) y = wrapM(y, hm)
      for (let i = 0; i < ss; i++) {
        let x = ox + (tx * ss + i + 0.5) * stX
        if (wrap && (x < 0 || x >= wm)) x = wrapM(x, wm)
        s.x = x; s.y = y; s.tx = tx; s.ty = ty
        for (let l = 0; l < NL; l++) queryInto(layers[l], x - hx, y - hy, x + hx, y + hy, x, y, hits[l])
        if (over) { s.r = br; s.g = bg; s.b = bb; s.cav = bc; s.h = bh } else { s.r = 0; s.g = 0; s.b = 0; s.cav = 1; s.h = 0 }
        shader(s)
        ar += s.r; ag += s.g; ab += s.b; ac += s.cav; ah += s.h
      }
    }
    rgb[t3] = ar * inv; rgb[t3 + 1] = ag * inv; rgb[t3 + 2] = ab * inv; cav[t] = ac * inv
    if (hgt) hgt[t] = ah * inv
  }
}

// §3b Stepping (the block's tiles built a few ms at a time while the title is up, gfx-textures.js
// prebuildTextures). Every recipe, the bay compositor and the passes they run (rasterize, the masks, the field statistics) are generators
// that yield between rows; recipe(...) and paintBayElevation(...) drain them in one go, exactly as before. A stepping driver sets STEP.on
// and STEP.due (a clock time) for one slice and resumes the build until the slice is up. Only WHEN a build pauses depends on it, never a
// value, so a build stepped in slices of any size gives the same texels as one drained in one go.
export const STEP = { on: false, due: 0 }
const clock = typeof performance !== 'undefined' && typeof performance.now === 'function' ? () => performance.now() : () => Date.now()
export const due = () => STEP.on && clock() >= STEP.due
// run a stepped job (any iterator) to its end here and now: no pauses (a drain inside a slice finishes in that slice)
export function drain(it) {
  const on = STEP.on
  STEP.on = false
  try { for (;;) { const r = it.next(); if (r.done) return r.value } } finally { STEP.on = on }
}

const BC = new Float64Array(5)
export function blendHits(s, H, unit, joint) {
  let r = 0, g = 0, b = 0, c = 0, h = 0, stored = 0
  for (let k = 0; k < H.n; k++) stored += H.area[k]
  const kU = stored > 0 && stored < H.sum - 1e-12 ? H.sum / stored : 1         // units dropped past MAX_HITS: rescale the kept ones
  for (let k = 0; k < H.n; k++) {
    const a = H.area[k] * kU
    BC[0] = 0; BC[1] = 0; BC[2] = 0; BC[3] = 1; BC[4] = 0
    unit(k, BC)
    r += a * BC[0]; g += a * BC[1]; b += a * BC[2]; c += a * BC[3]; h += a * BC[4]
  }
  const j = 1 - H.sum
  if (j > 0) {
    BC[0] = 0; BC[1] = 0; BC[2] = 0; BC[3] = 1; BC[4] = 0
    joint(BC)
    r += j * BC[0]; g += j * BC[1]; b += j * BC[2]; c += j * BC[3]; h += j * BC[4]
  }
  s.r = r; s.g = g; s.b = b; s.cav = c; s.h = h
}

export function coverageOf(index, R, o = {}) {
  const ss = o.ss == null || o.ss === 'auto' ? autoSS(R.tpm) : Math.max(1, o.ss | 0), wrap = o.wrap !== false
  const ox = o.origin ? o.origin[0] : 0, oy = o.origin ? o.origin[1] : 0, stX = R.w_m / (R.w * ss), stY = R.h_m / (R.h * ss)
  const H = newHits(), out = new Float64Array(R.w * R.h)
  for (let ty = 0; ty < R.h; ty++) for (let tx = 0; tx < R.w; tx++) {
    let a = 0
    for (let j = 0; j < ss; j++) {
      let y = oy + (ty * ss + j + 0.5) * stY
      if (wrap && (y < 0 || y >= R.h_m)) y = wrapM(y, R.h_m)
      for (let i = 0; i < ss; i++) {
        let x = ox + (tx * ss + i + 0.5) * stX
        if (wrap && (x < 0 || x >= R.w_m)) x = wrapM(x, R.w_m)
        queryInto(index, x - stX / 2, y - stY / 2, x + stX / 2, y + stY / 2, x, y, H)
        a += H.sum
      }
    }
    out[ty * R.w + tx] = a / (ss * ss)
  }
  return out
}

export function downsampleBox(R, f) {
  if (R.w % f || R.h % f) throw new Error(`downsampleBox: ${R.w}x${R.h} does not divide by ${f}`)
  const w = R.w / f, h = R.h / f, O = { w, h, w_m: R.w_m, h_m: R.h_m, tpm: R.tpm / f, sx: R.w_m / w, sy: R.h_m / h,
    rgb: new Float32Array(w * h * 3), cav: new Float32Array(w * h), height: R.height ? new Float32Array(w * h) : null }
  const inv = 1 / (f * f)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, c = 0, e = 0
    for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) {
      const t = (y * f + j) * R.w + x * f + i
      r += R.rgb[t * 3]; g += R.rgb[t * 3 + 1]; b += R.rgb[t * 3 + 2]; c += R.cav[t]; if (R.height) e += R.height[t]
    }
    const t = y * w + x
    O.rgb[t * 3] = r * inv; O.rgb[t * 3 + 1] = g * inv; O.rgb[t * 3 + 2] = b * inv; O.cav[t] = c * inv
    if (O.height) O.height[t] = e * inv
  }
  return O
}

export function meanAbsDiff(A, B) {
  if (A.w !== B.w || A.h !== B.h) throw new Error(`meanAbsDiff: ${A.w}x${A.h} vs ${B.w}x${B.h}`)
  let r = 0, c = 0, e = 0, mx = 0
  for (let i = 0; i < A.rgb.length; i++) { const d = Math.abs(A.rgb[i] - B.rgb[i]); r += d; if (d > mx) mx = d }
  for (let i = 0; i < A.cav.length; i++) c += Math.abs(A.cav[i] - B.cav[i])
  if (A.height && B.height) for (let i = 0; i < A.height.length; i++) e += Math.abs(A.height[i] - B.height[i])
  return { rgb: r / A.rgb.length, cav: c / A.cav.length, height: A.height && B.height ? e / A.height.length : null, maxRgb: mx }
}

export function rollRaster(R, dx, dy) {
  const O = cloneRaster(R)
  for (let y = 0; y < R.h; y++) for (let x = 0; x < R.w; x++) {
    const d = y * R.w + x, s = pmodi(y + dy, R.h) * R.w + pmodi(x + dx, R.w)
    O.rgb[d * 3] = R.rgb[s * 3]; O.rgb[d * 3 + 1] = R.rgb[s * 3 + 1]; O.rgb[d * 3 + 2] = R.rgb[s * 3 + 2]; O.cav[d] = R.cav[s]
    if (R.height) O.height[d] = R.height[s]
  }
  return O
}

export function seamStats(R) {
  const W = R.w, H = R.h, P = R.rgb
  const colPair = (xa, xb) => { let s = 0; for (let y = 0; y < H; y++) for (let c = 0; c < 3; c++) s += Math.abs(P[(y * W + xa) * 3 + c] - P[(y * W + xb) * 3 + c]); return s / (H * 3) }
  const rowPair = (ya, yb) => { let s = 0; for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) s += Math.abs(P[(ya * W + x) * 3 + c] - P[(yb * W + x) * 3 + c]); return s / (W * 3) }
  let cMin = Infinity, cMax = 0, cSum = 0, rMin = Infinity, rMax = 0, rSum = 0
  for (let x = 0; x + 1 < W; x++) { const d = colPair(x, x + 1); cMin = Math.min(cMin, d); cMax = Math.max(cMax, d); cSum += d }
  for (let y = 0; y + 1 < H; y++) { const d = rowPair(y, y + 1); rMin = Math.min(rMin, d); rMax = Math.max(rMax, d); rSum += d }
  return { colWrap: colPair(W - 1, 0), colMin: cMin, colMax: cMax, colMean: cSum / Math.max(1, W - 1),
    rowWrap: rowPair(H - 1, 0), rowMin: rMin, rowMax: rMax, rowMean: rSum / Math.max(1, H - 1) }
}

const to8 = (v) => { const q = v + 0.5; return q < 0 ? 0 : q > 255 ? 255 : q | 0 }
export function toRGB8(R) { const o = new Uint8Array(R.w * R.h * 3); for (let i = 0; i < o.length; i++) o[i] = to8(R.rgb[i]); return o }
export function toRGBA8(R) {
  const n = R.w * R.h, o = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) { o[i * 4] = to8(R.rgb[i * 3]); o[i * 4 + 1] = to8(R.rgb[i * 3 + 1]); o[i * 4 + 2] = to8(R.rgb[i * 3 + 2]); o[i * 4 + 3] = to8(R.cav[i] * 255) }
  return o
}
export function toGray8(values, k = 255) { const o = new Uint8Array(values.length); for (let i = 0; i < o.length; i++) o[i] = to8(values[i] * k); return o }

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §4 Layer index and exact coverage
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const MAX_POLY = 1000
export function polyArea(P) {
  let a = 0
  const n = P.length >> 1
  for (let i = 0, j = n - 1; i < n; j = i++) a += P[2 * j] * P[2 * i + 1] - P[2 * i] * P[2 * j + 1]
  return a / 2
}
export function polyDist(P, x, y) {
  const n = P.length >> 1
  let inside = false, d2 = Infinity
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = P[2 * i], yi = P[2 * i + 1], xj = P[2 * j], yj = P[2 * j + 1]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
    const ex = xi - xj, ey = yi - yj, l2 = ex * ex + ey * ey
    let t = l2 > 0 ? ((x - xj) * ex + (y - yj) * ey) / l2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const dx = xj + ex * t - x, dy = yj + ey * t - y, dd = dx * dx + dy * dy
    if (dd < d2) d2 = dd
  }
  const d = Math.sqrt(d2)
  return inside ? d : -d
}
// exact area of polygon P (shifted by −dx, −dy already applied to the box) inside the box [x0, x1] × [y0, y1]: Sutherland–Hodgman
const CLIP_A = new Float64Array(2 * (MAX_POLY + 16)), CLIP_B = new Float64Array(2 * (MAX_POLY + 16))
function clipArea(P, x0, y0, x1, y1) {
  let n = P.length >> 1, src = CLIP_A, dst = CLIP_B
  for (let i = 0; i < P.length; i++) src[i] = P[i]
  for (let pl = 0; pl < 4; pl++) {
    let m = 0
    const X = pl === 0 ? x0 : pl === 1 ? x1 : 0, Y = pl === 2 ? y0 : pl === 3 ? y1 : 0
    for (let i = 0; i < n; i++) {
      const j = i === 0 ? n - 1 : i - 1
      const sx = src[2 * j], sy = src[2 * j + 1], ex = src[2 * i], ey = src[2 * i + 1]
      const sIn = pl === 0 ? sx >= X : pl === 1 ? sx <= X : pl === 2 ? sy >= Y : sy <= Y
      const eIn = pl === 0 ? ex >= X : pl === 1 ? ex <= X : pl === 2 ? ey >= Y : ey <= Y
      if (sIn !== eIn) {
        if (pl < 2) { const t = (X - sx) / (ex - sx); dst[2 * m] = X; dst[2 * m + 1] = sy + t * (ey - sy) }
        else { const t = (Y - sy) / (ey - sy); dst[2 * m] = sx + t * (ex - sx); dst[2 * m + 1] = Y }
        m++
      }
      if (eIn) { dst[2 * m] = ex; dst[2 * m + 1] = ey; m++ }
    }
    n = m
    const tmp = src; src = dst; dst = tmp
    if (n < 3) return 0
  }
  let a = 0
  for (let i = 0, j = n - 1; i < n; j = i++) a += src[2 * j] * src[2 * i + 1] - src[2 * i] * src[2 * j + 1]
  return Math.abs(a) / 2
}

export function indexUnits(src, o = {}) {
  const isArr = Array.isArray(src)
  const units = isArr ? src : src.units
  const w = o.w ?? (isArr ? undefined : src.w), h = o.h ?? (isArr ? undefined : src.h)
  const periodic = o.periodic ?? (isArr ? false : !!src.periodic)
  if (!(w > 0) || !(h > 0)) throw new Error('indexUnits: w and h (metres) required')
  const polys = []
  let sw = 0, sh = 0
  for (let k = 0; k < units.length; k++) {
    const u = units[k]
    if (!(u.x0 < u.x1) || !(u.y0 < u.y1) || !Number.isFinite(u.x0 + u.x1 + u.y0 + u.y1)) throw new Error(`indexUnits: unit ${k} has a bad bbox`)
    if (u.poly) {
      if (u.poly.length < 6 || u.poly.length & 1 || u.poly.length > 2 * MAX_POLY) throw new Error(`indexUnits: unit ${k} has a bad poly`)
      polys.push(Float64Array.from(u.poly))
    } else polys.push(null)
    sw += u.x1 - u.x0; sh += u.y1 - u.y0
  }
  const m = Math.min(0.5, w / 2, h / 2)
  const bin = units.length ? Math.min(1, Math.max(0.02, Math.max(sw, sh) / units.length)) : 1
  const X0 = -m, Y0 = -m, nbx = Math.max(1, Math.ceil((w + 2 * m) / bin)), nby = Math.max(1, Math.ceil((h + 2 * m) / bin))
  const eu = [], edx = [], edy = []
  for (let k = 0; k < units.length; k++) {
    const u = units[k]
    const nx0 = periodic ? Math.ceil((X0 - u.x1) / w) : 0, nx1 = periodic ? Math.floor((w + m - u.x0) / w) : 0
    const ny0 = periodic ? Math.ceil((Y0 - u.y1) / h) : 0, ny1 = periodic ? Math.floor((h + m - u.y0) / h) : 0
    for (let ny = ny0; ny <= ny1; ny++) for (let nx = nx0; nx <= nx1; nx++) {
      const dx = nx * w, dy = ny * h
      if (u.x1 + dx < X0 || u.x0 + dx > w + m || u.y1 + dy < Y0 || u.y0 + dy > h + m) continue
      eu.push(k); edx.push(dx); edy.push(dy)
    }
  }
  const binsOf = (e) => {
    const u = units[eu[e]]
    return [Math.max(0, Math.floor((u.x0 + edx[e] - X0) / bin)), Math.min(nbx - 1, Math.floor((u.x1 + edx[e] - X0) / bin)),
      Math.max(0, Math.floor((u.y0 + edy[e] - Y0) / bin)), Math.min(nby - 1, Math.floor((u.y1 + edy[e] - Y0) / bin))]
  }
  const start = new Int32Array(nbx * nby + 1)
  for (let e = 0; e < eu.length; e++) { const [a, b, c, d] = binsOf(e); for (let y = c; y <= d; y++) for (let x = a; x <= b; x++) start[y * nbx + x + 1]++ }
  for (let i = 0; i < nbx * nby; i++) start[i + 1] += start[i]
  const fill = start.slice(0, nbx * nby), list = new Int32Array(start[nbx * nby])
  for (let e = 0; e < eu.length; e++) { const [a, b, c, d] = binsOf(e); for (let y = c; y <= d; y++) for (let x = a; x <= b; x++) list[fill[y * nbx + x]++] = e }
  return { units, polys, w, h, periodic, X0, Y0, bin, nbx, nby, start, list,
    eu: Int32Array.from(eu), edx: Float64Array.from(edx), edy: Float64Array.from(edy), stamp: new Int32Array(eu.length), q: 0 }
}

function queryInto(I, qx0, qy0, qx1, qy1, cx, cy, H) {
  H.n = 0; H.sum = 0; H.top = -1
  if (I.periodic) {                                                                      // fold the query into the first period
    const kx = Math.floor(cx / I.w), ky = Math.floor(cy / I.h)
    if (kx) { const d = kx * I.w; cx -= d; qx0 -= d; qx1 -= d }
    if (ky) { const d = ky * I.h; cy -= d; qy0 -= d; qy1 -= d }
  }
  const qw = qx1 - qx0, qh = qy1 - qy0, qa = qw * qh, hd = 0.5 * hyp(qw, qh)
  const bx0 = Math.max(0, Math.floor((qx0 - I.X0) / I.bin)), bx1 = Math.min(I.nbx - 1, Math.floor((qx1 - I.X0) / I.bin))
  const by0 = Math.max(0, Math.floor((qy0 - I.Y0) / I.bin)), by1 = Math.min(I.nby - 1, Math.floor((qy1 - I.Y0) / I.bin))
  if (bx1 < bx0 || by1 < by0) return
  if (++I.q >= 0x7FFFFFF0) { I.stamp.fill(0); I.q = 1 }
  const q = I.q, units = I.units
  let sum = 0
  for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
    const b = by * I.nbx + bx
    for (let p = I.start[b], pe = I.start[b + 1]; p < pe; p++) {
      const e = I.list[p]
      if (I.stamp[e] === q) continue
      I.stamp[e] = q
      const k = I.eu[e], u = units[k], dx = I.edx[e], dy = I.edy[e]
      const ux0 = u.x0 + dx, ux1 = u.x1 + dx, uy0 = u.y0 + dy, uy1 = u.y1 + dy
      const ox = Math.min(qx1, ux1) - Math.max(qx0, ux0), oy = Math.min(qy1, uy1) - Math.max(qy0, uy0)
      if (ox <= 0 || oy <= 0) continue
      const P = I.polys[k]
      let area, ed
      if (!P) {
        area = ox * oy
        if (cx >= ux0 && cx <= ux1 && cy >= uy0 && cy <= uy1) ed = Math.min(cx - ux0, ux1 - cx, cy - uy0, uy1 - cy)
        else ed = -hyp(Math.max(ux0 - cx, 0, cx - ux1), Math.max(uy0 - cy, 0, cy - uy1))
      } else {
        ed = polyDist(P, cx - dx, cy - dy)
        if (ed >= hd) area = qa
        else if (ed <= -hd) continue
        else area = clipArea(P, qx0 - dx, qy0 - dy, qx1 - dx, qy1 - dy)
      }
      if (area <= qa * 1e-12) continue
      const a = area / qa
      sum += a
      let slot = H.n
      if (slot >= MAX_HITS) {                                                           // keep the MAX_HITS largest
        slot = 0
        for (let i = 1; i < MAX_HITS; i++) if (H.area[i] < H.area[slot]) slot = i
        if (H.area[slot] >= a) continue
      } else H.n++
      H.unit[slot] = k; H.area[slot] = a; H.lx[slot] = cx - ux0; H.ly[slot] = cy - uy0; H.ed[slot] = ed
    }
  }
  H.sum = sum > 1 ? 1 : sum
  let top = -1
  for (let i = 0; i < H.n; i++) if (top < 0 || H.area[i] > H.area[top]) top = i
  H.top = top
}

export function discUnits(items, radiusKey = 'r', n = 24) {
  const k = Math.sqrt(Math.PI / ((n / 2) * Math.sin(2 * Math.PI / n)))         // equal-area n-gon
  return items.map((it) => {
    const r = it[radiusKey] * k, poly = []
    for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; poly.push(it.x + r * Math.cos(a), it.y + r * Math.sin(a)) }
    return { id: it.id, x0: it.x - r, y0: it.y - r, x1: it.x + r, y1: it.y + r, poly, src: it }
  })
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §5 Layouts (metres, plain data)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export const PRESSED_BRICK = Object.freeze({ course: 0.062, stretcher: 0.213, joint: 0.0048 })
export const COMMON_BRICK = Object.freeze({ course: 0.067, stretcher: 0.214, headerEvery: 6, joint: Object.freeze([0.010, 0.013]),
  jointDepth: 0.005, recessShade: 0.78 })
const CMU_MOD = [0.4064, 0.2032], CMU_JOINT = 0.0095                                   // 16 × 8 in nominal, ⅜ in joints
export const CMU = Object.freeze({ module: Object.freeze(CMU_MOD), unit: Object.freeze(CMU_MOD.map((v) => v - CMU_JOINT)), joint: CMU_JOINT })
export const FORMSTONE = Object.freeze({ wMin: 0.20, wMax: 0.60, hMin: 0.12, hMax: 0.30, jMin: 0.015, jMax: 0.025, dMin: 0.003, dMax: 0.006,
  rMin: 0.010, rMax: 0.030, wobble: 0.012, lineStep: 0.10, slant: 0.03, split: 0.25, lumpAmp: 0.004, lumpOctaves: 3 })
export const PLYWOOD = Object.freeze({ sheet: Object.freeze([1.219, 2.438]), thick: 0.0127, overlap: 0.15, gap: 0.002, boltHead: 0.025,
  washer: 0.038, screwHead: 0.009, screwSpacing: 0.30, screwInset: 0.02, patchDensity: 2.5, patchLen: Object.freeze([0.07, 0.12]),
  patchWid: Object.freeze([0.025, 0.045]), age: Object.freeze([0.3, 0.9]), strongback: 0.089 })

// courses of rectangular units (brick, CMU). Periodic: snapped counts, course 0 at the top. Infill: nominal sizes from the foot up, clipped.
function courseUnits(seed, w, h, o) {
  const periodic = o.periodic !== false, hdr = o.headerEvery | 0, group = hdr > 0 ? hdr : 2
  let nc, course, ns, stretch
  if (periodic) {
    nc = group * Math.max(1, Math.round(h / (o.course * group))); course = h / nc
    ns = Math.max(1, Math.round(w / o.stretcher)); stretch = w / ns
  } else {
    course = o.course; stretch = o.stretcher; nc = Math.max(1, Math.ceil(h / course - 1e-9)); ns = Math.ceil(w / stretch - 1e-9)
  }
  const header = stretch / 2, sB = subSeed(seed, 'bed'), sH = subSeed(seed, 'head'), sU = subSeed(seed, 'unit')
  const bedW = (i) => lerp(o.bed[0], o.bed[1], hashF(i, 0, sB))      // joint i = the bed joint at the TOP of course i (infill: at its foot)
  const units = []
  for (let c = 0; c < nc; c++) {
    let my0, my1, jt, jb
    if (periodic) { my0 = c * course; my1 = c + 1 === nc ? h : (c + 1) * course; jt = bedW(c); jb = bedW((c + 1) % nc) }
    else { my1 = h - c * course; my0 = Math.max(0, my1 - course); jb = bedW(c); jt = bedW(c + 1) }
    const isH = hdr > 0 && c % hdr === 0, len = isH ? header : stretch
    const parity = hdr > 0 ? c % hdr : c
    const phase = isH ? 0.25 * stretch : (parity & 1 ? (o.offset ?? 0.5) * stretch : 0)
    const cells = []
    if (periodic) {
      const n = isH ? 2 * ns : ns
      for (let k = 0; k < n; k++) cells.push([phase + k * len, k + 1 === n ? phase + w : phase + (k + 1) * len])
    } else {
      for (let k = 0; -phase + k * len < w - 1e-9; k++) cells.push([Math.max(0, -phase + k * len), Math.min(w, -phase + (k + 1) * len)])
    }
    const n = cells.length
    const headW = (k) => lerp(o.head[0], o.head[1], hashF(c * 8192 + (periodic ? pmodi(k, n) : k), 1, sH))
    for (let k = 0; k < n; k++) {
      let [cx0, cx1] = cells[k]
      const jl = headW(k), jr = headW(k + 1)
      let x0 = cx0 + jl / 2, x1 = cx1 - jr / 2
      const y0 = my0 + jt / 2, y1 = my1 - jb / 2
      if (x1 - x0 < 0.003 || y1 - y0 < 0.003) continue                                  // a sliver at a cut edge: all mortar
      if (periodic && x0 >= w) { x0 -= w; x1 -= w; cx0 -= w; cx1 -= w }
      const id = units.length
      units.push({ id, kind: isH ? 'header' : o.kind, course: c, col: k, x0, y0, x1, y1, cell: [cx0, my0, cx1, my1],
        cut: !periodic && (cx1 - cx0 < len - 1e-9 || my1 - my0 < course - 1e-9), rnd: unitRnd(sU, id) })
    }
  }
  return { units, nc, ns, course, stretch, header }
}

export function layoutBrick(w, h, seed, o = {}) {
  const bond = o.bond || 'running'
  if (bond !== 'running' && bond !== 'common') throw new Error(`layoutBrick: unknown bond ${bond}`)
  const N = bond === 'common' ? COMMON_BRICK : PRESSED_BRICK
  const periodic = o.periodic !== false
  const j = o.joint ?? N.joint, jr = typeof j === 'number' ? [j, j] : [j[0], j[1]]
  const headerEvery = bond === 'common' ? (o.headerEvery ?? COMMON_BRICK.headerEvery) : 0
  const r = courseUnits(seed, w, h, { course: o.course ?? N.course, stretcher: o.stretcher ?? N.stretcher, headerEvery, bed: jr, head: jr,
    periodic, offset: o.offset, kind: 'stretcher' })
  return { kind: 'brick', bond, w, h, periodic, seed: seed >>> 0, nominal: { ...N },
    module: { course: r.course, stretcher: r.stretch, header: r.header, courses: r.nc, perCourse: r.ns },
    joint: { min: jr[0], max: jr[1], depth: bond === 'common' ? COMMON_BRICK.jointDepth : 0.001, recessShade: bond === 'common' ? COMMON_BRICK.recessShade : 1 },
    units: r.units }
}

export function layoutCmu(w, h, seed, o = {}) {
  const periodic = o.periodic !== false
  const mod = o.module ?? CMU.module, j = o.joint ?? CMU.joint, jr = typeof j === 'number' ? [j, j] : [j[0], j[1]]
  const r = courseUnits(seed, w, h, { course: mod[1], stretcher: mod[0], headerEvery: 0, bed: jr, head: jr, periodic, offset: o.offset, kind: 'block' })
  return { kind: 'cmu', bond: 'running', w, h, periodic, seed: seed >>> 0, nominal: { module: [...CMU.module], unit: [...CMU.unit], joint: CMU.joint },
    module: { course: r.course, stretcher: r.stretch, courses: r.nc, perCourse: r.ns }, joint: { min: jr[0], max: jr[1], depth: 0.002, recessShade: 1 },
    units: r.units }
}

// ── polygon offsetting for the formstone stones ──
// Inset a simple polygon by a per-edge distance d[i] (edge i runs from vertex i to i+1). Each edge moves inward along its normal and the
// vertices are where neighbouring moved edges meet. An edge that the inset reverses (a short polyline piece next to a stone corner) is
// collapsed and its neighbours are met directly, until none is reversed. Returns null if the polygon vanishes.
function insetPoly(P, d) {
  const n0 = P.length >> 1, s = polyArea(P) > 0 ? 1 : -1, E = []
  for (let i = 0; i < n0; i++) {
    const j = (i + 1) % n0, x0 = P[2 * i], y0 = P[2 * i + 1], x1 = P[2 * j], y1 = P[2 * j + 1], l = hyp(x1 - x0, y1 - y0)
    if (l < 1e-9) continue
    const ux = (x1 - x0) / l, uy = (y1 - y0) / l, nx = -uy * s, ny = ux * s, di = d[i]   // (nx, ny) = the inward normal
    E.push({ ux, uy, ax: x0 + nx * di, ay: y0 + ny * di, bx: x1 + nx * di, by: y1 + ny * di })
  }
  const meet = (a, b) => {                                                               // where moved edge a (ending) meets moved edge b
    const det = a.ux * b.uy - a.uy * b.ux
    if (Math.abs(det) < 1e-6) return [(a.bx + b.ax) / 2, (a.by + b.ay) / 2]
    const t = ((b.ax - a.ax) * b.uy - (b.ay - a.ay) * b.ux) / det
    return [a.ax + a.ux * t, a.ay + a.uy * t]
  }
  for (let guard = 0; guard <= n0; guard++) {
    const n = E.length
    if (n < 3) return null
    const V = E.map((e, i) => meet(E[(i + n - 1) % n], e))                               // V[i] = the start of edge i
    let bad = -1, worst = 0
    for (let i = 0; i < n; i++) {
      const a = V[i], b = V[(i + 1) % n], L = (b[0] - a[0]) * E[i].ux + (b[1] - a[1]) * E[i].uy
      if (L <= worst) { worst = L; bad = i }
    }
    if (bad < 0) { const out = []; for (const v of V) out.push(v[0], v[1]); return out }
    E.splice(bad, 1)
  }
  return null
}
// outset by r with round convex joins (a morphological opening after an inset by d + r gives an inset by d with corners rounded to r)
function roundOutset(Q, r) {
  const n = Q.length >> 1, s = polyArea(Q) > 0 ? 1 : -1, out = []
  for (let i = 0; i < n; i++) {
    const ip = (i + n - 1) % n, inx = (i + 1) % n, vx = Q[2 * i], vy = Q[2 * i + 1]
    let e1x = vx - Q[2 * ip], e1y = vy - Q[2 * ip + 1], e2x = Q[2 * inx] - vx, e2y = Q[2 * inx + 1] - vy
    const l1 = hyp(e1x, e1y), l2 = hyp(e2x, e2y)
    e1x /= l1; e1y /= l1; e2x /= l2; e2y /= l2
    const o1x = e1y * s, o1y = -e1x * s, o2x = e2y * s, o2y = -e2x * s               // outward normals
    const turn = (e1x * e2y - e1y * e2x) * s, dot = o1x * o2x + o1y * o2y
    let da = Math.atan2(o1x * o2y - o1y * o2x, dot)
    if (turn > 0 && Math.abs(da) > 0.05) {
      const a1 = Math.atan2(o1y, o1x), m = Math.max(1, Math.ceil(Math.abs(da) / (Math.PI / 8)))
      for (let k = 0; k <= m; k++) { const a = a1 + (da * k) / m; out.push(vx + r * Math.cos(a), vy + r * Math.sin(a)) }
    } else if (1 + dot > 1e-6) {
      const k = r / (1 + dot)
      out.push(vx + (o1x + o2x) * k, vy + (o1y + o2y) * k)
    } else out.push(vx + r * o1x, vy + r * o1y, vx + r * o2x, vy + r * o2y)              // a hairpin: never meet at infinity
  }
  return out
}
// sizes drawn in [lo, hi] made to sum to `total` exactly: the error is shared out in proportion to each size's room to grow (or shrink),
// so no size leaves [lo, hi]; only if that is impossible (n·lo > total or n·hi < total) does it fall back to plain scaling
function fitSum(raw, lo, hi, total) {
  let s = 0
  for (const v of raw) s += v
  const e = total - s
  let slack = 0
  for (const v of raw) slack += e > 0 ? hi - v : v - lo
  if (slack > 0 && Math.abs(e) <= slack) return raw.map((v) => v + (e * (e > 0 ? hi - v : v - lo)) / slack)
  return raw.map((v) => (v * total) / s)
}
function bboxOf(P) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (let i = 0; i < P.length; i += 2) { x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]); y0 = Math.min(y0, P[i + 1]); y1 = Math.max(y1, P[i + 1]) }
  return [x0, y0, x1, y1]
}

export function layoutFormstone(w, h, seed, o = {}) {
  const P = { ...FORMSTONE, ...o }
  const sC = subSeed(seed, 'courses'), sL = subSeed(seed, 'lines'), sJ = subSeed(seed, 'heads'), sS = subSeed(seed, 'split')
  const sI = subSeed(seed, 'insets'), sU = subSeed(seed, 'unit')
  // the size ranges are the STONES'; a module (joint centre to joint centre) adds the mean joint width
  const jAvg = (P.jMin + P.jMax) / 2
  // course heights within hMin..hMax (+ joint), scaled so they sum to the tile height exactly (periodic in y)
  const nc = Math.max(1, Math.round(h / ((P.hMin + P.hMax) / 2 + jAvg)))
  const ch = fitSum(Array.from({ length: nc }, (_, c) => lerp(P.hMin + jAvg, P.hMax + jAvg, hashF(c, 0, sC))), P.hMin + jAvg, P.hMax + jAvg, h)
  const cy = [0]
  for (let c = 0; c < nc; c++) cy.push(c + 1 === nc ? h : cy[c] + ch[c])
  // wobbling course lines: m vertices across the period; line nc is line 0 shifted down by h
  const m = Math.max(3, Math.round(w / P.lineStep)), dxl = w / m
  const off = []
  for (let i = 0; i < nc; i++) {
    const above = i ? cy[i] - cy[i - 1] : cy[nc] - cy[nc - 1], lim = Math.min(P.wobble, (P.wobbleShare ?? 0.12) * Math.min(cy[i + 1] - cy[i], above))
    const a = []
    for (let k = 0; k < m; k++) a.push((hashF(i, k, sL) - 0.5) * 2 * lim)
    off.push(a)
  }
  const lineY = (i, x) => {
    const a = off[i % nc], u = x / dxl, k = Math.floor(u), t = u - k, k0 = pmodi(k, m), k1 = k0 + 1 === m ? 0 : k0 + 1
    return cy[i] + a[k0] + (a[k1] - a[k0]) * t
  }
  const units = []
  const halfJ = (key, side) => lerp(P.jMin, P.jMax, hashF(key, side, sI)) / 2
  const pushStone = (cell, dEdge, course, col, split, key) => {
    // drop near-duplicate vertices (they would give zero-length edges)
    const V = [], D = []
    const nn = cell.length >> 1
    for (let i = 0; i < nn; i++) {
      const x = cell[2 * i], y = cell[2 * i + 1], px = V.length ? V[V.length - 2] : cell[2 * nn - 2], py = V.length ? V[V.length - 1] : cell[2 * nn - 1]
      if (V.length && hyp(x - px, y - py) < 1e-6) { D[D.length - 1] = dEdge[i]; continue }
      V.push(x, y); D.push(dEdge[i])
    }
    const [bx0, by0, bx1, by1] = bboxOf(V)
    const sV = polyArea(V), ok = (Q) => Q && Q.every(Number.isFinite) && polyArea(Q) * sV > 0 && Math.abs(polyArea(Q)) >= 1e-6
    let r = Math.min(lerp(P.rMin, P.rMax, hashF(key, 7, sI)), 0.2 * Math.min(bx1 - bx0, by1 - by0))
    const inner = insetPoly(V, D.map((d) => d + r))
    let poly = ok(inner) ? roundOutset(inner, r) : null
    if (!ok(poly)) { poly = insetPoly(V, D); r = 0 }                                     // no room to round: a plain inset
    if (!ok(poly)) return
    let [x0, y0, x1, y1] = bboxOf(poly)
    const sx = -w * Math.floor(x0 / w), sy = -h * Math.floor(y0 / h)                     // bbox corner into [0, w) × [0, h)
    if (sx || sy) { for (let i = 0; i < poly.length; i += 2) { poly[i] += sx; poly[i + 1] += sy } x0 += sx; x1 += sx; y0 += sy; y1 += sy }
    const id = units.length
    units.push({ id, kind: 'stone', course, col, split, x0, y0, x1, y1, poly, jointDepth: lerp(P.dMin, P.dMax, hashF(key, 8, sI)), radius: r, rnd: unitRnd(sU, id) })
  }
  const between = (line, xa, xb, desc) => {                                              // polyline vertices strictly inside (xa, xb)
    const out = []
    const j0 = Math.floor(xa / dxl) + 1, j1 = Math.ceil(xb / dxl) - 1
    if (!desc) { for (let j = j0; j <= j1; j++) { const x = j * dxl; if (x > xa + 1e-6 && x < xb - 1e-6) out.push(x, lineY(line, x)) } }
    else { for (let j = j1; j >= j0; j--) { const x = j * dxl; if (x > xa + 1e-6 && x < xb - 1e-6) out.push(x, lineY(line, x)) } }
    return out
  }
  const coursesOut = []
  for (let c = 0; c < nc; c++) {
    const n = Math.max(1, Math.round(w / ((P.wMin + P.wMax) / 2 + jAvg)))
    const ws = fitSum(Array.from({ length: n }, (_, k) => lerp(P.wMin + jAvg, P.wMax + jAvg, hashF(c, k, sJ))), P.wMin + jAvg, P.wMax + jAvg, w)
    const phase = hashF(c, 9999, sJ) * w
    const xt = [], xb = []
    let acc = phase
    for (let k = 0; k < n; k++) { xt.push(acc); acc += ws[k] }
    xt.push(phase + w)
    for (let k = 0; k < n; k++) xb.push(xt[k] + (hashF(c, k, (sJ ^ 0x5A17) >>> 0) - 0.5) * 2 * P.slant)
    xb.push(xb[0] + w)
    coursesOut.push({ top: cy[c], height: cy[c + 1] - cy[c], stones: n })
    const tall = cy[c + 1] - cy[c] >= 2 * (P.hMin + jAvg) * 0.9
    for (let k = 0; k < n; k++) {
      const key = c * 4096 + k * 4
      const A = [xt[k], lineY(c, xt[k])], B = [xt[k + 1], lineY(c, xt[k + 1])], C = [xb[k + 1], lineY(c + 1, xb[k + 1])], D = [xb[k], lineY(c + 1, xb[k])]
      const top = between(c, A[0], B[0], false), bot = between(c + 1, D[0], C[0], true)
      const dT = halfJ(key, 0), dB = halfJ(key, 1), dL = halfJ(key, 2), dR = halfJ(key, 3)
      if (!(tall && hashF(c, k, sS) < P.split)) {
        const cell = [...A, ...top, ...B, ...C, ...bot, ...D]
        const d = [...Array(top.length / 2 + 1).fill(dT), dR, ...Array(bot.length / 2 + 1).fill(dB), dL]
        pushStone(cell, d, c, k, 0, key)
      } else {
        const fL = lerp(0.42, 0.58, hashF(key, 4, sS)), fR = lerp(0.42, 0.58, hashF(key, 5, sS))
        const E = [lerp(A[0], D[0], fL), lerp(A[1], D[1], fL)], F = [lerp(B[0], C[0], fR), lerp(B[1], C[1], fR)]
        const dS = halfJ(key + 1, 0), dS2 = halfJ(key + 2, 0)
        pushStone([...A, ...top, ...B, ...F, ...E], [...Array(top.length / 2 + 1).fill(dT), dR, dS, dL], c, k, 1, key + 1)
        if (!P.splitHead || C[0] - D[0] < 1.8 * P.wMin) pushStone([...E, ...F, ...C, ...bot, ...D], [dS2, dR, ...Array(bot.length / 2 + 1).fill(dB), dL], c, k, 2, key + 2)
        else {
          // the lower stone cut by its own head joint (G on E–F, Q on the course line below), so the pair does not stack
          const tg = lerp(P.splitHead[0], P.splitHead[1], hashF(key, 6, sS)), tq = tg + (hashF(key, 7, sS) - 0.5) * 2 * P.slant / Math.max(1e-6, C[0] - D[0])
          const G = [lerp(E[0], F[0], tg), lerp(E[1], F[1], tg)], qx = lerp(D[0], C[0], c01(tq)), Q = [qx, lineY(c + 1, qx)], dM = halfJ(key + 3, 0)
          const botL = between(c + 1, D[0], qx, true), botR = between(c + 1, qx, C[0], true)
          pushStone([...E, ...G, ...Q, ...botL, ...D], [dS2, dM, ...Array(botL.length / 2 + 1).fill(dB), dL], c, k, 2, key + 2)
          pushStone([...G, ...F, ...C, ...botR, ...Q], [dS2, dR, ...Array(botR.length / 2 + 1).fill(dB), dM], c, k, 3, key + 3)
        }
      }
    }
  }
  return { kind: 'formstone', w, h, periodic: true, seed: seed >>> 0, nominal: { ...FORMSTONE }, courses: coursesOut, units }
}

// a pointed oval ("boat") veneer patch: long half-axis `a` along the grain, short half-axis `b`, n points per side, rotated by tilt
function boatPoly(x, y, a, b, alongY, tilt, n = 10) {
  const pts = []
  const push = (u, v) => {
    let px = alongY ? v : u, py = alongY ? u : v
    const c = Math.cos(tilt), s = Math.sin(tilt)
    pts.push(x + px * c - py * s, y + px * s + py * c)
  }
  for (let i = 0; i <= n; i++) { const u = -1 + (2 * i) / n; push(u * a, b * Math.pow(Math.max(0, 1 - u * u), 0.7)) }
  for (let i = n - 1; i >= 1; i--) { const u = -1 + (2 * i) / n; push(u * a, -b * Math.pow(Math.max(0, 1 - u * u), 0.7)) }
  return pts
}

export function layoutPlywood(w, h, seed, o = {}) {
  const P = { ...PLYWOOD, ...o }
  const orient = P.orient && P.orient !== 'auto' ? P.orient : h >= w ? 'vertical' : 'horizontal'
  const sw = orient === 'vertical' ? P.sheet[0] : P.sheet[1], sh = orient === 'vertical' ? P.sheet[1] : P.sheet[0]
  const ov = Math.min(P.overlap, w / 4, h / 4)
  const op = o.opening ? { x0: o.opening.x0, y0: o.opening.y0, x1: o.opening.x1, y1: o.opening.y1 } : { x0: ov, y0: ov, x1: w - ov, y1: h - ov }
  if (!(op.x1 > op.x0 && op.y1 > op.y0)) throw new Error('layoutPlywood: empty opening')
  const sA = subSeed(seed, 'age'), sU = subSeed(seed, 'sheet')
  const age = lerp(P.age[0], P.age[1], hashF(0, 0, sA))
  const units = []
  const nx = Math.max(1, Math.ceil(w / sw - 1e-9)), ny = Math.max(1, Math.ceil(h / sh - 1e-9)), g = P.gap / 2
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const cx0 = i * sw, cx1 = Math.min(w, (i + 1) * sw), cy0 = j * sh, cy1 = Math.min(h, (j + 1) * sh), id = units.length
    units.push({ id, kind: 'sheet', col: i, course: j, x0: cx0 + (i > 0 ? g : 0), y0: cy0 + (j > 0 ? g : 0), x1: cx1 - (i < nx - 1 ? g : 0), y1: cy1 - (j < ny - 1 ? g : 0),
      cut: cx1 - cx0 < sw - 1e-9 || cy1 - cy0 < sh - 1e-9, grain: orient === 'vertical' ? 'y' : 'x', age: c01(age + (hashF(id, 1, sA) - 0.5) * 0.12), rnd: unitRnd(sU, id) })
  }
  // strongbacks behind the board at 1/3 and 2/3 of the opening height; two carriage bolts each at ±1/4 of the opening width
  const oh = op.y1 - op.y0, ow = op.x1 - op.x0, ocx = (op.x0 + op.x1) / 2, sB = subSeed(seed, 'bolts')
  const strongbacks = [1, 2].map((k, id) => ({ id, y: op.y0 + (oh * k) / 3, x0: op.x0, x1: op.x1, depth: P.strongback }))
  const bolts = []
  for (const sb of strongbacks) for (const side of [-1, 1]) {
    const id = bolts.length
    bolts.push({ id, x: ocx + (side * ow) / 4, y: sb.y, headR: P.boltHead / 2, washerR: P.washer / 2, strongback: sb.id, rnd: unitRnd(sB, id) })
  }
  // perimeter screws: every <= screwSpacing along each sheet edge, screwInset in from it, corners included once
  const screws = [], sS = subSeed(seed, 'screws')
  for (const u of units) {
    const a0 = u.x0 + P.screwInset, b0 = u.y0 + P.screwInset, a1 = u.x1 - P.screwInset, b1 = u.y1 - P.screwInset
    if (a1 <= a0 || b1 <= b0) continue
    const C = [[a0, b0], [a1, b0], [a1, b1], [a0, b1]]
    for (let e = 0; e < 4; e++) {
      const [ax, ay] = C[e], [bx, by] = C[(e + 1) % 4], len = hyp(bx - ax, by - ay), n = Math.max(1, Math.ceil(len / P.screwSpacing - 1e-9))
      const ex = (bx - ax) / len, ey = (by - ay) / len
      for (let q = 0; q < n; q++) {
        const id = screws.length, t = q / n
        const along = q === 0 ? 0 : (hashF(id, 0, sS) - 0.5) * 0.006, across = (hashF(id, 1, sS) - 0.5) * 0.004
        screws.push({ id, x: ax + (bx - ax) * t + ex * along - ey * across, y: ay + (by - ay) * t + ey * along + ex * across, r: P.screwHead / 2, sheet: u.id, rnd: unitRnd(sS, id) })
      }
    }
  }
  // oval veneer patches along the grain, clear of the sheet edges, the bolts and each other
  const patches = [], sP = subSeed(seed, 'patches')
  for (const u of units) {
    const alongY = u.grain === 'y', count = Math.floor((u.x1 - u.x0) * (u.y1 - u.y0) * P.patchDensity + hashF(u.id, 0, sP))
    for (let tries = 0, made = 0; made < count && tries < count * 16; tries++) {
      const t = u.id * 4093 + tries
      const a = lerp(P.patchLen[0], P.patchLen[1], hashF(t, 1, sP)) / 2, b = lerp(P.patchWid[0], P.patchWid[1], hashF(t, 2, sP)) / 2
      const rx = alongY ? b : a, ry = alongY ? a : b, mg = 0.08
      if (u.x1 - u.x0 < 2 * (mg + rx) || u.y1 - u.y0 < 2 * (mg + ry)) break
      const x = lerp(u.x0 + mg + rx, u.x1 - mg - rx, hashF(t, 3, sP)), y = lerp(u.y0 + mg + ry, u.y1 - mg - ry, hashF(t, 4, sP))
      if (bolts.some((bo) => hyp(bo.x - x, bo.y - y) < bo.washerR + a + 0.02)) continue
      if (patches.some((p) => hyp(p.x - x, p.y - y) < Math.max(p.rx, p.ry) + a + 0.01)) continue
      const tilt = (hashF(t, 5, sP) - 0.5) * 0.1, poly = boatPoly(x, y, a, b, alongY, tilt)
      const [x0, y0, x1, y1] = bboxOf(poly), id = patches.length
      patches.push({ id, kind: 'patch', sheet: u.id, x, y, rx, ry, tilt, poly, x0, y0, x1, y1, rnd: unitRnd(sP, id) })
      made++
    }
  }
  const sM = subSeed(seed, 'mark')
  const mark = { present: hashF(0, 0, sM) < 0.5, x: w / 2 + (hashF(0, 1, sM) - 0.5) * 0.2 * w, y: lerp(0.22, 0.36, hashF(0, 2, sM)) * h }
  return { kind: 'plywood', w, h, periodic: false, seed: seed >>> 0, orient, nominal: { ...PLYWOOD, sheet: [...PLYWOOD.sheet] }, opening: op, age,
    units, patches, strongbacks, bolts, screws, mark,
    waterLine: lerp(0.10, 0.20, hashF(0, 3, sM)), delam: [0.25, 0.25, 0.4, 0.4].map((p, k) => hashF(k, 4, sM) < p) }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §6 Colour rule: recipe colour = target × materialHex / stockHex, per channel
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export const STOCK_HEX = Object.freeze({ F: '#B8A888', C: '#8F8F8F', P: '#7A6A52', B: '#8A4A3A', W: '#141414', O: '#7A5A48', M: '#D2D0C8', floor: '#5A5048' })
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return null
  const s = hex.replace('#', '')
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null
  const n = parseInt(s, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
export const stockOf = (codeOrHex) => STOCK_HEX[codeOrHex] || codeOrHex
export function relColour(target, matHex, stockHex) {
  const t = Array.isArray(target) ? target : hexToRgb(target)
  if (!t) throw new Error(`relColour: bad target ${target}`)
  const st = hexToRgb(stockOf(stockHex))
  if (!st) throw new Error(`relColour: bad stock ${stockHex}`)
  const m = hexToRgb(matHex) || st
  return [st[0] ? (t[0] * m[0]) / st[0] : t[0], st[1] ? (t[1] * m[1]) / st[1] : t[1], st[2] ? (t[2] * m[2]) / st[2] : t[2]]
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §7 Decals and masks (metres)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export const edgeFade = (v, size, m0 = 4 / 32, m1 = 10 / 32) => sstep(m0, m1, Math.min(v, size - v))
const needWH = (o, who) => { if (!(o.w > 0) || !(o.h > 0)) throw new Error(`${who}: w and h (metres) required`) }

export function makeSootStreaks(seed, o) {
  needWH(o, 'makeSootStreaks')
  const w = o.w, periodic = o.periodic !== false, avoid = o.avoidEdges !== false, top = o.top ?? 0, n = o.count ?? 6
  const L = [o.lenMin ?? 0.35, o.lenMax ?? 1.3], Wd = [o.widthMin ?? 0.03, o.widthMax ?? 0.09], str = o.strength ?? 1
  const AMP = o.amp ?? [0.005, 0.02], spread = o.spread ?? 0, linear = o.edge === 'linear'
  const streaks = []
  for (let k = 0; k < n; k++) {
    const hw = lerp(Wd[0], Wd[1], hashF(k, 2, seed)) / 2, wmax = hw * (1 + spread), lo = avoid ? 2 * EDGE_M + wmax : 0, hi = avoid ? w - 2 * EDGE_M - wmax : w
    if (hi <= lo) break
    streaks.push({ x: lerp(lo, hi, hashF(k, 0, seed)), len: lerp(L[0], L[1], hashF(k, 1, seed)), hw, a: str * (0.5 + 0.5 * hashF(k, 3, seed)),
      amp: lerp(AMP[0], AMP[1], hashF(k, 4, seed)), wl: lerp(0.5, 1.2, hashF(k, 5, seed)), ph: hashF(k, 6, seed) * 6.283185307179586 })
  }
  const f = (x, y) => {
    let keep = 1
    for (const st of streaks) {
      const t = (y - top) / st.len
      if (t < 0 || t >= 1) continue
      let dx = x - st.x - st.amp * Math.sin((6.283185307179586 * (y - top)) / st.wl + st.ph)
      if (periodic) dx = wrapD(dx, w)
      const q = 1 - Math.abs(dx) / (spread ? st.hw * (1 + spread * t) : st.hw)
      if (q <= 0) continue
      keep *= 1 - c01(st.a * Math.pow(1 - t, 1.2) * (linear ? q : q * q * (3 - 2 * q)))
    }
    return 1 - keep
  }
  f.streaks = streaks
  return f
}

export function makeDampFoot(seed, o) {
  needWH(o, 'makeDampFoot')
  const h = o.h, H = o.height ?? 0.40, jag = o.jag ?? 0.04, tide = o.tide ?? 0.012
  const n = makeFbm(seed, { periodX: o.w, periodY: h, feature: o.feature ?? 0.3, octaves: 3 })
  const f = (x, y) => {
    const sd = y - (h - H - jag * n(x, 0)), q = sd / tide
    const k = sd > 0 ? 0.75 + 0.25 * c01(sd / H) : 0
    return Math.max(k, 0.9 * Math.exp(-q * q))
  }
  f.line = h - H
  return f
}

export function makeRustRuns(seed, o) {
  needWH(o, 'makeRustRuns')
  const w = o.w, periodic = o.periodic !== false, L = [o.lenMin ?? 0.06, o.lenMax ?? 0.30], wd = o.width ?? 0.010, str = o.strength ?? 1
  const AMP = o.amp ?? [0.001, 0.004], WL = o.wl ?? [0.05, 0.12], HEAD = o.head ?? [0.8, 0.9]
  const runs = (o.sources || []).map((p, k) => {
    const x = Array.isArray(p) ? p[0] : p.x, y = Array.isArray(p) ? p[1] : p.y
    return { x, y, len: lerp(L[0], L[1], hashF(k, 0, seed)), w: wd * lerp(0.6, 1.2, hashF(k, 1, seed)), a: str * (0.6 + 0.4 * hashF(k, 2, seed)),
      amp: lerp(AMP[0], AMP[1], hashF(k, 3, seed)), wl: lerp(WL[0], WL[1], hashF(k, 4, seed)), ph: hashF(k, 5, seed) * 6.283185307179586 }
  })
  const f = (x, y) => {
    let keep = 1
    for (const r of runs) {
      let dx0 = x - r.x
      if (periodic) dx0 = wrapD(dx0, w)
      const dy0 = y - r.y
      let k = HEAD[0] * r.a * c01(1 - hyp(dx0, dy0) / (HEAD[1] * r.w))
      const t = dy0 / r.len
      if (t >= 0 && t < 1) {
        const dx = dx0 - r.amp * Math.sin((6.283185307179586 * dy0) / r.wl + r.ph), hw = r.w * 0.5 * (1 - 0.55 * t), q = 1 - Math.abs(dx) / hw
        if (q > 0) k = Math.max(k, r.a * Math.pow(1 - t, 0.9) * q * q * (3 - 2 * q))
      }
      keep *= 1 - c01(k)
    }
    return 1 - keep
  }
  f.runs = runs
  return f
}

export function makeEfflorescence(seed, o) {
  needWH(o, 'makeEfflorescence')
  const w = o.w, h = o.h, H = o.height ?? 0.30, density = o.density ?? 0.5, foot = o.foot ?? h, grain = o.grain ?? 0.006, soft = o.soft ?? 0.05
  const blot = makeFbm(subSeed(seed, 'blot'), { periodX: w, periodY: h, feature: o.feature ?? 0.08, octaves: 3 })
  const edge = makeFbm(subSeed(seed, 'edge'), { periodX: w, periodY: h, feature: 0.15, octaves: 2 })
  const fine = makeValueNoise(subSeed(seed, 'fine'), { periodX: w, periodY: h, feature: grain })
  const xr = o.x0 != null && o.x1 != null ? [o.x0, o.x1] : null
  const f = (x, y, texel = 0) => {
    const z = foot - y
    if (z < 0 || z > H * 1.3) return 0
    const fall = 1 - sstep(0.25 * H, H, z + 0.05 * edge(x, y))
    if (fall <= 0) return 0
    const side = xr ? sstep(xr[0], xr[0] + soft, x) * (1 - sstep(xr[1] - soft, xr[1], x)) : 1
    if (side <= 0) return 0
    const crust = sstep(1 - density - 0.12, 1 - density + 0.12, 0.5 + 0.5 * blot(x, y, texel))
    return c01(crust * fall * side * (0.55 + 0.45 * fine(x, y, texel)))
  }
  return f
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §8 EDGE: every variant restores its outer EDGE_M metres from the substrate (gfx-textures.js:186 restoreEdges, in metres)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export const EDGE = 3
export const EDGE_M = EDGE / JS_TPM
export const edgeTexels = (tpm, m = EDGE_M) => Math.round(m * tpm)
export function restoreEdges(V, S, o = {}) {
  if (V.w !== S.w || V.h !== S.h) throw new Error('restoreEdges: variant and substrate differ in size')
  const tpm = V.w / V.w_m, cols = edgeTexels(tpm, o.cols ?? EDGE_M), rows = edgeTexels(V.h / V.h_m, o.rows ?? 0)
  for (let y = 0; y < V.h; y++) for (let x = 0; x < V.w; x++) {
    if (!(x < cols || x >= V.w - cols || y < rows || y >= V.h - rows)) continue
    const t = y * V.w + x
    V.rgb[t * 3] = S.rgb[t * 3]; V.rgb[t * 3 + 1] = S.rgb[t * 3 + 1]; V.rgb[t * 3 + 2] = S.rgb[t * 3 + 2]; V.cav[t] = S.cav[t]
    if (V.height && S.height) V.height[t] = S.height[t]
  }
  return V
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §9 Recipe scaffold
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor
export function makeRecipe(def) {
  if (!def || typeof def.paint !== 'function') throw new Error('makeRecipe: paint(ctx) required')
  const stockHex = stockOf(def.stock)
  if (!hexToRgb(stockHex)) throw new Error(`makeRecipe ${def.name}: bad stock ${def.stock}`)
  // a generator paint (*paint(ctx), §3b) runs its passes as `yield* ctx.raster(...)`; a plain paint(ctx) gets the plain rasterize
  const stepped = def.paint instanceof GeneratorFunction
  function* steps(w_m, h_m, tpm, seed, matHex, opts = {}) {
    const R = newRaster(w_m, h_m, tpm, { height: def.height !== false })
    const mat = hexToRgb(matHex) ? matHex : stockHex, s0 = seed >>> 0, ss = opts.ss ?? 'auto'
    const per = (o) => ({ periodX: w_m, periodY: h_m, ...o })
    const pass = { ss, origin: opts.origin, wrap: opts.wrap }
    const ctx = { R, w_m, h_m, tpm, seed: s0, matHex: mat, stockHex, opts, ss,
      col: (t) => relColour(t, mat, stockHex), sub: (tag) => subSeed(s0, tag), rng: (tag) => mulberry32(subSeed(s0, tag)),
      fbm: (tag, o) => makeFbm(subSeed(s0, tag), per(o)), noise: (tag, o) => makeValueNoise(subSeed(s0, tag), per(o)),
      voronoi: (tag, o) => makeVoronoi(subSeed(s0, tag), per(o)), warp: (tag, o) => makeWarp(subSeed(s0, tag), per(o)),
      raster: stepped ? (shader, o = {}) => rasterizeSteps(R, shader, { ...pass, ...o }) : (shader, o = {}) => rasterize(R, shader, { ...pass, ...o }) }
    const meta = stepped ? yield* def.paint(ctx) : def.paint(ctx)
    if (meta !== undefined) R.meta = meta
    if (due()) yield
    return finishRecipe(R, def.name)
  }
  // recipe(...) → Raster, built in one go; recipe.steps(...) the same build as a stepped job (§3b) → Raster
  const recipe = (w_m, h_m, tpm, seed, matHex, opts = {}) => drain(steps(w_m, h_m, tpm, seed, matHex, opts))
  recipe.steps = steps
  recipe.recipeName = def.name; recipe.stock = def.stock; recipe.periodic = def.periodic !== false
  return recipe
}
// the scaffold's last step: rgb clamped to 0..255 and cav to 0..1, any non-finite value an error
function finishRecipe(R, name) {
  for (let i = 0; i < R.rgb.length; i++) {
    const v = R.rgb[i]
    if (!Number.isFinite(v)) throw new Error(`${name}: non-finite rgb at ${i}`)
    R.rgb[i] = v < 0 ? 0 : v > 255 ? 255 : v
  }
  for (let i = 0; i < R.cav.length; i++) {
    const v = R.cav[i]
    if (!Number.isFinite(v)) throw new Error(`${name}: non-finite cav at ${i}`)
    R.cav[i] = v < 0 ? 0 : v > 1 ? 1 : v
  }
  if (R.height) for (let i = 0; i < R.height.length; i++) if (!Number.isFinite(R.height[i])) throw new Error(`${name}: non-finite height at ${i}`)
  return R
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §11 The glyph test: a 5 × 7 bitmap of every digit and capital letter, and the distance of a mark from each of them
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const G = (s) => Object.freeze(s.split(' '))
export const FONT_5X7 = Object.freeze({
  0: G('.###. #...# #..## #.#.# ##..# #...# .###.'), 1: G('..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.'),
  2: G('.###. #...# ....# ...#. ..#.. .#... #####'), 3: G('##### ...#. ..#.. ...#. ....# #...# .###.'),
  4: G('...#. ..##. .#.#. #..#. ##### ...#. ...#.'), 5: G('##### #.... ####. ....# ....# #...# .###.'),
  6: G('..##. .#... #.... ####. #...# #...# .###.'), 7: G('##### ....# ...#. ..#.. .#... .#... .#...'),
  8: G('.###. #...# #...# .###. #...# #...# .###.'), 9: G('.###. #...# #...# .#### ....# ...#. .##..'),
  A: G('.###. #...# #...# #...# ##### #...# #...#'), B: G('####. #...# #...# ####. #...# #...# ####.'),
  C: G('.###. #...# #.... #.... #.... #...# .###.'), D: G('###.. #..#. #...# #...# #...# #..#. ###..'),
  E: G('##### #.... #.... ####. #.... #.... #####'), F: G('##### #.... #.... ####. #.... #.... #....'),
  G: G('.###. #...# #.... #.### #...# #...# .####'), H: G('#...# #...# #...# ##### #...# #...# #...#'),
  I: G('.###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.'), J: G('..### ...#. ...#. ...#. ...#. #..#. .##..'),
  K: G('#...# #..#. #.#.. ##... #.#.. #..#. #...#'), L: G('#.... #.... #.... #.... #.... #.... #####'),
  M: G('#...# ##.## #.#.# #.#.# #...# #...# #...#'), N: G('#...# #...# ##..# #.#.# #..## #...# #...#'),
  O: G('.###. #...# #...# #...# #...# #...# .###.'), P: G('####. #...# #...# ####. #.... #.... #....'),
  Q: G('.###. #...# #...# #...# #.#.# #..#. .##.#'), R: G('####. #...# #...# ####. #.#.. #..#. #...#'),
  S: G('.#### #.... #.... .###. ....# ....# ####.'), T: G('##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..'),
  U: G('#...# #...# #...# #...# #...# #...# .###.'), V: G('#...# #...# #...# #...# #...# .#.#. ..#..'),
  W: G('#...# #...# #...# #.#.# #.#.# #.#.# .#.#.'), X: G('#...# #...# .#.#. ..#.. .#.#. #...# #...#'),
  Y: G('#...# #...# #...# .#.#. ..#.. ..#.. ..#..'), Z: G('##### ....# ...#. ..#.. .#... #.... #####'),
})
export const GLYPHS = Object.freeze(Object.keys(FONT_5X7))
export const GLYPH_MIN_DISTANCE = 6

export function toBits5x7(mask) {
  const o = new Uint8Array(35)
  if (mask && mask.length === 7 && (typeof mask[0] === 'string' || Array.isArray(mask[0]) || ArrayBuffer.isView(mask[0]))) {
    for (let y = 0; y < 7; y++) {
      const row = mask[y]
      if (!row || row.length !== 5) throw new Error('toBits5x7: each row must have 5 cells')
      for (let x = 0; x < 5; x++) { const v = row[x]; o[y * 5 + x] = typeof v === 'string' ? (v === '#' || v === '1' ? 1 : 0) : v ? 1 : 0 }
    }
    return o
  }
  if (!mask || mask.length !== 35) throw new Error('toBits5x7: expected 35 cells or 7 rows of 5')
  for (let i = 0; i < 35; i++) o[i] = mask[i] ? 1 : 0
  return o
}
const GLYPH_BITS = new Map(GLYPHS.map((g) => [g, toBits5x7(FONT_5X7[g])]))
const bitsOf = (m) => (typeof m === 'string' && GLYPH_BITS.has(m) ? GLYPH_BITS.get(m) : toBits5x7(m))
export function glyphDistance(mask, glyph) {
  const a = bitsOf(mask), b = bitsOf(glyph)
  let d = 0
  for (let i = 0; i < 35; i++) if (a[i] !== b[i]) d++
  return d
}
export function mirror5x7(mask) {
  const a = toBits5x7(mask), o = new Uint8Array(35)
  for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) o[y * 5 + x] = a[y * 5 + 4 - x]
  return o
}
export function maskTo5x7(sample, x0, y0, x1, y1, o = {}) {
  const thr = o.thr ?? 0.5, ss = o.ss ?? 8, out = new Uint8Array(35), cw = (x1 - x0) / 5, ch = (y1 - y0) / 7
  for (let cy = 0; cy < 7; cy++) for (let cx = 0; cx < 5; cx++) {
    let s = 0
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) s += sample(x0 + (cx + (i + 0.5) / ss) * cw, y0 + (cy + (j + 0.5) / ss) * ch)
    out[cy * 5 + cx] = s / (ss * ss) >= thr ? 1 : 0
  }
  return out
}
export function fitMaskTo5x7(values, w, h, o = {}) {
  const on = o.on ?? 0.5, thr = o.thr ?? 0.5, out = new Uint8Array(35)
  let bx0 = w, by0 = h, bx1 = -1, by1 = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (values[y * w + x] >= on) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y) }
  if (bx1 < 0) return out
  const X0 = bx0, Y0 = by0, BW = bx1 + 1 - bx0, BH = by1 + 1 - by0
  for (let cy = 0; cy < 7; cy++) for (let cx = 0; cx < 5; cx++) {
    const ax = X0 + (cx * BW) / 5, bx = X0 + ((cx + 1) * BW) / 5, ay = Y0 + (cy * BH) / 7, by = Y0 + ((cy + 1) * BH) / 7
    let s = 0, a = 0
    for (let y = Math.floor(ay); y < Math.ceil(by); y++) for (let x = Math.floor(ax); x < Math.ceil(bx); x++) {
      const wgt = (Math.min(bx, x + 1) - Math.max(ax, x)) * (Math.min(by, y + 1) - Math.max(ay, y))
      if (wgt > 0) { s += wgt * values[y * w + x]; a += wgt }
    }
    out[cy * 5 + cx] = a > 0 && s / a >= thr ? 1 : 0
  }
  return out
}
export function glyphTest(mask, o = {}) {
  const min = o.min ?? GLYPH_MIN_DISTANCE, a = toBits5x7(mask), cands = o.mirror === false ? [[a, false]] : [[a, false], [mirror5x7(a), true]]
  let best = { distance: Infinity, nearest: null, mirrored: false }
  for (const [m, mirrored] of cands) for (const g of GLYPHS) {
    const d = glyphDistance(m, g)
    if (d < best.distance) best = { distance: d, nearest: g, mirrored }
  }
  return { pass: best.distance >= min, ...best }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  PART II — THE MASONRY PAINTERS: pressed and common brick, painted brick, formstone, marble, CMU, the parge of an exposed party wall,
//  arch bands, and the decay each shows on a Harlem Park rowhouse back. Built ON part I: its API is used, never changed.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// Pure and seeded, in the style of gfx-textures.js: no DOM, no Math.random, no image reads, no imports, no state that
// outlives a call. Every pixel comes from code and seeds; nothing is traced, sampled or copied from any photograph or real facade. No
// digit, letter, symbol or word is painted anywhere (these painters draw no marks at all).
//
// Conventions are the core's (its header): metres, y DOWN from the top edge (y = h_m is the FOOT of the wall), tpm = texels per metre
// (32 in the game, 128 fine), a recipe is (w_m, h_m, tpm, seed, matHex, opts) → Raster { w, h, rgb, cav, height, meta }. Every shader below is a
// pure function of the sub-sample position, its footprint (s.fx) and the layer hits, so with ss 'auto' a 32 tpm render IS the 128 tpm
// render box-downsampled. Detail finer than two 128 tpm texels (marble sugar, CMU aggregate, mica, mortar sand) is band-limited: it is
// there at 128 tpm and fades to its mean when one sample covers a coarser footprint (ss 1 at 32 tpm).
//
// Light: the game's renderers draw these tiles unlit and shadowless. The cavity channel `cav` is pure occlusion (joints, pits, recesses
// darker; no direction). The RGB carries the same occlusion and, for relief only, a soft overcast SKY term: surfaces that tilt up get a
// little more light, surfaces that tilt down a little less (an up-facing surface ×1.06, a soffit ×0.55, at texture scale). No sun.
// The RGB is the FINAL albedo: its joints, pits and recesses are already as dark as they should read. A material must not multiply the
// cavity in again at full strength (formstone joints would fall to ~0.3 of the face, brick joints to ~0.5: black grids under the flat
// light); it may use at most lerp(1, cav, 0.25) as extra texture AO.
//
// Decals: a painter whose variant draws stroke-like decals (cracks, rust runs, soot streaks) also sets R.decal, a Float32Array(w·h) of
// their box-filtered coverage 0..1 on the same texel grid, so the glyph test for decals (part III) can check that none reads as a letter.
//
// Periodicity: the BASE of every tiled recipe wraps in x and y with no seam. VARIANTS (decay, stains, holes, openings) are painted over
// the same substrate with every change faded to nothing within the core's edgeFade margin (12.5 cm) of the left and right edges, so a
// variant's outer EDGE columns equal its base exactly (gfx-textures.js's restoreEdges contract) and variants wrap in x. Decay that is anchored to
// the top or the foot of a wall (soot from the top, a damp foot, efflorescence) does not wrap in y; stacked bands rely on the way they
// are stacked and on restoreEdges rows, as the core's notes say.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  API
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  Every recipe takes the core recipe signature; opts.ss, opts.origin and opts.wrap are honoured as in the core. Common opts:
//   foot   (false)  the tile stands on the yard: a damp foot (40 cm, −8% value) and splash-back grime in the bottom 30 cm.
//                   Breaks y-periodicity.
//  paintPressedBrick   stock 'B', periodic. Running bond face brick (layoutBrick 'running': course 6.25 cm, stretcher 22.2 cm, joint
//                   4.8 mm): #7E3A2C ±5% value, sharp arrises, thin flush joints #B9B2A3. opts: striped (white-striped joints #DDD8CC,
//                   a house's own pointing), grime (0..1, default 0.35). meta: { striped, grime }
//  paintCommonBrick    stock 'B', periodic. Common bond (layoutBrick 'common': a header course every 6th, course 6.67 cm, joints 1.0–1.3
//                   cm recessed ×0.78, 5 mm deep). Bricks #9C5A43..#B06A4E, ±12% value, warm/cool jitter, a few clinkers and salmon
//                   bricks, darker header ends, soft arrises eroded 2–8 mm and chipped, a few sand pits; mortar #B9B2A3 eroded (the
//                   old lime pointing).
//                   opts.variant: COMMON_BRICK_VARIANTS
//                     'base'          the substrate: lime pointing throughout
//                     'repointed'     a whole-surface STATE (a full periodic tile, like marble 'fresh'): the wall repointed in grey
//                                     Portland cement over 82% of its area, the old lime surviving in islands of a few bricks. Pointing
//                                     is done by area: the boundary steps along the courses and the head joints (the mask is read at
//                                     the centre of each brick cell). It belongs to a whole HOUSE, every common-brick bay of it.
//                                     R.repoint = the mask's coverage on the texel grid (the glyph test for decals can read it)
//                     'soot'          streaks from the top, a soot deposit high up, darker joints
//                     'spall'         a few brick faces gone (opts.count, default 3–6), the paler body showing, recessed
//                     'ghostOpening'  a bricked-up opening: a different brick and grey cement mortar, toothed into the old wall course
//                                     by course; the old arch kept (opts.arch 'segmental' (rowlock rings, rise 8 cm) | 'jack' | 'none';
//                                     default seeded) and the old stone sill (opts.sill, default true) with drip stains under it.
//                                     opts.opening { x0, y0, x1, y1 } metres (default 0.91 m wide, centred; head at 18%, sill at 90% of
//                                     the height), opts.rise, opts.rings
//                     'rust'          a rust run from one or two iron fixings (a hanger or a pipe strap)
//                   opts.repoint (0..1 share of grey repointing; default 0, 'repointed' 0.82). meta: { variant, repoint, ... }
//  paintPaintedBrick   stock 'B', periodic. The common-brick substrate under paint. opts.paint 'red-oxide' #7A3026 | 'cream' #D8D2C4 |
//                   'grey' #8C8A85 | a hex (default seeded); the paint fills the joints, so relief shows at ×0.4 contrast. opts.peel
//                   (0..1, default 0.12) the share of the tile where the paint has let go in sheets (an fbm mask) and the brick shows,
//                   with paint left in its joints; opts.under (an older coat seen in the peel rings: a paint name or hex | null;
//                   default seeded). meta: { paint, under, peel }
//  paintFormstone      stock 'F', periodic. layoutFormstone stones (20–60 × 12–30 cm, joints 1.5–2.5 cm, 3–6 mm deep; FS_LAYOUT:
//                   rounded corners 2–4.5 cm, course lines wandering ±2.2 cm, few split slots and never a stacked pair) with lumpy
//                   hand-tooled "coffee bean" relief (fbm 3 octaves, ±6 mm), trowel dimples, soft stone edges, a cement grime film
//                   and nearly invisible mica (+8% value on 0.3–0.6% of the face texels at 128 tpm). opts.palette 'grey' #A9A59B |
//                   'tan' #B19C7E | 'blend' (#A79F92 / #B5A58C / #A38E86 mixed WITHIN each stone, neighbours only a little apart)
//                   (default seeded); joints #87837B, a little darker than the face, not an outline. opts.mica (default true; false:
//                   no sparkle, e.g. painted over). opts.snap (the game's 32 tpm look, formstoneSnap): each texel the stone that
//                   covers most of it, 1-texel joints #6E6A63, ±7 % a stone, its edges lit top-left and dark bottom-right, one stone in
//                   seven run through two courses, 10 % darker (meta.snap); without it the recipe is unchanged.
//                   opts.variant: FORMSTONE_VARIANTS
//                     'base' | 'toneA' (a warmer re-coated patch of stones + a damp stain) | 'toneB' (a greyer patch + a damp stain) |
//                     'soot' | 'spall' (opts.share 0.10–0.25 of the tile gone to the brick beneath, with the torn lath at the edge) |
//                     'bulge' (the lath pulled loose: a domed patch ringed by cracks) | 'lathSheet' (a group of stones torn off along
//                     their joints, the sheet hanging a little askew from its top corner over the hole; in the hole the grey scratch
//                     coat with the rusty expanded-metal lath over it, brick only where the scratch coat has gone too) | 'rust' (rust
//                     bled through from the lath nails: wandering drips, and a few broken pieces along the lath rows) |
//                     'efflorescence' (salts at the foot and in the joints) | 'parge' (a grey cement patch #8A8780)
//                   opts.edgeRound   a rounded, hand-formed border band where formstone wraps an opening: true (all sides) | a side
//                                    name or list ('left' 'right' 'top' 'bottom') | { left, right, top, bottom: true | width m }.
//                                    Width default 0.07 m. Inside it the band is one row of border stones rolled over a 3.5 cm
//                                    arris (darker where it turns away, brighter on a top return, darkest on a soffit), cut off from
//                                    the field by a scored joint. Breaks periodicity on those sides.
//                   meta: { variant, palette, micaShare, ... }
//  paintMarble         stock 'M', periodic. White Beaver Dam / Cockeysville marble: two sets of low-contrast veins, cloudy mottle,
//                   sugary grain (±4%, a 7.8 mm crystal grid: visible at 128 tpm, gone at 32 with one sample per texel), soiling
//                   #7B776E in recesses and in drip washes. opts.variant: MARBLE_VARIANTS
//                     'weathered' (default: #D5D1C6) | 'fresh' (#E9E7E1, veins #BDBDB8) | 'soiled' (heavy grey-black crust) |
//                     'painted' (grey or white paint, opts.paint 'grey' | 'white' | hex, opts.peel 0..1, default 0.08–0.18: lost
//                     mostly along the top and bottom edges, the nosings) | 'crackA' (one long crack, a short spur forking off its
//                     middle third) | 'crackB' (one
//                     nearly straight diagonal through-crack, a short acute spur off it part-way along, never from one point with
//                     it, and crazing round the spur's root) | 'rustRun' (a rail foot leaded into the stone and
//                     its rust run; opts.railX, opts.railY, opts.railFoot) | 'missingCore' (the slab gone: opts.core 'rubble'
//                     #6E5A4A | 'concrete' #A3A29C, default seeded)
//                   'fresh', 'soiled', 'painted' and 'missingCore' are whole-surface STATES (full periodic tiles of their own);
//                   only 'crackA', 'crackB' and 'rustRun' are decorations over 'weathered' that keep its EDGE columns.
//                   opts.joints 'none' (default) | 'ashlar' | { course, stretcher } (fine 3 mm slab joints, dirty, worn edges),
//                   opts.tread (a tread: a worn hollow, dirt against the riser at y = h, a rounded nosing at y = 0; not periodic in y)
//  paintCmu            stock 'C', periodic. CMU in running bond (layoutCmu: 40 × 20 cm tiled, 40.6 × 20.3 nominal as an infill),
//                   aged #8E8D88 / new #A6A5A0 (opts.age 'aged' (default) | 'new' | 0..1), ±4% per unit, aggregate texture, 5% face
//                   pits, unstruck mortar squeezed out of the joints in blobs and droppings. opts.infill (or opts.periodic false):
//                   laid from the foot as an infill, alternate courses start with a cut half block; opts.cutHalves (default true)
//                   draws the cut ends rough. opts.efflorescence (default = infill): white #E6E4DC over the bottom 30 cm.
//                   opts.snap (an infill; the game's 32 tpm look): the blocks on whole texels, 13 long, courses of 7 and 6 from the
//                   foot, 1-texel joints at 0.72 of the block's value (meta.snap); without it the recipe is unchanged.
//                   meta: { infill, age, pitShare }
//  paintParge          stock 'B', periodic unless opts.ghost / opts.foot. Grey cement parge #8A8780 (trowel arcs, lifts, map cracks,
//                   rain washes) over soft salmon common brick, with patches where it has fallen (opts.fallen 0..1, default
//                   seeded 0.06–0.16). opts.ghost: true | partyWallGhost data → the ghost marks of a lost neighbour, faint, as
//                   large shapes in metres: its roof-slope line with the old exterior brick above it and the tar flashing line,
//                   floor lines with joist pockets, a soot flue band, a stair line and faded room-paint rectangles. opts.ghostK
//                   (default 1): the marks' strength (the game draws them at 3). The brick is shaded only where it shows.
//  paintPartyWall      = paintParge with ghost: true and foot: true (an exposed party wall, full height: the end of a row).
//  partyWallGhost(w, h, seed, o) → { roof: { zFront, zRear, falls, y(x) }, floors: [{ z, y }], pockets, flue, rooms, stair }
//                   the ghost geometry (metres; z up from the foot, y = h − z down from the top). o.floors (heights above the foot,
//                   default [0.76, 3.96]: the jut's basement and storeys), o.roofZ, o.slope, o.falls 'left' | 'right'.
//  Constants: MASONRY (the colour targets), BRICK_PAINTS, FORMSTONE_PALETTES, ROOM_PAINTS, COMMON_BRICK_VARIANTS, FORMSTONE_VARIANTS,
//   MARBLE_VARIANTS, MASONRY_RECIPES (name → recipe), MASONRY_VARIANTS (name → variant list)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const TAU = 6.283185307179586

// the colour targets at the stock hexes (chosen values: no colour is sampled from a photograph)
export const MASONRY = Object.freeze({
  pressed: '#7E3A2C', mortar: '#B9B2A3', stripe: '#DDD8CC', commonA: '#9C5A43', commonB: '#B06A4E',
  formJoint: '#87837B', parge: '#8A8780',
  marbleWeathered: '#D5D1C6', marbleFresh: '#E9E7E1', marbleVein: '#BDBDB8', soil: '#7B776E', rubble: '#6E5A4A', concrete: '#A3A29C',
  cmuAged: '#8E8D88', cmuNew: '#A6A5A0', efflorescence: '#E6E4DC',
})
export const BRICK_PAINTS = Object.freeze({ 'red-oxide': '#7A3026', cream: '#D8D2C4', grey: '#8C8A85' })
export const FORMSTONE_PALETTES = Object.freeze({ grey: Object.freeze(['#A9A59B']), tan: Object.freeze(['#B19C7E']), blend: Object.freeze(['#A79F92', '#B5A58C', '#A38E86']) })
export const ROOM_PAINTS = Object.freeze(['#9DB09A', '#C9A39A', '#9AA6B4', '#C8BC8E', '#B7A9C2'])   // faded pastel room colours
export const COMMON_BRICK_VARIANTS = Object.freeze(['base', 'soot', 'spall', 'ghostOpening', 'rust', 'repointed'])
export const FORMSTONE_VARIANTS = Object.freeze(['base', 'toneA', 'toneB', 'soot', 'spall', 'bulge', 'lathSheet', 'rust', 'efflorescence', 'parge'])
export const MARBLE_VARIANTS = Object.freeze(['weathered', 'fresh', 'soiled', 'painted', 'crackA', 'crackB', 'rustRun', 'missingCore'])

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §0 Small helpers (file-local)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// band limiting: detail of cell size `cell` keeps full weight from two footprints up and fades to nothing at one
const bandK = (cell, fx) => (fx > 0 ? sstep(1, 2, cell / fx) : 1)
// the box-filtered inside share of a signed-distance shape (sd > 0 inside) over a footprint f
const covSd = (sd, f) => (f > 0 ? c01(0.5 + sd / f) : sd > 0 ? 1 : 0)
// exact 1-D box filter: the share of a footprint f, centred at signed distance d from a line, covered by the band |d| <= hw
function covLine(d, hw, f) {
  if (!(f > 0)) return Math.abs(d) <= hw ? 1 : 0
  const a = Math.max(d - f / 2, -hw), b = Math.min(d + f / 2, hw)
  return b > a ? (b - a) / f : 0
}
// the tempered colour rule: target × (1 + k·(mat/stock − 1)); k = 1 is the plain rule, k = 0 an absolute accent (rust, soot, salt)
function tcol(ctx, target, k) {
  const t = Array.isArray(target) ? target : hexToRgb(target), f = ctx.col(t)
  return [t[0] + (f[0] - t[0]) * k, t[1] + (f[1] - t[1]) * k, t[2] + (f[2] - t[2]) * k]
}
// the distribution of a field over a fixed n × n grid of the tile (resolution-independent, so thresholds match at every tpm)
// (a generator, §3b: it yields between rows of its grid; fieldRow adds a row's samples to the running sum in the same order as one loop)
function fieldRow(fn, v, j, n, w, h, sum) {
  for (let i = 0; i < n; i++) { const f = fn(((i + 0.5) * w) / n, ((j + 0.5) * h) / n); v[j * n + i] = f; sum += f }
  return sum
}
function* fieldQ(fn, w, h, n = 64) {
  const v = new Float64Array(n * n)
  let sum = 0
  if (due()) yield
  for (let j = 0; j < n; j++) { sum = fieldRow(fn, v, j, n, w, h, sum); if (due()) yield }
  v.sort()
  // rank(f): the share of the samples below f (0..1, linear between neighbours): the field's own CDF, so 1 - rank is a peel ORDER
  const rank = (f) => {
    let lo = 0, hi = n * n
    while (lo < hi) { const m = (lo + hi) >> 1; if (v[m] < f) lo = m + 1; else hi = m }
    if (lo <= 0) return 0
    if (lo >= n * n) return 1
    const a = v[lo - 1], b = v[lo]
    return (lo - 1 + (b > a ? (f - a) / (b - a) : 0.5) + 0.5) / (n * n)
  }
  return { mean: sum / (n * n), q: (p) => v[Math.min(n * n - 1, Math.max(0, Math.floor(p * n * n)))], rank }
}
const mixS = (s, c, t) => { if (t > 0) { s.r += (c[0] - s.r) * t; s.g += (c[1] - s.g) * t; s.b += (c[2] - s.b) * t } }
const mulS = (s, k) => { s.r *= k; s.g *= k; s.b *= k }
const setS = (s, c, k = 1) => { s.r = c[0] * k; s.g = c[1] * k; s.b = c[2] * k }
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const sc3 = (c, k) => [c[0] * k, c[1] * k, c[2] * k]
// the variant fade: 0 within the core's edgeFade margin of the left / right edge, so variants keep their substrate's EDGE columns
const vfade = (x, W) => edgeFade(wrapM(x, W), W)
// signed distance to a rounded rectangle of half sizes (ax, ay) and corner radius r, NEGATIVE inside
function sdRRect(px, py, ax, ay, r) {
  const qx = Math.abs(px) - ax + r, qy = Math.abs(py) - ay + r
  return Math.min(Math.max(qx, qy), 0) + hyp(Math.max(qx, 0), Math.max(qy, 0)) - r
}
// distance from (x, y) to a polyline [x0, y0, x1, y1, ...]
function distPolyline(P, x, y) {
  let d2 = Infinity
  for (let i = 0; i + 3 < P.length; i += 2) {
    const ax = P[i], ay = P[i + 1], ex = P[i + 2] - ax, ey = P[i + 3] - ay, l2 = ex * ex + ey * ey
    const t = l2 > 0 ? c01(((x - ax) * ex + (y - ay) * ey) / l2) : 0
    const dx = ax + ex * t - x, dy = ay + ey * t - y, dd = dx * dx + dy * dy
    if (dd < d2) d2 = dd
  }
  return Math.sqrt(d2)
}
// a wandering crack path from (x0, y0) to (x1, y1): n segments, a random walk across the line of up to `jit` metres
function crackPath(seed, x0, y0, x1, y1, n, jit) {
  const P = [], L = hyp(x1 - x0, y1 - y0) || 1, nx = -(y1 - y0) / L, ny = (x1 - x0) / L
  let off = 0
  for (let i = 0; i <= n; i++) {
    const t = i / n
    if (i > 0 && i < n) off += (hashF(i, 0, seed) - 0.5) * 2 * jit
    const pull = Math.sin(Math.PI * t)                                   // ends fixed: the walk is damped toward both ends
    P.push(x0 + (x1 - x0) * t + nx * off * pull, y0 + (y1 - y0) * t + ny * off * pull)
  }
  return P
}
// a periodic texel-scale grid: about `cell` metres per cell, a whole number of cells across the tile; (x, y) → a cell hash in [0, 1)
function makeCellGrid(W, H, cell, seed) {
  const nx = Math.max(1, Math.round(W / cell)), ny = Math.max(1, Math.round(H / cell))
  const f = (x, y) => hashF(Math.min(nx - 1, Math.floor((wrapM(x, W) / W) * nx)), Math.min(ny - 1, Math.floor((wrapM(y, H) / H) * ny)), seed)
  f.cell = Math.min(W / nx, H / ny)
  return f
}
function checkVariant(who, v, list) { if (!list.includes(v)) throw new Error(`${who}: unknown variant '${v}' (one of ${list.join(', ')})`) }
// a mask on the texel grid, rasterised on the same sample grid as the colour pass, so it box-filters exactly like it → Float32Array(w·h)
function* maskPass(ctx, fn) {
  const D = newRaster(ctx.w_m, ctx.h_m, ctx.tpm, { height: false }), tex = ctx.w_m / D.w
  yield* rasterizeSteps(D, (s) => { s.r = fn(s.x, s.y, s.fx, tex) }, { ss: ctx.ss, origin: ctx.opts.origin, wrap: ctx.opts.wrap })
  return maskOf(D)
}
function maskOf(D) {
  const a = new Float32Array(D.w * D.h)
  for (let i = 0; i < a.length; i++) a[i] = c01(D.rgb[i * 3])
  return a
}
// R.decal: the coverage of a variant's stroke decals (cracks, runs, streaks) (the glyph test for decals reads it). fn(x, y, fx, tex): tex =
// the output texel (metres), so a line decal can be drawn at least a texel wide in its mask (its PRESENCE at that resolution), where the
// colour pass dilutes a sub-texel crack
function* decalPass(ctx, fn) { ctx.R.decal = yield* maskPass(ctx, fn) }
const pick = (list, u) => list[Math.min(list.length - 1, Math.floor(u * list.length))]

// a soft blob mask with an exact share: field = warped fbm, pushed down near the left / right edges; sd(x, y) is the signed distance
// (metres, + inside) to its threshold line, estimated from the field's gradient near the line
function* makeBlobMask(ctx, tag, W, H, share, o = {}) {
  const f = ctx.fbm(tag, { feature: o.feature ?? 0.45, octaves: o.octaves ?? 4 })
  const wp = ctx.warp(tag + ':w', { feature: (o.feature ?? 0.45) * 1.3, octaves: 2, amp: o.warp ?? 0.06 }), Wp = {}
  const bias = o.bias || null, edges = o.edges !== false
  const field = (x, y) => { wp(x, y, Wp); return f(Wp.x, Wp.y) + (bias ? bias(x, y) : 0) - (edges ? 3 * (1 - vfade(x, W)) : 0) }
  const thr = (yield* fieldQ(field, W, H, 96)).q(1 - c01(share))
  const d = 0.006
  const sd = (x, y) => {
    const v = field(x, y) - thr
    if (Math.abs(v) > 0.3) return v > 0 ? 0.25 : -0.25
    const gx = (field(x + d, y) - field(x - d, y)) / (2 * d), gy = (field(x, y + d) - field(x, y - d)) / (2 * d)
    const g = Math.max(1e-3, hyp(gx, gy))
    return Math.max(-0.25, Math.min(0.25, v / g))
  }
  return { sd, field, thr, share }
}

// wall-scale weathering of a vertical surface: slow tonal patches and rain washes (dark dirt streaks and paler washed streaks). The
// streaks are gated by a slow field, so they gather where water runs and leave the rest clean, instead of covering the tile evenly (an
// even cover reads as a barcode once the tile repeats). o.gateY (default 4 m: on a 2 m tile the gate cannot vary down the wall, so a
// gated streak runs the full tile height) and o.seg (default false: true cuts every dark streak into 0.3–1 m runs that start and stop,
// the way grime runs from a sill or a coping and ends; full-height grime is the soot-streak mask's, placed in world space)
function makeWallWeather(ctx, tag, o) {
  const big = ctx.fbm(tag + ':big', { feature: 0.6, octaves: 3 })
  const wash = ctx.fbm(tag + ':wash', { featureX: 0.09, featureY: 0.9, octaves: 3 })
  const gate = ctx.fbm(tag + ':gate', { featureX: 0.45, featureY: o.gateY ?? 4, octaves: 2 })
  const seg = o.seg ? ctx.fbm(tag + ':seg', { featureX: 0.3, featureY: 0.6, octaves: 2 }) : null
  return (x, y, fx) => {
    const w = wash(x, y, fx), g = sstep(-0.02, 0.3, gate(x, y, fx)), sg = seg ? sstep(-0.05, 0.35, seg(x, y, fx)) : 1
    return (1 + o.big * big(x, y, fx)) * (1 - o.dark * g * sg * sstep(0.08, 0.45, w) + o.light * (1 - g) * sstep(0.12, 0.5, -w))
  }
}
// the foot of a wall on the yard: a damp foot (−8% value over 40 cm) and splash-back grime in the bottom 30 cm
function makeFoot(ctx, tag, W, H) {
  const damp = makeDampFoot(ctx.sub(tag + ':damp'), { w: W, h: H, height: 0.40 })
  const spl = ctx.fbm(tag + ':splash', { featureX: 0.05, featureY: 0.12, octaves: 3 })
  const grime = tcol(ctx, [62, 60, 52], 0.3)
  return (s, x, y, fx) => {
    mulS(s, 1 - 0.08 * damp(x, y))
    const z = H - wrapM(y, H)
    if (z < 0.3) { const g = c01((1 - z / 0.3) * (0.5 + 0.7 * spl(x, y, fx))); mixS(s, grime, 0.32 * g * g); s.cav *= 1 - 0.08 * g }
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §1 Brick shading, shared by pressed brick, common brick, painted brick, the brick under formstone and under parge.
//  makeBrickShade(ctx, layout, P, tag) → { L, I, shade(s, H, out, repoint) } fills out = { r, g, b, cav, h, relief, joint } for one
//  sub-sample from the layer hits H: the bare brick colour, its occlusion and height, the geometric RELIEF factor alone (joint recess,
//  eroded arris, pits: what still shows through paint) and the mortar share.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const B7 = new Float64Array(7)
function blend7(H, unit, joint, out) {
  let stored = 0
  for (let k = 0; k < H.n; k++) stored += H.area[k]
  const kU = stored > 0 && stored < H.sum - 1e-12 ? H.sum / stored : 1        // units dropped past MAX_HITS: rescale the kept ones
  let r = 0, g = 0, b = 0, c = 0, h = 0, rl = 0, jt = 0
  for (let k = 0; k < H.n; k++) {
    const a = H.area[k] * kU
    B7[0] = 0; B7[1] = 0; B7[2] = 0; B7[3] = 1; B7[4] = 0; B7[5] = 1; B7[6] = 0
    unit(k, B7)
    r += a * B7[0]; g += a * B7[1]; b += a * B7[2]; c += a * B7[3]; h += a * B7[4]; rl += a * B7[5]; jt += a * B7[6]
  }
  const j = 1 - H.sum
  if (j > 0) {
    B7[0] = 0; B7[1] = 0; B7[2] = 0; B7[3] = 1; B7[4] = 0; B7[5] = 1; B7[6] = 1
    joint(B7)
    r += j * B7[0]; g += j * B7[1]; b += j * B7[2]; c += j * B7[3]; h += j * B7[4]; rl += j * B7[5]; jt += j * B7[6]
  }
  out.r = r; out.g = g; out.b = b; out.cav = c; out.h = h; out.relief = rl; out.joint = jt
}

function commonBrickParams(ctx, o = {}) {
  return {
    colA: ctx.col(MASONRY.commonA), colB: ctx.col(MASONRY.commonB), tone: 0.12, warm: 0.05,
    clinker: 0.025, clinkerCol: ctx.col([112, 62, 52]), salmon: 0.05, salmonCol: ctx.col([200, 134, 102]),
    headerK: 0.93, flash: 0.05, mottle: 0.05,
    // soft 140-year-old brick: arrises eroded 2–8 mm and chipped, only a few sand pits, and those shallow
    erosion: 0.005, chip: 1.0, arrisShade: 0.8, pitKeep: 0.08, pitR: [0.0012, 0.0028], pitDark: 0.12,
    mortar: ctx.col(MASONRY.mortar), recess: COMMON_BRICK.recessShade, jointDepth: COMMON_BRICK.jointDepth, sandK: 0.06, deepK: 0.14,
    repointCol: ctx.col([160, 158, 152]), spalled: null, spallCol: ctx.col([196, 140, 110]),
    ...o,
  }
}

function makeBrickShade(ctx, L, P, tag) {
  const mott = ctx.fbm(tag + ':mott', { feature: 0.035, octaves: 3 })
  const ero = ctx.fbm(tag + ':ero', { feature: 0.02, octaves: 3 })
  const chipN = ctx.fbm(tag + ':chip', { feature: 0.05, octaves: 2 })
  const sand = ctx.noise(tag + ':sand', { feature: 0.004 })
  const deep = ctx.fbm(tag + ':deep', { feature: 0.3, octaves: 3 })
  const rough = ctx.noise(tag + ':rough', { feature: 0.005 })
  const pitV = ctx.voronoi(tag + ':pit', { feature: 0.014, search: 1 })
  const sF = ctx.sub(tag + ':flash'), sP = ctx.sub(tag + ':pit')
  const V = {}, st = { x: 0, y: 0, fx: 0, H: null, rep: 0, mott: 0, e: 0, pc: 0, sand: 0, dp: 0, rough: 0, chipV: 0 }
  const unit = (k, C) => {
    const H = st.H, u = L.units[H.unit[k]], fx = st.fx
    const t1 = u.rnd[1]
    let r = P.colA[0] + (P.colB[0] - P.colA[0]) * t1, g = P.colA[1] + (P.colB[1] - P.colA[1]) * t1, b = P.colA[2] + (P.colB[2] - P.colA[2]) * t1
    const sp = u.rnd[3]
    if (sp < P.clinker) { r = lerp(r, P.clinkerCol[0], 0.65); g = lerp(g, P.clinkerCol[1], 0.65); b = lerp(b, P.clinkerCol[2], 0.65) }
    else if (sp > 1 - P.salmon) { r = lerp(r, P.salmonCol[0], 0.55); g = lerp(g, P.salmonCol[1], 0.55); b = lerp(b, P.salmonCol[2], 0.55) }
    const j = (u.rnd[2] - 0.5) * 2 * P.warm
    r *= 1 + j; b *= 1 - j
    let v = 1 + (u.rnd[0] - 0.5) * 2 * P.tone
    if (u.kind === 'header') v *= P.headerK
    if (P.flash > 0) {                                                  // a firing gradient along the brick (one end nearer the fire)
      const len = u.x1 - u.x0, tl = H.lx[k] / len - 0.5, amp = P.flash * (hashF(u.id, 2, sF) * 2 - 1)
      v *= 1 + 2 * amp * tl
    }
    v *= 1 + P.mottle * st.mott
    // the arris: eroded and rounded (soft brick) or crisp (pressed brick), chipped in places
    const e = st.e
    const face = covSd(H.ed[k] - e, fx)
    let relief = (face + (1 - face) * P.arrisShade) * (1 - P.pitDark * st.pc)
    let cav = 1 - 0.3 * (1 - face) - 0.4 * st.pc, hh = -(1 - face) * Math.min(e, P.jointDepth) - 0.002 * st.pc
    const k2 = v * relief
    r *= k2; g *= k2; b *= k2
    // grey Portland repointing is smeared over the eroded arrises: the joint reads wider, flush and grey
    if (st.rep > 0 && face < 1) {
      const sm = st.rep * (1 - face) * 0.85, rc = P.repointCol
      r = lerp(r, rc[0] * 0.97, sm); g = lerp(g, rc[1] * 0.97, sm); b = lerp(b, rc[2] * 0.97, sm)
      cav = lerp(cav, 0.9, sm); hh = lerp(hh, -0.0008, sm); relief = lerp(relief, 0.97, sm)
    }
    // a spalled face (variant 'spall'): the fired skin gone over most of the face, the paler, rougher body showing, recessed
    const spd = P.spalled ? P.spalled.get(u.id) : null
    if (spd) {
      const len = u.x1 - u.x0, hgt = u.y1 - u.y0
      const qx = (H.lx[k] - spd.cx * len) / (spd.rx * len), qy = (H.ly[k] - spd.cy * hgt) / (spd.ry * hgt)
      const q = Math.sqrt(qx * qx + qy * qy) + 0.3 * st.chipV
      const sdq = (1 - q) * Math.min(spd.rx * len, spd.ry * hgt)
      const sc = covSd(sdq, fx)                                        // the spall breaks through the arris (it is not an inset)
      if (sc > 0) {
        const ao = 1 - 0.6 * (1 - sstep(0, 0.010, sdq)), rk = (0.82 + 0.36 * st.rough) * (1 + 0.1 * st.mott) * spd.tone * ao
        r = lerp(r, P.spallCol[0] * rk, sc); g = lerp(g, P.spallCol[1] * rk, sc); b = lerp(b, P.spallCol[2] * rk, sc)
        relief = lerp(relief, 0.85 * ao, sc); cav -= 0.32 * sc; hh -= 0.012 * sc
      }
    }
    C[0] = r; C[1] = g; C[2] = b; C[3] = cav; C[4] = hh; C[5] = relief; C[6] = 0
  }
  const joint = (C) => {
    const dp = st.dp
    let kk = P.recess * (1 + P.sandK * st.sand) * (1 - P.deepK * dp)
    let r = P.mortar[0], g = P.mortar[1], b = P.mortar[2]
    let cav = 0.62 - 0.22 * dp, h = -P.jointDepth * (0.7 + 0.6 * dp), rel = P.recess * (1 - P.deepK * dp)
    if (st.rep > 0) {                                                   // grey Portland repointing: flush, smeared, cleaner
      const t = st.rep
      r = lerp(r, P.repointCol[0], t); g = lerp(g, P.repointCol[1], t); b = lerp(b, P.repointCol[2], t)
      kk = lerp(kk, 0.97 * (1 + 0.03 * st.sand), t); cav = lerp(cav, 0.9, t); h = lerp(h, -0.0008, t); rel = lerp(rel, 0.97, t)
    }
    C[0] = r * kk; C[1] = g * kk; C[2] = b * kk; C[3] = cav; C[4] = h; C[5] = rel; C[6] = 1
  }
  return {
    L, P, I: indexUnits(L),
    shade(s, H, out, rep = 0) {
      const x = s.x, y = s.y, fx = s.fx
      st.x = x; st.y = y; st.fx = fx; st.H = H; st.rep = rep
      st.mott = mott(x, y, fx)
      const en = 0.5 + 0.5 * ero(x, y, fx)
      st.chipV = chipN(x, y, fx)
      st.e = P.erosion * (0.4 + 1.2 * en) + (P.chip > 0 ? P.chip * 0.02 * sstep(0.62, 0.86, 0.5 + 0.5 * st.chipV) : 0)
      st.pc = 0
      if (P.pitKeep > 0) {
        pitV(x, y, V)
        if (hashF(V.id, 0, sP) < P.pitKeep) st.pc = covSd(lerp(P.pitR[0], P.pitR[1], hashF(V.id, 1, sP)) - V.f1, fx)
      }
      st.sand = (2 * sand(x, y, fx) - 1) * bandK(0.004, fx)
      st.rough = (2 * rough(x, y, fx) - 1) * bandK(0.005, fx)
      st.dp = 0.5 + 0.5 * deep(x, y, fx)
      blend7(H, unit, joint, out)
    },
  }
}

// the grey Portland repointing mask of a common-bond wall L: share 0 → none. Pointing is done by area, a few bricks at a time, so the
// field (fbm 0.18 m, 3 octaves: islands a few bricks across, never one large figure) is read at the centre of the brick cell the sample
// lies in, course by course with each course's own phase and unit length: the boundary steps along the bed and head joints
function* makeRepoint(ctx, L, W, H, share) {
  if (!(share > 0)) return () => 0
  const f = ctx.fbm('repoint', { feature: 0.18, octaves: 3 })
  const c = L.module.course, sl = L.module.stretcher, hdr = COMMON_BRICK.headerEvery
  const at = (x, y, fx) => {
    const ci = Math.floor(wrapM(y, H) / c), par = ci % hdr, isH = par === 0, len = isH ? sl / 2 : sl
    const ph = isH ? 0.25 * sl : par & 1 ? 0.5 * sl : 0
    return f(ph + (Math.floor((x - ph) / len) + 0.5) * len, (ci + 0.5) * c, fx)
  }
  const thr = (yield* fieldQ((x, y) => at(x, y, 0), W, H, 96)).q(1 - share)
  return (x, y, fx) => sstep(thr - 0.03, thr + 0.03, at(x, y, fx))
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §2 paintPressedBrick: smooth face brick, sharp arrises, very thin joints, running bond. The J-east
//  front. White-striped joints on 1 in 4 pressed fronts, via opts.striped.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// the pressed courses (6.25 cm = 8 texels at 128 tpm) are sampled half a 128 tpm texel down, so each thin bed joint falls inside one
// texel row instead of straddling two (pale and smeared against the 1-texel head joints, a vertical hatch at distance)
const PRESSED_DY = 0.5 / 128
export const paintPressedBrick = makeRecipe({ name: 'paintPressedBrick', stock: 'B', periodic: true, *paint(ctx) {
  const W = ctx.w_m, H = ctx.h_m, o = ctx.opts, striped = !!o.striped, grime = c01(o.grime ?? 0.35)
  const L = layoutBrick(W, H, ctx.sub('layout'))
  const P = commonBrickParams(ctx, { colA: ctx.col(MASONRY.pressed), colB: ctx.col(MASONRY.pressed), tone: 0.05, warm: 0.015,
    clinker: 0, salmon: 0, headerK: 1, flash: 0.015, mottle: 0.02, erosion: 0.0005, chip: 0.05, arrisShade: 0.86, pitKeep: 0.02,
    pitR: [0.001, 0.0022], recess: 0.93, jointDepth: L.joint.depth, sandK: 0.04, deepK: 0.05 })
  const BS = makeBrickShade(ctx, L, P, 'pressed')
  const WX = makeWallWeather(ctx, 'wall', { big: 0.025, dark: 0.012 + 0.03 * grime, light: 0.015 })
  const dirtJ = ctx.fbm('dirt-joint', { feature: 0.4, octaves: 3 })
  const stripeC = ctx.col(MASONRY.stripe), wearN = ctx.fbm('stripe-wear', { feature: 0.05, octaves: 3 })
  const wob = ctx.fbm('stripe-wobble', { feature: 0.08, octaves: 2 })
  const FT = o.foot ? makeFoot(ctx, 'foot', W, H) : null
  const out = {}
  yield* ctx.raster((s) => {
    const x = s.x, y = s.y, fx = s.fx, Hh = s.hits[0]
    BS.shade(s, Hh, out)
    let k = WX(x, y, fx)
    // soot and dust in the joints: grime darkens the mortar a little, more in slow patches
    const jd = out.joint * grime * 0.12 * (0.6 + 0.8 * c01(0.5 + dirtJ(x, y, fx)))
    s.r = out.r * k * (1 - jd); s.g = out.g * k * (1 - jd); s.b = out.b * k * (1 - jd); s.cav = out.cav; s.h = out.h
    if (striped) {
      // the painted stripe: a white line down the centre of every joint, a little wider than the joint, wobbling, worn in places
      let d = 0
      for (let i = 0; i < Hh.n; i++) {
        const u = L.units[Hh.unit[i]], px = u.x0 + Hh.lx[i], py = u.y0 + Hh.ly[i], c = u.cell
        if (px >= c[0] && px < c[2] && py >= c[1] && py < c[3]) { d = Math.min(px - c[0], c[2] - px, py - c[1], c[3] - py); break }
      }
      const hw = 0.0029 + 0.0006 * wob(x, y, fx)
      const keep = sstep(-0.32, -0.08, wearN(x, y, fx))
      const st = covLine(d, hw, fx) * keep                                                  // the exact box filter of the stripe
      if (st > 0) { mixS(s, sc3(stripeC, k * (1 - 0.5 * jd)), 0.92 * st); s.h += 0.0002 * st }
    }
    if (FT) FT(s, x, y, fx)
  }, { layers: [BS.I], origin: [o.origin ? o.origin[0] : 0, (o.origin ? o.origin[1] : 0) + PRESSED_DY] })
  return { striped, grime, module: L.module }
} })

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §3 paintCommonBrick: local brick on backs, side walls and back buildings. Common bond, soft and
//  variable, eroded lime joints. Variants: soot, spall, ghostOpening, rust.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// the bricked-up opening: the old wall minus the units inside the opening, the infill toothed into it course by course, the kept arch
function planGhostOpening(ctx, L, W, H, o) {
  const sG = ctx.sub('ghost')
  const course = L.module.course, nc = L.module.courses
  const ow = Math.max(0.4, Math.min(0.91, W - 0.8)), x0d = (W - ow) / 2
  const op = o.opening ? { ...o.opening } : { x0: x0d, x1: x0d + ow, y0: 0.18 * H, y1: 0.9 * H }
  if (!(op.x1 > op.x0 && op.y1 > op.y0)) throw new Error('paintCommonBrick ghostOpening: empty opening')
  const arch = o.arch ?? (hashF(0, 1, sG) < 0.65 ? 'segmental' : 'jack')
  if (!['segmental', 'jack', 'none'].includes(arch)) throw new Error(`paintCommonBrick: unknown arch '${arch}'`)
  const sill = o.sill ?? true
  const c0 = Math.max(2, Math.min(nc - 4, Math.round(op.y0 / course)))
  const c1 = Math.max(c0 + 2, Math.min(nc - (sill ? 2 : 1), Math.round(op.y1 / course)))
  const y0s = c0 * course, y1s = c1 * course, xc = (op.x0 + op.x1) / 2, span = op.x1 - op.x0
  let A = null
  if (arch === 'segmental') {
    const f = o.rise ?? 0.08, R = (span * span / 4 + f * f) / (2 * f), rings = o.rings ?? (hashF(0, 2, sG) < 0.6 ? 2 : 1)
    A = { kind: 'segmental', f, R, xc, yc: y0s - f + R, th: Math.asin(Math.min(1, span / 2 / R)), rings, d: 0.102, jr: 0.010, jv: 0.009 }
    A.Rout = R + rings * A.d + (rings - 1) * A.jr
  } else if (arch === 'jack') {
    const D = o.depth ?? 0.20, skew = o.skew ?? 0.05
    A = { kind: 'jack', D, skew, xc, yP: y0s + (D * span) / (2 * skew), jv: 0.009 }
    A.th = Math.atan2(span / 2, A.yP - y0s)
    A.n = 2 * Math.round((span + skew) / 0.0667 / 2) + 1                                      // an odd count: a keystone at the crown
  }
  // the head joints of every old course, wrapped into [0, W)
  const joints = Array.from({ length: nc }, () => [])
  for (const u of L.units) joints[u.course].push(wrapM(u.cell[0], W))
  const bracket = (c, xa, xb) => {
    let l = -Infinity, r = Infinity
    for (const j of joints[c]) { if (j <= xa && j > l) l = j; if (j >= xb && j < r) r = j }
    return [Number.isFinite(l) ? l : xa, Number.isFinite(r) ? r : xb]
  }
  // toothing: in alternate courses the infill reaches one step further into the old wall
  const bL = new Float64Array(nc).fill(NaN), bR = new Float64Array(nc).fill(NaN)
  for (let c = c0; c < c1; c++) { const push = (c - c0) & 1 ? 0.07 : 0; const [l, r] = bracket(c, op.x0 - push, op.x1 + push); bL[c] = l; bR[c] = r }
  const old = L.units.filter((u) => {
    const c = u.course
    if (c < c0 || c >= c1) return true
    const m = wrapM((u.cell[0] + u.cell[2]) / 2, W)
    return !(m > bL[c] && m < bR[c])
  })
  // the infill: a later, harder brick in stretcher bond, laid in the old courses (toothed in), grey cement joints
  const sI = ctx.sub('infill'), units = [], ln = 0.2134
  const bed = (c) => lerp(0.009, 0.011, hashF(c & 0xFFFF, 0, sI))
  const fill = (c, a, b) => {
    const rel = c - c0, my0 = c * course, my1 = (c + 1) * course, jt = bed(c), jb = bed(c + 1)
    let p = a, first = true, jPrev = 0.010
    while (p < b - 1e-9) {
      let q = first && (rel & 1) ? p + ln / 2 : p + ln
      if (q > b - 0.05) q = b
      const jn = q >= b ? 0.010 : lerp(0.008, 0.012, hashF(c * 64 + units.length, 1, sI))
      const ux0 = p + jPrev / 2, ux1 = q - jn / 2, uy0 = my0 + jt / 2, uy1 = my1 - jb / 2
      if (ux1 - ux0 > 0.01 && uy1 > uy0) {
        const id = units.length
        units.push({ id, kind: 'stretcher', course: c, col: id, x0: ux0, y0: uy0, x1: ux1, y1: uy1, cell: [p, my0, q, my1], cut: q - p < ln - 1e-9, rnd: unitRnd(sI, id) })
      }
      jPrev = jn; p = q; first = false
    }
  }
  for (let c = c0; c < c1; c++) fill(c, bL[c], bR[c])
  const tymp = []
  if (A && A.kind === 'segmental') {                                                         // the part of the opening under the arch
    for (let c = Math.max(0, Math.floor((y0s - A.f) / course)); c < c0; c++) {
      const yb = (c + 1) * course, dy = A.yc - yb, hw = Math.sqrt(Math.max(0, A.R * A.R - dy * dy))
      const [l, r] = bracket(c, xc - hw, xc + hw)
      fill(c, l, r); tymp.push(c)
    }
  }
  const colI = hashF(0, 3, sG) < 0.5 ? ctx.col('#8C4636') : ctx.col('#B56A4C')
  const Pinf = commonBrickParams(ctx, { colA: colI, colB: sc3(colI, 0.95), tone: 0.05, warm: 0.02, clinker: 0, salmon: 0, headerK: 1,
    flash: 0.02, mottle: 0.03, erosion: 0.0012, chip: 0.1, pitKeep: 0.12, mortar: ctx.col('#A3A19A'), recess: 0.95, jointDepth: 0.0015, deepK: 0.04 })
  const zone = (xw, yw) => {
    const c = Math.floor(yw / course)
    if (c >= c0 && c < c1) return xw > bL[c] && xw < bR[c]
    if (A && A.kind === 'segmental' && yw < y0s && yw > y0s - A.f - 0.02) { const dx = xw - A.xc, dy = yw - A.yc; return dx * dx + dy * dy < A.R * A.R }
    return false
  }
  // the arch at (x, y): the coverage of its whole zone (voussoirs and their joints) and of a voussoir, and the voussoir id
  const archAt = (xw, yw, fx, out) => {
    out.region = 0; out.brick = 0; out.id = 0
    if (!A) return out
    let r, th, sdReg, sdV, n, D, i
    if (A.kind === 'segmental') {
      const dx = xw - A.xc, dy = A.yc - yw
      r = hyp(dx, dy); th = Math.atan2(dx, dy)
      const sdSec = (A.th - Math.abs(th)) * r
      sdReg = Math.min(r - A.R, A.Rout + A.jv / 2 - r, sdSec)
      if (sdReg < -fx) return out
      const ring = Math.max(0, Math.min(A.rings - 1, Math.floor((r - A.R) / (A.d + A.jr))))
      const rin = A.R + ring * (A.d + A.jr), rout = rin + A.d
      n = Math.max(3, Math.round(((rin + A.d / 2) * 2 * A.th) / 0.0667)); D = (2 * A.th) / n
      const t = (th + A.th) / D
      i = Math.max(0, Math.min(n - 1, Math.floor(t)))
      const dJ = (D / 2) * r - A.jv / 2 - Math.abs((t - i - 0.5) * D) * r
      sdV = Math.min(r - rin, rout - r, dJ)
      out.id = ring * 997 + i
    } else {
      const dx = xw - A.xc, dy = A.yP - yw
      r = hyp(dx, dy); th = Math.atan2(dx, dy)
      const sdSec = (A.th - Math.abs(th)) * r * Math.cos(A.th)
      const top = y0s - A.D
      sdReg = Math.min(yw - top + A.jv / 2, y0s - yw, sdSec)
      if (sdReg < -fx) return out
      n = A.n; D = (2 * A.th) / n
      const t = (th + A.th) / D
      i = Math.max(0, Math.min(n - 1, Math.floor(t)))
      const dJ = ((D / 2) * r - A.jv / 2 - Math.abs((t - i - 0.5) * D) * r) * Math.cos(th)
      sdV = Math.min(yw - top, y0s - yw, dJ)
      out.id = i
    }
    out.region = covSd(sdReg, fx); out.brick = Math.min(out.region, covSd(sdV, fx))
    return out
  }
  const sillBox = sill ? { x0: op.x0 - 0.05, x1: op.x1 + 0.05, y0: y1s, y1: y1s + 0.068 } : null
  return { old: { ...L, units: old }, infill: { kind: 'brick', bond: 'stretcher', w: W, h: H, periodic: true, units }, Pinf, zone, archAt,
    A, arch, sill: sillBox, opening: { x0: op.x0, x1: op.x1, y0: y0s, y1: y1s }, courses: [c0, c1], tymp, bL, bR, removed: L.units.length - old.length }
}

// pick the few bricks whose face has spalled: interior stretchers, more of them low on the wall
function pickSpalled(L, W, H, seed, n) {
  const cand = L.units.filter((u) => !u.cut && u.kind === 'stretcher' && u.x0 > 0.16 && u.x1 < W - 0.16 && u.y0 > 0.04 && u.y1 < H - 0.04)
  const key = (u) => hashF(u.id, 0, seed) * (1.25 - 0.5 * ((u.y0 + u.y1) / 2 / H))
  cand.sort((a, b) => key(a) - key(b))
  const M = new Map()
  // the spalled area is an ellipse off-centre and larger than the face, so it takes one or two arrises with it
  for (const u of cand.slice(0, n)) M.set(u.id, { cx: lerp(0.3, 0.7, hashF(u.id, 1, seed)), cy: lerp(0.25, 0.75, hashF(u.id, 2, seed)),
    rx: lerp(0.5, 0.85, hashF(u.id, 3, seed)), ry: lerp(0.65, 1.0, hashF(u.id, 4, seed)), tone: lerp(0.9, 1.06, hashF(u.id, 5, seed)) })
  return M
}

export const paintCommonBrick = makeRecipe({ name: 'paintCommonBrick', stock: 'B', periodic: true, *paint(ctx) {
  const W = ctx.w_m, H = ctx.h_m, o = ctx.opts, variant = o.variant ?? 'base'
  checkVariant('paintCommonBrick', variant, COMMON_BRICK_VARIANTS)
  const L = layoutBrick(W, H, ctx.sub('layout'), { bond: 'common' })
  // grey Portland repointing: none on the lime base; a repointed wall ('repointed', a whole-surface state picked per house) keeps its
  // old lime pointing only in islands
  const repShare = c01(o.repoint ?? (variant === 'repointed' ? 0.82 : 0))
  let G = null, spalled = null
  if (variant === 'ghostOpening') G = planGhostOpening(ctx, L, W, H, o)
  if (variant === 'spall') spalled = pickSpalled(L, W, H, ctx.sub('spall'), o.count ?? 3 + Math.floor(hashF(0, 0, ctx.sub('spall-n')) * 4))
  if (due()) yield
  const P = commonBrickParams(ctx, { spalled })
  const BS = makeBrickShade(ctx, G ? G.old : L, P, 'brick')
  if (due()) yield
  const IS = G ? makeBrickShade(ctx, G.infill, G.Pinf, 'infill') : null
  const WX = makeWallWeather(ctx, 'wall', { big: 0.04, dark: 0.06, light: 0.03 })
  const RP = (yield* makeRepoint(ctx, L, W, H, repShare))
  const FT = o.foot ? makeFoot(ctx, 'foot', W, H) : null
  const VAR = variant === 'soot' ? sootDecal(ctx, W, H, 1) : variant === 'rust' ? rustFixings(ctx, W, H, o) : null
  const GO = G ? ghostOverlay(ctx, G, P, W, H) : null
  const out = {}, layers = IS ? [BS.I, IS.I] : [BS.I]
  yield* ctx.raster((s) => {
    const x = s.x, y = s.y, fx = s.fx, xw = wrapM(x, W), yw = wrapM(y, H)
    const inf = G ? G.zone(xw, yw) : false
    if (inf) IS.shade(s, s.hits[1], out, 0)
    else BS.shade(s, s.hits[0], out, RP(x, y, fx))
    const k = inf ? 1 + 0.5 * (WX(x, y, fx) - 1) : WX(x, y, fx)                // the infill is younger: half the weathering
    s.r = out.r * k; s.g = out.g * k; s.b = out.b * k; s.cav = out.cav; s.h = out.h
    if (GO) GO(s, x, y, xw, yw, fx)
    if (VAR) VAR(s, x, y, xw, yw, fx, out)
    if (FT) FT(s, x, y, fx)
  }, { layers })
  if (VAR && VAR.decal) yield* decalPass(ctx, VAR.decal)
  if (repShare > 0) ctx.R.repoint = (yield* maskPass(ctx, RP))
  const meta = { variant, repoint: repShare, module: L.module }
  if (G) Object.assign(meta, { arch: G.arch, opening: G.opening, sill: G.sill, removed: G.removed, infillUnits: G.infill.units.length })
  if (spalled) meta.spalled = [...spalled.keys()]
  return meta
} })

// the kept arch, the old sill and the stains under it, painted over the old wall / infill
function ghostOverlay(ctx, G, P, W, H) {
  const AO = {}, sA = ctx.sub('arch')
  const mortar = sc3(P.mortar, P.recess), mott = ctx.fbm('arch:mott', { feature: 0.035, octaves: 3 })
  const stone = ctx.col([150, 145, 134]), dirt = tcol(ctx, [70, 66, 58], 0.3), sillSoil = ctx.fbm('sill-soil', { featureX: 0.06, featureY: 0.03, octaves: 3 })
  const sillN = ctx.fbm('sill', { feature: 0.08, octaves: 3 }), drip = ctx.fbm('drip', { featureX: 0.035, featureY: 0.5, octaves: 3 })
  const dripLen = ctx.fbm('drip-len', { featureX: 0.12, featureY: 1, octaves: 2 })
  const S = G.sill
  return (s, x, y, xw, yw, fx) => {
    if (G.A) {
      G.archAt(xw, yw, fx, AO)
      if (AO.region > 0) {
        const id = AO.id, t1 = hashF(id, 1, sA)
        const c = lerp3(P.colA, P.colB, t1), v = (1 + (hashF(id, 0, sA) - 0.5) * 2 * P.tone) * (1 + P.mottle * mott(x, y, fx)) * (hashF(id, 3, sA) < 0.08 ? 0.82 : 1)
        const br = AO.brick, mo = AO.region - br
        s.r = s.r * (1 - AO.region) + mortar[0] * mo + c[0] * v * br
        s.g = s.g * (1 - AO.region) + mortar[1] * mo + c[1] * v * br
        s.b = s.b * (1 - AO.region) + mortar[2] * mo + c[2] * v * br
        s.cav = s.cav * (1 - AO.region) + 0.6 * mo + 0.97 * br; s.h = s.h * (1 - AO.region) - 0.004 * mo
      }
    }
    if (S) {
      const sd = Math.min(xw - S.x0, S.x1 - xw, yw - S.y0, S.y1 - yw)
      if (sd > -fx) {
        const cov = covSd(sd, fx)
        const low = sstep(S.y1 - 0.035, S.y1, yw), k = (1 + 0.06 * sillN(x, y, fx)) * (1 - 0.18 * low)
        const sl = c01(0.4 * low + 0.35 * sstep(-0.1, 0.4, sillSoil(x, y, fx)) + 0.12)
        s.r = lerp(s.r, lerp(stone[0], dirt[0], sl) * k, cov); s.g = lerp(s.g, lerp(stone[1], dirt[1], sl) * k, cov); s.b = lerp(s.b, lerp(stone[2], dirt[2], sl) * k, cov)
        s.cav = lerp(s.cav, 1, cov); s.h = lerp(s.h, 0.03, cov)
      }
      // under the sill: its shadow line, then dirt washed down off it in streaks (weathering where the water goes)
      if (xw > S.x0 - 0.02 && xw < S.x1 + 0.02 && yw > S.y1) {
        const z = yw - S.y1, side = sstep(S.x0 - 0.02, S.x0 + 0.04, xw) * (1 - sstep(S.x1 - 0.04, S.x1 + 0.02, xw))
        const ao = (1 - sstep(0, 0.022, z)) * side
        const L = 0.25 + 0.45 * c01(0.5 + dripLen(x, y, fx)), m = c01(1 - z / L) * sstep(-0.05, 0.35, drip(x, y, fx)) * side
        mulS(s, (1 - 0.3 * ao) * (1 - 0.16 * m)); mixS(s, dirt, 0.18 * m); s.cav *= 1 - 0.3 * ao
      }
    }
  }
}

// soot: rain-washed streaks hanging plumb from the top, widening and feathering as they go down, a deposit high on the wall, darker
// joints (strength 0..1). f.decal = the streaks alone (the broad deposit is a soft gradient, not a stroke)
function sootDecal(ctx, W, H, strength) {
  const sS = ctx.sub('soot')
  const st = makeSootStreaks(sS, { w: W, h: H, count: 6 + Math.floor(hashF(0, 0, sS) * 3), lenMin: 0.35 * H, lenMax: 0.95 * H, widthMin: 0.08, widthMax: 0.24,
    strength: 0.6, amp: [0.001, 0.004], spread: 0.8, edge: 'linear' })
  const blot = ctx.fbm('soot-blot', { feature: 0.3, octaves: 3 })
  const soot = tcol(ctx, [40, 36, 34], 0.25)
  const f = (s, x, y, xw, yw, fx, out) => {
    const fd = vfade(x, W) * strength
    if (fd <= 0) return
    const top = Math.pow(1 - yw / H, 1.8) * (0.55 + 0.45 * c01(0.5 + blot(x, y, fx)))
    const m = c01(0.75 * st(x, y) + 0.32 * top) * fd
    mixS(s, soot, 0.62 * m)
    if (out && out.joint > 0) mulS(s, 1 - 0.25 * out.joint * m)
    s.cav *= 1 - 0.1 * m
  }
  f.decal = (x, y) => c01(0.75 * st(x, y)) * vfade(x, W) * strength
  return f
}

// rust: one or two iron fixings (a gutter hanger / pipe strap) high on the wall and the rust run under each
function rustFixings(ctx, W, H, o) {
  const sR = ctx.sub('rust')
  const n = o.fixings ?? 1 + (hashF(0, 0, sR) < 0.5 ? 1 : 0)
  const fx0 = lerp(0.42, W - 0.42, hashF(0, 1, sR)), fy0 = lerp(0.1, 0.32, hashF(0, 2, sR)) * H
  const fixes = [{ x: fx0, y: fy0 }]
  if (n > 1) fixes.push({ x: fx0 + (hashF(0, 3, sR) - 0.5) * 0.02, y: fy0 + lerp(0.45, 0.7, hashF(0, 4, sR)) })
  const runs = makeRustRuns(ctx.sub('rust-runs'), { w: W, h: H, sources: fixes.map((p) => [p.x, p.y + 0.008]), lenMin: 0.5, lenMax: 1.2, width: 0.07, strength: 1 })
  const wide = makeRustRuns(ctx.sub('rust-wide'), { w: W, h: H, sources: fixes.map((p) => [p.x, p.y + 0.02]), lenMin: 0.35, lenMax: 0.8, width: 0.16, strength: 0.6 })
  const halo = ctx.fbm('rust-halo', { feature: 0.04, octaves: 3 }), streak = ctx.fbm('rust-streak', { featureX: 0.02, featureY: 0.3, octaves: 2 })
  // on red brick a rust run reads by being darker and browner, and bright orange where it crosses the pale joints
  const rust = tcol(ctx, [118, 60, 30], 0.3), rustJ = tcol(ctx, [166, 96, 50], 0.3), rustD = tcol(ctx, [74, 44, 30], 0.3), iron = tcol(ctx, [54, 44, 40], 0.3)
  const fn = (s, x, y, xw, yw, fx, out) => {
    const f = vfade(x, W)
    if (f <= 0) return
    const wd = wide(x, y), m = c01(runs(x, y) * (0.75 + 0.5 * c01(0.5 + streak(x, y, fx))) + 0.5 * wd)
    if (wd > 0) mixS(s, rustJ, 0.38 * c01(1.6 * wd) * f)                                    // the broad orange-brown wash
    if (m > 0) {
      const j = out ? out.joint : 0
      mixS(s, rust, 0.72 * m * f * (1 - j)); mixS(s, rustJ, 0.9 * m * f * j); mulS(s, 1 - 0.12 * m * f)
    }
    for (const p of fixes) {
      const dx = wrapD(x - p.x, W), dy = y - p.y
      const d = hyp(dx, dy)
      if (d < 0.08) mixS(s, rustD, 0.45 * f * c01(1 - d / (0.05 + 0.02 * halo(x, y, fx))))
      // the fixing: a bent strap end 3 × 1.4 cm with a nail head, dark iron with rust
      const sd = Math.min(0.015 - Math.abs(dx), 0.007 - Math.abs(dy))
      if (sd > -fx) {
        const cov = covSd(sd, fx) * f
        mixS(s, iron, cov); s.cav = lerp(s.cav, 0.9, cov); s.h = lerp(s.h, 0.006, cov)
        const nail = covSd(0.0035 - d, fx) * f
        mixS(s, rustD, 0.8 * nail)
      }
      if (dy > 0.007 && dy < 0.02 && Math.abs(dx) < 0.016) s.cav *= 1 - 0.25 * f * (1 - sstep(0.007, 0.02, dy))
    }
  }
  fn.decal = (x, y, fx) => c01(runs(x, y) * (0.75 + 0.5 * c01(0.5 + streak(x, y, fx))) + 0.5 * wide(x, y)) * vfade(x, W)
  return fn
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §4 paintPaintedBrick: owners painted the porous brick. The paint fills the joints (relief ×0.4) and
//  peels in sheets, back to an older coat and to the brick, which keeps paint in its joints and pits.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const PAINT_NAMES = Object.keys(BRICK_PAINTS)
// an older coat only of a compatible value (never red-oxide under cream: it read as blood smeared on the wall)
const UNDER_OK = Object.freeze({ cream: Object.freeze(['grey']), grey: Object.freeze(['cream']), 'red-oxide': Object.freeze(['grey']) })
// opts.layer (a peel ORDER, for a renderer that blends two layers): 'film' = the paint film everywhere (no peel) with A = the peel order (0..1: the
// sheet that lets go first is lowest; a share p of the tile is where order < p), 'bare' = the whole film gone (the brick with paint left
// in its joints; A = its cavity). Such a renderer picks between the two per pixel by order < the wall's local share, so every edge
// is a sheet edge (never a cross-fade of two tiles)
export const paintPaintedBrick = makeRecipe({ name: 'paintPaintedBrick', stock: 'B', periodic: true, *paint(ctx) {
  const W = ctx.w_m, H = ctx.h_m, o = ctx.opts, sP = ctx.sub('paint')
  const layer = o.layer ?? null
  if (layer !== null && layer !== 'film' && layer !== 'bare') throw new Error(`paintPaintedBrick: bad layer ${layer}`)
  const paintKey = o.paint ?? pick(PAINT_NAMES, hashF(0, 0, sP))
  const paintHex = BRICK_PAINTS[paintKey] ?? paintKey
  if (!hexToRgb(paintHex)) throw new Error(`paintPaintedBrick: bad paint ${paintKey}`)
  const others = (UNDER_OK[paintKey] ?? PAINT_NAMES).filter((k) => BRICK_PAINTS[k] !== paintHex)
  const underKey = layer !== null ? null : o.under !== undefined ? o.under : hashF(0, 1, sP) < 0.45 && others.length ? pick(others, hashF(0, 2, sP)) : null
  const underHex = underKey == null ? null : BRICK_PAINTS[underKey] ?? underKey
  const peel = layer === 'film' ? 0 : layer === 'bare' ? 1 : c01(o.peel ?? 0.12)
  const L = layoutBrick(W, H, ctx.sub('layout'), { bond: 'common' })
  if (due()) yield
  const BS = makeBrickShade(ctx, L, commonBrickParams(ctx), 'brick')
  if (due()) yield
  const WX = makeWallWeather(ctx, 'wall', { big: 0.04, dark: 0.06, light: 0.03 })
  // vacant backs are never clean: grime runs from a sill or a coping for 0.3–1 m and stops (gated down the wall too, cut into runs)
  const PW = makeWallWeather(ctx, 'paint-wall', { big: 0.025, dark: 0.09, light: 0.035, gateY: 0.7, seg: true })
  const top = ctx.col(paintHex), under = underHex ? ctx.col(underHex) : null
  const roll = ctx.fbm('roller', { featureX: 0.25, featureY: 0.06, octaves: 3 }), chalk = ctx.fbm('chalk', { feature: 0.3, octaves: 3 })
  // the film lets go in large connected sheets (0.6-1 m), their edges a fringe of 2-6 cm flakes, never an even dalmatian
  // of small blobs (a renderer may vary the share across a wall, blending a low-peel and a high-peel tile by a world mask)
  const pf = ctx.fbm('peel', { feature: 0.80, octaves: 5 }), pw = ctx.warp('peel-warp', { feature: 0.9, octaves: 2, amp: 0.08 })
  const fringe = ctx.fbm('peel-fringe', { feature: 0.035, octaves: 2 })
  // the wash is isotropic (a vertical one dripped like blood; vertical runs belong to the grime, not to the peel)
  const wash = ctx.fbm('peel-wash', { feature: 0.12, octaves: 2 }), ub = ctx.fbm('under-break', { feature: 0.05, octaves: 3 })
  const Wp = {}
  const field = (x, y) => { pw(x, y, Wp); return pf(Wp.x, Wp.y) + 0.14 * wash(x, y) + 0.10 * fringe(x, y) }
  // the older coat holds on in broken bits (0–4 cm) of the peeled area, not in a ring of constant width round every peel
  const fieldU = (x, y) => field(x, y) + 0.35 * ub(x, y)
  const Q = (yield* fieldQ(field, W, H, layer === 'film' ? 160 : 96))
  const thr1 = layer === 'bare' ? -Infinity : peel > 0 ? Q.q(1 - peel) : Infinity
  const thr2 = peel > 0 && under ? (yield* fieldQ(fieldU, W, H, 96)).q(1 - peel * 0.8) : thr1
  const sdOf = (fn, x, y, v0, thr) => {
    const v = thr - v0
    if (!Number.isFinite(v)) return 1
    if (Math.abs(v) > 0.25) return v > 0 ? 0.2 : -0.2
    const d = 0.005, gx = (fn(x + d, y) - fn(x - d, y)) / (2 * d), gy = (fn(x, y + d) - fn(x, y - d)) / (2 * d)
    return Math.max(-0.2, Math.min(0.2, v / Math.max(1e-3, hyp(gx, gy))))
  }
  // chalking: the film fades toward a pale grey of its own value, more on the walls that have peeled most
  const chalkC = [lum(top) + 30, lum(top) + 30, lum(top) + 30], chalkK = 0.04 + 0.14 * c01(peel / 0.3)
  const FT = o.foot ? makeFoot(ctx, 'foot', W, H) : null
  const out = {}
  yield* ctx.raster((s) => {
    const x = s.x, y = s.y, fx = s.fx
    BS.shade(s, s.hits[0], out)
    const kb = WX(x, y, fx)
    // the brick under old paint is stained and dull: desaturated toward its own grey
    const bl = (out.r * 0.299 + out.g * 0.587 + out.b * 0.114) * kb
    const br = lerp(bl, out.r * kb, 0.78), bg = lerp(bl, out.g * kb, 0.78), bb = lerp(bl, out.b * kb, 0.78)
    // the paint film: its colour over the brick's relief at 0.4 contrast, roller texture, chalking and rain washes
    const relief = 1 - 0.4 * (1 - out.relief)
    const kp = relief * (1 + 0.02 * roll(x, y, fx)) * PW(x, y, fx)
    const ch = chalkK * (0.6 + 0.8 * c01(0.5 + chalk(x, y, fx)))
    const v0 = peel > 0 || layer === 'film' ? field(x, y) : -Infinity
    const sdTop = layer === 'film' ? 1 : layer === 'bare' ? -1 : peel > 0 ? sdOf(field, x, y, v0, thr1) : 1
    const sdUnder = under ? sdOf(fieldU, x, y, fieldU(x, y), thr2) : sdTop
    const cTop = covSd(sdTop, fx), cUnd = Math.max(cTop, covSd(sdUnder, fx))
    // bare brick: paint left in the joints and pits, only a faint haze of the top coat on the faces (desaturated
    // common brick, about #9A6A55 in situ, with paint in the joints, like the grey house; never an under-coat over the whole face)
    const res = top, rk = c01(0.62 * out.joint + 0.12 + 0.25 * (1 - out.relief))
    const er = lerp(br, res[0] * kp, rk), eg = lerp(bg, res[1] * kp, rk), eb = lerp(bb, res[2] * kp, rk)
    const pr = lerp(top[0], chalkC[0], ch) * kp, pg = lerp(top[1], chalkC[1], ch) * kp, pb = lerp(top[2], chalkC[2], ch) * kp
    let r = er * (1 - cUnd), g = eg * (1 - cUnd), b = eb * (1 - cUnd)
    if (under) { const t = cUnd - cTop; r += under[0] * kp * t; g += under[1] * kp * t; b += under[2] * kp * t }
    r += pr * cTop; g += pg * cTop; b += pb * cTop
    s.r = r; s.g = g; s.b = b
    s.cav = lerp(out.cav, 1 - 0.4 * (1 - out.cav), cUnd); s.h = lerp(out.h, 0.4 * out.h + 0.0003, cUnd)
    if (peel > 0 && layer === null) {
      // the film's torn edge: a pale lip on the paint side and a thin shadow where it lifts off the brick
      const lip = covLine(sdTop - 0.0016, 0.0014, fx), shadow = covLine(sdTop + 0.0022, 0.0016, fx)
      if (lip > 0) mulS(s, 1 + 0.08 * lip)
      if (shadow > 0) { mulS(s, 1 - 0.16 * shadow); s.cav *= 1 - 0.25 * shadow }
    }
    if (FT) FT(s, x, y, fx)
    // the film tile carries the peel ORDER in its A (the bare tile's cavity stands in for its own: paint fills joints at x0.4)
    if (layer === 'film') s.cav = 1 - Q.rank(v0)
  }, { layers: [BS.I] })
  return { paint: paintKey, under: underKey, peel, layer }
} })

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §5 paintFormstone: a cement veneer on nailed metal lath, sculpted into fake stones with shallow
//  scored joints and sprayed mica. Variants for its failure modes: spall to brick with the lath edge, a bulge, a hanging sheet,
//  rust from the lath, efflorescence, a grey parge repair; and re-toned patches with damp stains.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const MICA_CELL = 1 / 128                                                 // the mica grid: one flake cell per 128 tpm texel
// the formstone layout the painter asks the core for: soft rounded corners, course lines that wander, few split slots and no stacked
// pairs (a split slot's lower stone gets its own head joint), so the courses never stripe the wall like a cartoon stone wall
// shallow-scored joints 1.0-1.5 cm (not the 1.5-2.5 cm of a cartoon coursed wall) and more slanted head joints, so the
// stones read as irregular polygons
export const FS_LAYOUT = Object.freeze({ rMin: 0.020, rMax: 0.045, wobble: 0.022, lineStep: 0.16, wobbleShare: 0.18, split: 0.08,
  splitHead: Object.freeze([0.35, 0.65]), jMin: 0.010, jMax: 0.015, slant: 0.06 })

function makeStoneShade(ctx, palette) {
  const lump = ctx.fbm('fs:lump', { feature: 0.045, octaves: 3 })
  const dimV = ctx.voronoi('fs:dimple', { feature: 0.024, search: 1 })
  const grain = ctx.noise('fs:grain', { feature: 0.004 })
  const deep = ctx.fbm('fs:deep', { feature: 0.25, octaves: 2 })
  const blendN = palette.length > 1 ? ctx.fbm('fs:blend', { feature: 0.06, octaves: 3 }) : null
  const sD = ctx.sub('fs:dimple'), sM = ctx.sub('fs:mica'), sT = ctx.sub('fs:tone')
  const micaShare = ctx.opts.mica === false ? 0 : lerp(0.003, 0.006, hashF(0, 0, sM)), mica = makeCellGrid(ctx.w_m, ctx.h_m, MICA_CELL, sM)
  // a blend mixes its colours WITHIN each stone: each stone leans toward one palette colour (0.45 of the way from the palette mean) and
  // carries a second one in clouds, so neighbours differ only a little (never a patchwork of pink, lilac and yellow blocks)
  // every palette 5% toward its own grey (a slightly grey cement veneer), the joints 38% of the way to the stone colour
  // (their contrast cut by 35-40%: shallow scoring, not dark outlines)
  const raw = palette.map((h) => { const c0 = ctx.col(h), l0 = lum(c0); return lerp3(c0, [l0, l0, l0], 0.05) })
  const mean = [0, 1, 2].map((c) => raw.reduce((a, v) => a + v[c], 0) / raw.length)
  const cols = raw.length === 1 ? raw : raw.map((c) => lerp3(mean, c, 0.45)), jointC = lerp3(ctx.col(MASONRY.formJoint), mean, 0.38)
  const meanLum = lum(mean)
  const V = {}, LA = 0.006, dY = 0.004
  const hOf = (x, y, fx) => LA * Math.max(-1, Math.min(1, 2.2 * lump(x, y, fx)))
  return {
    micaShare, cols, jointC,
    // the unit-independent fields at (x, y): lump height and its sky term, dimples, grain, mica
    fields(x, y, fx, F) {
      const h = hOf(x, y, fx)
      const slope = (hOf(x, y + dY, fx) - hOf(x, y - dY, fx)) / (2 * dY)              // + = the surface tilts up (y runs down)
      dimV(x, y, V)
      let dim = 0
      if (hashF(V.id, 0, sD) < 0.55) { const r = lerp(0.004, 0.008, hashF(V.id, 1, sD)); dim = c01(1 - V.f1 / r) }
      dim *= bandK(0.006, fx)
      const gr = (2 * grain(x, y, fx) - 1) * bandK(0.004, fx)
      const mc = mica(x, y) < micaShare ? 1 : 0
      F.k = (1 + 9 * h) * (1 + 0.30 * Math.max(-0.3, Math.min(0.3, slope))) * (1 - 0.08 * dim * dim) * (1 + 0.03 * gr)
      F.mica = 0.08 * lerp(micaShare, mc, bandK(2 * mica.cell, fx))
      F.cav = 1 - 0.22 * dim * dim
      F.h = h - 0.0015 * dim * dim
      F.gr = gr; F.dp = 0.5 + 0.5 * deep(x, y, fx)
      F.bl = blendN ? 0.5 * sstep(-0.2, 0.4, blendN(x, y, fx)) : 0
      return F
    },
    // one stone (unit u) at signed distance ed from its outline, (lx, ly) in its own frame → C = [r, g, b, cav, h]
    stone(u, ed, lx, ly, F, C, retone) {
      let c = cols[0], cs = cols[0]
      if (cols.length > 1) {
        const i = Math.min(cols.length - 1, Math.floor(u.rnd[1] * cols.length)), j = (i + 1 + Math.floor(u.rnd[3] * (cols.length - 1))) % cols.length
        cs = cols[i]
        c = F.bl > 0 ? lerp3(cols[i], cols[j], F.bl) : cols[i]
      }
      // one cement coat, not a wall of two rock types: a small value spread, a very small warm / cool jitter (a little more in a blend),
      // and the stone's base luminance (its lean colour, jitter and value) held within ±5% of the palette mean, so no stone is a landmark
      let v = 1 + (u.rnd[0] - 0.5) * 0.08
      const w = (u.rnd[2] - 0.5) * (cols.length > 1 ? 0.035 : 0.015)
      const lb = ((cs[0] * (1 + w) * 0.299 + cs[1] * 0.587 + cs[2] * (1 - w) * 0.114) * v) / meanLum
      if (lb > 1.05) v *= 1.05 / lb
      else if (lb < 0.95) v *= 0.95 / lb
      const sw = u.x1 - u.x0, sh = u.y1 - u.y0
      v *= 1 + 0.045 * ((hashF(u.id, 1, sT) - 0.5) * (lx / sw - 0.5) + (hashF(u.id, 2, sT) - 0.5) * (ly / sh - 0.5)) * 2
      // the stone's edge turns down softly into the joint (a hand-formed edge, not an outlined bevel)
      const rad = Math.max(0.008, u.radius), e = 1 - sstep(0, rad, ed), e2 = e * e
      const vs = Math.max(-1, Math.min(1, (ly / sh) * 2 - 1))                      // −1 at the stone's top edge, +1 at its foot
      // the pillowed lump of a hand-formed stone under an overcast sky (the renderers are unlit, so it is painted in): its up-lit top about +8%,
      // its lower edge about -10%
      const pillow = vs < 0 ? 0.08 * sstep(0.55, 1, -vs) : -0.10 * sstep(0.55, 1, vs)
      const k = v * F.k * (1 - 0.10 * e2) * (1 - 0.08 * e * vs) * (1 + pillow) * (1 + F.mica * (1 - e))
      let r = c[0] * (1 + w) * k, g = c[1] * k, b = c[2] * (1 - w) * k
      if (retone) { r *= retone[0]; g *= retone[1]; b *= retone[2] }
      C[0] = r; C[1] = g; C[2] = b; C[3] = (1 - 0.2 * e2) * F.cav; C[4] = F.h - u.jointDepth * e2
    },
    joint(F, C) {
      const k = (1 + 0.05 * F.gr) * (1 - 0.06 * F.dp)
      C[0] = jointC[0] * k; C[1] = jointC[1] * k; C[2] = jointC[2] * k; C[3] = 0.70; C[4] = -0.0045
    },
  }
}

// expanded-metal lath: a diamond mesh of 3 mm strands, diamonds about 3.2 × 1.4 cm (periodic over the tile) → strand coverage 0..1
function makeLath(W, H) {
  const px = W / Math.max(1, Math.round(W / 0.032)), py = H / Math.max(1, Math.round(H / 0.014)), nrm = 1 / Math.sqrt(1 / (px * px) + 1 / (py * py))
  return (x, y, fx) => {
    const u = x / px + y / py, v = x / px - y / py
    const du = Math.abs(u - Math.round(u)) * nrm, dv = Math.abs(v - Math.round(v)) * nrm
    return Math.max(covLine(du, 0.0015, fx), covLine(dv, 0.0015, fx))
  }
}

// the rounded border band of opts.edgeRound: per side its width, plus border-stone joints along it
function edgeBands(spec, W, H, seed) {
  if (!spec) return null
  const D = 0.07, sides = { left: 0, right: 0, top: 0, bottom: 0 }
  const put = (k, v) => { if (!(k in sides)) throw new Error(`paintFormstone: edgeRound side '${k}'`); sides[k] = v === true ? D : v > 0 ? v : 0 }
  if (spec === true) for (const k in sides) sides[k] = D
  else if (typeof spec === 'string') put(spec, true)
  else if (Array.isArray(spec)) for (const k of spec) put(k, true)
  else for (const k of Object.keys(spec)) put(k, spec[k])
  const segs = {}
  for (const k of Object.keys(sides)) {
    if (!sides[k]) continue
    const len = k === 'left' || k === 'right' ? H : W, cuts = [0]
    let p = 0, i = 0
    while (p < len) { p += lerp(0.26, 0.46, hashF(i++, k.length, seed)); cuts.push(Math.min(p, len)) }
    segs[k] = cuts
  }
  return { sides, segs }
}

export const paintFormstone = makeRecipe({ name: 'paintFormstone', stock: 'F', periodic: true, *paint(ctx) {
  const W = ctx.w_m, H = ctx.h_m, o = ctx.opts, variant = o.variant ?? 'base'
  checkVariant('paintFormstone', variant, FORMSTONE_VARIANTS)
  const palette = o.palette ?? pick(['grey', 'tan', 'blend'], hashF(0, 0, ctx.sub('palette')))
  if (!FORMSTONE_PALETTES[palette]) throw new Error(`paintFormstone: unknown palette '${palette}'`)
  const L = layoutFormstone(W, H, ctx.sub('layout'), FS_LAYOUT)
  if (due()) yield
  const I = indexUnits(L)
  if (due()) yield
  const SS = makeStoneShade(ctx, FORMSTONE_PALETTES[palette])
  if (due()) yield
  const WX = makeWallWeather(ctx, 'fs:wall', { big: 0.03, dark: 0.10, light: 0.02 })
  // seventy years of city air: a grey cement-and-grime film over the warm palettes (so tan never reads as yellow sandstone)
  const film = palette === 'grey' ? 0 : palette === 'tan' ? 0.14 : 0.10, filmC = ctx.col([138, 134, 126])
  const ER = edgeBands(o.edgeRound, W, H, ctx.sub('fs:edge'))
  const FT = o.foot ? makeFoot(ctx, 'foot', W, H) : null
  const needBrick = variant === 'spall' || variant === 'lathSheet'
  const BR = needBrick ? makeBrickShade(ctx, layoutBrick(W, H, ctx.sub('fs:brick'), { bond: 'common' }), commonBrickParams(ctx), 'fs:brick') : null
  if (due()) yield
  const layers = BR ? [I, BR.I] : [I]
  const F = {}, F2 = {}, C = new Float64Array(5), out = {}
  const st = { H: null, retone: null, fade: 1, xw: 0 }
  // per-stone re-tone zone (toneA / toneB): whole stones, decided at their centres
  let zoneOf = null, retoneK = null
  if (variant === 'toneA' || variant === 'toneB') {
    const zf = ctx.fbm(variant + ':zone', { feature: 0.6, octaves: 3 })
    const thr = (yield* fieldQ((x, y) => zf(x, y), W, H)).q(0.5)
    zoneOf = new Float64Array(L.units.length)
    for (const u of L.units) zoneOf[u.id] = zf(wrapM((u.x0 + u.x1) / 2, W), wrapM((u.y0 + u.y1) / 2, H)) > thr ? 1 : 0
    // a later coat of the same cement: a touch lighter and warmer (toneA) or a touch darker and greyer (toneB), never a yellow repair
    retoneK = variant === 'toneA' ? [1.025, 1.02, 1.0] : [0.955, 0.955, 0.96]
  }
  const RT = [1, 1, 1]
  const unit = (k, Cc) => {
    const H0 = st.H, u = L.units[H0.unit[k]]
    let rt = null
    if (zoneOf && zoneOf[u.id] > 0 && st.fade > 0) {
      const f = st.fade
      RT[0] = 1 + (retoneK[0] - 1) * f; RT[1] = 1 + (retoneK[1] - 1) * f; RT[2] = 1 + (retoneK[2] - 1) * f
      rt = RT
    }
    SS.stone(u, H0.ed[k], H0.lx[k], H0.ly[k], F, Cc, rt)
  }
  const joint = (Cc) => SS.joint(F, Cc)
  // opts.snap: the stones on whole texels (formstoneSnap, the game's texel look); it reads the layout before the stones are shaded
  if (due()) yield
  const SN = o.snap ? yield* formstoneSnap(ctx, L, I) : null
  const V = (yield* makeFormstoneVariant(ctx, variant, W, H, o, L, SS, BR))
  yield* ctx.raster((s) => {
    const x = s.x, y = s.y, fx = s.fx, xw = wrapM(x, W), yw = wrapM(y, H)
    st.H = s.hits[0]; st.fade = zoneOf ? vfade(x, W) : 1; st.xw = xw
    SS.fields(x, y, fx, F)
    if (SN) SN.shade(s, st.H, unit)
    else blendHits(s, st.H, unit, joint)
    if (ER) edgeRoundAt(s, ER, SS, F, C, xw, yw, fx, W, H)
    mulS(s, WX(x, y, fx))
    if (film > 0) mixS(s, filmC, film)
    if (V) V(s, x, y, xw, yw, fx, out, F2)
    if (FT) FT(s, x, y, fx)
  }, { layers })
  if (V && V.decal) yield* decalPass(ctx, V.decal)
  return { variant, palette, micaShare: SS.micaShare, stones: L.units.length, ...(V && V.meta ? V.meta : {}), ...(SN ? { snap: SN.meta } : {}) }
} })

// opts.snap of paintFormstone (the game's texel look): at 32 texels a metre the 1.0–1.5 cm joints are under half a
// texel, so area sampling turned the wall into flat, light, near-regular courses (ashlar or CMU, not formstone). Here every texel belongs
// to the stone that covers most of it (or to no stone), a texel where the stone changes to its right or below is the joint (so every joint
// is at least one texel wide) in a joint grey #6E6A63, each stone's value is jittered ±7 %, the hand-formed rounded edge is a
// texel lighter at its top and left and darker at its bottom and right, about one stone in seven runs on through the course under it,
// and the face is 10 % darker overall. The stones' shading inside is the recipe's own.
const FS_SNAP = Object.freeze({ joint: '#6E6A63', jitter: 0.07, lit: 1.07, dark: 0.93, merge: 0.14, value: 0.9 })
function* formstoneSnap(ctx, L, I) {
  const R = ctx.R, TW = R.w, TH = R.h, n = TW * TH, o = ctx.opts
  const stX = R.w_m / TW, stY = R.h_m / TH, ox = o.origin ? o.origin[0] : 0, oy = o.origin ? o.origin[1] : 0
  const HQ = newHits(), lab0 = new Int32Array(n).fill(-1)
  for (let ty = 0; ty < TH; ty++) {
    for (let tx = 0; tx < TW; tx++) {
      const x = wrapM(ox + (tx + 0.5) * stX, R.w_m), y = wrapM(oy + (ty + 0.5) * stY, R.h_m)
      queryInto(I, x - stX / 2, y - stY / 2, x + stX / 2, y + stY / 2, x, y, HQ)
      if (HQ.top >= 0 && HQ.area[HQ.top] >= 0.2) lab0[ty * TW + tx] = HQ.unit[HQ.top]
    }
    if (due()) yield                                                          // (a generator, §3b)
  }
  const units = L.units, root = Int32Array.from({ length: units.length }, (_, i) => i), sM = ctx.sub('snap-merge'), sJ = ctx.sub('snap-jitter')
  // each stone's columns and its lowest texel in each (rows wrap: the tile is periodic in y)
  const bottom = new Map()
  for (let ty = 0; ty < TH; ty++) for (let tx = 0; tx < TW; tx++) {
    const u = lab0[ty * TW + tx]
    if (u < 0) continue
    const key = u * TW + tx, b = bottom.get(key)
    if (b === undefined || ty > b) bottom.set(key, ty)
  }
  if (due()) yield
  const cols = new Map()
  for (const [key, ty] of bottom) { const u = Math.floor(key / TW); if (!cols.has(u)) cols.set(u, []); cols.get(u).push([key - u * TW, ty]) }
  if (due()) yield
  const taken = new Uint8Array(units.length)
  let merged = 0
  for (let a = 0; a < units.length; a++) {
    if (taken[a] || hashF(a, 1, sM) >= FS_SNAP.merge || !cols.has(a)) continue
    const ca = cols.get(a), votes = new Map()
    for (const [tx, ty] of ca) {
      for (let d = 1; d <= 2; d++) { const b = lab0[pmodi(ty + d, TH) * TW + tx]; if (b >= 0 && b !== a) { votes.set(b, (votes.get(b) || 0) + 1); break } }
    }
    let best = -1, bn = 0
    for (const [b, c] of votes) if (c > bn) { best = b; bn = c }
    if (best < 0 || taken[best] || bn < 0.6 * ca.length || !cols.has(best) || cols.get(best).length > 1.3 * ca.length) continue
    root[best] = a; taken[a] = 1; taken[best] = 1; merged++
    units[best].rnd = units[a].rnd                                                      // one stone: one tone
  }
  if (due()) yield
  const lab = new Int32Array(n)
  for (let t = 0; t < n; t++) lab[t] = lab0[t] < 0 ? -1 : root[lab0[t]]
  const at = (tx, ty) => lab[pmodi(ty, TH) * TW + pmodi(tx, TW)]
  const jm = new Uint8Array(n)
  for (let ty = 0; ty < TH; ty++) for (let tx = 0; tx < TW; tx++) { const l = lab[ty * TW + tx]; jm[ty * TW + tx] = l < 0 || l !== at(tx + 1, ty) || l !== at(tx, ty + 1) ? 1 : 0 }
  const jAt = (tx, ty) => jm[pmodi(ty, TH) * TW + pmodi(tx, TW)]
  const jc = ctx.col(FS_SNAP.joint), C = new Float64Array(5)
  return {
    meta: { merged },
    shade(s, H0, unit) {
      const tx = s.tx, ty = s.ty, t = ty * TW + tx
      if (jm[t]) {
        const k = 1 + 0.08 * (hashF(tx, ty, sJ) - 0.5)
        s.r = jc[0] * k; s.g = jc[1] * k; s.b = jc[2] * k; s.cav = 0.75; s.h = -0.004
        return
      }
      let k = -1
      for (let i = 0; i < H0.n; i++) if (H0.unit[i] === lab0[t]) { k = i; break }
      if (k < 0) k = H0.top
      if (k < 0) { s.r = jc[0]; s.g = jc[1]; s.b = jc[2]; s.cav = 0.75; s.h = -0.004; return }
      C[0] = 0; C[1] = 0; C[2] = 0; C[3] = 1; C[4] = 0
      unit(k, C)
      let m = FS_SNAP.value * (1 + 2 * FS_SNAP.jitter * (hashF(lab[t], 3, sJ) - 0.5))
      if (jAt(tx, ty - 1) || jAt(tx - 1, ty)) m *= FS_SNAP.lit
      if (jAt(tx, ty + 1) || jAt(tx + 1, ty)) m *= FS_SNAP.dark
      s.r = C[0] * m; s.g = C[1] * m; s.b = C[2] * m; s.cav = C[3]; s.h = C[4]
    },
  }
}

// the rounded border band where formstone wraps an opening
function edgeRoundAt(s, ER, SS, F, C, xw, yw, fx, W, H) {
  const S = ER.sides
  let best = Infinity, side = null, d = 0, along = 0
  for (const k of ['left', 'right', 'top', 'bottom']) {
    if (!S[k]) continue
    const dd = k === 'left' ? xw : k === 'right' ? W - xw : k === 'top' ? yw : H - yw
    if (dd / S[k] < best) { best = dd / S[k]; side = k; d = dd; along = k === 'left' || k === 'right' ? yw : xw }
  }
  if (!side) return
  const bw = S[side], jh = 0.008
  if (d > bw + 2 * jh + fx) return
  // the border stone: segments along the edge, a scored joint at the band's inner line
  const cuts = ER.segs[side]
  let i = 1
  while (i < cuts.length - 1 && cuts[i] <= along) i++
  const a0 = cuts[i - 1], a1 = cuts[i]
  const sd = Math.min(bw - d, along - a0 - jh, a1 - along - jh)
  const cov = covSd(sd, fx)
  const u = { id: 100000 + i * 4 + ['left', 'right', 'top', 'bottom'].indexOf(side), x0: 0, x1: 0.35, y0: 0, y1: bw, radius: 0.015, jointDepth: 0.004,
    rnd: [hashF(i, 11, side.length), hashF(i, 12, side.length), hashF(i, 13, side.length), 0] }
  SS.stone(u, Math.max(0, sd), 0.175, bw - d, F, C, null)
  // the arris rolls away over 3.5 cm: darker where it turns, brighter on a top return, darkest on a soffit
  const ea = 1 - sstep(0, 0.035, d), e2 = ea * ea
  const sky = side === 'top' ? 1 + 0.08 * ea : side === 'bottom' ? 1 - 0.3 * e2 : 1 - 0.14 * e2
  const k = (1 - 0.12 * e2) * sky
  let r = C[0] * k, g = C[1] * k, b = C[2] * k, cav = C[3] * (1 - 0.25 * e2), h = C[4] - 0.03 * e2
  // the joints: around the border stone (mortar colour)
  SS.joint(F, B7)
  r = r * cov + B7[0] * (1 - cov); g = g * cov + B7[1] * (1 - cov); b = b * cov + B7[2] * (1 - cov); cav = cav * cov + B7[3] * (1 - cov); h = h * cov + B7[4] * (1 - cov)
  const t = covSd(bw + 2 * jh - d, fx)                                     // the band and its scored inner joint replace the field
  s.r = lerp(s.r, r, t); s.g = lerp(s.g, g, t); s.b = lerp(s.b, b, t); s.cav = lerp(s.cav, cav, t); s.h = lerp(s.h, h, t)
}

// the formstone variants → a decorator (s, x, y, xw, yw, fx, out, F2) painted over the base, faded at the x edges
function* makeFormstoneVariant(ctx, variant, W, H, o, L, SS, BR) {
  const tag = 'fsv:' + variant, sV = ctx.sub(tag)
  const rustC = tcol(ctx, [138, 80, 44], 0.3), rustD = tcol(ctx, [86, 52, 36], 0.3), cement = ctx.col([150, 147, 140]), scratch = ctx.col([143, 140, 133])
  const salt = tcol(ctx, MASONRY.efflorescence, 0.5), soot = tcol(ctx, [40, 37, 35], 0.25), pg = ctx.col(MASONRY.parge)
  const lath = makeLath(W, H)
  const lathCol = ctx.fbm(tag + ':lathc', { feature: 0.05, octaves: 2 })
  const hole = (s, x, y, fx, sdIn, out) => {
    // inside a hole: brick (hazed with the cement that was on it) with scratch-coat remnants, the lath left on it near the torn edge,
    // deep in shade at the edge
    BR.shade(s, s.hits[1], out)
    out.r += (pg[0] - out.r) * 0.12; out.g += (pg[1] - out.g) * 0.12; out.b += (pg[2] - out.b) * 0.12
    const sc = sstep(0.05, 0.25, scrN(x, y, fx))
    let r = lerp(out.r, scratch[0] * (0.95 + 0.1 * out.relief), sc * 0.8), g = lerp(out.g, scratch[1] * (0.95 + 0.1 * out.relief), sc * 0.8), b = lerp(out.b, scratch[2] * (0.95 + 0.1 * out.relief), sc * 0.8)
    const lz = 1 - sstep(0.02 + 0.03 * c01(0.5 + lzN(x, y, fx)), 0.07, sdIn)
    const lc = lath(x, y, fx) * c01(lz + 0.25 * sstep(0.1, 0.3, lzN(x + 0.31, y, fx)))
    if (lc > 0) {
      const t = c01(0.5 + lathCol(x, y, fx)), cr = lerp(rustD[0], rustC[0], t), cg = lerp(rustD[1], rustC[1], t), cb = lerp(rustD[2], rustC[2], t)
      r = lerp(r, cr, 0.9 * lc); g = lerp(g, cg, 0.9 * lc); b = lerp(b, cb, 0.9 * lc)
    }
    const ao = 1 - 0.42 * (1 - sstep(0, 0.03, sdIn))
    return [r * ao, g * ao, b * ao, Math.min(out.cav, 1) * (0.55 + 0.35 * sstep(0, 0.03, sdIn)), -0.025 + out.h]
  }
  const scrN = ctx.fbm(tag + ':scratch', { feature: 0.12, octaves: 4 }), lzN = ctx.fbm(tag + ':lathzone', { feature: 0.1, octaves: 3 })
  if (variant === 'base') return null
  if (variant === 'toneA' || variant === 'toneB') {
    // a damp stain: an elongated wet patch with a pale salt tide line, at a seeded place; its outline wanders across the stones and
    // joints (finer noise, more of it), so it never snaps to them as a square smudge, and it is faint
    const cx = lerp(0.45, W - 0.45, hashF(0, 1, sV)), cy = lerp(0.35, 0.65, hashF(0, 2, sV)) * H
    const rx = lerp(0.22, 0.4, hashF(0, 3, sV)), ry = lerp(0.35, 0.7, hashF(0, 4, sV))
    const n = ctx.fbm(tag + ':damp', { feature: 0.09, octaves: 3 }), wet = tcol(ctx, [92, 96, 88], 0.4)
    const f = (s, x, y, xw, yw, fx) => {
      const fd = vfade(x, W)
      if (fd <= 0) return
      const q = hyp(wrapD(x - cx, W) / rx, (yw - cy) / ry) + 0.45 * n(x, y, fx)
      const m = sstep(1, 0.55, q) * fd, tide = sstep(0.07, 0, Math.abs(q - 0.97)) * sstep(-0.1, 0.25, n(x + 0.4, y, fx)) * fd
      if (m > 0) { mixS(s, wet, 0.08 * m); mulS(s, 1 - 0.07 * m); s.cav *= 1 - 0.05 * m }
      if (tide > 0) mixS(s, salt, 0.18 * tide)
    }
    f.meta = { damp: { x: cx, y: cy, rx, ry } }
    return f
  }
  if (variant === 'soot') {
    const sd = sootDecal(ctx, W, H, 0.9)
    const f = (s, x, y, xw, yw, fx, out) => { out.joint = 0; sd(s, x, y, xw, yw, fx, out) }
    f.decal = sd.decal
    return f
  }
  if (variant === 'spall') {
    const share = o.share ?? lerp(0.10, 0.25, hashF(0, 0, sV))
    const M = (yield* makeBlobMask(ctx, tag + ':mask', W, H, share, { feature: 0.55, warp: 0.08, octaves: 3 }))
    const rim = ctx.col([168, 165, 158])
    const f = (s, x, y, xw, yw, fx, out) => {
      const sd = M.sd(x, y)
      if (sd < -0.03) return
      // the broken cement edge (the coats seen edge-on): a pale band just outside the hole
      const rb = covLine(sd + 0.007, 0.006, fx)
      if (rb > 0) { mixS(s, rim, 0.55 * rb); s.cav = lerp(s.cav, 0.95, rb) }
      const hc = covSd(sd, fx)
      if (hc > 0) {
        const Hc = hole(s, x, y, fx, sd, out)
        s.r = lerp(s.r, Hc[0], hc); s.g = lerp(s.g, Hc[1], hc); s.b = lerp(s.b, Hc[2], hc); s.cav = lerp(s.cav, Hc[3], hc); s.h = lerp(s.h, Hc[4], hc)
      }
    }
    f.meta = { share, thr: M.thr }
    return f
  }
  if (variant === 'bulge') {
    const bx = lerp(0.5, W - 0.5, hashF(0, 1, sV)), by = lerp(0.3, 0.7, hashF(0, 2, sV)) * H
    const rx = lerp(0.32, 0.5, hashF(0, 3, sV)), ry = lerp(0.24, 0.4, hashF(0, 4, sV)), A = lerp(0.018, 0.03, hashF(0, 5, sV))
    const wn = ctx.fbm(tag + ':warp', { feature: 0.2, octaves: 3 }), cn = ctx.fbm(tag + ':crack', { feature: 0.05, octaves: 3 })
    const gaps = ctx.fbm(tag + ':gaps', { feature: 0.25, octaves: 2 })
    const nCr = 3 + Math.floor(hashF(0, 6, sV) * 3), cracks = []
    for (let i = 0; i < nCr; i++) cracks.push({ a: (i / nCr + 0.25 * (hashF(i, 7, sV) - 0.5)) * TAU, r0: lerp(0.25, 0.55, hashF(i, 8, sV)) })
    const dark = tcol(ctx, [52, 50, 46], 0.3), wet = tcol(ctx, [92, 94, 88], 0.4)
    const rho = (x, y, fx) => hyp(wrapD(x - bx, W) / rx, (y - by) / ry) + 0.07 * wn(x, y, fx)
    const f = (s, x, y, xw, yw, fx) => {
      const fd = vfade(x, W)
      if (fd <= 0) return
      const p = rho(x, y, fx)
      if (p > 1.6) return
      if (p < 1) {
        // the dome: its sky term (top half up-facing, lower half down-facing) and its height; the joints on it open up
        const p2 = p * p, hb = A * (1 - p2) * (1 - p2)
        const pu = rho(x, y - 0.01, fx), pd = rho(x, y + 0.01, fx)
        const hu = pu < 1 ? A * (1 - pu * pu) ** 2 : 0, hd = pd < 1 ? A * (1 - pd * pd) ** 2 : 0
        const slope = (hd - hu) / 0.02
        mulS(s, 1 + fd * Math.max(-0.22, Math.min(0.22, 2 * slope)))
        s.h += hb * fd
        if (s.cav < 0.8) mulS(s, 1 - 0.3 * (1 - p) * fd)                                   // the joints on the dome have opened
      } else if (p < 1.18 && y > by) mulS(s, 1 - 0.14 * fd * sstep(1.18, 1.0, p) * c01((y - by) / ry))   // under the overhang of its foot
      // the ring crack round its rim (broken in places) and the radial cracks
      // the rim crack is broken (about half its length is open) and runs along the joints where it meets them
      let cr = 0
      const dRing = Math.abs(p - 1 - 0.09 * cn(x, y, fx)) * Math.min(rx, ry)
      const open = sstep(0.0, 0.2, gaps(x, y, fx) + (s.cav < 0.7 ? 0.25 : 0))
      cr = Math.max(cr, covLine(dRing, 0.0016, fx) * open)
      const ang = Math.atan2((y - by) / ry, wrapD(x - bx, W) / rx)
      for (const c of cracks) {
        if (p < c.r0 || p > 1.06) continue
        const da = Math.abs(wrapD(ang - c.a - 0.18 * cn(x + 0.37, y + 0.11, fx), TAU))
        cr = Math.max(cr, covLine(da * p * Math.min(rx, ry), 0.0016, fx) * sstep(c.r0, c.r0 + 0.1, p))
      }
      const halo = Math.exp(-dRing / 0.01) * open
      if (cr > 0 || halo > 0.02) { mixS(s, dark, fd * (0.85 * cr + 0.25 * halo)); s.cav *= 1 - fd * 0.5 * cr }
      // damp washed down from the lower crack
      const dy = y - (by + ry)
      if (dy > -0.05 && dy < 0.45 && Math.abs(wrapD(x - bx, W)) < rx * 0.8) {
        const m = (1 - sstep(0, 0.45, dy)) * sstep(rx * 0.8, rx * 0.3, Math.abs(wrapD(x - bx, W))) * sstep(-0.05, 0.02, dy)
        mixS(s, wet, 0.14 * m * fd)
      }
    }
    f.meta = { bulge: { x: bx, y: by, rx, ry, A } }
    return f
  }
  if (variant === 'lathSheet') {
    // the sheet that came away is a group of whole stones: the 3–6 stones nearest a seeded point, torn along their joints
    const hx0 = lerp(0.75, W - 0.75, hashF(0, 1, sV)), hy0 = lerp(0.3, 0.45, hashF(0, 2, sV)) * H, nS = 3 + Math.floor(hashF(0, 3, sV) * 4)
    const near = []
    for (const u of L.units) {
      let best = null
      for (const ox of [-W, 0, W]) for (const oy of [-H, 0, H]) {
        const d = hyp((u.x0 + u.x1) / 2 + ox - hx0, (u.y0 + u.y1) / 2 + oy - hy0)
        if (!best || d < best.d) best = { u, ox, oy, d, poly: u.poly.map((v, i) => v + (i & 1 ? oy : ox)) }
      }
      near.push(best)
    }
    near.sort((a, b) => a.d - b.d || a.u.id - b.u.id)
    const cands = near.slice(0, nS)
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity
    for (const c of cands) { bx0 = Math.min(bx0, c.u.x0 + c.ox); by0 = Math.min(by0, c.u.y0 + c.oy); bx1 = Math.max(bx1, c.u.x1 + c.ox); by1 = Math.max(by1, c.u.y1 + c.oy) }
    const hx = (bx0 + bx1) / 2, hy = (by0 + by1) / 2, ax = (bx1 - bx0) / 2, ay = (by1 - by0) / 2, jg = 0.013
    const side = hashF(0, 5, sV) < 0.5 ? -1 : 1, th = side * lerp(0.06, 0.16, hashF(0, 6, sV)), drop = lerp(0.45, 0.75, hashF(0, 7, sV)) * Math.min(ay, 0.22)
    const piv = [hx + side * ax * 0.85, by0 + 0.03]                                          // the top corner it still hangs from
    const bn = ctx.fbm(tag + ':edge', { feature: 0.06, octaves: 3 })
    // + inside: the union of those stones grown over their joints, its edge torn a little (so the tear follows the joints)
    const sdHole = (x0, y) => {
      const x = hx + wrapD(x0 - hx, W)                                                       // the copy of x nearest the hole
      if (x < bx0 - 0.1 || x > bx1 + 0.1 || y < by0 - 0.1 || y > by1 + 0.1) return -0.1
      let d = -Infinity
      for (const c of cands) d = Math.max(d, polyDist(c.poly, x, y) + jg)
      return d + 0.03 * bn(x, y)
    }
    const cs = Math.cos(th), sn = Math.sin(th)
    // world → the sheet's own (original) position: undo the drop and the rotation about the pivot
    const toSheet = (x, y, q) => { const dx = wrapD(x - piv[0], W), dy = y - piv[1] - drop; q[0] = piv[0] + dx * cs + dy * sn; q[1] = piv[1] - dx * sn + dy * cs; return q }
    const diag = Math.max(0.1, hyp(2 * ax, 2 * ay))
    // in the hole: the grey scratch coat with the rusty lath over it; the brick only where the scratch coat has gone as well
    const scratchC = ctx.col([138, 135, 128]), bareN = ctx.fbm(tag + ':bare', { feature: 0.09, octaves: 3 })
    const bareT = (yield* fieldQ((x, y) => bareN(x, y), W, H)).q(0.8)
    const holeLS = (s, x, y, fx, sdIn, out) => {
      BR.shade(s, s.hits[1], out)
      out.r += (pg[0] - out.r) * 0.12; out.g += (pg[1] - out.g) * 0.12; out.b += (pg[2] - out.b) * 0.12
      const coat = 1 - sstep(bareT - 0.03, bareT + 0.03, bareN(x, y, fx)), kc = (0.94 + 0.12 * c01(0.5 + scrN(x, y, fx))) * (1 - 0.05 * c01(0.5 + lzN(x, y, fx)))
      let r = lerp(out.r, scratchC[0] * kc, coat), g = lerp(out.g, scratchC[1] * kc, coat), b = lerp(out.b, scratchC[2] * kc, coat)
      const lc = 0.85 * lath(x, y, fx)
      if (lc > 0) {
        const t = c01(0.5 + lathCol(x, y, fx)), cr = lerp(rustD[0], rustC[0], t), cg = lerp(rustD[1], rustC[1], t), cb = lerp(rustD[2], rustC[2], t)
        r = lerp(r, cr, lc); g = lerp(g, cg, lc); b = lerp(b, cb, lc)
      }
      const ao = 1 - 0.42 * (1 - sstep(0, 0.03, sdIn))
      return [r * ao, g * ao, b * ao, lerp(Math.min(out.cav, 1), 0.92, coat) * (0.55 + 0.35 * sstep(0, 0.03, sdIn)), -0.022 + (1 - coat) * out.h]
    }
    const rim = ctx.col([166, 163, 156]), q = [0, 0]
    const f = (s, x, y, xw, yw, fx, out, F2) => {
      const fd = vfade(x, W)
      if (fd <= 0) return
      const sdH = sdHole(x, yw)
      toSheet(x, yw, q)
      const sdS = sdHole(q[0], q[1]) - 0.012
      if (sdH < -0.05 && sdS < -0.06) return
      // the hole: the scratch coat and the lath
      const hc = covSd(sdH, fx) * fd
      const rb = covLine(sdH + 0.007, 0.006, fx) * fd
      if (rb > 0) mixS(s, rim, 0.5 * rb)
      if (hc > 0) {
        const Hc = holeLS(s, x, yw, fx, sdH, out)
        s.r = lerp(s.r, Hc[0], hc); s.g = lerp(s.g, Hc[1], hc); s.b = lerp(s.b, Hc[2], hc); s.cav = lerp(s.cav, Hc[3], hc); s.h = lerp(s.h, Hc[4], hc)
      }
      // the occlusion the hanging sheet throws on the wall below and around it
      if (sdS < 0 && sdS > -0.05) { const ao = (1 - sstep(0, 0.05, -sdS)) * fd; mulS(s, 1 - 0.32 * ao); s.cav *= 1 - 0.3 * ao }
      // lath torn out with the sheet, sticking out past its edge
      if (sdS < 0 && sdS > -0.022) { const lc = lath(q[0], q[1], fx) * fd * sstep(-0.022, -0.004, sdS); if (lc > 0) mixS(s, rustD, 0.85 * lc) }
      // the sheet: the stones that were in the hole, tilted out at the foot (a little darker), its torn rim pale
      const sc = covSd(sdS, fx) * fd
      if (sc > 0) {
        let best = -Infinity, bu = null, bx = 0, by = 0
        for (const c of cands) {
          const ed = polyDist(c.u.poly, q[0] - c.ox, q[1] - c.oy)
          if (ed > best) { best = ed; bu = c.u; bx = q[0] - c.ox - c.u.x0; by = q[1] - c.oy - c.u.y0 }
        }
        SS.fields(q[0], q[1], fx, F2)
        const Cs = [0, 0, 0, 1, 0]
        let r, g, b, cav
        if (bu) {
          const cv = covSd(best, fx)
          SS.stone(bu, Math.max(0, best), bx, by, F2, Cs, null)
          const sr = Cs[0], sg = Cs[1], sb = Cs[2], scv = Cs[3]
          SS.joint(F2, Cs)
          r = lerp(Cs[0], sr, cv); g = lerp(Cs[1], sg, cv); b = lerp(Cs[2], sb, cv); cav = lerp(Cs[3], scv, cv)
        } else { SS.joint(F2, Cs); r = Cs[0]; g = Cs[1]; b = Cs[2]; cav = Cs[3] }
        // it leans out of the wall more toward its free edge (away from the corner it hangs from), so it faces the sky less there
        const tf = c01(hyp(q[0] - piv[0], q[1] - piv[1]) / diag)
        const tilt = 0.92 - 0.16 * tf, edge = covLine(sdS - 0.006, 0.006, fx)
        r = lerp(r * tilt, rim[0], 0.55 * edge); g = lerp(g * tilt, rim[1], 0.55 * edge); b = lerp(b * tilt, rim[2], 0.55 * edge)
        s.r = lerp(s.r, r, sc); s.g = lerp(s.g, g, sc); s.b = lerp(s.b, b, sc); s.cav = lerp(s.cav, cav, sc); s.h = lerp(s.h, 0.02 + 0.04 * tf, sc)
      }
    }
    f.meta = { hole: { x: hx, y: hy, ax, ay, stones: cands.map((c) => c.u.id) }, sheet: { pivot: piv, angle: th, drop } }
    return f
  }
  if (variant === 'rust') {
    // lath sheets 27 in (0.686 m) tall nailed every 16 in (0.406 m): a third of the nails bleed rust through the coats
    const y0 = lerp(0.08, 0.4, hashF(0, 1, sV)), x0 = hashF(0, 2, sV) * 0.406, src = [], rows = []
    for (let ry = y0; ry < H - 0.1; ry += 0.686) {
      rows.push(ry)
      for (let rx = x0, i = 0; rx < W; rx += 0.406, i++) {
        if (rx < 0.2 || rx > W - 0.2 || hashF(i, Math.round(ry * 100), sV) > 0.4) continue
        src.push([rx + (hashF(i, 3, sV) - 0.5) * 0.03, ry + (hashF(i, 4, sV) - 0.5) * 0.02])
      }
    }
    // drips that hang nearly plumb with a slow wander (30–70 cm wavelength, never a coil) and taper from a small bloom (no round head);
    // along the lath rows only a faint stain, in broken 5–20 cm pieces (never a ruled line, so a row and a drip never join into a letter)
    const RO = { wl: [0.3, 0.7], amp: [0.002, 0.005], head: [0.5, 0.45] }
    const runs = makeRustRuns(ctx.sub(tag + ':runs'), { w: W, h: H, sources: src, lenMin: 0.08, lenMax: 0.7, width: 0.04, strength: 0.95, ...RO })
    const wide = makeRustRuns(ctx.sub(tag + ':wide'), { w: W, h: H, sources: src, lenMin: 0.1, lenMax: 0.4, width: 0.08, strength: 0.4, ...RO })
    const band = ctx.fbm(tag + ':band', { feature: 0.12, octaves: 3 }), streak = ctx.fbm(tag + ':streak', { featureX: 0.015, featureY: 0.25, octaves: 2 })
    const mOf = (x, y, yw, fx) => {
      let m = runs(x, y) * (0.75 + 0.5 * c01(0.5 + streak(x, y, fx))) + 0.7 * wide(x, y)
      for (const ry of rows) {
        const d = Math.abs(yw - ry)
        if (d < 0.05) { const bv = band(x, y, fx); m = Math.max(m, 0.10 * (1 - d / 0.05) * sstep(0.25, 0.55, bv) * c01(0.5 + 1.5 * bv)) }
      }
      return c01(m)
    }
    const f = (s, x, y, xw, yw, fx) => {
      const fd = vfade(x, W)
      if (fd <= 0) return
      const m = mOf(x, y, yw, fx)
      if (m > 0) { mixS(s, rustC, 0.8 * m * fd); mixS(s, rustD, 0.3 * m * m * fd) }
    }
    f.decal = (x, y, fx) => mOf(x, y, wrapM(y, H), fx) * vfade(x, W)
    f.meta = { nails: src.length, rows }
    return f
  }
  if (variant === 'efflorescence') {
    const eff = makeEfflorescence(ctx.sub(tag + ':salt'), { w: W, h: H, height: 0.55, density: 0.5, foot: H, feature: 0.1 })
    const damp = makeDampFoot(ctx.sub(tag + ':damp'), { w: W, h: H, height: 0.75, jag: 0.08 })
    const jn = ctx.fbm(tag + ':joint', { feature: 0.1, octaves: 3 }), haze = ctx.fbm(tag + ':haze', { feature: 0.2, octaves: 3 })
    return (s, x, y, xw, yw, fx) => {
      const fd = vfade(x, W)
      if (fd <= 0) return
      mulS(s, 1 - 0.1 * damp(x, y) * fd)
      // powdery salt: a soft haze low on the wall, a crust in blotches at the foot, white lines in the joints where the water moves
      const z = H - yw, inJ = s.cav < 0.75 ? (0.75 - s.cav) / 0.25 : 0
      const hz = 0.22 * sstep(0.9, 0.1, z) * c01(0.5 + 1.2 * haze(x, y, fx))
      const e = c01(0.65 * eff(x, y, fx) + hz + inJ * 0.8 * sstep(1.2, 0.3, z) * c01(0.3 + jn(x, y, fx) * 1.5)) * fd
      if (e > 0) { mixS(s, salt, 0.62 * e); s.cav = lerp(s.cav, 0.95, 0.4 * e) }
    }
  }
  if (variant === 'parge') {
    // a trowelled repair: two to four overlapping daubs, so its outline is lumpy, never a rectangle
    const cx = lerp(0.75, W - 0.75, hashF(0, 2, sV)), cy = lerp(0.3, 0.7, hashF(0, 3, sV)) * H
    const n = 2 + Math.floor(hashF(0, 1, sV) * 3), patches = []
    for (let i = 0; i < n; i++) patches.push({ x: cx + (hashF(i, 6, sV) - 0.5) * 0.5, y: cy + (hashF(i, 7, sV) - 0.5) * 0.45,
      ax: lerp(0.14, 0.3, hashF(i, 4, sV)), ay: lerp(0.12, 0.28, hashF(i, 5, sV)), r: 0.1 })
    const bn = ctx.fbm(tag + ':edge', { feature: 0.07, octaves: 4 }), pg = ctx.col(MASONRY.parge)
    const mot = ctx.fbm(tag + ':mottle', { feature: 0.12, octaves: 3 }), dirtN = ctx.fbm(tag + ':dirt', { featureX: 0.05, featureY: 0.4, octaves: 3 })
    const PS = makePargeSurface(ctx, tag)
    const f = (s, x, y, xw, yw, fx) => {
      const fd = vfade(x, W)
      if (fd <= 0) return
      let sd = -Infinity
      for (const p of patches) sd = Math.max(sd, -sdRRect(wrapD(x - p.x, W), yw - p.y, p.ax, p.ay, p.r))
      sd += 0.045 * bn(x, y, fx)
      if (sd < -0.01) return
      // feathered edge: the parge thins out over the formstone, whose joints show through near the boundary
      const t = sstep(0, 0.03, sd), cov = covSd(sd, fx) * fd
      const k = PS(x, y, fx) * (1 + 0.05 * mot(x, y, fx)) * (1 - 0.1 * sstep(0.1, 0.5, dirtN(x, y, fx)))
      const jointShow = 1 - t
      const cr = pg[0] * k, cg = pg[1] * k, cb = pg[2] * k
      const thin = (s.cav < 0.75 ? 0.82 : 1) * jointShow + (1 - jointShow)
      s.r = lerp(s.r, cr * thin, cov * (0.55 + 0.45 * t)); s.g = lerp(s.g, cg * thin, cov * (0.55 + 0.45 * t)); s.b = lerp(s.b, cb * thin, cov * (0.55 + 0.45 * t))
      s.cav = lerp(s.cav, 0.97, cov * t); s.h = lerp(s.h, 0.003, cov)
      const ledge = covLine(sd, 0.0018, fx) * fd, shrink = covLine(sd - 0.012, 0.0006, fx) * fd * sstep(0, 0.3, bn(x + 0.29, y + 0.13, fx))
      if (ledge > 0 || shrink > 0) mulS(s, 1 - 0.16 * ledge - 0.4 * shrink)
    }
    f.meta = { patches }
    return f
  }
  throw new Error(`paintFormstone: variant ${variant} has no painter`)
}

// the trowelled cement surface (parge): value factor around 1 (trowel sweeps, lifts, sand) at (x, y). Each Voronoi cell is one
// stroke: faint ridges on circles about a centre 0.3–0.6 m off the cell, so a stroke shows a few gentle parallel sweeps, never rings
function makePargeSurface(ctx, tag) {
  const arcs = ctx.voronoi(tag + ':trowel', { feature: 0.3, search: 1 }), sA = ctx.sub(tag + ':trowel')
  const lift = ctx.fbm(tag + ':lift', { featureX: 1.2, featureY: 0.25, octaves: 2 }), blot = ctx.fbm(tag + ':blot', { feature: 0.18, octaves: 3 })
  const sand = ctx.noise(tag + ':sand', { feature: 0.004 }), wob = ctx.fbm(tag + ':wob', { feature: 0.1, octaves: 2 })
  const V = {}
  return (x, y, fx) => {
    arcs(x, y, V)
    const a = hashF(V.id, 2, sA) * TAU, R = lerp(0.3, 0.6, hashF(V.id, 3, sA))
    const cx = x + V.dx + Math.cos(a) * R, cy = y + V.dy + Math.sin(a) * R                  // this stroke's centre of swing
    const ph = hashF(V.id, 0, sA) * TAU, sp = lerp(0.03, 0.05, hashF(V.id, 1, sA))
    const ridge = Math.sin((TAU * (hyp(x - cx, y - cy) + 0.006 * wob(x, y, fx))) / sp + ph)
    const arc = ridge * sstep(0, 0.05, V.edge) * bandK(sp / 2, fx) * lerp(0.4, 1, hashF(V.id, 4, sA))
    return (1 + 0.012 * arc) * (1 + 0.03 * lift(x, y, fx)) * (1 + 0.03 * blot(x, y, fx)) * (1 + 0.03 * (2 * sand(x, y, fx) - 1) * bandK(0.004, fx))
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §6 paintMarble: white crystalline metalimestone. Weathered to a sugary off-white, soiled grey
//  in recesses and drip washes, rust at rail feet, painted by some owners, salvaged from vacant stoops (the missing-step core).
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const CRYSTAL = 1 / 128                                                   // the sugar grid: one crystal cell per 128 tpm texel
const VEIN_DIRS_A = [[1, 1], [1, -1], [2, 1], [1, 2], [2, -1]], VEIN_DIRS_B = [[3, 1], [1, 3], [3, -2], [2, 3], [3, -1]]

export const paintMarble = makeRecipe({ name: 'paintMarble', stock: 'M', periodic: true, *paint(ctx) {
  const W = ctx.w_m, H = ctx.h_m, o = ctx.opts, variant = o.variant ?? 'weathered'
  checkVariant('paintMarble', variant, MARBLE_VARIANTS)
  if (variant === 'missingCore') return (yield* paintMarbleCore(ctx))
  const fresh = variant === 'fresh', sM = ctx.sub('marble')
  const base = ctx.col(fresh ? MASONRY.marbleFresh : MASONRY.marbleWeathered)
  const veinC = fresh ? ctx.col(MASONRY.marbleVein) : lerp3(ctx.col(MASONRY.marbleWeathered), ctx.col([178, 176, 168]), 0.8)
  const soilC = ctx.col(MASONRY.soil)
  const soilK = variant === 'soiled' ? 1 : fresh ? 0.12 : 0.4
  // veins: two sets of periodic warped stripes in different directions; set A broad and cloudy, set B thin and sharper
  const dA = pick(VEIN_DIRS_A, hashF(0, 0, sM)), dB = pick(VEIN_DIRS_B, hashF(0, 1, sM))
  const wA = ctx.fbm('veinA-warp', { feature: 0.45, octaves: 4 }), wB = ctx.fbm('veinB-warp', { feature: 0.3, octaves: 4 })
  const gB = ctx.fbm('veinB-gate', { feature: 0.25, octaves: 3 }), mB = 2 + Math.floor(hashF(0, 2, sM) * 2)
  // vein strength varies ALONG the veins with a periodic field (a per-vein hash would not wrap: crossing the tile moves the index)
  const gA = ctx.fbm('veinA-gate', { feature: 0.4, octaves: 3 })
  const cloud = ctx.fbm('cloud', { feature: 0.25, octaves: 4 }), crystal = makeCellGrid(W, H, CRYSTAL, ctx.sub('crystal'))
  const wash = ctx.fbm('wash', { featureX: 0.06, featureY: 0.7, octaves: 3 }), blot = ctx.fbm('blot', { feature: 0.4, octaves: 4 })
  const gate = ctx.fbm('wash-gate', { featureX: 0.4, featureY: 4, octaves: 2 })
  const crust = ctx.fbm('crust', { feature: 0.12, octaves: 3 }), drip = ctx.fbm('drip', { featureX: 0.04, featureY: 0.6, octaves: 3 })
  const veins = (x, y, fx) => {
    const pa = (dA[0] * x) / W + (dA[1] * y) / H + 0.55 * wA(x, y, fx)
    const da = Math.abs(pa - Math.round(pa))
    const va = (0.3 + 0.7 * c01(0.5 + 1.4 * gA(x, y, fx))) * Math.exp(-((da / 0.07) ** 2))
    const pb = mB * ((dB[0] * x) / W + (dB[1] * y) / H) + 0.6 * wB(x, y, fx)
    const db = Math.abs(pb - Math.round(pb))
    const vb = sstep(-0.05, 0.3, gB(x, y, fx)) * Math.exp(-((db / 0.012) ** 2)) * bandK(0.012 / (mB + 1), fx)
    return [va, vb]
  }
  // joints (an ashlar face) and the tread
  let SL = null
  if (o.joints && o.joints !== 'none') {
    const J = o.joints === 'ashlar' ? { course: 0.5, stretcher: 1.2 } : o.joints
    SL = layoutBrick(W, H, ctx.sub('slabs'), { bond: 'running', course: J.course, stretcher: J.stretcher, joint: 0.003 })
  }
  const I = SL ? indexUnits(SL) : null
  const tread = !!o.tread
  const V = (yield* makeMarbleVariant(ctx, variant, W, H, o, { soilC, base }))
  yield* ctx.raster((s) => {
    const x = s.x, y = s.y, fx = s.fx, xw = wrapM(x, W), yw = wrapM(y, H)
    const [va, vb] = veins(x, y, fx)
    let r = base[0], g = base[1], b = base[2]
    const tv = c01(0.55 * va + 0.5 * vb) * (fresh ? 0.9 : 0.7)
    r = lerp(r, veinC[0], tv); g = lerp(g, veinC[1], tv); b = lerp(b, veinC[2], tv)
    // sugar: a crystal grid at 128 tpm, ±4%; fades to its mean at coarser footprints
    const cr = (crystal(x, y) * 2 - 1) * bandK(2 * crystal.cell, fx)
    let k = (1 + 0.025 * cloud(x, y, fx)) * (1 + 0.04 * cr * (tread ? 0.6 : 1))
    // soiling: drip washes, blotches of crust in sheltered spots, dirt in the darkest pores
    const gw = sstep(-0.05, 0.3, gate(x, y, fx)) * (variant === 'soiled' ? 1 : 0.7) + (variant === 'soiled' ? 0.3 : 0)
    let soil = soilK * (0.5 * gw * sstep(0.1, 0.5, wash(x, y, fx)) + 0.5 * sstep(0.1, 0.45, blot(x, y, fx)) * (variant === 'soiled' ? 0.5 : 0.35))
    // the crust follows the water: it gathers in vertical drip lines, not in free clouds
    if (variant === 'soiled') soil += 0.45 * sstep(-0.1, 0.4, crust(x, y, fx)) * sstep(0, 0.35, blot(x, y, fx) + 0.25) * sstep(-0.05, 0.3, drip(x, y, fx))
    soil += (fresh ? 0.02 : 0.06) * c01(-cr)
    let cav = 1, h = 0
    if (SL) {
      // the slab joints: fine, dirty, their edges worn round
      const Hh = s.hits[0]
      let inside = 0, edm = 0
      for (let i = 0; i < Hh.n; i++) { inside += Hh.area[i]; edm = Math.max(edm, Hh.ed[i]) }
      const worn = 1 - sstep(0, 0.012, edm)
      soil += 0.4 * worn * worn + 0.7 * (1 - inside)
      k *= (1 - 0.06 * worn * worn) * (1 - 0.25 * (1 - inside))
      cav = 1 - 0.25 * worn * worn - 0.5 * (1 - inside); h = -0.004 * worn * worn - 0.006 * (1 - inside)
    }
    if (tread) {
      // a worn hollow in the walking line (cleaner, smoother), dirt against the riser above (y = h), a rounded nosing at y = 0
      const q = hyp((xw - W / 2) / (0.34 * W), (yw - 0.42 * H) / (0.3 * H)), hol = c01(1 - q * q)
      soil *= 1 - 0.6 * hol; k *= 1 + 0.03 * hol; h -= 0.012 * hol
      const back = 1 - sstep(0, 0.04, H - yw), nose = 1 - sstep(0, 0.015, yw)
      soil += 0.6 * back; k *= 1 - 0.12 * nose; cav *= 1 - 0.2 * back - 0.15 * nose
    }
    soil = c01(soil)
    r = lerp(r, soilC[0], 0.62 * soil); g = lerp(g, soilC[1], 0.62 * soil); b = lerp(b, soilC[2], 0.62 * soil)
    s.r = r * k; s.g = g * k; s.b = b * k; s.cav = cav * (1 - 0.06 * soil); s.h = h
    if (V) V(s, x, y, xw, yw, fx)
    if (o.foot) { const z = H - yw; if (z < 0.25) { const t = (1 - z / 0.25) ** 2; mixS(s, soilC, 0.4 * t); s.cav *= 1 - 0.06 * t } }
  }, { layers: I ? [I] : [] })
  if (V && V.decal) yield* decalPass(ctx, V.decal)
  return { variant, veins: { A: dA, B: dB, perB: mB }, joints: SL ? SL.module : null, tread, ...(V && V.meta ? V.meta : {}) }
} })

function* makeMarbleVariant(ctx, variant, W, H, o, C) {
  const sV = ctx.sub('mv:' + variant), tag = 'mv:' + variant
  if (variant === 'weathered' || variant === 'fresh' || variant === 'soiled') return null
  if (variant === 'painted') {
    const key = o.paint ?? (hashF(0, 0, sV) < 0.5 ? 'grey' : 'white')
    const hex = key === 'grey' ? '#A9A7A0' : key === 'white' ? '#E4E1D8' : key
    const pc = ctx.col(hex), peel = c01(o.peel ?? lerp(0.08, 0.18, hashF(0, 1, sV)))
    // painted steps lose their paint where feet and weather hit: along the nosings and arrises (the tile's top and bottom edges, laid
    // along them), in a few small flakes elsewhere; the risers and cheeks keep most of it (never an even field of flakes)
    const pf = ctx.fbm(tag + ':peel', { feature: 0.10, octaves: 5 }), pw = ctx.warp(tag + ':pw', { feature: 0.12, octaves: 2, amp: 0.012 })
    const brush = ctx.fbm(tag + ':brush', { featureX: 0.3, featureY: 0.012, octaves: 2 })
    // the edge bias: strong on the arris (the outer 6 cm), a gentler wear over the outer 30 cm (the tread front, where feet land)
    const Wp = {}, field = (x, y) => {
      const yw = wrapM(y, H), d = Math.min(yw, H - yw)
      pw(x, y, Wp)
      return pf(Wp.x, Wp.y) + 0.6 * (1 - sstep(0, 0.06, d)) + 0.45 * (1 - sstep(0.04, 0.30, d))
    }
    const thr = (yield* fieldQ(field, W, H, 96)).q(1 - peel)
    const f = (s, x, y, xw, yw, fx) => {
      const v = thr - field(x, y)
      let sd
      if (Math.abs(v) > 0.25) sd = v > 0 ? 0.2 : -0.2
      else { const d = 0.004, gx = (field(x + d, y) - field(x - d, y)) / (2 * d), gy = (field(x, y + d) - field(x, y - d)) / (2 * d); sd = v / Math.max(1e-3, hyp(gx, gy)) }
      // painting is a whole-surface state (no edge fade): paint over the marble, flat and brushed (no vertical dirt streaks: on a
      // repeating tile they barcode), flaking off in small sheets
      const cov = covSd(sd, fx)
      const k = (1 + 0.02 * brush(x, y, fx)) * (s.cav < 0.9 ? 0.9 + 0.1 * s.cav : 1)
      s.r = lerp(s.r, pc[0] * k, cov); s.g = lerp(s.g, pc[1] * k, cov); s.b = lerp(s.b, pc[2] * k, cov)
      s.cav = lerp(s.cav, 1 - 0.3 * (1 - s.cav), cov); s.h += 0.0002 * cov
      const lip = covLine(sd - 0.0012, 0.001, fx), shadow = covLine(sd + 0.002, 0.0016, fx)
      if (lip > 0) mulS(s, 1 + 0.08 * lip)
      if (shadow > 0) { mulS(s, 1 - 0.22 * shadow); s.cav *= 1 - 0.25 * shadow }
    }
    f.meta = { paint: key, peel }
    return f
  }
  if (variant === 'crackA' || variant === 'crackB') {
    const paths = []
    if (variant === 'crackA') {
      const x0 = lerp(0.3 * W, 0.7 * W, hashF(0, 1, sV)), x1 = lerp(0.3 * W, 0.7 * W, hashF(0, 2, sV))
      const p = crackPath(ctx.sub(tag + ':main'), x0, lerp(0.05, 0.2, hashF(0, 3, sV)) * H, x1, lerp(0.8, 0.95, hashF(0, 4, sV)) * H, 28, 0.025)
      paths.push({ P: p, w: 0.0015 })
      // its branch: a short thin spur forking forward (downward, 20–34° off the crack) from a point in its middle third, shorter than
      // 8 cm (a long branch off a long crack draws a λ or a y: the stroke-decal node test fails three strokes over 8 cm at one point)
      const at = 10 + Math.floor(hashF(0, 5, sV) * 8), bx = p[2 * at], by = p[2 * at + 1], dir = hashF(0, 6, sV) < 0.5 ? -1 : 1
      const ma = Math.atan2(p[2 * at + 5] - by, p[2 * at + 4] - bx), sa = ma + dir * lerp(0.35, 0.6, hashF(0, 8, sV)), len = lerp(0.05, 0.075, hashF(0, 7, sV))
      paths.push({ P: crackPath(ctx.sub(tag + ':branch'), bx, by, bx + Math.cos(sa) * len, by + Math.sin(sa) * len, 5, 0.004), w: 0.0007 })
    } else {
      // one nearly straight through-crack, drawn as two halves from a point off-centre with a slight kink there (±6°), and one short,
      // thin spur that branches FORWARD at an acute angle (20–34°) from a point a third to two thirds along one half. Never three arms
      // from one point: a through-crack with a spur at its junction, or three near-equal arms, draws a y, a λ or a Y. The crack runs
      // diagonally (25–65° from the horizontal), the way a slab breaks across, never plumb.
      const jx = (hashF(0, 1, sV) < 0.5 ? lerp(0.22, 0.38, hashF(0, 7, sV)) : lerp(0.62, 0.78, hashF(0, 7, sV))) * W, jy = lerp(0.4, 0.6, hashF(0, 2, sV)) * H
      const a0 = (hashF(0, 3, sV) < 0.5 ? 1 : -1) * lerp(0.44, 1.13, hashF(0, 8, sV))
      const arms = [[a0, lerp(0.45, 0.8, hashF(0, 5, sV))], [a0 + Math.PI + (hashF(1, 4, sV) - 0.5) * 0.2, lerp(0.45, 0.8, hashF(1, 5, sV))]]
      arms.forEach(([a, len], i) => {
        let ex = jx + Math.cos(a) * len, ey = jy + Math.sin(a) * len
        ex = Math.max(0.3, Math.min(W - 0.3, ex)); ey = Math.max(0.05, Math.min(H - 0.05, ey))
        paths.push({ P: crackPath(ctx.sub(tag + ':c' + i), jx, jy, ex, ey, 16, 0.018), w: 0.0014 })
      })
      // the spur's root ON the drawn first half, its direction along that half's chord (forward, away from the middle point), shorter
      // than 8 cm (the stroke-decal node test fails three strokes over 8 cm meeting within 1 cm)
      const P0 = paths[0].P, kr = Math.round(lerp(0.35, 0.65, hashF(2, 7, sV)) * 16), rx = P0[2 * kr], ry = P0[2 * kr + 1]
      const ch = Math.atan2(P0[33] - P0[1], P0[32] - P0[0]), sa = ch + (hashF(2, 6, sV) < 0.5 ? 1 : -1) * lerp(0.35, 0.6, hashF(2, 4, sV))
      const sl = lerp(0.04, 0.07, hashF(2, 5, sV))
      paths.push({ P: crackPath(ctx.sub(tag + ':c2'), rx, ry, rx + Math.cos(sa) * sl, ry + Math.sin(sa) * sl, 5, 0.004), w: 0.0007 })
    }
    const craze = variant === 'crackB' ? ctx.voronoi(tag + ':craze', { feature: 0.12, search: 1 }) : null, sC = ctx.sub(tag + ':cz')
    // the crazing: round the spur's root, where the stone was stressed most
    const jx = variant === 'crackB' ? paths[2].P[0] : 0, jy = variant === 'crackB' ? paths[2].P[1] : 0, V = {}
    const dark = tcol(ctx, [70, 66, 60], 0.4)
    // minW: the least half-width a line is drawn with (0 for the colour; half an output texel for the decal mask)
    const crackAt = (x, xw, yw, fx, o, minW = 0) => {
      let c = 0, halo = 0
      for (const p of paths) {
        const d = distPolyline(p.P, xw, yw)
        if (d > 0.03) continue
        c = Math.max(c, covLine(d, Math.max(p.w, minW), fx)); halo = Math.max(halo, Math.exp(-d / 0.008))
      }
      if (craze) {
        const dj = hyp(xw - jx, yw - jy)
        // the crazing: hairlines at their true width in the decal mask too (a faint net, not strokes; its three-way junctions are
        // centimetres across)
        if (dj < 0.45) { craze(x, wrapM(yw, H), V); if (hashF(V.id, V.id2, sC) < 0.55) c = Math.max(c, 0.7 * covLine(V.edge, 0.001, fx) * sstep(0.45, 0.15, dj)) }
      }
      o.c = c; o.halo = halo
      return o
    }
    const CO = { c: 0, halo: 0 }
    const f = (s, x, y, xw, yw, fx) => {
      const fd = vfade(x, W)
      if (fd <= 0) return
      const { c, halo } = crackAt(x, xw, yw, fx, CO)
      // dirt washes into a crack and stains the stone either side of it
      if (halo > 0.01) mixS(s, C.soilC, 0.5 * halo * fd)
      if (c > 0) { mixS(s, dark, 0.75 * c * fd); s.cav *= 1 - 0.55 * c * fd; s.h -= 0.003 * c * fd }
    }
    f.decal = (x, y, fx, tex) => crackAt(x, wrapM(x, W), wrapM(y, H), fx, CO, 0.5 * tex).c * vfade(x, W)
    f.meta = { cracks: paths.length }
    return f
  }
  if (variant === 'rustRun') {
    const rx = o.railX ?? lerp(0.3 * W, 0.7 * W, hashF(0, 1, sV)), ry = o.railY ?? 0.05, foot = o.railFoot ?? ry > 0.02
    // marble drinks rust: a broad soft stain round the foot, a run of 5–10 cm down the face, darker in its core, streaked
    const runs = makeRustRuns(ctx.sub(tag + ':runs'), { w: W, h: H, sources: [[rx, ry + 0.01], [rx + 0.015, ry + 0.02]], lenMin: 0.45, lenMax: 0.95, width: 0.1, strength: 0.75 })
    const core = makeRustRuns(ctx.sub(tag + ':core'), { w: W, h: H, sources: [[rx, ry + 0.01]], lenMin: 0.3, lenMax: 0.6, width: 0.035, strength: 0.9 })
    const hn = ctx.fbm(tag + ':halo', { feature: 0.05, octaves: 3 }), st = ctx.fbm(tag + ':streak', { featureX: 0.015, featureY: 0.2, octaves: 2 })
    const rust = tcol(ctx, [168, 98, 52], 0.25), rustD = tcol(ctx, [118, 68, 40], 0.25), lead = tcol(ctx, [100, 98, 94], 0.3), iron = tcol(ctx, [56, 44, 38], 0.3)
    const mOf = (x, y, yw, fx) => {
      // a tight bloom round the foot and a soft broad wash below it (never a hard-edged funnel hanging from the arris, which would read
      // as a T); the core run carries the colour down the face
      const d = hyp(wrapD(x - rx, W), yw - ry), halo = 0.25 * Math.exp(-d / (0.08 + 0.03 * hn(x, y, fx))) + 0.4 * Math.exp(-d / 0.025)
      return c01(0.45 * runs(x, y) * (0.7 + 0.5 * c01(0.5 + st(x, y, fx))) + halo + 0.7 * core(x, y))
    }
    const f = (s, x, y, xw, yw, fx) => {
      const fd = vfade(x, W)
      if (fd <= 0) return
      const dx = wrapD(x - rx, W), dy = yw - ry, d = hyp(dx, dy)
      const m = mOf(x, y, yw, fx)
      if (m > 0) { mixS(s, rust, 0.6 * m * fd); mixS(s, rustD, 0.3 * m * m * fd) }
      if (foot) {
        const plug = covSd(0.022 - d, fx) * fd, bar = covSd(Math.min(0.011 - Math.abs(dx), 0.011 - Math.abs(dy)), fx) * fd
        if (plug > 0) { mixS(s, lead, 0.85 * plug); s.cav = lerp(s.cav, 0.8, plug) }
        if (bar > 0) { mixS(s, iron, bar); s.h = lerp(s.h, 0.02, bar); s.cav = lerp(s.cav, 0.7, bar) }
      }
    }
    f.decal = (x, y, fx) => mOf(x, y, wrapM(y, H), fx) * vfade(x, W)
    f.meta = { rail: { x: rx, y: ry, foot } }
    return f
  }
  throw new Error(`paintMarble: variant ${variant} has no painter`)
}

// the core of a stoop whose marble step was taken: brick-and-stone rubble in a dark mortar, or a poured-concrete replacement
function* paintMarbleCore(ctx) {
  const W = ctx.w_m, H = ctx.h_m, o = ctx.opts, sC = ctx.sub('core')
  const core = o.core ?? (hashF(0, 0, sC) < 0.55 ? 'rubble' : 'concrete')
  if (core === 'rubble') {
    // angular fragments at two sizes (10–14 cm pieces of brick, stone and old mortar, and 4–5 cm rubble between them) in a dark matrix
    const matrix = ctx.col(MASONRY.rubble), brick = ctx.col([124, 78, 64]), stone = ctx.col([112, 108, 100]), lump = ctx.col([132, 124, 110]), bed = ctx.col([146, 138, 122])
    const big = ctx.voronoi('rubble', { feature: 0.16, search: 1 }), small = ctx.voronoi('rubble-s', { feature: 0.045, search: 1 })
    const sR = ctx.sub('rubble'), sS = ctx.sub('rubble-s')
    const tex = ctx.fbm('rubble-tex', { feature: 0.015, octaves: 3 }), grain = ctx.noise('rubble-grain', { feature: 0.004 })
    const smear = ctx.fbm('rubble-bed', { feature: 0.3, octaves: 4 }), dust = ctx.fbm('rubble-dust', { feature: 0.4, octaves: 3 })
    const thrS = (yield* fieldQ((x, y) => smear(x, y), W, H)).q(0.85)
    const V = {}, V2 = {}
    const kindCol = (t) => (t < 0.36 ? brick : t < 0.72 ? stone : lump)
    yield* ctx.raster((s) => {
      const x = s.x, y = s.y, fx = s.fx
      big(x, y, V)
      const id = V.id, d1 = V.edge - lerp(0.008, 0.018, hashF(id, 1, sR)), cov1 = hashF(id, 0, sR) < 0.38 ? covSd(d1, fx) : 0
      small(x, y, V2)
      const id2 = V2.id, d2 = V2.edge - lerp(0.004, 0.009, hashF(id2, 1, sS)), cov2 = (hashF(id2, 0, sS) < 0.22 ? covSd(d2, fx) : 0) * (1 - cov1)
      const c1 = kindCol(hashF(id, 3, sR)), c2 = kindCol(hashF(id2, 3, sS))
      // each piece is a rough broken face: a tilted plane (a random lean, and its top catching more sky), its rim falling away
      const t1 = 1 + 0.12 * (hashF(id, 6, sR) - 0.5) * 2 * Math.max(-1, Math.min(1, -V.dx / 0.08)) - 0.08 * Math.max(-1, Math.min(1, -V.dy / 0.08))
      const t2 = 1 + 0.12 * (hashF(id2, 6, sS) - 0.5) * 2 * Math.max(-1, Math.min(1, -V2.dx / 0.025)) - 0.08 * Math.max(-1, Math.min(1, -V2.dy / 0.025))
      const k1 = (0.82 + 0.28 * hashF(id, 4, sR)) * t1 * (1 - 0.3 * (1 - sstep(0, 0.03, d1))) * (1 + 0.07 * tex(x + 0.5, y, fx))
      const k2 = (0.78 + 0.3 * hashF(id2, 4, sS)) * t2 * (1 - 0.3 * (1 - sstep(0, 0.012, d2))) * (1 + 0.07 * tex(x, y + 0.5, fx))
      const cm = 1 - cov1 - cov2
      const km = (1 + 0.12 * tex(x, y, fx)) * (1 + 0.05 * (2 * grain(x, y, fx) - 1) * bandK(0.004, fx))
      s.r = matrix[0] * km * cm + c1[0] * k1 * cov1 + c2[0] * k2 * cov2; s.g = matrix[1] * km * cm + c1[1] * k1 * cov1 + c2[1] * k2 * cov2; s.b = matrix[2] * km * cm + c1[2] * k1 * cov1 + c2[2] * k2 * cov2
      const d = cov1 > cov2 ? d1 : d2, cov = cov1 + cov2, ao = 1 - 0.3 * (1 - sstep(0, 0.012, d))
      s.cav = 0.45 * cm + (0.75 + 0.25 * ao) * cov; s.h = -0.012 * cm + 0.01 * cov * sstep(0, 0.02, d)
      const sm = sstep(thrS - 0.03, thrS + 0.03, smear(x, y, fx))
      if (sm > 0) { mixS(s, sc3(bed, 1 + 0.05 * tex(x, y, fx)), 0.8 * sm); s.cav = lerp(s.cav, 0.9, sm); s.h = lerp(s.h, 0, sm) }
      // years of dirt over all of it, so the pieces sink into one dark brown mass
      mixS(s, matrix, 0.3 + 0.15 * c01(0.5 + dust(x, y, fx)))
    })
    return { variant: 'missingCore', core }
  }
  if (core !== 'concrete') throw new Error(`paintMarble missingCore: unknown core '${core}'`)
  const paste = ctx.col(MASONRY.concrete), aggr = ctx.col([118, 114, 106])
  const rough = ctx.fbm('conc-rough', { feature: 0.08, octaves: 4 }), grain = ctx.noise('conc-grain', { feature: 0.004 })
  const bug = ctx.voronoi('conc-bug', { feature: 0.02, search: 1 }), sB = ctx.sub('conc-bug')
  const woodg = ctx.fbm('conc-wood', { featureX: 0.4, featureY: 0.01, octaves: 2 }), stain = ctx.fbm('conc-stain', { feature: 0.35, octaves: 3 })
  const nB = Math.max(1, Math.round(H / 0.15)), sBd = ctx.sub('conc-boards'), V = {}
  yield* ctx.raster((s) => {
    const x = s.x, y = s.y, fx = s.fx, yw = wrapM(y, H)
    const bi = Math.floor((yw / H) * nB), by = (yw / H) * nB - bi, dB = Math.min(by, 1 - by) * (H / nB)
    let k = (1 + 0.05 * rough(x, y, fx)) * (1 + 0.04 * (2 * grain(x, y, fx) - 1) * bandK(0.004, fx)) * (1 + 0.03 * (hashF(bi, 0, sBd) - 0.5) * 2)
    k *= 1 + 0.02 * woodg(x, y, fx)
    k *= 1 - 0.1 * sstep(0.1, 0.5, stain(x, y, fx))
    setS(s, paste, k)
    const fin = covLine(dB, 0.0015, fx)
    if (fin > 0) { mixS(s, aggr, 0.4 * fin); s.cav = 1 - 0.3 * fin }
    bug(x, y, V)
    if (hashF(V.id, 0, sB) < 0.18) { const bc = covSd(lerp(0.0015, 0.0035, hashF(V.id, 1, sB)) - V.f1, fx); if (bc > 0) { mulS(s, 1 - 0.3 * bc); s.cav -= 0.4 * bc; s.h -= 0.003 * bc } }
  })
  return { variant: 'missingCore', core }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §7 paintCmu: the concrete block that seals doors and windows, set behind the kept frames.
//  Unstruck mortar squeezed out of the joints, face pits, white efflorescence at the foot.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export const paintCmu = makeRecipe({ name: 'paintCmu', stock: 'C', periodic: true, *paint(ctx) {
  const W = ctx.w_m, H = ctx.h_m, o = ctx.opts
  const infill = !!o.infill || o.periodic === false
  const cutHalves = o.cutHalves ?? true
  const L = layoutCmu(W, H, ctx.sub('layout'), { periodic: !infill }), I = indexUnits(L)
  const ageT = o.age === 'new' ? 0 : o.age === 'aged' || o.age == null ? 1 : c01(o.age)
  const face = lerp3(ctx.col(MASONRY.cmuNew), ctx.col(MASONRY.cmuAged), ageT)
  const mortar = lerp3(ctx.col([170, 168, 160]), ctx.col([150, 148, 141]), ageT)               // crude grey infill mortar, barely paler
  const effOn = o.efflorescence ?? infill
  const aggr = ctx.noise('aggr', { feature: 0.004 }), grit = ctx.voronoi('grit', { feature: 0.008, search: 1 }), sGr = ctx.sub('grit')
  const mott = ctx.fbm('mott', { feature: 0.08, octaves: 3 }), pitV = ctx.voronoi('pits', { feature: 0.012, search: 1 }), sP = ctx.sub('pits')
  const sq = ctx.fbm('squeeze', { feature: 0.06, octaves: 3 }), lumpN = ctx.fbm('mortar-lump', { feature: 0.012, octaves: 2 })
  const cutN = ctx.fbm('cut', { feature: 0.02, octaves: 3 }), sDr = ctx.sub('drops'), dropN = ctx.fbm('drops', { feature: 0.03, octaves: 2 })
  const WX = makeWallWeather(ctx, 'wall', { big: 0.03, dark: 0.07 * ageT + 0.02, light: 0.02 })
  const eff = effOn ? makeEfflorescence(ctx.sub('effl'), { w: W, h: H, height: 0.30, density: 0.55, foot: H, feature: 0.1 }) : null
  const effHaze = ctx.fbm('effl-haze', { feature: 0.15, octaves: 3 })
  const effC = tcol(ctx, MASONRY.efflorescence, 0.5), grime = tcol(ctx, [60, 60, 56], 0.3)
  const FT = o.foot ? makeFoot(ctx, 'foot', W, H) : null
  const pitShare = (yield* fieldQ((x, y) => { const V = {}; pitV(x, y, V); return hashF(V.id, 0, sP) < 0.42 && V.f1 < lerp(0.0014, 0.0034, hashF(V.id, 1, sP)) ? 1 : 0 }, W, H, 160)).mean
  const V = {}, G = {}, st = { pit: 0, sqv: 0, lump: 0, gr: 0, ag: 0, mt: 0, x: 0, y: 0, fx: 0, H: null }
  const unit = (k, C) => {
    const H0 = st.H, u = L.units[H0.unit[k]], fx = st.fx
    const len = u.x1 - u.x0, hgt = u.y1 - u.y0, lx = H0.lx[k], ly = H0.ly[k]
    let v = (1 + (u.rnd[0] - 0.5) * 0.12) * (1 + 0.025 * st.mt) * (1 + 0.05 * st.ag) * (1 + 0.04 * st.gr)
    const hue = (u.rnd[2] - 0.5) * 0.03
    let r = face[0] * (1 + hue) * v, g = face[1] * v, b = face[2] * (1 - hue) * v
    // the face pits are shallow (about -8% value, cavity >= 0.88): only the joints and squeeze-out read in the
    // cavity channel, or the infill reads as speckled terrazzo wherever the cavity is weighted in
    let cav = 1 - 0.12 * st.pit, h = -0.003 * st.pit
    r *= 1 - 0.08 * st.pit; g *= 1 - 0.08 * st.pit; b *= 1 - 0.08 * st.pit
    // a cut end at a jamb: broken with a hammer, its edge ragged, the gap packed with mortar
    let ed = H0.ed[k]
    if (infill && cutHalves && u.cut) {
      const atL = u.cell[0] <= 1e-9, atR = u.cell[2] >= W - 1e-9
      const dc = atL ? lx : atR ? len - lx : Infinity
      if (dc < 0.03) ed = Math.min(ed, dc - 0.008 * (0.5 + 0.5 * cutN(st.x, st.y, fx)) - 0.002)
    }
    // unstruck mortar squeezed out over the block edges in places (about half the joint length has no bead), sagging onto the top edge
    // of the block below its bed joint
    const top = ly < Math.min(len - lx, lx, hgt - ly)
    const sw = (0.0015 + 0.009 * sstep(0.35, 0.8, st.sqv)) * (top ? 1.8 : 1)
    const blob = covSd(sw - ed, fx)
    // droppings: thin smears of mortar run down a block face under its top joint
    let drop = 0
    if (top || ly < 0.06) {
      const dh = hashF(u.id, 0, sDr)
      if (dh < 0.45) {
        const cxp = lerp(0.15, 0.85, hashF(u.id, 1, sDr)) * len, wdt = lerp(0.015, 0.045, hashF(u.id, 2, sDr)), dl = lerp(0.015, 0.05, hashF(u.id, 3, sDr))
        const sdd = Math.min(wdt - Math.abs(lx - cxp) + 0.008 * dropN(st.x, st.y, fx), dl - ly)
        drop = covSd(sdd, fx) * 0.6 * (1 - 0.6 * ageT)
      }
    }
    const shade = covLine(ed - sw - 0.0025, 0.0025, fx) * (top ? 1 : 0.35)
    const mk = (1 + 0.08 * st.lump) * (top ? 1.03 : 1)                                     // the top of a sagging blob catches the sky
    r = r * (1 - shade * 0.30); g = g * (1 - shade * 0.30); b = b * (1 - shade * 0.30)
    const mb = Math.max(blob, drop)
    C[0] = lerp(r, mortar[0] * mk, mb); C[1] = lerp(g, mortar[1] * mk, mb); C[2] = lerp(b, mortar[2] * mk, mb)
    C[3] = lerp(cav * (1 - 0.35 * shade), 0.85, blob); C[4] = lerp(h, 0.004 * (0.5 + 0.5 * st.sqv), blob)
  }
  const joint = (C) => {
    // the recessed joint in its own shadow: the module reads from 3-6 m
    const mk = (1 + 0.07 * st.lump) * (1 + 0.04 * st.ag) * 0.84
    C[0] = mortar[0] * mk; C[1] = mortar[1] * mk; C[2] = mortar[2] * mk; C[3] = 0.78 + 0.1 * st.lump; C[4] = 0.002
  }
  // the dry weathering every sample gets (both rasters below): the wall's weather, the efflorescence, the foot
  const finishCmu = (s, x, y, fx) => {
    mulS(s, WX(x, y, fx))
    if (eff) {
      // powdery salt over the bottom 30 cm: a soft haze rising out of the joints, a crust in blotches at the very foot
      const z = H - wrapM(y, H), inJ = s.cav > 0.7 && s.cav < 0.9 && s.h > 0.001 ? 1 : 0
      const e = c01(0.7 * eff(x, y, fx) + (0.18 + 0.25 * inJ) * sstep(0.32, 0.04, z) * c01(0.5 + 1.2 * effHaze(x, y, fx)))
      if (e > 0) { mixS(s, effC, 0.72 * e); s.cav = lerp(s.cav, 0.95, 0.5 * e) }
      if (ageT > 0 && z < 0.12) mixS(s, grime, 0.2 * ageT * (1 - z / 0.12))
    }
    if (FT) FT(s, x, y, fx)
  }
  // opts.snap (an infill only; the game's texel look): at 32 texels a metre the 0.95 cm joints are a third of a
  // texel and area sampling washes them out (the fill read as a mottled slab), so the units are laid on whole texels instead. The
  // 40.6 × 20.3 cm module is 13 × 6.5 texels: blocks 13 texels long, courses 7 and 6 texels tall in turn from the foot, half bond about
  // the opening's centre line, 1-texel joints in their shadow at 0.72 of the block's value. A piece cut at a jamb stays (one under 3
  // texels is the mortar packing), as do a cut course at the head, the pits, the weather, the efflorescence and the foot.
  if (o.snap && infill) {
    const TW = ctx.R.w, TH = ctx.R.h, MOD = 13, mid = TW >> 1, sB = ctx.sub('snap-blocks')
    let courses = 0
    yield* ctx.raster((s) => {
      const x = s.x, y = s.y, fx = s.fx, tx = s.tx, rb = TH - 1 - s.ty                  // rb: the texel row up from the foot
      const p = Math.floor(rb / MOD), r13 = rb - p * MOD, k = 2 * p + (r13 < 7 ? 0 : 1), hk = r13 < 7 ? 7 : 6, rk = r13 < 7 ? r13 : r13 - 7
      const b0 = p * MOD + (r13 < 7 ? 0 : 7), cut = b0 + hk > TH, visH = TH - b0
      if (k + 1 > courses) courses = k + 1
      const ox = mid - ((k & 1) ? 6 : 0), j = Math.floor((tx - ox) / MOD), a = ox + j * MOD     // a = this block's head-joint column
      const v0 = Math.max(0, a + 1), v1 = Math.min(TW, a + MOD)                                // the block's face columns
      pitV(x, y, V)
      st.pit = hashF(V.id, 0, sP) < 0.42 ? covSd(lerp(0.0014, 0.0034, hashF(V.id, 1, sP)) - V.f1, fx) : 0
      grit(x, y, G)
      st.gr = (hashF(G.id, 0, sGr) * 2 - 1) * bandK(0.008, fx)
      st.ag = (2 * aggr(x, y, fx) - 1) * bandK(0.004, fx)
      st.mt = mott(x, y, fx); st.lump = lumpN(x, y, fx)
      const packed = (cut && visH <= 3) || v1 - v0 < 3
      const isJoint = !packed && (rk === hk - 1 || tx === a)
      if (packed || isJoint) {
        const mk = (1 + 0.07 * st.lump) * (1 + 0.04 * st.ag)
        if (packed) { s.r = mortar[0] * mk * 0.9; s.g = mortar[1] * mk * 0.9; s.b = mortar[2] * mk * 0.9; s.cav = 0.85; s.h = 0.002 }
        else { const kj = 0.72 * mk; s.r = face[0] * kj; s.g = face[1] * kj; s.b = face[2] * kj; s.cav = 0.78 + 0.1 * st.lump; s.h = -0.002 }
      } else {
        const r0 = hashF(k, j, sB), r2 = hashF(k, j + 7919, sB)
        const v = (1 + (r0 - 0.5) * 0.12) * (1 + 0.025 * st.mt) * (1 + 0.05 * st.ag) * (1 + 0.04 * st.gr) * (1 - 0.08 * st.pit)
        const hue = (r2 - 0.5) * 0.03
        s.r = face[0] * (1 + hue) * v; s.g = face[1] * v; s.b = face[2] * (1 - hue) * v
        // the block's top row in the shadow of the bed joint over it, its foot row a touch lit
        if (rk === hk - 2) mulS(s, 0.95)
        else if (rk === 0) mulS(s, 1.03)
        s.cav = 1 - 0.12 * st.pit; s.h = -0.003 * st.pit
      }
      finishCmu(s, x, y, fx)
    })
    return { infill, age: ageT, efflorescence: !!effOn, pitShare, courses, snap: true }
  }
  yield* ctx.raster((s) => {
    const x = s.x, y = s.y, fx = s.fx
    st.x = x; st.y = y; st.fx = fx; st.H = s.hits[0]
    pitV(x, y, V)
    st.pit = hashF(V.id, 0, sP) < 0.42 ? covSd(lerp(0.0014, 0.0034, hashF(V.id, 1, sP)) - V.f1, fx) : 0
    grit(x, y, G)
    st.gr = (hashF(G.id, 0, sGr) * 2 - 1) * bandK(0.008, fx)
    st.ag = (2 * aggr(x, y, fx) - 1) * bandK(0.004, fx)
    st.mt = mott(x, y, fx); st.sqv = c01(0.5 + 1.4 * sq(x, y, fx)); st.lump = lumpN(x, y, fx)
    blendHits(s, st.H, unit, joint)
    mulS(s, WX(x, y, fx))
    if (eff) {
      // powdery salt over the bottom 30 cm: a soft haze rising out of the joints, a crust in blotches at the very foot
      const z = H - wrapM(y, H), inJ = s.cav > 0.7 && s.cav < 0.9 && s.h > 0.001 ? 1 : 0
      const e = c01(0.7 * eff(x, y, fx) + (0.18 + 0.25 * inJ) * sstep(0.32, 0.04, z) * c01(0.5 + 1.2 * effHaze(x, y, fx)))
      if (e > 0) { mixS(s, effC, 0.72 * e); s.cav = lerp(s.cav, 0.95, 0.5 * e) }
      if (ageT > 0 && z < 0.12) mixS(s, grime, 0.2 * ageT * (1 - z / 0.12))
    }
    if (FT) FT(s, x, y, fx)
  }, { layers: [I] })
  return { infill, age: ageT, efflorescence: !!effOn, pitShare, courses: L.module.courses }
} })

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §8 paintParge / paintPartyWall: an exposed party wall finished with grey
//  cement parge over soft, absorbent brick; where the parge has fallen the brick shows. The ghost of the lost neighbour stays on it.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// the ghost geometry of a lost neighbour on a party wall w × h (metres). z is the height above the foot; y = h − z (down from the top).
export function partyWallGhost(w, h, seed, o = {}) {
  const r = (i) => hashF(i, 0, seed >>> 0)
  const floorsZ = o.floors ?? [0.76, 3.96]
  const falls = o.falls ?? (r(1) < 0.5 ? 'left' : 'right')
  const slope = o.slope ?? lerp(0.04, 0.09, r(2))
  const zFront = o.roofZ ?? Math.min(h - 0.25, 6.6 + 0.4 * r(3))
  const zRear = zFront - slope * w
  const roofZ = (x) => (falls === 'right' ? zFront - slope * x : zRear + slope * x)
  const roof = { zFront, zRear, falls, slope, y: (x) => h - roofZ(x) }
  const floors = floorsZ.filter((z) => z < Math.min(zFront, h)).map((z) => ({ z, y: h - z }))
  const fxc = lerp(0.3, 0.7, r(4)) * w, fw = lerp(0.36, 0.5, r(5))
  const flue = { x0: fxc - fw / 2, x1: fxc + fw / 2, zTop: zFront + 0.5, zBottom: floorsZ[0] ?? 0 }
  const part = r(6) < 0.5 ? lerp(0.38, 0.62, r(7)) * w : null
  const rooms = []
  const levels = [...floors.map((f) => f.z), Math.min(zRear, zFront)]
  for (let i = 0; i + 1 < levels.length; i++) {
    const z0 = levels[i] + 0.1, z1 = levels[i + 1] - 0.08
    if (z1 - z0 < 0.6) continue
    const spans = part == null ? [[0.04, w - 0.04]] : [[0.04, part - 0.06], [part + 0.06, w - 0.04]]
    spans.forEach(([a, b], j) => { if (b - a > 0.3) rooms.push({ x0: a, x1: b, z0, z1, y0: h - z1, y1: h - z0, colour: pick(ROOM_PAINTS, r(10 + i * 4 + j)), base: z0 + 0.12 }) })
  }
  const stair = floors.length >= 2 ? { x0: r(8) < 0.5 ? 0.15 : w - 0.15, z0: floors[0].z, x1: r(8) < 0.5 ? Math.min(w - 0.2, 0.15 + 2.4) : Math.max(0.2, w - 2.55), z1: floors[1].z } : null
  if (stair) { stair.y0 = h - stair.z0; stair.y1 = h - stair.z1 }
  return { w, h, roof, floors, pockets: { spacing: 0.406, w: 0.06, h: 0.24, offset: lerp(0.05, 0.4, r(9)) }, flue, partition: part, rooms, stair }
}

function* paintPargeImpl(ctx) {
  const W = ctx.w_m, H = ctx.h_m, o = ctx.opts, sG = ctx.sub('ghost')
  const ghost = o.ghost ? (o.ghost === true ? partyWallGhost(W, H, sG, o.ghostOpts ?? {}) : o.ghost) : null
  const fallen = c01(o.fallen ?? lerp(0.06, 0.16, hashF(0, 0, ctx.sub('fallen'))))
  const L = layoutBrick(W, H, ctx.sub('layout'), { bond: 'common' })
  const P = commonBrickParams(ctx, { colA: ctx.col([180, 119, 92]), colB: ctx.col([160, 100, 76]), tone: 0.13, erosion: 0.004, chip: 0.85,
    pitKeep: 0.12, salmon: 0.08, clinker: 0.02, deepK: 0.2 })
  if (due()) yield
  const BS = makeBrickShade(ctx, L, P, 'brick')
  if (due()) yield
  const pg = ctx.col(MASONRY.parge), PS = makePargeSurface(ctx, 'parge')
  // map cracks: Voronoi cell edges, warped so they wander, and only part of each edge open
  const cracks = ctx.voronoi('map-crack', { feature: 0.35, search: 1 }), sC = ctx.sub('map-crack')
  const cWarp = ctx.warp('map-crack-w', { feature: 0.12, octaves: 3, amp: 0.03 }), cGate = ctx.fbm('map-crack-g', { feature: 0.15, octaves: 2 }), Wc = {}
  const WX = makeWallWeather(ctx, 'wall', { big: 0.03, dark: 0.08, light: 0.03 })
  const bias = o.foot || ghost ? (x, y) => 0.6 * (1 - sstep(0, 0.9, H - wrapM(y, H))) : null
  // the fallen patches are a property of the surface, not a variant: they may cross the tile edges (the field wraps), so the base
  // tile shows no patch-free stripe at its seams
  const M = (yield* makeBlobMask(ctx, 'fallen', W, H, fallen, { feature: 0.38, warp: 0.07, octaves: 5, bias, edges: false }))
  const rimC = ctx.col([164, 161, 154]), key = ctx.fbm('key', { feature: 0.05, octaves: 3 })
  const FT = o.foot || ghost ? makeFoot(ctx, 'foot', W, H) : null
  // opts.ghostK: the strength of the ghost marks (1: the recipe's; the game draws them stronger, so they read against the parge)
  if (due()) yield
  const GH = ghost ? makeGhostMarks(ctx, ghost, W, H, o.ghostK ?? 1) : null
  if (due()) yield
  const out = {}, V = {}
  yield* ctx.raster((s) => {
    const x = s.x, y = s.y, fx = s.fx, xw = wrapM(x, W), yw = wrapM(y, H)
    const kw = WX(x, y, fx)
    // the parge: trowelled grey cement, its map cracks dirt-lined, rain-washed
    let kp = PS(x, y, fx) * kw
    cWarp(x, y, Wc, fx)
    cracks(Wc.x, Wc.y, V)
    const live = hashF(Math.min(V.id, V.id2), Math.max(V.id, V.id2), sC) < 0.5 ? sstep(-0.12, 0.12, cGate(x, y, fx)) : 0
    const crk = live * covLine(V.edge, 0.0007, fx), halo = live * Math.exp(-V.edge / 0.005)
    kp *= (1 - 0.45 * crk) * (1 - 0.05 * halo)
    let pr = pg[0] * kp, pgg = pg[1] * kp, pb = pg[2] * kp
    // where the parge has fallen: the soft brick, cement left in its joints and keyed into its pits; a shade line under the torn edge
    const sd = M.sd(x, y)
    let above = 0
    if (GH) { GH.prep(x, y, fx); above = GH.above(xw, yw, fx) }                     // above the old roof line: never parged
    const fall = Math.max(covSd(sd, fx), above)
    if (GH) { const t = [pr, pgg, pb]; GH.marks(t, xw, yw, x, y, fx, true); pr = t[0]; pgg = t[1]; pb = t[2] }
    if (fall > 0) {
      // the brick is shaded only where it shows (lerp(a, b, 0) is a exactly: the same bytes, at about a third of the cost on a parged wall)
      BS.shade(s, s.hits[0], out)
      const br = out.r * kw, bg = out.g * kw, bb = out.b * kw
      // where the parge fell, a haze of cement stays on the brick faces too (not on the brick above the old roof, never parged)
      const keyed = c01(0.55 * out.joint + 0.3 * sstep(0.2, 0.5, key(x, y, fx)) + 0.12) * (1 - above)
      let er = lerp(br, pg[0] * 0.9 * kp, keyed), eg = lerp(bg, pg[1] * 0.9 * kp, keyed), eb = lerp(bb, pg[2] * 0.9 * kp, keyed)
      const ao = 1 - 0.22 * (1 - sstep(0, 0.015, sd)) * (1 - above)
      er *= ao; eg *= ao; eb *= ao
      if (GH) { const e = [er, eg, eb]; GH.marks(e, xw, yw, x, y, fx, false); er = e[0]; eg = e[1]; eb = e[2] }
      s.r = lerp(pr, er, fall); s.g = lerp(pgg, eg, fall); s.b = lerp(pb, eb, fall)
      s.cav = lerp(0.97 - 0.4 * crk, out.cav * ao, fall); s.h = lerp(0.012, out.h, fall)
    } else { s.r = pr; s.g = pgg; s.b = pb; s.cav = 0.97 - 0.4 * crk; s.h = 0.012 }
    const rim = covLine(sd + 0.005, 0.004, fx) * (1 - above)
    if (rim > 0) { mixS(s, rimC, 0.35 * rim); s.cav = lerp(s.cav, 0.95, rim) }
    if (GH) GH.post(s, xw, yw, x, y, fx)
    if (FT) FT(s, x, y, fx)
  }, { layers: [BS.I] })
  return { fallen, ghost: ghost ? { roof: { zFront: ghost.roof.zFront, zRear: ghost.roof.zRear, falls: ghost.roof.falls }, floors: ghost.floors, flue: ghost.flue, rooms: ghost.rooms.length, stair: !!ghost.stair } : null }
}

// the ghost marks: faint shapes in metres, tinting the parge (and, for the soot and the tar, the brick too)
function makeGhostMarks(ctx, G, W, H, K = 1) {
  const edge = ctx.fbm('ghost-edge', { feature: 0.08, octaves: 3 }), blot = ctx.fbm('ghost-blot', { feature: 0.25, octaves: 4 })
  const drips = ctx.fbm('ghost-drip', { featureX: 0.03, featureY: 0.15, octaves: 2 }), dripLen = ctx.fbm('ghost-drip-len', { featureX: 0.05, featureY: 0.5, octaves: 2 })
  const soot = tcol(ctx, [58, 48, 42], 0.3), tar = tcol(ctx, [40, 38, 36], 0.2), plaster = ctx.col([158, 154, 146])
  const rooms = G.rooms.map((rm) => ({ ...rm, c: ctx.col(rm.colour) }))
  const sootOld = tcol(ctx, [46, 42, 40], 0.25)
  const N = { e: 0, b: 0, e2: 0, b2: 0 }                                    // this sample's noise, evaluated once (prep)
  return {
    prep(x, y, fx) { N.e = edge(x, y, fx); N.b = blot(x, y, fx); N.e2 = edge(x + 0.3, y, fx); N.b2 = blot(x + 0.7, y, fx) },
    // 1 above the old roof line (the wall was always outside there, bare brick), 0 below; ragged by a few cm
    above(xw, yw, fx) { return covSd(G.roof.y(xw) - 0.02 * N.e - yw, fx) },
    marks(c, xw, yw, x, y, fx, onParge) {
      const fade = (k) => { c[0] *= k; c[1] *= k; c[2] *= k }
      const mix = (col, t) => { if (t > 0) { c[0] += (col[0] - c[0]) * t; c[1] += (col[1] - c[1]) * t; c[2] += (col[2] - c[2]) * t } }
      if (onParge) {
        // faded room paint, blotchy, soft-edged; a baseboard line in each room
        for (const rm of rooms) {
          const sd = Math.min(xw - rm.x0, rm.x1 - xw, yw - rm.y0, rm.y1 - yw) + 0.03 * N.e
          if (sd < -0.04) continue
          const t = sstep(-0.04, 0.05, sd) * (0.05 + 0.06 * c01(0.5 + N.b)) * K         // parged over: the old colour barely shows
          mix(rm.c, t)
          const bl = covLine(yw - (H - rm.base), 0.012, fx) * sstep(-0.02, 0.02, sd)
          if (bl > 0) fade(1 - 0.05 * K * bl)
        }
        // the floor lines and the joist pockets under them (parged over: slightly sunk and darker)
        for (const f of G.floors) {
          const fl = covLine(yw - f.y, 0.018, fx)
          if (fl > 0) fade(1 - 0.06 * K * fl)
          const pk = G.pockets, dyp = yw - f.y - pk.h / 2 - 0.02
          if (Math.abs(dyp) < pk.h / 2 + 0.02) {
            const px = wrapD(xw - pk.offset, pk.spacing)
            const sdp = Math.min(pk.w / 2 - Math.abs(px), pk.h / 2 - Math.abs(dyp))
            const t = covSd(sdp + 0.004, 0.01)
            if (t > 0) { fade(1 - 0.08 * K * t); mix(plaster, 0.06 * K * t) }
          }
        }
        // the stair: a faint diagonal stringer line between the first two floors
        if (G.stair) {
          const S = G.stair, ex = S.x1 - S.x0, ey = S.y1 - S.y0, l2 = ex * ex + ey * ey
          const t = c01(((xw - S.x0) * ex + (yw - S.y0) * ey) / l2), d = hyp(S.x0 + ex * t - xw, S.y0 + ey * t - yw)
          if (d < 0.14) fade(1 - 0.05 * K * sstep(0.14, 0.04, d))
        }
      }
      // the flue: soot bled through the wall from the lost chimney, a faint vertical band, fanning out to 0.7 m over the metre above
      // each floor line (where a hearth stood)
      const F = G.flue
      const yTop = H - F.zTop, yBot = H - F.zBottom
      if (yw > yTop - 0.1 && yw < yBot + 0.1) {
        const fc = (F.x0 + F.x1) / 2, hw0 = (F.x1 - F.x0) / 2
        let hw = hw0
        for (const fl of G.floors) { const u = fl.y - yw; if (u >= 0 && u < 1.0) hw = Math.max(hw, lerp(0.35, hw0, sstep(0, 1.0, u))) }
        const sd = hw - Math.abs(xw - fc) + 0.04 * N.e2
        const t = sstep(-0.03, 0.08, sd) * sstep(yTop - 0.1, yTop + 0.25, yw) * sstep(yBot + 0.1, yBot - 0.3, yw)
        if (t > 0) mix(onParge ? soot : sootOld, t * (onParge ? Math.min(0.35, 0.18 * K) : 0.4) * (0.55 + 0.45 * c01(0.5 + N.b2)))   // (a strong K: the flue at most 0.35)
      }
    },
    // the tar flashing line along the old roof slope, its drips below; soot on the old exterior brick above
    post(s, xw, yw, x, y, fx) {
      const ry = G.roof.y(xw), d = yw - (ry - 0.035)
      const band = covLine(d + 0.01 * N.e, 0.026, fx)
      if (band > 0) { mixS(s, tar, 0.72 * band); s.cav = lerp(s.cav, 0.9, band) }
      // tar drips below the flashing: sparse, each its own length (5–40 cm), not a comb fringe
      if (d > 0.02 && d < 0.42) {
        const len = 0.05 + 0.35 * c01(0.5 + 1.4 * dripLen(x, 0, fx))
        if (d < len) { const m = (1 - d / len) * sstep(0.25, 0.6, drips(x, y, fx)); mixS(s, tar, 0.45 * m) }
      }
      if (yw < ry) { const up = c01((ry - yw) / 1.2); mixS(s, sootOld, 0.16 * up * c01(0.5 + N.b)) }
    },
  }
}

export const paintParge = makeRecipe({ name: 'paintParge', stock: 'B', periodic: true, paint: paintPargeImpl })
export const paintPartyWall = Object.assign(
  (w_m, h_m, tpm, seed, matHex, opts = {}) => paintParge(w_m, h_m, tpm, seed, matHex, { ghost: true, foot: true, ...opts }),
  { recipeName: 'paintPartyWall', stock: 'B', periodic: false,
    steps: (w_m, h_m, tpm, seed, matHex, opts = {}) => paintParge.steps(w_m, h_m, tpm, seed, matHex, { ghost: true, foot: true, ...opts }) })

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §9 Index
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §9 paintArchBand (rear openings sit under segmental or jack arches of common brick): the brick heads over
//  the rear windows and doors, as their own pieces mapped along the band (u = along it, v = across it from its top), so they read as
//  bricks on edge or on end and never as a strip of the running-bond wall.
//   kind 'rowlock': one ring of headers on edge, ARCH_BAND.unit (6.7 cm) along the arc, the band's height across (a segmental arch);
//                   render it longer than the longest band (map u = arc length / the rendered length: no stretch).
//   kind 'jack':    stretchers on end splayed from one centre below the opening, a keystone in the middle, in the box of a
//                   trapezoid (the top width w_m, the bottom width w_m - 2 x ARCH_BAND.splay over the height h_m).
//  Both: common-brick colours per unit (+-12% value, warm / cool), eroded arrises, recessed lime joints in their shadow, and a darker
//  bed joint along both long edges where the band meets the wall.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export const ARCH_BAND = Object.freeze({ unit: 0.067, joint: 0.008, bed: 0.006, splay: 0.06 })
export const paintArchBand = makeRecipe({ name: 'paintArchBand', stock: 'B', periodic: false, *paint(ctx) {
  const W = ctx.w_m, H = ctx.h_m, o = ctx.opts, kind = o.kind ?? 'rowlock', sU = ctx.sub('units')
  if (kind !== 'rowlock' && kind !== 'jack') throw new Error(`paintArchBand: bad kind ${kind}`)
  const cA = ctx.col(MASONRY.commonA), cB = ctx.col(MASONRY.commonB), mortar = ctx.col(MASONRY.mortar)
  const face = ctx.fbm('face', { feature: 0.02, octaves: 3 }), dirt = ctx.fbm('dirt', { feature: 0.12, octaves: 2 })
  const AB = ARCH_BAND
  // jack: the splay's centre below the band (the skewbacks' lines meet there)
  const bot = W - 2 * AB.splay, dC = (bot / 2) * (H / AB.splay), cx = W / 2, cy = H + dC
  const alpha = Math.atan2(W / 2, cy), nJ = Math.max(5, 2 * Math.round((W / AB.unit - 1) / 2) + 1), dA = (2 * alpha) / nJ
  let units = 0
  yield* ctx.raster((s) => {
    const x = s.x, y = s.y, fx = s.fx
    let id, dj
    if (kind === 'rowlock') {
      const t = x / AB.unit
      id = Math.floor(t); dj = Math.min(t - id, id + 1 - t) * AB.unit
    } else {
      const th = Math.atan2(x - cx, cy - y), rr = hyp(x - cx, cy - y), t = (th + alpha) / dA
      id = Math.floor(t); dj = Math.min(t - id, id + 1 - t) * dA * rr
    }
    const hU = hashF(id, 0, sU), hV = hashF(id, 1, sU), hW = hashF(id, 2, sU)
    const base = lerp3(cA, cB, hU), v = (1 + (hV - 0.5) * 0.24) * (1 + 0.04 * face(x, y, fx)) * (1 - 0.05 * c01(0.5 + dirt(x, y, fx)))
    const warm = (hW - 0.5) * 0.06
    let r = base[0] * v * (1 + warm), g = base[1] * v, b = base[2] * v * (1 - warm)
    // eroded arrises next to a joint, the joint recessed in its own shadow
    const near = covLine(dj - AB.joint * 0.5 - 0.004, 0.004, fx)
    r *= 1 - 0.08 * near; g *= 1 - 0.08 * near; b *= 1 - 0.08 * near
    const jt = covSd(AB.joint * 0.5 - dj, fx)
    const mk = 0.80 * (1 + 0.04 * face(x + 0.31, y, fx))
    r = lerp(r, mortar[0] * mk, jt); g = lerp(g, mortar[1] * mk, jt); b = lerp(b, mortar[2] * mk, jt)
    // the bed joints along both long edges, darker: the band reads against the wall
    const de = Math.min(y, H - y), bed = covSd(AB.bed - de, fx)
    r = lerp(r, mortar[0] * 0.62, bed); g = lerp(g, mortar[1] * 0.62, bed); b = lerp(b, mortar[2] * 0.62, bed)
    s.r = r; s.g = g; s.b = b
    s.cav = 1 - 0.30 * jt - 0.35 * bed - 0.06 * near
    s.h = -0.004 * Math.max(jt, bed)
    if (id + 1 > units) units = id + 1
  })
  return { kind, unit: AB.unit, units: kind === 'rowlock' ? Math.ceil(W / AB.unit) : nJ, centreBelow: kind === 'jack' ? dC : null }
} })

export const MASONRY_RECIPES = Object.freeze({ paintPressedBrick, paintCommonBrick, paintPaintedBrick, paintFormstone, paintMarble, paintCmu, paintParge, paintPartyWall, paintArchBand })
export const MASONRY_VARIANTS = Object.freeze({ paintCommonBrick: COMMON_BRICK_VARIANTS, paintFormstone: FORMSTONE_VARIANTS, paintMarble: MARBLE_VARIANTS })

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  PART III — THE SURFACE PAINTERS: the crew mark and the invented placard, plywood, painted wood (trim, sash, doors, cornices), the
//  vent panel, asphalt, concrete, granite curbs, the park ground and the window interiors, with their decay. Built ON part I (and part
//  II's shared helpers TAU, tcol, mixS, mulS, setS).
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//
// Pure and seeded, in the style of gfx-textures.js: no DOM, no Math.random, no image reads, no imports, no state that
// outlives a call. Every pixel comes from code and seeds. No digit, letter, symbol or word is ever painted: the crew mark is re-rolled
// until it clears the core's glyph test (§11), and the placard is a plain off-white sheet with one black band.
//
// Conventions are the core's (its header): metres, y DOWN from the top edge, tpm = texels per metre (32 in the game, 128 fine), a recipe is
// (w_m, h_m, tpm, seed, matHex, opts) → Raster { w, h, rgb, cav, height, meta, ... }. Every shader below is a pure function of the
// sub-sample position, its footprint (s.fx, s.fy) and the layer hits, so with ss 'auto' a 32 tpm render IS the 128 tpm render
// box-downsampled; detail finer than two 128 tpm texels (aggregate, grain lines, crystals) is box-filtered or faded to its mean.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  API
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  Recipes (all take the core recipe signature; opts.ss, opts.origin and opts.wrap are honoured as in the core)
//   paintPlywood    stock 'P', not periodic. The board w × h (opening + overlap) from layoutPlywood. opts: age (0..1 → the fresh→grey mix
//                   0.3..0.9 | [lo, hi]: the layout's own range for the mix, [a, a] = exactly a; default the layout's draw in 0.3..0.9),
//                   mark (true | false | default the layout's ~½ draw), markSeed, opening, orient. The mark weathers with the
//                   board (its orange pulled toward the wood by 0.15 + 0.35·mix), has a 2 cm overspray and a mottled density; no
//                   veneer patch lies under it (its box grown by 3 cm and down by its runs), and its grain-through reads the wood
//                   without the patches' glue lines. R.patchLine = the glue lines on the texel grid, each at least a texel wide (the
//                   glyph test can read it under the mark). meta: { layout (its patches as painted), mix, mark (crewMark result
//                   | null), markAt, markBox, patchesMoved }
//   crewMark(seed)  the sprayed crew mark: 4–6 orange blocks in a loose zigzag over two rows (1–3 alternations, never a strict 4+ that
//                   reads as a W, an M or a chequer; each block 15–35% of its height off its row), overspray, runs. Re-rolled until it
//                   passes the glyph test (full,
//                   mirrored, and each half alone) at CREW_MARK.minDistance = 7 cells, one more than the glyph test's 6; no seed of 0..3999
//                   needs more than two re-rolls. → { seed, attempt, n, blocks: [{ id, row, x0, y0, x1, y1, poly }],
//                   runs: [{ x, y, len, w }], w, h, soft, colour, bits, glyph, halves } (metres, relative to the mark centre)
//   crewMarkMask(mark, res) → { values, w, h, x0, y0, res }   the block layout rasterised (the glyph test's input)
//   paintPlacard    own stock #E4E0D2, not periodic, matHex IGNORED (absolute colours: never red). Portrait off-white sheet, one black band
//                   at 40% of its height, four corner nails, weathering. Call with PLACARD.w × PLACARD.h (20 × 28 cm).
//   paintPaintedWood  own stock #E2DED3 (matHex tints every paint by its drift from it), periodic in x and y. opts: paint ('white' |
//                   'blackgreen' | 'brown' | hex), under (the older coat), peel (0..1, the share of bare grey wood), age (0..1 alligatoring;
//                   default from peel), grain ('x' | 'y'). meta: { paint, under, peel, age }
//   paintVentPanel  own stock #E2DED3, not periodic. A 0.61 × 0.25 m jigsaw-cut frieze panel: opts.motif 'sunflower' | 'fan' | 'wing'
//                   (default seeded), plus the painted-wood opts. Returns R.alpha (Float32Array w·h: 1 = wood, 0 = cut through); the RGB in
//                   a cut is the dark attic behind. meta: { motif, cutShare }
//   paintAsphalt    stock 'floor', periodic. opts: ox (0..1 oxidation; default seeded 0.35..0.85), cracks (0..1), seal (0..1 share of
//                   tar-sealed cracks; default 0.05: nobody seals an abandoned court), patches (count; default seeded 0..2). Open
//                   cracks are dirt-filled #322E28, weedy where wide.
//   paintConcrete   stock 'C', periodic unless opts.vertical. opts: joints (metres, default 1.0; 0 none), broom ('x' | 'y' | 'none'),
//                   stain (0..1), spall (0..1), rust (count), vertical (rust runs downward; risers)
//   paintGranite    stock 'floor', periodic. opts: face ('top' | 'face': tool marks), dirt (0..1)
//   paintYard       stock 'floor', periodic. opts: cover ('grass' | 'thin' (default) | 'dirt': YARD_COVER_WEAR 0.10 / 0.55 / 0.95),
//                   variant ('base' | 'gravel' | 'tanbark' | 'litter' | 'glass' | 'damp'), wear (0..1, the share of bare dirt; default
//                   the cover's), desire ({ dir: 'x' | 'y' | 'd1' | 'd2', offset, width } | null). No feature over ~10 cm repeats: the
//                   large grass / dirt split is paintYardWearMask's, blended by the ground material. The grass thins out into the
//                   dirt blade by blade (a ramp of the field dithered by the 6 mm blade stipple at 128 tpm), never an island with an
//                   outline. Variant decoration fades out over the EDGE band, so every variant seams with the base of its cover and
//                   with each other. R.decal = the broadleaf rosettes (for the glyph test). meta: { variant, cover, wear, desire }.
//                   opts.overlay (with a variant): the variant ALONE as a coverage overlay, for the ground material to lay over
//                   whatever cover is there per pixel (never a tile rendered over one cover, which shows as a square of that cover in a
//                   cell of another): RGB = the variant's colours painted over neutral grey 128 (premultiplied over it), A (the cav
//                   channel) = its coverage, no relief. Lay it as Ground·(1 − A) + (RGB − 128·(1 − A)), exact under box filtering
//                   and mips; 'damp' is a multiply instead: RGB 128, A = the wetness, Ground·lerp(1, 0.78, A)
//   paintYardWearMask  stock 'floor', not periodic, no height. The whole park ground's wear (grey 0 grass .. 255 dirt) over YARD_MAP's
//                   48 × 36 m: a slow field of thin and thick grass, desire lines from the spawn past the note to the exit round both
//                   juts with their corners cut, an apron at the foot of each jut's stoop, the grass hanging on at the wall feet (the
//                   jut walls too). Bake at 8 texels/m (384 × 288). meta: { map, route, stoops }
//   paintYardCoverRank  stock 'floor', periodic, no height. R = the rank (0..1 quantile) of paintYard's grass field at each point, G =
//                   the blade stipple, B = 0: the ground material's grass at wear w is where R > w (a threshold, dithered by G at its
//                   edge), so the covers never ghost through each other as a lerp of tiles would. Same seed as the yard tiles.
//   yardStoops(map = YARD_MAP) → [{ x, y, front }]   the door-bay stoops of the two juts (metres: the stoop's centre x, its foot y and
//                   the jut's front face y), by planBlockFacade's door rule and the MarbleStoop dimensions
//   paintWindowInterior  not periodic. opts.mode 'lit' (stock 'O') | 'dark' (stock 'O') | 'void' (stock 'W');
//                   lit / dark: variant ('base' | 'blinds' | 'sheer' | 'sage'), shade (0.4..0.7 of the height pulled down; default seeded),
//                   sash ('none' default: no sash or frame painted | '1/1': paint them, two lites, for the
//                   game's tile | '2/2': four panes, the legacy tile's look),
//                   sheen (false default: none; true paints glassSheen in). Every value is <= BLOOM_CAP.
//                   void: rail (one hanging sash rail), no glass, the room's grey level held in VOID_RANGE (7–25/255).
//                   meta: { mode, variant, shade, lamp, ... }
//   paintShade      = paintWindowInterior with mode 'lit' (the name of the O art)
//  Fidelity: with ss 'auto' (the default) every painter's 32 tpm render IS its 128 tpm render box-downsampled. With ss 1 (16× cheaper)
//  the mean difference stays under 8/255 except where the detail is finer than a 32 tpm texel and high in contrast: painted
//  wood with heavy peel (flakes ~2 cm across the grain, ~26/255 at peel 0.3), granite (5–10 mm crystals) and the vent panel's cut-outs
//  (~13–15). Render those with ss 'auto' (or at least 2).
//  Helpers
//   glassSheen(R, { amount = GLASS_SHEEN, sky = SKY_HEX, streak = true }) → R   in place: rgb → rgb + (sky − rgb)·k, k averaging `amount`
//   sheenColour(rgb, amount = GLASS_SHEEN, sky = SKY_HEX) → [r, g, b]          the same for one colour (for a material to mirror)
//   decalGlyphTest(values, w, h, { on = 0.3, minPx = 8, lineRatio = 0.15, aspect = 0.4, min = 6 }) → { pass, distance, nearest, ... }
//                   the glyph test for stroke decals (R.decal of the painters, cut-out masks), one connected decal at a time (§1)
//   decalNodeTest(values, w, h, { on = 0.3, tpm = 128, armMin = 0.08, radius = 0.01 }) → { pass, nodes, failed, maxArms, worst }
//                   the node test for stroke decals: fails where three strokes longer than armMin meet within radius (§1)
//   BLOOM_CAP = 216 (⌊0.85 × 255⌋), SKY_HEX '#B9B7AE', GLASS_SHEEN 0.08, PLACARD, VENT_PANEL, PAINTS, BARE_WOOD, CREW_MARK, YARD_VARIANTS,
//   WINDOW_VARIANTS, WINDOW_MODES, WINDOW_SASH, VOID_RANGE, SURFACE_RECIPES (name → recipe)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export const BLOOM_CAP = 216                     // display values never pass 0.85 × 255, so the bloom threshold 0.9 is never reached
export const SKY_HEX = '#B9B7AE'                 // levels.js '∅' sky
export const GLASS_SHEEN = 0.08                  // the glass sheen: 8% of the sky colour

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §0 Small helpers (file-local)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// band limiting: detail of cell size `cell` keeps full weight from two footprints up and fades to nothing at one
const fadeW = (cell, fx) => (fx > 0 ? sstep(1, 2, cell / fx) : 1)
// exact 1-D box filter: the share of a footprint of width f, centred at signed distance d from a line, covered by the band |d| <= hw
function box1(d, hw, f) {
  if (!(f > 0)) return Math.abs(d) <= hw ? 1 : 0
  const a = Math.max(d - f / 2, -hw), b = Math.min(d + f / 2, hw)
  return b > a ? (b - a) / f : 0
}
// the box-filtered inside share of a signed-distance shape (sd > 0 inside) over a footprint f
const sdCov = (sd, f) => (f > 0 ? c01(0.5 + sd / f) : sd > 0 ? 1 : 0)
// a soft threshold of field P at t, anti-aliased by P's change dP over one footprint
const softT = (P, t, dP) => { const e = Math.max(1e-5, 0.5 * dP); return sstep(t - e, t + e, P) }
// the tempered colour rule: target × (1 + k·(mat/stock − 1)) per channel; k = 1 is the plain rule, k = 0 an absolute colour (an accent)

// the distribution of a field over a fixed n × n grid of the tile (resolution-independent, so thresholds match at every tpm)
function* fieldStats(fn, w, h, n = 64) {
  const v = new Float64Array(n * n)
  let sum = 0
  if (due()) yield
  for (let j = 0; j < n; j++) { sum = fieldRow(fn, v, j, n, w, h, sum); if (due()) yield }      // (a generator, §3b, as fieldQ)
  v.sort()
  // rank(f): the share of the samples below f (0..1, linear between neighbours): 1 - rank is a peel ORDER (a peel mask)
  const rank = (f) => {
    let lo = 0, hi = n * n
    while (lo < hi) { const m = (lo + hi) >> 1; if (v[m] < f) lo = m + 1; else hi = m }
    if (lo <= 0) return 0
    if (lo >= n * n) return 1
    const a = v[lo - 1], b = v[lo]
    return (lo - 1 + (b > a ? (f - a) / (b - a) : 0.5) + 0.5) / (n * n)
  }
  return { mean: sum / (n * n), q: (p) => v[Math.min(n * n - 1, Math.max(0, Math.floor(p * n * n)))], rank }
}
// the sub-sample footprint (metres) ctx.raster will use: the tile over (texels × sub-samples per texel); what rasterize passes as s.fx
const sampleFootprint = (ctx) => ctx.w_m / (ctx.R.w * (ctx.ss == null || ctx.ss === 'auto' ? autoSS(ctx.tpm) : Math.max(1, ctx.ss | 0)))

const capS = (s) => { if (s.r > BLOOM_CAP) s.r = BLOOM_CAP; if (s.g > BLOOM_CAP) s.g = BLOOM_CAP; if (s.b > BLOOM_CAP) s.b = BLOOM_CAP }
const lumS = (s) => s.r * 0.299 + s.g * 0.587 + s.b * 0.114
// stones / chips from a Voronoi field: a stone is its cell shrunk by `gap` and cut to a disc of radius r (rounded, never overlapping).
// → out { cov (box-filtered), id, d }; keep = the share of cells that hold a stone
function makeStones(vor, seed, o) {
  const V = {}, gap = o.gap ?? 0.001, r0 = o.rMin, r1 = o.rMax
  return (x, y, fx, keep, out) => {
    vor(x, y, V)
    out.id = V.id
    if (hashF(V.id, 0, seed) >= keep) { out.cov = 0; out.d = -1; return out }
    const r = lerp(r0, r1, hashF(V.id, 1, seed)), d = Math.min(V.edge - gap, r - V.f1)
    out.d = d; out.cov = sdCov(d, fx)
    return out
  }
}
// signed distance (+ inside) to a lens ("vesica") of half-length a, half-width b, centred at the origin along +x
function sdLens(px, py, a, b) {
  const R = (a * a + b * b) / (2 * b), c = R - b
  return Math.min(R - hyp(px, py - c), R - hyp(px, py + c), a - Math.abs(px))
}
// signed distance (+ inside) to a capsule from (ax, ay) to (bx, by), radius r
function sdCapsule(px, py, ax, ay, bx, by, r) {
  const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey
  const t = l2 > 0 ? c01(((px - ax) * ex + (py - ay) * ey) / l2) : 0
  return r - hyp(px - ax - ex * t, py - ay - ey * t)
}
const rot = (x, y, a) => { const c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c] }
// the EDGE-band fade for variant decoration on a periodic tile (wrapped, so it stays periodic)
const variantFade = (x, y, W, H) => edgeFade(wrapM(x, W), W) * edgeFade(wrapM(y, H), H)
// box-filtered runs (rust, paint, water) hanging below sources: a soft bloom at the source and a narrowing, fading trail. Unlike the core's
// point-sampled makeRustRuns, the cross-section is the exact 1-D box filter of the run over the footprint, so a run narrower than a texel
// shows at its true (diluted) strength at any tpm. sources: [{ x, y, len, w (full width), a (strength 0..1), wob (metres) }]
function makeRunsAA(sources, seed) {
  const R = sources.map((q, k) => ({ ...q, ph: hashF(k, 1, seed) * TAU, wl: lerp(0.05, 0.12, hashF(k, 2, seed)), x0: q.x - q.w - 0.01, x1: q.x + q.w + 0.01 }))
  return (x, y, fx) => {
    let keep = 1
    for (const r of R) {
      if (x < r.x0 - fx || x > r.x1 + fx) continue
      const dy = y - r.y
      if (dy < -r.w || dy > r.len + r.w) continue
      const dx = x - r.x - (r.wob ?? 0.002) * Math.sin((TAU * dy) / r.wl + r.ph)
      let k = 0.85 * r.a * sdCov(0.55 * r.w - hyp(dx, dy), fx)
      const t = dy / r.len
      if (t >= 0 && t < 1) k = Math.max(k, r.a * Math.pow(1 - t, 0.8) * box1(dx, 0.5 * r.w * (1 - 0.5 * t), fx))
      keep *= 1 - c01(k)
    }
    return 1 - keep
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §1 The crew mark (the legacy plywood tile's PLY_NUM mark in gfx-textures.js, generalised)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The legacy mark is four 6 × 8-texel orange blocks in a 4 × 2 checker (a zigzag) in a 72 × 48 cm box of the 2 m tile. Here: 4–6 blocks
// of sprayed orange in a loose zigzag over two rows, each a little rotated, sized and placed by hand; soft spray edges, overspray, runs.
// minDistance: the glyph test's limit for a mark AND for each of its halves, one cell stricter than the glyph test's 6, so that no reading
// of "within 6 cells" can let a mark through
export const CREW_MARK = Object.freeze({ blocks: Object.freeze([4, 6]), width: Object.freeze([0.50, 0.70]), height: Object.freeze([0.34, 0.48]),
  colour: Object.freeze([240, 138, 40]), soft: 0.007, attempts: 64, res: 0.004, minDistance: GLYPH_MIN_DISTANCE + 1 })

export function crewMarkMask(mark, res = CREW_MARK.res) { return drain(crewMarkMaskSteps(mark, res)) }
// (crewMarkMask as a stepped job, §3b: it pauses between rows of its grid)
function* crewMarkMaskSteps(mark, res = CREW_MARK.res) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const b of mark.blocks) { x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1) }
  const w = Math.max(1, Math.ceil((x1 - x0) / res)), h = Math.max(1, Math.ceil((y1 - y0) / res)), values = new Float32Array(w * h)
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = x0 + (i + 0.5) * res, y = y0 + (j + 0.5) * res
      for (const b of mark.blocks) if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && polyDist(b.poly, x, y) > 0) { values[j * w + i] = 1; break }
    }
    if (due()) yield
  }
  return { values, w, h, x0, y0, res }
}
function* markBitsSteps(blocks) { const m = yield* crewMarkMaskSteps({ blocks }); return fitMaskTo5x7(m.values, m.w, m.h) }

function crewLayout(seed, attempt) {
  const s = subSeed(seed >>> 0, 'crew-' + attempt), r = (k) => hashF(k, 0x51, s)
  const n = CREW_MARK.blocks[0] + Math.floor(r(0) * (CREW_MARK.blocks[1] - CREW_MARK.blocks[0] + 1))
  const W = lerp(CREW_MARK.width[0], CREW_MARK.width[1], r(1)) + 0.025 * (n - 4), H = lerp(CREW_MARK.height[0], CREW_MARK.height[1], r(2))
  const px = W / n, py = H / 2, bw = px * lerp(0.94, 1.10, r(3)), bh = py * lerp(0.92, 1.08, r(4))
  const start = r(5) < 0.5 ? 0 : 1, shear = (r(6) - 0.5) * 0.14, turn = (r(7) - 0.5) * 0.06
  // the rows: a loose zigzag, not a strict up-down alternation (4 or more alternations in a row read as a W, an M or a chequered flag);
  // two neighbours may share a row and touch. Each block sits 15–35% of a block height off its row line.
  const rows = [start]
  for (let i = 1; i < n; i++) rows.push(hashF(i, 9, s) < 0.62 ? 1 - rows[i - 1] : rows[i - 1])
  let alt = 0
  for (let i = 1; i < n; i++) if (rows[i] !== rows[i - 1]) alt++
  if (alt >= 4 || alt === 0) return null
  const blocks = []
  for (let i = 0; i < n; i++) {
    const row = rows[i], jit = (hashF(i, 2, s) < 0.5 ? -1 : 1) * lerp(0.15, 0.35, hashF(i, 10, s)) * bh
    const cx = -W / 2 + (i + 0.5) * px + (hashF(i, 1, s) - 0.5) * 0.028, cy = -H / 2 + (row + 0.5) * py + jit
    const hw = (bw * lerp(0.90, 1.06, hashF(i, 3, s))) / 2, hh = (bh * lerp(0.88, 1.06, hashF(i, 4, s))) / 2
    const a = turn + (hashF(i, 5, s) - 0.5) * 0.09
    const poly = []
    for (const [qx, qy] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
      const [rx, ry] = rot(qx, qy, a)
      const yy = cy + ry
      poly.push(cx + rx + shear * yy, yy)
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let k = 0; k < 8; k += 2) { x0 = Math.min(x0, poly[k]); x1 = Math.max(x1, poly[k]); y0 = Math.min(y0, poly[k + 1]); y1 = Math.max(y1, poly[k + 1]) }
    blocks.push({ id: i, row, x0, y0, x1, y1, poly })
  }
  // runs: a bead of paint slides down from the bottom edge of about half the blocks (the bottom edge runs from corner 3 to corner 2)
  const runs = []
  for (const b of blocks) {
    const nr = hashF(b.id, 6, s) < 0.55 ? (hashF(b.id, 7, s) < 0.3 ? 2 : 1) : 0
    for (let q = 0; q < nr; q++) {
      const t = lerp(0.15, 0.85, hashF(b.id * 4 + q, 8, s)), P = b.poly
      runs.push({ x: lerp(P[6], P[4], t), y: lerp(P[7], P[5], t) - 0.004, len: lerp(0.03, 0.15, hashF(b.id * 4 + q, 9, s)),
        w: lerp(0.006, 0.011, hashF(b.id * 4 + q, 10, s)) })
    }
  }
  return { n, blocks, runs, W, H }
}

export function crewMark(seed) { return drain(crewMarkSteps(seed)) }
// (crewMark as a stepped job, §3b: it pauses between attempts)
function* crewMarkSteps(seed) {
  const sd = seed >>> 0
  for (let attempt = 0; attempt <= CREW_MARK.attempts; attempt++) {
    if (attempt > 0 && due()) yield
    let L
    if (attempt < CREW_MARK.attempts) { L = crewLayout(sd, attempt); if (!L) continue }
    else {                                                                              // never reached in practice: the legacy checker
      const blocks = [0, 1, 2, 3].map((i) => {
        const x0 = -0.36 + i * 0.1875, y0 = i & 1 ? 0 : -0.24, x1 = x0 + 0.1875, y1 = y0 + 0.24
        return { id: i, row: i & 1, x0, y0, x1, y1, poly: [x0, y0, x1, y0, x1, y1, x0, y1] }
      })
      L = { n: 4, blocks, runs: [], W: 0.72, H: 0.48 }
    }
    if (due()) yield
    const min = CREW_MARK.minDistance, bits = yield* markBitsSteps(L.blocks)
    if (due()) yield
    const glyph = glyphTest(bits, { min })
    if (!glyph.pass) continue
    if (due()) yield
    const half = Math.ceil(L.n / 2), halves = []
    for (const b of [L.blocks.slice(0, half), L.blocks.slice(half)]) { const hb = yield* markBitsSteps(b); halves.push(glyphTest(hb, { min })); if (due()) yield }
    if (!halves.every((h) => h.pass)) continue
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const b of L.blocks) { x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1) }
    return { seed: sd, attempt, n: L.n, blocks: L.blocks, runs: L.runs, w: x1 - x0, h: y1 - y0, bbox: [x0, y0, x1, y1], soft: CREW_MARK.soft,
      colour: [...CREW_MARK.colour], bits: Array.from(bits), glyph, halves }
  }
  throw new Error('crewMark: no mark passed the glyph test')               // unreachable: the legacy fallback passes at distance 13
}

// The glyph test for DECALS (the glyph test's rule applied to strokes: cracks, rust runs, soot streaks, weed rosettes, cut-outs). values: w × h
// coverage 0..1. The mask (values >= on) is split into 8-connected components; each component at least minPx texels across is fitted to
// 5 × 7 cells over its own bbox, STROKE-AWARE: a cell is on when the component covers at least half of what one stroke crossing it
// would (threshold 0.5·min(1, sw / cell), sw = the component's mean stroke width 2·area / perimeter), so thin line art is read the way a
// font draws it, not lost in a mostly empty cell. A component whose texels lie along one line (principal axes, minor / major spread
// < lineRatio 0.15) or whose bbox is more than 1 / aspect (2.5) times as long as it is wide is a single stroke (a lone crack, a drip
// with its bloom, a streak hanging from the wall top) and is counted, not tested: a bare stroke is not a letter (every 5 × 7 letter is
// 5:7, and any narrow stroke stretched to 5 × 7 lands within a few cells of 'I', '1' or 'T'). Components under minPx texels (8: 6 cm
// at 128 tpm, 25 cm at 32) are too small to carry 5 × 7 detail. min: 6 cells. → { pass, distance, nearest, mirrored,
// tested, strokes, small, worst }
export function decalGlyphTest(values, w, h, o = {}) {
  const on = o.on ?? 0.3, minPx = o.minPx ?? 8, lineRatio = o.lineRatio ?? 0.15, aspect = o.aspect ?? 0.4, min = o.min ?? GLYPH_MIN_DISTANCE
  const lab = new Int32Array(w * h).fill(-1), stack = []
  const res = { pass: true, distance: Infinity, nearest: null, mirrored: false, tested: 0, strokes: 0, small: 0, worst: null }
  let nComp = 0
  for (let i0 = 0; i0 < w * h; i0++) {
    if (lab[i0] >= 0 || !(values[i0] >= on)) continue
    const id = nComp++, pix = []
    lab[i0] = id; stack.push(i0)
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w
      pix.push(i)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy
        if ((dx || dy) && xx >= 0 && yy >= 0 && xx < w && yy < h) { const j = yy * w + xx; if (lab[j] < 0 && values[j] >= on) { lab[j] = id; stack.push(j) } }
      }
    }
    let x0 = w, y0 = h, x1 = -1, y1 = -1, mx = 0, my = 0, per = 0
    for (const i of pix) {
      const x = i % w, y = (i - x) / w
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); mx += x; my += y
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h || lab[yy * w + xx] !== id) per++ }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1
    if (Math.max(bw, bh) < minPx) { res.small++; continue }
    mx /= pix.length; my /= pix.length
    let sxx = 0, syy = 0, sxy = 0
    for (const i of pix) { const x = (i % w) - mx, y = Math.floor(i / w) - my; sxx += x * x; syy += y * y; sxy += x * y }
    const tr = (sxx + syy) / pix.length, det = (sxx * syy - sxy * sxy) / (pix.length * pix.length), disc = Math.sqrt(Math.max(0, tr * tr / 4 - det))
    const lMax = tr / 2 + disc, lMin = Math.max(0, tr / 2 - disc)
    if (Math.sqrt(lMin / Math.max(1e-9, lMax)) < lineRatio || Math.min(bw, bh) < aspect * Math.max(bw, bh)) { res.strokes++; continue }
    // the stroke-aware 5 × 7 fit over the component's bbox (exact area resampling of its texels into the cells)
    const cw = bw / 5, ch = bh / 7, cov = new Float64Array(35), sw = (2 * pix.length) / Math.max(1, per)
    for (const i of pix) {
      const px = (i % w) - x0, py = Math.floor(i / w) - y0
      for (let r = Math.floor(py / ch); r <= Math.min(6, Math.floor((py + 1) / ch)); r++) {
        const oy = Math.min(py + 1, (r + 1) * ch) - Math.max(py, r * ch)
        if (oy <= 0) continue
        for (let c = Math.floor(px / cw); c <= Math.min(4, Math.floor((px + 1) / cw)); c++) {
          const ox = Math.min(px + 1, (c + 1) * cw) - Math.max(px, c * cw)
          if (ox > 0) cov[r * 5 + c] += ox * oy
        }
      }
    }
    const thr = 0.5 * Math.min(1, sw / Math.min(cw, ch)), bits = new Uint8Array(35)
    for (let k = 0; k < 35; k++) bits[k] = cov[k] / (cw * ch) >= thr ? 1 : 0
    const g = glyphTest(bits, { min })
    res.tested++
    if (g.distance < res.distance) { res.distance = g.distance; res.nearest = g.nearest; res.mirrored = g.mirrored; res.worst = { bbox: [x0, y0, x1, y1], bits: Array.from(bits).join('') } }
    if (!g.pass) res.pass = false
  }
  if (res.distance === Infinity) res.distance = null
  return res
}

// The NODE test for stroke decals: three strokes longer than armMin (0.08 m) meeting within `radius` (0.01 m) draw a y, a λ, a Y or a
// K whatever their angles, and the 5 × 7 fit of decalGlyphTest cannot see a node. values: w × h coverage 0..1 on a grid of tpm texels per
// metre (use it at 128 tpm: at 32 an 8 cm arm is two or three texels). The mask (values >= on) is thinned to a one-texel skeleton
// (Zhang–Suen); every skeleton texel with three or more skeleton neighbours is a candidate node, and candidates within the node radius
// (at least 2 texels) are one node. Round a node a disc of that radius is cut from the skeleton; each piece of skeleton that touches the
// disc is an arm, as long as its farthest texel from the node along the skeleton. An arm counts when it is at least armMin long and at
// least 2.5 of the mask's half-widths at the node (so the medial-axis corners of a wide streak or bloom are not strokes). A node with
// three or more counted arms fails. → { pass, nodes, failed, maxArms, worst: { at: [x, y] metres, arms } | null }
export function decalNodeTest(values, w, h, o = {}) {
  const on = o.on ?? 0.3, tpm = o.tpm ?? 128, armMin = (o.armMin ?? 0.08) * tpm, Rc = Math.max(2, (o.radius ?? 0.01) * tpm)
  const m = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) m[i] = values[i] >= on ? 1 : 0
  // Zhang–Suen thinning (outside the grid is background)
  const sk = m.slice(), at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : sk[y * w + x])
  const NB = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]                 // P2..P9 clockwise from north
  for (let changed = true; changed;) {
    changed = false
    for (const pass of [0, 1]) {
      const del = []
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (!sk[y * w + x]) continue
        const p = NB.map(([dx, dy]) => at(x + dx, y + dy)), B = p.reduce((a, v) => a + v, 0)
        if (B < 2 || B > 6) continue
        let A = 0
        for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) A++
        if (A !== 1) continue
        if (pass === 0 ? p[0] * p[2] * p[4] === 0 && p[2] * p[4] * p[6] === 0 : p[0] * p[2] * p[6] === 0 && p[0] * p[4] * p[6] === 0) del.push(y * w + x)
      }
      for (const i of del) sk[i] = 0
      if (del.length) changed = true
    }
  }
  const nbrs = (i) => { const x = i % w, y = (i - x) / w, out = []; for (const [dx, dy] of NB) if (at(x + dx, y + dy)) out.push((y + dy) * w + x + dx); return out }
  // the mask's half-width at a texel: its distance to the nearest background texel (searched out to 64 texels)
  const halfWidth = (cx, cy) => {
    let best = 64
    for (let r = 1; r <= 64 && r < best; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
      const x = cx + dx, y = cy + dy
      if (x < 0 || y < 0 || x >= w || y >= h || !m[y * w + x]) best = Math.min(best, Math.hypot(dx, dy))
    }
    return best
  }
  const cand = []
  for (let i = 0; i < w * h; i++) if (sk[i] && nbrs(i).length >= 3) cand.push(i)
  const used = new Uint8Array(cand.length), res = { pass: true, nodes: 0, failed: 0, maxArms: 0, worst: null }
  for (let c = 0; c < cand.length; c++) {
    if (used[c]) continue
    const cx = cand[c] % w, cy = Math.floor(cand[c] / w)
    for (let d = c; d < cand.length; d++) if (!used[d] && Math.hypot((cand[d] % w) - cx, Math.floor(cand[d] / w) - cy) <= Rc) used[d] = 1
    res.nodes++
    const need = Math.max(armMin, 2.5 * halfWidth(cx, cy))
    // the arms: skeleton pieces outside the disc, seeded by the skeleton texels just outside it; a geodesic flood from each seed
    const lab = new Map(), arms = []
    for (let y = Math.max(0, Math.floor(cy - Rc - 2)); y <= Math.min(h - 1, Math.ceil(cy + Rc + 2)); y++) {
      for (let x = Math.max(0, Math.floor(cx - Rc - 2)); x <= Math.min(w - 1, Math.ceil(cx + Rc + 2)); x++) {
        const i = y * w + x, r = Math.hypot(x - cx, y - cy)
        if (!sk[i] || r <= Rc || r > Rc + 1.5 || lab.has(i)) continue
        // a new arm: flood its whole piece of skeleton outside the disc (so no second seed of it starts another arm), the distance
        // along it in steps of 1 or √2 (a FIFO flood is close enough at this scale)
        const id = arms.length, q = [[i, r]]
        let far = r
        lab.set(i, id)
        for (let k = 0; k < q.length; k++) {
          const [j, dj] = q[k]
          for (const n of nbrs(j)) {
            const nx = n % w, ny = (n - nx) / w
            if (lab.has(n) || Math.hypot(nx - cx, ny - cy) <= Rc) continue
            const dn = dj + Math.hypot(nx - (j % w), ny - Math.floor(j / w))
            lab.set(n, id); q.push([n, dn]); if (dn > far) far = dn
          }
        }
        arms.push(far)
      }
    }
    const long = arms.filter((a) => a >= need)
    res.maxArms = Math.max(res.maxArms, long.length)
    if (long.length >= 3) {
      res.pass = false; res.failed++
      if (!res.worst || long.length > res.worst.arms.length) res.worst = { at: [(cx + 0.5) / tpm, (cy + 0.5) / tpm], arms: long.map((a) => +(a / tpm).toFixed(3)) }
    }
  }
  return res
}

// a sampler of the mark placed with its centre at (ax, ay): → out { paint (solid, box-filtered with the spray's soft edge, its density
// mottled by `mot` if given), mist }
function markSampler(mark, ax, ay, mot = null) {
  const B = mark.blocks.map((b) => ({ x0: b.x0 + ax, y0: b.y0 + ay, x1: b.x1 + ax, y1: b.y1 + ay,
    poly: b.poly.map((v, i) => v + (i & 1 ? ay : ax)) }))
  const runs = mark.runs.map((r) => ({ x: r.x + ax, y: r.y + ay, len: r.len, w: r.w }))
  const [bx0, by0, bx1, by1] = [mark.bbox[0] + ax - 0.06, mark.bbox[1] + ay - 0.06, mark.bbox[2] + ax + 0.06, mark.bbox[3] + ay + 0.22]
  return (x, y, fx, out) => {
    out.paint = 0; out.mist = 0
    if (x < bx0 || x > bx1 || y < by0 || y > by1) return out
    let d = -Infinity
    for (const b of B) {
      if (x < b.x0 - 0.05 || x > b.x1 + 0.05 || y < b.y0 - 0.05 || y > b.y1 + 0.05) continue
      const q = polyDist(b.poly, x, y)
      if (q > d) d = q
    }
    let paint = d > -Infinity ? c01(0.5 + d / Math.max(fx, mark.soft, mot ? 0.012 : 0)) : 0         // a can's soft edge, not a cut sticker
    if (paint > 0 && mot) paint *= 1 + 0.20 * (2 * c01(0.5 + 1.5 * mot(x, y, fx)) - 1)            // the can's uneven density
    for (const r of runs) {
      const dx = x - r.x, dy = y - r.y
      if (dx < -0.02 || dx > 0.02 || dy < -0.01 || dy > r.len + 0.02) continue
      const t = dy / r.len
      let k = 0
      if (t >= 0 && t <= 1) k = box1(dx, (r.w / 2) * (1 - 0.35 * t), fx)
      k = Math.max(k, sdCov(r.w * 0.62 - hyp(dx, dy - r.len), fx))
      if (k > paint) paint = k
    }
    out.paint = Math.min(1, paint)
    out.mist = d > -Infinity && d < 0 ? 0.34 * sstep(-0.022, 0, d) : 0                      // the overspray halo: about 2 cm, soft
    return out
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §2 paintPlywood (½ in sheets on 2×4 strongbacks, ⅜ in carriage bolts with washers)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export const paintPlywood = makeRecipe({ name: 'paintPlywood', stock: 'P', periodic: false, *paint(ctx) {
  const W = ctx.w_m, H = ctx.h_m, o = ctx.opts
  const ageRange = Array.isArray(o.age) ? o.age : null
  const L = layoutPlywood(W, H, ctx.sub('layout'), { opening: o.opening, orient: o.orient, ...(ageRange ? { age: ageRange } : {}) })
  const mix0 = o.age != null && !ageRange ? lerp(0.3, 0.9, c01(o.age)) : L.age
  const sheetMix = L.units.map((u) => c01(mix0 + (u.age - L.age)))
  const vert = L.orient === 'vertical'
  const wantMark = o.mark == null ? L.mark.present : !!o.mark
  if (due()) yield
  const mark = wantMark ? yield* crewMarkSteps(o.markSeed ?? ctx.sub('crew')) : null
  const markAt = mark ? [L.mark.x, L.mark.y] : null
  // no veneer patch under the mark: its glue line would show through the thin paint as a ring (an O inside an orange block). The mark's
  // box is grown by 3 cm, and down by its longest run
  const markBox = mark ? [markAt[0] + mark.bbox[0] - 0.03, markAt[1] + mark.bbox[1] - 0.03, markAt[0] + mark.bbox[2] + 0.03,
    markAt[1] + mark.bbox[3] + 0.03 + mark.runs.reduce((m, r) => Math.max(m, r.len), 0)] : null
  const patches = markBox ? L.patches.filter((p) => p.x1 < markBox[0] || p.x0 > markBox[2] || p.y1 < markBox[1] || p.y0 > markBox[3]) : L.patches
  const I = [indexUnits(L), indexUnits(patches, { w: W, h: H }), indexUnits(discUnits(L.bolts, 'washerR', 32), { w: W, h: H }),
    indexUnits(discUnits(L.bolts, 'headR', 24), { w: W, h: H }), indexUnits(discUnits(L.screws, 'r', 12), { w: W, h: H }),
    indexUnits(discUnits(L.screws.map((q) => ({ id: q.id, x: q.x, y: q.y, halo: 0.012 })), 'halo', 16), { w: W, h: H })]
  if (due()) yield
  const markS = mark ? markSampler(mark, markAt[0], markAt[1], ctx.fbm('mark-mottle', { feature: 0.03, octaves: 3 })) : null
  // fields: (along, across) the grain; every sheet reads them at its own offset so neighbouring sheets never continue each other's grain
  const A = (along, across) => (vert ? { featureX: across, featureY: along } : { featureX: along, featureY: across })
  const nA = ctx.fbm('ring-a', { ...A(1.2, 0.20), octaves: 3 }), nB = ctx.fbm('ring-b', { ...A(0.35, 0.06), octaves: 2 })
  const nC = ctx.fbm('cloud', { feature: 0.22, octaves: 3 }), nAge = ctx.fbm('age', { ...A(0.6, 0.18), octaves: 3 })
  const nStreak = ctx.fbm('streaks', { featureX: 0.05, featureY: 0.9, octaves: 3 }), nX = ctx.fbm('cross', { ...A(0.03, 0.4), octaves: 2 }), nW = ctx.fbm('water', { feature: 0.12, octaves: 3 })
  const nWick = ctx.fbm('wick', { featureX: 0.025, featureY: 0.5, octaves: 2 }), nWickG = ctx.fbm('wick-gate', { featureX: 0.06, featureY: 0.5, octaves: 2 })
  const nD = ctx.fbm('delam', { feature: 0.05, octaves: 3 }), nDg = ctx.fbm('delam-tear', { ...A(0.16, 0.018), octaves: 3 }), nR = ctx.fbm('rustbloom', { feature: 0.012, octaves: 2 })
  if (due()) yield
  const splash = ctx.voronoi('splash', { feature: 0.022, search: 1 }), mould = ctx.voronoi('mould', { feature: 0.012, search: 1 })
  if (due()) yield
  const sChk = ctx.sub('checks'), sSpl = ctx.sub('splash')
  const fresh = ctx.col('#C9A979'), grey = ctx.col('#8C857A'), gapC = ctx.col([38, 33, 28])
  const steel = ctx.col([96, 94, 90]), galv = ctx.col([150, 150, 146]), rustC = tcol(ctx, [118, 66, 36], 0.3), paintC = tcol(ctx, CREW_MARK.colour, 0.08)
  // rust runs: from most screws (short, a screw-head wide) and from every bolt (longer, a washer wide); older boards rust further
  const sRs = ctx.sub('rust-s'), sRb = ctx.sub('rust-b')
  const rustS = makeRunsAA(L.screws.filter((q) => q.rnd[0] < 0.40 + 0.5 * mix0).map((q, k) => ({ x: q.x, y: q.y + q.r * 0.5,
    len: lerp(0.03, 0.06 + 0.18 * mix0, hashF(k, 3, sRs)), w: lerp(0.007, 0.011, hashF(k, 4, sRs)), a: (0.35 + 0.4 * mix0) * lerp(0.6, 1, hashF(k, 5, sRs)) })), sRs)
  if (due()) yield
  const rustB = makeRunsAA(L.bolts.map((b, k) => ({ x: b.x + (hashF(k, 6, sRb) - 0.5) * 0.01, y: b.y + b.washerR * 0.6,
    len: lerp(0.10, 0.14 + 0.32 * mix0, hashF(k, 3, sRb)), w: lerp(0.014, 0.022, hashF(k, 4, sRb)), a: 0.45 + 0.4 * mix0, wob: 0.003 })), sRb)
  // rotary-cut figure: the contours of a slow field whose noise term outweighs its trend across the sheet, so the bands run from a
  // couple of cm to tens of cm wide and close into long ovals ("cathedrals") where the field turns. Latewood is the narrow dark part.
  const ringPhase = (x, y, ox, oy) => {
    const across = vert ? x + ox : y + oy
    return (0.07 * across + 0.055 * nA(x + ox, y + oy) + 0.008 * nB(x + ox, y + oy)) / 0.034
  }
  const ring = (x, y, fx, fy, ox, oy) => {
    const p = ringPhase(x, y, ox, oy), dp = Math.abs(ringPhase(x + fx, y, ox, oy) - p) + Math.abs(ringPhase(x, y + fy, ox, oy) - p)
    const f = p - Math.floor(p), late = sstep(0.50, 0.68, f) - sstep(0.76, 0.92, f)
    return lerp(0.22, late, 1 - sstep(0.3, 0.6, dp))                                    // narrower than ~2 footprints: its mean
  }
  // surface checks: short thin splits along the grain (cells 2.2 cm across × 28 cm along)
  const checks = (x, y, fx, fy, m, ox, oy) => {
    const ac = (vert ? x : y) + ox, al = (vert ? y : x) + oy, fa = vert ? fx : fy
    const i = Math.floor(ac / 0.022), u = al + i * 0.131, j = Math.floor(u / 0.28)
    if (hashF(i, j, sChk) >= 0.12 + 0.45 * m) return 0
    const v0 = (i + 0.2 + 0.6 * hashF(i, j, sChk + 1)) * 0.022, t = u / 0.28 - j
    return box1(ac - v0, 0.0011, fa) * sstep(0.05, 0.3, t) * sstep(0.95, 0.7, t)
  }
  const wood = (x, y, fx, fy, si, ed, out, patch) => {
    const u = L.units[si], ox = u.rnd[0] * 3.7 + (patch ? 1.9 : 0), oy = u.rnd[1] * 5.3 + (patch ? 0.7 : 0)
    // greyer where the weather reaches most: the top of the board, the sheet edges (end grain wicks water), water streaks running down
    const st = nStreak(x, y, fx), top = 1 - sstep(0, 0.30, y)
    const m = c01(sheetMix[si] + 0.14 * nAge(x, y, fx) + 0.12 * (1 - sstep(0, 0.07, ed)) + 0.10 * top + 0.10 * Math.max(0, st) - (patch ? 0.05 : 0))
    const late = ring(x, y, fx, fy, ox, oy), cl = nC(x + ox, y + oy, fx)
    const base = mix3(fresh, grey, m)
    // broad soft tonal bands (+-6 %) and only faint latewood lines (never a topographic map)
    const e = 1.01, lm = [lerp(0.95, 0.965, m), lerp(0.935, 0.965, m), lerp(0.91, 0.97, m)]
    const band = 1 + 0.06 * nA(x * 0.7 + ox, y * 0.7 + oy)
    const k = band * (1 + 0.04 * cl) * (patch ? 1.04 : 1) * (1 - 0.05 * Math.max(0, st - 0.1)) * (1 - 0.5 * checks(x, y, fx, fy, m, ox, oy))
    out[0] = base[0] * lerp(e, lm[0], late) * k; out[1] = base[1] * lerp(e, lm[1], late) * k; out[2] = base[2] * lerp(e, lm[2], late) * k
    return m
  }
  if (due()) yield
  const corners = [[0, 0], [W, 0], [0, H], [W, H]], sD = ctx.sub('delam')
  const delam = L.delam.map((on, k) => (on ? { cx: corners[k][0], cy: corners[k][1], rx: lerp(0.09, 0.22, hashF(k, 11, sD)), ry: lerp(0.07, 0.20, hashF(k, 12, sD)) } : null)).filter(Boolean)
  const C3 = [0, 0, 0], P3 = [0, 0, 0], M = {}, SP = {}, MK = {}
  yield* ctx.raster((s) => {
    const x = s.x, y = s.y, fx = s.fx, fy = s.fy, Hs = s.hits[0]
    let mAt = mix0
    blendHits(s, Hs, (k, C) => {
      mAt = wood(x, y, fx, fy, Hs.unit[k], Hs.ed[k], C3, false)
      C[0] = C3[0]; C[1] = C3[1]; C[2] = C3[2]; C[3] = 1 - 0.12 * (1 - sstep(0, 0.006, Hs.ed[k])); C[4] = 0
    }, (C) => { C[0] = gapC[0]; C[1] = gapC[1]; C[2] = gapC[2]; C[3] = 0.25; C[4] = -0.0127 })
    // the wood's own value before the patches: the mark's grain-through reads it, so the paint never carries a glue ring
    const lum0 = lumS(s)
    // oval veneer patches: their own veneer, a faint glue line round them (filled lenses, not outlined rings)
    const Hp = s.hits[1]
    if (Hp.n > 0) {
      const p = patches[Hp.unit[Hp.top]]
      wood(x, y, fx, fy, p.sheet, 1, P3, true)
      s.r = lerp(s.r, P3[0], Hp.sum); s.g = lerp(s.g, P3[1], Hp.sum); s.b = lerp(s.b, P3[2], Hp.sum)
      const line = box1(Hp.ed[Hp.top], 0.0008, fx)
      mulS(s, 1 - 0.22 * line); s.cav -= 0.25 * line
    }
    // delaminated corners: the face veneer gone, the cross-grained core ply showing, a shadow under the lifted edge, torn fibres
    for (const D of delam) {
      // the face veneer tears along the grain: a ragged edge with long fingers along it
      const dd = hyp((x - D.cx) / D.rx, (y - D.cy) / D.ry) + 0.28 * nD(x, y, fx) + 0.45 * nDg(x, y, fx)
      if (dd > 1.25) continue
      const e = fx / Math.min(D.rx, D.ry), inn = sstep(1 + e, 1 - e, dd), deep = sstep(0.48 + e, 0.42 - e, dd)
      const core = mix3(fresh, grey, 0.3 + 0.45 * mAt), xg = 1 + 0.07 * nX(x, y, fx)
      const cc = [core[0] * 0.90 * xg, core[1] * 0.86 * xg, core[2] * 0.80 * xg]
      mixS(s, cc, inn); mulS(s, 1 - 0.22 * deep)
      const shadow = inn * sstep(0.78, 0.97, dd), lip = (1 - inn) * sstep(1.09, 1.0, dd)
      mulS(s, (1 - 0.42 * shadow) * (1 + 0.10 * lip))
      s.cav = Math.min(s.cav, 1 - 0.45 * shadow); s.h += -0.0025 * inn - 0.0025 * deep + 0.0012 * lip
    }
    // the water line at the foot: darker and browner toward the foot, wicked up the grain in narrow streaks (5–15 cm above it), a
    // soft top edge with a faint tide mark, a few mould specks; soil splash above it
    const z = H - y, b = L.waterLine * (1 + 0.3 * nW(x, 0))
    const wick = (0.05 + 0.10 * c01(0.5 + 1.5 * nWick(x, 0, fx))) * sstep(0.05, 0.35, nWickG(x, 0, fx)), top = b + wick
    if (z < top + 0.04) {
      const wet = 1 - sstep(top - 0.03, top + 0.03, z), wetB = 1 - sstep(b - 0.03, b + 0.03, z)
      const kd = wet * (0.16 + 0.10 * wetB + 0.20 * wetB * (1 - c01(z / b)))
      s.r *= 1 - kd; s.g *= 1 - kd * 1.06; s.b *= 1 - kd * 1.12
      mulS(s, 1 - 0.07 * Math.exp(-(((z - b) / 0.012) ** 2)))
      mould(x, y, M)
      if (hashF(M.id, 3, sSpl) < 0.35 * 0.3 * wetB) mulS(s, 1 - 0.45 * sdCov(lerp(0.0012, 0.003, hashF(M.id, 4, sSpl)) - M.f1, fx))
    }
    if (z < 0.42) {
      splash(x, y, SP)
      const dens = 0.35 * (1 - z / 0.42) ** 2
      if (hashF(SP.id, 1, sSpl) < dens) mulS(s, 1 - 0.24 * sdCov(lerp(0.0015, 0.0042, hashF(SP.id, 2, sSpl)) - SP.f1, fx))
    }
    // bolts: galvanised washers (dulled and rusting with age) under domed carriage-bolt heads; perimeter screws, each in a small dimple
    const Hw = s.hits[2], Hh = s.hits[3], Hq = s.hits[4], Hd = s.hits[5]
    if (Hd.sum > 0) { const dim = Hd.sum * sstep(0, 0.006, Hd.ed[Hd.top]); mulS(s, 1 - 0.10 * dim); s.cav -= 0.12 * dim }
    if (Hw.sum > 0) {
      const ring = 1 - sstep(0.0015, 0.004, Hw.ed[Hw.top]), rb = c01(0.25 + 0.6 * mix0 + 0.5 * nR(x, y, fx))
      const c = mix3(mix3(galv, steel, 0.25 + 0.6 * mix0), rustC, 0.45 * rb)
      s.r = lerp(s.r, c[0] * (1 - 0.25 * ring), Hw.sum); s.g = lerp(s.g, c[1] * (1 - 0.25 * ring), Hw.sum); s.b = lerp(s.b, c[2] * (1 - 0.25 * ring), Hw.sum)
      s.h += 0.002 * Hw.sum; s.cav = lerp(s.cav, 1 - 0.3 * ring, Hw.sum)
    }
    if (Hh.sum > 0) {
      const bo = L.bolts[Hh.unit[Hh.top]], dome = c01(1 - (hyp(x - bo.x, y - bo.y) / bo.headR) ** 2), rb = c01(0.35 + 0.7 * mix0 + 0.6 * nR(x + 0.3, y, fx))
      const c = mix3(steel, rustC, 0.6 * rb), v = 0.72 + 0.38 * dome
      s.r = lerp(s.r, c[0] * v, Hh.sum); s.g = lerp(s.g, c[1] * v, Hh.sum); s.b = lerp(s.b, c[2] * v, Hh.sum)
      s.h += (0.004 * Math.sqrt(dome) + 0.002) * Hh.sum; s.cav = lerp(s.cav, 0.8 + 0.2 * dome, Hh.sum)
    }
    if (Hq.sum > 0) {
      const q = L.screws[Hq.unit[Hq.top]], c = mix3(steel, rustC, 0.25 + 0.55 * mix0 * q.rnd[1])
      s.r = lerp(s.r, c[0] * 0.7, Hq.sum); s.g = lerp(s.g, c[1] * 0.7, Hq.sum); s.b = lerp(s.b, c[2] * 0.7, Hq.sum)
      s.h += 0.0006 * Hq.sum; s.cav = lerp(s.cav, 0.7, Hq.sum)
    }
    // the crew mark: sprayed over the board and its fixings; the grain shows through the thin paint; it fades with the board's age
    if (markS) {
      markS(x, y, fx, MK)
      if (MK.paint > 0 || MK.mist > 0) {
        // the paint weathered with the board: chalked and dirtied toward the wood under it, never a fresh orange sticker
        const l = lum0 / lerp(150, 125, mix0), fade = 0.15 + 0.35 * mix0
        const c = [paintC[0] * (0.8 + 0.2 * l), paintC[1] * (0.76 + 0.24 * l), paintC[2] * (0.72 + 0.28 * l)]          // the grain shows through
        const pc = mix3(c, [s.r, s.g, s.b], fade)
        mixS(s, pc, Math.max(MK.paint * 0.94, MK.mist))
      }
    }
    // rust runs last: they formed after the board went up and the mark was sprayed, so they stain both
    const rr = Math.max(rustS(x, y, fx), rustB(x, y, fx))
    if (rr > 0) { mixS(s, rustC, 0.72 * rr); mulS(s, 1 - 0.08 * rr) }
  }, { layers: I })
  // R.patchLine: the patches' glue lines on the texel grid, each drawn at least a texel wide (their presence at this resolution), for
  // a glyph test of the board under the mark
  const tx_ = ctx.R.sx, ty_ = ctx.R.sy, hw = Math.max(0.0008, 0.5 * Math.max(tx_, ty_)), pl = new Float32Array(ctx.R.w * ctx.R.h)
  for (const p of patches) {
    for (let ty = Math.max(0, Math.floor((p.y0 - hw) / ty_)); ty < Math.min(ctx.R.h, Math.ceil((p.y1 + hw) / ty_)); ty++) {
      for (let tx = Math.max(0, Math.floor((p.x0 - hw) / tx_)); tx < Math.min(ctx.R.w, Math.ceil((p.x1 + hw) / tx_)); tx++) {
        if (Math.abs(polyDist(p.poly, (tx + 0.5) * tx_, (ty + 0.5) * ty_)) <= hw) pl[ty * ctx.R.w + tx] = 1
      }
    }
  }
  ctx.R.patchLine = pl
  return { layout: patches === L.patches ? L : { ...L, patches }, mix: mix0, mark, markAt, markBox, patchesMoved: L.patches.length - patches.length }
} })

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §3 paintPlacard: the INVENTED vacancy placard. Portrait off-white, one black band at 40% of its height, four
//  corner nails. Never red, never square, never an X, never reflective, no symbol, no text. Absolute colours: matHex is ignored.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export const PLACARD = Object.freeze({ w: 0.20, h: 0.28, colour: '#E4E0D2', band: 0.40, bandH: 0.15, margin: 0.012, nail: 0.016, nailR: 0.0035 })
export const paintPlacard = makeRecipe({ name: 'paintPlacard', stock: PLACARD.colour, height: true, periodic: false, *paint(ctx) {
  const W = ctx.w_m, H = ctx.h_m, sc = Math.min(W / PLACARD.w, H / PLACARD.h)
  const sheet = hexToRgb(PLACARD.colour), ink = [33, 33, 31], nailC = [74, 72, 68], rustC = [104, 90, 76]
  const bc = PLACARD.band * H, bh = (PLACARD.bandH * H) / 2, mg = PLACARD.margin * sc, ni = PLACARD.nail * sc, nr = PLACARD.nailR * sc
  const nails = [[ni, ni], [W - ni, ni], [ni, H - ni], [W - ni, H - ni]]
  const grime = makeFbm(ctx.sub('grime'), { periodX: W, periodY: H, feature: 0.05, octaves: 3 })
  const fadeN = makeFbm(ctx.sub('fade'), { periodX: W, periodY: H, feature: 0.08, octaves: 2 })
  const rain = makeSootStreaks(ctx.sub('rain'), { w: W, h: H, count: 5, lenMin: 0.06 * sc, lenMax: 0.22 * sc, widthMin: 0.004 * sc, widthMax: 0.012 * sc,
    strength: 0.22, avoidEdges: false, periodic: false })
  const tears = makeRustRuns(ctx.sub('tears'), { w: W, h: H, periodic: false, sources: nails.map(([x, y]) => [x, y + nr]), lenMin: 0.01 * sc, lenMax: 0.035 * sc, width: 0.004 * sc, strength: 0.45 })
  yield* ctx.raster((s) => {
    const x = s.x, y = s.y, fx = s.fx, fy = s.fy
    const edge = Math.min(x, W - x, y, H - y)
    let c = [sheet[0], sheet[1], sheet[2]]
    // the band: printed edge to edge inside the margin, a little faded and chalky where the sun reaches it
    const inX = box1(x - W / 2, W / 2 - mg, fx), inY = box1(y - bc, bh, fy), band = inX * inY
    const inkC = mix3(ink, [70, 70, 67], c01(0.25 + 0.35 * fadeN(x, y, fx)))
    c = mix3(c, inkC, band)
    let k = (1 + 0.025 * grime(x, y, fx)) * (1 - 0.10 * sstep(0.6 * H, H, y)) * (1 - 0.16 * (1 - sstep(0, 0.004 * sc, edge)))
    k *= 1 - 0.35 * rain(x, y)
    setS(s, c, k)
    const t = tears(x, y)
    if (t > 0) mixS(s, rustC, 0.55 * t)
    let nh = 0, nc = 1
    for (const [nx, ny] of nails) {
      const d = hyp(x - nx, y - ny)
      if (d > 3 * nr) continue
      mixS(s, rustC, 0.35 * sstep(2.6 * nr, nr, d))
      const cov = sdCov(nr - d, fx), dome = c01(1 - (d / nr) ** 2), ring = sdCov(1.8 * nr - d, fx) - cov   // the dent the hammer left
      mixS(s, [nailC[0] * (0.8 + 0.3 * dome), nailC[1] * (0.8 + 0.3 * dome), nailC[2] * (0.8 + 0.3 * dome)], cov)
      nh = Math.max(nh, cov * (0.0015 + 0.0015 * dome)); nc = Math.min(nc, 1 - 0.45 * ring - 0.15 * cov)
    }
    s.cav = Math.min(1 - 0.25 * (1 - sstep(0, 0.004 * sc, edge)), nc); s.h = nh
  })
  return { band: [bc - bh, bc + bh], nails }
} })

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §4 Painted wood: frames, sash, cornice, fascia. A top coat over an older coat over grey wood; alligator cracks (Voronoi
//  edges, cells long along the grain) on old paint; peel follows the grain and shows the older coat in a ring and grey wood inside it.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export const PAINTS = Object.freeze({ white: '#E2DED3', blackgreen: '#2F352F', brown: '#4A3A30' })
export const BARE_WOOD = '#8F877A'
const PAINT_KEYS = Object.keys(PAINTS)

function* makePaintedWood(ctx, o, tag) {
  const W = ctx.w_m, H = ctx.h_m, sP = ctx.sub(tag + 'paint')
  const layer = o.layer ?? null
  if (layer !== null && layer !== 'film' && layer !== 'bare') throw new Error(`paintPaintedWood: bad layer ${layer}`)
  const topKey = o.paint ?? PAINT_KEYS[Math.floor(hashF(1, 2, sP) * PAINT_KEYS.length)]
  const topHex = PAINTS[topKey] ?? topKey
  const others = PAINT_KEYS.filter((k) => PAINTS[k] !== topHex)
  const underKey = o.under ?? others[Math.floor(hashF(3, 4, sP) * others.length)]
  const top = ctx.col(topHex), under = ctx.col(PAINTS[underKey] ?? underKey), bare = ctx.col(BARE_WOOD)
  const peel = layer === 'film' ? 0 : layer === 'bare' ? 1 : c01(o.peel ?? 0.15), age = c01(o.age ?? Math.min(1, 0.2 + 1.6 * c01(o.peel ?? 0.15)))
  const gx = (o.grain ?? 'x') !== 'y'
  const A = (along, across) => (gx ? { featureX: along, featureY: across } : { featureX: across, featureY: along })
  // the flakes are long and narrow along the grain (2-6 cm across, 10-25 cm along: 4-6 : 1), a pale curled lip on
  // the paint side and a dark lift shadow on the bare side of every edge; never 2 : 1 blobs (they read as camouflage)
  const peelN = ctx.fbm(tag + 'peel', { ...A(0.17, 0.034), octaves: 3 }), peelW = ctx.warp(tag + 'peelw', { ...A(0.12, 0.03), octaves: 2, amp: 0.004 })
  const clus = ctx.fbm(tag + 'cluster', { ...A(0.50, 0.20), octaves: 2 })
  const grainN = ctx.fbm(tag + 'grain', { ...A(0.30, 0.012), octaves: 3 }), grain2 = ctx.fbm(tag + 'grain2', { ...A(0.8, 0.04), octaves: 2 })
  const brush = ctx.fbm(tag + 'brush', { ...A(0.12, 0.02), octaves: 2 }), grime = ctx.fbm(tag + 'grime', { feature: 0.22, octaves: 3 })
  // checking: fine cracks parallel to the grain (the zero lines of a long, thin noise), only in patches where the paint is oldest
  // (about 30% of the area at full age), never a cell network
  const allig = ctx.fbm(tag + 'allig', { ...A(0.30, 0.10), octaves: 3 }), underM = ctx.fbm(tag + 'under', { ...A(0.10, 0.03), octaves: 2 })
  const chk = ctx.fbm(tag + 'check', { ...A(0.09, 0.0045), octaves: 2 }), chkB = ctx.fbm(tag + 'check-break', { ...A(0.05, 0.02), octaves: 2 })
  const Wp = {}
  const P = (x, y) => { peelW(x, y, Wp); return peelN(Wp.x, Wp.y) + 0.05 * grainN(x, y) + 0.22 * clus(x, y) }
  const st = peel > 0 || layer === 'film' ? (yield* fieldStats(P, W, H, layer === 'film' ? 128 : 64)) : null
  const tBare = layer === 'bare' ? -1e9 : peel > 0 ? st.q(1 - peel) : 1e9
  const tUnder = layer !== null ? 1e9 : peel > 0 ? st.q(1 - Math.min(1, peel * 1.3 + 0.015)) : 1e9   // 1e9: never reached
  const aShare = 0.32 * c01((age - 0.2) * 1.25), tAl = aShare > 0 ? (yield* fieldStats((x, y) => allig(x, y), W, H)).q(1 - aShare) : 1e9
  const dark = lum(top) < 100
  // old paint: white goes dirty and yellow-grey; dark paints chalk toward a pale grey of their own hue
  const aged = dark ? mix3(top, mix3(top, [150, 152, 146], 0.6), 0.5) : [top[0] * 0.88, top[1] * 0.87, top[2] * 0.81]
  const underAged = lum(under) < 100 ? mix3(under, [140, 142, 136], 0.3) : [under[0] * 0.86, under[1] * 0.85, under[2] * 0.79]
  const crackC = mix3(mix3(underAged, bare, 0.5), dark ? [150, 150, 144] : [0, 0, 0], dark ? 0.25 : 0.65)          // dark crack lines
  const uSoft = lum(under) < lum(top)
  const de = 0.0015
  const shade = (x, y, fx, fy, out) => {
    const p0 = P(x, y), dP = Math.abs(P(x + fx, y) - p0) + Math.abs(P(x, y + fy) - p0)
    const g = grainN(x, y, fx), g2 = grain2(x, y, fx), b = brush(x, y, fx), gr = grime(x, y, fx)
    const am = aShare > 0 ? sstep(tAl - 0.04, tAl + 0.10, allig(x, y, fx)) : 0
    let ca = 0
    if (am > 0) {
      // the crack: where the thin noise crosses zero (its distance from the zero line in metres), broken along its length
      const c0 = chk(x, y), gy = gx ? (chk(x, y + de) - chk(x, y - de)) / (2 * de) : (chk(x + de, y) - chk(x - de, y)) / (2 * de)
      const dist = c0 / Math.max(1e-3, Math.abs(gy)), on = sstep(-0.05, 0.15, chkB(x, y))
      ca = am * on * box1(dist, dark ? 0.0005 + 0.0004 * age : 0.0007 + 0.0005 * age, gx ? fy : fx)
    }
    const k = 1 + 0.025 * b + 0.012 * g
    const c = mix3(top, aged, c01((0.03 + 0.75 * age) * (0.55 + 0.9 * gr)))          // fresh paint (age 0) is the paint colour
    let r = c[0] * k, gg = c[1] * k, bb = c[2] * k
    const ck = dark ? 0.6 : 0.8
    r = lerp(r, crackC[0], ck * ca); gg = lerp(gg, crackC[1], ck * ca); bb = lerp(bb, crackC[2], ck * ca)
    const mB = layer === 'bare' ? 1 : layer === 'film' ? 0 : softT(p0, tBare, dP)
    // the older coat shows in a band at the peel edge, and only where it held on (underM)
    const um = sstep(-0.05, 0.12, underM(x, y, fx))
    // a light coat over a darker under-coat shows it as a soft ring at half the contrast (a dark coat keeps its pale under-coat)
    const mU = layer !== null ? 0 : softT(p0, tUnder, dP) * um * (uSoft ? 0.5 : 1)
    const ku = 1 + 0.02 * b
    r = lerp(r, underAged[0] * ku, mU); gg = lerp(gg, underAged[1] * ku, mU); bb = lerp(bb, underAged[2] * ku, mU)
    // the curled paint lip catches the light (paint side); the lift shadow is a thin dark line just inside the bare patch
    const edge = layer !== null ? 0 : Math.exp(-(((p0 - tBare) / (0.010 + dP)) ** 2))
    const lip = (1 - mB) * edge, sh = mB * edge
    r *= 1 + 0.10 * lip; gg *= 1 + 0.10 * lip; bb *= 1 + 0.10 * lip
    // silver-grey weathered wood: raised grain, darker latewood lines
    const kw = (1 + 0.13 * g + 0.07 * g2) * (1 - 0.34 * Math.max(0, g - 0.05) ** 2), wv = 1 - 0.32 * sh
    r = lerp(r, bare[0] * kw * wv, mB); gg = lerp(gg, bare[1] * kw * wv, mB); bb = lerp(bb, bare[2] * kw * wv, mB)
    out[0] = r; out[1] = gg; out[2] = bb
    out[3] = 1 - 0.35 * ca * (1 - mB) - 0.08 * mB - 0.15 * sh
    out[4] = -0.0004 * mB - 0.0002 * ca
    // the film tile carries the peel ORDER (1 - the rank of the flake field) in place of its cavity (for a renderer that blends the peel per pixel)
    if (layer === 'film') out[3] = 1 - st.rank(p0)
    return out
  }
  shade.meta = { paint: topKey, under: underKey, peel, age, layer }
  return shade
}

export const paintPaintedWood = makeRecipe({ name: 'paintPaintedWood', stock: PAINTS.white, periodic: true, *paint(ctx) {
  const shade = (yield* makePaintedWood(ctx, ctx.opts, 'pw-')), O = [0, 0, 0, 1, 0]
  yield* ctx.raster((s) => { shade(s.x, s.y, s.fx, s.fy, O); s.r = O[0]; s.g = O[1]; s.b = O[2]; s.cav = O[3]; s.h = O[4] })
  return shade.meta
} })

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §4b paintDoorLeaf: a four-panel wood front-door leaf, its own piece (laid over the leaf alone), so no
//  strip of painted wood repeats across a leaf. Stiles, a centre muntin and three rails (grain along each member), four recessed
//  panels (two tall over two short) with their bevels shaded as the overcast sky lights them (the pipeline is unlit: up-facing bevels
//  a little lighter, down-facing ones darker, a dark sticking line round each field), the joints where the rails meet the stiles, a
//  worn kick rail and a hand-grimed lock rail. Call with the leaf's size (0.91 x 2.29 m). opts: the painted-wood opts (paint, peel,
//  age). meta: { panels: [{ x0, y0, x1, y1 }], ...the paint's meta }
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export const DOOR_LEAF = Object.freeze({ stile: 0.10, muntin: 0.10, bottomRail: 0.22, lockRail: [0.85, 1.05], topRail: 2.15, nominalH: 2.29,
  bevel: 0.035, sticking: 0.006 })
export const paintDoorLeaf = makeRecipe({ name: 'paintDoorLeaf', stock: PAINTS.white, periodic: false, *paint(ctx) {
  const W = ctx.w_m, H = ctx.h_m, o = ctx.opts, D = DOOR_LEAF, kz = H / D.nominalH
  const shX = (yield* makePaintedWood(ctx, { ...o, grain: 'x' }, 'dl-x-')), shY = (yield* makePaintedWood(ctx, { ...o, grain: 'y' }, 'dl-y-'))
  const pw = (W - 2 * D.stile - D.muntin) / 2
  // panel boxes in texture metres (y down from the leaf's top)
  const zy = (z) => H - z * kz
  const rows = [[D.bottomRail, D.lockRail[0]], [D.lockRail[1], D.topRail]]
  const panels = []
  for (const [z0, z1] of rows) for (const x0 of [D.stile, D.stile + pw + D.muntin]) panels.push({ x0, x1: x0 + pw, y0: zy(z1), y1: zy(z0) })
  const grime = ctx.fbm('dl-grime', { feature: 0.08, octaves: 3 })
  const O = [0, 0, 0, 1, 0]
  yield* ctx.raster((s) => {
    const x = s.x, y = s.y, fx = s.fx, fy = s.fy
    let inP = null
    for (const P of panels) if (x > P.x0 && x < P.x1 && y > P.y0 && y < P.y1) { inP = P; break }
    // the member under this point: a stile or the muntin (vertical grain) or a rail (horizontal grain); panels run their grain up
    const onStile = x < D.stile || x > W - D.stile || (x > D.stile + pw && x < D.stile + pw + D.muntin)
    const vertical = inP !== null || onStile
    ;(vertical ? shY : shX)(x, y, fx, fy, O)
    let k = 1, cav = O[3]
    if (inP) {
      const dT = y - inP.y0, dB = inP.y1 - y, dL = x - inP.x0, dR = inP.x1 - x, d = Math.min(dT, dB, dL, dR)
      k *= 0.965                                                                   // the field sits back in the frame
      if (d < D.bevel) {
        const face = d === dT ? 0.80 : d === dB ? 1.08 : 0.93                       // the top bevel faces down, the bottom one up
        const t = sdCov(D.bevel - d, Math.max(fx, fy))
        k *= lerp(1, face, t)
      }
      const stick = box1(d, D.sticking * 0.5, Math.max(fx, fy)) + box1(d - D.bevel, 0.0012, Math.max(fx, fy))
      k *= 1 - 0.30 * c01(stick); cav -= 0.25 * c01(stick)
    } else if (!onStile) {
      // a rail: the joint where it meets the stile or muntin (a hairline across the rail)
      const j = Math.min(Math.abs(x - D.stile), Math.abs(x - (W - D.stile)), Math.abs(x - (D.stile + pw)), Math.abs(x - (D.stile + pw + D.muntin)))
      const jl = box1(j, 0.0008, fx)
      k *= 1 - 0.22 * jl; cav -= 0.15 * jl
    }
    // the gap round the leaf, the worn kick rail, the hand grime on the lock side at the lock rail
    const edge = Math.min(x, W - x, y, H - y)
    k *= 1 - 0.30 * box1(edge, 0.004, Math.max(fx, fy))
    const zf = (H - y) / kz
    const kick = sstep(0.20, 0.0, zf) * (0.6 + 0.4 * c01(0.5 + grime(x, y, fx)))
    const hand = Math.exp(-(((x - (W - 0.09)) / 0.07) ** 2) - (((zf - 0.97) / 0.18) ** 2)) * (0.5 + 0.5 * c01(0.5 + grime(x, y, fx)))
    k *= 1 - 0.14 * kick - 0.12 * hand
    s.r = O[0] * k; s.g = O[1] * k; s.b = O[2] * k; s.cav = c01(cav); s.h = O[4]
  })
  return { panels, ...shY.meta }
} })

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §5 paintVentPanel: a jigsaw-cut frieze panel. Generic motifs built from signed-distance shapes
//  (lenses, discs, capsules, wedges), symmetric about the panel's centre line. Generated from geometry, never traced.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export const VENT_PANEL = Object.freeze({ w: 0.61, h: 0.25, motifs: Object.freeze(['sunflower', 'fan', 'wing']), border: 0.025, groove: 0.012, thick: 0.019 })

// the cut-out of a motif: → f(px, py) signed distance, + inside a cut, in NOMINAL panel metres about the centre (y down)
function ventMotif(motif, seed) {
  const r = (k) => hashF(k, 0x7E, seed)
  // a side rosette: a small round centre and n fat petals (they read as a flower, never as a thin-spoked asterisk)
  const rosette = (cx, cy, R, n, a0) => (px, py) => {
    let d = 0.18 * R - hyp(px - cx, py - cy)
    for (let i = 0; i < n; i++) {
      const a = a0 + (TAU * i) / n, [qx, qy] = rot(px - cx, py - cy, -a)
      d = Math.max(d, sdLens(qx - 0.62 * R, qy, 0.30 * R, (0.62 * R * TAU / n) * 0.42))
    }
    return d
  }
  if (motif === 'sunflower') {
    const n = [10, 12, 14][Math.floor(r(0) * 3)], R = lerp(0.092, 0.100, r(1)), rc = lerp(0.022, 0.030, r(2)), r0 = rc + lerp(0.010, 0.016, r(3))
    const bw = ((TAU * (r0 + R) * 0.5) / n) * lerp(0.40, 0.50, r(4)), sx = lerp(0.195, 0.215, r(5)), sr = lerp(0.040, 0.050, r(6)), ns = r(7) < 0.5 ? 5 : 6
    const side = [rosette(-sx, 0, sr, ns, -Math.PI / 2), rosette(sx, 0, sr, ns, -Math.PI / 2)]
    return (px, py) => {
      let d = rc - hyp(px, py)
      const a = Math.atan2(py, px), step = TAU / n, k = Math.round(a / step), [qx, qy] = rot(px, py, -k * step)
      d = Math.max(d, sdLens(qx - (r0 + R) / 2, qy, (R - r0) / 2, bw / 2))
      for (const f of side) d = Math.max(d, f(px, py))
      return d
    }
  }
  if (motif === 'fan') {
    const n = 9 + 2 * Math.floor(r(0) * 3), span = lerp(2.6, 2.95, r(1)), py0 = lerp(0.080, 0.090, r(2)), ri = lerp(0.032, 0.040, r(3)), ro = lerp(0.150, 0.160, r(4))
    const dA = span / (n - 1), half = dA * lerp(0.26, 0.32, r(5)), sx = lerp(0.225, 0.240, r(6)), sr = lerp(0.032, 0.040, r(7))
    const side = [rosette(-sx, 0.005, sr, 6, -Math.PI / 2), rosette(sx, 0.005, sr, 6, -Math.PI / 2)]
    return (px, py) => {
      const qx = px, qy = py - py0, rho = hyp(qx, qy), a = Math.atan2(qy, qx) + Math.PI / 2   // a = 0 straight up
      let d = 0.011 - rho                                                                      // the pivot hole
      const k = Math.max(0, Math.min(n - 1, Math.round((a + span / 2) / dA))), ak = -span / 2 + k * dA
      d = Math.max(d, Math.min((half - Math.abs(a - ak)) * rho, rho - ri, ro - rho))
      d = Math.max(d, Math.min(0.006 - Math.abs(rho - (ro + 0.012)), (span / 2 + 0.05 - Math.abs(a)) * rho))   // the outer arc slot
      for (const f of side) d = Math.max(d, f(px, py))
      return d
    }
  }
  // 'wing': a pair of wings either side of a narrow body slot, a smaller pair of wings below, round holes outboard
  const ua = lerp(0.070, 0.080, r(0)), ub = lerp(0.030, 0.036, r(1)), ut = lerp(0.35, 0.50, r(2)), la = lerp(0.042, 0.050, r(3)), lb = lerp(0.019, 0.024, r(4))
  const lt = lerp(0.40, 0.60, r(5)), hx = lerp(0.205, 0.225, r(6)), hr = lerp(0.016, 0.020, r(7))
  return (px, py) => {
    const ax = Math.abs(px)                                                                    // mirror: one side drawn
    let d = sdCapsule(ax, py, 0, -0.045, 0, 0.050, 0.0055)
    const [ux, uy] = rot(ax - (0.016 + ua * Math.cos(ut)), py + 0.010 + ua * Math.sin(ut) * 0.5, ut)
    d = Math.max(d, sdLens(ux, uy, ua, ub))
    const [lx, ly] = rot(ax - (0.014 + la * Math.cos(lt)), py - 0.030 - la * Math.sin(lt) * 0.5, -lt)
    d = Math.max(d, sdLens(lx, ly, la, lb))
    d = Math.max(d, hr - hyp(ax - hx, py), 0.6 * hr - hyp(ax - hx - 0.045, py))
    return d
  }
}

export const paintVentPanel = makeRecipe({ name: 'paintVentPanel', stock: PAINTS.white, periodic: false, *paint(ctx) {
  const W = ctx.w_m, H = ctx.h_m, o = ctx.opts
  const motif = o.motif ?? VENT_PANEL.motifs[Math.floor(hashF(0, 0, ctx.sub('motif')) * 3)]
  if (!VENT_PANEL.motifs.includes(motif)) throw new Error(`paintVentPanel: unknown motif ${motif}`)
  const cut = ventMotif(motif, ctx.sub('motif-' + motif)), sc = Math.min(W / VENT_PANEL.w, H / VENT_PANEL.h)
  const sd = (x, y) => cut((x - W / 2) / sc, (y - H / 2) / sc) * sc
  const shade = (yield* makePaintedWood(ctx, { grain: 'x', ...o }, 'vp-')), O = [0, 0, 0, 1, 0], attic = tcol(ctx, [17, 15, 13], 0)
  const gIn = VENT_PANEL.groove * sc
  const alphaAt = (x, y, fx) => 1 - sdCov(sd(x, y), fx)
  yield* ctx.raster((s) => {
    const x = s.x, y = s.y, fx = s.fx
    shade(x, y, fx, s.fy, O)
    s.r = O[0]; s.g = O[1]; s.b = O[2]; s.cav = O[3]; s.h = O[4]
    // a routed groove round the border, the cut edges darkened (end grain, dirt), the attic dark behind the cuts
    const edge = Math.min(x, W - x, y, H - y), groove = box1(edge - gIn, 0.0016 * sc, fx)
    mulS(s, 1 - 0.35 * groove); s.cav -= 0.4 * groove; s.h -= 0.002 * groove
    const d = sd(x, y), a = 1 - sdCov(d, fx), near = a * Math.exp(Math.min(0, d) / 0.004) * (d < 0 ? 1 : 0)
    mulS(s, 1 - 0.22 * near); s.cav = lerp(s.cav, 0.7, near)
    s.r = lerp(attic[0], s.r, a); s.g = lerp(attic[1], s.g, a); s.b = lerp(attic[2], s.b, a)
    s.cav = lerp(0.15, s.cav, a); s.h = lerp(-VENT_PANEL.thick, s.h, a)
  })
  // the alpha / cut mask: a second pass on the same sample grid, so it box-filters exactly like the colour
  const Am = newRaster(W, H, ctx.tpm, { height: false })
  yield* rasterizeSteps(Am, (s) => { s.r = alphaAt(s.x, s.y, s.fx) }, { ss: ctx.ss, origin: o.origin, wrap: o.wrap })
  const alpha = new Float32Array(Am.w * Am.h)
  let cutA = 0
  for (let i = 0; i < alpha.length; i++) { alpha[i] = c01(Am.rgb[i * 3]); cutA += 1 - alpha[i] }
  ctx.R.alpha = alpha
  return { motif, cutShare: cutA / alpha.length, ...shade.meta }
} })

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §6 paintAsphalt (the alley strip and the court pad). Binder #4A4844 oxidising to #5E5B55, exposed aggregate 1–2 cm,
//  block cracks (warped Voronoi edges, some sealed with tar), ravelled crack edges, saw-cut patches.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export const paintAsphalt = makeRecipe({ name: 'paintAsphalt', stock: 'floor', periodic: true, *paint(ctx) {
  const W = ctx.w_m, H = ctx.h_m, o = ctx.opts, sR = ctx.sub('rolls')
  // seal: an abandoned court or a ghost alley gets no crack-sealing crew, so by default (almost) none
  const ox0 = c01(o.ox ?? lerp(0.35, 0.85, hashF(0, 0, sR))), dens = c01(o.cracks ?? 0.55), seal = c01(o.seal ?? 0.05)
  const nP = o.patches ?? Math.floor(hashF(0, 1, sR) * 3)
  const fresh = ctx.col('#4A4844'), oxid = ctx.col('#5E5B55'), stoneA = ctx.col([128, 124, 116]), stoneB = ctx.col([92, 90, 86])
  // open cracks are full of dirt and grit, not black chasms
  const crackC = ctx.col([50, 46, 40]), sealC = ctx.col([30, 29, 27]), patchC = ctx.col('#3F3E3B'), weed = tcol(ctx, [84, 92, 56], 0.15)
  const oxN = ctx.fbm('ox', { feature: 0.6, octaves: 3 }), binN = ctx.fbm('binder', { feature: 0.06, octaves: 3 })
  const crackM = ctx.fbm('crack-mask', { feature: 0.7, octaves: 2 }), crackWd = ctx.fbm('crack-w', { feature: 0.15, octaves: 2 })
  const cv = ctx.voronoi('cracks', { feature: 0.55 }), cw = ctx.warp('crack-warp', { feature: 0.3, octaves: 3, amp: 0.05 })
  const fineV = ctx.voronoi('alligator', { feature: 0.12 }), fineM = ctx.fbm('alligator-m', { feature: 0.8, octaves: 2 })
  const stones = makeStones(ctx.voronoi('stones', { feature: 0.014, search: 1 }), ctx.sub('stones'), { gap: 0.0012, rMin: 0.004, rMax: 0.0085 })
  const sealN = ctx.fbm('seal-region', { feature: 0.7, octaves: 2 }), tarN = ctx.fbm('tar', { feature: 0.04, octaves: 2 })
  const sealT = seal > 0 ? (yield* fieldStats((x, y) => sealN(x, y), W, H, 32)).q(1 - seal) : 1e9
  const patches = []
  for (let i = 0; i < nP; i++) patches.push({ x: hashF(i, 2, sR) * W, y: hashF(i, 3, sR) * H, hx: lerp(0.18, 0.45, hashF(i, 4, sR)), hy: lerp(0.15, 0.35, hashF(i, 5, sR)),
    a: (hashF(i, 6, sR) - 0.5) * 0.25, cold: hashF(i, 7, sR) < 0.35 })
  // the exposed-aggregate share and its mean over the tile, for the band-limited fade
  const ST = {}
  const stoneMean = (yield* fieldStats((x, y) => stones(x, y, 0, 1, ST).cov, W, H, 48)).mean
  const C = {}, F = {}, Wp = {}
  yield* ctx.raster((s) => {
    const x = s.x, y = s.y, fx = s.fx
    const ox = c01(ox0 + 0.30 * oxN(x, y, fx))
    const bin = mix3(fresh, oxid, ox), kb = 1 + 0.05 * binN(x, y, fx)
    setS(s, bin, kb)
    // cracks first (their ravelled edges expose more stone)
    // the block-crack network is everywhere; a slow mask opens it (and closes it again) smoothly along its length, so a crack tapers in
    // and out instead of stopping at a cell corner
    cw(x, y, Wp, fx); cv(Wp.x, Wp.y, C)
    const cracked = sstep(-0.10, 0.10, crackM(x, y, fx) + 0.7 * (dens - 0.55))
    const width = (0.0015 + 0.006 * c01(0.5 + crackWd(x, y, fx))) * cracked
    let crack = box1(C.edge, width / 2, fx)
    fineV(x, y, F)
    const fineOn = sstep(0.12, 0.3, fineM(x, y, fx) - 0.25 + 0.5 * dens)
    crack = Math.max(crack, fineOn * box1(F.edge, 0.0014, fx))
    const ravel = cracked * Math.exp(-C.edge / 0.018)
    // aggregate: more of it shows where the binder has oxidised and worn, and along cracks
    const expo = c01(0.15 + 0.55 * ox + 0.4 * ravel)
    stones(x, y, fx, 1, ST)
    const tone = 0.85 + 0.3 * hashF(ST.id, 5, sR), sc = mix3(stoneA, stoneB, hashF(ST.id, 6, sR) < 0.3 ? 1 : 0)
    const vis = hashF(ST.id, 4, sR) < expo ? ST.cov : 0, fw = fadeW(0.014, fx)
    const sv = lerp(stoneMean * expo, vis, fw)
    mixS(s, [sc[0] * tone, sc[1] * tone, sc[2] * tone], sv * 0.75)
    s.h = 0.0012 * sv; s.cav = 1 - 0.08 * (1 - sv) * fw
    // patches: newer asphalt (darker, less oxidised, less stone showing) with a black sealed joint round the saw cut, or a lumpy hand-laid
    // cold patch; no cracks inside
    let inP = 0
    for (const p of patches) {
      const [lx, ly] = rot(wrapD(x - p.x, W), wrapD(y - p.y, H), -p.a)
      const d = p.cold ? (1 - hyp(lx / p.hx, ly / p.hy)) * Math.min(p.hx, p.hy) + 0.03 * binN(x + 0.5, y, fx) : Math.min(p.hx - Math.abs(lx), p.hy - Math.abs(ly))
      if (d < -0.03) continue
      const cov = sdCov(d, fx), line = p.cold ? 0 : box1(d, 0.006, fx)
      const pc = mix3(patchC, oxid, 0.25 * ox), kp = (1 + 0.07 * binN(x + 0.3, y + 0.7, fx)) * (p.cold ? 1 + 0.06 * oxN(x * 3, y * 3, 3 * fx) : 1)
      mixS(s, [pc[0] * kp, pc[1] * kp, pc[2] * kp], cov)
      const pv = lerp(stoneMean * 0.25, hashF(ST.id, 4, sR) < 0.25 ? ST.cov : 0, fw)
      mixS(s, [stoneB[0], stoneB[1], stoneB[2]], 0.45 * pv * cov)
      mixS(s, sealC, 0.8 * line)
      s.h = lerp(s.h, 0.003, cov); inP = Math.max(inP, cov)
    }
    crack *= 1 - inP
    // sealed cracks: in some regions a crew has run hot tar along every crack: a band 4–7 cm wide, ragged-edged, a little greyed
    const sealed = seal > 0 ? sstep(0.05, 0.4, cracked) * softT(sealN(x, y, fx), sealT, 0.05) * (1 - inP) : 0
    if (sealed > 0) {
      const tw = 0.020 + 0.010 * c01(0.5 + crackWd(x + 1, y, fx)) + 0.004 * tarN(x, y, fx)
      const band = sealed * box1(C.edge, tw, fx)
      mixS(s, mix3(sealC, oxid, 0.12 + 0.1 * c01(0.5 + tarN(x + 2, y, fx))), 0.92 * band)
      s.h = lerp(s.h, 0.001, band); s.cav = lerp(s.cav, 1, band); crack *= 1 - sealed
    }
    if (crack > 0) {
      const weedy = 0.85 * sstep(0.004, 0.007, width) * sstep(0.12, 0.25, tarN(x + 0.53, y + 0.21, fx))   // moss and grass in the wide cracks
      mixS(s, mix3(crackC, weed, weedy), 0.92 * crack)
      s.cav -= 0.6 * crack; s.h -= 0.006 * crack
    }
  })
  return { ox: ox0, cracks: dens, seal, patches }
} })

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §7 paintConcrete (steps, footings, thresholds, sills). Cement paste #A3A29C stained toward #8F8E88; broom lines (fine, so
//  they show at 128 tpm and average out at 32), tooled expansion joints with smooth edger margins, spall to exposed aggregate, rust bleed.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export const paintConcrete = makeRecipe({ name: 'paintConcrete', stock: 'C', periodic: true, *paint(ctx) {
  const W = ctx.w_m, H = ctx.h_m, o = ctx.opts, sR = ctx.sub('rolls')
  const J = o.joints ?? 1.0, broom = o.broom ?? 'x', stainK = c01(o.stain ?? 0.45), spallK = c01(o.spall ?? 0.3), vertical = !!o.vertical
  const nRust = o.rust ?? Math.floor(hashF(0, 0, sR) * 3)
  const nxJ = J > 0 ? Math.max(1, Math.round(W / J)) : 0, nyJ = J > 0 ? Math.max(1, Math.round(H / J)) : 0
  const paste = ctx.col('#A3A29C'), stained = ctx.col('#8F8E88'), grooveC = ctx.col([84, 83, 79]), aggrA = ctx.col([146, 142, 134]), aggrB = ctx.col([104, 102, 98])
  const matrix = ctx.col([142, 140, 133]), rustC = tcol(ctx, [134, 92, 58], 0.3)
  const mottle = ctx.fbm('mottle', { feature: 0.35, octaves: 3 }), trowel = ctx.fbm('trowel', { featureX: 0.25, featureY: 0.08, octaves: 2 })
  const brm = broom === 'y' ? ctx.fbm('broom', { featureX: 0.016, featureY: 0.35, octaves: 2 }) : ctx.fbm('broom', { featureX: 0.35, featureY: 0.016, octaves: 2 })
  const stainN = ctx.fbm('stain', { feature: 0.4, octaves: 4 }), spallN = ctx.fbm('spall', { feature: 0.2, octaves: 5 }), rustN = ctx.fbm('rust-n', { feature: 0.05, octaves: 3 })
  const pits = makeStones(ctx.voronoi('pits', { feature: 0.03, search: 1 }), ctx.sub('pits'), { gap: 0, rMin: 0.0012, rMax: 0.0035 })
  const pebbles = makeStones(ctx.voronoi('pebbles', { feature: 0.012, search: 1 }), ctx.sub('pebbles'), { gap: 0.0012, rMin: 0.003, rMax: 0.0065 })
  const rusts = []
  for (let i = 0; i < nRust; i++) rusts.push({ x: hashF(i, 1, sR) * W, y: hashF(i, 2, sR) * H, r: lerp(0.04, 0.12, hashF(i, 3, sR)) })
  const runs = vertical ? makeRustRuns(ctx.sub('runs'), { w: W, h: H, sources: rusts.map((q) => [q.x, q.y]), lenMin: 0.15, lenMax: 0.45, width: 0.03, strength: 0.7 }) : null
  const jd = (v, size, n) => (n > 0 ? Math.abs(wrapD(v, size / n)) : Infinity)
  const ST = {}, PB = {}
  const pebMean = (yield* fieldStats((x, y) => pebbles(x, y, 0, 0.8, PB).cov, W, H, 48)).mean
  // spall: freeze-thaw takes the paste off at the joints and slab edges first, so the field leans hard toward them
  const fp = sampleFootprint(ctx)
  const SP = (x, y) => spallN(x, y, fp) + 0.45 * Math.exp(-Math.min(jd(x, W, nxJ), jd(y, H, nyJ)) / 0.10)
  const spT = (yield* fieldStats(SP, W, H, 64)).q(1 - 0.22 * spallK)
  yield* ctx.raster((s) => {
    const x = s.x, y = s.y, fx = s.fx, fy = s.fy
    const dx = jd(x, W, nxJ), dy = jd(y, H, nyJ), dj = Math.min(dx, dy)
    const margin = 1 - sstep(0.03, 0.045, dj)                                              // the edger's smooth band either side of a joint
    let k = 1 + 0.04 * mottle(x, y, fx) + 0.025 * trowel(x, y, fx)
    if (broom !== 'none') k *= 1 + 0.06 * brm(x, y, fx) * (1 - margin)
    k *= 1 - 0.025 * margin
    const st = c01(stainK * (0.45 + 1.3 * stainN(x, y, fx)) + 0.25 * stainK * Math.exp(-dj / 0.06))
    const c = mix3(paste, stained, st)
    setS(s, c, k * (1 - 0.08 * st * st))
    // pop-out pits
    pits(x, y, fx, 0.35, ST)
    if (ST.cov > 0) { mulS(s, 1 - 0.3 * ST.cov); s.cav = 1 - 0.3 * ST.cov }
    // spall: a shallow rough depression, exposed aggregate in a grey matrix, a shadowed rim where the paste broke off
    const sp0 = spallN(x, y, fx) + 0.45 * Math.exp(-dj / 0.10)
    const sdP = Math.abs(spallN(x + fx, y, fx) - spallN(x, y, fx)) + Math.abs(spallN(x, y + fy, fx) - spallN(x, y, fx))
    const spl = spallK > 0 ? softT(sp0, spT, sdP) : 0
    if (spallK > 0 && sp0 > spT - 0.1) {
      const rim = Math.exp(-(((sp0 - spT) / (0.025 + sdP)) ** 2))
      if (spl > 0) {
        pebbles(x, y, fx, 0.8, PB)
        const pv = lerp(pebMean, PB.cov, fadeW(0.012, fx)), pc = mix3(aggrA, aggrB, hashF(PB.id, 3, sR) < 0.4 ? 1 : 0)
        const tone = 0.88 + 0.24 * hashF(PB.id, 4, sR)
        const sc = mix3(matrix, [pc[0] * tone, pc[1] * tone, pc[2] * tone], pv)
        mixS(s, [sc[0] * 0.95, sc[1] * 0.95, sc[2] * 0.95], spl)
        s.cav = Math.min(s.cav, 1 - 0.25 * spl * (1 - pv)); s.h = -0.004 * spl + 0.0015 * pv * spl
      }
      mulS(s, 1 - 0.16 * rim * spl + 0.04 * rim * (1 - spl)); s.cav = Math.min(s.cav, 1 - 0.3 * rim * spl)
    }
    // rust bleed: radial blotches (flat work) or runs (risers)
    for (const q of rusts) {
      const d = hyp(wrapD(x - q.x, W), wrapD(y - q.y, H)) / q.r + 0.35 * rustN(x, y, fx)
      if (d < 1.2) mixS(s, rustC, 0.55 * sstep(1.1, 0.3, d))
    }
    if (runs) { const rr = runs(x, y); if (rr > 0) mixS(s, rustC, 0.6 * rr) }
    // the tooled joint: a rounded groove 8 mm wide
    const g = J > 0 ? box1(dj, 0.004, fx) : 0
    if (g > 0) { mixS(s, grooveC, 0.85 * g); s.cav -= 0.6 * g; s.h -= 0.01 * g }
  })
  return { joints: J, broom, stain: stainK, spall: spallK, rust: rusts }
} })

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §8 paintGranite (granite, pinkish-grey and coarse-grained: the curbstones). Crystals as Voronoi
//  cells: pink feldspar #A8968C, pale plagioclase, grey glassy quartz, black biotite #4A4846; overall #8E8580.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export const paintGranite = makeRecipe({ name: 'paintGranite', stock: 'floor', periodic: true, *paint(ctx) {
  const o = ctx.opts, face = o.face ?? 'top', dirt = c01(o.dirt ?? 0.6)
  const feld = ctx.col('#A8968C'), plag = ctx.col([176, 170, 162]), quartz = ctx.col([120, 118, 114]), bio = ctx.col('#4A4846')
  // crystal size: coarse-grained means 5–10 mm, about a texel at 128 tpm: a fine speckle there (point-sampled on purpose), its mean at
  // any coarser footprint, never a grid of 2-texel squares
  const XT = 0.008
  const xtal = ctx.voronoi('crystals', { feature: XT }), clus = ctx.fbm('clusters', { feature: 0.06, octaves: 2 })
  const big = ctx.fbm('tone', { feature: 0.3, octaves: 3 }), dirtN = ctx.fbm('dirt', { feature: 0.15, octaves: 3 })
  const tool = ctx.fbm('tool', { featureX: 0.25, featureY: 0.02, octaves: 2 }), sX = ctx.sub('xtal')
  const mins = [feld, plag, quartz, bio], V = {}
  // the box-filter mean of one crystal sample (for the band-limited fade at a coarse footprint)
  const shareOf = (h, c) => { const b = 0.08 + 0.15 * c; return h < b ? 3 : h < b + 0.26 ? 2 : h < b + 0.40 ? 1 : 0 }   // biotite in clots
  const meanC = [0, 0, 0]
  {
    let n = 0
    for (let j = 0; j < 48; j++) for (let i = 0; i < 48; i++) {
      const x = ((i + 0.5) * ctx.w_m) / 48, y = ((j + 0.5) * ctx.h_m) / 48
      xtal(x, y, V)
      const m = mins[shareOf(hashF(V.id, 1, sX), clus(x, y))], t = 0.9 + 0.2 * hashF(V.id, 2, sX)
      meanC[0] += m[0] * t; meanC[1] += m[1] * t; meanC[2] += m[2] * t; n++
    }
    meanC[0] /= n; meanC[1] /= n; meanC[2] /= n
  }
  yield* ctx.raster((s) => {
    const x = s.x, y = s.y, fx = s.fx
    xtal(x, y, V)
    const mi = shareOf(hashF(V.id, 1, sX), clus(x, y, fx)), m = mins[mi], t = 0.9 + 0.2 * hashF(V.id, 2, sX), fw = fadeW(2 * XT, fx)
    const edge = box1(V.edge, 0.0006, fx), pit = lerp(0.12, mi === 3 ? 1 : 0, fw)       // biotite weathers out first: shallow pits
    let k = (1 + 0.05 * big(x, y, fx)) * (1 - 0.10 * edge * fw) * (1 - dirt * 0.14 * c01(0.5 + dirtN(x, y, fx)))
    if (face === 'face') k *= 1 + 0.05 * tool(x, y, fx)
    // a weathered skin: the crystals show at a little over half their contrast through the dirt film on a curb
    const mt = mix3(meanC, [m[0] * t, m[1] * t, m[2] * t], 0.55)
    s.r = lerp(meanC[0], mt[0], fw) * k; s.g = lerp(meanC[1], mt[1], fw) * k; s.b = lerp(meanC[2], mt[2], fw) * k
    s.cav = 1 - 0.12 * edge * fw - 0.30 * pit; s.h = 0.0005 * (t - 1) * fw - 0.0008 * pit
  })
  return { face, dirt, mean: meanC }
} })

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §9 paintYard: worn grass going to dirt; desire lines; variants gravel (1–3 cm stones #7A746A),
//  tanbark remnant (#4A3828), litter specks, glass glints and a damp patch. Base dirt is the palette floor #5A5048; the grass
//  #5E6448..#6E7450 is an absolute accent, tempered (k 0.15) by the floor hex.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export const YARD_VARIANTS = Object.freeze(['base', 'gravel', 'tanbark', 'litter', 'glass', 'damp'])
// the ground's three covers: the large-scale grass / dirt split is NOT in the 2 m tile (every one of the 340 cells would repeat it); the
// tile holds one cover with detail under ~10 cm, and a renderer can blend the covers by world position with paintYardWearMask
export const YARD_COVERS = Object.freeze(['grass', 'thin', 'dirt'])
export const YARD_COVER_WEAR = Object.freeze({ grass: 0.10, thin: 0.55, dirt: 0.95 })
// the grass field of the park ground (paintYard and paintYardCoverRank read the same one): Gf = a slow field with clumpy detail, so worn
// ground breaks into tufts and islands, never into a cell pattern; a cover with wear w has its grass where Gf clears Gf's w-quantile.
// bladeF = the blade-scale stipple of the grass colour (6 mm value noise: one texel at 128 tpm, its mean at any coarser footprint);
// bladeU = the blade dither: one UNIFORM [0, 1) value per 128 tpm texel cell (a periodic hash grid), so dithering a coverage c by
// bladeU < c keeps the share c exactly, blade by blade (a value noise bunches round 0.5 and would turn the dither into a hard edge)
function yardGrassField(ctx) {
  const gN = ctx.fbm('grass', { feature: 0.08, octaves: 4 }), clump = ctx.fbm('clump', { feature: 0.035, octaves: 3 })
  const W = ctx.w_m, H = ctx.h_m, nx = Math.max(1, Math.round(W * 128)), ny = Math.max(1, Math.round(H * 128)), sU = ctx.sub('blade-dither')
  const bladeU = (x, y) => hashF(Math.min(nx - 1, Math.floor((wrapM(x, W) / W) * nx)), Math.min(ny - 1, Math.floor((wrapM(y, H) / H) * ny)), sU)
  return { Gf: (x, y) => gN(x, y) + 0.20 * clump(x, y), bladeF: ctx.noise('blade-fine', { feature: 0.006 }), bladeU }
}
export const paintYard = makeRecipe({ name: 'paintYard', stock: 'floor', periodic: true, *paint(ctx) {
  const W = ctx.w_m, H = ctx.h_m, o = ctx.opts, variant = o.variant ?? 'base', sR = ctx.sub('rolls'), overlay = !!o.overlay
  if (!YARD_VARIANTS.includes(variant)) throw new Error(`paintYard: unknown variant ${variant}`)
  if (overlay && variant === 'base') throw new Error('paintYard: an overlay is a variant (gravel, tanbark, litter, glass, damp)')
  const cover = o.cover ?? 'thin'
  if (!(cover in YARD_COVER_WEAR)) throw new Error(`paintYard: unknown cover ${cover}`)
  const wear = c01(o.wear ?? YARD_COVER_WEAR[cover]), des = o.desire || null
  const dirt = mix3(ctx.col('#5A5048'), ctx.col([104, 94, 76]), 0.25), pebC = ctx.col('#7A746A'), packed = mix3(dirt, ctx.col([112, 104, 94]), 0.22)
  const grassA = tcol(ctx, '#5E6448', 0.15), grassB = tcol(ctx, '#6E7450', 0.15), hay = tcol(ctx, [122, 114, 86], 0.15), leaf = tcol(ctx, [74, 86, 54], 0.15)
  const barkC = tcol(ctx, '#4A3828', 0.5), gravC = ctx.col('#7A746A')
  const gTone = ctx.fbm('grass-tone', { feature: 0.12, octaves: 3 })
  const tuftN = ctx.fbm('tuft', { feature: 0.025, octaves: 3 }), blade = ctx.fbm('blade', { featureX: 0.012, featureY: 0.03, octaves: 2 })
  if (due()) yield
  const { Gf, bladeF, bladeU } = yardGrassField(ctx)
  if (due()) yield
  const leafC = mix3(leaf, grassB, 0.35)
  // the bare ground's mottle: crumb scale (8 cm) and finer, never a cloud
  const dN = ctx.fbm('dirt', { feature: 0.08, octaves: 3 }), dN2 = ctx.fbm('dirt2', { feature: 0.04, octaves: 2 })
  const peb = makeStones(ctx.voronoi('pebbles', { feature: 0.03, search: 1 }), ctx.sub('pebbles'), { gap: 0.001, rMin: 0.003, rMax: 0.008 })
  const weedV = ctx.voronoi('weeds', { feature: 0.22, search: 1 }), sW = ctx.sub('weeds')
  const desN = ctx.fbm('desire', { feature: 0.3, octaves: 3 })
  const PB = {}, WV = {}
  const thr = (yield* fieldStats(Gf, W, H)).q(wear)
  if (due()) yield
  const pebMean = (yield* fieldStats((x, y) => peb(x, y, 0, 0.22, PB).cov, W, H, 48)).mean
  if (due()) yield
  // the desire line: a worn band across the tile along x, y or a diagonal (diagonals wrap on a square tile)
  const desireAt = (x, y) => {
    if (!des) return 0
    const off = des.offset ?? H / 2, hw = (des.width ?? 0.45) / 2, dir = des.dir ?? 'x'
    let d
    if (dir === 'x') d = wrapD(y - off, H)
    else if (dir === 'y') d = wrapD(x - off, W)
    else d = wrapD((dir === 'd1' ? x - y : x + y) - off, W) / Math.SQRT2
    return sstep(hw * 1.15 + 0.06 * desN(x, y), hw * 0.55, Math.abs(d))
  }
  // variant decoration (each fades out over the EDGE band)
  const VC = { barkC, gravC, pebC, dirt, patch: null, overlay }, vDec = (yield* makeYardVariant(ctx, variant, W, H, VC))
  if (due()) yield
  // broadleaf weeds (plantain / dandelion rosettes): 5–7 leaves of uneven length, unevenly spaced, broad, a little paler than the
  // leaf green and part-covered by the grass blades; only one Voronoi cell in ten holds one. → coverage 0..1
  const rosetteAt = (x, y, fx, dl) => {
    weedV(x, y, WV)
    if (hashF(WV.id, 1, sW) >= 0.10 * (1 - dl)) return 0
    const R = lerp(0.03, 0.055, hashF(WV.id, 2, sW)), n = 5 + Math.floor(hashF(WV.id, 3, sW) * 3)
    const qx = -WV.dx, qy = -WV.dy                                                           // the sample relative to the rosette centre
    if (hyp(qx, qy) >= R * 1.1) return 0
    let d = -1
    const a0 = hashF(WV.id, 4, sW) * TAU
    for (let i = 0; i < n; i++) {
      const Li = R * lerp(0.55, 1.0, hashF(WV.id, 10 + i, sW)), a = a0 + (TAU * i) / n + (hashF(WV.id, 20 + i, sW) - 0.5) * 0.7
      const [lx, ly] = rot(qx, qy, -a)
      d = Math.max(d, sdLens(lx - 0.5 * Li, ly, 0.5 * Li, 0.30 * Li))
    }
    return sdCov(d, fx)
  }
  const G3 = [0, 0, 0]
  if (overlay) {
    // the variant ALONE, as a coverage overlay for the ground material: every sample starts at neutral grey 128 with nothing covered,
    // and the decoration paints its colours OVER it (premultiplied over the neutral) and accumulates its coverage in A. Exact under
    // box filtering and mips: Ground' = Ground·(1 − A) + (RGB − 128·(1 − A)). Damp is a multiply: RGB stays 128, A = wetness
    yield* ctx.raster((s) => {
      s.r = 128; s.g = 128; s.b = 128; s.cav = 0; s.h = 0
      vDec(s, s.x, s.y, s.fx, s.fy)
    })
    return { variant, overlay: true, cover: null, wear: null, desire: null, patch: VC.patch }
  }
  yield* ctx.raster((s) => {
    const x = s.x, y = s.y, fx = s.fx, fy = s.fy
    const dl = desireAt(x, y)
    // dirt: the floor colour, mottled, with sparse small pebbles; packed smooth and a little paler on the desire line
    const kd = 1 + 0.08 * dN(x, y, fx) + 0.05 * dN2(x, y, fx) * (1 - 0.5 * dl)
    const dc = mix3(dirt, packed, dl)
    setS(s, dc, kd)
    peb(x, y, fx, 0.22 * (1 - 0.6 * dl), PB)
    const pv = lerp(pebMean * (1 - 0.6 * dl), PB.cov, fadeW(0.03, fx)), pt = 0.8 + 0.3 * hashF(PB.id, 3, sR)
    mixS(s, [pebC[0] * pt, pebC[1] * pt, pebC[2] * pt], 0.8 * pv)
    // relief: the ground hugging each pebble is occluded; shallow hollows (scuffs, puddle dips) in the dirt
    const ring = PB.d < 0 && PB.d > -0.004 ? (1 + PB.d / 0.004) * fadeW(0.03, fx) : 0, hollow = sstep(-0.12, -0.38, dN2(x, y, fx))
    s.cav = 1 - 0.1 * pv - 0.3 * ring - 0.14 * hollow; s.h = 0.002 * pv - 0.006 * hollow
    mulS(s, 1 - 0.04 * hollow)
    // grass: clumped tufts where the field clears the wear threshold, thinning out blade by blade into the dirt (never an island with
    // a cut-out outline): over a ramp of the field round the threshold the sward is dithered by the blade stipple, so at 128 tpm each
    // edge breaks into single-texel blades over ~12 cm, and at a coarser footprint the mean is the soft ramp. None on the desire line
    const G0 = Gf(x, y), tn = tuftN(x, y, fx)
    const ramp = sstep(thr - 0.30, thr + 0.16, G0)
    const blades = sstep(1 - ramp - 0.08, 1 - ramp + 0.08, bladeU(x, y))
    const gc = lerp(ramp, blades, fadeW(0.016, fx)) * (1 - dl)
    if (gc > 0) {
      const tc = mix3(grassA, grassB, c01(0.5 + gTone(x, y, fx) + 0.6 * tn))
      const inner = 1 - 0.13 * c01(-2.2 * tn)                                                   // darker in the gaps between tufts
      // blade-scale stipple: one texel at 128 tpm (point-sampled on purpose), its mean at any coarser footprint
      const bl = (1 + 0.07 * blade(x, y, fx)) * (1 + 0.10 * (2 * bladeF(x, y) - 1) * fadeW(0.016, fx))
      const dry = c01((blade(x + 0.37, y, fx) - 0.15) * 3) * 0.45
      const c = mix3(tc, hay, dry)
      G3[0] = c[0] * inner * bl; G3[1] = c[1] * inner * bl; G3[2] = c[2] * inner * bl
      mixS(s, G3, gc); s.h += 0.004 * gc; s.cav = lerp(s.cav, 0.85 + 0.15 * inner, gc)
    }
    const cv = rosetteAt(x, y, fx, dl)
    if (cv > 0) { mixS(s, leafC, 0.7 * cv); s.h += 0.003 * cv }
    if (vDec) vDec(s, x, y, fx, fy)
  })
  // R.decal: the rosettes (the glyph test for decals checks that none reads as a letter or an asterisk)
  const D = newRaster(W, H, ctx.tpm, { height: false })
  yield* rasterizeSteps(D, (s) => { s.r = rosetteAt(s.x, s.y, s.fx, desireAt(s.x, s.y)) }, { ss: ctx.ss, origin: o.origin, wrap: o.wrap })
  ctx.R.decal = Float32Array.from({ length: D.w * D.h }, (_, i) => c01(D.rgb[i * 3]))
  return { variant, cover, wear, desire: des, patch: VC.patch }
} })

// the WEAR MASK of the whole park ground (not a tile): 0 = grass, 0.5 = thin worn grass, 1 = bare dirt, over the 24 × 18 cell map at
// 2 m a cell (48 × 36 m; render it at 8 texels per metre, 384 × 288). A slow field (fbm, 2.5 m, 4 octaves) breaks the ground into
// patches of thin and thick grass; desire lines 0.6–1.2 m wide wear it to dirt from the spawn (2.5, 2.5) past the note toward the
// exit (18.5, 13.5), routed round both juts with their corners cut (people cut corners), and an apron worn at the foot of each jut's
// stoop. The grass hangs on at the wall feet, the jut walls' included. Cell coordinates as levels.js; x across, y down the map (row 0 at
// the top of the texture). A renderer samples it at the world position over the map's size (48 × 36 m) and blends the covers by it.
// YARD_MAP.juts: the map's two 2-row interior blocks [x0, y0, x1, y1) in cells, as planBlockFacade finds them; a jut's body is
// jutDepth deep from its north edge (2.8 m, a cut-row slice), its front (south) face at y0 + jutDepth, its door bay at the end
// toward its own side of the park (planBlockFacade: west end if x0 + x1 + 1 < width, x1 inclusive), where its 4-riser marble stoop
// stands (a 0.45 m landing and three 0.29 m treads, so its foot is 1.32 m out from the front)
export const YARD_MAP = Object.freeze({ cells: Object.freeze([24, 18]), cell: 2, spawn: Object.freeze([2.5, 2.5]), note: Object.freeze([6.5, 6.5]),
  exit: Object.freeze([18.5, 13.5]), juts: Object.freeze([Object.freeze([8, 5, 11, 7]), Object.freeze([14, 10, 17, 12])]),   // [x0, y0, x1, y1] cells
  jutDepth: 1.4, stoopRun: 1.32 })
// the stoops of YARD_MAP's juts: { x (metres, the door bay's centre), y (metres, the stoop's foot), front (metres, the jut front) }
export function yardStoops(map = YARD_MAP) {
  const c = map.cell
  return map.juts.map(([x0, y0, x1]) => {
    const doorX = x0 + (x1 - 1) + 1 < map.cells[0] ? x0 : x1 - 1, front = (y0 + map.jutDepth) * c
    return { x: (doorX + 0.5) * c, y: front + map.stoopRun, front }
  })
}
export const paintYardWearMask = makeRecipe({ name: 'paintYardWearMask', stock: 'floor', height: false, periodic: false, *paint(ctx) {
  const W = ctx.w_m, H = ctx.h_m, c = YARD_MAP.cell
  const big = ctx.fbm('wear', { feature: 2.5, octaves: 4 }), wob = ctx.fbm('wear-wob', { feature: 1.2, octaves: 2 }), wid = ctx.fbm('wear-width', { feature: 3, octaves: 2 })
  const P = (p) => [p[0] * c, p[1] * c]
  // the path: spawn → past the note → south of the first jut's stoops → west of and below the second jut → the exit (metres)
  const [j1, j2] = YARD_MAP.juts.map((j) => j.map((v) => v * c))
  const corners = [P(YARD_MAP.spawn), [P(YARD_MAP.note)[0] - 1.0, P(YARD_MAP.note)[1] + 1.2], [j1[0] - 0.6, j1[3] + 1.3], [j1[2] + 1.0, j1[3] + 1.4],
    [j2[0] - 1.3, j2[1] + 0.4], [j2[0] - 0.4, j2[3] + 1.2], P(YARD_MAP.exit)]
  // corners cut: each interior point becomes two points 1 m back along its two legs
  const route = [corners[0]]
  for (let i = 1; i + 1 < corners.length; i++) {
    const [px, py] = corners[i], [ax, ay] = corners[i - 1], [bx, by] = corners[i + 1], la = hyp(px - ax, py - ay), lb = hyp(bx - px, by - py)
    route.push([px - ((px - ax) / la) * 1.0, py - ((py - ay) / la) * 1.0], [px + ((bx - px) / lb) * 1.0, py + ((by - py) / lb) * 1.0])
  }
  route.push(corners[corners.length - 1])
  const lines = [{ P: route.flat(), w: [0.6, 1.2], k: 1 }]
  // the stoop aprons: worn where people stand at the foot of the steps, an ellipse 2.8 × 2 m centred 0.3 m out from the foot
  const stoops = yardStoops()
  // the jut bodies (metres), for the wall-foot relief: the grass hangs on against their walls
  const bodies = YARD_MAP.juts.map(([x0, y0, x1]) => [x0 * c, y0 * c, x1 * c, (y0 + YARD_MAP.jutDepth) * c])
  const distToRect = (R, x, y) => hyp(Math.max(R[0] - x, 0, x - R[2]), Math.max(R[1] - y, 0, y - R[3]))
  const distPL = (Q, x, y) => {
    let d2 = Infinity
    for (let i = 0; i + 3 < Q.length; i += 2) {
      const ax = Q[i], ay = Q[i + 1], ex = Q[i + 2] - ax, ey = Q[i + 3] - ay, l2 = ex * ex + ey * ey, t = l2 > 0 ? c01(((x - ax) * ex + (y - ay) * ey) / l2) : 0
      const dx = ax + ex * t - x, dy = ay + ey * t - y
      d2 = Math.min(d2, dx * dx + dy * dy)
    }
    return Math.sqrt(d2)
  }
  const field = (x, y) => {
    // the base: thin and thick grass in slow patches, rarely bare (bare dirt is the lines' and the aprons')
    let v = 0.40 + 0.60 * big(x, y)
    const wx = x + 0.5 * wob(x, y), wy = y + 0.5 * wob(x + 7, y)
    for (const L of lines) {
      const hw = lerp(L.w[0], L.w[1], c01(0.5 + 1.2 * wid(x, y))) / 2, d = distPL(L.P, wx, wy)
      v = Math.max(v, L.k * sstep(hw + 0.5, hw * 0.4, d))
    }
    for (const st of stoops) {
      const q = hyp((wx - st.x) / 1.4, (wy - st.y - 0.3) / 1.0)
      if (q < 1) v = Math.max(v, 0.9 * sstep(1.0, 0.6, q))
    }
    // a little less wear right at the wall feet (out of the walking line, where the grass hangs on): the map's border and the jut walls
    const e = Math.min(x - c, W - c - x, y - c, H - c - y, distToRect(bodies[0], x, y), distToRect(bodies[1], x, y))
    if (e < 0.6) v -= 0.15 * (1 - c01(e / 0.6))
    return c01(v)
  }
  yield* ctx.raster((s) => { const v = 255 * field(s.x, s.y); s.r = v; s.g = v; s.b = v; s.cav = 1 })
  return { map: YARD_MAP, route, stoops }
} })

// the COVER RANK of the park ground (for a renderer that blends the dirt and the grass tiles by it per pixel, instead of lerping
// three covers into ghosts of each other): R = the quantile of paintYard's grass field Gf at (x, y) among the tile's samples (the same
// field and seed as paintYard: the grass of a cover with wear w is exactly where R > w, so the material's grass at wear w is
// R > w, a threshold, not a blend), G = the blade stipple (its fringe dither, as paintYard's), B = 0, A = 1. Periodic in x and y.
export const paintYardCoverRank = makeRecipe({ name: 'paintYardCoverRank', stock: 'floor', height: false, periodic: true, *paint(ctx) {
  const W = ctx.w_m, H = ctx.h_m, { Gf, bladeU } = yardGrassField(ctx)
  // the CDF of Gf over the same 64 × 64 samples paintYard's threshold is taken from, linear between neighbouring samples
  const n = 64, v = new Float64Array(n * n)
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) v[j * n + i] = Gf(((i + 0.5) * W) / n, ((j + 0.5) * H) / n)
  v.sort()
  const N = v.length
  const rank = (g) => {
    let lo = 0, hi = N
    while (lo < hi) { const m = (lo + hi) >> 1; if (v[m] < g) lo = m + 1; else hi = m }
    if (lo === 0) return 0
    if (lo === N) return 1
    return c01((lo - 1 + (g - v[lo - 1]) / Math.max(1e-12, v[lo] - v[lo - 1])) / N)
  }
  yield* ctx.raster((s) => { s.r = 255 * rank(Gf(s.x, s.y)); s.g = 255 * bladeU(s.x, s.y); s.b = 0; s.cav = 1 })
  return { samples: N }
} })

// the yard variants → a decorator (s, x, y, fx, fy). Over a ground (C.overlay false) it mixes into the ground and edits its cavity and
// height; as an overlay (C.overlay true) it paints over the neutral start and accumulates its coverage in s.cav, and leaves the relief
// alone (the overlay has no cavity or height of its own)
function* makeYardVariant(ctx, variant, W, H, C) {
  if (variant === 'base') return null
  const ov = !!C.overlay
  // paint c over the sample at t: as an overlay, also add t to the coverage (A = 1 − Π(1 − t), the colour premultiplied over neutral)
  const put = ov ? (s, c, t) => { if (t > 0) { mixS(s, c, t); s.cav += t - s.cav * t } } : mixS
  const sV = ctx.sub('variant-' + variant)
  const cx = lerp(0.3, 0.7, hashF(0, 1, sV)) * W, cy = lerp(0.3, 0.7, hashF(0, 2, sV)) * H
  const patchN = ctx.fbm('vpatch-' + variant, { feature: 0.22, octaves: 4 }), sq = lerp(0.75, 1.3, hashF(0, 3, sV)), tilt = hashF(0, 4, sV) * Math.PI
  // a soft, irregular patch off the tile centre (an fbm-edged, seeded ellipse), its size seeded, small enough for its place that the
  // EDGE-band fade never squares it (so the variant cells do not form a grid of centred blobs of one size)
  const patch = (x, y, R) => {
    const [px, py] = rot(wrapD(x - cx, W), wrapD(y - cy, H), tilt)
    const d = hyp(px * sq, py / sq) / R + 0.45 * patchN(x, y)
    return sstep(1.0, 0.65, d) * variantFade(x, y, W, H)
  }
  const room = (Math.min(cx, W - cx, cy, H - cy) - 10 / 32) / (1.25 * Math.max(sq, 1 / sq))
  const RP = Math.max(0.12, Math.min(lerp(0.2, 0.38, hashF(0, 5, sV)) * Math.min(W, H), room))
  if (variant !== 'litter') C.patch = { x: cx, y: cy, r: RP }                               // reported in the yard's meta
  if (variant === 'gravel') {
    const st = makeStones(ctx.voronoi('gravel', { feature: 0.02, search: 1 }), sV, { gap: 0.0015, rMin: 0.006, rMax: 0.0135 }), O = {}
    const mean = (yield* fieldStats((x, y) => st(x, y, 0, 0.8, O).cov, W, H, 48)).mean
    const fines = [C.dirt[0] * 0.86, C.dirt[1] * 0.86, C.dirt[2] * 0.86]
    return (s, x, y, fx) => {
      const p = patch(x, y, RP)
      if (p <= 0) return
      st(x, y, fx, 0.85 * p, O)
      const t = 0.82 + 0.34 * hashF(O.id, 5, sV), pale = hashF(O.id, 6, sV) < 0.08 ? 1.22 : 1
      const v = lerp((mean * 0.85 * p) / 0.8, O.cov, fadeW(0.02, fx)), c = [C.gravC[0] * t * pale, C.gravC[1] * t * pale, C.gravC[2] * t * pale]
      put(s, ov ? fines : [s.r * 0.86, s.g * 0.86, s.b * 0.86], 0.5 * p)                // the gravel bed's fines
      put(s, c, v)
      if (!ov) { s.cav = lerp(s.cav, 0.8 + 0.2 * v, p); s.h += 0.006 * v }
    }
  }
  if (variant === 'tanbark') {
    const vor = ctx.voronoi('bark', { feature: 0.03, search: 1 }), O = {}
    const humus = mix3(C.barkC, ctx.col('#5A5048'), 0.45)
    return (s, x, y, fx) => {
      const p = patch(x, y, RP)
      if (p <= 0) return
      put(s, humus, 0.7 * p)                                                                  // decayed bark: a dark bed, the grass mostly gone
      vor(x, y, O)
      if (hashF(O.id, 1, sV) >= 0.8 * p) return
      const a = hashF(O.id, 2, sV) * Math.PI, L = lerp(0.012, 0.03, hashF(O.id, 3, sV)), b = lerp(0.004, 0.009, hashF(O.id, 4, sV))
      const [lx, ly] = rot(-O.dx, -O.dy, -a), d = Math.min(O.edge - 0.001, (1 - hyp(lx / L, ly / b)) * b)
      const cv = sdCov(d, fx), grey = hashF(O.id, 5, sV) * 0.35, t = 0.85 + 0.3 * hashF(O.id, 6, sV)
      const c = mix3(C.barkC, ov ? humus : [s.r, s.g, s.b], grey)                            // weathered chips grey toward the bed
      put(s, [c[0] * t, c[1] * t, c[2] * t], cv)
      if (!ov) s.h += 0.003 * cv
    }
  }
  if (variant === 'litter') {
    const vor = ctx.voronoi('litter', { feature: 0.16, search: 1 }), O = {}
    const plastic = [tcol(ctx, [92, 104, 120], 0.1), tcol(ctx, [120, 86, 78], 0.1), tcol(ctx, [96, 110, 88], 0.1)]
    const paper = tcol(ctx, [178, 174, 162], 0.1), butt = tcol(ctx, [170, 150, 116], 0.1), metal = tcol(ctx, [124, 122, 116], 0.1)
    return (s, x, y, fx) => {
      const vf = variantFade(x, y, W, H)
      if (vf <= 0) return
      vor(x, y, O)
      if (hashF(O.id, 1, sV) >= 0.4) return
      const kind = hashF(O.id, 2, sV), a = hashF(O.id, 3, sV) * Math.PI, [lx, ly] = rot(-O.dx, -O.dy, -a)
      let d, c
      if (kind < 0.45) { const hx = lerp(0.008, 0.022, hashF(O.id, 4, sV)), hy = hx * lerp(0.5, 0.9, hashF(O.id, 5, sV)); d = Math.min(hx - Math.abs(lx + 0.15 * ly), hy - Math.abs(ly)); c = mix3(paper, ov ? C.dirt : [s.r, s.g, s.b], 0.25 * hashF(O.id, 6, sV)) }
      else if (kind < 0.7) { d = sdCapsule(lx, ly, -0.011, 0, 0.011, 0, 0.004); c = butt }
      else if (kind < 0.85) { d = 0.013 - hyp(lx, ly); c = metal }
      else { const hx = lerp(0.008, 0.018, hashF(O.id, 4, sV)); d = Math.min(hx - Math.abs(lx), 0.6 * hx - Math.abs(ly + 0.3 * lx)); c = plastic[Math.floor(hashF(O.id, 7, sV) * 3)] }
      const cv = sdCov(Math.min(d, O.edge), fx) * vf
      put(s, c, cv)
      if (!ov) s.h += 0.001 * cv
    }
  }
  if (variant === 'glass') {
    const vor = ctx.voronoi('glass', { feature: 0.04, search: 1 }), O = {}
    const cols = [tcol(ctx, [96, 72, 44], 0.1), tcol(ctx, [70, 96, 66], 0.1), tcol(ctx, [142, 148, 142], 0.1)], glint = [212, 212, 204]
    return (s, x, y, fx) => {
      const p = patch(x, y, 1.1 * RP)
      if (p <= 0) return
      vor(x, y, O)
      if (hashF(O.id, 1, sV) >= 0.55 * p) return
      const a = hashF(O.id, 2, sV) * TAU, sz = lerp(0.005, 0.016, hashF(O.id, 3, sV)), [lx, ly] = rot(-O.dx, -O.dy, -a)
      const d = Math.min(sz - Math.abs(lx), 0.55 * sz - Math.abs(ly) - 0.4 * lx, O.edge)                // an angular shard
      const cv = sdCov(d, fx), c = cols[Math.floor(hashF(O.id, 4, sV) * 3)]
      put(s, c, 0.85 * cv)
      const gl = sdCov(0.0025 - hyp(lx - 0.4 * sz, ly), fx) * (hashF(O.id, 5, sV) < 0.6 ? 1 : 0)
      put(s, glint, 0.9 * gl)
    }
  }
  // 'damp': a darker, more saturated patch (water standing in a low spot) with a wetter core. As an overlay: A = the wetness, RGB
  // neutral (the ground material multiplies: Ground·lerp(1, 0.78, A))
  return (s, x, y) => {
    const [px, py] = rot(wrapD(x - cx, W), wrapD(y - cy, H), tilt)
    const d = hyp(px * sq, py / sq) / (1.15 * RP) + 0.45 * patchN(x, y), vf = variantFade(x, y, W, H)
    const wet = sstep(1.0, 0.6, d) * vf, core = sstep(0.5, 0.25, d) * vf
    if (wet <= 0) return
    if (ov) { s.cav = wet; return }
    const l = lumS(s), k = 1 - 0.24 * wet
    s.r = (l + (s.r - l) * 1.18) * k; s.g = (l + (s.g - l) * 1.18) * k; s.b = (l + (s.b - l) * 1.18) * k
    mixS(s, [s.r * 0.78, s.g * 0.78, s.b * 0.80], core)
    s.cav = lerp(s.cav, 1, 0.6 * core)
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  §10 Window interiors (O lit, W void; paintShade): what is seen through the opening. The sash and frame are not
//  painted unless opts.sash asks (the game's tiles paint a '1/1' sash). Lit: a roller shade #D8CCB0 pulled 40–70% down and lit warm from behind, a
//  curtain pair, a lamp gradient toward [255, 190, 110]; every value <= BLOOM_CAP. Dark: the shade drawn, unlit. Void: no glass, the
//  room 7–25/255 with a faint corner and ceiling line, optionally one hanging sash rail.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export const WINDOW_VARIANTS = Object.freeze(['base', 'blinds', 'sheer', 'sage'])
export const WINDOW_MODES = Object.freeze(['lit', 'dark', 'void'])
export const WINDOW_SASH = Object.freeze(['none', '1/1', '2/2'])
export const VOID_RANGE = Object.freeze([7, 24])         // the void interior's grey level d (luma ≈ 1.02·d + 0.4): 7–25/255
const LAMP = [255, 190, 110]

export function sheenColour(rgb, amount = GLASS_SHEEN, sky = SKY_HEX) {
  const k = hexToRgb(sky)
  return [rgb[0] + (k[0] - rgb[0]) * amount, rgb[1] + (k[1] - rgb[1]) * amount, rgb[2] + (k[2] - rgb[2]) * amount]
}
// the glass reflects a little of the overcast sky in soft diagonal streaks; the factor averages `amount` over a streak period
const sheenK = (x, y, amount) => amount * (1 + 0.35 * Math.sin((TAU * (0.8 * x + 0.45 * y)) / 0.9))
export function glassSheen(R, o = {}) {
  const a = o.amount ?? GLASS_SHEEN, sky = hexToRgb(o.sky ?? SKY_HEX), streak = o.streak !== false
  for (let ty = 0; ty < R.h; ty++) for (let tx = 0; tx < R.w; tx++) {
    const i = (ty * R.w + tx) * 3, k = streak ? sheenK((tx + 0.5) * R.sx, (ty + 0.5) * R.sy, a) : a
    for (let c = 0; c < 3; c++) R.rgb[i + c] = Math.min(BLOOM_CAP, R.rgb[i + c] + (sky[c] - R.rgb[i + c]) * k)
  }
  return R
}

function* windowLitDark(ctx) {
  const W = ctx.w_m, H = ctx.h_m, o = ctx.opts, mode = o.mode ?? 'lit', variant = o.variant ?? 'base', sR = ctx.sub('rolls')
  if (!WINDOW_VARIANTS.includes(variant)) throw new Error(`paintWindowInterior: unknown variant ${variant}`)
  const lit = mode === 'lit', sheen = !!o.sheen, sash = o.sash ?? 'none', sky = hexToRgb(SKY_HEX)
  if (!WINDOW_SASH.includes(sash)) throw new Error(`paintWindowInterior: unknown sash ${sash}`)
  const sf = lit ? c01(o.shade ?? lerp(0.4, 0.7, hashF(0, 1, sR))) : 1
  const lx = lerp(0.3, 0.7, hashF(0, 2, sR)), ly = lerp(0.58, 0.78, hashF(0, 3, sR))
  const T = (c) => tcol(ctx, c, 0.2)
  const shadeC = T('#D8CCB0'), lampC = T(LAMP.map((v) => v * 0.847)), wallC = T([196, 140, 84]), deepC = T([92, 62, 38]), furnC = T([54, 38, 26])
  const curtains = { base: [[168, 124, 104], [176, 140, 92], [140, 104, 80]][Math.floor(hashF(0, 4, sR) * 3)], blinds: [150, 118, 96], sheer: null, sage: [118, 130, 100] }
  const cloth = curtains[variant] ? T(curtains[variant]) : null
  const curtL = variant === 'base' || variant === 'sage', curtR = variant !== 'sheer'
  const cwL = lerp(0.16, 0.26, hashF(0, 5, sR)), cwR = lerp(0.16, 0.26, hashF(0, 6, sR)), phL = hashF(0, 7, sR) * TAU, phR = hashF(0, 8, sR) * TAU
  const fold = lerp(0.06, 0.085, hashF(0, 9, sR)), furnY = lerp(0.80, 0.88, hashF(0, 10, sR))
  // the back of a sofa or an armchair low in the room: a flat top with rounded corners, running past an edge or not
  const fa = lerp(-0.15, 0.35, hashF(0, 11, sR)) * W, fb = fa + lerp(0.5, 0.9, hashF(0, 12, sR)) * W, fr = 0.04
  const fab = ctx.fbm('fabric', { featureX: 0.02, featureY: 0.06, octaves: 2 }), rip = ctx.fbm('ripple', { featureX: 0.05, featureY: 0.5, octaves: 2 })
  const room = ctx.fbm('room', { feature: 0.2, octaves: 3 }), sheerC = T([214, 206, 188]), vinyl = [206, 204, 196], hemC = T([92, 74, 54])
  const glow = (u, v, su, sv) => Math.exp(-(((u - lx) * (u - lx)) / su + ((v - ly) * (v - ly)) / sv))
  yield* ctx.raster((s) => {
    const x = s.x, y = s.y, fx = s.fx, fy = s.fy, u = x / W, v = y / H
    const g = glow(u, v, 0.10, 0.07), gw = glow(u, v, 0.5, 0.45)
    // the room behind: the far wall lit by the lamp, darker up toward the ceiling, furniture low down
    if (lit) {
      const c = mix3(deepC, wallC, c01(0.25 + 0.55 * gw + 0.08 * room(x, y, fx)))
      setS(s, mix3(c, lampC, g * g), 0.82 + 0.18 * v)
      const ix = Math.min(x - fa, fb - x), iy = y - furnY * H
      const sdF = ix < fr && iy < fr ? fr - hyp(fr - ix, fr - iy) : Math.min(ix, iy)
      if (sdF > -0.01) {
        const kf = 1 + 0.35 * Math.exp(-Math.max(0, iy) / 0.025) * (0.4 + 0.6 * gw)            // the lamp catches its top edge
        mixS(s, [furnC[0] * kf, furnC[1] * kf, furnC[2] * kf], sdCov(sdF, Math.min(fx, fy)) * 0.92)
      }
      if (ly > sf + 0.08) {                                                                 // a lampshade, if the shade does not hide it
        const dy = (v - ly) * H + 0.03, hw = lerp(0.034, 0.058, c01((dy + 0.05) / 0.10))
        const inside = Math.min(hw - Math.abs((u - lx) * W), 0.05 - Math.abs(dy))
        mixS(s, T([210, 170, 112]), sdCov(inside, Math.min(fx, fy)) * 0.92)
      }
    } else setS(s, T([14, 12, 11]))
    // the shade (or the blinds): backlit and warm when lit, flat and grey-beige by daylight when dark
    const hemY = lit ? sf * H : H - 0.02                                                       // drawn: a dark 2 cm gap stays at the sill
    if (y < hemY + 0.011) {
      const tex = 1 + 0.02 * fab(x, y, fx) + 0.015 * rip(x, y, fx)
      let c
      if (lit) { const tr = 0.70 + 0.26 * glow(u, v, 0.6, 0.9); c = [shadeC[0] * tr, shadeC[1] * 0.90 * tr, shadeC[2] * 0.72 * tr] }
      else { const tr = 0.42 + 0.12 * v; c = [shadeC[0] * tr, shadeC[1] * tr, shadeC[2] * tr * 1.02] }
      if (variant === 'blinds') {
        const ph = (y % 0.025) / 0.025, slat = sstep(0.0, 0.12, ph) * sstep(1.0, 0.85, ph)
        const kk = (0.55 + 0.45 * slat) * (0.95 + 0.08 * Math.sin(ph * Math.PI))
        c = [c[0] * kk, c[1] * kk, c[2] * kk]
        for (const su of [0.18, 0.82]) { const l = box1(u * W - su * W, 0.0012, fx); c = mix3(c, [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6], l) }
      }
      const cov = sdCov(hemY - y, fy)
      mixS(s, [c[0] * tex, c[1] * tex, c[2] * tex], cov)
      if (y < 0.035) mulS(s, 0.62 + 0.38 * sstep(0.0, 0.035, y))                             // the roller in the head
      const hem = box1(y - (hemY - 0.011), 0.011, fy)
      mixS(s, lit ? hemC : mix3(hemC, [0, 0, 0], 0.4), hem)
    }
    if (lit && variant !== 'blinds') {                                                        // the pull cord and a solid acorn pull
      // (never a hollow ring: at every lit window it would read as a letter o or a zero)
      const cy = hemY + 0.04
      const pull = sdCov(0.007 - hyp(x - W / 2, (y - cy) / 1.6), Math.min(fx, fy))
      const cordK = box1(x - W / 2, 0.0008, fx) * (y > hemY && y < cy - 0.009 ? 1 : 0)
      mixS(s, hemC, Math.min(1, pull + cordK))
    }
    // the sheer: a pale veil over everything, soft vertical folds
    if (variant === 'sheer') {
      const fv = 0.9 + 0.1 * Math.sin((TAU * x) / 0.05 + 0.6 * Math.sin(v * 4))
      const vc = lit ? [sheerC[0] * (0.6 + 0.35 * gw) * fv, sheerC[1] * (0.55 + 0.33 * gw) * fv, sheerC[2] * (0.45 + 0.3 * gw) * fv] : [sheerC[0] * 0.4 * fv, sheerC[1] * 0.4 * fv, sheerC[2] * 0.4 * fv]
      mixS(s, vc, 0.42)
    }
    // the curtain pair: thin fabric, backlit (lit) or flat (dark), folds as vertical bands, a darker inner edge, a rod across the top
    if (cloth) {
      for (const side of [0, 1]) {
        if ((side === 0 && !curtL) || (side === 1 && !curtR)) continue
        const cw = (side === 0 ? cwL : cwR) * W, ph = side === 0 ? phL : phR
        const xe = side === 0 ? x : W - x, edgeX = cw + 0.012 * Math.sin(v * 5.3 + ph) + 0.02 * v
        const cov = sdCov(edgeX - xe, fx)
        if (cov <= 0) continue
        const f = 0.5 + 0.5 * Math.sin((TAU * xe) / fold + 0.8 * Math.sin(v * 3 + ph))
        const inner = 1 - 0.3 * Math.exp(-(edgeX - xe) / 0.012)
        const kk = lit ? (0.40 + 0.28 * f + 0.28 * gw) * inner : (0.30 + 0.12 * f) * inner
        mixS(s, [cloth[0] * kk, cloth[1] * kk, cloth[2] * kk], cov)
      }
      mixS(s, T([66, 50, 38]), sdCov(0.03 - y, fy) * (lit ? 1 : 0.8))
    }
    s.cav = 1; s.h = 0
    // the white sash and frame, painted only when opts.sash asks (the game's tiles): '1/1' vinyl (two lites, the meeting rail
    // across the middle) or '2/2' (four panes: a muntin down each sash as well, the legacy tile's look and the original sash)
    if (sash === '1/1' || sash === '2/2') {
      const e = Math.min(x, W - x, y, H - y), fr = sdCov(0.035 - e, Math.min(fx, fy)), mr = box1(y - H / 2, 0.022, fy)
      const k = Math.max(fr, mr, sash === '2/2' ? box1(x - W / 2, 0.011, fx) : 0)
      mixS(s, vinyl, k); s.cav = 1 - 0.3 * box1(y - H / 2 - 0.022, 0.002, fy); s.h = 0.02 * k
    }
    if (sheen) { const k = sheenK(x, y, GLASS_SHEEN); s.r += (sky[0] - s.r) * k; s.g += (sky[1] - s.g) * k; s.b += (sky[2] - s.b) * k }
    capS(s)
  })
  return { mode, variant, shade: sf, lamp: [lx, ly], curtains: cloth ? [curtL, curtR] : [false, false], sash, sheen }
}

function* windowVoid(ctx) {
  const W = ctx.w_m, H = ctx.h_m, o = ctx.opts, sR = ctx.sub('rolls')
  const cx = lerp(0.55, 0.78, hashF(0, 1, sR)), cl = lerp(0.10, 0.18, hashF(0, 2, sR)), noise = ctx.fbm('grain', { feature: 0.03, octaves: 2 })
  const rail = !!o.rail, ra = (hashF(0, 3, sR) < 0.5 ? -1 : 1) * lerp(0.07, 0.2, hashF(0, 4, sR)), rx = lerp(0.25, 0.75, hashF(0, 5, sR)) * W
  const rl = lerp(0.25, 0.45, hashF(0, 6, sR)) * H, rw = 0.045, broken = ctx.fbm('rail-end', { feature: 0.01, octaves: 2 })
  const wood = ctx.col([118, 112, 100]), woodBare = ctx.col([74, 68, 60]), peelN = ctx.fbm('rail-peel', { featureX: 0.02, featureY: 0.08, octaves: 3 })
  const col = (d) => ctx.col([d, d + 0.4, d * 1.16 + 1.4])
  yield* ctx.raster((s) => {
    const x = s.x, y = s.y, fx = s.fx, u = x / W, v = y / H
    // nearly black: darkest at the top-left where the reveal shades it, a whisper lighter low down (the legacy blackWindowSet values)
    let d = 8 + 10 * v * v + 5 * (1 - u) * v - (1 - v) * (1 - u)                           // 7 at the top-left .. 23 at the foot
    d += 1.1 * noise(x, y, fx)
    d += 3.5 * box1(u - cx, 0.004 / W, fx / W) * sstep(cl - 0.02, cl + 0.05, v)             // the corner of a room, barely there
    d += 3 * box1(v - cl, 0.003 / H, s.fy / H) * sstep(cx - 0.45, cx - 0.3, u)              // a ceiling line
    setS(s, col(d < VOID_RANGE[0] ? VOID_RANGE[0] : d > VOID_RANGE[1] ? VOID_RANGE[1] : d)); s.cav = 0.35; s.h = -0.3
    if (rail) {                                                                               // one sash rail, hanging askew from the head
      const [lx, ly] = rot(x - rx, y, -ra), endY = rl + 0.012 * broken(x, y, fx)
      const inside = Math.min(rw / 2 - Math.abs(lx), endY - ly, ly + 0.01)
      const cov = sdCov(inside, fx)
      if (cov > 0) {
        const pe = sstep(0.05, 0.2, peelN(x, y, fx)), shade = 0.75 + 0.25 * c01(0.5 - lx / rw) - 0.25 * c01(ly / rl)
        const c = mix3(wood, woodBare, pe)
        mixS(s, [c[0] * shade, c[1] * shade, c[2] * shade], cov); s.cav = lerp(s.cav, 0.9, cov); s.h = lerp(s.h, -0.05, cov)
      }
    }
    capS(s)
  })
  return { mode: 'void', rail, corner: cx, ceiling: cl, railAt: rail ? { x: rx, angle: ra, length: rl } : null }
}

const winLitDark = makeRecipe({ name: 'paintWindowInterior', stock: 'O', periodic: false, paint: windowLitDark })
const winVoid = makeRecipe({ name: 'paintWindowInterior', stock: 'W', periodic: false, paint: windowVoid })
export function paintWindowInterior(w_m, h_m, tpm, seed, matHex, opts = {}) {
  const mode = opts.mode ?? 'lit'
  if (!WINDOW_MODES.includes(mode)) throw new Error(`paintWindowInterior: unknown mode ${mode}`)
  return (mode === 'void' ? winVoid : winLitDark)(w_m, h_m, tpm, seed, matHex, opts)
}
paintWindowInterior.recipeName = 'paintWindowInterior'; paintWindowInterior.stock = Object.freeze({ lit: 'O', dark: 'O', void: 'W' }); paintWindowInterior.periodic = false
paintWindowInterior.steps = (w_m, h_m, tpm, seed, matHex, opts = {}) => {
  const mode = opts.mode ?? 'lit'
  if (!WINDOW_MODES.includes(mode)) throw new Error(`paintWindowInterior: unknown mode ${mode}`)
  return (mode === 'void' ? winVoid : winLitDark).steps(w_m, h_m, tpm, seed, matHex, opts)
}

// paintShade (the name of the lit art of O): paintWindowInterior in 'lit' mode, its variants and options
export function paintShade(w_m, h_m, tpm, seed, matHex, opts = {}) { return winLitDark(w_m, h_m, tpm, seed, matHex, { ...opts, mode: 'lit' }) }
paintShade.recipeName = 'paintShade'; paintShade.stock = 'O'; paintShade.periodic = false
paintShade.steps = (w_m, h_m, tpm, seed, matHex, opts = {}) => winLitDark.steps(w_m, h_m, tpm, seed, matHex, { ...opts, mode: 'lit' })

export const SURFACE_RECIPES = Object.freeze({ paintPlywood, paintPlacard, paintPaintedWood, paintDoorLeaf, paintVentPanel, paintAsphalt, paintConcrete, paintGranite, paintYard,
  paintYardWearMask, paintYardCoverRank, paintWindowInterior, paintShade })

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  PART IV — THE BAY COMPOSITOR (paintBayElevation): one bay's elevation from the recipes above
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// A bay's elevation is a cladding FIELD (a periodic recipe over the whole w × h) with PIECES laid into it in order: a door frame, an
// infill, a board, a window, a sill, an arch, a placard. Every piece is its own recipe rendered at its own size and pasted at its rect,
// snapped to whole texels, so a piece's layout (its blocks, sheets, panes) is its own and is never stretched. The renderers are unlit
// and shadowless, so the joins are occlusion only, never a light direction: a piece set back in a reveal darkens toward its edges, a piece
// standing proud darkens the wall round it, a projecting piece darkens the wall under it, and an up-facing edge takes the sky a little.
//
//   paintBayElevation(spec, tpm = JS_TPM, cache = null) → Raster (rgb, cav; no height) of spec.w × spec.h metres at tpm
//     (paintBayElevationSteps(spec, tpm, cache): the same build as a stepped job, §3b)
//     spec   = { w, h, field: Part | [Part & { y: [y0, y1] }, ...] | null, pieces: [Piece, ...] }   metres, y DOWN from the top of the
//              elevation (as every recipe); a list of fields is a STACK, each part rendered at w × (y1 - y0) and laid at its rows (a storey
//              band over another: the storeys stack the bays' 2 m tiles); with no field the pieces must cover the elevation themselves
//              (it starts black)
//     Part   = { recipe: a RECIPES name, seed: uint32, hex: the material hex (null: the recipe's stock), opts: the recipe's opts }
//     Piece  = Part & { rect: [x0, y0, x1, y1] metres (snapped to whole texels), and optionally:
//                clip:   { kind: 'trapezoid', inset } the piece's shape: its bottom edge `inset` metres narrower at each end (a jack arch)
//                reveal: { width, k } set back in a reveal: darkened by up to k toward its left, right and top edges
//                ring:   { width, k } standing proud (a board): the elevation round its left, right and top edges darkened by up to k
//                below:  { width, k } projecting (a sill, a step): the elevation under it darkened by up to k
//                lit:    { width, k, edge } (or a list of them) an edge band of the piece brightened by up to k: its top edge by
//                        default, which faces the sky (up-facing ×1.06), or edge 'bottom'; a negative k darkens the band
//                        (the shadow line under a projecting nosing) }
//     cache  an optional Map shared by the bays of ONE build: a recipe render is keyed by its arguments, so a field or a piece that two
//            bays share (the same brick under a door and under a window) is painted once. Rasters in it are read, never written.
//   R.meta = { pieces: [{ recipe, rect (texels), meta }] }: what each piece's painter reported (the crew mark, the board's layout, ...)
//   Every falloff is in metres, so a 128 tpm elevation is the same picture as the 32 tpm one.
export const RECIPES = Object.freeze({ ...MASONRY_RECIPES, ...SURFACE_RECIPES })

function* renderPart(part, w_m, h_m, tpm, cache) {
  const recipe = RECIPES[part.recipe]
  if (!recipe) throw new Error(`paintBayElevation: unknown recipe ${part.recipe}`)
  const key = cache ? JSON.stringify([part.recipe, w_m, h_m, tpm, part.seed >>> 0, part.hex ?? null, part.opts ?? {}]) : null
  if (cache && cache.has(key)) return cache.get(key)
  const R = recipe.steps ? yield* recipe.steps(w_m, h_m, tpm, part.seed >>> 0, part.hex ?? null, part.opts ?? {})
    : recipe(w_m, h_m, tpm, part.seed >>> 0, part.hex ?? null, part.opts ?? {})
  if (cache) cache.set(key, R)
  return R
}
// the share of texel (tx, ty) of a piece of w × h texels that its clip shape covers (4 × 4 sample points)
function clipCover(clip, tx, ty, w, h, tpm) {
  if (!clip) return 1
  if (clip.kind !== 'trapezoid') throw new Error(`paintBayElevation: unknown clip ${clip.kind}`)
  const inset = clip.inset * tpm
  let n = 0
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    const u = tx + (i + 0.5) / 4, v = ty + (j + 0.5) / 4, d = (inset * v) / h
    if (u >= d && u <= w - d) n++
  }
  return n / 16
}
const falloff = (d, width) => 1 - sstep(0, width, d)          // 1 at the edge, 0 from `width` on

// paintBayElevation(spec, tpm, cache) builds the elevation in one go; paintBayElevationSteps the same build as a stepped job (§3b)
export function paintBayElevation(spec, tpm = JS_TPM, cache = null) { return drain(paintBayElevationSteps(spec, tpm, cache)) }
export function* paintBayElevationSteps(spec, tpm = JS_TPM, cache = null) {
  const W = spec.w, H = spec.h
  const R = newRaster(W, H, tpm, { height: false })
  if (Array.isArray(spec.field)) {                               // a stack of fields, each over its own rows
    for (const f of spec.field) {
      const r0 = Math.round(f.y[0] * tpm), r1 = Math.round(f.y[1] * tpm)
      if (!(r1 > r0) || r0 < 0 || r1 > R.h) throw new Error('paintBayElevation: a stacked field lies outside the elevation')
      const F = yield* renderPart(f, W, (r1 - r0) / tpm, tpm, cache)
      if (F.w !== R.w || F.h !== r1 - r0) throw new Error('paintBayElevation: a stacked field does not cover its rows')
      R.rgb.set(F.rgb, r0 * R.w * 3); R.cav.set(F.cav, r0 * R.w)
      if (due()) yield
    }
  } else if (spec.field && spec.field.rgb) {                     // a raster already made (a stack whose seams were evened first)
    const F = spec.field
    if (F.w !== R.w || F.h !== R.h) throw new Error('paintBayElevation: the field raster does not cover the elevation')
    R.rgb.set(F.rgb); R.cav.set(F.cav)
    if (due()) yield
  } else if (spec.field) {                                       // (no field: the pieces must cover the elevation themselves)
    const F = yield* renderPart(spec.field, W, H, tpm, cache)
    if (F.w !== R.w || F.h !== R.h) throw new Error('paintBayElevation: the field does not cover the elevation')
    R.rgb.set(F.rgb); R.cav.set(F.cav)
    if (due()) yield
  }
  const metas = []
  for (const p of spec.pieces ?? []) {
    const [x0, y0, x1, y1] = p.rect
    const px0 = Math.round(x0 * tpm), py0 = Math.round(y0 * tpm), px1 = Math.round(x1 * tpm), py1 = Math.round(y1 * tpm)
    const pw = px1 - px0, ph = py1 - py0
    if (pw <= 0 || ph <= 0 || px0 < 0 || py0 < 0 || px1 > R.w || py1 > R.h) throw new Error(`paintBayElevation: ${p.recipe} rect outside the elevation`)
    const P = yield* renderPart(p, pw / tpm, ph / tpm, tpm, cache)
    if (due()) yield
    layPiece(R, p, P, px0, py0, px1, py1, tpm)
    metas.push({ recipe: p.recipe, rect: [px0, py0, px1, py1], meta: P.meta ?? null })
    if (due()) yield
  }
  clampRgb(R.rgb)
  R.meta = { pieces: metas }
  return R
}
// one piece P laid into the elevation R at texels [px0, px1) × [py0, py1): its ring and its shadow below first, then the piece itself
function layPiece(R, p, P, px0, py0, px1, py1, tpm) {
  const pw = px1 - px0, ph = py1 - py0, sx = R.sx, sy = R.sy
  const darken = (t, k) => { R.rgb[t * 3] *= k; R.rgb[t * 3 + 1] *= k; R.rgb[t * 3 + 2] *= k; R.cav[t] *= k }
  const lits = p.lit ? (Array.isArray(p.lit) ? p.lit : [p.lit]) : []
  if (P.w !== pw || P.h !== ph) throw new Error(`paintBayElevation: ${p.recipe} rendered ${P.w} × ${P.h}, expected ${pw} × ${ph}`)
  // round it first: proud (ring) and projecting (below) darken the elevation the piece will not cover
  if (p.ring) {
    const ww = Math.ceil(p.ring.width * tpm)
    for (let ty = Math.max(0, py0 - ww); ty < py1; ty++) for (let tx = Math.max(0, px0 - ww); tx < Math.min(R.w, px1 + ww); tx++) {
      if (tx >= px0 && tx < px1 && ty >= py0) continue
      const dx = tx < px0 ? (px0 - tx - 0.5) * sx : tx >= px1 ? (tx - px1 + 0.5) * sx : 0
      const dy = ty < py0 ? (py0 - ty - 0.5) * sy : 0
      darken(ty * R.w + tx, 1 - p.ring.k * falloff(Math.max(dx, dy), p.ring.width))
    }
  }
  if (p.below) {
    const ww = Math.ceil(p.below.width * tpm)
    for (let ty = py1; ty < Math.min(R.h, py1 + ww); ty++) for (let tx = px0; tx < px1; tx++) {
      darken(ty * R.w + tx, 1 - p.below.k * falloff((ty - py1 + 0.5) * sy, p.below.width))
    }
  }
  for (let ty = 0; ty < ph; ty++) for (let tx = 0; tx < pw; tx++) {
    const c = clipCover(p.clip, tx, ty, pw, ph, tpm)
    if (c <= 0) continue
    const s = ty * pw + tx, t = (py0 + ty) * R.w + px0 + tx
    const u = (tx + 0.5) * sx, v = (ty + 0.5) * sy
    let k = 1
    if (p.reveal) k *= 1 - p.reveal.k * falloff(Math.min(u, pw * sx - u, v), p.reveal.width)
    for (const L of lits) k *= 1 + L.k * falloff(L.edge === 'bottom' ? ph * sy - v : v, L.width)
    for (let ch = 0; ch < 3; ch++) R.rgb[t * 3 + ch] += (P.rgb[s * 3 + ch] * k - R.rgb[t * 3 + ch]) * c
    R.cav[t] += (P.cav[s] * Math.min(1, k) - R.cav[t]) * c
  }
}
const clampRgb = (a) => { for (let i = 0; i < a.length; i++) { const v = a[i]; a[i] = v < 0 ? 0 : v > 255 ? 255 : v } }

// cutBands(R, rows = R.w) → [band 0, band 1, ...]: an elevation cut into tiles of `rows` texel rows from the FOOT up (band 0 is the bottom
// of the elevation), each a raster of its own (rgb, cav). For the storeys: a storey stack's 2 m bands, 64 × 64 at 32 texels a
// metre. The elevation must be a whole number of bands tall.
export function cutBands(R, rows = R.w) {
  const n = R.h / rows
  if (!Number.isInteger(n) || n < 1) throw new Error(`cutBands: ${R.h} rows are not a whole number of ${rows}-row bands`)
  const out = []
  for (let b = 0; b < n; b++) {
    const r0 = R.h - (b + 1) * rows
    const T = newRaster(R.w * R.sx, rows * R.sy, R.tpm, { height: false })
    if (T.w !== R.w || T.h !== rows) throw new Error('cutBands: a band does not keep the elevation\'s texel grid')
    T.rgb.set(R.rgb.subarray(r0 * R.w * 3, (r0 + rows) * R.w * 3)); T.cav.set(R.cav.subarray(r0 * R.w, (r0 + rows) * R.w))
    out.push(T)
  }
  return out
}
