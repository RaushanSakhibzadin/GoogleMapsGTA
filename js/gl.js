"use strict";
/* VICE MAPS — WebGL2 plumbing and the 4×4 matrices the 3D view needs.

   Part of a set of plain <script> files sharing one global scope. They are NOT
   modules on purpose: ES modules are blocked over file://, and opening
   index.html straight off disk with no build step is the point of this thing.
   Load order is fixed in index.html and matters — this one comes before
   render3d.js, which is the only file that uses it.

   NO LIBRARY. gl-matrix is 40 KB to get four functions, and three.js is 600 to
   get a scene graph this game does not have: the world is already a flat list of
   footprints in metres, the camera is behind a car, and there is exactly one
   light. What is actually needed is perspective, lookAt, a multiply and a point
   transform — which is what is here. Everything is column-major Float32Array(16)
   because that is what uniformMatrix4fv takes, and any other convention would be
   converted at the boundary anyway.

   THIS FILE IS 3D-ONLY. The 2D game never loads a GL context, never compiles a
   shader and is not slowed down by any of it — index.html loads this, but
   nothing in it runs until someone presses the 3D button. */

/* ------------------------------ matrices ------------------------------ */
const M4 = {
  make: () => new Float32Array(16),

  ident(o) {
    o[0] = 1; o[1] = 0; o[2] = 0; o[3] = 0;
    o[4] = 0; o[5] = 1; o[6] = 0; o[7] = 0;
    o[8] = 0; o[9] = 0; o[10] = 1; o[11] = 0;
    o[12] = 0; o[13] = 0; o[14] = 0; o[15] = 1;
    return o;
  },

  /* Right-handed, looking down -Z, with the near plane mapping to NDC -1. */
  perspective(o, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    o[0] = f / aspect; o[1] = 0; o[2] = 0; o[3] = 0;
    o[4] = 0; o[5] = f; o[6] = 0; o[7] = 0;
    o[8] = 0; o[9] = 0; o[10] = (far + near) * nf; o[11] = -1;
    o[12] = 0; o[13] = 0; o[14] = 2 * far * near * nf; o[15] = 0;
    return o;
  },

  /* Orthographic, for the shadow pass. The sun is 150 million kilometres away, so
     its rays are parallel and its projection has no vanishing point — a
     perspective shadow map would put the shadows of distant buildings in the
     wrong place and make near ones enormous. */
  ortho(o, l, r, b, t, near, far) {
    const lr = 1 / (l - r), bt = 1 / (b - t), nf = 1 / (near - far);
    o[0] = -2 * lr; o[1] = 0; o[2] = 0; o[3] = 0;
    o[4] = 0; o[5] = -2 * bt; o[6] = 0; o[7] = 0;
    o[8] = 0; o[9] = 0; o[10] = 2 * nf; o[11] = 0;
    o[12] = (l + r) * lr; o[13] = (t + b) * bt; o[14] = (far + near) * nf; o[15] = 1;
    return o;
  },

  lookAt(o, ex, ey, ez, cx, cy, cz, ux, uy, uz) {
    let zx = ex - cx, zy = ey - cy, zz = ez - cz;
    let l = Math.hypot(zx, zy, zz) || 1;
    zx /= l; zy /= l; zz /= l;
    // x = up × z
    let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
    l = Math.hypot(xx, xy, xz);
    /* A camera looking straight down has up parallel to z and no cross product to
       normalise. It cannot happen from a chase camera behind a car, but it can
       happen from a test that places the eye by hand, and a NaN matrix draws
       nothing at all with no error anywhere — so nudge instead of dividing by
       zero. */
    if (l < 1e-6) { xx = 1; xy = 0; xz = 0; } else { xx /= l; xy /= l; xz /= l; }
    // y = z × x, already unit since both are
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0;
    o[4] = xy; o[5] = yy; o[6] = zy; o[7] = 0;
    o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0;
    o[12] = -(xx * ex + xy * ey + xz * ez);
    o[13] = -(yx * ex + yy * ey + yz * ez);
    o[14] = -(zx * ex + zy * ey + zz * ez);
    o[15] = 1;
    return o;
  },

  // o = a · b, with b applied first (o transforms a point by b then by a)
  mul(o, a, b) {
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      o[c * 4]     = a[0] * b0 + a[4] * b1 + a[8]  * b2 + a[12] * b3;
      o[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9]  * b2 + a[13] * b3;
      o[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      o[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return o;
  },

  // the full clip-space result, w included — the projection needs it
  xform(m, x, y, z) {
    return [m[0] * x + m[4] * y + m[8]  * z + m[12],
            m[1] * x + m[5] * y + m[9]  * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
            m[3] * x + m[7] * y + m[11] * z + m[15]];
  }
};

/* The six frustum planes, pulled straight out of a view-projection matrix
   (Gribb & Hartmann). Each is [a,b,c,d] with the inside on the positive side, so
   a box is rejected the moment its most-positive corner still lands negative.
   Normalising is not strictly needed for a box test, but it makes the distances
   real metres, which is what the near-cell padding is expressed in. */
function frustumOf(m, out) {
  const p = out || [];
  const row = (i, s) => [
    m[3] + s * m[i], m[7] + s * m[i + 4], m[11] + s * m[i + 8], m[15] + s * m[i + 12]
  ];
  const planes = [row(0, 1), row(0, -1), row(1, 1), row(1, -1), row(2, 1), row(2, -1)];
  for (let i = 0; i < 6; i++) {
    const q = planes[i];
    const l = Math.hypot(q[0], q[1], q[2]) || 1;
    p[i] = [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  }
  return p;
}

/* An axis-aligned box against the frustum. Conservative: a box that straddles a
   plane is kept, and a box outside any one plane is gone. */
function boxInFrustum(pl, x0, y0, z0, x1, y1, z1) {
  for (let i = 0; i < 6; i++) {
    const p = pl[i];
    // the corner furthest along the plane normal — if even that is behind, all are
    const vx = p[0] >= 0 ? x1 : x0, vy = p[1] >= 0 ? y1 : y0, vz = p[2] >= 0 ? z1 : z0;
    if (p[0] * vx + p[1] * vy + p[2] * vz + p[3] < 0) return false;
  }
  return true;
}

/* ------------------------------ context ------------------------------ */
/* One object owns the context and everything made from it, so a failure to get
   WebGL2 at all is a single null check at the call site rather than a spray of
   exceptions from inside the render loop. */
const GL = {
  gl: null,
  canvas: null,
  fail: '',                        // why 3D is unavailable, for the toast

  /* Returns the context, or null. Called once, lazily, the first time anybody
     asks for the 3D view — a player who never presses the button never pays for
     a GL context, and a browser without WebGL2 never sees an error until it is
     relevant to them. */
  init(canvas) {
    if (this.gl) return this.gl;
    if (this.fail) return null;
    this.canvas = canvas;
    let gl = null;
    try {
      gl = canvas.getContext('webgl2', {
        alpha: false, antialias: true, depth: true, stencil: false,
        // the frame is fully repainted every time; preserving it only costs a copy
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance'
      });
    } catch (e) { gl = null; }
    if (!gl) { this.fail = 'WebGL2 unavailable'; return null; }
    this.gl = gl;
    /* A lost context is not an error to report — it is a laptop switching GPUs, a
       phone waking up, or a driver reset. Swallow the default (which kills the
       canvas permanently), drop everything built from the dead context, and let
       the next frame rebuild it. */
    canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault();
      if (typeof glContextLost === 'function') glContextLost();
    }, false);
    return gl;
  },

  /* EVERY PROGRAM AGREES ABOUT WHERE THE ATTRIBUTES LIVE.

     A vertex array remembers attribute LOCATIONS, not names, and the linker is
     free to assign them however it likes — so a mesh built with the positions of
     one program's `aPos` can quietly feed them into another program's `aNrm`.
     That is exactly what the shadow pass does: it draws the same buffers the
     lighting pass built, through a different program. Binding the names to fixed
     slots before linking makes every VAO usable by every program, which is the
     difference between one vertex buffer per mesh and one per pass. */
  program(vsSrc, fsSrc) {
    const gl = this.gl;
    const SLOT = { aPos: 0, aNrm: 1, aCol: 2, aPal: 3, aUV: 4, aWall: 5 };
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error('shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    const vs = sh(gl.VERTEX_SHADER, vsSrc), fs = sh(gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    for (const nm in SLOT) gl.bindAttribLocation(p, SLOT[nm], nm);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error('link: ' + gl.getProgramInfoLog(p));
    gl.deleteShader(vs); gl.deleteShader(fs);
    // every uniform and attribute location, looked up once and kept
    const u = {}, a = {};
    const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < nu; i++) {
      const nm = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
      u[nm] = gl.getUniformLocation(p, nm);
    }
    const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for (let i = 0; i < na; i++) {
      const nm = gl.getActiveAttrib(p, i).name;
      a[nm] = gl.getAttribLocation(p, nm);
    }
    return { p, u, a };
  },

  /* A vertex array plus its buffer, uploaded once. `attrs` is a list of
     [location, size] in the order they are interleaved; the stride is worked out
     from the total. Returns null for an empty mesh so callers can skip it
     without a special case — a zero-length draw is legal but a wasted state
     change. */
  mesh(data, attrs) {
    const gl = this.gl;
    if (!data.length) return null;
    let comps = 0;
    for (const [, n] of attrs) comps += n;
    const stride = comps * 4;
    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    let off = 0;
    for (const [loc, n] of attrs) {
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, n, gl.FLOAT, false, stride, off);
      }
      off += n * 4;
    }
    gl.bindVertexArray(null);
    return { vao, buf, n: data.length / comps };
  },

  /* Same shape, but the buffer is re-uploaded every frame — traffic, particles,
     tyre marks. Kept and orphaned rather than recreated, because allocating a
     buffer per frame is how you get a stall on a mobile driver. */
  stream(prev, data, attrs) {
    const gl = this.gl;
    let comps = 0;
    for (const [, n] of attrs) comps += n;
    if (!prev) {
      prev = { vao: gl.createVertexArray(), buf: gl.createBuffer(), n: 0, cap: 0 };
      gl.bindVertexArray(prev.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, prev.buf);
      let off = 0;
      const stride = comps * 4;
      for (const [loc, n] of attrs) {
        if (loc >= 0) {
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, n, gl.FLOAT, false, stride, off);
        }
        off += n * 4;
      }
      gl.bindVertexArray(null);
    }
    prev.n = data.length / comps;
    if (!prev.n) return prev;
    gl.bindBuffer(gl.ARRAY_BUFFER, prev.buf);
    if (data.length > prev.cap) {
      // grow with headroom so a steadily busier scene doesn't reallocate every frame
      prev.cap = Math.ceil(data.length * 1.5);
      gl.bufferData(gl.ARRAY_BUFFER, prev.cap * 4, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    return prev;
  },

  free(m) {
    if (!m || !this.gl) return;
    this.gl.deleteVertexArray(m.vao);
    this.gl.deleteBuffer(m.buf);
  },

  /* A depth-only render target: what the sun can see.

     COMPARE_REF_TO_TEXTURE is the part worth knowing about. With it set, the
     texture is sampled through a sampler2DShadow and the hardware does the
     depth comparison AND bilinear filtering of the RESULT — so one tap already
     costs four samples' worth of softening, for free, on hardware that has done
     this since 2004. Sampling raw depths and comparing them by hand gives hard,
     stair-stepped shadow edges and costs more.

     A colour attachment is deliberately absent; the fragment shader writes
     nothing and the whole pass is depth. */
  shadowMap(size) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0,
                  gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // CLAMP_TO_EDGE, so ground beyond the map's edge reads the border depth
    // rather than wrapping a building's shadow round to the other side
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (!ok) { gl.deleteFramebuffer(fb); gl.deleteTexture(tex); return null; }
    return { fb, tex, size };
  }
};

