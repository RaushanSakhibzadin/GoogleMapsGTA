"use strict";
/* VICE MAPS — The same city, from behind the car.

   Part of a set of plain <script> files sharing one global scope. They are NOT
   modules on purpose: ES modules are blocked over file://, and opening
   index.html straight off disk with no build step is the point of this thing.
   Load order is fixed in index.html and matters — this one comes last of the
   renderers, because it owns render() and toScreen() and dispatches to the 2D
   pair by name.

   BOTH VIEWS SHIP. This does not replace render.js; the button in the corner
   picks one. That decision costs a dispatcher and buys three things worth more
   than it: the top-down game keeps working exactly as it did on machines with no
   WebGL2, every 2D test in the suite stays meaningful, and a bug can be bisected
   by pressing a button rather than by checking out a different branch.

   WHAT IS SHARED AND WHAT IS NOT. The world, the physics, the missions, the
   police, the streaming, the radar, the big map and the whole HUD are shared and
   untouched — the radar is a separate canvas and the HUD is DOM. What is new is
   this file, gl.js under it, and the two files that give the car a third
   dimension to be in. The objective arrow is shared too, which is why toScreen()
   has to mean something here: it is projected through the 3D camera and drawn on
   the 2D canvas, which sits over the WebGL one as a transparent overlay.

   HOW THE GEOMETRY IS BATCHED. Per 512 m cell, built once, kept on the GPU, and
   culled as a unit against the frustum. That matches how the world arrives —
   tiles stream in and get recycled — and it means nothing is rebuilt per frame
   except the things that actually move. A cell is built on the frame it is first
   needed, one per frame, so driving into a new district costs a few frames of
   empty ground at the horizon rather than a stall.

   ONE LIGHT, AND IT CASTS. There is a sun in daylight and a moon at dusk: a
   single directional source, drawn in the sky where its own rays say it is, with
   a real shadow map under it. Everything the sun can see is rendered once more
   from the sun's point of view, and the depth that comes back is what every
   surface in the main pass asks before deciding whether it is lit. */

let MODE3D = false;
let SOFT3D = false;      // the chase view, without a GPU

/* How far the world is drawn, in metres. Fog closes over the last third of it,
   so cells stop existing behind a wall of sky rather than popping out of a clear
   view. */
const VIEW3 = 760;
const FOG0 = 300;
const CELL3 = 512;
const CELL_CAP = 44;                 // cells kept on the GPU before the far ones go
const GND_DIV = 16;                  // ground tessellation per cell: 32 m a quad
const SEG_MAX = 24;                  // road segments longer than this split to follow hills

/* THE SHADOW MAP covers a square this many metres either side of the car.

   170 is a deliberate compromise and worth stating. One map has one resolution,
   and spreading 2048 texels over a kilometre gives four-metre shadow pixels —
   a building's shadow becomes a staircase. Spreading them over 340 metres gives
   17 cm, which is sharp enough for a kerb. What that costs is shadows only near
   the car, and that turns out not to matter: past 300 m the fog has started and
   by 760 there is nothing left to shade. A cascaded map would fix it properly
   and is three times the code for scenery you can barely see. */
const WHEEL_R2 = 90 * 90;            // past this a wheel is not worth the triangles
const WIN_MIN_H = 5.5;               // shorter than this is a shed, and gets no windows
const SHADOW_R = 170;
const SHADOW_SIZE = 2048;

/* Palette slots for the ground pass. Their COLOURS live in a uniform array, not
   in the vertex buffer, so pressing N to swap dusk for daylight changes six
   vec3s and redraws — it does not rebuild a single triangle. That is the same
   promise resolveColours() makes in the 2D game, kept the same way. */
const PAL_GROUND = 0, PAL_PARK = 1, PAL_KERB = 2, PAL_ROAD = 3, PAL_BIG = 4, PAL_LINE = 5;

/* Two looks, as the 2D themes are two looks. Sky, sun and shadow are 3D-only
   concerns — the top-down view has no horizon and fakes its lighting by
   multiplying wall colours — so they live here rather than in THEMES.

   THE LIGHT VALUES ARE DERIVED, NOT PICKED. Each theme in util.js already states
   exactly how bright a wall and a roof are meant to be: dusk multiplies the
   material by 0.17 for a wall and 0.30 for a roof, daylight by 0.66 and 1.00.
   Those numbers are the two views' only chance of looking like the same game, so
   amb and lc here are solved backwards out of them — with this light direction a
   roof collects amb·1.30 + lc·0.73 and a lit wall amb + lc·0.56, and the pairs
   below land within a few percent of what the 2D renderer paints. Eyeballing
   them instead is how you get a night that reads as an overcast afternoon, which
   is exactly what the first attempt at this did.

   `shadowK` is how dark a shaded surface goes. It is nowhere near zero and must
   not be: a shadow is the absence of the SUN, not the absence of light, and the
   sky still fills it. At dusk it is barely anything, because at dusk almost all
   the light is ambient already.

   THE LIGHT IS LOW — around 30° for the sun, 22° for the moon — and that is the
   one place this deliberately parts company with the 2D theme. The theme's
   numbers imply a source almost directly overhead, which is what makes a roof
   brighter than a wall; but a source overhead casts a shadow the length of its
   own building's footprint, and the whole reason for having a sun at all is the
   shadow it throws down a street. Low light also means a lit wall ends up
   brighter than a roof, which is not a mismatch to apologise for — it is what
   late afternoon looks like. */
/* AND THE SUN IS IN THE SOUTH, because this city is at 44° north and the sun
   has never once been anywhere else.

   ld points TOWARDS the light. +x is east and +z is south — projY negates
   latitude, so a larger world y is a lower latitude — and both themes used to
   carry a negative z, which put the sun in the NORTH-west and lit every north
   face while the south of every building sat in shadow all day. Nobody who has
   not stood in the street would spot it from a screenshot; anybody who lives
   there sees it immediately, and it was reported from Belgrade.

   Flipping that one sign puts both themes in the south-west — bearing 226 and
   230°, elevation 18 and 16° — which is a northern-hemisphere afternoon going
   into evening, and the low angle the shadows were tuned for in the first
   place. */
const SKY = {
  dusk: {
    // a shade above PAL.ground on purpose, so the horizon is a line rather than
    // the place two identical blacks meet
    sky: [.105, .062, .175], amb: [.085, .070, .135], lc: [.15, .125, .17],
    ld: [-.70, .26, .58], shadowK: .82,
    // overhead at dusk is nearly black; the last of the light is on the skyline
    zen: [.035, .022, .085], glow: [.16, .09, .20],
    // after dark a third of the windows are somebody's front room
    glass: [.10, .11, .17], win: [1, .80, .46], winK: .32, glassE: .34,
    orb: { col: [.80, .84, 1], r: 11, halo: 3.0, ha: .12 }       // the moon
  },
  day: {
    sky: [.62, .70, .80], amb: [.34, .355, .39], lc: [.64, .60, .53],
    ld: [-.66, .30, .64], shadowK: .58,
    /* The zenith of the reference photograph, near enough. It is a much stronger
       blue than the horizon, and getting that difference wrong in either
       direction is the difference between "outdoors" and "a grey backdrop". */
    zen: [.20, .38, .68], glow: [.30, .26, .17],
    // daylight glass is the sky reflected in it, and almost nothing is lit
    glass: [.30, .37, .47], win: [1, .93, .74], winK: .03, glassE: 0,
    orb: { col: [1, .95, .78], r: 17, halo: 3.6, ha: .22 }       // the sun
  }
};

/* CSS colour to a 0..1 triple. The palette is written as strings because the 2D
   canvas takes strings; this is the one place that has to care. */
function col3(s) {
  const c = parseColour(s);
  if (c) return [c[0] / 255, c[1] / 255, c[2] / 255];
  const m = /rgba?\(([^)]+)\)/.exec(String(s));
  if (!m) return [1, 0, 1];                       // magenta: a missing colour should be loud
  const p = m[1].split(',').map(parseFloat);
  return [(p[0] || 0) / 255, (p[1] || 0) / 255, (p[2] || 0) / 255];
}
function colA(s) {
  const m = /rgba\(([^)]+)\)/.exec(String(s));
  return m ? (parseFloat(m[1].split(',')[3]) || 1) : 1;
}
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/* ------------------------------ shaders ------------------------------ */
const VS_COMMON = `#version 300 es
in vec3 aPos; in vec3 aNrm;
uniform mat4 uVP, uLVP;
out vec3 vN; out float vD; out vec4 vL;
`;

const FS_HEAD = `#version 300 es
precision mediump float;
precision mediump sampler2DShadow;
in vec3 vN; in float vD; in vec4 vL;
uniform vec3 uLdir, uLcol, uAmb, uFog;
uniform vec2 uFogR;
uniform sampler2DShadow uShadow;
/* x is one texel of the shadow map; y is 1 when there is a shadow map at all,
   so a machine that could not allocate one still renders, just unshadowed. */
uniform vec2 uSmap;
out vec4 outC;

/* HOW MUCH OF THE SUN THIS FRAGMENT CAN SEE, 0 to 1.

   sampler2DShadow is doing more work here than it looks. With the texture's
   compare mode set, one texture() call does the depth comparison AND bilinear
   filtering of the COMPARISON — so a single tap is already four samples' worth
   of softening, in hardware, for free. Four taps on top of that is sixteen
   effective samples, which is what turns a staircase into an edge.

   The last two lines are the part that is easy to leave out and impossible to
   unsee: the map only covers a few hundred metres, so without a fade the
   shadowed region ends at a hard straight line across the road. */
float sunlit() {
  if (uSmap.y < 0.5) return 1.0;
  vec3 q = vL.xyz / vL.w * 0.5 + 0.5;
  if (q.z > 1.0 || min(q.x, q.y) < 0.0 || max(q.x, q.y) > 1.0) return 1.0;
  float t = uSmap.x;
  float s = texture(uShadow, vec3(q.xy + vec2(-t, -t), q.z))
          + texture(uShadow, vec3(q.xy + vec2( t, -t), q.z))
          + texture(uShadow, vec3(q.xy + vec2(-t,  t), q.z))
          + texture(uShadow, vec3(q.xy + vec2( t,  t), q.z));
  vec2 e = abs(q.xy - 0.5) * 2.0;
  return mix(1.0, s * 0.25, clamp((1.0 - max(e.x, e.y)) * 7.0, 0.0, 1.0));
}

vec4 fogged(vec3 c) {
  float f = clamp((vD - uFogR.x) / (uFogR.y - uFogR.x), 0.0, 1.0);
  return vec4(mix(c, uFog, f), 1.0);
}
`;

const SH_LIT_V = VS_COMMON + `in vec3 aCol;
in vec2 aWall;
out vec3 vC; out highp vec3 vW;
void main() {
  vec4 p = uVP * vec4(aPos, 1.0);
  gl_Position = p; vN = aNrm; vC = aCol; vD = p.w; vL = uLVP * vec4(aPos, 1.0);
  /* HOW FAR ALONG THE FACADE THIS VERTEX SITS — worked out here rather than
     stored, because it is already in the buffer twice over.

     A vertical wall's tangent is its own normal turned a quarter turn in the
     ground plane, so the horizontal coordinate of a facade is one dot product
     with a vector every wall vertex already carries. That is a whole texture
     coordinate for nothing, and it is CONTINUOUS ROUND A CORNER: both walls of a
     corner measure from the same world origin, so the window grid does not jump
     where two walls of one building meet, which is exactly what a per-wall 0..1
     coordinate would have done.

     aWall is the part that cannot be derived: how far up the wall this vertex is
     and how tall the wall is in total. Both are needed to lay floors out from
     the pavement instead of from an arbitrary zero, and to stop the top floor
     being sliced in half by the roofline. Anything that is not a facade — a
     roof, a car, a pedestrian — passes zeroes and takes the plain path. */
  vec2 t = vec2(-aNrm.z, aNrm.x);
  float tl = length(t);
  vW = vec3(tl > 0.001 ? dot(aPos.xz, t / tl) : 0.0, aWall);
}`;
/* vW IS DECLARED highp AND HAS TO BE. It carries a world coordinate, and this
   world is thirty-six kilometres across — so that number reaches ±18000, and the
   whole point of it is the fractional part.

   A fragment shader here runs at mediump, which is ten bits of mantissa. At
   18000 that is a resolution of about sixteen metres, and fract() of a value
   quantised to sixteen metres is not a window grid, it is noise that snaps
   between two values as you drive. Desktop drivers almost all promote mediump to
   full float, which is exactly why this cost nothing to get wrong here and would
   have shipped broken to every phone: iOS runs mediump as genuine half
   precision. In highp the same coordinate resolves to about a millimetre. */

/* uPaint is the difference between a building and a car.

   A building's colour in the buffer is raw material — the concrete a mapper
   typed in — and the theme's light is what makes it a night-time building. A
   car's is its paint, and drawCar() in the 2D renderer puts that on the canvas
   at full strength in both themes, because a car is a lacquered object under
   street lights rather than a lump of masonry. Running the dusk light over a
   neon pink car turns it into a dark grey one, which is what the first version
   of this did — the fleet went from a Vice City car park to a queue of gravel.

   So cars keep their colour and take only enough shading to tell one face from
   another, and enough of the shadow term to sit in one rather than glow in it.
   Same program, same buffer, one uniform flipped between two draw calls that
   were already separate. */
