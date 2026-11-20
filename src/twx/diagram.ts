// Diagram information that BPDs and services write the same way: node
// positions and sizes (extensionElements/nodeVisualInfo), flow ports
// (extensionElements/linkVisualInfo), and the mapping of BAW ids onto ids
// that are valid in XML. Shared by the BPD reader and the service reader.

import { XmlIdMap } from '../model/ids';
import type { Bounds, Flow, PortLocation, PortSide, Process } from '../model/model';
import { attr, child, childText, type XmlElement } from './xml';

/** extensionElements/nodeVisualInfo x, y, width, height of a flow node. */
export function nodeVisualInfo(el: XmlElement): Bounds | undefined {
  const info = child(child(el, 'extensionElements'), 'nodeVisualInfo');
  if (!info) return undefined;
  const b = {
    x: Number(attr(info, 'x')),
    y: Number(attr(info, 'y')),
    width: Number(attr(info, 'width')),
    height: Number(attr(info, 'height')),
  };
  return Object.values(b).every(Number.isFinite) ? b : undefined;
}

/** Sets sourcePort / targetPort of a flow from its extensionElements/linkVisualInfo. */
export function readLinkPorts(el: XmlElement, flow: Flow): void {
  const link = child(child(el, 'extensionElements'), 'linkVisualInfo');
  const sourcePort = portLocation(childText(link, 'sourcePortLocation'));
  const targetPort = portLocation(childText(link, 'targetPortLocation'));
  if (sourcePort) flow.sourcePort = sourcePort;
  if (targetPort) flow.targetPort = targetPort;
}

const PORT_SIDES: ReadonlyArray<[string, PortSide]> = [
  ['left', 'left'],
  ['right', 'right'],
  ['top', 'top'],
  ['bottom', 'bottom'],
];

/** Position along a side: start (top or left), center, end (bottom or right). */
const PORT_OFFSETS: Readonly<Record<string, number>> = {
  Top: 0.25,
  Left: 0.25,
  Center: 0.5,
  Bottom: 0.75,
  Right: 0.75,
};

/**
 * linkVisualInfo source/targetPortLocation: "<side><position>", seen as
 * leftCenter, rightCenter, topCenter, bottomCenter, leftTop and bottomLeft.
 * Undefined for any other value.
 */
export function portLocation(value: string | undefined): PortLocation | undefined {
  if (!value) return undefined;
  for (const [prefix, side] of PORT_SIDES) {
    if (!value.startsWith(prefix)) continue;
    const offset = PORT_OFFSETS[value.slice(prefix.length)];
    return offset === undefined ? undefined : { side, offset };
  }
  return undefined;
}

/**
 * BAW ids are not valid XML ids ("25.…" and "2025.…" start with a digit,
 * "bpdid:…" has colons); bpmn-moddle would drop the whole process. Every id
 * and every reference to one is mapped to a safe id; the BAW id stays in
 * `originalId`.
 */
export function withXmlIds(process: Process): Process {
  const ids = new XmlIdMap();
  const subLanes = process.nodes.flatMap((n) => n.lanes ?? []);
  ids.reserve([
    process.id,
    ...process.lanes.map((l) => l.id),
    ...subLanes.map((l) => l.id),
    ...process.nodes.map((n) => n.id),
    ...process.flows.map((f) => f.id),
  ]);
  const map = <T extends { id: string; originalId?: string }>(el: T): T => {
    const safe = ids.get(el.id);
    if (safe === el.id) return el;
    return { ...el, id: safe, originalId: el.id };
  };
  return {
    ...map(process),
    lanes: process.lanes.map((l) => ({ ...map(l), nodeIds: l.nodeIds.map((n) => ids.get(n)) })),
    nodes: process.nodes.map((n) => {
      const node = map(n);
      if (node.parentId !== undefined) node.parentId = ids.get(node.parentId);
      if (node.laneId !== undefined) node.laneId = ids.get(node.laneId);
      if (node.attachedToId !== undefined) node.attachedToId = ids.get(node.attachedToId);
      if (node.lanes) node.lanes = node.lanes.map((l) => ({ ...map(l), nodeIds: l.nodeIds.map((n) => ids.get(n)) }));
      return node;
    }),
    flows: process.flows.map((f) => ({ ...map(f), sourceId: ids.get(f.sourceId), targetId: ids.get(f.targetId) })),
  };
}
