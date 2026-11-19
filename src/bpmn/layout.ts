// Computes diagram coordinates for a Process that has none (Bob output has
// no bpmndi section). Lanes become horizontal bands of equal width, stacked
// top to bottom in document order; every node stays inside its lane band.
//
// Two ELK "layered" passes (direction RIGHT):
//   1. A free layout of the flow graph gives the left-to-right order of the
//      nodes and their vertical order.
//   2. Nodes are put into rows inside their lane band, and ELK runs again in
//      interactive mode, which keeps those positions (up to small shifts) and
//      routes the sequence flows orthogonally and places their labels.
// If pass 2 pushes a node out of its band, the positions from step 2 are kept
// and flows are routed with a simple orthogonal router instead.

import type { ElkEdgeSection, ElkExtendedEdge, ElkNode, ElkPort, LayoutOptions as ElkOptions } from 'elkjs/lib/elk-api';
import type { Bounds, Flow, FlowNode, FlowNodeKind, PortLocation, Process } from '../model/model';
import { ELK_TIMEOUT_MS, ElkLayoutError, runElkLayout } from './elkRunner';
import { createRouteBudget, freePort, routeBetweenPorts, type RouteBudget } from './orthogonalRouter';

export interface Point {
  x: number;
  y: number;
}

export interface LayoutOptions {
  /**
   * Leave out flow labels that only repeat the target ("To <target name>").
   * Labels of conditional and default flows are always shown. Default: true.
   */
  hideGeneratedFlowLabels?: boolean;
  /**
   * Leave out lanes that hold no drawn node, as BAW does when it imports a
   * process. Default: true.
   */
  hideEmptyLanes?: boolean;
  /** Longest one ELK pass may take, in milliseconds. Default: ELK_TIMEOUT_MS. */
  elkTimeoutMs?: number;
}

export interface LaneLayout {
  id: string;
  name: string;
  bounds: Bounds;
  /** True for the lane added to hold nodes that have no lane in the source. */
  synthetic: boolean;
}

export interface ProcessLayout {
  /** Bounds of the participant (pool) that holds the lanes. */
  pool: Bounds;
  /** Lanes in document order, top to bottom. Empty when the process has no lanes. */
  lanes: LaneLayout[];
  /** Bounds of every drawn flow node, keyed by node id. */
  shapes: Map<string, Bounds>;
  /** Bounds of the external labels of events and gateways, keyed by node id. */
  nodeLabels: Map<string, Bounds>;
  /** Waypoints of every drawn sequence flow, keyed by flow id. */
  edges: Map<string, Point[]>;
  /** Text of every flow label that is shown, keyed by flow id. */
  flowLabels: Map<string, string>;
  /** Bounds of every shown flow label, keyed by flow id. */
  edgeLabels: Map<string, Bounds>;
  /** Nodes that are not drawn (children of collapsed sub-processes). */
  hiddenNodeIds: Set<string>;
  /** Flows that are not drawn (touching hidden nodes or unknown nodes). */
  hiddenFlowIds: Set<string>;
  warnings: string[];
}

type Geometry = Omit<ProcessLayout, 'flowLabels' | 'hiddenNodeIds' | 'hiddenFlowIds' | 'warnings'>;

/** Id of the lane added for nodes without a lane. */
export const UNASSIGNED_LANE_ID = 'bobViewer_unassignedLane';

/**
 * Most nodes and flows one diagram may draw. Layout time grows with the
 * size; at these limits a diagram is still laid out in seconds. A larger one
 * (a crafted file can hold hundreds of thousands) is refused with a readable
 * message instead of keeping the extension host busy.
 */
export const MAX_DIAGRAM_NODES = 5_000;
export const MAX_DIAGRAM_FLOWS = 20_000;

/** Raised when a diagram is over MAX_DIAGRAM_NODES or MAX_DIAGRAM_FLOWS; the message is meant for users. */
export class DiagramTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiagramTooLargeError';
  }
}

export const TASK_SIZE = { width: 100, height: 80 };
export const EVENT_SIZE = { width: 36, height: 36 };
export const GATEWAY_SIZE = { width: 50, height: 50 };

/** Minimum width of the external label of an event or gateway. */
export const NODE_LABEL_MIN_WIDTH = 120;
/** Flow labels wrap at this width (unless a single word is wider). */
const EDGE_LABEL_WRAP = 150;
const LABEL_LINE_HEIGHT = 14;
/** Step between candidate flow label positions along a segment. */
const LABEL_STEP = 10;
/** Gap between a node and its external label. */
const NODE_LABEL_GAP = 5;

/** Width of the vertical label header of the pool (bpmn-js draws its name in this strip). */
export const POOL_HEADER = 30;
/** Width of the vertical label header of each lane (bpmn-js draws its name in this strip). */
export const LANE_HEADER = 30;
/** Free space between a lane's left edge (after its header) and the first node. */
const CONTENT_LEFT = 40;
const CONTENT_RIGHT = 40;
/** Vertical padding inside a lane, above the first and below the last row. */
const LANE_PADDING = 20;
/** Minimum distance between a lane border and the nodes (and labels) inside. */
const LANE_MARGIN = 10;
/** Height of one row of nodes inside a lane (room for a task, or an event plus its label). */
export const ROW_HEIGHT = 120;
/** Distance from the top of a row to the centre line of its nodes. */
const ROW_CENTER = 50;
/** Height of a lane band without nodes. */
export const EMPTY_LANE_HEIGHT = 100;
/**
 * Pool and lane names are drawn rotated in their 30px header strip with
 * 12px Arial; two lines fit in it, a third spills into the next strip. A
 * band is made at least this much taller than half the name's width, so that
 * the name wraps to two lines at most.
 */
const HEADER_NAME_PADDING = 20;
/** Minimum free space kept between a flow label and other labels. */
const LABEL_GAP = 6;
/** Minimum free space kept between a flow label and other flows. */
const LABEL_FLOW_GAP = 3;
/** Minimum horizontal gap between two nodes (and their labels) in the same row. */
const ROW_GAP = 20;
/** Horizontal distance between a node and an end event moved next to it. */
const NEXT_TO_GAP = 60;
/** Distance kept between flows and the pool border. */
const EDGE_MARGIN = 10;