const SH_LIT_F = FS_HEAD + `in vec3 vC; in highp vec3 vW;
uniform float uPaint;
uniform vec3 uGlass, uWinCol;
/* How tall a wall has to be before it gets windows. Sheds and lock-ups do not,
   and a test sets it out of reach to render the identical frame with the facades
   plain — which costs nothing, because the comparison is on the fast path
   already and would be there whatever the number was. */
uniform float uWinK, uGlassE, uWinMin;

/* A HASH THAT DOES NOT USE sin(), for the same reason the varying above is
   highp. The usual fract(sin(dot(p, k)) * 43758.5) is fine when p is a screen
   coordinate and useless when it is a floor()ed world one: p reaches six
   thousand here, the dot product reaches two million, and sin() of two million
   in single precision has three bits of fraction left in its argument. Whole
   districts would light the same window pattern, and change it as you drove.

   This one folds the magnitude away in the first line — fract() BEFORE anything
   large happens — so it keeps its full range whatever p is. */
float h21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

void main() {
  vec3 nn = normalize(vN);
  float sh = sunlit();
  float d = max(dot(nn, uLdir), 0.0);
  float s = max(nn.y, 0.0) * 0.30;
  vec3 base = vC;

  /* WINDOWS, which is the whole difference between a city and a heap of boxes.

     A real street is not made of flat coloured slabs — it is rows of glass, and
     the eye reads those rows as scale before it reads anything else. Everything
     needed is already here: a horizontal coordinate from the vertex shader, a
     height above the pavement, and the wall's own height to know where to stop.

     The grid is anchored to the WORLD, not to the wall, so a long block's
     windows line up along its whole length and round its corners. Floors are
     3.15 m and bays 2.85 m, which are ordinary numbers for the kind of interwar
     and socialist-era block the reference photograph is full of. The ground
     floor is left plain below 2.6 m — real ground floors are shopfronts,
     doorways and shutters, not the same window repeated — and the top 1.2 m is
     left plain as a cornice, so the roofline does not cut a row of windows in
     half.

     ANTIALIASING IS NOT OPTIONAL HERE. A 2.85 m bay is well under a pixel by the
     time a block is a hundred metres away, and a hard step() against a
     sub-pixel pattern is a wall of crawling static as the camera moves. fwidth
     gives the width of one pixel in grid units, which does two jobs: it softens
     each window edge to exactly one pixel, and when it grows past about half a
     cell the pattern dissolves back into plain wall — which is what a distant
     facade looks like anyway. */
  float win = 0.0, onLit = 0.0;
  if (uPaint < 0.5 && vW.z > uWinMin && abs(nn.y) < 0.5) {
    float up = vW.y, top = vW.z - 1.2;
    if (up > 2.6 && up < top) {
      vec2 cell = vec2(vW.x / 2.85, (up - 2.6) / 3.15);
      vec2 f = fract(cell);
      vec2 w = max(fwidth(cell), vec2(1e-4));
      float mx = smoothstep(0.25 - w.x, 0.25 + w.x, f.x)
               * (1.0 - smoothstep(0.72 - w.x, 0.72 + w.x, f.x));
      float my = smoothstep(0.17 - w.y, 0.17 + w.y, f.y)
               * (1.0 - smoothstep(0.66 - w.y, 0.66 + w.y, f.y));
      win = mx * my * clamp(1.0 - max(w.x, w.y) * 2.2, 0.0, 1.0);
      /* Which windows have a light on. Seeded from the cell's world position and
         the building's height, so it is stable — a window does not flicker as
         you drive past it — and no two blocks light the same pattern. */
      onLit = step(1.0 - uWinK, h21(floor(cell) + vec2(vW.z, 0.0)));
    }
    /* The bottom two metres of a real wall are darker than the rest: soot,
       rain-splash, and the pavement's own shadow. It costs one mix and it is
       what stops a building looking like it was pasted onto the ground. */
    base *= mix(0.70, 1.0, clamp(up / 2.6, 0.0, 1.0));
  }

  vec3 lit = base * (uAmb * (1.0 + s) + uLcol * d * sh);
  vec3 paint = base * (0.55 + 0.45 * d * sh);
  vec3 c = mix(lit, paint, uPaint);

  if (win > 0.004) {
    /* Glass takes very little diffuse light and a lot of whatever is opposite
       it, so it stays dark on a lit wall and dark on an unlit one — which is why
       a window reads as a hole rather than as a patch of paint. A lit one is
       emissive and ignores the sun entirely.

       uGlassE is what a dark window still gives back after sunset: the sky, the
       street below it, the lamp on the corner. Without it the dusk theme's
       ambient is so low that an unlit facade is a black rectangle with a few
       yellow squares floating on it, and the wall next to the camera — the one
       filling a third of the screen — has no grid at all. Daylight sets it to
       zero, because in daylight the reflection is already in the diffuse term. */
    vec3 g = uGlass * (uAmb * 1.30 + uLcol * d * sh * 0.55 + uGlassE);
    c = mix(c, mix(g, uWinCol, onLit), win);
  }
  outC = fogged(c);
}`;

const SH_GND_V = VS_COMMON + `in float aPal;
flat out int vP;
void main() {
  vec4 p = uVP * vec4(aPos, 1.0);
  gl_Position = p; vN = aNrm; vP = int(aPal); vD = p.w; vL = uLVP * vec4(aPos, 1.0);
}`;

/* THE GROUND IS NOT LIT THE WAY THE BUILDINGS ARE, and that is deliberate.

   A building carries a raw material colour and the theme is what turns it into
   something to draw. The ground, the parks and the roads do not: PAL.road is
   already the final dusk road colour, chosen by eye against PAL.ground. Running
   a light over it a second time multiplies a number that has had its
   multiplication, and the first attempt at this file did exactly that — dusk
   came out as a black rectangle with a slightly less black rectangle on it.

   So a flat surface here is EXACTLY the palette colour, and the shading term is
   only the difference between this surface's angle and a flat one's. A road
   across a hillside catches more or less than the same road on the level, the
   values agree with the top-down view metre for metre, and nothing is darkened
   twice. The shadow is then a separate multiply, because a shadow is a fact
   about the sun and not about the paint. */
const SH_GND_F = FS_HEAD + `flat in int vP;
uniform vec3 uPal[8];
uniform float uShadowK;
void main() {
  vec3 nn = normalize(vN);
  float k = clamp(1.0 + (dot(nn, uLdir) - uLdir.y) * 1.15, 0.55, 1.5);
  outC = fogged(uPal[vP] * k * mix(uShadowK, 1.0, sunlit()));
}`;

/* Particles, tyre marks, street lights, the sun itself: no lighting, straight
   colour and alpha.

   aUV is what tells a soft thing from a hard one, and it does it without a
   second program or a uniform to flip between them. A glow is built with its
   corners at (±1, ±1) and fades to nothing at radius one; a tyre mark is built
   with every corner at (0, 0), which is the centre of that falloff, so it comes
   out flat and fully opaque. One buffer, one draw, both shapes.

   Hard-edged glows were the first version of this, and a street lamp is six
   metres up while the camera is six metres up — so driving past one put a
   seven-metre opaque rectangle across half the screen. */
const SH_FX_V = `#version 300 es
in vec3 aPos; in vec4 aCol; in vec2 aUV;
uniform mat4 uVP;
out vec4 vC; out vec2 vU;
void main() { gl_Position = uVP * vec4(aPos, 1.0); vC = aCol; vU = aUV; }`;
const SH_FX_F = `#version 300 es
precision mediump float;
in vec4 vC; in vec2 vU;
out vec4 outC;
void main() {
  float a = vC.a * (1.0 - smoothstep(0.0, 1.0, length(vU)));
  if (a <= 0.004) discard;
  outC = vec4(vC.rgb, a);
}`;

/* A SIGN: one textured quad, alpha-cut, fogged like everything else so a name a
   quarter of a mile away fades into the haze with the building carrying it. It
   takes the theme's ambient rather than the sun, because a fascia sign is lit
   from in front at night and painted white by day, and either way it should not
   go black when it happens to face away from the sun. */
const SH_SIGN_V = `#version 300 es
in vec3 aPos; in vec2 aUV;
uniform mat4 uVP;
out vec2 vU; out float vD;
void main() { vec4 p = uVP * vec4(aPos, 1.0); gl_Position = p; vU = aUV; vD = p.w; }`;
const SH_SIGN_F = `#version 300 es
precision mediump float;
in vec2 vU; in float vD;
uniform sampler2D uTex;
uniform vec3 uFog, uInk;
uniform vec2 uFogR;
out vec4 outC;
void main() {
  vec4 t = texture(uTex, vU);
  if (t.a <= 0.02) discard;
  float f = clamp((vD - uFogR.x) / (uFogR.y - uFogR.x), 0.0, 1.0);
  /* The glyphs are white and their rim is black; multiplying by the ink colour
     tints the letters without touching the rim, which is what keeps them legible
     on a pale wall in daylight and warm at dusk. */
  outC = vec4(mix(t.rgb * uInk, uFog, f), t.a * (1.0 - f));
}`;

/* THE CAR, which is the one thing in this world that is a MODEL rather than
   geometry generated from the map.

   Everything else here is built in world space and poured into a shared buffer,
   because a building never moves and a tyre mark never turns. A car does both,
   forty times a frame, and re-transforming four hundred triangles per car on the
   CPU to put them in a shared buffer would be several hundred thousand vertex
   transforms a frame in JavaScript for no reason at all. So the mesh is uploaded
   once, in the car's own coordinates, and each car is a model matrix.

   uMVP and uMLVP arrive pre-multiplied — the projection times the view times the
   model, worked out once per car on the CPU — so the vertex shader costs exactly
   what the static one costs and the whole difference is a handful of uniforms
   per draw.

   uNM is the awkward one and it is not the model matrix's rotation. The car's
   forward, lateral and up vectors have three DIFFERENT lengths, being half a
   length, half a width and half a height, so the model transform carries a
   non-uniform scale and normals pushed through it come out pointing off the
   surface — a long car would light as though it were leaning. The inverse
   transpose is what fixes that, and for a matrix whose columns are orthogonal it
   is just each column divided by its own length squared, which is what
   render3d.js hands over.

   THE PAINT IS A PALETTE LOOKUP, the same trick the ground uses. Slot zero is
   the car's own colour and changes per draw; the rest — glass, tyre, alloy, tail
   light, headlight, trim — are the same on every car in the city, which is what
   makes a pink car with black tyres possible at all. A mesh with one baked
   texture atlas, which is how the ready-made low-poly car kits are built, cannot
   do that: it would be one colour for the whole fleet. */
const SH_CAR_V = `#version 300 es
in vec3 aPos; in vec3 aNrm; in float aPal;
uniform mat4 uMVP, uMLVP;
uniform mat3 uNM;
out vec3 vN; out float vD; out vec4 vL; flat out int vP;
void main() {
  vec4 p = uMVP * vec4(aPos, 1.0);
  gl_Position = p; vD = p.w;
  vN = uNM * aNrm;
  vP = int(aPal);
  vL = uMLVP * vec4(aPos, 1.0);
}`;

/* Lit as PAINT, not as masonry — the same reasoning as the uPaint branch next
   door. A car is a lacquered object under street lights and the 2D view draws it
   at full strength in both themes; running the dusk light over a neon pink car
   turns it into a grey one. So it keeps its colour and takes only enough shading
   to tell one panel from another, plus enough of the shadow term to sit in a
   shadow rather than glow in it.

   Two materials break that rule on purpose. Glass barely takes diffuse light at
   all and mostly shows what is opposite it, so it stays dark and reads as a hole
   rather than as a dark patch of paint. Lamps ignore the sun completely, because
   a tail light is a light. */
const SH_CAR_F = FS_HEAD + `flat in int vP;
uniform vec3 uCarPal[7];
void main() {
  vec3 nn = normalize(vN);
  float sh = sunlit();
  float d = max(dot(nn, uLdir), 0.0);
  vec3 c = uCarPal[vP];
  vec3 lit = c * (0.55 + 0.45 * d * sh);
  if (vP == 1) lit = c * (uAmb * 2.2 + uLcol * d * sh * 0.5) + vec3(0.035, 0.04, 0.055);
  if (vP >= 4 && vP <= 5) lit = c;
  outC = fogged(lit);
}`;

/* THE SKY, which used to be gl.clearColor and one flat number.

   A real sky is never one colour. It is deep overhead and pale at the horizon,
   because looking up is a short path through the air and looking level is a very
   long one — and that gradient is most of what tells you a picture was taken
   outdoors. The reference photograph makes the point better than any amount of
   tuning: the blue directly above the roofline is several shades darker than the
   blue between the buildings.

   It is drawn as ONE TRIANGLE covering the screen, not two, and not a quad: a
   single oversized triangle has no seam down the diagonal where the two halves
   of a quad meet, and shades fewer fragments. gl_VertexID makes it, so it needs
   no vertex buffer at all.

   The view ray comes from the camera's own basis passed as a mat3 rather than
   from inverting the view-projection, because the three vectors are sitting
   right there in the view matrix and a 4×4 inverse is a hundred lines this file
   would then have to keep correct. Scale the columns by the tangents of the half
   angles and the interpolated result IS the world-space direction through that
   pixel. */
const SH_SKY_V = `#version 300 es
uniform mat3 uCamB;
out vec3 vDir;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
  vDir = uCamB * vec3(p, 1.0);
  gl_Position = vec4(p, 1.0, 1.0);
}`;
const SH_SKY_F = `#version 300 es
precision mediump float;
in vec3 vDir;
uniform vec3 uZen, uHor, uLdir, uGlow;
out vec4 outC;
void main() {
  vec3 d = normalize(vDir);
  /* pow on the height, not the height itself: a linear ramp puts the pale band
     halfway up the screen, where no sky has ever put it. The horizon haze is a
     thin thing hugging the skyline and the blue takes over quickly above it. */
  float up = clamp(d.y, 0.0, 1.0);
  vec3 c = mix(uHor, uZen, pow(up, 0.42));
  /* Below the horizon is haze fading down, so a camera tipped forward over a
     crest does not show a hard edge under the ground it is about to draw. */
  c = mix(c, uHor, clamp(-d.y * 6.0, 0.0, 1.0));
  // the sun's or moon's own glow spread into the air around it
  float g = pow(max(dot(d, uLdir), 0.0), 5.0);
  outC = vec4(c + uGlow * g, 1.0);
}`;

/* The shadow pass. Position in, depth out, nothing else — the fragment shader
   writes no colour because there is no colour buffer attached to write it to. */
const SH_DEP_V = `#version 300 es
in vec3 aPos;
uniform mat4 uVP;
void main() { gl_Position = uVP * vec4(aPos, 1.0); }`;
const SH_DEP_F = `#version 300 es
precision mediump float;
void main() {}`;

/* ------------------------------ state ------------------------------ */
const G3 = {
  ready: false,
  lit: null, gnd: null, fx: null, dep: null, sky: null, car: null,   // programs
  carVao: null, carN: 0,                          // the car mesh, uploaded once
  skyVao: null,                                   // the fullscreen triangle's empty VAO
  sm: null,                                       // the shadow map, or null
  cells: new Map(),                               // key -> built cell
  idx: new Map(),                                 // key -> buildings by centroid
  seen: 0,                                        // how much of W.buildings is indexed
  roadN: -1, parkN: -1,                           // world-shape signature, for invalidation
  VP: M4.make(), V: M4.make(), Pm: M4.make(),
  Vl: M4.make(), Pl: M4.make(), LVP: M4.make(),   // the sun's point of view
  planes: [],
  cars: null, fxm: null,                          // per-frame streams
  cam: { h: 0, d: 15, y: 7, ex: 0, ey: 0, ez: 0 },
  // set by the test hook only: renders the identical frame with the sun's
  // shadows switched off, so a difference can be attributed to exactly one thing
  noShadow: false,
  noWin: false, plainCars: false,
  built: 0, drawn: 0, tris: 0, shadowTris: 0
};

/* Scratch for the per-car draws. Allocated once: a frame with forty cars in it
   would otherwise make forty matrices, forty normal matrices and forty of each
   product, every frame, for the garbage collector to deal with mid-drive. */
const CARM = { m: M4.make(), nm: new Float32Array(9), mvp: M4.make(), mlvp: M4.make(),
               pal: new Float32Array(21) };

const cellKey = (kx, kz) => kx + ',' + kz;
const cellOf = v => Math.floor(v / CELL3);

