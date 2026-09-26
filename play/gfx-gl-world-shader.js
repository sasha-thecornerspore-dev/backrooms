// gfx-gl-world-shader.js — the GLSL ES 3.00 source of the GPU world pass (gfx-gl-world.js). One fragment shader, specialised at build time by two
// defines (LIT: the light-model shading of gfx-world.js renderLit, otherwise the legacy distance-fog shading of renderLegacy; SKY: the level has an
// open sky), and the list of uniforms each specialisation must expose (checked when the program is built, so a typo is a GlError at creation).
//
// Rows are numbered from the TOP (y = H - 1 - floor(gl_FragCoord.y)), columns from the left, exactly like the CPU's buf32; colours are the CPU's
// non-linear 0..1 (byte / 255) with no sRGB conversion, and the result is truncated to a byte the way the CPU's `| 0` does, so an identical input
// gives an identical pixel. See the header of gfx-gl-util.js for the COLUMN TEXTURE and gfx-gl-world-data.js for what every table holds.

const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;

uniform sampler2DArray uTiles;   // every surface tile (walls, wall variants, floor / ceiling variants, the light panel), RGBA8, mipmapped
uniform sampler2D uCols;         // W x 2 RGBA32F: row 0 (corr|FAR, wallX, layer, side), row 1 (pool share, dist, draw corr, 0)
uniform vec2  uRes;              // internal W, H
uniform float uHH;               // horizon row (from the top)
uniform float uFog;              // fog distance in world units
uniform vec3  uFogL;             // the fog colour 0..1, already scaled by the frame's light (legacy: x flicker; lit: x fogGain x dip)
uniform float uAng0, uAngStep;   // view angle of column 0, and per column
uniform vec2  uPFrac;            // player position within its cell
uniform ivec2 uPInt;             // player cell
uniform vec2  uDir0, uDDir;      // ray direction of column 0 (unit) and its change per column (floor / ceiling positions are linear in x)
uniform vec3  uFloorLayers;      // (first layer, variant count, unused)
uniform vec3  uCeilLayers;
uniform float uLightLayer;       // the ceiling light panel's layer
uniform float uLightsOn;         // 1: drop-ceiling panels are drawn
uniform float uGradScale;        // texture footprint multiplier (>1 = softer, coarser mip levels sooner)
uniform float uSharp;            // >0: width in pixels of the soft edge between magnified texels (0 = plain bilinear)
uniform float uNear;             // 1: the CPU's near-field filter is on (texFilter >= 2 or lightDetail >= 2): a horizontal 2-tap blend inside a magnified texel
uniform float uTSf;              // tile size in texels
uniform float uIso;              // 1: no anisotropic filtering available: use one isotropic footprint (the geometric mean)
uniform float uFlicker;          // legacy: the global flicker scalar (already inside uFogL)
#ifdef SKY
uniform sampler2D uSkyRows;      // H x 2 RGBA32F: row 0 (r, g, b, cloud amplitude), row 1 (strip row A, strip row B)
uniform sampler2D uCloud;        // the cloud strip, R8, CLOUD_W x CLOUD_H, LINEAR, repeating in azimuth
uniform vec3  uSkyRgb;           // 0..1
uniform float uSkyMode;          // 0: the legacy vertical gradient, 1: the overcast layers
uniform float uSkyA0, uSkyB0, uSkyDu, uSkyAmpB;   // azimuth (in strip texels) of column 0 for layer A / B, per column, layer B's weight
#endif
#ifdef LIT
uniform sampler2D uPool;         // 64 x 128 RGBA32F: floor (S, A, B) rows 0..63, ceiling rows 64..127
uniform sampler2D uWallTab;      // (wallPool tables) see gfx-gl-world-data.js fillWallTable
uniform sampler2D uCells;        // 64 x 64 RGBA8: contact bits, lamp flag, lamp level
uniform sampler2D uLm;           // 128 x 128 R32F lamp lightmap (toroidal)
uniform sampler2D uLmAny;        // 32 x 32 R8: does any lamp reach this light cell
uniform sampler2D uLev;          // panel levels (R32F, LEV_MAX x LEV_MAX)
uniform float uGdip;             // the frame's bounded global dip
uniform vec3  uAmbF, uAmbC;      // ambient light colour of floor / ceiling (level included)
uniform vec3  uTint, uATint;     // pool tint, ambient tint (walls)
uniform float uFogBase, uFogGlow, uFloorInv, uCeilInv;
uniform vec4  uAo;               // floor (strength, reach), ceiling (strength, reach) of the contact shading
uniform float uPanels, uEmit, uLamps;    // panel lattice / lightmap emitters / lamp fixtures on the ceiling
uniform ivec2 uOccC;             // the cell window's centre cell
uniform int   uOccR;             // ... and radius
uniform int   uLmR;              // the lightmap's radius (cells)
uniform float uLevOn, uModulated;        // a panel level grid is live; floor / ceiling pools follow it
uniform ivec3 uLev3;             // levN, levI0, levJ0
uniform vec3  uLampCol;          // lamp fixture core colour 0..1... in byte/255
uniform float uFlash, uFlashK, uGlow, uGlowK;
uniform vec3  uGlowCol;
uniform vec2  uFlashSxy;         // beam widths
uniform float uFlashPitch, uFov, uSinH2, uCosH2;
#endif