const BASE_OPTIONS: ElkOptions = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
  'elk.spacing.nodeNode': '40',
  'elk.layered.spacing.nodeNodeBetweenLayers': '60',
  'elk.spacing.edgeNode': '20',
  'elk.layered.spacing.edgeNodeBetweenLayers': '20',
  'elk.spacing.edgeEdge': '12',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
  // Room between a flow and its label, and between labels, so that the labels
  // of a gateway's outgoing flows do not touch each other.
  'elk.spacing.edgeLabel': '6',
  'elk.spacing.labelNode': String(NODE_LABEL_GAP),
  'elk.spacing.labelLabel': String(LABEL_GAP),
  'elk.edgeLabels.inline': 'false',
};

const FREE_OPTIONS: ElkOptions = {
  ...BASE_OPTIONS,
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
};

const INTERACTIVE_OPTIONS: ElkOptions = {
  ...BASE_OPTIONS,
  'elk.layered.cycleBreaking.strategy': 'INTERACTIVE',
  'elk.layered.layering.strategy': 'INTERACTIVE',
  'elk.layered.crossingMinimization.strategy': 'INTERACTIVE',
  'elk.layered.nodePlacement.strategy': 'INTERACTIVE',
};

/** Default diagram size of a node kind. Sub-processes are drawn collapsed. */
export function nodeSize(kind: FlowNodeKind): { width: number; height: number } {
  if (isEvent(kind)) return { ...EVENT_SIZE };
  if (isGateway(kind)) return { ...GATEWAY_SIZE };
  return { ...TASK_SIZE };
}

function isEvent(kind: FlowNodeKind): boolean {
  return kind === 'startEvent' || kind === 'endEvent' || kind === 'intermediateEvent';
}

function isGateway(kind: FlowNodeKind): boolean {
  return kind === 'exclusiveGateway' || kind === 'parallelGateway' || kind === 'inclusiveGateway' || kind === 'eventBasedGateway';
}