function initGL3() {
  if (G3.ready) return true;
  const gl = GL.gl;
  if (!gl) return false;
  G3.lit = GL.program(SH_LIT_V, SH_LIT_F);
  G3.gnd = GL.program(SH_GND_V, SH_GND_F);
  G3.fx = GL.program(SH_FX_V, SH_FX_F);
  G3.dep = GL.program(SH_DEP_V, SH_DEP_F);
  G3.sky = GL.program(SH_SKY_V, SH_SKY_F);
  G3.car = GL.program(SH_CAR_V, SH_CAR_F);
  G3.sign = GL.program(SH_SIGN_V, SH_SIGN_F);
  {
    const m = carMesh();
    const mesh = GL.mesh(m, [[G3.car.a.aPos, 3], [G3.car.a.aNrm, 3], [G3.car.a.aPal, 1]]);
    G3.carVao = mesh ? mesh.vao : null;
    G3.carN = mesh ? mesh.n : 0;
  }
  /* A draw call with no attributes still needs SOME vertex array bound, and
     whatever was left bound from the last mesh would have its attributes enabled
     and its buffer read — legal, but it makes a driver fetch data nothing uses.
     One empty VAO, made once. */
  G3.skyVao = gl.createVertexArray();
  /* A shadow map is a nice-to-have, not a requirement. If the depth texture will
     not allocate — an old driver, a tight memory budget — uSmap.y stays zero and
     every surface reports itself fully lit, which is the picture this had before
     shadows existed rather than a black screen. */
  G3.sm = GL.shadowMap(SHADOW_SIZE);
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  G3.ready = true;
  return true;
}

/* A lost context takes every buffer, texture and program with it. Drop the lot
   and let the next frame notice G3.ready is false and build it again. */
function glContextLost() {
  G3.ready = false;
  G3.cells.clear();
  G3.cars = G3.fxm = null;
  G3.sm = null;
  G3.skyVao = null;
  G3.carVao = null; G3.carN = 0;
  GL.gl = null;
}

/* ------------------------------ the index ------------------------------ */
/* Buildings, filed by the cell their centroid falls in. Appended to as tiles
   stream in; thrown away and rebuilt whole when the world SHRINKS, because
   evictFarTiles filters W.buildings and there is no way to tell from the outside
   which ones went. That happens every few hundred metres at most, and rebuilding
   an index over a few thousand centroids is well under a millisecond — the
   expensive part is the GPU geometry, and only the cells still on screen get
   rebuilt, one per frame. */
/* A building ALREADY in the world has changed, so whatever was built for its
   cell is now out of date. syncIndex3 covers buildings that are new — it drops
   the cell of every arrival — but not one that has been standing for a minute
   and has just been handed the name of the shop on its ground floor. Called
   from world.js when that happens; a no-op before the chase view has ever been
   switched on, which is why it checks for the map at all. */
function dirtyCellAt(x, z) {
  if (!G3.cells) return;
  const k = cellKey(cellOf(x), cellOf(z));
  const c = G3.cells.get(k);
  if (c) { freeCell(c); G3.cells.delete(k); }
}

function syncIndex3() {
  if (W.buildings.length < G3.seen) {
    G3.idx.clear();
    dropAllCells();
    G3.seen = 0;
  }
  for (let i = G3.seen; i < W.buildings.length; i++) {
    const b = W.buildings[i];
    const k = cellKey(cellOf(b.cx), cellOf(b.cy));
    const a = G3.idx.get(k);
    if (a) a.push(b); else G3.idx.set(k, [b]);
    // whatever was already built for that cell is now missing a building
    const c = G3.cells.get(k);
    if (c) { freeCell(c); G3.cells.delete(k); }
  }
  G3.seen = W.buildings.length;

  /* Roads and parks have no per-cell index — they are walked from the spatial
     hash at build time — so a change in either invalidates everything. Roads
     only ever grow once a skeleton is up, so in practice this fires while a
     district streams in and then never again. */
  if (W.roads.length !== G3.roadN || W.parks.length !== G3.parkN) {
    G3.roadN = W.roads.length; G3.parkN = W.parks.length;
    dropAllCells();
  }
}
function freeCell(c) { GL.free(c.gnd); GL.free(c.lit); GL.free(c.sgn); }
function dropAllCells() {
  for (const c of G3.cells.values()) freeCell(c);
  G3.cells.clear();
}

/* ------------------------------ cell geometry ------------------------------ */
/* A quad from four corners, with one normal, into a ground buffer. */
function gquad(o, ax, ay, az, bx, by, bz, cx2, cy2, cz2, dx, dy, dz, nx, ny, nz, pal) {
  o.push(ax, ay, az, nx, ny, nz, pal, bx, by, bz, nx, ny, nz, pal, cx2, cy2, cz2, nx, ny, nz, pal);
  o.push(ax, ay, az, nx, ny, nz, pal, cx2, cy2, cz2, nx, ny, nz, pal, dx, dy, dz, nx, ny, nz, pal);
}

/* A polyline drawn as a flat ribbon lying on the ground.

   Long segments are cut down to SEG_MAX so the ribbon follows the hills instead
   of tunnelling through them — a 200 m straight drawn as one quad is a straight
   line in space, and the hill it crosses comes through the middle of the road.
   And each interior joint gets a patch across it, because 3D has no equivalent
   of the round line joins the 2D renderer leans on: without it every bend in
   every street has a notch bitten out of the outside of it. */
function ribbon(o, pts, w, pal, lift, x0, z0, x1, z1) {
  const hw = w * .5;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1].x, az = pts[i - 1].y, bx = pts[i].x, bz = pts[i].y;
    // only the segments belonging to this cell, decided by midpoint so a road
    // crossing four cells is drawn once in each and never twice in either
    const mx = (ax + bx) * .5, mz = (az + bz) * .5;
    if (mx < x0 || mx >= x1 || mz < z0 || mz >= z1) continue;
    const dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz);
    if (L < 1e-4) continue;
    const ux = dx / L, uz = dz / L;
    const px = -uz * hw, pz = ux * hw;
    const steps = Math.max(1, Math.ceil(L / SEG_MAX));
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps, t1 = (s + 1) / steps;
      const sx = ax + dx * t0, sz = az + dz * t0;
      const ex = ax + dx * t1, ez = az + dz * t1;
      const y0 = terrainH(sx - px, sz - pz) + lift, y1 = terrainH(sx + px, sz + pz) + lift;
      const y2 = terrainH(ex + px, ez + pz) + lift, y3 = terrainH(ex - px, ez - pz) + lift;
      gquad(o, sx - px, y0, sz - pz, sx + px, y1, sz + pz,
               ex + px, y2, ez + pz, ex - px, y3, ez - pz, 0, 1, 0, pal);
    }
    // the patch over the joint into the next segment
    if (i < pts.length - 1) {
      const nx2 = pts[i + 1].x - bx, nz2 = pts[i + 1].y - bz;
      const nl = Math.hypot(nx2, nz2);
      if (nl > 1e-4) {
        let jx = ux + nx2 / nl, jz = uz + nz2 / nl;
        const jl = Math.hypot(jx, jz) || 1;
        jx /= jl; jz /= jl;
        const qx = -jz * hw, qz = jx * hw, rx = jx * hw, rz = jz * hw;
        const y = terrainH(bx, bz) + lift;
        gquad(o, bx - qx - rx, y, bz - qz - rz, bx + qx - rx, y, bz + qz - rz,
                 bx + qx + rx, y, bz + qz + rz, bx - qx + rx, y, bz - qz + rz, 0, 1, 0, pal);
      }
    }
  }
}

/* The dashed centre line, as real dashes. Only on roads wide enough to have one,
   which is the same test the 2D renderer makes. */
function dashes(o, pts, lift, x0, z0, x1, z1) {
  // the same dash and the same width the 2D renderer strokes: 0.55 m of paint,
  // not the 0.7 the first pass used, which three metres from the camera is a
  // yellow runway rather than a centre line
  const ON = 3.2, OFF = 5.4, HW = .275;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1].x, az = pts[i - 1].y, bx = pts[i].x, bz = pts[i].y;
    const mx = (ax + bx) * .5, mz = (az + bz) * .5;
    if (mx < x0 || mx >= x1 || mz < z0 || mz >= z1) continue;
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
    if (L < ON) continue;
    const ux = dx / L, uz = dz / L, px = -uz * HW, pz = ux * HW;
    for (let d = 0; d + ON < L; d += ON + OFF) {
      const sx = ax + ux * d, sz = az + uz * d;
      const ex = ax + ux * (d + ON), ez = az + uz * (d + ON);
      const y = terrainH((sx + ex) * .5, (sz + ez) * .5) + lift;
      gquad(o, sx - px, y, sz - pz, sx + px, y, sz + pz,
               ex + px, y, ez + pz, ex - px, y, ez - pz, 0, 1, 0, PAL_LINE);
    }
  }
}

/* A POLYGON CUT DOWN TO A RECTANGLE — Sutherland–Hodgman, four half-planes.

   Each pass keeps the vertices on the inside of one edge and inserts the crossing
   point wherever the outline steps over it, so a convex window like a cell always
   leaves a simple polygon that earClip can triangulate. A shape entirely outside
   comes back empty, which the caller reads as "nothing of this park is here". */
const cutAt = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
function clipToCell(pts, x0, z0, x1, z1) {
  const inside = [p => p.x >= x0, p => p.x <= x1, p => p.y >= z0, p => p.y <= z1];
  const cross = [
    (a, b) => cutAt(a, b, (x0 - a.x) / ((b.x - a.x) || 1e-9)),
    (a, b) => cutAt(a, b, (x1 - a.x) / ((b.x - a.x) || 1e-9)),
    (a, b) => cutAt(a, b, (z0 - a.y) / ((b.y - a.y) || 1e-9)),
    (a, b) => cutAt(a, b, (z1 - a.y) / ((b.y - a.y) || 1e-9))
  ];
  let cur = pts;
  for (let k = 0; k < 4 && cur.length; k++) {
    const next = [];
    for (let i = 0, j = cur.length - 1; i < cur.length; j = i++) {
      const A = cur[j], B = cur[i];
      const ia = inside[k](A), ib = inside[k](B);
      if (ib) { if (!ia) next.push(cross[k](A, B)); next.push(B); }
      else if (ia) next.push(cross[k](A, B));
    }
    cur = next;
  }
  return cur;
}

/* THE NAME OVER THE DOOR.

   OpenStreetMap knows what a great many of these buildings are called — 329 of
   the 3502 in the bundled Stari grad capture carry a name, and the shops and
   garages inside the rest carry their own. A city where the casino says GRAND
   CASINO ADMIRAL across its parapet is a different place from one made of
   anonymous boxes, and it is the single cheapest thing that can be done with
   data already in the payload.

   A SIGN IS A TEXTURE, and text is the one thing WebGL cannot draw. So the
   letters are painted with the 2D canvas — the same one the radar uses — into a
   shared atlas, and each sign is one quad reading one cell of it. The atlas is
   allocated once at a fixed size and written a cell at a time with
   texSubImage2D, because re-uploading a megabyte every time a new shop comes
   into view is exactly the kind of thing that turns a smooth drive into a
   stutter.

   Sixty-four cells, and no eviction. Signs are baked into a cell's static mesh
   with their texture coordinates already in the buffer, so recycling a slot
   would silently rename a building three streets back. When the atlas is full,
   later names simply do not get a sign — which is a city with fewer signs in it,
   not a city with wrong ones. */
const SIGN_W = 256, SIGN_H = 64, SIGN_COLS = 4, SIGN_ROWS = 16;
const SIGN_MAX = SIGN_COLS * SIGN_ROWS;
const SIGN = { tex: null, cv: null, g: null, map: new Map(), n: 0 };

function signSlot(text) {
  if (SIGN.map.has(text)) return SIGN.map.get(text);
  if (SIGN.n >= SIGN_MAX) return null;
  const gl = GL.gl;
  if (!gl) return null;
  if (!SIGN.tex) {
    SIGN.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, SIGN.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SIGN_W * SIGN_COLS, SIGN_H * SIGN_ROWS,
                  0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    SIGN.cv = document.createElement('canvas');
    SIGN.cv.width = SIGN_W; SIGN.cv.height = SIGN_H;
    SIGN.g = SIGN.cv.getContext('2d');
  }
  const i = SIGN.n++;
  const col = i % SIGN_COLS, row = (i / SIGN_COLS) | 0;
  const g = SIGN.g;
  g.clearRect(0, 0, SIGN_W, SIGN_H);
  /* Upper case and the HUD's condensed face, because that is what a fascia sign
     looks like and because narrow letters fit more of a long Serbian name across
     a wall. Cyrillic and Latin both come out of the same font stack. */
  const label = text.toUpperCase();
  const face = getComputedStyle(document.body).getPropertyValue('--hud');
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  /* SHRUNK TO FIT, NOT SQUEEZED. The first version scaled the letters
     horizontally to make a long name fit the cell, which turned GRAND CASINO
     ADMIRAL into a column of vertical bars. A name that needs more room gets a
     smaller point size instead, and the QUAD gets wider — because a long name
     genuinely is wider relative to its height, and the sign on the wall should
     say so. */
  const room = SIGN_W - 10;
  let px = 46;
  g.font = px + 'px ' + face;
  const w0 = Math.max(1, g.measureText(label).width);
  if (w0 > room) { px = Math.max(13, Math.floor(px * room / w0)); g.font = px + 'px ' + face; }
  const m = g.measureText(label);
  const asc = m.actualBoundingBoxAscent || px * 0.72;
  const dsc = m.actualBoundingBoxDescent || 0;
  const x = 5, y = Math.min(SIGN_H - 5, (SIGN_H + asc - dsc) / 2);
  // a dark rim so white letters still read against a pale stucco wall
  g.lineWidth = Math.max(3, px * 0.12); g.lineJoin = 'round';
  g.strokeStyle = 'rgba(0,0,0,.55)';
  g.strokeText(label, x, y);
  g.fillStyle = '#fff';
  g.fillText(label, x, y);
  gl.bindTexture(gl.TEXTURE_2D, SIGN.tex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, col * SIGN_W, row * SIGN_H,
                   gl.RGBA, gl.UNSIGNED_BYTE, SIGN.cv);
  /* THE QUAD IS THE INK, not the cell. Mapping the whole 256x64 cell onto the
     wall would hang the letters in the middle of a large invisible rectangle —
     they would come out a third of the size asked for, with the rest of the sign
     padding. So the box the glyphs actually cover is measured and only that is
     mapped, which makes `h` on the wall the height of the letters themselves. */
  const pad = 4;
  const bx0 = Math.max(0, x - pad), bx1 = Math.min(SIGN_W, x + Math.min(room, m.width) + pad);
  const by0 = Math.max(0, y - asc - pad), by1 = Math.min(SIGN_H, y + dsc + pad);
  const AW = SIGN_W * SIGN_COLS, AH = SIGN_H * SIGN_ROWS;
  const s = {
    u0: (col * SIGN_W + bx0) / AW,
    u1: (col * SIGN_W + bx1) / AW,
    v0: (row * SIGN_H + by0) / AH,
    v1: (row * SIGN_H + by1) / AH,
    aspect: (bx1 - bx0) / Math.max(1, by1 - by0)
  };
  SIGN.map.set(text, s);
  return s;
}

/* Letters standing off the wall they are bolted to, which is what stops them
   fighting the masonry for the same depth and is also what a channel-letter sign
   physically does. */
const SIGN_STANDOFF = 0.18;
/* Worked out separately from the pushing so a test can ask where a sign WOULD go
   without reading it back off the GPU. Returns null when the building does not
   get one, and otherwise the two ends of the sign, its top and bottom, and the
   wall it is on. */
