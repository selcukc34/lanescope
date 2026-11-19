// Orthogonal routing of one flow between given ports, around the other nodes.
//
// The flow leaves its source perpendicular to the port's side and enters its
// target the same way (a short stub at each end). Between the two stubs a
// path is searched on a sparse grid made of the stub points and the edges of
// every node, grown by a margin (plus the midlines between them): A* over
// grid points, cost = length + a penalty per bend, so the result is short
// with few bends. No grid segment crosses a grown node, so the path never
// runs through a node. Pure: no DOM, no vscode.

import type { Bounds, PortLocation, PortSide } from '../model/model';

export interface Point {
  x: number;
  y: number;
}

/** Free space kept between a flow and the nodes it passes. */
export const ROUTE_MARGIN = 10;
/** Length of the straight piece at each end, out of the node's side. */
export const PORT_STUB = 20;
/** Extra cost of a bend, in diagram units. */
const BEND_PENALTY = 40;

const DIRECTIONS: Record<PortSide, Point> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

/** The point on a node's border a port names. */
export function portPoint(b: Bounds, port: PortLocation): Point {
  switch (port.side) {
    case 'top':
      return { x: b.x + b.width * port.offset, y: b.y };
    case 'bottom':
      return { x: b.x + b.width * port.offset, y: b.y + b.height };
    case 'left':
      return { x: b.x, y: b.y + b.height * port.offset };
    case 'right':
      return { x: b.x + b.width, y: b.y + b.height * port.offset };
  }
}

const OPPOSITE: Record<PortSide, PortSide> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/**
 * The port to use on `node`: `port`, unless its point lies inside another
 * node (a boundary event sits on its activity's border, and BAW may name the
 * side that faces into the activity). Then the opposite side, else another
 * side whose point is free.
 */
export function freePort(node: Bounds, port: PortLocation, others: Bounds[]): PortLocation {
  const inside = (p: PortLocation) => others.some((o) => o !== node && strictlyInside(portPoint(node, p), o));
  if (!inside(port)) return port;
  const sides: PortSide[] = [OPPOSITE[port.side], ...(['top', 'right', 'bottom', 'left'] as PortSide[])];
  for (const side of sides) {
    const candidate = { side, offset: 0.5 };
    if (!inside(candidate)) return candidate;
  }
  return port;
}

/** True when an axis-parallel segment runs through the inside of a box (touching its border does not count). */
export function segmentCrosses(a: Point, b: Point, box: Bounds): boolean {
  const left = box.x;
  const right = box.x + box.width;
  const top = box.y;
  const bottom = box.y + box.height;
  if (a.y === b.y) {
    const x1 = Math.min(a.x, b.x);
    const x2 = Math.max(a.x, b.x);
    return a.y > top && a.y < bottom && x2 > left && x1 < right;
  }
  if (a.x === b.x) {
    const y1 = Math.min(a.y, b.y);
    const y2 = Math.max(a.y, b.y);
    return a.x > left && a.x < right && y2 > top && y1 < bottom;
  }
  // Not axis-parallel: test the bounding box (conservative).
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  return x2 > left && x1 < right && y2 > top && y1 < bottom;
}

function grow(b: Bounds, by: number): Bounds {
  return { x: b.x - by, y: b.y - by, width: b.width + 2 * by, height: b.height + 2 * by };
}

function strictlyInside(p: Point, b: Bounds): boolean {
  return p.x > b.x && p.x < b.x + b.width && p.y > b.y && p.y < b.y + b.height;
}

/**
 * Work the router may still do, shared by every flow of one diagram. A unit
 * is one obstacle test; a search step costs as many units as there are
 * obstacles. The search grows with the square of the node count, so a
 * crafted diagram with thousands of nodes and flows could otherwise keep the
 * extension host busy for hours. Once spent, routeBetweenPorts returns
 * undefined and the caller falls back to a simple route.
 */
export interface RouteBudget {
  remaining: number;
}

/**
 * Units for one diagram: several times what a 300-node diagram with local
 * flows needs (about 150 million, well under a second), and small enough
 * that the worst case stays at a few seconds.
 */
export const DEFAULT_ROUTE_BUDGET = 1_000_000_000;

export function createRouteBudget(units = DEFAULT_ROUTE_BUDGET): RouteBudget {
  return { remaining: units };
}