/** True when the flow name only repeats its target: "To <target name>". */
export function isGeneratedFlowLabel(flow: Flow, targetName: string): boolean {
  const name = flow.name.trim().toLowerCase();
  return name.length > 0 && name === `to ${targetName.trim().toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Label sizes. bpmn-js draws external labels with 11px Arial; these are
// conservative estimates of that.

function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += ch === ' ' ? 3.5 : /[A-Z0-9_]/.test(ch) ? 7.5 : 6;
  return Math.ceil(w);
}

function wrapText(text: string, wrapAt: number): { lines: number; widest: number } {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  let lines = 0;
  let widest = 0;
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && textWidth(candidate) > wrapAt) {
      lines++;
      widest = Math.max(widest, textWidth(current));
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) {
    lines++;
    widest = Math.max(widest, textWidth(current));
  }
  return { lines, widest };
}

function nodeLabelSize(text: string): { width: number; height: number } {
  const longestWord = Math.max(0, ...text.split(/\s+/).map(textWidth));
  const width = Math.max(NODE_LABEL_MIN_WIDTH, longestWord + 4);
  return { width, height: wrapText(text, width - 4).lines * LABEL_LINE_HEIGHT + 4 };
}

function edgeLabelSize(text: string): { width: number; height: number } {
  const { lines, widest } = wrapText(text, EDGE_LABEL_WRAP);
  return { width: widest + 4, height: lines * LABEL_LINE_HEIGHT + 4 };
}

function hasExternalLabel(node: FlowNode): boolean {
  return node.name.trim().length > 0 && (isEvent(node.kind) || isGateway(node.kind));
}

/** External label of an event or gateway: centred below the shape. */
function nodeLabelBounds(node: FlowNode, shape: Bounds): Bounds {
  const size = nodeLabelSize(node.name);
  return {
    x: round(shape.x + shape.width / 2 - size.width / 2),
    y: round(shape.y + shape.height + NODE_LABEL_GAP),
    ...size,
  };
}

/** Height a pool or lane needs so its name wraps to two lines at most in its header strip. */
export function headerMinHeight(name: string): number {
  const trimmed = name.trim();
  if (!trimmed) return 0;
  // Header names are drawn with 12px Arial; textWidth estimates 11px.
  return Math.ceil((textWidth(trimmed) * 12) / 11 / 2) + HEADER_NAME_PADDING;
}

// ---------------------------------------------------------------------------

interface Band {
  /** Lane id, or undefined for the single band of a process without lanes. */
  id?: string;
  name: string;
  synthetic: boolean;
  nodes: FlowNode[];
  /** The lane's own bounds from the source (TWX), if any. */
  bounds?: Bounds;
}

interface Graph {
  /** Name drawn in the pool header (the process name, else its id). */
  poolName: string;
  nodes: FlowNode[];
  flows: Flow[];
  nodeById: Map<string, FlowNode>;
  sizes: Map<string, { width: number; height: number }>;
  /** Shown label text per flow id. */
  flowLabels: Map<string, string>;
}

/** Lays out a process. Never modifies the process. */
export async function layoutProcess(process: Process, options: LayoutOptions = {}): Promise<ProcessLayout> {
  const hideGenerated = options.hideGeneratedFlowLabels ?? true;
  const warnings: string[] = [];
  const nodeIds = new Set(process.nodes.map((n) => n.id));

  // Collapsed sub-processes: their children are not drawn.
  const hiddenNodeIds = new Set<string>();
  const parentOf = new Map(process.nodes.map((n) => [n.id, n.parentId]));
  for (const node of process.nodes) {
    if (node.parentId !== undefined) hiddenNodeIds.add(node.id);
  }
  const collapsed = new Map<string, number>();
  const topOf = new Map<string, string>();
  for (const id of hiddenNodeIds) {
    const top = topAncestor(id, parentOf, topOf);
    collapsed.set(top, (collapsed.get(top) ?? 0) + 1);
  }
  const nameOf = new Map(process.nodes.map((n) => [n.id, n.name]));
  for (const [id, count] of collapsed) {
    const name = nameOf.get(id) ?? id;
    warnings.push(`Sub-process "${name}" is drawn collapsed; its ${count} inner node(s) are not shown.`);
  }

  const nodes = process.nodes.filter((n) => !hiddenNodeIds.has(n.id));
  const diagramName = process.name || process.id;
  if (nodes.length > MAX_DIAGRAM_NODES) {
    throw new DiagramTooLargeError(
      `"${diagramName}" has ${nodes.length} nodes to draw; Lanescope draws diagrams of up to ${MAX_DIAGRAM_NODES} nodes.`,
    );
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const hiddenFlowIds = new Set<string>();
  const flows: Flow[] = [];
  for (const flow of process.flows) {
    if (!nodeIds.has(flow.sourceId) || !nodeIds.has(flow.targetId)) {
      hiddenFlowIds.add(flow.id);
      warnings.push(`Sequence flow "${flow.name || flow.id}" references an unknown node and is not drawn.`);
    } else if (hiddenNodeIds.has(flow.sourceId) || hiddenNodeIds.has(flow.targetId)) {
      hiddenFlowIds.add(flow.id);
    } else {
      flows.push(flow);
    }
  }

  if (flows.length > MAX_DIAGRAM_FLOWS) {
    throw new DiagramTooLargeError(
      `"${diagramName}" has ${flows.length} sequence flows to draw; Lanescope draws diagrams of up to ${MAX_DIAGRAM_FLOWS} flows.`,
    );
  }

  const flowLabels = new Map<string, string>();
  for (const flow of flows) {
    const name = flow.name.trim();
    if (!name) continue;
    const alwaysShown = flow.condition !== undefined || flow.isDefault;
    if (hideGenerated && !alwaysShown && isGeneratedFlowLabel(flow, nodeById.get(flow.targetId)!.name)) continue;
    flowLabels.set(flow.id, flow.name);
  }

  const graph: Graph = {
    poolName: process.name || process.id,
    nodes,
    flows,
    nodeById,
    sizes: new Map(nodes.map((n) => [n.id, nodeSize(n.kind)])),
    flowLabels,
  };
  const bands = buildBands(process, nodes, options.hideEmptyLanes ?? true, warnings);

  const withBounds = nodes.filter((n) => n.bounds !== undefined).length;
  let result: Geometry;
  if (nodes.length > 0 && withBounds === nodes.length) {
    result = layoutFromBounds(bands, graph, warnings);
  } else {
    if (withBounds > 0) {
      warnings.push(
        `Only ${withBounds} of ${nodes.length} nodes have diagram bounds; the whole diagram was laid out again.`,
      );
    }
    result = await layoutWithElk(bands, graph, warnings, options.elkTimeoutMs ?? ELK_TIMEOUT_MS);
  }
  return { ...result, flowLabels, hiddenNodeIds, hiddenFlowIds, warnings };
}

/** The outermost ancestor of a node; `memo` caches answers, so deep nesting stays linear. */
function topAncestor(id: string, parentOf: Map<string, string | undefined>, memo: Map<string, string>): string {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = id;
  let top: string | undefined;
  while (top === undefined) {
    const known = memo.get(current);
    if (known !== undefined) {
      top = known;
      break;
    }
    // A cycle of parents ends where it closes.
    if (seen.has(current)) {
      top = current;
      break;
    }
    seen.add(current);
    chain.push(current);
    const parent = parentOf.get(current);
    if (parent === undefined || !parentOf.has(parent)) top = current;
    else current = parent;
  }
  for (const c of chain) memo.set(c, top);
  return top;
}

function buildBands(process: Process, nodes: FlowNode[], hideEmpty: boolean, warnings: string[]): Band[] {
  if (process.lanes.length === 0) {
    return [{ name: '', synthetic: false, nodes }];
  }
  let bands: Band[] = process.lanes.map((l) => ({
    id: l.id,
    name: l.name,
    synthetic: false,
    nodes: [],
    ...(l.bounds ? { bounds: l.bounds } : {}),
  }));
  const byId = new Map(bands.map((b) => [b.id, b]));
  const orphans: FlowNode[] = [];
  for (const node of nodes) {
    const band = node.laneId !== undefined ? byId.get(node.laneId) : undefined;
    if (band) band.nodes.push(node);
    else orphans.push(node);
  }
  if (orphans.length > 0) {
    bands.push({ id: UNASSIGNED_LANE_ID, name: '(No lane)', synthetic: true, nodes: orphans });
    warnings.push(`${orphans.length} node(s) have no lane and are drawn in an extra lane "(No lane)".`);
  }
  if (hideEmpty) {
    bands = bands.filter((b) => b.nodes.length > 0);
    // Lanes but no drawn node at all: draw a plain pool.
    if (bands.length === 0) return [{ name: '', synthetic: false, nodes }];
  }
  return bands;
}

// ---------------------------------------------------------------------------
// ELK layout

async function layoutWithElk(bands: Band[], graph: Graph, warnings: string[], timeoutMs: number): Promise<Geometry> {
  const { nodes, flows, nodeById, sizes } = graph;

  // Pass 1: free layout for horizontal and in-layer order.
  const free = await runElk(elkGraph(graph, FREE_OPTIONS), graph, timeoutMs);
  const freePos = new Map((free.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));

  // Horizontal extent a node takes in its row, including its external label.
  const footprint = (node: FlowNode, x: number) => {
    const w = sizes.get(node.id)!.width;
    const half = Math.max(w, hasExternalLabel(node) ? nodeLabelSize(node.name).width : 0) / 2;
    return { left: x + w / 2 - half, right: x + w / 2 + half };
  };
  const clash = (a: { left: number; right: number }, b: { left: number; right: number }) =>
    a.right + ROW_GAP > b.left && b.right + ROW_GAP > a.left;

  // End events whose only incoming flow comes from another lane are placed
  // next to their source instead of where pass 1 put them, so that they do
  // not stack up in rows of their own.
  const bandOf = new Map<string, number>();
  bands.forEach((b, i) => b.nodes.forEach((n) => bandOf.set(n.id, i)));
  const incoming = new Map<string, Flow[]>();
  for (const f of flows) incoming.set(f.targetId, [...(incoming.get(f.targetId) ?? []), f]);
  const sourceOfMoved = new Map<string, FlowNode>();
  for (const node of nodes) {
    const ins = incoming.get(node.id) ?? [];
    if (node.kind === 'endEvent' && ins.length === 1 && bandOf.get(ins[0].sourceId) !== bandOf.get(node.id)) {
      sourceOfMoved.set(node.id, nodeById.get(ins[0].sourceId)!);
    }
  }

  // Rows inside each lane band, then the bands themselves.
  const planned = new Map<string, Bounds>();
  const laneBounds: Array<{ top: number; height: number }> = [];
  let top = 0;
  bands.forEach((band, bandIndex) => {
    const rows: Array<Array<{ left: number; right: number }>> = [];
    const rowOf = new Map<string, number>();
    const xOf = new Map<string, number>();

    const regular = band.nodes
      .filter((n) => !sourceOfMoved.has(n.id))
      .sort((a, b) => {
        const pa = freePos.get(a.id)!;
        const pb = freePos.get(b.id)!;
        return pa.y + sizes.get(a.id)!.height / 2 - (pb.y + sizes.get(b.id)!.height / 2) || pa.x - pb.x;
      });
    for (const node of regular) {
      const x = freePos.get(node.id)!.x;
      const fp = footprint(node, x);
      let row = rows.findIndex((r) => r.every((o) => !clash(fp, o)));
      if (row < 0) {
        row = rows.length;
        rows.push([]);
      }
      rows[row].push(fp);
      rowOf.set(node.id, row);
      xOf.set(node.id, x);
    }

    // Moved end events: the row nearest to the source's lane, right of the
    // source, sliding further right past anything already in that row.
    const moved = band.nodes
      .filter((n) => sourceOfMoved.has(n.id))
      .map((n) => ({ node: n, source: sourceOfMoved.get(n.id)! }))
      .sort(
        (a, b) =>
          Math.abs(bandOf.get(a.source.id)! - bandIndex) - Math.abs(bandOf.get(b.source.id)! - bandIndex) ||
          freePos.get(a.source.id)!.x - freePos.get(b.source.id)!.x,
      );
    for (const { node, source } of moved) {
      if (rows.length === 0) rows.push([]);
      const row = bandOf.get(source.id)! > bandIndex ? rows.length - 1 : 0;
      let x = freePos.get(source.id)!.x + sizes.get(source.id)!.width + NEXT_TO_GAP;
      for (;;) {
        const fp = footprint(node, x);
        const hit = rows[row].find((o) => clash(fp, o));
        if (!hit) break;
        x += hit.right + ROW_GAP - fp.left;
      }
      rows[row].push(footprint(node, x));
      rowOf.set(node.id, row);
      xOf.set(node.id, x);
    }

    const height = Math.max(
      rows.length === 0 ? EMPTY_LANE_HEIGHT : 2 * LANE_PADDING + rows.length * ROW_HEIGHT,
      band.id !== undefined ? headerMinHeight(band.name) : 0,
    );
    for (const node of band.nodes) {
      const size = sizes.get(node.id)!;
      const rowTop = top + LANE_PADDING + rowOf.get(node.id)! * ROW_HEIGHT;
      // All nodes of a row share one centre line, set high enough to leave
      // room for the labels below events and gateways.
      planned.set(node.id, { x: xOf.get(node.id)!, y: rowTop + ROW_CENTER - size.height / 2, ...size });
    }
    laneBounds.push({ top, height });
    top += height;
  });

  // Pass 2: route flows and place their labels with the planned positions.
  const fixed = await runElk(elkGraph(graph, INTERACTIVE_OPTIONS, planned), graph, timeoutMs);
  let shapes = new Map<string, Bounds>();
  let edges = new Map<string, Point[]>();
  let edgeLabels = new Map<string, Bounds>();
  for (const child of fixed.children ?? []) {
    shapes.set(child.id, { x: child.x ?? 0, y: child.y ?? 0, ...sizes.get(child.id)! });
  }
  for (const edge of fixed.edges ?? []) {
    edges.set(edge.id, edgePoints(edge));
    const label = edge.labels?.[0];
    if (label) {
      edgeLabels.set(edge.id, { x: label.x ?? 0, y: label.y ?? 0, width: label.width ?? 0, height: label.height ?? 0 });
    }
  }

  // ELK normalises coordinates; undo the vertical shift it applied (the most
  // common one). It may also have pushed some nodes down a little; the lane
  // bands then grow to hold them, as long as the lanes keep their order.
  const dy = mostCommon(nodes.map((n) => shapes.get(n.id)!.y - planned.get(n.id)!.y));
  shapes = mapBounds(shapes, 0, -dy);
  edges = mapPoints(edges, 0, -dy);
  edgeLabels = mapBounds(edgeLabels, 0, -dy);
  let bandBounds = fitBands(bands, laneBounds, shapes);
  if (!bandBounds) {
    warnings.push('Flow routing moved nodes out of their lanes; flows were routed with a simple router instead.');
    shapes = new Map(planned);
    edges = routeAll(flows, shapes, warnings);
    edgeLabels = new Map();
    bandBounds = laneBounds;
  }

  return frame(bands, bandBounds, graph, shapes, edges, edgeLabels, true);
}

/**
 * Lane bands around the final node positions: each band starts where the
 * previous one ends and is at least as tall as planned. Undefined when a
 * node (with its label) reaches above the top of its band.
 */
function fitBands(
  bands: Band[],
  planned: Array<{ top: number; height: number }>,
  shapes: Map<string, Bounds>,
): Array<{ top: number; height: number }> | undefined {
  const out: Array<{ top: number; height: number }> = [];
  let top = planned[0].top;
  for (let i = 0; i < bands.length; i++) {
    let bottom = Math.max(planned[i].top + planned[i].height, top + EMPTY_LANE_HEIGHT);
    for (const node of bands[i].nodes) {
      const b = shapes.get(node.id)!;
      const label = hasExternalLabel(node) ? nodeLabelBounds(node, b) : b;
      if (b.y < top + LANE_MARGIN) return undefined;
      bottom = Math.max(bottom, b.y + b.height + LANE_MARGIN, label.y + label.height + LANE_MARGIN);
    }
    out.push({ top, height: bottom - top });
    top = bottom;
  }
  return out;
}

/**
 * Runs one ELK pass in the layout worker (./elkRunner), which stops it after
 * `timeoutMs`. ELK's running time has no bound: a large, densely cyclic graph
 * can keep it busy for minutes or overflow its stack. Either is reported as a
 * readable DiagramTooLargeError.
 */
async function runElk(input: ElkNode, graph: Graph, timeoutMs: number): Promise<ElkNode> {
  try {
    return await runElkLayout(input, timeoutMs);
  } catch (err) {
    const size = `(${graph.nodes.length} nodes, ${graph.flows.length} flows)`;
    if (err instanceof ElkLayoutError && err.reason === 'timeout') {
      throw new DiagramTooLargeError(`"${graph.poolName}" ${size} could not be laid out within ${timeoutMs / 1000} seconds.`);
    }
    if (err instanceof ElkLayoutError && err.reason === 'stack') {
      throw new DiagramTooLargeError(`"${graph.poolName}" ${size} is too large or too densely connected to lay out.`);
    }
    throw err;
  }
}

function elkGraph(graph: Graph, layoutOptions: ElkOptions, positions?: Map<string, Bounds>): ElkNode {
  const outgoing = new Map<string, Flow[]>();
  for (const f of graph.flows) outgoing.set(f.sourceId, [...(outgoing.get(f.sourceId) ?? []), f]);
  const outPort = (f: Flow) =>
    (outgoing.get(f.sourceId)?.length ?? 0) > 1 ? `${f.sourceId}#out#${f.id}` : `${f.sourceId}#out`;

  const children: ElkNode[] = graph.nodes.map((n) => {
    const { width, height } = graph.sizes.get(n.id)!;
    const pos = positions?.get(n.id);
    const outs = outgoing.get(n.id) ?? [];
    let ports: ElkPort[];
    let portConstraints: string;
    if (outs.length > 1) {
      // One port per outgoing flow, so the flows do not share a trunk. With
      // planned positions, the ports are ordered top to bottom like their
      // targets (nearer targets first), so the flows do not cross each other
      // and ELK has no reason to push nodes around.
      const ordered = positions ? [...outs].sort((a, b) => targetKey(a, b, positions)) : outs;
      portConstraints = positions ? 'FIXED_ORDER' : 'FIXED_SIDE';
      ports = [
        { id: `${n.id}#in`, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'WEST', 'elk.port.index': '0' } },
        ...ordered.map((f, i) => ({
          id: outPort(f),
          width: 0,
          height: 0,
          // Port indices run clockwise, so east ports go top to bottom.
          layoutOptions: { 'elk.port.side': 'EAST', 'elk.port.index': String(i + 1) },
        })),
      ];
    } else {
      // In the middle of the west and east sides: BPMN style, and on the
      // tips of gateway diamonds.
      portConstraints = 'FIXED_POS';
      ports = [
        { id: `${n.id}#in`, x: 0, y: height / 2, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'WEST' } },
        { id: `${n.id}#out`, x: width, y: height / 2, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'EAST' } },
      ];
    }
    return {
      id: n.id,
      width,
      height,
      ...(pos ? { x: pos.x, y: pos.y } : {}),
      layoutOptions: { 'elk.portConstraints': portConstraints, 'elk.portAlignment.default': 'DISTRIBUTED' },
      ports,
      // External labels take part so that ELK keeps flows clear of them.
      labels: hasExternalLabel(n)
        ? [{ text: n.name, ...nodeLabelSize(n.name), layoutOptions: { 'elk.nodeLabels.placement': 'OUTSIDE V_BOTTOM H_CENTER' } }]
        : [],
    };
  });

  const edges: ElkExtendedEdge[] = graph.flows.map((f) => {
    const text = graph.flowLabels.get(f.id);
    const hint = positions ? detourHint(f, graph, positions) : undefined;
    return {
      id: f.id,
      sources: [outPort(f)],
      targets: [`${f.targetId}#in`],
      ...(hint ? { sections: [hint] } : {}),
      labels: text
        ? [{ id: `${f.id}#label`, text, ...edgeLabelSize(text), layoutOptions: { 'elk.edgeLabels.placement': 'TAIL' } }]
        : [],
    };
  });

  return { id: 'root', layoutOptions, children, edges };
}