function signQuad(b, fp, wind, top, foot) {
  const s = signSlot(b.sign);
  if (!s) return null;
  /* THE WIDEST WALL GETS IT. A name goes on the front of a building, and the
     front of a building in a footprint with no other information is its longest
     side — which for a block on a corner is the one facing the main road.

     TIES GO TO THE WALL FACING SOUTH, and they have to be broken by something,
     because "the first one I found" depends on which vertex OpenStreetMap
     happened to start the ring at and which way round it wound it. A square
     building has four equally widest walls, so the same building drawn from the
     same place would put its name on a different one depending on how the
     outline was listed — winding.mjs exists to catch exactly that and duly
     caught it, half a per cent of the frame moving, all of it lettering.

     South rather than a coin toss because at 44° north that is the lit side and
     the side a boulevard is usually on. Breaking the tie on the midpoint instead
     was the first attempt: also deterministic, and it hung half the signs on
     north walls where the test camera could not see them and neither could a
     driver. */
  const n = fp.length;
  let a = null, c = null, bl = 0, bs = -2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const L = Math.hypot(fp[i].x - fp[j].x, fp[i].y - fp[j].y);
    if (L < 10) continue;                     // no wall worth signing
    // the outward normal of this wall, and how far south it points
    const u = wind > 0 ? fp[i] : fp[j], v = wind > 0 ? fp[j] : fp[i];
    const south = (v.x - u.x) / L;            // nz of (-(ez), ex): +1 is due south
    const win = !a ? true
      : L > bl + 0.05 ? true
      : L < bl - 0.05 ? false
      : south > bs;
    if (win) { a = fp[j]; c = fp[i]; bl = L; bs = south; }
  }
  if (!a) return null;
  const p = wind > 0 ? c : a, q = wind > 0 ? a : c;
  const ex = (q.x - p.x) / bl, ez = (q.y - p.y) / bl;
  const nx = -ez, nz = ex;                    // outward, matching the wall's own
  /* SIZED OFF THE BUILDING, THEN CUT DOWN TO THE WALL. Letters get a fifth of
     the facade's height, which is what a fascia sign takes on a real one, and
     the width follows from the name's own proportions. Only if that would run
     off the end of the wall does the width lead instead — a long name on a
     narrow shopfront gets smaller letters, exactly as it would in the street.

     Doing it the other way round was the first attempt and produced seven metres
     of lettering on a ninety-metre casino: a stamp, not a sign. */
  const wallH = top - foot;
  let h = clamp(wallH * 0.20, 1.2, 6);
  let w = h * s.aspect;
  if (w > bl * 0.8) { w = bl * 0.8; h = w / s.aspect; }
  if (h < 0.8) return null;                   // too small to read; leave it off
  const cxp = p.x + ex * bl / 2, czp = p.y + ez * bl / 2;
  const y1 = top - Math.max(0.5, h * 0.35), y0 = y1 - h;
  if (y0 < foot + 0.5) return null;           // no room under the roofline
  const ox = nx * SIGN_STANDOFF, oz = nz * SIGN_STANDOFF;
  const L = { x: cxp - ex * w / 2 + ox, z: czp - ez * w / 2 + oz };
  const R = { x: cxp + ex * w / 2 + ox, z: czp + ez * w / 2 + oz };
  return { L, R, y0, y1, s, w, h, wall: bl };
}
function pushSign(out, b, fp, wind, top, foot) {
  const q = signQuad(b, fp, wind, top, foot);
  if (!q) return;
  const { L, R, y0, y1, s } = q;
  out.push(L.x, y0, L.z, s.u0, s.v1,
           R.x, y0, R.z, s.u1, s.v1,
           R.x, y1, R.z, s.u1, s.v0);
  out.push(L.x, y0, L.z, s.u0, s.v1,
           R.x, y1, R.z, s.u1, s.v0,
           L.x, y1, L.z, s.u0, s.v0);
}

/* STREET TREES.

   Belgrade's boulevards are lined with plane trees and its blocks are green
   behind them, and a city drawn without any is a model of a city rather than a
   place. OpenStreetMap does map individual trees, but sparsely and unevenly —
   whole avenues that plainly have them carry none — so these are generated
   instead, which was the way it was asked for.

   WHERE A TREE CAN ACTUALLY STAND: on the verge beside a drivable road, off the
   tarmac, and not inside a building. The first two are grid lookups the game
   already keeps for the off-road penalty; the third is the same bucket walk that
   marks a POI's building. Anything that fails is simply not planted, so a tree
   never appears in a wall or in the middle of a carriageway.

   AND IN THE SAME PLACE EVERY TIME. The position along the road decides
   everything — spacing, height, how green it is — through a hash of the
   coordinate, so a cell dropped and rebuilt comes back identical and two
   players in the same street see the same trees. The spacing is walked from the
   start of each SEGMENT rather than from the cell, so a tree lands in exactly
   one cell and the row does not restart at every cell boundary. */
const TREE_GAP = 9, TREE_VERGE = 2.6;
/* Integer hash rather than sin(): the argument here is a world coordinate that
   reaches ±18000, and sin() of a number that size has almost no fraction left —
   the same reason the window shader carries its own. */