/* ------------------------------ geometry ------------------------------ */
/* EAR CLIPPING, because real building footprints are not convex and a triangle
   fan across an L-shaped block fills in the missing corner. OSM is full of
   courtyards, terraces and blocks wrapped round a yard, and every one of them
   comes out as a solid slab under a fan.

   Returns a flat list of vertex indices, three per triangle, into `pts`. The
   input may be closed (OSM ways repeat their first node) — that is stripped
   here rather than at every call site. */
function earClip(pts) {
  let n = pts.length;
  if (n > 2 && Math.abs(pts[0].x - pts[n - 1].x) < 1e-7 && Math.abs(pts[0].y - pts[n - 1].y) < 1e-7) n--;
  if (n < 3) return [];

  // work on an index ring, so a clipped ear is one splice and no point copying
  const V = new Array(n);
  let area2 = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area2 += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  // walk the ring so that the polygon is always counter-clockwise in our terms
  if (area2 >= 0) for (let i = 0; i < n; i++) V[i] = i;
  else for (let i = 0; i < n; i++) V[i] = n - 1 - i;

  const cross = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const out = [];
  let count = n;
  /* Bounded. A self-intersecting footprint — and OSM has them — has no ear to
     find, and the naive loop spins on it for ever. Two full laps without
     clipping anything means give up and return what we have; a slightly wrong
     roof on one building beats a hung tab. */
  let guard = 2 * n * n;
  for (let v = count - 1; count > 2;) {
    if (guard-- <= 0) break;
    const u = v % count, w = (u + 2) % count;
    v = (u + 1) % count;
    const a = pts[V[u]], b = pts[V[v]], c = pts[V[w]];
    if (cross(a.x, a.y, b.x, b.y, c.x, c.y) <= 1e-10) continue;   // reflex or degenerate
    let ok = true;
    for (let i = 0; i < count; i++) {
      if (i === u || i === v || i === w) continue;
      const p = pts[V[i]];
      // any other vertex inside the candidate ear disqualifies it
      if (cross(a.x, a.y, b.x, b.y, p.x, p.y) >= 0 &&
          cross(b.x, b.y, c.x, c.y, p.x, p.y) >= 0 &&
          cross(c.x, c.y, a.x, a.y, p.x, p.y) >= 0) { ok = false; break; }
    }
    if (!ok) continue;
    out.push(V[u], V[v], V[w]);
    V.splice(v, 1);
    count--;
    guard = 2 * count * count;
    v = count - 1;
  }
  return out;
}

/* Which way is OUT. The sign of the shoelace area decides it for the whole
   polygon at once, which is the only way that survives a concave edge — a
   per-edge test against the centroid gets the inside of a courtyard backwards.
   Matches the convention drawBuilding() uses in the 2D renderer, deliberately,
   so a footprint that reads correctly in one view reads correctly in both. */
function windingOf(pts) {
  let a2 = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
    a2 += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  return a2 >= 0 ? 1 : -1;
}