out vec4 oCol;

uint hash2u(int a, int b, uint c) {
  uint h = (uint(a) * 2654435761u) ^ (uint(b) * 2246822519u) ^ (c * 3266489917u);
  h ^= h >> 16u; h *= 0x45d9f3bu; h ^= h >> 16u;
  return h;
}

// MODULO. h % n on a full 32-bit value is only exact where the GPU divides in integers; some parts lower it through an fp32 reciprocal (exact below
// 2^24). Splitting h into 16-bit halves keeps every intermediate small (< 2^24 for any n up to 4096), so the result is exact everywhere (the formula is
// proved against JS % in test/gfx-gl-fix-r2.test.js). The CPU's hash2 (gfx-util.js) wraps in 32 bits exactly like this one (Math.imul), so the two pick
// the same variant on every cell, at any distance from the origin.
uint modExact(uint h, uint n) {
  n = max(n, 1u);
  return (((h >> 16u) % n) * (65536u % n) + (h & 65535u) % n) % n;
}

// The near-field softness, the CPU's rule (gfx-world.js filtNear): when uNear is on and a texel spans more than about 4-6 pixels (nearK < 1: the CPU's
// texels-per-pixel over its NEAR_TEXEL / NEAR_TEXEL_WALL), the horizontal axis is a plain 2-tap blend inside the texel instead of the crisp antialiased
// edge. The vertical axis stays crisp (the CPU never blends vertically), and a filtered tier without uNear (medium) keeps crisp edges on both axes.
const float NEAR_TEXEL = 0.13, NEAR_TEXEL_WALL = 0.17;

