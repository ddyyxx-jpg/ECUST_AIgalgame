/**
 * 地图寻路：在碰撞掩码上跑 A*。
 *
 * 网格来自 /map/campus-collision.png（600×450，每格 10 世界单位）：
 * 黑 = 建筑/水域（不可走），白 = 可走。
 * NPC 用它绕开建筑，而不是直线穿墙。
 */

export interface Grid {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

const CELL = 10; // 一格 = 10 世界单位

export function isWalkable(grid: Grid, wx: number, wy: number): boolean {
  const gx = Math.floor(wx / CELL);
  const gy = Math.floor(wy / CELL);
  if (gx < 0 || gy < 0 || gx >= grid.w || gy >= grid.h) return false;
  // 灰度图：R 通道 < 128 视为障碍
  return grid.data[(gy * grid.w + gx) * 4]! >= 128;
}

/** 把一个点吸附到最近的可走格中心（起终点落在建筑里时用） */
function snap(grid: Grid, wx: number, wy: number): Point | null {
  const cx = Math.round(wx / CELL);
  const cy = Math.round(wy / CELL);
  if (isWalkable(grid, cx * CELL, cy * CELL)) return { x: cx * CELL, y: cy * CELL };
  for (let r = 1; r <= 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (isWalkable(grid, nx * CELL, ny * CELL)) return { x: nx * CELL, y: ny * CELL };
      }
    }
  }
  return null;
}

/** A*；返回世界坐标路径（含起终点），找不到就返回 null */
export function findPath(grid: Grid, from: Point, to: Point): Point[] | null {
  const start = snap(grid, from.x, from.y);
  const goal = snap(grid, to.x, to.y);
  if (!start || !goal) return null;

  const sx = start.x / CELL;
  const sy = start.y / CELL;
  const gx = goal.x / CELL;
  const gy = goal.y / CELL;
  if (sx === gx && sy === gy) return [from, to];

  const W = grid.w;
  const H = grid.h;
  const size = W * H;
  const gScore = new Float32Array(size).fill(Infinity);
  const fScore = new Float32Array(size).fill(Infinity);
  const came = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);

  const idx = (x: number, y: number) => y * W + x;
  const h = (x: number, y: number) =>
    Math.hypot(x - gx, y - gy) + (Math.abs(x - gx) + Math.abs(y - gy)) * 0.001;

  // 简易二叉堆
  const heap: number[] = [];
  const push = (i: number) => {
    heap.push(i);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (fScore[heap[p]!]! <= fScore[heap[c]!]!) break;
      [heap[p], heap[c]] = [heap[c]!, heap[p]!];
      c = p;
    }
  };
  const pop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let p = 0;
      for (;;) {
        const l = p * 2 + 1;
        const r = l + 1;
        let m = p;
        if (l < heap.length && fScore[heap[l]!]! < fScore[heap[m]!]!) m = l;
        if (r < heap.length && fScore[heap[r]!]! < fScore[heap[m]!]!) m = r;
        if (m === p) break;
        [heap[p], heap[m]] = [heap[m]!, heap[p]!];
        p = m;
      }
    }
    return top;
  };

  const s = idx(sx, sy);
  gScore[s] = 0;
  fScore[s] = h(sx, sy);
  push(s);

  const DIRS = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ] as const;

  let guard = 0;
  while (heap.length && guard++ < 400000) {
    const cur = pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % W;
    const cy = (cur - cx) / W;
    if (cx === gx && cy === gy) {
      // 回溯
      const cells: number[] = [];
      let p = cur;
      while (p !== -1) {
        cells.push(p);
        p = came[p]!;
      }
      cells.reverse();
      const pts: Point[] = cells.map((c) => {
        const x = c % W;
        return { x: x * CELL, y: ((c - x) / W) * CELL };
      });
      pts[0] = { x: from.x, y: from.y };
      pts[pts.length - 1] = { x: to.x, y: to.y };
      return simplify(pts);
    }
    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (!isWalkable(grid, nx * CELL, ny * CELL)) continue;
      // 斜向不允许"切角"：两个正交邻居都得能走
      if (dx !== 0 && dy !== 0) {
        if (!isWalkable(grid, (cx + dx) * CELL, cy * CELL)) continue;
        if (!isWalkable(grid, cx * CELL, (cy + dy) * CELL)) continue;
      }
      const ni = idx(nx, ny);
      if (closed[ni]) continue;
      const ng = gScore[cur]! + cost;
      if (ng < gScore[ni]!) {
        gScore[ni] = ng;
        fScore[ni] = ng + h(nx, ny);
        came[ni] = cur;
        push(ni);
      }
    }
  }
  return null;
}

/** 去掉共线的中间点，减少动画段数 */
function simplify(pts: Point[]): Point[] {
  if (pts.length <= 2) return pts;
  const out: Point[] = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) > 1) out.push(b);
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

/** 路径总长 */
export function pathLength(pts: Point[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    d += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  }
  return d;
}