function hash2(x, z) {
  let h = Math.imul(Math.round(x * 8) | 0, 374761393) ^ Math.imul(Math.round(z * 8) | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function insideBuilding(x, y) {
  const arr = W.buckets.get(Math.floor(x / W.bcell) + ',' + Math.floor(y / W.bcell));
  if (!arr) return false;
  for (const bi of arr) {
    const b = W.buildings[bi];
    if (x < b.bb.x0 || x > b.bb.x1 || y < b.bb.y0 || y > b.bb.y1) continue;
    if (pointInPoly(b.pts, x, y)) return true;
  }
  return false;
}
/* One triangle with its own face normal, which is what makes a canopy read as
   faceted foliage rather than as a flat green blob.

   THE ORDER OF THE CORNERS IS THE OUTWARD SIDE. cross(b-a, c-a) has to come out
   pointing away from the middle of the tree, which is the same convention the
   walls use — and getting it backwards produces exactly what it produced on the
   buildings: normals facing into the trunk, so no sunlight ever lands on them
   and every tree in the city is a black blob lit by ambient alone. Which is what
   the first version of this looked like, one commit after fixing the identical
   fault in the masonry. */
function pushTri(o, ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b) {
  let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
  let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
  let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  o.push(ax, ay, az, nx, ny, nz, r, g, b, 0, 0,
         bx, by, bz, nx, ny, nz, r, g, b, 0, 0,
         cx, cy, cz, nx, ny, nz, r, g, b, 0, 0);
}
/* A trunk and an eight-sided crown: sixteen triangles, which is two per cent of
   one building and reads as a tree from a car. */
function pushTree(o, x, z, note) {
  const k = hash2(x, z);
  const y = terrainH(x, z);
  const H = 8.5 + k * 5.0;                    // 8.5 to 13.5 m to the top of the crown
  const trunkH = H * 0.34, rad = 0.29 * H + k * 0.5;   // a crown about 8 m across
  note(y); note(y + H);
  const tr = 0.20 + k * 0.10;
  const br = 0.24, bg = 0.19, bb = 0.15;
  for (let i = 0; i < 4; i++) {
    const a0 = i * Math.PI / 2, a1 = (i + 1) * Math.PI / 2;
    const x0 = x + Math.cos(a0) * tr, z0 = z + Math.sin(a0) * tr;
    const x1 = x + Math.cos(a1) * tr, z1 = z + Math.sin(a1) * tr;
    pushTri(o, x0, y, z0, x1, y + trunkH, z1, x1, y, z1, br, bg, bb);
    pushTri(o, x0, y, z0, x0, y + trunkH, z0, x1, y + trunkH, z1, br, bg, bb);
  }
  /* Greener or browner by a few per cent per tree, from the same hash — a row of
     identical crowns is the one thing that makes generated planting look
     generated. */
  const g0 = 0.52 + k * 0.16, r0 = 0.28 + k * 0.12, b0 = 0.20 + k * 0.09;
  /* SEVEN SIDES, AND THE WIDEST PART LOW. Four sides with a point at each end is
     a rhombus on a stick, which is what the first attempt looked like from the
     car — the silhouette of a bipyramid is its two points and nothing else.
     Seven is enough that the outline reads as round at the distance a tree is
     ever looked at, odd so a flat edge never faces the camera square on, and
     still only twenty-one triangles. */
  const SIDES = 7;
  const crown = H - trunkH;
  const cy0 = y + trunkH, cy1 = y + H, mid = y + trunkH + crown * 0.52;
  for (let i = 0; i < SIDES; i++) {
    const a0 = (i * 2 * Math.PI) / SIDES + k, a1 = ((i + 1) * 2 * Math.PI) / SIDES + k;
    const x0 = x + Math.cos(a0) * rad, z0 = z + Math.sin(a0) * rad;
    const x1 = x + Math.cos(a1) * rad, z1 = z + Math.sin(a1) * rad;
    pushTri(o, x, cy1, z, x1, mid, z1, x0, mid, z0, r0, g0, b0);
    // the underside is in its own shade, which is most of what says "canopy"
    pushTri(o, x, cy0, z, x0, mid, z0, x1, mid, z1, r0 * .62, g0 * .62, b0 * .62);
  }
}
/* `sites` is for the tests: pass an array and every trunk position that was
   planted lands in it, so the placement rules can be checked as coordinates
   rather than guessed at from pixels. Production passes nothing. */
function treesAlong(o, r, x0, z0, x1, z1, note, sites) {
  const off = r.w / 2 + TREE_VERGE;
  for (let i = 0; i < r.pts.length - 1; i++) {
    const a = r.pts[i], b = r.pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    if (L < 4) continue;
    const ex = dx / L, ey = dy / L, px = -ey, py = ex;
    for (let s = TREE_GAP * 0.5; s < L; s += TREE_GAP) {
      for (let side = -1; side <= 1; side += 2) {
        const j = hash2(a.x + ex * s, a.y + ey * s + side);
        if (j < 0.08) continue;               // gaps: driveways, corners, a stump
        const d = off + j * 1.6;
        const tx = a.x + ex * s + px * d * side, tz = a.y + ey * s + py * d * side;
        // exactly one cell owns it, so a tree is never built twice
        if (tx < x0 || tx >= x1 || tz < z0 || tz >= z1) continue;
        if (onTarmac(tx, tz) || insideBuilding(tx, tz)) continue;
        pushTree(o, tx, tz, note);
        if (sites) sites.push(tx, tz);
      }
    }
  }
}

/* Everything in one 512 m square, turned into two GPU meshes. */
function buildCell(kx, kz) {
  const x0 = kx * CELL3, z0 = kz * CELL3, x1 = x0 + CELL3, z1 = z0 + CELL3;
  const gnd = [], lit = [], sgn = [];
  let ymin = Infinity, ymax = -Infinity;
  const note = y => { if (y < ymin) ymin = y; if (y > ymax) ymax = y; };

  /* THE GROUND, tessellated so it has the shape the physics thinks it has. A
     flat quad here and a car climbing a hill is a car climbing nothing. */
  const st = CELL3 / GND_DIV;
  const hs = [], ns = [];
  for (let i = 0; i <= GND_DIV; i++) for (let j = 0; j <= GND_DIV; j++) {
    const x = x0 + i * st, z = z0 + j * st;
    const g = terrainGrad(x, z);
    hs[i * (GND_DIV + 1) + j] = g.h;
    // the surface normal of a heightfield is (-dh/dx, 1, -dh/dz), normalised
    const l = Math.hypot(g.gx, 1, g.gy) || 1;
    ns[i * (GND_DIV + 1) + j] = [-g.gx / l, 1 / l, -g.gy / l];
    note(g.h);
  }
  const at = (i, j) => i * (GND_DIV + 1) + j;
  for (let i = 0; i < GND_DIV; i++) for (let j = 0; j < GND_DIV; j++) {
    const xa = x0 + i * st, xb = xa + st, za = z0 + j * st, zb = za + st;
    const p = [[xa, hs[at(i, j)], za, ns[at(i, j)]], [xb, hs[at(i + 1, j)], za, ns[at(i + 1, j)]],
               [xb, hs[at(i + 1, j + 1)], zb, ns[at(i + 1, j + 1)]], [xa, hs[at(i, j + 1)], zb, ns[at(i, j + 1)]]];
    /* WOUND SO THE FRONT FACE POINTS UP. The corners go round the quad in +x
       then +z, and a triangle taken in that order has its normal pointing at the
       ground — so with back-face culling on, the entire terrain was invisible
       and every frame showed the sky where the ground should be, with the roads
       (which happen to be wound the other way) hanging in it. */
    for (const t of [[0, 2, 1], [0, 3, 2]])
      for (const v of t) {
        const q = p[v];
        gnd.push(q[0], q[1], q[2], q[3][0], q[3][1], q[3][2], PAL_GROUND);
      }
  }

  /* Parks, roads and their markings, stacked a few centimetres above the ground
     in the order the 2D renderer paints them. The offsets are what keeps them
     apart in the depth buffer — at 300 m a 24-bit depth buffer resolves about
     half a centimetre, so six is comfortable and none of it is visible. */
  /* PARKS ARE CLIPPED TO THE CELL, not filed under the cell their middle is in.

     They used to be drawn once, in whichever cell held the centroid, so that a
     park spanning four cells was not drawn four times. The flaw is that the
     centroid's cell may not be BUILT: cells are built out to VIEW3 and evicted
     behind you, and a park big enough to matter is easily big enough for its
     middle to sit outside that radius while its edge is under your wheels. The
     whole park then vanishes from the world while the map — which draws
     W.parks straight, with no cell rule — still shows it green. Reported as
     exactly that.

     Clipping each park to the cell it is being built into draws every part of it
     exactly once, in the cell that owns that part, which is what the roads have
     always done through ribbon(). A park is visible whenever the ground under it
     is. */
  for (const f of W.parks) {
    if (f.bb.x1 < x0 || f.bb.x0 >= x1 || f.bb.y1 < z0 || f.bb.y0 >= z1) continue;
    const poly = clipToCell(f.pts, x0, z0, x1, z1);
    if (poly.length < 3) continue;
    const tri = earClip(poly);
    for (let i = 0; i < tri.length; i += 3) {
      const p0 = poly[tri[i]], p1 = poly[tri[i + 1]], p2 = poly[tri[i + 2]];
      // as with the roofs below: which way an ear-clipped triangle faces depends
      // on the footprint's own winding, so take the order that points upward
      const cr = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
      for (const p of cr > 0 ? [p0, p2, p1] : [p0, p1, p2])
        gnd.push(p.x, terrainH(p.x, p.y) + .06, p.y, 0, 1, 0, PAL_PARK);
    }
  }

  const pad = 24;
  const rs = roadsIn(x0 - pad, z0 - pad, x1 + pad, z1 + pad);
  for (const r of rs) ribbon(gnd, r.pts, r.w + 2.4, PAL_KERB, .12, x0, z0, x1, z1);
  for (const r of rs) ribbon(gnd, r.pts, r.w, r.w >= 11 ? PAL_BIG : PAL_ROAD, .18, x0, z0, x1, z1);
  for (const r of rs) if (r.w >= 9) dashes(gnd, r.pts, .24, x0, z0, x1, z1);

  /* THE BUILDINGS. Walls with a real outward normal — which is what replaces the
     2D renderer's trick of multiplying every wall colour by 0.17 to imply a
     light direction. Here the normal does it, so the material colour goes into
     the buffer untinted and a theme change never touches this geometry.

     The base is dropped to the lowest corner of the footprint and then a metre
     further, so a block on a slope is buried into the hill rather than standing
     on one leg with daylight under the other three. */
  const bs = G3.idx.get(cellKey(kx, kz));
  if (bs) for (const b of bs) {
    if (b.mono) { monument(lit, b, note); continue; }
    const n = b.pts.length;
    let base = Infinity;
    for (let i = 0; i < n; i++) { const h = terrainH(b.pts[i].x, b.pts[i].y); if (h < base) base = h; }
    base -= 1;
    const top = terrainH(b.cx, b.cy) + b.h;
    note(base); note(top);
    const fp = b.pts;
    const wall = b.mWall, roof = b.mRoof;
    const wr = wall[0] / 255, wg = wall[1] / 255, wb = wall[2] / 255;
    /* WHICH WAY ROUND THE OUTLINE IS LISTED, and why both the normal and the
       triangles have to be told.

       OpenStreetMap does not agree on a direction for a building's outline: of
       the 3502 buildings in the bundled Stari grad capture, 1855 run one way
       and 1647 the other. So the outward side of a wall cannot be read off the
       edge alone — hence `wind`, which flips the normal for a footprint listed
       the other way round.

       THE NORMAL IS ONLY HALF OF IT. The GPU decides what to draw by the order
       the triangle's own corners arrive in, not by the normal it carries, and
       that order comes straight from the direction the outline is walked. So a
       clockwise building used to get a correct normal — lit correctly, windows
       in the right place — on triangles the hardware then culled as
       back-facing. The near walls vanished and you looked straight into the far
       ones from behind: an open book standing in the street where a block
       should be, reported as "some buildings look like walls". Walking the edge
       backwards for those buildings turns the triangles round to match the
       normal, and costs nothing. */
    const wind = windingOf(fp);
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const p = wind > 0 ? fp[i] : fp[j], q = wind > 0 ? fp[j] : fp[i];
      const ax = p.x, az = p.y, bx = q.x, bz = q.y;
      const ex = bx - ax, ez = bz - az;
      const L = Math.hypot(ex, ez);
      if (L < 1e-4) continue;
      // outward, in the ground plane — the edge is already reversed above for a
      // clockwise footprint, so the normal follows it without a sign of its own
      const nx = -ez / L, nz = ex / L;
      /* aWall is (how far up this vertex is, how tall this wall is). The base is
         a metre INTO the hill, so the height that matters to the facade is
         measured from the ground at the footprint rather than from the buried
         corner — otherwise a block on a slope would start its ground floor
         underground at one end and a metre up in the air at the other. */
      const foot = base + 1, H = top - foot;
      lit.push(ax, base, az, nx, 0, nz, wr, wg, wb, -1, H,
               bx, base, bz, nx, 0, nz, wr, wg, wb, -1, H,
               bx, top, bz, nx, 0, nz, wr, wg, wb, H, H);
      lit.push(ax, base, az, nx, 0, nz, wr, wg, wb, -1, H,
               bx, top, bz, nx, 0, nz, wr, wg, wb, H, H,
               ax, top, az, nx, 0, nz, wr, wg, wb, H, H);
    }
    // the roof, which is the one part that genuinely needs a triangulator
    const tri = earClip(fp);
    const rr = roof[0] / 255, rg = roof[1] / 255, rb = roof[2] / 255;
    for (let i = 0; i < tri.length; i += 3) {
      const p0 = fp[tri[i]], p1 = fp[tri[i + 1]], p2 = fp[tri[i + 2]];
      const cr = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
      for (const p of cr > 0 ? [p0, p2, p1] : [p0, p1, p2])
        lit.push(p.x, top, p.y, 0, 1, 0, rr, rg, rb, 0, 0);   // a roof has no facade
    }
    // and its name across the widest wall, if OSM gave it one
    if (b.sign) pushSign(sgn, b, fp, wind, top, base + 1);
  }

  // the planting, last, because it needs the buildings' footprints to avoid
  for (const r of rs) if (r.drive) treesAlong(lit, r, x0, z0, x1, z1, note);

  if (!isFinite(ymin)) { ymin = 0; ymax = 1; }
  return {
    kx, kz, x0, z0, x1, z1, y0: ymin - 2, y1: ymax + 2,
    gnd: GL.mesh(new Float32Array(gnd), [[G3.gnd.a.aPos, 3], [G3.gnd.a.aNrm, 3], [G3.gnd.a.aPal, 1]]),
    lit: GL.mesh(new Float32Array(lit), [[G3.lit.a.aPos, 3], [G3.lit.a.aNrm, 3], [G3.lit.a.aCol, 3], [G3.lit.a.aWall, 2]]),
    sgn: sgn.length ? GL.mesh(new Float32Array(sgn), [[G3.sign.a.aPos, 3], [G3.sign.a.aUV, 2]]) : null
  };
}

/* A MEMORIAL, built rather than drawn.

   Four courses, because that is what a monument is when you strip it to blocks
   you can see from a car: steps at the bottom, a plinth, a shaft, and something
   on top. Getting the proportions right matters far more than detail at this
   distance — a figure is a tenth of the height and the plinth is a third, and a
   shape with those ratios reads as a monument at two hundred metres while a
   plain column reads as a chimney.

   Stone, not masonry, and NO aWall on any of it: the window shader keys on a
   wall's height being non-zero, and rows of lit windows up a statue would be
   worse than leaving the square empty. The figure is bronze and much darker,
   which is what separates a monument from a pillar at a glance. */
const MONU_TOP = { obelisk: [.62, .70, .62], monument: [.36, .40, .34],
                   statue: [.30, .34, .30], memorial: [.34, .38, .32] };
function monument(lit, b, note) {
  const kind = (b.mono && b.mono.kind) || 'memorial';
  // the footprint's own radius, so a mapped outline keeps its real size
  let rx = (b.bb.x1 - b.bb.x0) * .5, rz = (b.bb.y1 - b.bb.y0) * .5;
  rx = clamp(rx, 1.6, 9); rz = clamp(rz, 1.6, 9);
  let base = Infinity;
  for (const p of b.pts) { const h = terrainH(p.x, p.y); if (h < base) base = h; }
  base -= .6;
  const H = b.h;
  note(base); note(base + H);

  const stone = [.74, .72, .67], dark = [.52, .50, .46];
  const t = MONU_TOP[kind] || MONU_TOP.memorial;
  /* Fractions of the total height. The steps are a low wide skirt, the plinth is
     the block with the name on it, the shaft carries most of the height, and the
     figure is what makes it a memorial rather than a pillar. An obelisk skips
     the figure and tapers instead, which is what an obelisk is. */
  const step = H * .06, plinth = H * .26, shaft = H * .58;
  const box = (y0, y1, hx, hz, c) => {
    const p = [];
    for (const uy of [y0, y1])
      for (const [a, o] of [[-1, -1], [1, -1], [1, 1], [-1, 1]])
        p.push(b.cx + a * hx, uy, b.cy + o * hz);
    pushBox(lit, p, c[0], c[1], c[2]);
  };
  box(base, base + step, rx * 1.5, rz * 1.5, dark);              // the steps
  box(base + step, base + step + plinth, rx, rz, stone);         // the plinth
  const sy = base + step + plinth;
  if (kind === 'obelisk') {
    // a taper rather than a figure: narrower at the top, and nothing on it
    box(sy, sy + shaft + H * .10, rx * .52, rz * .52, stone);
    box(sy + shaft + H * .10, base + H, rx * .18, rz * .18, stone);
  } else {
    box(sy, sy + shaft, rx * .60, rz * .60, stone);               // the shaft
    // and the figure, offset nothing and squarer than the shaft below it
    box(sy + shaft, base + H, rx * .40, rz * .40, t);
  }
}

/* ------------------------------ dynamic bits ------------------------------ */
/* A cuboid, from the eight corners body3d.js works out, into the lit stream.
   Twelve triangles with a real face normal each, which is what makes a rolled
   car read as rolled rather than as a rectangle at a funny angle. */
const BOX_FACES = [
  [0, 1, 2, 3], [7, 6, 5, 4], [4, 5, 1, 0], [6, 7, 3, 2], [5, 6, 2, 1], [7, 4, 0, 3]
];
function pushBox(o, p, r, g, b) {
  for (const f of BOX_FACES) {
    const ax = p[f[0] * 3], ay = p[f[0] * 3 + 1], az = p[f[0] * 3 + 2];
    const bx = p[f[1] * 3], by = p[f[1] * 3 + 1], bz = p[f[1] * 3 + 2];
    const cx = p[f[2] * 3], cy = p[f[2] * 3 + 1], cz = p[f[2] * 3 + 2];
    const dx = p[f[3] * 3], dy = p[f[3] * 3 + 1], dz = p[f[3] * 3 + 2];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    // the trailing zeroes are aWall: nothing in this stream is a facade
    o.push(ax, ay, az, nx, ny, nz, r, g, b, 0, 0, bx, by, bz, nx, ny, nz, r, g, b, 0, 0, cx, cy, cz, nx, ny, nz, r, g, b, 0, 0);
    o.push(ax, ay, az, nx, ny, nz, r, g, b, 0, 0, cx, cy, cz, nx, ny, nz, r, g, b, 0, 0, dx, dy, dz, nx, ny, nz, r, g, b, 0, 0);
  }
}

const BOXTMP = [];

/* ANY SMALLER BOX INSIDE THE BODY'S OWN FRAME, in normalised coordinates where
   ±1 is the body's own surface along forward, lateral and up. Wheels use it, and
   it is what keeps them attached: the axes are recovered from the eight corners
   carBox already worked out, so a wheel inherits the pitch, the roll and the
   airborne spin exactly, with no second rotation to disagree with the first.

   `l0` must stay below `l1`. The corner order matches carBox's, and reversing
   the lateral pair would reverse the winding of every face with it — which
   back-face culling would then turn inside out. */
const SUBTMP = [];
function subBox(src, out, f0, f1, l0, l1, u0, u1) {
  const F = [], L = [], U = [], c = [];
  for (let k = 0; k < 3; k++) {
    F[k] = (src[3 + k] - src[k]) * .5;              // half-length, forward
    L[k] = (src[9 + k] - src[k]) * .5;              // half-width, lateral
    U[k] = (src[12 + k] - src[k]) * .5;             // half-height, up
    // corner 0 is at (-1, -1, -1), so the centre is one of each away from it
    c[k] = src[k] + F[k] + L[k] + U[k];
  }
  let n = 0;
  for (const u of [u0, u1]) for (const [f, l] of [[f0, l0], [f1, l0], [f1, l1], [f0, l1]])
    for (let k = 0; k < 3; k++) out[n++] = c[k] + F[k] * f + L[k] * l + U[k] * u;
  return out;
}

/* A CAR, OUT OF NINE BOXES.

   The reference photograph is a row of parked cars, and none of what makes them
   read as cars was here: they were a coloured cuboid with a second cuboid
   standing on it, full length, like a lorry cab on a skip. The list of what was
   missing is short and every item is cheap.

   WHEELS, and a gap for them to sit in. What identifies a parked car at a glance
   is the dark space under the sill with something round and black in it. Adding
   wheels to a box that already reaches the tarmac does nothing — the first
   attempt proved it — so the painted body comes UP and the wheels fill what is
   now empty underneath, standing slightly proud besides, which is what puts them
   in view from dead ahead and dead behind rather than only from the side.

   A BONNET AND A BOOT. The old cabin ran the whole length of the roof, and that
   single fact is most of why the shape read as a van. A car's glasshouse is
   inset at both ends and narrower than its body, and once it is, the thing has a
   front and a back from any angle.

   LIGHTS. Four small boxes, red at the back and pale at the front, which cost
   almost nothing and are the difference between a shape and a vehicle — most of
   all at dusk, when a street of them is a street of tail lights.

   THE NUMBERS ARE IN THE BODY'S OWN FRAME, where ±1 is its surface along
   forward, lateral and up, and they are chosen against real proportions: the
   sill at 32 cm off the road, the beltline at about a metre, the roof at 1.6 m,
   wheels 62 cm across. carBox is untouched — it is the collision volume the
   physics reasons about, and this is the same eight corners read as a frame to
   hang smaller shapes off, so a rolled or airborne car brings every part of
   itself with it and nothing can drift out of alignment.

   Past 90 m all of it collapses back to the two boxes it used to be. At that
   range a wheel is a pixel and a half and a headlamp is less, and the far half
   of a busy street is most of the cars on screen — in the shadow pass as well as
   the colour one. */
const BODY_LO = -.56;                     // the sill: where paint starts, off the road
const WHEELS = [[-.86, -.44], [.44, .86]];
const LAMPS = [[-.86, -.40], [.40, .86]];
function pushCar(o, src, r, g, b, full) {
  /* The glasshouse. Dark, and it keeps a trace of the body colour rather than
     going to a flat black, because at dusk the paint is how you tell one car
     from another and the roof is a good part of what you can see of it. */
  const gr = r * .22 + .045, gg = g * .23 + .05, gb = b * .28 + .07;
  if (!full) {
    // far away: the two boxes this used to be, sitting on the road as before
    pushBox(o, subBox(src, SUBTMP, -1, 1, -1, 1, -1, .45), r, g, b);
    pushBox(o, subBox(src, SUBTMP, -.66, .32, -.8, .8, .40, 1.23), gr, gg, gb);
    return;
  }
  pushBox(o, subBox(src, SUBTMP, -1, 1, -1, 1, BODY_LO, .41), r, g, b);
  // inset at both ends and narrower: the bonnet and the boot are what is left
  pushBox(o, subBox(src, SUBTMP, -.66, .32, -.8, .8, .30, 1.23), gr, gg, gb);
  for (const s of [-1, 1]) {
    for (const [f0, f1] of WHEELS)
      pushBox(o, subBox(src, SUBTMP, f0, f1, s < 0 ? -1.06 : .86, s < 0 ? -.86 : 1.06, -1, -.15),
              .062, .058, .07);
    const [l0, l1] = LAMPS[s < 0 ? 0 : 1];
    pushBox(o, subBox(src, SUBTMP, -1.02, -.94, l0, l1, .02, .30), .78, .07, .05);   // tail
    pushBox(o, subBox(src, SUBTMP, .94, 1.02, l0, l1, .02, .30), .95, .93, .78);     // head
  }
}

/* SERBIAN POLICE LIVERY, added on top of whichever body was drawn.

   Looked up rather than invented: a Belgrade patrol car is WHITE with a blue
   chequer band along the flank, the Cyrillic ПОЛИЦИЈА wordmark, and a blue LED
   lightbar. Not the red-and-blue bar this had, which is a North American
   convention and reads as the wrong country to anyone who lives there.

   Drawn from the car's own eight corners rather than baked into the mesh, so it
   sits correctly on BOTH bodies — the detailed model up close and the two-box
   version at distance — and rides the pitch and roll with them.

   ONLY THE BLUE SQUARES ARE EMITTED. A Sillitoe chequer is a checkerboard of
   blue on white, and the white half is the car's own paint, so half the pattern
   is free: emit where (row + column) is even and the body shows through the
   rest. Two rows of seven over the doors is what reads as chequered at the
   distance you actually see a police car from, which is the whole test — a
   finer grid turns to mush by the time it is three cars ahead of you.

   The wordmark is deliberately absent. At this scale it would be two pixels of
   noise along the door, and noise on a white panel reads as dirt rather than as
   lettering. */
const POL_BLUE = [.055, .21, .60];
/* THE BAR IS BLUE AND RED, one end each, alternating.

   A real Belgrade bar is blue at both ends — that is what the livery research
   turned up and what this was built as first. Blue and red is a deliberate
   choice on top of the accurate livery: it is what a police car reads as in a
   game like this one, and it is what was asked for. The chequer, the white body
   and the wordmark-free flank are still the real thing.

   Each end keeps its colour whether or not it is firing; only the brightness
   swaps. A lamp that goes black when off means that from the side — which is
   how you mostly see a police car — half the time the roof has nothing on it. */
const POL_LAMP = [.30, .62, 1];
const POL_DIM = [.10, .30, .78];
const POL_RED = [1, .22, .18];
const POL_RED_DIM = [.46, .07, .06];
const POL_COLS = 7, POL_ROWS = 2;
function pushPolice(o, src, blink) {
  // the band sits over the doors, just proud of the paint so it cannot z-fight
  const y0 = .10, y1 = .46, S = 1.012;
  const fw = 1.72 / POL_COLS, rh = (y1 - y0) / POL_ROWS;
  for (const side of [-1, 1]) {
    for (let i = 0; i < POL_COLS; i++) for (let j = 0; j < POL_ROWS; j++) {
      if ((i + j) % 2) continue;                    // the white half is the paint
      const f0 = -.86 + fw * i, u0 = y0 + rh * j;
      pushBox(o, subBox(src, SUBTMP, f0, f0 + fw,
                        side < 0 ? -S : S - .02, side < 0 ? -S + .02 : S,
                        u0, u0 + rh),
              POL_BLUE[0], POL_BLUE[1], POL_BLUE[2]);
    }
  }
  /* The bar itself: two blue lamps on a dark plinth, alternating, so it reads as
     flashing from behind as well as from the side. Serbian bars are blue at both
     ends — there is no red half to alternate with, so what alternates is which
     end is lit. */
  pushBox(o, subBox(src, SUBTMP, -.30, .18, -.72, .72, 1.20, 1.30), .07, .08, .10);
  for (const side of [-1, 1]) {
    /* BOTH ENDS ARE BLUE, ALWAYS. Only which one is BRIGHT alternates.

     The unlit end started at near-black, which is what a switched-off lamp looks
     like from the front — and from the side, which is how you mostly see a
     police car, it meant that half the time the roof had no blue on it at all.
     A real bar is a blue lamp at each end whether or not it is firing. */
    const lit = (side < 0) === blink;
    // the near end blue, the far end red, and which one is bright alternates
    const c = side < 0 ? (lit ? POL_LAMP : POL_DIM)
                       : (lit ? POL_RED_DIM : POL_RED);
    pushBox(o, subBox(src, SUBTMP, -.26, .14, side < 0 ? -.68 : .04, side < 0 ? -.04 : .68,
                      1.28, 1.42), c[0], c[1], c[2]);
  }
}

/* THE MODEL MATRIX FOR ONE CAR, read straight out of the eight corners carBox
   already worked out. Those corners carry the heading, the pitch and the roll
   the physics computed, so nothing here re-derives a rotation — two rotations
   derived separately disagree the moment either is anything but flat, and a
   barrel roll is exactly when someone is looking closely.

   Corner 0 sits at local (-1, 0, -1), corner 1 at (+1, 0, -1), corner 3 at
   (-1, 0, +1) and corner 4 at (-1, 2, -1), so the images of the three local unit
   vectors are half-differences of those, and the local origin is one forward and
   one lateral step in from corner 0.

   The normal matrix is the inverse transpose, which for a matrix with orthogonal
   columns is each column over its own length squared. It matters because the
   three columns have three different lengths — half a length, half a width, half
   a height — so a normal pushed through the model matrix unaltered comes out
   tilted, and a long car would light as though it were leaning. */
function carModel(src, m, nm) {
  const F = [], U = [], L = [];
  for (let k = 0; k < 3; k++) {
    F[k] = (src[3 + k] - src[k]) * .5;
    L[k] = (src[9 + k] - src[k]) * .5;
    U[k] = (src[12 + k] - src[k]) * .5;
  }
  for (let k = 0; k < 3; k++) {
    m[k] = F[k]; m[4 + k] = U[k]; m[8 + k] = L[k];
    m[12 + k] = src[k] + F[k] + L[k];
  }
  m[3] = m[7] = m[11] = 0; m[15] = 1;
  const fl = F[0] * F[0] + F[1] * F[1] + F[2] * F[2] || 1;
  const ul = U[0] * U[0] + U[1] * U[1] + U[2] * U[2] || 1;
  const ll = L[0] * L[0] + L[1] * L[1] + L[2] * L[2] || 1;
  for (let k = 0; k < 3; k++) { nm[k] = F[k] / fl; nm[3 + k] = U[k] / ul; nm[6 + k] = L[k] / ll; }
}

function carColour(c) {
  const q = parseColour(c.color) || [255, 80, 200];
  return [q[0] / 255, q[1] / 255, q[2] / 255];
}

/* ------------------------------ the camera ------------------------------ */
/* Behind and above, looking at a point in front. It reuses the camera the 2D
   game already smooths — cam.x/cam.y lead the car and settle at a rate tuned
   against how the car actually drives — and only turns that into an eye and a
   target. The one thing added is a heading of its own, lagged, so a handbrake
   turn swings the world round rather than snapping it. */
function camera3D(dt) {
  const c = P.car;
  const spd = Math.hypot(c.vx, c.vy);
  const k = clamp(spd / TOP_SPEED, 0, 1);
  const C = G3.cam;
  /* In a drift the car points somewhere other than where it is going, and a
     camera locked to the nose spends the whole slide staring at a kerb. It
     follows the heading, but slowly, and slower still the faster you go. */
  C.h += angDiff(C.h, c.h) * decay(lerp(5.5, 2.6, k), dt);
  C.d += (lerp(13.5, 25, k) * lerp(1.22, 1, zoomK) - C.d) * decay(2.2, dt);
  /* LOW, AND LOOKING NEARLY LEVEL. The first version sat six metres up and
     aimed at the car's roofline, which is an 18° downward tilt — a view of a lot
     of tarmac, very little of what is coming, and no sky at all. Dropping the
     eye and lifting the aim point brings it to about 5°, which is where every
     chase camera in every driving game sits, and it is also what puts the
     horizon and the low sun inside the frame instead of above it. */
  C.y += (lerp(3.7, 5.9, k) - C.y) * decay(2.2, dt);

  const cz = c.z || 0;
  /* The TARGET is the 2D camera's point, which already leads the car. The EYE
     hangs off the car itself, and that distinction is the whole framing:
     cam.x/cam.y run up to 26 metres ahead at speed, so an eye placed relative to
     THEM ends up on the bonnet at exactly the moment you most want to see where
     you are going. */
  const tx = cam.x, tz = cam.y, ty = cz + 2.4;
  let ex = c.x - Math.cos(C.h) * C.d, ez = c.y - Math.sin(C.h) * C.d;
  /* The eye may never go under the hill behind you. On a climb the ground
     immediately behind the car is higher than the car, and an eye at a fixed
     height above the CAR ends up inside it — which draws the inside of a
     hillside across the whole screen. */
  let ey = Math.max(cz + C.y, terrainH(ex, ez) + 2.6);
  if (cam.shake > 0) {
    const s = cam.shake * .9;
    ex += rand(-1, 1) * s; ey += rand(-1, 1) * s; ez += rand(-1, 1) * s;
  }
  C.ex = ex; C.ey = ey; C.ez = ez;
  M4.lookAt(G3.V, ex, ey, ez, tx, ty, tz, 0, 1, 0);
  M4.perspective(G3.Pm, 1.02, Math.max(VW, 1) / Math.max(VH, 1), 1.0, VIEW3 + CELL3);
  M4.mul(G3.VP, G3.Pm, G3.V);
  frustumOf(G3.VP, G3.planes);
}

/* WHAT THE SUN CAN SEE. An orthographic box around the car, looking down the
   light direction.

   The last four lines are the reason this is a function and not two calls. The
   map is a fixed grid of texels in the sun's space, and the box it covers moves
   with the car — so a surface can slide between texels frame to frame, and the
   shadow edge crawls and boils along a wall while you drive in a straight line.
   Snapping the projection to whole texels pins the grid to the world instead,
   and the crawling stops dead. */
function shadowView() {
  const th = SKY[themeName] || SKY.dusk;
  const ld = th.ld;
  const l = Math.hypot(ld[0], ld[1], ld[2]) || 1;
  const Lx = ld[0] / l, Ly = ld[1] / l, Lz = ld[2] / l;
  const c = P.car;
  // biased ahead of the car, because that is the half of the map you are looking at
  const cxw = c.x + Math.cos(G3.cam.h) * SHADOW_R * .35;
  const czw = c.y + Math.sin(G3.cam.h) * SHADOW_R * .35;
  const cyw = terrainH(cxw, czw);
  const D = SHADOW_R * 2.6;
  M4.lookAt(G3.Vl, cxw + Lx * D, cyw + Ly * D, czw + Lz * D, cxw, cyw, czw, 0, 1, 0);
  M4.ortho(G3.Pl, -SHADOW_R, SHADOW_R, -SHADOW_R, SHADOW_R, 1, D * 2.2);
  M4.mul(G3.LVP, G3.Pl, G3.Vl);

  const S = G3.sm ? G3.sm.size : SHADOW_SIZE;
  const o = M4.xform(G3.LVP, 0, 0, 0);
  const tx = o[0] * S * .5, ty = o[1] * S * .5;
  G3.LVP[12] += (Math.round(tx) - tx) * 2 / S;
  G3.LVP[13] += (Math.round(ty) - ty) * 2 / S;
}

/* Where a world point lands on the screen, for the objective arrow and for
   anything else that has to agree with what is drawn. Same signature and same
   units as the 2D one, and the dispatcher below is what makes them one name.

   The behind-the-camera case matters more here than it ever did in 2D: a
   top-down camera can always see a bearing, and this one cannot see half the
   world. Projecting a point behind the eye through the matrix gives a position
   mirrored through the centre of the screen, which would send the arrow to the
   pickup exactly the wrong way. It is worked out in view space instead, where
   "behind" is simply a positive z. */
function toScreen3D(wx, wy) {
  const y = terrainH(wx, wy) + 1;
  const v = M4.xform(G3.V, wx, y, wy);
  /* BEHIND THE EYE, worked out as a BEARING rather than as a position.

     Two things went wrong here when it was a position. Both signs were inverted
     against the branch below — v[0] positive is to the right, and this sent it
     left — so the arrow flipped a full half turn through the middle of the
     screen the moment a target crossed behind the camera. A pickup sitting near
     that boundary crosses it over and over, which is the arrow "jumping from
     side to side". And a target DIRECTLY behind has v[0] and v[1] both at zero,
     which landed on the screen centre, where drawArrow's own "it is on screen,
     no arrow needed" test fires and the arrow disappears altogether — precisely
     when it is most wanted.

     A bearing has neither failure. Zero is straight ahead and ±π is directly
     behind, so the screen direction (sin θ, −cos θ) points right at a quarter
     turn, down at a half, and is never undefined. It also meets the projection
     continuously: at θ = ±90° the perspective divide is already throwing the
     point off the side of the screen, and this puts it in the same place. */
  if (v[2] > -1) {
    const th = Math.atan2(v[0], -v[2]);
    return [VW / 2 + Math.sin(th) * VW, VH / 2 - Math.cos(th) * VH];
  }
  const p = M4.xform(G3.Pm, v[0], v[1], v[2]);
  const w = p[3] || 1e-6;
  return [(p[0] / w * .5 + .5) * VW, (-p[1] / w * .5 + .5) * VH];
}

/* ------------------------------ the frame ------------------------------ */
let last3 = 0;
function render3D() {
  const gl = GL.gl;
  if (!gl || !initGL3()) { render2D(); return; }
  const c = P.car;

  const now = performance.now();
  const dt = clamp((now - last3) / 1000, 0.001, 0.1);
  last3 = now;

  camera3D(dt);
  shadowView();
  syncIndex3();

  /* The radar is shared with the 2D view and rotates with `rot`, so the same
     three numbers have to mean the same thing here. HX/HY are the screen centre
     because nothing in 3D has a projection origin on the canvas. */
  rot = -Math.PI / 2 - G3.cam.h;
  cs = Math.cos(rot); sn = Math.sin(rot);
  HX = VW / 2; HY = VH / 2;

  const th = SKY[themeName] || SKY.dusk;
  const ld = th.ld, ll = Math.hypot(ld[0], ld[1], ld[2]) || 1;
  const LD = [ld[0] / ll, ld[1] / ll, ld[2] / ll];

  /* ---- which cells, and build at most one of them ---- */
  const kx0 = cellOf(cam.x - VIEW3), kx1 = cellOf(cam.x + VIEW3);
  const kz0 = cellOf(cam.y - VIEW3), kz1 = cellOf(cam.y + VIEW3);
  const want = [];
  for (let i = kx0; i <= kx1; i++) for (let j = kz0; j <= kz1; j++) {
    const dx = Math.max(Math.abs(cam.x - (i + .5) * CELL3) - CELL3 / 2, 0);
    const dz = Math.max(Math.abs(cam.y - (j + .5) * CELL3) - CELL3 / 2, 0);
    const d = Math.hypot(dx, dz);
    if (d > VIEW3) continue;
    want.push({ i, j, d });
  }
  want.sort((a, b) => a.d - b.d);

  /* ONE CELL A FRAME. Building one is an ear-clip over every footprint in a
     quarter of a square kilometre, which is single-digit milliseconds in a dense
     centre — fine once, and a stutter every time you cross a boundary if it were
     done on demand for all of them. Nearest first, so the gap that fills last is
     always at the horizon where the fog is already eating it. The first frame in
     3D is allowed a bigger bite, because the alternative is twenty frames of
     empty ground while the player watches. */
  let budget = G3.cells.size ? 1 : 12;
  G3.drawn = 0; G3.tris = 0; G3.shadowTris = 0;
  const draw = [];
  for (const w of want) {
    const k = cellKey(w.i, w.j);
    let cell = G3.cells.get(k);
    if (!cell) {
      if (budget <= 0) continue;
      budget--;
      cell = buildCell(w.i, w.j);
      G3.cells.set(k, cell);
      G3.built++;
    }
    if (!boxInFrustum(G3.planes, cell.x0, cell.y0, cell.z0, cell.x1, cell.y1, cell.z1)) continue;
    draw.push(cell);
  }

  /* ---- everything that moves, rebuilt every frame ---- */
  const dyn = [];
  const R2 = 420 * 420;
  const near = o => dist2(o.x, o.y, cam.x, cam.y) < R2;
  /* NEAR CARS ARE THE MESH, FAR ONES ARE THE BOXES, and the split is what makes
     both affordable. The mesh is four hundred triangles and costs a draw call
     and six uniforms per car; the boxes are two per car and cost nothing extra,
     because they go into the same stream everything else does and leave in one
     draw. Past ninety metres a car is thirty pixels tall and the difference
     between them is not visible, so the far half of a busy street — which is
     most of the cars on screen — never pays for a windscreen. */
  const meshCars = [];
  const addCar = q => {
    if (!near(q)) return;
    const col = carColour(q);
    carBox(q, BOXTMP);
    if (!G3.plainCars && G3.carVao && dist2(q.x, q.y, cam.x, cam.y) < WHEEL_R2)
      meshCars.push({ src: BOXTMP.slice(), col });
    else pushCar(dyn, BOXTMP, col[0], col[1], col[2], false);
    // the livery goes into the plain stream either way — it is the same eight
    // corners, so it lands on the detailed body and the distant one alike
    if (q.kind === 'cop') pushPolice(dyn, BOXTMP, Math.floor((q.blink || 0) * 7) % 2 === 0);
  };
  for (const t of traffic) addCar(t);
  for (const k of cops) addCar(k);
  if (!P.dead || Math.floor(P.deadT * 8) % 2 === 0) addCar(c);
  for (const p of peds) {
    if (!near(p)) continue;
    const y = terrainH(p.x, p.y);
    const q = parseColour(p.col) || [230, 230, 230];
    const r = .32, h = 1.7;
    const b = [];
    for (const uy of [0, 1]) for (const [a, o2] of [[-1, -1], [1, -1], [1, 1], [-1, 1]])
      b.push(p.x + a * r, y + uy * h, p.y + o2 * r);
    pushBox(dyn, b, q[0] / 255, q[1] / 255, q[2] / 255);
  }
  const LITATTR = [[G3.lit.a.aPos, 3], [G3.lit.a.aNrm, 3], [G3.lit.a.aCol, 3], [G3.lit.a.aWall, 2]];
  if (dyn.length) G3.cars = GL.stream(G3.cars, new Float32Array(dyn), LITATTR);

  /* ---- pass one: the world as the sun sees it ----

     Buildings and cars only. The terrain is a receiver and not a caster: these
     hills are gentle enough that a slope shadowing the next slope is worth
     almost nothing to look at, and putting the ground mesh through a second time
     would roughly double the pass for it.

     polygonOffset rather than a bias in the shader. The classic shadow-acne
     problem is a lit surface sampling its own depth and deciding it is behind
     itself; nudging the depths away during the pass that WRITES them fixes it
     once, for every receiver, instead of at every place that reads. */
  if (G3.sm) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, G3.sm.fb);
    gl.viewport(0, 0, G3.sm.size, G3.sm.size);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.useProgram(G3.dep.p);
    gl.uniformMatrix4fv(G3.dep.u.uVP, false, G3.LVP);
    /* FRONT faces culled, not back, and only in this pass. What gets written is
       then the far side of every building as the sun sees it — so a sunlit wall's
       own depth is a whole building's thickness behind it and it can never decide
       it is standing in its own shadow. That is the acne this had: a stair-step
       pattern crawling over every wall that faced anywhere near the light.

       It works because these are closed volumes. Buildings are walls plus a roof
       with their base buried a metre into the hill, and cars are cuboids; nothing
       cast here is a single-sided sheet, which is the one shape this trick breaks
       on. The offset stays as a small second line of defence for the grazing
       case. */
    gl.cullFace(gl.FRONT);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.4, 2.5);
    for (const cell of draw) if (cell.lit) {
      gl.bindVertexArray(cell.lit.vao);
      gl.drawArrays(gl.TRIANGLES, 0, cell.lit.n);
      G3.shadowTris += cell.lit.n / 3;
    }
    /* CARS CAST THE OTHER WAY ROUND, and they have to.

       Front-face culling works for a building because its far side from the sun
       is metres behind its near side. A car is a box a metre and a half tall
       sitting on the road: its far side IS the road, so the depth written under
       it is the road's own depth and the road promptly decides it is not in
       shadow. Which is what happened — buildings threw clean shadows across the
       street and the car in the middle of it threw none at all, in broad
       daylight.

       So the dynamic batch writes its sunward faces instead, with enough offset
       that the roof does not shade itself. */
    if (dyn.length && G3.cars.n) {
      gl.cullFace(gl.BACK);
      gl.polygonOffset(2.6, 5.0);
      gl.bindVertexArray(G3.cars.vao);
      gl.drawArrays(gl.TRIANGLES, 0, G3.cars.n);
      G3.shadowTris += G3.cars.n / 3;
    }
    /* The near cars go through the same depth program one at a time, with the
       sun's view-projection folded into each car's model matrix before it is
       handed over as uVP. Same reasoning as the batch above: sunward faces, not
       far ones, because a car's far side from the sun IS the road under it. */
    if (meshCars.length && G3.carVao) {
      gl.cullFace(gl.BACK);
      gl.polygonOffset(2.6, 5.0);
      gl.bindVertexArray(G3.carVao);
      for (const q of meshCars) {
        carModel(q.src, CARM.m, CARM.nm);
        M4.mul(CARM.mlvp, G3.LVP, CARM.m);
        gl.uniformMatrix4fv(G3.dep.u.uVP, false, CARM.mlvp);
        gl.drawArrays(gl.TRIANGLES, 0, G3.carN);
        G3.shadowTris += G3.carN / 3;
      }
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.cullFace(gl.BACK);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /* ---- pass two: the world as you see it ---- */
  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  gl.clearColor(th.sky[0], th.sky[1], th.sky[2], 1);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  gl.enable(gl.DEPTH_TEST);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  /* ---- the sky, first, so everything else lands on top of it ----

     No depth test and no depth write: it is behind everything by definition, and
     the clear has just wiped the buffer anyway. The camera basis is lifted
     straight out of the view matrix — the first three columns of a lookAt ARE
     right, up and backward, expressed as rows — scaled so the interpolated
     vector through a pixel is that pixel's world-space view ray. */
  {
    const tanY = Math.tan(1.02 / 2), tanX = tanY * Math.max(VW, 1) / Math.max(VH, 1);
    const V = G3.V;
    const B = new Float32Array([
      V[0] * tanX, V[4] * tanX, V[8] * tanX,
      V[1] * tanY, V[5] * tanY, V[9] * tanY,
      -V[2], -V[6], -V[10]
    ]);
    gl.useProgram(G3.sky.p);
    gl.uniformMatrix3fv(G3.sky.u.uCamB, false, B);
    gl.uniform3fv(G3.sky.u.uZen, th.zen);
    gl.uniform3fv(G3.sky.u.uHor, th.sky);
    gl.uniform3fv(G3.sky.u.uLdir, LD);
    gl.uniform3fv(G3.sky.u.uGlow, th.glow);
    gl.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(G3.skyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  if (G3.sm) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, G3.sm.tex);
  }
  const setCommon = pr => {
    gl.uniformMatrix4fv(pr.u.uVP, false, G3.VP);
    gl.uniformMatrix4fv(pr.u.uLVP, false, G3.LVP);
    gl.uniform3fv(pr.u.uLdir, LD);
    gl.uniform3fv(pr.u.uLcol, th.lc);
    gl.uniform3fv(pr.u.uAmb, th.amb);
    gl.uniform3fv(pr.u.uFog, th.sky);
    gl.uniform2f(pr.u.uFogR, FOG0, VIEW3);
    gl.uniform1i(pr.u.uShadow, 0);
    const on = G3.sm && !G3.noShadow;
    gl.uniform2f(pr.u.uSmap, on ? 1 / G3.sm.size : 0, on ? 1 : 0);
  };

  gl.useProgram(G3.gnd.p);
  setCommon(G3.gnd);
  gl.uniform1f(G3.gnd.u.uShadowK, th.shadowK);
  const P8 = new Float32Array(24);
  const put = (i, c3) => { P8[i * 3] = c3[0]; P8[i * 3 + 1] = c3[1]; P8[i * 3 + 2] = c3[2]; };
  const roadC = col3(PAL.road);
  put(PAL_GROUND, col3(PAL.ground));
  put(PAL_PARK, col3(PAL.park));
  put(PAL_KERB, col3(PAL.kerb));
  put(PAL_ROAD, roadC);
  put(PAL_BIG, col3(PAL.roadBig));
  // the centre line is drawn opaque, so its alpha is folded into the road under it
  put(PAL_LINE, mix3(roadC, col3(PAL.line), colA(PAL.line)));
  gl.uniform3fv(G3.gnd.u.uPal, P8);
  for (const cell of draw) if (cell.gnd) {
    gl.bindVertexArray(cell.gnd.vao);
    gl.drawArrays(gl.TRIANGLES, 0, cell.gnd.n);
    G3.tris += cell.gnd.n / 3;
  }

  gl.useProgram(G3.lit.p);
  setCommon(G3.lit);
  gl.uniform3fv(G3.lit.u.uGlass, th.glass);
  gl.uniform3fv(G3.lit.u.uWinCol, th.win);
  gl.uniform1f(G3.lit.u.uWinK, th.winK);
  gl.uniform1f(G3.lit.u.uGlassE, th.glassE);
  gl.uniform1f(G3.lit.u.uWinMin, G3.noWin ? 1e9 : WIN_MIN_H);
  gl.uniform1f(G3.lit.u.uPaint, 0);            // masonry: the theme's light makes it
  for (const cell of draw) if (cell.lit) {
    gl.bindVertexArray(cell.lit.vao);
    gl.drawArrays(gl.TRIANGLES, 0, cell.lit.n);
    G3.tris += cell.lit.n / 3;
    G3.drawn++;
  }
  /* ---- the names on the buildings ----

     After the masonry and before the cars, because a sign is bolted to a wall
     and a car can park in front of it. Depth test on so it is hidden by whatever
     is between you and it, depth WRITE off because the glyphs are cut out with
     alpha and the transparent corners of the quad would otherwise punch a
     rectangular hole in everything drawn afterwards. */
  if (SIGN.tex) {
    gl.useProgram(G3.sign.p);
    gl.uniformMatrix4fv(G3.sign.u.uVP, false, G3.VP);
    gl.uniform3fv(G3.sign.u.uFog, th.sky);
    gl.uniform2f(G3.sign.u.uFogR, FOG0, VIEW3);
    /* Warm at dusk, plain white by day — the same lamp colour the street lights
       use, so a fascia sign after dark belongs to the same night as everything
       under it. */
    gl.uniform3fv(G3.sign.u.uInk, themeName === 'day' ? [1, 1, 1] : [1, .93, .80]);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, SIGN.tex);
    gl.uniform1i(G3.sign.u.uTex, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    for (const cell of draw) if (cell.sgn) {
      gl.bindVertexArray(cell.sgn.vao);
      gl.drawArrays(gl.TRIANGLES, 0, cell.sgn.n);
      G3.tris += cell.sgn.n / 3;
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.useProgram(G3.lit.p);
  }

  if (dyn.length && G3.cars.n) {
    gl.uniform1f(G3.lit.u.uPaint, 1);          // paint: keeps its colour after dark
    gl.bindVertexArray(G3.cars.vao);
    gl.drawArrays(gl.TRIANGLES, 0, G3.cars.n);
    G3.tris += G3.cars.n / 3;
  }

  /* ---- and the near cars, one draw each ---- */
  if (meshCars.length && G3.carVao) {
    gl.useProgram(G3.car.p);
    setCommon(G3.car);
    // everything but the paint is the same on every car in the city, so the tail
    // of the palette is uploaded once and only slot zero moves
    for (let i = 1; i < CAR_PAL.length; i++) {
      CARM.pal[i * 3] = CAR_PAL[i][0]; CARM.pal[i * 3 + 1] = CAR_PAL[i][1];
      CARM.pal[i * 3 + 2] = CAR_PAL[i][2];
    }
    gl.bindVertexArray(G3.carVao);
    for (const q of meshCars) {
      carModel(q.src, CARM.m, CARM.nm);
      M4.mul(CARM.mvp, G3.VP, CARM.m);
      M4.mul(CARM.mlvp, G3.LVP, CARM.m);
      gl.uniformMatrix4fv(G3.car.u.uMVP, false, CARM.mvp);
      gl.uniformMatrix4fv(G3.car.u.uMLVP, false, CARM.mlvp);
      gl.uniformMatrix3fv(G3.car.u.uNM, false, CARM.nm);
      CARM.pal[0] = q.col[0]; CARM.pal[1] = q.col[1]; CARM.pal[2] = q.col[2];
      gl.uniform3fv(G3.car.u.uCarPal, CARM.pal);
      gl.drawArrays(gl.TRIANGLES, 0, G3.carN);
      G3.tris += G3.carN / 3;
    }
  }

  /* ---- pass three: tyre marks, then everything that glows ---- */
  const FXATTR = [[G3.fx.a.aPos, 3], [G3.fx.a.aCol, 4], [G3.fx.a.aUV, 2]];
  const fx = [];
  // a flat quad: every uv at the centre of the falloff, so the shader leaves it alone
  const hard = (o, ax, ay, az, bx, by, bz, cx2, cy2, cz2, dx, dy, dz, r, g, b, a) => {
    o.push(ax, ay, az, r, g, b, a, 0, 0, bx, by, bz, r, g, b, a, 0, 0, cx2, cy2, cz2, r, g, b, a, 0, 0);
    o.push(ax, ay, az, r, g, b, a, 0, 0, cx2, cy2, cz2, r, g, b, a, 0, 0, dx, dy, dz, r, g, b, a, 0, 0);
  };
  for (const m of marks) {
    if (!near(m)) continue;
    const a = clamp(m.life / MARK_LIFE, 0, 1) * .5;
    const y = terrainH(m.x, m.y) + .26;
    const o = m.w * .35, dx = Math.cos(m.h) * 1.2, dz = Math.sin(m.h) * 1.2;
    const px = -Math.sin(m.h) * .22, pz = Math.cos(m.h) * .22;
    for (const s of [1, -1]) {
      const bx = m.x - Math.sin(m.h) * o * s, bz = m.y + Math.cos(m.h) * o * s;
      hard(fx, bx - dx - px, y, bz - dz - pz, bx + dx - px, y, bz + dz - pz,
               bx + dx + px, y, bz + dz + pz, bx - dx + px, y, bz - dz + pz, .04, .02, .06, a);
    }
  }
  if (fx.length) {
    gl.useProgram(G3.fx.p);
    gl.uniformMatrix4fv(G3.fx.u.uVP, false, G3.VP);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    G3.fxm = GL.stream(G3.fxm, new Float32Array(fx), FXATTR);
    gl.bindVertexArray(G3.fxm.vao);
    gl.drawArrays(gl.TRIANGLES, 0, G3.fxm.n);
  }

  // sparks, smoke, fireballs, street lights and the sun: additive, always facing you
  const add = [];
  const camR = [G3.V[0], G3.V[4], G3.V[8]], camU = [G3.V[1], G3.V[5], G3.V[9]];
  const bill = (x, y, z, r, cr, cg, cb, ca) => {
    const rx = camR[0] * r, ry = camR[1] * r, rz = camR[2] * r;
    const ux = camU[0] * r, uy = camU[1] * r, uz = camU[2] * r;
    const v = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
    for (const [a, b] of v)
      add.push(x + rx * a + ux * b, y + ry * a + uy * b, z + rz * a + uz * b, cr, cg, cb, ca, a, b);
  };

  /* THE SUN, OR THE MOON. Placed along the light direction, so it is genuinely
     where the shading says it is — walk round a building at dusk and the moon is
     on the side the shadows point away from, because both read the same vector.

     Far out but inside the far plane, and depth-tested, so a tower in front of
     it blocks it. It is deliberately NOT fogged: haze dims a hillside because
     there is air in the way, and the same air is what makes a low sun a disc you
     can look at. */
  {
    const C = G3.cam, o = th.orb, D = VIEW3 * .82;
    const ox = C.ex + LD[0] * D, oy = C.ey + LD[1] * D, oz = C.ez + LD[2] * D;
    bill(ox, oy, oz, o.r * o.halo, o.col[0], o.col[1], o.col[2], o.ha);
    bill(ox, oy, oz, o.r, o.col[0], o.col[1], o.col[2], .95);
  }

  for (const p of parts) {
    if (!near(p)) continue;
    const a = clamp(p.life * 2, 0, 1);
    const q = parseColour(p.col) || [255, 200, 120];
    const r = p.soft ? (p.r || .5) * (1 + (1 - p.life / p.life0) * 1.9) : (p.r || .28);
    bill(p.x, terrainH(p.x, p.y) + .6 + r, p.y, r,
         q[0] / 255, q[1] / 255, q[2] / 255, p.soft ? a * .3 : a);
  }
  for (const b of blasts) {
    const t = clamp(b.life / .55, 0, 1);
    const by = terrainH(b.x, b.y) + b.r * .6;
    bill(b.x, by, b.y, b.r, 1, .30, 0, t * .7);
    bill(b.x, by, b.y, b.r * .34, 1, .76, .42, t * t * t * .8);
  }

  /* THE MARKERS, which the chase view simply did not draw.

     The top-down game paints a marker on the ground at the objective and at
     every landmark, and none of that survived the move to 3D: the pickup existed
     on the radar and on the city map and nowhere you could see it out of the
     windscreen. Reported, exactly, as being able to see the pink and yellow
     things only on the map.

     A ground marker is the wrong answer here anyway. From a camera six metres up
     behind a car, a disc painted on the tarmac is a thin ellipse hidden behind
     the next vehicle, and it is invisible from more than a street away — which
     is most of the time, because a delivery is routinely a kilometre off. So
     these are BEACONS: a column of light standing where the marker is.

     FIFTY-FIVE METRES for the objective, which is a number and not a flourish.
     The column is depth-tested like everything else, so a building in front of
     it hides it, and that is right — a light you can see through a wall reads as
     a bug. But it has to clear the roofline it is standing behind, and these
     blocks run twenty to thirty metres, so the column has to be taller than the
     street it is in. Landmarks get a short one instead, and only within 150 m,
     because a garage is a convenience rather than a destination and a skyline of
     beacons is worse than none. */
  {
    /* A column faces the camera about its own vertical axis, not about the
       camera's up — a light shaft that tips over when you crest a hill stops
       being a shaft. So the horizontal axis is the camera's right vector
       flattened onto the ground and renormalised. */
    let hx = camR[0], hz = camR[2];
    const hl = Math.hypot(hx, hz) || 1;
    hx /= hl; hz /= hl;
    /* The UVs are what make it a flame rather than a slab. The fx shader fades
       on length(uv), so a corner at (±1, 0) is already gone at the base edge and
       (0, 1) is gone at the top: full brightness up the centre of the base,
       nothing at the sides, nothing at the tip. */
    /* AND IT FADES OUT AS YOU REACH IT, for the same reason the street lamps do:
       a billboard seen from the inside is a wash over the whole screen.

       This was reported after being BUSTED, which is the case that makes it
       unavoidable — you are booked at the station and respawn on the kerb beside
       it, which is to say standing inside that station's own beacon. Measured, a
       beacon at zero distance lifts the mean brightness of the ENTIRE frame from
       28.1 to 34, a pale haze across the road that decays to nothing by about a
       hundred metres. Nothing is blown out and no single pixel looks wrong, which
       is why it reads as fog rather than as a bug.

       The shaft is the part that has to go: it is a vertical billboard the camera
       can be inside, and it is tallest and widest exactly where it is least
       useful, because a column marking a spot you are already standing on tells
       you nothing. The corona stays — it is flat on the tarmac, seen from six
       metres up, and it is the right marker at arm's length. */
    const fadeIn = (x, z, near, span) => {
      const d = Math.hypot(x - G3.cam.ex, z - G3.cam.ez);
      return clamp((d - near) / span, 0, 1);
    };
    const shaft = (x, z, h, w, cr, cg, cb, a, lift) => {
      if (a <= 0.004) return;
      const y = terrainH(x, z) + (lift || 0);
      const v = [[-1, 0], [1, 0], [1, 1], [-1, 0], [1, 1], [-1, 1]];
      for (const [u, t] of v)
        add.push(x + hx * w * u, y + .25 + h * t, z + hz * w * u, cr, cg, cb, a, u, t);
    };
    // and a corona on the tarmac underneath it, so the spot itself is marked
    const corona = (x, z, r, cr, cg, cb, a) => {
      const v = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
      for (const [u, t] of v)
        add.push(x + u * r, terrainH(x + u * r, z + t * r) + .30, z + t * r, cr, cg, cb, a, u, t);
    };
    const tgt = MISSION.state === 'pickup' ? MISSION.pick
              : MISSION.state === 'deliver' ? MISSION.drop : null;
    if (tgt) {
      const q = parseColour(MISSION.state === 'pickup' ? '#ff4fd8' : GOLD) || [255, 79, 216];
      const cr = q[0] / 255, cg = q[1] / 255, cb = q[2] / 255;
      /* Gone under sixteen metres and at full strength by forty-two. The pickup
         itself triggers at seven, so the column is there for the whole approach
         and only stands down once you are close enough that the corona under
         your wheels is the clearer marker. */
      const k = fadeIn(tgt.x, tgt.y, 16, 26);
      shaft(tgt.x, tgt.y, 55, 3.4, cr, cg, cb, .42 * k);
      shaft(tgt.x, tgt.y, 26, 1.6, cr, cg, cb, .34 * k);      // a brighter core
      corona(tgt.x, tgt.y, 6.5, cr, cg, cb, .40);
    }
    for (const p of W.pois) {
      if (dist2(p.x, p.y, cam.x, cam.y) > 150 * 150) continue;
      const q = parseColour(POI_COL[p.kind]) || [255, 255, 255];
      /* A shorter column, so a shorter fade — but the same rule, and this is the
         one you end up standing in after a bust or a trip to the hospital.

         STOOD ON THE ROOF WHEN THE LANDMARK IS A BUILDING. p.lift is the height
         of whatever footprint the POI sits inside, worked out in world.js. A
         hospital mapped the way form has its POI at the middle of its own floor,
         and thirteen metres of column inside a twenty-metre block never reaches
         daylight — so the marker for the one thing you are trying to find is the
         one thing you cannot see. On the roof it reads as a sign on the
         building, which is what it is for. */
      shaft(p.x, p.y, 13, 1.5, q[0] / 255, q[1] / 255, q[2] / 255,
            .30 * fadeIn(p.x, p.y, 10, 18), p.lift);
      corona(p.x, p.y, 3.2, q[0] / 255, q[1] / 255, q[2] / 255, .26);
    }
  }

  /* THE STREET LIGHTS, which are most of what this game looks like after dark.
     The 2D view blits a pre-tinted glow sprite for each; here they are additive
     billboards standing six metres up, which is where a lamp is. Same list, same
     colours, same one-in-six chance of being neon rather than sodium — the
     difference is that in 3D you drive under them. */
  if (W.lights && PAL.lights) {
    const C = G3.cam;
    let n = 0;
    for (const L of W.lights) {
      if (n > 260) break;
      if (dist2(L.x, L.y, cam.x, cam.y) > 240 * 240) continue;
      n++;
      const q = parseColour(L.c) || [255, 210, 160];
      const ly = terrainH(L.x, L.y) + 6;
      /* Fade a lamp out as you reach it. The eye is about six metres up and so is
         the lamp, so a glow you drive INTO is one whose billboard the camera ends
         up inside — and a billboard seen from the inside is a coloured wash over
         the entire screen. It is gone by the time that could happen, which is
         also what a light you have driven under does. */
      const d = Math.hypot(L.x - C.ex, ly - C.ey, L.y - C.ez);
      const a = clamp((d - 11) / 14, 0, 1) * .34;
      if (a <= 0) continue;
      bill(L.x, ly, L.y, 7.5, q[0] / 255, q[1] / 255, q[2] / 255, a);
    }
  }

  if (add.length) {
    gl.useProgram(G3.fx.p);
    gl.uniformMatrix4fv(G3.fx.u.uVP, false, G3.VP);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    G3.fxm = GL.stream(G3.fxm, new Float32Array(add), FXATTR);
    gl.bindVertexArray(G3.fxm.vao);
    gl.drawArrays(gl.TRIANGLES, 0, G3.fxm.n);
  }
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  gl.bindVertexArray(null);

  trimCells();

  /* ---- the 2D canvas on top, for everything that is not the world ---- */
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, VW, VH);
  drawArrow();
  drawHUD();
  drawMini();
}