// a tile lookup with an explicit footprint (world units per pixel across / down), so the mip level and the anisotropy do not depend on quad neighbours;
// nearK is the CPU's texels-per-pixel measure over its near-field threshold for this surface (below 1: magnified enough for the 2-tap blend)
vec4 tileAt(vec2 uv, float layer, vec2 gx, vec2 gy, float nearK) {
  if (uIso > 0.5) { float g = sqrt(length(gx) * length(gy)); gx = vec2(g, 0.0); gy = vec2(0.0, g); }
  gx *= uGradScale; gy *= uGradScale;
  if (uSharp > 0.0) {
    // magnified: keep the texels' edges crisp (a transition uSharp pixels wide) instead of a full-texel blur; minified: plain filtering (w = 1)
    vec2 w = clamp(max(abs(gx), abs(gy)) * (uTSf * uSharp), vec2(0.02), vec2(1.0));
    if (uNear > 0.5 && nearK < 1.0) w.x = 1.0;        // the seam maths below then leaves u alone: the hardware's linear filter is the 2-tap blend
    vec2 p = uv * uTSf, seam = floor(p + 0.5);
    uv = (seam + clamp((p - seam) / w, -0.5, 0.5)) / uTSf;
  }
  return textureGrad(uTiles, vec3(uv, layer), gx, gy);
}
`

const SKY = `
#ifdef SKY
vec3 skyPixel(float x, float y) {
  if (uSkyMode < 0.5) {                                  // legacy: sky colour at the top to the fog colour at the horizon (uFogL carries the flicker)
    float t = uHH > 0.0 ? y / uHH : 1.0;
    vec3 fogRaw = uFogL;
    return (uSkyRgb * (1.0 - t) + fogRaw * t);
  }
  vec4 r0 = texelFetch(uSkyRows, ivec2(int(y), 0), 0);
  vec4 r1 = texelFetch(uSkyRows, ivec2(int(y), 1), 0);
  float c = x + 0.5;
  float sA = uSkyA0 + uSkyDu * c, sB = uSkyB0 + uSkyDu * 3.0 * c;
  float d0 = texture(uCloud, vec2((sA + 0.5) / 1024.0, (r1.x + 0.5) / 96.0)).r * 255.0;
  float d1 = texture(uCloud, vec2((sB + 0.5) / 1024.0, (r1.y + 0.5) / 96.0)).r * 255.0;
  float sh = ((128.0 - d0) + uSkyAmpB * (128.0 - d1)) * (r0.a * (1.0 / 128.0));
  return r0.rgb * (1.0 + sh);
}
#endif
`

const LEGACY = `
#ifndef LIT
vec3 wallPixel(float x, float y, vec4 c0, vec4 c1, float corr, float whF, float wtF) {
  float wallX = c0.y, layer = c0.z, side = c0.w;
  float distF = min(1.0, corr / uFog);
  float sideMul = side > 0.5 ? 0.72 : 1.0;
  float ang = uAng0 + x * uAngStep;
  float cosInc = max(0.05, side > 0.5 ? abs(sin(ang)) : abs(cos(ang)));
  // v is kept a half texel inside the tile: the sampler REPEATs (floors need it), so the first / last wall row would blend into the opposite edge
  float v = clamp((y - wtF) / whF, 0.5 / uTSf, 1.0 - 0.5 / uTSf);
  vec3 tx = tileAt(vec2(wallX, v), layer, vec2(c1.y * uAngStep / cosInc, 0.0), vec2(0.0, 1.0 / whF), corr * uAngStep * uTSf / NEAR_TEXEL_WALL).rgb;
  float a = sideMul * (1.0 - distF) * uFlicker;
  return tx * a + uFogL * distF;
}

// (the sky rows never reach here: main() sends y <= uHH to skyPixel, so flatPixel has no early return in the SKY variants and FXC sees every path set c)
vec3 flatPixel(float x, float y) {
  bool isFloor = y > uHH;
  float span = isFloor ? uRes.y - uHH : uHH;
  float rowDist = span / max(1.0, isFloor ? y - uHH : uHH - y);
  if (rowDist > uFog) return uFogL;
  float df = min(1.0, rowDist / uFog);
  vec2 rel = uPFrac + rowDist * (uDir0 + x * uDDir);
  vec2 fl = floor(rel);
  ivec2 cell = uPInt + ivec2(fl);
  vec2 f = rel - fl;
  vec2 gx = rowDist * uDDir, gy = (rowDist * rowDist / span) * (uDir0 + x * uDDir);
  float nearK = length(gx) * uTSf / NEAR_TEXEL;
  bool panel = !isFloor && uLightsOn > 0.5 && ((cell.x & 1) == 0) && ((cell.y & 1) == 0);
  vec3 c = uFogL;
  if (panel) {
    float dfL = df * 0.45;
    c = tileAt(f, uLightLayer, gx, gy, nearK).rgb * ((1.0 - dfL) * uFlicker) + uFogL * dfL;
  } else {
    vec3 lay = isFloor ? uFloorLayers : uCeilLayers;
    float layer = lay.x + float(modExact(hash2u(cell.x, cell.y, isFloor ? 1u : 2u), uint(lay.y)));
    c = tileAt(f, layer, gx, gy, nearK).rgb * ((1.0 - df) * uFlicker) + uFogL * df;
  }
  return c;
}
#endif
`

const LIT = `
#ifdef LIT
float flashAtt(float d) { return 1.0 / (1.0 + d * d / 9.0) * (1.0 - smoothstep(7.0, 12.5, d)); }
float glowAtt(float d2) { return 1.0 / (1.0 + d2 / 2.2) * (1.0 - smoothstep(9.0, 38.0, d2)); }
float sxAt(float x) { float a = ((x + 0.5) / uRes.x - 0.5) * uFov; return exp(-(a * a) / (uFlashSxy.x * uFlashSxy.x)); }
float syAt(float y) { float dv = (y - uHH) / uRes.y - uFlashPitch; return exp(-(dv * dv) / (uFlashSxy.y * uFlashSxy.y)); }
const vec3 FLASH_COL = vec3(1.0, 0.93, 0.76);