/**
 * A forward flow that would run through nodes between its source and target
 * gets a route below them as a hint. In interactive mode ELK orders a long
 * flow among the nodes of each layer by its bend points; without them it may
 * put the flow above such a node and push the node down, out of its row.
 */
function detourHint(f: Flow, graph: Graph, positions: Map<string, Bounds>): ElkEdgeSection | undefined {
  const s = positions.get(f.sourceId)!;
  const t = positions.get(f.targetId)!;
  const sx = s.x + s.width;
  const tx = t.x;
  if (tx <= sx) return undefined;
  const sy = s.y + s.height / 2;
  const ty = t.y + t.height / 2;
  const lo = Math.min(sy, ty) - 10;
  const hi = Math.max(sy, ty) + 10;
  let bottom = -Infinity;
  for (const [id, b] of positions) {
    if (id === f.sourceId || id === f.targetId) continue;
    if (b.x < tx && b.x + b.width > sx && b.y < hi && b.y + b.height > lo) {
      const node = graph.nodeById.get(id)!;
      const label = hasExternalLabel(node) ? nodeLabelBounds(node, b) : b;
      bottom = Math.max(bottom, b.y + b.height, label.y + label.height);
    }
  }
  if (bottom === -Infinity) return undefined;
  const y = bottom + 20;
  return {
    id: `${f.id}#hint`,
    startPoint: { x: sx, y: sy },
    bendPoints: [
      { x: sx + 10, y: sy },
      { x: sx + 10, y },
      { x: tx - 10, y },
      { x: tx - 10, y: ty },
    ],
    endPoint: { x: tx, y: ty },
  };
}

