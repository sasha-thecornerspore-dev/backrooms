// gfx-gl-post-shaders.js — the GLSL ES 3.00 sources of the GPU post pass (one string per program). Pure data: import-safe in Node. Colours are in the
// same non-linear 0..1 space the CPU uses (byte / 255), no sRGB conversion. Textures are stored bottom-up like every GL texture; where a shader needs
// "the row from the top" (grain tile, particle positions, the bloom grids) it computes it as `size.y - 1 - int(gl_FragCoord.y)`.
// The stages and the CPU code each mirrors are named next to them (gfx-post.js).
import { FULLSCREEN_VS } from './gfx-gl-util.js'
export { FULLSCREEN_VS }

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`
// emitterLuma (gfx-post.js): half Rec.601 luma, half the peak channel
const EL = `
float el(vec3 c) { return 0.5 * (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) + 0.5 * max(c.r, max(c.g, c.b)); }
`

// ── bloom chain (drawBloom / bloomField) ────────────────────────────────────────────────────────────────────────────────────
// a halving blit: bilinear at the destination pixel centre = the 2x2 box average when the sizes halve exactly (the canvas drawImage the CPU uses)
export const DOWN_FS = HEAD + `
uniform sampler2D uSrc;
in vec2 vUv;
out vec4 o;
void main() { o = vec4(texture(uSrc, vUv).rgb, 1.0); }`

// the frame's LOCAL AVERAGE brightness: emitterLuma averaged over a coarse grid of the tiny frame (each cell covers uScale.xy tiny pixels)
export const GRID_FS = HEAD + EL + `
uniform sampler2D uSrc;      // the tiny frame (1/8)
uniform ivec2 uSrcSize;
uniform ivec2 uOutSize;
uniform vec2 uScale;         // tiny pixels per grid cell
out vec4 o;
void main() {
  ivec2 g = ivec2(gl_FragCoord.xy);
  int xt = g.x, yt = uOutSize.y - 1 - g.y;                    // the cell's column and its row from the top
  int x0 = int(float(xt) * uScale.x), x1 = min(uSrcSize.x, int(ceil(float(xt + 1) * uScale.x)));
  int y0 = int(float(yt) * uScale.y), y1 = min(uSrcSize.y, int(ceil(float(yt + 1) * uScale.y)));
  float a = 0.0, c = 0.0;
  for (int yy = y0; yy < y1; yy++) {
    for (int xx = x0; xx < x1; xx++) { a += el(texelFetch(uSrc, ivec2(xx, uSrcSize.y - 1 - yy), 0).rgb); c += 1.0; }
  }
  float v = c > 0.0 ? a / c : 0.0;
  o = vec4(v, v, v, 1.0);
}`

// the bright pass: a pixel is an EMITTER only if it is bright AND clearly brighter than its neighbourhood (the local-contrast gate),
// and the light it emits keeps its hue, pulled toward the lamp colour by tintMix
export const BRIGHT_FS = HEAD + EL + `
uniform sampler2D uSrc;      // the tiny frame
uniform sampler2D uAvg;      // the blurred local average (grid), bilinear
uniform vec3 uP;             // thr, knee, tintMix
uniform vec3 uTint;
in vec2 vUv;
out vec4 o;
void main() {
  vec3 c = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).rgb;
  float l = el(c);
  float w = smoothstep(uP.x, uP.x + max(1e-6, uP.y), l);
  vec3 p = vec3(0.0);
  if (w > 0.0) {
    float m = texture(uAvg, vUv).r;
    w *= smoothstep(0.1, 0.2, l - m);   // BLOOM_CONTRAST_LO / HI (gfx-post.js)
    if (w > 0.0) p = mix(c * w, uTint * (w * l), uP.z);
  }
  o = vec4(p, 1.0);
}`

// the separable [1 4 6 4 1] / 16 blur (blur5x3), edges clamped, as one 5x5 pass: the targets are tiny
export const BLUR_FS = HEAD + `
uniform sampler2D uSrc;
out vec4 o;
const float K[5] = float[5](1.0, 4.0, 6.0, 4.0, 1.0);
void main() {
  ivec2 g = ivec2(gl_FragCoord.xy), hi = textureSize(uSrc, 0) - 1;
  vec3 acc = vec3(0.0);
  for (int j = 0; j < 5; j++) {
    int yy = clamp(g.y + j - 2, 0, hi.y);
    for (int i = 0; i < 5; i++) acc += K[i] * K[j] * texelFetch(uSrc, ivec2(clamp(g.x + i - 2, 0, hi.x), yy), 0).rgb;
  }
  o = vec4(acc * (1.0 / 256.0), 1.0);
}`

// the wide veil: the emitted light box-averaged onto the coarse grid
export const WIDE_FS = HEAD + `
uniform sampler2D uSrc;      // P
uniform ivec2 uSrcSize;
uniform ivec2 uOutSize;
uniform vec2 uScale;
out vec4 o;
void main() {
  ivec2 g = ivec2(gl_FragCoord.xy);
  int xt = g.x, yt = uOutSize.y - 1 - g.y;
  int x0 = int(float(xt) * uScale.x), x1 = min(uSrcSize.x, int(ceil(float(xt + 1) * uScale.x)));
  int y0 = int(float(yt) * uScale.y), y1 = min(uSrcSize.y, int(ceil(float(yt + 1) * uScale.y)));
  vec3 a = vec3(0.0); float c = 0.0;
  for (int yy = y0; yy < y1; yy++) {
    for (int xx = x0; xx < x1; xx++) { a += texelFetch(uSrc, ivec2(xx, uSrcSize.y - 1 - yy), 0).rgb; c += 1.0; }
  }
  o = vec4(c > 0.0 ? a / c : vec3(0.0), 1.0);
}`

// ── the low-res compose (composeFrame's low-res half): bloom -> [steam is drawn on top by the particle program] -> gain -> veil -> grain ──────
// The legacy tier runs only the grain; the atmosphere pass runs bloom, gain, veil and grain. uDoBloom / uDoGrade split the work around the steam draw.
export const COMPOSE_FS = HEAD + `
uniform sampler2D uSrc;      // the frame (scene, or the bloomed frame after the steam split)
uniform sampler2D uHalo;     // the tight halo (blurred emitted light), bilinear
uniform sampler2D uWide;     // the wide veil, bilinear
uniform sampler2D uTile;     // the grain tile (RGBA8, straight alpha)
uniform vec2 uRes;           // internal W, H
uniform int uDoBloom, uDoGrade, uGrainOn;
uniform vec2 uBloomGain;     // tight, wide
uniform vec3 uGain;          // highlight gain (<= 1 per channel)
uniform vec3 uVeilV, uVeilD; // veil colour toward the middle / toward the corners (0..1)
uniform vec3 uVeil;          // vignette depth, where it starts (normalised radius), the middle's veil alpha
uniform ivec2 uGrainOff;     // where the tile sits (texels)
uniform int uTileMask;       // tile size - 1
uniform float uGrainK;       // 1 (modern: the tile carries the alpha), 0.045 (legacy: a plain alpha over grey noise)
out vec4 o;
void main() {
  ivec2 g = ivec2(gl_FragCoord.xy);
  vec3 c = texelFetch(uSrc, g, 0).rgb;
  if (uDoBloom != 0) {
    vec2 uv = gl_FragCoord.xy / uRes;
    vec3 light = texture(uHalo, uv).rgb * uBloomGain.x + texture(uWide, uv).rgb * uBloomGain.y;
    float I = max(light.r, max(light.g, light.b));
    if (I < 0.002) light = vec3(0.0); else if (I > 1.0) light /= I;
    c = vec3(1.0) - (vec3(1.0) - c) * (vec3(1.0) - light);     // SCREEN: light on a bright pixel must not clip it flat
  }
  if (uDoGrade != 0) {
    c *= uGain;
    float r = length(gl_FragCoord.xy - 0.5 * uRes) / (0.5 * length(uRes));
    float w = pow(smoothstep(uVeil.y, 1.02, r), 1.3);          // vignetteAlpha(r, 1, from)
    c = mix(c, mix(uVeilV, uVeilD, w), mix(uVeil.z, uVeil.x, w));
  }
  if (uGrainOn != 0) {
    ivec2 tp = ivec2((g.x + uGrainOff.x) & uTileMask, ((int(uRes.y) - 1 - g.y) + uGrainOff.y) & uTileMask);
    vec4 gt = texelFetch(uTile, tp, 0);
    c = mix(c, gt.rgb, gt.a * uGrainK);
  }
  o = vec4(c, 1.0);
}`

// ── the visible frame: the bilinear upscale + everything the CPU draws at full resolution before the particles ──────────────
// legacy: the vignette (a radial black gradient); both: the flicker blackout; modern + tape: gate drift, red/blue fringe, soft focus
export const UP_FS = HEAD + `
uniform sampler2D uLow;
uniform vec2 uOut;           // canvas OW, OH
uniform vec2 uLowRes;        // internal W, H
uniform float uFlick;        // 1 - the blackout overlay's alpha
uniform vec3 uVig;           // legacy vignette: depth, inner radius, outer radius (px); depth 0 = none
uniform vec4 uTape;          // drift (canvas px), fringe (low-res px), soft (blend), on
in vec2 vUv;
out vec4 o;
void main() {
  vec2 uv = vUv;
  if (uTape.w > 0.5) uv.x = (gl_FragCoord.x - (uTape.x - 3.0)) / (uOut.x + 6.0);
  vec3 c = texture(uLow, uv).rgb;
  if (uTape.w > 0.5) {
    float d = uTape.y / uLowRes.x;
    c = vec3(texture(uLow, uv - vec2(d, 0.0)).r, c.g, texture(uLow, uv + vec2(d, 0.0)).b);
    if (uTape.z > 0.0) {
      vec2 e = 1.0 / uLowRes;
      vec3 s = 0.25 * (texture(uLow, vUv + vec2(e.x, e.y)).rgb + texture(uLow, vUv + vec2(-e.x, e.y)).rgb
                     + texture(uLow, vUv + vec2(e.x, -e.y)).rgb + texture(uLow, vUv + vec2(-e.x, -e.y)).rgb);
      c = mix(c, s, uTape.z);
    }
  }
  if (uVig.x > 0.0) c *= 1.0 - uVig.x * clamp((length(gl_FragCoord.xy - 0.5 * uOut) - uVig.y) / (uVig.z - uVig.y), 0.0, 1.0);
  o = vec4(c * uFlick, 1.0);
}`

// ── the player's own light, when the world pass did not do it (drawLights): additive screen gradients ────────────────────────
export const LIGHTS_FS = HEAD + `
uniform vec2 uOut;
uniform int uFlash;
uniform vec4 uGlow;          // rgb 0..1, alpha at the centre (already pulsed); alpha 0 = off
out vec4 o;
void main() {
  vec2 p = vec2(gl_FragCoord.x, uOut.y - gl_FragCoord.y);     // from the top-left, at the pixel centre
  vec3 acc = vec3(0.0);
  if (uFlash != 0) {
    float t = clamp((length(p - vec2(uOut.x * 0.5, uOut.y * 0.52)) - uOut.y * 0.04) / (uOut.y * (0.72 - 0.04)), 0.0, 1.0);
    vec3 c; float a;
    if (t < 0.5) { float s = t / 0.5; c = mix(vec3(255.0, 244.0, 212.0), vec3(255.0, 238.0, 196.0), s) / 255.0; a = mix(0.24, 0.09, s); }
    else { float s = (t - 0.5) / 0.5; c = vec3(255.0, 238.0, 196.0) * (1.0 - s) / 255.0; a = 0.09 * (1.0 - s); }
    acc += c * a;
  }
  if (uGlow.a > 0.0) {
    float t = clamp((length(p - vec2(uOut.x * 0.5, uOut.y * 0.6)) - uOut.y * 0.03) / (uOut.y * (0.62 - 0.03)), 0.0, 1.0);
    acc += uGlow.rgb * (1.0 - t) * uGlow.a * (1.0 - t);
  }
  o = vec4(acc, 1.0);
}`

// ── particles: instanced quads (see gfx-gl-post-particles.js for the record layout) ─────────────────────────────────────────
export const PARTICLE_VS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
layout(location = 0) in vec4 aA;      // cx, cy, halfL, halfW  (target px, from the top-left)
layout(location = 1) in vec4 aB;      // dx, dy, kind, mainKind
layout(location = 2) in vec4 aC;      // a0, lb, g, the lit alpha's ceiling (0 = none)
uniform vec2 uTarget;                 // the target's size in px
uniform float uFlick;
uniform int uUseLuma;                 // 1 when the bloom pass measured the frame this frame
uniform sampler2D uTiny;              // the tiny (1/8) frame the brightness map is read from
out vec2 vQ;
out vec2 vHalf;
out vec2 vPx;
flat out float vKind;
out float vAlpha;
${EL}
void main() {
  vec2 q = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  float kind = aB.z;
  float L = aC.y;
  if (uUseLuma != 0) {
    ivec2 ts = textureSize(uTiny, 0);
    vec2 f = aA.xy / uTarget;                                  // where on the frame (from the top-left), 0..1
    ivec2 cell = ivec2(clamp(int(f.x * float(ts.x)), 0, ts.x - 1), clamp(int(f.y * float(ts.y)), 0, ts.y - 1));
    float luma = floor(el(texelFetch(uTiny, ivec2(cell.x, ts.y - 1 - cell.y), 0).rgb) * 255.0 + 0.5) / 255.0;
    L *= 0.55 + 0.9 * luma;
  }
  float mk = kind > 4.5 ? aB.w : kind;                         // a glow is judged by the light term of the mote it rides on
  float a0 = aC.x;
  float alpha0 = mk < 0.5 ? a0 * min(1.7, L) : (mk < 1.5 ? a0 * min(1.6, L * 1.1) : a0);
  if (aC.w > 0.0) alpha0 = min(alpha0, aC.w);                // steam near the camera (V9, gfx-post.js steamLimits)
  float alpha = kind > 4.5 ? min(1.0, alpha0 * aC.z * 0.9) : min(1.0, alpha0);
  vAlpha = alpha * uFlick;
  vec2 hh = aA.zw + ((kind > 2.5 && kind < 4.5) ? vec2(1.0) : vec2(0.0));     // the antialiased shapes (dot, streak) get a 1 px rim to fade in
  vQ = q; vKind = kind; vHalf = aA.zw; vPx = q * hh;
  vec2 dir = aB.xy, perp = vec2(-dir.y, dir.x);
  vec2 p = aA.xy + dir * (q.x * hh.x) + perp * (q.y * hh.y);
  gl_Position = vec4(p.x / uTarget.x * 2.0 - 1.0, 1.0 - p.y / uTarget.y * 2.0, 0.0, 1.0);
  if (alpha0 < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // culled (the CPU skips a mote it would draw at alpha < 0.004)
}`