/* Cells you have driven away from. Kept generously — turning round on a street
   you just drove down must not rebuild it — and dropped furthest-first once
   there are more than the cap. */
function trimCells() {
  if (G3.cells.size <= CELL_CAP) return;
  const all = [...G3.cells.entries()]
    .map(([k, c]) => ({ k, c, d: dist2((c.x0 + c.x1) / 2, (c.z0 + c.z1) / 2, cam.x, cam.y) }))
    .sort((a, b) => b.d - a.d);
  for (let i = 0; i < all.length - CELL_CAP; i++) {
    freeCell(all[i].c);
    G3.cells.delete(all[i].k);
  }
}

/* ------------------------------ the switch ------------------------------ */
/* One name, two renderers. Everything outside this file — main.js's loop, the
   test hooks, drawArrow, drawBuilding — calls render() and toScreen() and never
   learns which one it got. */
/* THREE VIEWS, ONE SWITCH. SOFT is the chase view drawn on the 2D canvas, for
   the browsers that have no WebGL at all — it is a different rasteriser, not a
   different game, so everything above this line treats it as the chase view. */
function render() { MODE3D ? (SOFT3D ? render3DSoft() : render3D()) : render2D(); }
function toScreen(wx, wy) { return MODE3D ? toScreen3D(wx, wy) : toScreen2D(wx, wy); }

