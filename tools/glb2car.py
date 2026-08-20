#!/usr/bin/env python3
"""Bake a glTF/GLB vehicle into js/carmodel.js, so the chase view can draw it.

    python3 tools/glb2car.py path/to/sedan.glb > js/carmodel.js

WHY A TOOL AND NOT A LOADER. A browser opened on a file:// URL cannot fetch a
sibling file -- .obj, .gltf and .json alike are cross-origin against a null
origin and refused -- and opening index.html straight off disk with nothing
installed is the whole point of this game. So every asset it loads from disk is
a .js file with the data inlined, which is why data/belgrade.js is a script and
not a JSON document. This does the same for a mesh.

It also means the parsing happens once, here, instead of shipping a glTF reader
to every player for a file that never changes.

WHAT MAKES A MODEL USABLE. Not the format -- glTF, OBJ and FBX all carry the
same triangles. What matters is whether the PARTS ARE SEPARABLE. Every car in
traffic picks its own colour, so the body has to be identifiable apart from the
glass, the tyres and the lamps. A model authored against a single shared texture
atlas -- which is how most of the ready-made low-poly kits are built, including
Kenney's, where body, window and wheel are one material told apart by where they
land on a colour map -- cannot be recoloured per car at all. Run one of those
through this and the whole fleet comes out one colour.

So the mapping below is by MATERIAL NAME, and a model with one material for
everything will say so loudly rather than quietly producing a monochrome car.

    CC0 sources worth trying, all of which keep their parts separate:
      kenney.nl/assets/car-kit          (public domain, sedan/hatchback/van/suv)
      opengameart.org/content/car-kit   (the same pack, mirrored)

The output is a Float32Array of [x, y, z, nx, ny, nz, material] per vertex in
the game's own car space: x forward from -1 at the rear bumper to +1 at the
nose, y up from 0 at the road to 2 at the top of the collision cuboid, z lateral
+/-1 at the widest the body may be. js/carmesh.js picks it up automatically if
js/carmodel.js is loaded before it; without it, the hand-built mesh is used.
"""

import base64
import json
import os
import re
import struct
import sys

# material name -> the game's material slots, matching js/carmesh.js
SLOT = {'paint': 0, 'glass': 1, 'tyre': 2, 'hub': 3, 'tail': 4, 'head': 5, 'trim': 6}
# what a material has to look like to be one of them; first match wins, and
# anything unrecognised is bodywork, which is the safe way round -- a stray panel
# in the car's colour is invisible, and a body panel in tyre black is not
RULES = [
    (r'glass|window|windshield|windscreen|screen', 'glass'),
    (r'tire|tyre|rubber|wheel(?!.*rim)', 'tyre'),
    (r'rim|hub|alloy|spoke', 'hub'),
    (r'tail|brake|rear.?light|stop', 'tail'),
    (r'head.?light|front.?light|lamp', 'head'),
    (r'bumper|trim|grill|grille|plastic|chrome|black', 'trim'),
]

COMP = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2),
        5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
NUM = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def load(path):
    """Return (gltf dict, list of buffer bytes). Handles .glb and .gltf alike."""
    raw = open(path, 'rb').read()
    if raw[:4] == b'glTF':
        js, bins = None, []
        off = 12
        while off < len(raw):
            clen, ctype = struct.unpack('<II', raw[off:off + 8])
            chunk = raw[off + 8:off + 8 + clen]
            if ctype == 0x4E4F534A:
                js = json.loads(chunk)
            elif ctype == 0x004E4942:
                bins.append(chunk)
            off += 8 + clen
        return js, bins
    js = json.loads(raw)
    bins = []
    base = os.path.dirname(os.path.abspath(path))
    for b in js.get('buffers', []):
        uri = b.get('uri', '')
        if uri.startswith('data:'):
            bins.append(base64.b64decode(uri.split(',', 1)[1]))
        elif uri:
            bins.append(open(os.path.join(base, uri), 'rb').read())
        else:
            bins.append(b'')
    return js, bins


def accessor(js, bins, i):
    """One accessor, as a flat list of numbers. Handles interleaved strides."""
    a = js['accessors'][i]
    n = NUM[a['type']]
    fmt, size = COMP[a['componentType']]
    if 'bufferView' not in a:
        return [0.0] * (a['count'] * n)
    bv = js['bufferViews'][a['bufferView']]
    buf = bins[bv.get('buffer', 0)]
    base = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride') or n * size
    out = []
    for k in range(a['count']):
        off = base + k * stride
        out.extend(struct.unpack_from('<' + fmt * n, buf, off))
    return out


def node_matrix(nd):
    """A node's local transform, as a 4x4 in column-major order."""
    if 'matrix' in nd:
        return list(nd['matrix'])
    t = nd.get('translation', [0, 0, 0])
    r = nd.get('rotation', [0, 0, 0, 1])
    s = nd.get('scale', [1, 1, 1])
    x, y, z, w = r
    m = [
        1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
        2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
        2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
        0, 0, 0, 1,
    ]
    for c in range(3):
        for k in range(3):
            m[c * 4 + k] *= s[c]
    m[12], m[13], m[14] = t
    return m


def mul(a, b):
    o = [0.0] * 16
    for c in range(4):
        for r in range(4):
            o[c * 4 + r] = sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4))
    return o


def xform(m, p):
    return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
            m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
            m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]