vec3 wallPixel(float x, float y, vec4 c0, vec4 c1, float corr, float whF, float wtF) {
  float wallX = c0.y, layer = c0.z, side = c0.w;
  float pw = c1.x;
  float distF = min(1.0, corr / uFog);
  float sideMul = side > 0.5 ? 0.72 : 1.0;
  float a = sideMul * (1.0 - distF) * uGdip;
  float v = (y - wtF) / whF;
  float ang = uAng0 + x * uAngStep;
  float cosInc = max(0.05, side > 0.5 ? abs(sin(ang)) : abs(cos(ang)));
  float vc = clamp(v, 0.5 / uTSf, 1.0 - 0.5 / uTSf);        // a half texel inside the tile: the REPEAT sampler would blend the first / last row into the opposite edge
  vec3 tx = tileAt(vec2(wallX, vc), layer, vec2(c1.y * uAngStep / cosInc, 0.0), vec2(0.0, 1.0 / whF), corr * uAngStep * uTSf / NEAR_TEXEL_WALL).rgb;
  int texY = int(v * uTSf) & (int(uTSf) - 1);
  vec4 wt = texelFetch(uWallTab, ivec2(texY, 1), 0);       // (ambient, pool at full share) of this texel row
  vec3 L = a * (uATint * wt.x + uTint * (wt.y * pw));
  float fw = distF * (uFogBase + (1.0 - uFogBase) * uFogGlow * pw);
  vec3 add = uFogL * fw * ((1.0 - pw) + pw * uTint);
  if (uFlash + uGlow > 0.5) {
    float wk = sideMul * (1.0 - distF);
    if (uFlash > 0.5) L += wk * FLASH_COL * (uFlashK * sxAt(x) * flashAtt(corr)) * syAt(y);
    if (uGlow > 0.5) L += wk * uGlowCol * (glowAtt(c1.y * c1.y + 0.25) * uGlowK);
  }
  return tx * L + add;
}

float aoAxis(int b2, int t, float strength, float reach) {
  if (b2 == 0) return 1.0;
  float d = (float(t) + 0.5) / uTSf;
  float lo = 1.0 - strength * pow(max(0.0, 1.0 - d / reach), 2.0);
  float hi = 1.0 - strength * pow(max(0.0, 1.0 - (1.0 - d) / reach), 2.0);
  return b2 == 1 ? lo : b2 == 2 ? hi : lo * hi;
}

float levelAt(ivec2 g) {
  return (g.x >= 0 && g.x < uLev3.x && g.y >= 0 && g.y < uLev3.x) ? texelFetch(uLev, g, 0).r : 1.0;
}