function targetKey(a: Flow, b: Flow, positions: Map<string, Bounds>): number {
  const ta = positions.get(a.targetId)!;
  const tb = positions.get(b.targetId)!;
  return ta.y + ta.height / 2 - (tb.y + tb.height / 2) || ta.x - tb.x;
}

function edgePoints(edge: ElkExtendedEdge): Point[] {
  const points: Point[] = [];
  for (const s of edge.sections ?? []) {
    for (const p of [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]) {
      const last = points[points.length - 1];
      if (!last || last.x !== p.x || last.y !== p.y) points.push({ x: p.x, y: p.y });
    }
  }
  return points;
}

function mostCommon(values: number[]): number {
  const counts = new Map<number, number>();
  let best = values[0] ?? 0;
  for (const v of values) {
    const key = Math.round(v * 100) / 100;
    const c = (counts.get(key) ?? 0) + 1;
    counts.set(key, c);
    if (c > (counts.get(best) ?? 0)) best = key;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Layout that keeps existing bounds

function layoutFromBounds(bands: Band[], graph: Graph, warnings: string[]): Geometry {
  const shapes = new Map(graph.nodes.map((n) => [n.id, { ...n.bounds! }]));
  const edges = routeAll(graph.flows, shapes, warnings);

  // The source's own lane bands (TWX: the BAW lane heights), when they fit.
  const fromSource = sourceLaneBounds(bands, shapes);
  if (fromSource) return frame(bands, fromSource, graph, shapes, edges, new Map(), false);

  // Bands follow the nodes they hold, in document order.
  const laneBounds: Array<{ top: number; height: number }> = [];
  let cursor = Math.min(...[...shapes.values()].map((b) => b.y)) - LANE_PADDING;
  let overlap = false;
  for (const band of bands) {
    if (band.nodes.length === 0) {
      const height = Math.max(EMPTY_LANE_HEIGHT, headerMinHeight(band.name));
      laneBounds.push({ top: cursor, height });
      cursor += height;
      continue;
    }
    const minY = Math.min(...band.nodes.map((n) => shapes.get(n.id)!.y)) - LANE_PADDING;
    const maxY = Math.max(...band.nodes.map((n) => shapes.get(n.id)!.y + shapes.get(n.id)!.height)) + LANE_PADDING;
    if (minY < cursor) overlap = true;
    // Lanes touch: a lane starts where the one above ends, also when its nodes start lower.
    const laneTop = cursor;
    const height = Math.max(maxY - laneTop, EMPTY_LANE_HEIGHT);
    laneBounds.push({ top: laneTop, height });
    cursor = laneTop + height;
  }
  if (overlap) {
    warnings.push('Existing node bounds do not stack lanes top to bottom; some nodes may be drawn outside their lane.');
  }
  return frame(bands, laneBounds, graph, shapes, edges, new Map(), false);
}

// ---------------------------------------------------------------------------
// Simple orthogonal router (east side of the source to west side of the target)

/**
 * The lane bands the source gives, when every band has them, they touch top
 * to bottom (no hidden lane in between) and hold their nodes. Undefined otherwise.
 */
function sourceLaneBounds(
  bands: Band[],
  shapes: Map<string, Bounds>,
): Array<{ top: number; height: number }> | undefined {
  if (bands.some((b) => b.id === undefined || b.bounds === undefined)) return undefined;
  const out: Array<{ top: number; height: number }> = [];
  for (const band of bands) {
    const b = band.bounds!;
    const previous = out[out.length - 1];
    if (previous && previous.top + previous.height !== b.y) return undefined;
    for (const node of band.nodes) {
      const s = shapes.get(node.id)!;
      if (s.y < b.y || s.y + s.height > b.y + b.height) return undefined;
    }
    out.push({ top: b.y, height: b.height });
  }
  return out;
}

const DEFAULT_SOURCE_PORT: PortLocation = { side: 'right', offset: 0.5 };
const DEFAULT_TARGET_PORT: PortLocation = { side: 'left', offset: 0.5 };

/**
 * Routes every flow. Flows with ports from the source diagram are routed
 * around the nodes, within one RouteBudget for the whole diagram; when it
 * runs out, the remaining flows get the simple route and a warning says so.
 */
function routeAll(
  flows: Flow[],
  shapes: Map<string, Bounds>,
  warnings: string[],
  budget: RouteBudget = createRouteBudget(),
): Map<string, Point[]> {
  const edges = new Map<string, Point[]>();
  const obstacles = [...shapes.values()];
  let simplified = 0;
  for (const f of flows) {
    const s = shapes.get(f.sourceId)!;
    const t = shapes.get(f.targetId)!;
    // Ports from the source diagram (TWX): leave and enter through those sides, around the other nodes.
    const routed =
      f.sourcePort || f.targetPort
        ? routeBetweenPorts(
            s,
            freePort(s, f.sourcePort ?? DEFAULT_SOURCE_PORT, obstacles),
            t,
            freePort(t, f.targetPort ?? DEFAULT_TARGET_PORT, obstacles),
            obstacles,
            budget,
          )
        : undefined;
    if (!routed && budget.remaining <= 0 && (f.sourcePort || f.targetPort)) simplified++;
    edges.set(f.id, routed ?? route(s, t));
  }
  if (simplified > 0) {
    warnings.push(
      `The diagram is too large to route every flow around the nodes; ${simplified} flow(s) are drawn with simple routes.`,
    );
  }
  return edges;
}

function route(s: Bounds, t: Bounds): Point[] {
  const sy = s.y + s.height / 2;
  const ty = t.y + t.height / 2;
  const sRight = s.x + s.width;
  if (t.x >= sRight + 10) {
    const midX = (sRight + t.x) / 2;
    return dedupe([
      { x: sRight, y: sy },
      { x: midX, y: sy },
      { x: midX, y: ty },
      { x: t.x, y: ty },
    ]);
  }
  // Backwards or overlapping: leave to the east, pass below both, enter from the west.
  const below = Math.max(s.y + s.height, t.y + t.height) + 20;
  return [
    { x: sRight, y: sy },
    { x: sRight + 20, y: sy },
    { x: sRight + 20, y: below },
    { x: t.x - 20, y: below },
    { x: t.x - 20, y: ty },
    { x: t.x, y: ty },
  ];
}

function dedupe(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push(p);
  }
  // Drop middle points of straight runs.
  return out.filter((p, i) => {
    if (i === 0 || i === out.length - 1) return true;
    const a = out[i - 1];
    const b = out[i + 1];
    return !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y));
  });
}