/**
 * Routes a flow from `source` (leaving through `sourcePort`) to `target`
 * (entering through `targetPort`), around `obstacles` (every drawn node,
 * source and target included). Returns undefined when no path exists, or
 * when `budget` runs out (a fresh, unlimited one when not given).
 */
export function routeBetweenPorts(
  source: Bounds,
  sourcePort: PortLocation,
  target: Bounds,
  targetPort: PortLocation,
  obstacles: Bounds[],
  budget: RouteBudget = { remaining: Infinity },
): Point[] | undefined {
  if (budget.remaining <= 0) return undefined;
  const start = portPoint(source, sourcePort);
  const end = portPoint(target, targetPort);
  const others = obstacles.filter((o) => o !== source && o !== target);

  // Facing sides with an overlap: one straight line when nothing is between.
  const line = straightLine(source, sourcePort.side, target, targetPort.side, [start, end], others);
  if (line) return line;

  const outDir = DIRECTIONS[sourcePort.side];
  const inDir = DIRECTIONS[targetPort.side];
  // Facing sides close together: shorter stubs, so they do not pass each other.
  const gap = facingGap(source, sourcePort.side, target, targetPort.side);
  const stub = gap !== undefined ? Math.min(PORT_STUB, gap / 2) : PORT_STUB;
  const startStub = { x: start.x + outDir.x * stub, y: start.y + outDir.y * stub };
  const endStub = { x: end.x + inDir.x * stub, y: end.y + inDir.y * stub };

  // Nodes keep a free margin around them; where a stub ends inside that
  // margin (nodes close together), the margin shrinks down to the node itself.
  // Only a node a stub ends inside is left out.
  const blocks: Bounds[] = [];
  for (const b of obstacles) {
    const margin = MARGINS.find((m) => !strictlyInside(startStub, grow(b, m)) && !strictlyInside(endStub, grow(b, m)));
    if (margin !== undefined) blocks.push(grow(b, margin));
  }
  const blocked = (a: Point, b: Point) => blocks.some((box) => segmentCrosses(a, b, box));

  const path = search(startStub, endStub, outDir, inDir, blocks, blocked, budget);
  if (!path) return undefined;
  return simplify([start, ...path, end]);
}

/** Margins tried around a node, largest first; 0 is the node itself. */
const MARGINS = [ROUTE_MARGIN, 6, 3, 1, 0];

/**
 * Distance between two sides that face each other (source right and target
 * left with the target further right, and so on); undefined otherwise.
 */
function facingGap(source: Bounds, from: PortSide, target: Bounds, to: PortSide): number | undefined {
  if (from === 'right' && to === 'left') return positive(target.x - (source.x + source.width));
  if (from === 'left' && to === 'right') return positive(source.x - (target.x + target.width));
  if (from === 'bottom' && to === 'top') return positive(target.y - (source.y + source.height));
  if (from === 'top' && to === 'bottom') return positive(source.y - (target.y + target.height));
  return undefined;
}

function positive(n: number): number | undefined {
  return n > 0 ? n : undefined;
}

/**
 * A single straight segment between facing sides, at the height (or x) of
 * one of the port points when that lies on both sides, and when no other
 * node is in the way. Avoids small jogs between ports a few pixels apart.
 */
function straightLine(
  source: Bounds,
  from: PortSide,
  target: Bounds,
  to: PortSide,
  ports: [Point, Point],
  others: Bounds[],
): Point[] | undefined {
  if (facingGap(source, from, target, to) === undefined) return undefined;
  const horizontal = from === 'left' || from === 'right';
  const lo = horizontal ? Math.max(source.y, target.y) : Math.max(source.x, target.x);
  const hi = horizontal
    ? Math.min(source.y + source.height, target.y + target.height)
    : Math.min(source.x + source.width, target.x + target.width);
  // The target's port first: the flow arrives where BAW points it.
  for (const p of [ports[1], ports[0]]) {
    const at = horizontal ? p.y : p.x;
    if (at <= lo || at >= hi) continue;
    const a = horizontal ? { x: ports[0].x, y: at } : { x: at, y: ports[0].y };
    const b = horizontal ? { x: ports[1].x, y: at } : { x: at, y: ports[1].y };
    if (!others.some((o) => segmentCrosses(a, b, grow(o, 1)))) return [a, b];
  }
  return undefined;
}

interface State {
  xi: number;
  yi: number;
  /** Index into DIRS of the direction the path arrived with. */
  dir: number;
}