vec3 flatPixel(float x, float y) {
  bool isFloor = y > uHH;
  bool ceiling = !isFloor;
  float span = isFloor ? uRes.y - uHH : uHH;
  float rowDist = span / max(1.0, isFloor ? y - uHH : uHH - y);
  if (rowDist > uFog) return uFogL;
  float df = min(1.0, rowDist / uFog);
  float w0 = 1.0 - df;
  float a = w0 * uGdip;
  vec2 rel = uPFrac + rowDist * (uDir0 + x * uDDir);
  vec2 fl = floor(rel);
  ivec2 cell = uPInt + ivec2(fl);
  vec2 f = rel - fl;
  ivec2 tt = min(ivec2(f * uTSf), ivec2(int(uTSf) - 1));
  vec2 gx = rowDist * uDDir, gy = (rowDist * rowDist / span) * (uDir0 + x * uDDir);
  float dfL = df * 0.45, aL = 1.0 - dfL;
  vec3 gL = uFogL * dfL;
  float HT = uTSf * 0.5;
  float nearK = length(gx) * uTSf / NEAR_TEXEL;

  // the cell window: contact bits and lamp fixtures of the cells around the player
  ivec2 dc = cell - uOccC;
  int bits = 0; bool lampC = false; float lampL = 1.0;
  if (abs(dc.x) <= uOccR && abs(dc.y) <= uOccR) {
    vec4 cs = texelFetch(uCells, cell & 63, 0);
    bits = int(cs.r * 255.0 + 0.5);
    if (uLamps > 0.5 && ceiling && cs.g > 0.5) { lampC = true; lampL = cs.b; }
  }
  bool panel = ceiling && uLightsOn > 0.5 && uPanels > 0.5 && ((cell.x & 1) == 0) && ((cell.y & 1) == 0);
  if (panel) {
    float pv = 1.0;
    if (uLevOn > 0.5) pv = levelAt(ivec2(cell.x >> 1, cell.y >> 1) - uLev3.yz);
    vec2 pd = vec2(tt) - HT;
    float em = (0.1 + 0.9 * pv) * (1.08 - 0.22 * dot(pd, pd) / (2.0 * HT * HT));
    return tileAt(f, uLightLayer, gx, gy, nearK).rgb * (aL * uTint * em) + gL;
  }

  // the pool of light here
  float ps = 0.0;
  if (uPanels > 0.5) {
    // f can round to exactly 1.0 in fp32 (rel just below a whole number): clamp so the index never leaves the 64 x 128 table
    ivec2 pi = ivec2(((cell.x & 1) * 32) + min(int(f.x * 32.0), 31), ((cell.y & 1) * 32) + min(int(f.y * 32.0), 31));
    if (ceiling) pi.y += 64;
    vec4 pt = texelFetch(uPool, pi, 0);
    ps = pt.x;
    if (uModulated > 0.5) {
      ivec2 nk = ivec2(cell.x + (f.x >= 0.5 ? 1 : 0), cell.y + (f.y >= 0.5 ? 1 : 0));
      float plv = levelAt((nk >> 1) - uLev3.yz);
      ps = pt.y + plv * pt.z;
    }
  } else if (uEmit > 0.5) {
    ivec2 lc = cell - uOccC;
    if (abs(lc.x) <= uLmR && abs(lc.y) <= uLmR && texelFetch(uLmAny, cell & 31, 0).r > 0.001) {
      vec2 s = f * 4.0 - 0.5;
      vec2 sf = floor(s);
      vec2 fr = s - sf;
      ivec2 i0 = cell * 4 + ivec2(sf);
      float p00 = texelFetch(uLm, i0 & 127, 0).r, p10 = texelFetch(uLm, (i0 + ivec2(1, 0)) & 127, 0).r;
      float p01 = texelFetch(uLm, (i0 + ivec2(0, 1)) & 127, 0).r, p11 = texelFetch(uLm, (i0 + ivec2(1, 1)) & 127, 0).r;
      ps = mix(mix(p00, p10, fr.x), mix(p01, p11, fr.x), fr.y) * (ceiling ? 0.55 : 1.0);
      vec2 dp = vec2(cell - uPInt) + (f - uPFrac);
      float dcT = max(abs(dp.x), abs(dp.y));
      float fadeA = float(uLmR) - 3.0;
      if (dcT > fadeA) { float u = (dcT - fadeA) / 3.0; ps = u >= 1.0 ? 0.0 : ps * (1.0 - u * u * (3.0 - 2.0 * u)); }
    }
  }
  float ao = aoAxis(bits & 3, tt.x, ceiling ? uAo.z : uAo.x, ceiling ? uAo.w : uAo.y) * aoAxis((bits >> 2) & 3, tt.y, ceiling ? uAo.z : uAo.x, ceiling ? uAo.w : uAo.y);
  ps *= ao;
  vec3 L = a * ((ceiling ? uAmbC : uAmbF) * ao + uTint * ps);
  if (uFlash > 0.5) L += (w0 * FLASH_COL) * (uFlashK * syAt(y) * flashAtt(rowDist) * (ceiling ? 0.55 : 0.85) * sxAt(x));
  if (uGlow > 0.5) {
    float u = 2.0 * (x + 0.5) / uRes.x - 1.0, rd2 = rowDist * rowDist;
    L += (w0 * uGlowCol * uGlowK) * glowAtt(rd2 * uCosH2 + 0.25 + rd2 * uSinH2 * u * u);
  }
  float gk = df * (1.0 - uFogBase) * uFogGlow * (ceiling ? uCeilInv : uFloorInv);
  vec3 add = uFogL * (df * uFogBase + gk * uTint * ps);
  vec3 c;
  {
    float layerBase = isFloor ? uFloorLayers.x : uCeilLayers.x;
    float cnt = isFloor ? uFloorLayers.y : uCeilLayers.y;
    float layer = layerBase + float(modExact(hash2u(cell.x, cell.y, isFloor ? 1u : 2u), uint(cnt)));
    c = tileAt(f, layer, gx, gy, nearK).rgb * L + add;
  }
  if (lampC) {                                              // a lamp fixture: a bright bulb inside a dark cage ring, soft-edged
    vec2 pd = f * uTSf - HT;                                // from the sub-texel position, as the CPU does: a smooth ring, not a blocky one
    float t = dot(pd, pd) / (0.0169 * uTSf * uTSf);
    if (t < 1.0) {
      float cov = t < 0.8 ? 1.0 : (1.0 - t) * 5.0;
      float em = (t < 0.2 ? 1.0 : t < 0.32 ? 1.0 - (t - 0.2) * 5.67 : 0.32) * (0.1 + 0.9 * lampL);
      c += (uLampCol * aL * em + gL - c) * cov;
    }
  }
  return c;
}
#endif
`

const MAIN = `
void main() {
  float x = floor(gl_FragCoord.x);
  float y = uRes.y - 1.0 - floor(gl_FragCoord.y);
  vec4 c0 = texelFetch(uCols, ivec2(int(x), 0), 0);
  vec4 c1 = texelFetch(uCols, ivec2(int(x), 1), 0);
  float corr = c1.z;
  float whF = uRes.y / max(0.001, corr);
  float wtF = uHH - whF * 0.5;
  // the wall's rows: the CPU's double-precision ceil / floor, packed by the pass as y0 * 4096 + y1 (both exact in fp32); -1 = not supplied, recompute here
  float y0 = ceil(wtF), y1 = floor(wtF + whF);
  if (c1.w >= 0.0) { y0 = floor(c1.w * (1.0 / 4096.0)); y1 = c1.w - y0 * 4096.0; }
  vec3 col;
  if (y >= y0 && y < y1) col = wallPixel(x, y, c0, c1, corr, whF, wtF);
  else {
#ifdef SKY
    if (y <= uHH) col = skyPixel(x, y); else
#endif
    col = flatPixel(x, y);
  }
  oCol = vec4(floor(clamp(col, 0.0, 1.0) * 255.0 + 0.002) / 255.0, 1.0);
}
`

export function worldFragmentSource({ lit, sky }) {
  return COMMON.replace('#version 300 es\n', `#version 300 es\n${lit ? '#define LIT\n' : ''}${sky ? '#define SKY\n' : ''}`) + SKY + LEGACY + LIT + MAIN
}