// ---------------------------------------------------------------------------
// Pool and lanes around the content. With `normalize`, everything is moved so
// the pool starts at the origin; otherwise node coordinates stay as they are.

function frame(
  bands: Band[],
  laneBounds: Array<{ top: number; height: number }>,
  graph: Graph,
  shapes: Map<string, Bounds>,
  edges: Map<string, Point[]>,
  edgeLabels: Map<string, Bounds>,
  normalize: boolean,
): Geometry {
  const nodeLabels = new Map<string, Bounds>();
  for (const node of graph.nodes) {
    if (hasExternalLabel(node)) nodeLabels.set(node.id, nodeLabelBounds(node, shapes.get(node.id)!));
  }
  edgeLabels = placeEdgeLabels(graph, shapes, nodeLabels, edges, edgeLabels);

  const xs: number[] = [];
  const ys: number[] = [];
  for (const b of [...shapes.values(), ...nodeLabels.values(), ...edgeLabels.values()]) {
    xs.push(b.x, b.x + b.width);
    ys.push(b.y, b.y + b.height);
  }
  for (const pts of edges.values()) {
    for (const p of pts) {
      xs.push(p.x);
      ys.push(p.y);
    }
  }
  const minX = xs.length > 0 ? Math.min(...xs) : 0;
  const maxX = xs.length > 0 ? Math.max(...xs) : 0;

  // Let the first and last band grow when content reaches above or below them.
  const bandsTop = laneBounds[0].top;
  const last = laneBounds[laneBounds.length - 1];
  const minY = ys.length > 0 ? Math.min(...ys) : bandsTop;
  const maxY = ys.length > 0 ? Math.max(...ys) : last.top + last.height;
  if (minY < bandsTop + EDGE_MARGIN) {
    const grow = bandsTop + EDGE_MARGIN - minY;
    // In place: with a single band, `last` is the same band.
    laneBounds[0].top = bandsTop - grow;
    laneBounds[0].height += grow;
  }
  if (maxY > last.top + last.height - EDGE_MARGIN) {
    last.height = maxY - last.top + EDGE_MARGIN;
  }
  // A pool too short for its name: the last band grows (nothing moves).
  const poolMin = headerMinHeight(graph.poolName);
  const total = last.top + last.height - laneBounds[0].top;
  if (total < poolMin) last.height += poolMin - total;

  const poolTop = laneBounds[0].top;
  // Content starts right of the pool's header strip and the lanes' header strip.
  const contentLeft = POOL_HEADER + (bands[0].id !== undefined ? LANE_HEADER : 0) + CONTENT_LEFT;
  const poolLeft = minX - contentLeft;
  const dx = normalize ? -poolLeft : 0;
  const dy = normalize ? -poolTop : 0;
  const width = maxX - minX + contentLeft + CONTENT_RIGHT;
  const height = laneBounds.reduce((sum, l) => sum + l.height, 0);

  const lanes: LaneLayout[] = [];
  bands.forEach((band, i) => {
    if (band.id === undefined) return;
    lanes.push({
      id: band.id,
      name: band.name,
      synthetic: band.synthetic,
      bounds: {
        x: poolLeft + dx + POOL_HEADER,
        y: laneBounds[i].top + dy,
        width: width - POOL_HEADER,
        height: laneBounds[i].height,
      },
    });
  });

  return {
    pool: { x: poolLeft + dx, y: poolTop + dy, width, height },
    lanes,
    shapes: mapBounds(shapes, dx, dy),
    nodeLabels: mapBounds(nodeLabels, dx, dy),
    edges: mapPoints(edges, dx, dy),
    edgeLabels: mapBounds(edgeLabels, dx, dy),
  };
}