const DIRS: Point[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

function dirIndex(d: Point): number {
  return DIRS.findIndex((x) => x.x === d.x && x.y === d.y);
}

function search(
  from: Point,
  to: Point,
  outDir: Point,
  inDir: Point,
  blocks: Bounds[],
  blocked: (a: Point, b: Point) => boolean,
  budget: RouteBudget,
): Point[] | undefined {
  // Each step tests every block up to five times (free, then blocked per direction).
  const stepCost = Math.max(1, blocks.length) * 5;
  const xs = axis([from.x, to.x, ...blocks.flatMap((b) => [b.x, b.x + b.width])]);
  const ys = axis([from.y, to.y, ...blocks.flatMap((b) => [b.y, b.y + b.height])]);
  const xi0 = xs.indexOf(from.x);
  const yi0 = ys.indexOf(from.y);
  const xiEnd = xs.indexOf(to.x);
  const yiEnd = ys.indexOf(to.y);
  const free = (xi: number, yi: number) => !blocks.some((b) => strictlyInside({ x: xs[xi], y: ys[yi] }, b));

  // The flow enters the target against inDir (it moves from the stub towards the node).
  const finalDir = dirIndex({ x: -inDir.x, y: -inDir.y });
  const key = (s: State) => (s.yi * xs.length + s.xi) * 4 + s.dir;
  const startState: State = { xi: xi0, yi: yi0, dir: dirIndex(outDir) };
  const cost = new Map<number, number>([[key(startState), 0]]);
  const previous = new Map<number, State>();
  const open = new Heap<State>();
  open.push(startState, 0);
  const done = new Set<number>();

  while (open.size > 0) {
    const state = open.pop()!;
    const k = key(state);
    if (done.has(k)) continue;
    done.add(k);
    budget.remaining -= stepCost;
    if (budget.remaining < 0) return undefined;
    if (state.xi === xiEnd && state.yi === yiEnd) {
      const points: Point[] = [];
      let s: State | undefined = state;
      while (s) {
        points.push({ x: xs[s.xi], y: ys[s.yi] });
        s = previous.get(key(s));
      }
      return points.reverse();
    }
    const g = cost.get(k)!;
    for (let d = 0; d < 4; d++) {
      const xi = state.xi + DIRS[d].x;
      const yi = state.yi + DIRS[d].y;
      if (xi < 0 || yi < 0 || xi >= xs.length || yi >= ys.length) continue;
      // No turning back on the spot.
      if (DIRS[d].x === -DIRS[state.dir].x && DIRS[d].y === -DIRS[state.dir].y) continue;
      const a = { x: xs[state.xi], y: ys[state.yi] };
      const b = { x: xs[xi], y: ys[yi] };
      if (!free(xi, yi) || blocked(a, b)) continue;
      const atEnd = xi === xiEnd && yi === yiEnd;
      const bends = (d !== state.dir ? 1 : 0) + (atEnd && d !== finalDir ? 1 : 0);
      const next: State = { xi, yi, dir: d };
      const nk = key(next);
      const ng = g + Math.abs(b.x - a.x) + Math.abs(b.y - a.y) + bends * BEND_PENALTY;
      if (ng < (cost.get(nk) ?? Infinity)) {
        cost.set(nk, ng);
        previous.set(nk, state);
        open.push(next, ng + Math.abs(to.x - b.x) + Math.abs(to.y - b.y));
      }
    }
  }
  return undefined;
}

/** Binary min-heap by priority. */
class Heap<T> {
  private readonly items: Array<{ value: T; priority: number }> = [];

  get size(): number {
    return this.items.length;
  }

  push(value: T, priority: number): void {
    const items = this.items;
    items.push({ value, priority });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].priority <= items[i].priority) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop(): T | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0].value;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && items[l].priority < items[m].priority) m = l;
        if (r < items.length && items[r].priority < items[m].priority) m = r;
        if (m === i) break;
        [items[m], items[i]] = [items[i], items[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Sorted unique coordinates plus the midlines between neighbours (to pass through gaps). */
function axis(values: number[]): number[] {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    out.push(sorted[i]);
    if (i + 1 < sorted.length) out.push((sorted[i] + sorted[i + 1]) / 2);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Drops repeated points and the middle points of straight runs. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push(p);
  }
  return out.filter((p, i) => {
    if (i === 0 || i === out.length - 1) return true;
    const a = out[i - 1];
    const b = out[i + 1];
    return !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y));
  });
}