def xform3(m, p):
    return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2],
            m[1] * p[0] + m[5] * p[1] + m[9] * p[2],
            m[2] * p[0] + m[6] * p[1] + m[10] * p[2]]


def slot_for(name):
    low = (name or '').lower()
    for pat, key in RULES:
        if re.search(pat, low):
            return SLOT[key]
    return SLOT['paint']


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    path = sys.argv[1]
    js, bins = load(path)
    mats = [m.get('name', '') for m in js.get('materials', [])]

    tris = []          # [(p0, p1, p2, n0, n1, n2, slot)]
    seen_slots = {}

    def walk(idx, parent):
        nd = js['nodes'][idx]
        m = mul(parent, node_matrix(nd))
        if 'mesh' in nd:
            for prim in js['meshes'][nd['mesh']]['primitives']:
                if prim.get('mode', 4) != 4:
                    continue                    # triangles only
                att = prim['attributes']
                pos = accessor(js, bins, att['POSITION'])
                nrm = accessor(js, bins, att['NORMAL']) if 'NORMAL' in att else None
                if 'indices' in prim:
                    idxs = [int(v) for v in accessor(js, bins, prim['indices'])]
                else:
                    idxs = list(range(len(pos) // 3))
                name = mats[prim['material']] if 'material' in prim else ''
                sl = slot_for(name)
                seen_slots[name] = sl
                for k in range(0, len(idxs) - 2, 3):
                    tri = []
                    for j in idxs[k:k + 3]:
                        p = xform(m, pos[j * 3:j * 3 + 3])
                        n = xform3(m, nrm[j * 3:j * 3 + 3]) if nrm else None
                        tri.append((p, n))
                    tris.append((tri, sl))
        for ch in nd.get('children', []):
            walk(ch, m)

    scene = js.get('scenes', [{}])[js.get('scene', 0)]
    ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    for r in scene.get('nodes', []):
        walk(r, ident)

    if not tris:
        sys.exit('%s: no triangles found' % path)

    # ---- into the game's car space -----------------------------------------
    # glTF is Y-up, Z-towards-the-viewer; a vehicle is almost always modelled
    # nose along -Z. The longest axis of the bounding box is taken as the length
    # whichever way round it is, so a model authored along X still lands right.
    lo = [min(p[a] for t, _ in tris for p, _ in t) for a in range(3)]
    hi = [max(p[a] for t, _ in tris for p, _ in t) for a in range(3)]
    size = [hi[a] - lo[a] for a in range(3)]
    length_axis = 0 if size[0] >= size[2] else 2
    lateral_axis = 2 if length_axis == 0 else 0
    sys.stderr.write('%s: %d triangles, bbox %s\n' %
                     (os.path.basename(path), len(tris),
                      ' x '.join('%.2f' % v for v in size)))
    for name, sl in sorted(seen_slots.items()):
        sys.stderr.write('  material %-24s -> slot %d\n' % (repr(name), sl))
    if len(seen_slots) < 2:
        sys.stderr.write(
            '\n  WARNING: this model has ONE material, so every part of it will\n'
            '  take the car\'s paint colour -- glass, tyres and lamps included.\n'
            '  It is a texture-atlas model. Pick one whose parts are separate.\n\n')

    def to_car(p):
        x = (p[length_axis] - lo[length_axis]) / (size[length_axis] or 1) * 2 - 1
        y = (p[1] - lo[1]) / (size[1] or 1) * 2
        z = (p[lateral_axis] - lo[lateral_axis]) / (size[lateral_axis] or 1) * 2 - 1
        return x, y, z

    def to_car_n(n):
        # a normal maps through the same axis permutation, without the offset,
        # and is renormalised afterwards because the three scales differ
        v = [n[length_axis] / (size[length_axis] or 1),
             n[1] / (size[1] or 1),
             n[lateral_axis] / (size[lateral_axis] or 1)]
        l = (v[0] ** 2 + v[1] ** 2 + v[2] ** 2) ** .5 or 1
        return v[0] / l, v[1] / l, v[2] / l

    out = []
    for t, sl in tris:
        ps = [to_car(p) for p, _ in t]
        if all(n is not None for _, n in t):
            ns = [to_car_n(n) for _, n in t]
        else:
            # no normals in the file: a flat face normal from the winding
            a, b, c = ps
            u = [b[i] - a[i] for i in range(3)]
            v = [c[i] - a[i] for i in range(3)]
            fn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2],
                  u[0] * v[1] - u[1] * v[0]]
            l = (fn[0] ** 2 + fn[1] ** 2 + fn[2] ** 2) ** .5 or 1
            ns = [[fn[0] / l, fn[1] / l, fn[2] / l]] * 3
        for p, n in zip(ps, ns):
            out.extend([p[0], p[1], p[2], n[0], n[1], n[2], float(sl)])

    w = sys.stdout.write
    w('"use strict";\n')
    w('/* GENERATED by tools/glb2car.py from %s -- do not edit by hand.\n'
      % os.path.basename(path))
    w('   Load this before js/carmesh.js and it is used instead of the mesh\n'
      '   built there. Seven floats per vertex: position, normal, material. */\n')
    w('const CAR_MODEL = new Float32Array([\n')
    for i in range(0, len(out), 7):
        w(','.join('%.4g' % v for v in out[i:i + 7]) + ',\n')
    w(']);\n')
    sys.stderr.write('  wrote %d vertices\n' % (len(out) // 7))


if __name__ == '__main__':
    main()