const BASE_UNIFORMS = ['uTiles', 'uCols', 'uRes', 'uHH', 'uFog', 'uFogL', 'uAng0', 'uAngStep', 'uPFrac', 'uPInt', 'uDir0', 'uDDir', 'uFloorLayers',
  'uCeilLayers', 'uLightLayer', 'uLightsOn', 'uGradScale', 'uIso', 'uSharp', 'uNear', 'uTSf']
const SKY_UNIFORMS = ['uSkyRows', 'uCloud', 'uSkyRgb', 'uSkyMode', 'uSkyA0', 'uSkyB0', 'uSkyDu', 'uSkyAmpB']
const LEGACY_UNIFORMS = ['uFlicker']
const LIT_UNIFORMS = ['uPool', 'uWallTab', 'uCells', 'uLm', 'uLmAny', 'uLev', 'uGdip', 'uAmbF', 'uAmbC', 'uTint', 'uATint', 'uFogBase', 'uFogGlow', 'uFloorInv',
  'uCeilInv', 'uAo', 'uPanels', 'uEmit', 'uLamps', 'uOccC', 'uOccR', 'uLmR', 'uLevOn', 'uModulated', 'uLev3', 'uLampCol', 'uFlash', 'uFlashK', 'uGlow',
  'uGlowK', 'uGlowCol', 'uFlashSxy', 'uFlashPitch', 'uFov', 'uSinH2', 'uCosH2']
export function worldUniformNames({ lit, sky }) {
  return [...BASE_UNIFORMS, ...(sky ? SKY_UNIFORMS : []), ...(lit ? LIT_UNIFORMS : LEGACY_UNIFORMS)]
}
