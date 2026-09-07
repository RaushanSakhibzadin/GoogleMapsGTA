/* THE LATTICE THE CITY IS RASTERISED ONTO — square or hexagonal.
 *
 * Both are addressed by integer cell coordinates (a, b) plus a level, and both
 * answer the same three questions: where is a cell's centre, which cell holds a
 * point, and who are a cell's neighbours. Everything upstream and downstream
 * works in those terms, so the choice is one line in config.mjs.
 *
 * WHY THE HEX IS EXPENSIVE, measured rather than assumed. Greedy meshing merges
 * runs of identical cells, and on a square lattice it merges in all three
 * directions — that is where the 10.4x reduction comes from. Hexagons do not
 * tile into larger hexagons and do not tile into boxes, so the only merge left
 * is VERTICAL: a column of the same colour becomes one taller prism. Measured
 * on this district that is 2.8x on buildings and exactly 1.0x on the ground,
 * which is a single layer and therefore cannot merge at all.
 *
 *     same cell size, cubes    73,354 parts
 *     same cell size, hexes   513,615 parts
 *
 * So a hex lattice has to be COARSER than a square one to cost the same, and
 * that is the real trade — not whether it is possible.
 *
 * POINTY-TOP HEXES in axial coordinates, which is the standard formulation:
 * columns run north-south, rows are offset by half a width. R is the
 * circumradius (centre to corner), so the flat-to-flat width is sqrt(3)*R and
 * the corner-to-corner height is 2R.
 */

const SQRT3 = Math.sqrt(3);

/* ------------------------------- square ------------------------------- */

function squareLattice(V) {
  return {
    kind: 'square',
    /* The horizontal footprint of one cell, for reporting and for choosing a
       comparable hex size. */
    area: V * V,
    size: V,
    centre: (a, b) => [(a + 0.5) * V, (b + 0.5) * V],
    cellOf: (x, y) => [Math.floor(x / V), Math.floor(y / V)],
    /* Four-neighbourhood. Diagonals are deliberately not counted: a cell
       touching outside only at a corner has no exposed face, and including
       them fattens every diagonal wall to two cells thick. */
    neighbours: (a, b) => [[a - 1, b], [a + 1, b], [a, b - 1], [a, b + 1]],
    /* How far apart two cell centres are at most, used to size the search when
       stamping a road of a given width onto the lattice. */
    reach: V
  };
}

/* -------------------------------- hex --------------------------------- */

function hexLattice(R) {
  const W = SQRT3 * R;          // flat to flat
  const centre = (q, r) => [W * (q + r / 2), R * 1.5 * r];

  /* Point to hex: the inverse of the above, then cube-rounded. Rounding in
     axial coordinates directly gives the wrong cell near every edge — the
     standard fix is to go via cube coordinates, round all three, and correct
     whichever moved furthest so they still sum to zero. */
  function cellOf(x, y) {
    const q = (SQRT3 / 3 * x - y / 3) / R;
    const r = (2 / 3 * y) / R;
    let cx = q, cz = r, cy = -cx - cz;
    let rx = Math.round(cx), ry = Math.round(cy), rz = Math.round(cz);
    const dx = Math.abs(rx - cx), dy = Math.abs(ry - cy), dz = Math.abs(rz - cz);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy > dz) ry = -rx - rz;
    else rz = -rx - ry;
    return [rx, rz];
  }

  return {
    kind: 'hex',
    area: 1.5 * SQRT3 * R * R,
    size: R,
    width: W,
    centre,
    cellOf,
    // six neighbours in axial coordinates
    neighbours: (q, r) => [[q + 1, r], [q - 1, r], [q, r + 1],
                           [q, r - 1], [q + 1, r - 1], [q - 1, r + 1]],
    reach: 2 * R
  };
}

/* --------------------------------------------------------------------- */

export function makeLattice(cfg) {
  return cfg.lattice === 'hex' ? hexLattice(cfg.hexR) : squareLattice(cfg.voxel);
}

/* THE HEX RADIUS THAT COSTS WHAT A GIVEN SQUARE CELL COSTS, by area. Not the
   whole story — the merge behaviour differs, which is the point of the note at
   the top — but it is the right starting point for choosing one, and it is the
   number you want when someone asks "how much coarser does the hex have to be".
   Equal area: 1.5*sqrt(3)*R^2 = V^2. */
export const hexRForArea = V => V / Math.sqrt(1.5 * SQRT3);