function resize3D() {
  const el = $('gl');
  if (!el || !GL.gl) return;
  // same rule as the 2D canvases: assigning either dimension clears the buffer,
  // so a resize that changes nothing must write nothing
  const w = Math.floor(VW * DPR), h = Math.floor(VH * DPR);
  if (el.width !== w) el.width = w;
  if (el.height !== h) el.height = h;
}

/* Returns whether it worked, because a browser without WebGL2 has to be told
   rather than left looking at a black rectangle. */
function setMode3D(on) {
  if (on && !MODE3D) {
    SOFT3D = false;
    GL.attempts++;
    /* AND SAY SO IN THE LOG. This used to put a toast on the screen and leave no
       trace anywhere else, so a report of "3D is not available again" arrived
       with a log that recorded mirror timings, the car's position and nothing at
       all about the one thing that had gone wrong. initGL3 compiles every shader
       in the game, so it is caught as well: a link error on one phone's driver
       is a plausible cause and would otherwise escape as a bare stack trace. */
    let ok = false, err = '';
    try { ok = !!GL.init($('gl')) && initGL3(); }
    catch (e) { err = String(e && e.message || e); }
    if (!ok) {
      const why = GL.fail || err || 'initGL3 returned false';
      if (typeof LOG !== 'undefined' && LOG.note) LOG.note('gl', '3D refused: ' + why);
      /* NO WEBGL IS NOT NO CHASE VIEW. It used to be: the button said "3D NEEDS
         WEBGL2" and put you back in the top-down game, which on a browser with
         WebGL switched off means never seeing the thing at all — and that is a
         browser, not a broken phone. Everything the GL renderer uses except the
         GL is ordinary JavaScript, so the same street is drawn on the 2D canvas
         instead. It gives up the shading, the shadows and the window grid; it
         keeps being behind the car in a street with depth.

         The toast still names the fault, because one of the two is something the
         player can go and change: a missing constructor means WebGL is switched
         off in this browser, which on iOS is what Lockdown Mode does. */
      SOFT3D = true;
      const none = typeof WebGL2RenderingContext === 'undefined' &&
                   typeof WebGLRenderingContext === 'undefined';
      toast(none ? 'NO WEBGL HERE — DRAWING 3D THE SLOW WAY'
                 : '3D WITHOUT A GPU — THE SLOW WAY', 3000);
    }
  }
  MODE3D = !!on;
  /* The terrain and the 2D game are mutually exclusive on purpose. With TERRAIN
     off, terrainH() is a constant zero and every vertical term in the physics is
     multiplied by nothing — the top-down game is exactly the game it was, and
     the tests written against it stay honest. */
  TERRAIN = MODE3D;
  terrainSeed();
  $('gl').classList.toggle('on', MODE3D && !SOFT3D);
  $('modeN').textContent = MODE3D ? '2D' : '3D';
  $('modeBtn').title = MODE3D ? 'Switch to the top-down view' : 'Switch to the chase view';
  document.body.classList.toggle('mode-3d', MODE3D);
  /* The car has no height until the ground under it has one, and the first
     ground step reads an undefined z as "place me". Clearing it on the way in
     AND on the way out means switching views mid-corner never launches anything. */
  const all = [P.car].concat(traffic, cops);
  for (const q of all) if (q) { q.z = undefined; q.air = false; q.flip = 0; q.pitch = q.roll = 0; }
  G3.cam.h = P.car ? P.car.h : 0;
  last3 = performance.now();
  dropAllCells();
  resize();
  try { localStorage.setItem('vm3d', MODE3D ? '1' : '0'); } catch (e) {}
  return true;
}

/* Whatever view you were last in, put back at the moment the city appears.
   Silently: a player who chose 3D on a machine that has since lost WebGL2 gets
   the top-down game and no scolding, because there is nothing they can do about
   it and the game works either way. */
function restoreView3D() {
  let want = false;
  try { want = localStorage.getItem('vm3d') === '1'; } catch (e) {}
  if (want === MODE3D) return;
  if (want && (!GL.init($('gl')) || !initGL3())) return;
  setMode3D(want);
}