// The sprites the CPU pre-rasterises into 32 px canvases (buildSprite), evaluated analytically: q in -1..1 is the sprite's own canvas (0..32 px).
export const PARTICLE_FS = HEAD + `
uniform vec3 uColor;
in vec2 vQ;
in vec2 vHalf;
in vec2 vPx;
flat in float vKind;
in float vAlpha;
out vec4 o;
// blob(): a radial gradient with stops 0: a, 0.3: 0.7a, 0.65: 0.2a, 1: 0 (r = distance over the blob's radius)
float ramp(float r) {
  return r < 0.3 ? mix(1.0, 0.7, r / 0.3) : (r < 0.65 ? mix(0.7, 0.2, (r - 0.3) / 0.35) : (r < 1.0 ? mix(0.2, 0.0, (r - 0.65) / 0.35) : 0.0));
}
void main() {
  vec2 cp = (vQ * 0.5 + 0.5) * 32.0;         // canvas pixels, y down (the quad's +y is down the screen)
  vec3 col = uColor;
  float a;
  if (vKind < 0.5 || vKind > 4.5) {                                             // dust / glow: a soft disc
    a = ramp(length(vQ));
  } else if (vKind < 1.5) {                                                     // steam: three offset lobes
    float a1 = 0.55 * ramp(length(cp - vec2(16.0, 16.0)) / 16.0);
    float a2 = 0.40 * ramp(length(cp - vec2(12.0, 19.0)) / 10.24);
    float a3 = 0.35 * ramp(length(cp - vec2(21.0, 12.0)) / 8.96);
    a = 1.0 - (1.0 - a1) * (1.0 - a2) * (1.0 - a3);
  } else if (vKind < 2.5) {                                                     // spark: a hot core inside a tight halo
    float ab = 0.45 * ramp(length(vQ));
    float rc = length(cp - vec2(16.0, 16.0)) / 5.12;
    float ac = rc < 1.0 ? 1.0 - rc : 0.0;
    vec3 cc = mix(vec3(1.0), uColor, min(rc, 1.0));
    a = ac + ab * (1.0 - ac);
    col = a > 1e-5 ? (cc * ac + uColor * ab * (1.0 - ac)) / a : uColor;
  } else if (vKind < 3.5) {                                                     // the legacy dot: an antialiased disc (radius = halfL px)
    a = clamp(vHalf.x - length(vPx) + 0.5, 0.0, 1.0);
  } else {                                                                      // a spark's streak: a flat butt-capped stroke
    a = clamp(vHalf.x - abs(vPx.x) + 0.5, 0.0, 1.0) * clamp(vHalf.y - abs(vPx.y) + 0.5, 0.0, 1.0);
  }
  o = vec4(col, a * vAlpha);
}`

// (name lists the pass checks against the compiled programs: a missing uniform is a GlError at creation, not a silent no-op at draw time)
export const UNIFORMS = {
  down: ['uSrc'],
  grid: ['uSrc', 'uSrcSize', 'uOutSize', 'uScale'],
  bright: ['uSrc', 'uAvg', 'uP', 'uTint'],
  blur: ['uSrc'],
  wide: ['uSrc', 'uSrcSize', 'uOutSize', 'uScale'],
  compose: ['uSrc', 'uHalo', 'uWide', 'uTile', 'uRes', 'uDoBloom', 'uDoGrade', 'uGrainOn', 'uBloomGain', 'uGain', 'uVeilV', 'uVeilD', 'uVeil', 'uGrainOff', 'uTileMask', 'uGrainK'],
  up: ['uLow', 'uOut', 'uLowRes', 'uFlick', 'uVig', 'uTape'],
  lights: ['uOut', 'uFlash', 'uGlow'],
  particles: ['uColor', 'uTarget', 'uFlick', 'uUseLuma', 'uTiny'],
}