// ---------------------------------------------------------------------------
// Flow labels go near the start of their flow. Candidates are tried in order
// and the first one that is clear of nodes, node labels, other flow labels and
// other flows wins; a label never overlaps a node unless there is no other
// choice. The labels of a split (a node with several labelled outgoing flows,
// usually a gateway) try the middle of their flow's first vertical segment
// first, sliding along it when a sibling's label is there already: near the
// gateway the flows of a split run close together and their labels would
// crowd. Then ELK's own position (Bob output), then beside each of the first
// segments. Other labels keep a small gap (LABEL_GAP, LABEL_FLOW_GAP).

function placeEdgeLabels(
  graph: Graph,
  shapes: Map<string, Bounds>,
  nodeLabels: Map<string, Bounds>,
  edges: Map<string, Point[]>,
  preferred: Map<string, Bounds>,
): Map<string, Bounds> {
  const placed = new Map<string, Bounds>();
  const segments: Array<{ flowId: string; a: Point; b: Point }> = [];
  for (const [flowId, pts] of edges) {
    for (let i = 1; i < pts.length; i++) segments.push({ flowId, a: pts[i - 1], b: pts[i] });
  }
  const nodeBoxes = [...shapes.values()];
  const softBoxes = [...nodeLabels.values()];
  const labelled = new Map<string, Flow[]>();
  for (const flow of graph.flows) {
    if (!graph.flowLabels.get(flow.id)) continue;
    labelled.set(flow.sourceId, [...(labelled.get(flow.sourceId) ?? []), flow]);
  }

  for (const flow of graph.flows) {
    const text = graph.flowLabels.get(flow.id);
    if (!text) continue;
    const size = edgeLabelSize(text);
    const points = edges.get(flow.id)!;
    const siblings = (labelled.get(flow.sourceId) ?? []).filter((f) => f.id !== flow.id);
    const candidates = [
      ...(siblings.length > 0 ? splitLabelCandidates(points, siblings.map((f) => edges.get(f.id)!), size) : []),
      ...(preferred.has(flow.id) ? [preferred.get(flow.id)!] : []),
      ...labelCandidates(points, size),
    ];

    let best: Bounds | undefined;
    let bestScore = Infinity;
    for (const c of candidates) {
      const roomy = grow(c, LABEL_GAP);
      const near = grow(c, LABEL_FLOW_GAP);
      const hard = nodeBoxes.filter((b) => boxesOverlap(c, b)).length;
      const soft =
        softBoxes.filter((b) => boxesOverlap(c, b)).length +
        [...placed.values()].filter((b) => boxesOverlap(roomy, b)).length +
        segments.filter((sg) => sg.flowId !== flow.id && segmentHitsBox(sg.a, sg.b, near)).length;
      const score = hard * 1000 + soft;
      if (score < bestScore) {
        best = c;
        bestScore = score;
        if (score === 0) break;
      }
    }
    placed.set(flow.id, roundBounds(best!));
  }
  return placed;
}

