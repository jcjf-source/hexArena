// Hex grid helpers. The arena is 7 columns x 8 rows using "odd-r" offset
// coordinates (odd rows are shifted half a hex to the right).
// Rows 0-3 belong to the enemy (top), rows 4-7 to the player (bottom).

export const COLS = 7;
export const ROWS = 8;

export const cellKey = (col, row) => row * COLS + col;

function toCube(col, row) {
  const q = col - (row - (row & 1)) / 2;
  return { q, r: row, s: -q - row };
}

export function hexDist(c1, r1, c2, r2) {
  const a = toCube(c1, r1);
  const b = toCube(c2, r2);
  return Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.s - b.s));
}

const EVEN_DIRS = [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]];
const ODD_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]];

export function neighbors(col, row) {
  const dirs = row & 1 ? ODD_DIRS : EVEN_DIRS;
  const out = [];
  for (const [dc, dr] of dirs) {
    const c = col + dc;
    const r = row + dr;
    if (c >= 0 && c < COLS && r >= 0 && r < ROWS) out.push([c, r]);
  }
  return out;
}