/**
 * Positions beside the middle of the first vertical segment of a flow that
 * leaves a split: right of it, then left, starting in the middle of the part
 * the flow does not share with its siblings and sliding away from there.
 * Empty when the flow has no vertical segment long enough for the label.
 */
function splitLabelCandidates(points: Point[], siblings: Point[][], size: { width: number; height: number }): Bounds[] {
  const { width: w, height: h } = size;
  for (let i = 1; i < Math.min(points.length, 4); i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a.x !== b.x || Math.abs(b.y - a.y) < h + 8) continue;
    const own = ownRange(a.x, Math.min(a.y, b.y), Math.max(a.y, b.y), siblings);
    const [lo, hi] = own && own[1] - own[0] >= h + 8 ? own : [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    const first = lo + 4;
    const last = hi - 4 - h;
    const mid = Math.max(first, Math.min(last, (lo + hi) / 2 - h / 2));
    const out: Bounds[] = [];
    for (let k = 0; ; k++) {
      const offsets = k === 0 ? [0] : [k * LABEL_STEP, -k * LABEL_STEP];
      const ys = offsets.map((d) => mid + d).filter((y) => y >= first && y <= last);
      if (ys.length === 0) break;
      for (const y of ys) out.push({ x: a.x + 4, y, ...size }, { x: a.x - 4 - w, y, ...size });
    }
    return out;
  }
  return [];
}

/**
 * The longest part of the vertical run x, lo..hi that no sibling flow runs
 * along (shares x with). Undefined when siblings cover all of it.
 */
function ownRange(x: number, lo: number, hi: number, siblings: Point[][]): [number, number] | undefined {
  const covered: Array<[number, number]> = [];
  for (const pts of siblings) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (a.x !== b.x || Math.abs(a.x - x) > 0.5) continue;
      covered.push([Math.min(a.y, b.y), Math.max(a.y, b.y)]);
    }
  }
  covered.sort((p, q) => p[0] - q[0]);
  let best: [number, number] | undefined;
  let cursor = lo;
  const consider = (from: number, to: number) => {
    if (to > from && (!best || to - from > best[1] - best[0])) best = [from, to];
  };
  for (const [from, to] of covered) {
    if (to <= cursor) continue;
    if (from >= hi) break;
    consider(cursor, Math.min(from, hi));
    cursor = Math.max(cursor, to);
  }
  consider(cursor, hi);
  return best;
}

function grow(b: Bounds, by: number): Bounds {
  return { x: b.x - by, y: b.y - by, width: b.width + 2 * by, height: b.height + 2 * by };
}

/** Positions beside the first segments of a flow, nearest to the source first. */
function labelCandidates(points: Point[], size: { width: number; height: number }): Bounds[] {
  const { width: w, height: h } = size;
  const out: Bounds[] = [];
  for (let i = 1; i < Math.min(points.length, 4); i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a.y === b.y) {
      // Above, then below the segment, sliding from its start towards its end.
      const dir = b.x >= a.x ? 1 : -1;
      const first = dir > 0 ? a.x + 4 : a.x - 4 - w;
      const span = Math.max(0, Math.abs(b.x - a.x) - 8 - w);
      for (let d = 0; d <= span; d += LABEL_STEP) {
        const x = first + dir * d;
        out.push({ x, y: a.y - h - 2, ...size }, { x, y: a.y + 2, ...size });
      }
    } else {
      // Right, then left of the segment, sliding along it.
      const dir = b.y >= a.y ? 1 : -1;
      const first = dir > 0 ? a.y + 4 : a.y - 4 - h;
      const span = Math.max(0, Math.abs(b.y - a.y) - 8 - h);
      for (let d = 0; d <= span; d += LABEL_STEP) {
        const y = first + dir * d;
        out.push({ x: a.x + 4, y, ...size }, { x: a.x - 4 - w, y, ...size });
      }
    }
  }
  return out;
}

function boxesOverlap(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function segmentHitsBox(a: Point, b: Point, box: Bounds): boolean {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  return minX < box.x + box.width && maxX > box.x && minY < box.y + box.height && maxY > box.y;
}

function roundBounds(b: Bounds): Bounds {
  return { x: round(b.x), y: round(b.y), width: b.width, height: b.height };
}

function mapBounds(shapes: Map<string, Bounds>, dx: number, dy: number): Map<string, Bounds> {
  return new Map([...shapes].map(([id, b]) => [id, { ...b, x: round(b.x + dx), y: round(b.y + dy) }]));
}

function mapPoints(edges: Map<string, Point[]>, dx: number, dy: number): Map<string, Point[]> {
  return new Map([...edges].map(([id, pts]) => [id, pts.map((p) => ({ x: round(p.x + dx), y: round(p.y + dy) }))]));
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
