// Maps one BPD object of a TWX export (objects/25.*.xml) onto a Process of
// the shared model. Verified on BAW 8.6.6 exports.
//
// A BPD object carries two models of the same diagram, with the same flow
// object ids:
//   - <bpmn2Data>: the BPMN2 model as escaped XML. The primary source for
//     nodes, flows, names, conditions and documentation.
//   - <BusinessProcessDiagram>: the classic model, pool > lane > flowObject.
//     Read for the lanes and the positions: flowObject/position/location x,y
//     relative to its lane, whose heights are <height>; absolute y = heights
//     of the lanes above + y. It leaves out lanes without flow objects, which
//     BAW still draws; those come from the BPMN2 laneSet (empty, with their
//     nodeVisualInfo height), in laneSet order.
// Sizes come from the BPMN2 extensionElements/nodeVisualInfo. A boundary
// event (classic attachedEvent, location 0,0) takes x,y from nodeVisualInfo,
// relative to the lane of its activity. When a node has no position, the
// layout lays out the whole diagram again.
//
// Activity details (scripts, call mappings and parameters are read by
// ./activities, shared with the service reader):
//   user task         callActivity/extensionElements/userTaskSettings
//   timer             timerEventDefinition/extensionElements/timerEventSettings;
//                     boundaryEvent@cancelActivity, @parallelMultiple
//   variables         process/dataObject; defaults and tracking from the classic
//                     pool/privateVariable and pool/trackedField
//   process I/O       process/ioSpecification dataInput/dataOutput
// Shapes not seen in a real export are not guessed at: they are reported as
// warnings and left out.

import { nodeSize } from '../bpmn/layout';
import type {
  Bounds,
  Flow,
  FlowNode,
  FlowNodeKind,
  Lane,
  Process,
  ProcessVariable,
  TimerSettings,
  UserTaskSettings,
} from '../model/model';
import { dataObjectVariable, ioParameters, NON_FLOW_ELEMENTS, parametersOf, readCallMappings, readScript } from './activities';
import { nodeVisualInfo, readLinkPorts, withXmlIds } from './diagram';
import type { TwxResolver } from './resolver';
import { docText } from './text';
import { attr, child, childText, children, descendants, first, parseXml, textContent, type XmlElement } from './xml';

export { portLocation } from './diagram';

export type BpdReadResult =
  | { kind: 'process'; process: Process; warnings: string[] }
  /** An embedded (event) subprocess saved as an object of its own: its nodes are part of its parent BPD. */
  | { kind: 'embedded'; parentId: string }
  | { kind: 'skipped'; warning: string };

const EVENTS: Readonly<Record<string, FlowNodeKind>> = {
  startEvent: 'startEvent',
  endEvent: 'endEvent',
  intermediateCatchEvent: 'intermediateEvent',
  intermediateThrowEvent: 'intermediateEvent',
  boundaryEvent: 'intermediateEvent',
};

const GATEWAYS: Readonly<Record<string, FlowNodeKind>> = {
  exclusiveGateway: 'exclusiveGateway',
  parallelGateway: 'parallelGateway',
  inclusiveGateway: 'inclusiveGateway',
  eventBasedGateway: 'eventBasedGateway',
};

/** BPMN2 task elements other than callActivity. */
const TASKS: Readonly<Record<string, FlowNodeKind>> = {
  scriptTask: 'scriptTask',
  userTask: 'userTask',
  serviceTask: 'serviceTask',
  sendTask: 'serviceTask',
  receiveTask: 'serviceTask',
  businessRuleTask: 'task',
  task: 'task',
  manualTask: 'task',
};

const SUB_PROCESSES = new Set(['subProcess', 'adHocSubProcess', 'transaction']);

/**
 * callActivity extensionElements/activityType values.
 * A BAW system task is drawn as a task with a service type, as Bob writes it
 * (bpmn:Task with icp:serviceType), so both inputs give the same diagram.
 */
const ACTIVITY_TYPES: Readonly<Record<string, FlowNodeKind>> = {
  UserTask: 'userTask',
  InlineUserTask: 'userTask',
  ServiceTask: 'task',
  SystemTask: 'task',
  ScriptTask: 'task',
  RuleTask: 'task',
  DecisionTask: 'task',
  CalledProcess: 'callActivity',
};

/** icp:serviceType of a system task, by the processType of the service it calls. */
const SERVICE_TYPES: Readonly<Record<string, string>> = {
  '12': 'ServiceFlow',
};

/**
 * Reads one BPD object file. Throws only on XML that is not well formed.
 * @param objectXml the XML of another object of the export by id, for the
 *   diagrams of the BPD's sub-processes; without it their nodes have no bounds.
 */
export function readBpd(objectXml: string, resolver: TwxResolver, otherObject?: (id: string) => string | undefined): BpdReadResult {
  const root = parseXml(objectXml);
  const bpd = child(root, 'bpd') ?? first(root, 'bpd');
  if (!bpd) return { kind: 'skipped', warning: 'An object file under objects/25.* holds no <bpd> element.' };
  const id = attr(bpd, 'id') ?? childText(bpd, 'bpdId') ?? '';
  const name = attr(bpd, 'name') ?? id;
  const label = `BPD "${name}"`;

  const data = childText(bpd, 'bpmn2Data');
  if (!data) {
    const parentId = childText(bpd, 'parentBpdId');
    if (parentId) return { kind: 'embedded', parentId };
    return { kind: 'skipped', warning: `${label} has no BPMN2 model in the export and is not shown.` };
  }

  let definitions: XmlElement;
  try {
    definitions = parseXml(data);
  } catch {
    // Parser messages can quote the model: never pass them on.
    return { kind: 'skipped', warning: `The BPMN2 model of ${label} could not be parsed; it is not shown.` };
  }
  const bpmnProcess = first(definitions, 'process');
  if (!bpmnProcess) {
    return { kind: 'skipped', warning: `${label} has no BPMN2 process in the export and is not shown.` };
  }

  const warnings: string[] = [];
  const nodes: FlowNode[] = [];
  const flows: Flow[] = [];
  const defaults = new Map<string, string>();
  const visual = new Map<string, Bounds>();
  const assignedByLane = new Set<string>();
  walk(bpmnProcess, undefined, { nodes, flows, defaults, visual, assignedByLane, resolver, warnings, label });

  // A default flow is a gateway setting; BAW also writes `default` on activities and events.
  const kindById = new Map(nodes.map((n) => [n.id, n.kind]));
  for (const flow of flows) {
    const kind = kindById.get(flow.sourceId);
    flow.isDefault = kind !== undefined && kind.endsWith('Gateway') && defaults.get(flow.sourceId) === flow.id;
  }

  const classic = readClassic(bpd, bpmnProcess);
  const lanes = classic.lanes.length > 0 ? classic.lanes.map((l) => l.lane) : bpmnLanes(bpmnProcess);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const lane of lanes) {
    for (const nodeId of lane.nodeIds) {
      const node = nodeById.get(nodeId);
      if (node && node.parentId === undefined) node.laneId = lane.id;
    }
  }
  for (const node of nodes) {
    if (node.laneId !== undefined && assignedByLane.has(node.id)) {
      const lane = lanes.find((l) => l.id === node.laneId);
      if (lane?.name) node.performer = lane.name;
    }
  }

  placeNodes(nodes, classic, visual);
  if (otherObject) placeSubProcessNodes(nodes, visual, otherObject);

  const documentation =
    docText(children(bpmnProcess, 'documentation').map(textContent).join('\n\n')) ??
    docText(childText(bpd, 'description')) ??
    '';

  const process: Process = { id, name, documentation, source: { kind: 'bpd' }, lanes, nodes, flows };
  const variables = readVariables(bpmnProcess, bpd, resolver);
  if (variables.length > 0) process.variables = variables;
  const { inputs, outputs } = ioParameters(bpmnProcess, resolver);
  if (inputs.length > 0) process.inputs = inputs;
  if (outputs.length > 0) process.outputs = outputs;

  return { kind: 'process', process: withXmlIds(process), warnings };
}

// ---------------------------------------------------------------------------
// BPMN2 model

interface WalkContext {
  nodes: FlowNode[];
  flows: Flow[];
  /** `default` attribute by node id. */
  defaults: Map<string, string>;
  /** nodeVisualInfo by node id (relative to the lane). */
  visual: Map<string, Bounds>;
  /** User tasks that BAW assigns to the users of their lane. */
  assignedByLane: Set<string>;
  resolver: TwxResolver;
  warnings: string[];
  label: string;
}

function walk(container: XmlElement, parentId: string | undefined, ctx: WalkContext): void {
  for (const el of container.children) {
    const id = attr(el, 'id');
    if (el.name === 'sequenceFlow') {
      const condition = children(el, 'conditionExpression').map(textContent).join('').trim();
      const flow: Flow = {
        id: id ?? '',
        name: attr(el, 'name') ?? '',
        sourceId: attr(el, 'sourceRef') ?? '',
        targetId: attr(el, 'targetRef') ?? '',
        isDefault: false,
      };
      if (condition) flow.condition = condition;
      readLinkPorts(el, flow);
      ctx.flows.push(flow);
      continue;
    }
    if (NON_FLOW_ELEMENTS.has(el.name)) continue;
    if (!id) continue;

    const node = mapNode(el, ctx);
    if (parentId !== undefined) node.parentId = parentId;
    ctx.nodes.push(node);

    const def = attr(el, 'default');
    if (def) ctx.defaults.set(id, def);
    const vis = nodeVisualInfo(el);
    if (vis) ctx.visual.set(id, vis);
    if (node.kind === 'unknown') {
      ctx.warnings.push(`${ctx.label}: unsupported element <${el.name}> "${node.name || id}" read as kind "unknown".`);
    }
    if (SUB_PROCESSES.has(el.name)) walk(el, id, ctx);
  }
}

function mapNode(el: XmlElement, ctx: WalkContext): FlowNode {
  const node: FlowNode = {
    id: attr(el, 'id') ?? '',
    // Names are kept as written, trailing spaces included.
    name: el.attrs.name ?? '',
    kind: 'unknown',
    originalType: el.name,
    inputs: [],
    outputs: [],
  };
  const doc = docText(children(el, 'documentation').map(textContent).join('\n\n'));
  if (doc) node.documentation = doc;

  const kind = EVENTS[el.name] ?? GATEWAYS[el.name] ?? TASKS[el.name];
  if (kind) {
    node.kind = kind;
    if (el.name === 'scriptTask') {
      const script = readScript(el);
      if (script) node.script = script;
    }
    if (EVENTS[el.name]) {
      const timer = readTimer(el, `${ctx.label}: timer "${node.name || node.id}"`, ctx.warnings);
      if (timer) node.timer = timer;
    }
  } else if (SUB_PROCESSES.has(el.name)) {
    node.kind = 'subProcess';
    if (attr(el, 'triggeredByEvent') === 'true') {
      node.originalType = 'subProcess (event)';
      node.triggeredByEvent = true;
    }
  } else if (el.name === 'callActivity') {
    mapCallActivity(el, node, ctx);
  }
  return node;
}

function mapCallActivity(el: XmlElement, node: FlowNode, ctx: WalkContext): void {
  const extensions = child(el, 'extensionElements');
  const activityType = childText(extensions, 'activityType') ?? '';
  const calledRef = attr(el, 'calledElement');
  const calledId = calledRef ? calledRef.replace(/^\//, '').trim() : undefined;

  // An unknown activity type is still a call: of a linked process (25.…) or a service.
  node.kind = ACTIVITY_TYPES[activityType] ?? 'callActivity';
  node.originalType = activityType ? `callActivity (${activityType})` : 'callActivity';

  const settings = child(extensions, 'userTaskSettings');
  const label = `${ctx.label}: "${node.name || node.id}"`;
  if (node.kind === 'userTask') {
    if (childText(settings, 'activityAssignmentType') === 'Lane') ctx.assignedByLane.add(node.id);
    const userTask = settings ? readUserTask(settings, label, ctx.warnings) : undefined;
    if (userTask) node.userTask = userTask;
  }

  const callee = calledId ? ctx.resolver.callee(calledId) : undefined;
  if (calledId) {
    node.calledElement = { id: calledId };
    // Toolkit services (System Data, …) are not among the app's objects: no name, no signature.
    if (callee) {
      node.calledElement.name = callee.name;
      node.calledElement.kind = callee.generated ? `${callee.kind}, generated` : callee.kind;
      if (node.kind === 'task' && (activityType === 'ServiceTask' || activityType === 'SystemTask')) {
        const serviceType = callee.processType ? SERVICE_TYPES[callee.processType] : undefined;
        if (serviceType) node.serviceType = serviceType;
      }
      node.inputs = parametersOf(callee, 'input');
      node.outputs = parametersOf(callee, 'output');
      // Read once per service and shared by every call of it.
      const internals = ctx.resolver.internals(calledId);
      if (internals) node.calledElement.internals = internals;
    }
  }
  Object.assign(node, readCallMappings(el, node.inputs, node.outputs, callee !== undefined, label, ctx.warnings));
}

function readUserTask(settings: XmlElement, label: string, warnings: string[]): UserTaskSettings | undefined {
  const out: UserTaskSettings = {};
  const assignment = childText(settings, 'activityAssignmentType');
  if (assignment) out.assignment = assignment;
  const priority = childText(child(settings, 'activityPriority'), 'priority');
  if (priority) out.priority = priority;
  const due = child(settings, 'activityDueDate');
  if (due) {
    const type = attr(due, 'type');
    const dueDate = child(due, 'dueDate');
    if (type !== undefined && type !== 'TimeCalculation') {
      warnings.push(`${label}: the due date of type "${type}" is not shown.`);
    } else if (dueDate) {
      const value = textContent(dueDate).trim();
      const unit = attr(dueDate, 'unit');
      if (value) out.dueDate = unit ? `${value} ${unit}` : value;
    }
  }
  const subject = childText(settings, 'subject');
  if (subject) out.subject = subject;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Timer of an event; undefined when it has none or its settings have a form not seen in a real export. */
function readTimer(el: XmlElement, label: string, warnings: string[]): TimerSettings | undefined {
  const defs = children(el, 'timerEventDefinition');
  if (defs.length === 0) return undefined;
  const settings = child(child(defs[0], 'extensionElements'), 'timerEventSettings');
  if (defs.length > 1 || !settings) {
    warnings.push(`${label}: timer settings of an unknown form are not shown.`);
    return undefined;
  }
  const dateType = childText(settings, 'dateType');
  const direction = childText(settings, 'relativeDirection');
  if ((dateType !== undefined && dateType !== 'Now') || (direction !== undefined && direction !== 'AfterStart')) {
    warnings.push(
      `${label}: timer settings with dateType "${dateType ?? ''}" and relativeDirection "${direction ?? ''}" are not shown.`,
    );
    return undefined;
  }
  const duration = childText(settings, 'relativeTime');
  if (!duration) {
    warnings.push(`${label}: the timer has no duration.`);
    return undefined;
  }
  const timer: TimerSettings = { duration };
  const unit = childText(settings, 'relativeTimeResolution');
  if (unit) timer.unit = unit;
  if (el.name === 'boundaryEvent') {
    const cancel = attr(el, 'cancelActivity');
    const parallel = attr(el, 'parallelMultiple');
    if (cancel === 'true' || cancel === 'false') timer.interrupting = cancel === 'true';
    if (parallel === 'true' || parallel === 'false') timer.repeating = parallel === 'true';
  }
  return timer;
}

/**
 * BPD variables: BPMN2 process/dataObject, with the default value from the
 * classic pool/privateVariable (same id) and tracking from pool/trackedField.
 */
function readVariables(process: XmlElement, bpd: XmlElement, resolver: TwxResolver): ProcessVariable[] {
  const pools = children(bpd, 'BusinessProcessDiagram').flatMap((d) => children(d, 'pool'));
  const classicById = new Map<string, XmlElement>();
  const classicByName = new Map<string, XmlElement>();
  const trackedNames = new Set<string>();
  for (const pool of pools) {
    for (const v of children(pool, 'privateVariable')) {
      const id = attr(v, 'id');
      const name = childText(v, 'name');
      if (id) classicById.set(id, v);
      if (name && !classicByName.has(name)) classicByName.set(name, v);
    }
    for (const t of children(pool, 'trackedField')) {
      const name = childText(t, 'name');
      if (name) trackedNames.add(name);
    }
  }

  return children(process, 'dataObject').map((obj) => {
    const variable = dataObjectVariable(obj, resolver);
    if (trackedNames.has(variable.name)) variable.tracked = true;
    const classic = classicById.get(attr(obj, 'id') ?? '') ?? classicByName.get(variable.name);
    if (classic) {
      delete variable.defaultValue;
      if (childText(classic, 'hasDefault')?.toLowerCase() === 'true') {
        variable.defaultValue = childText(classic, 'defaultValue') ?? '';
      }
    }
    return variable;
  });
}


/** Top-level lanes of the BPMN2 laneSet, used when the classic model has none. */
function bpmnLanes(process: XmlElement): Lane[] {
  return children(process, 'laneSet').flatMap((set) =>
    children(set, 'lane').map((lane) => ({
      id: attr(lane, 'id') ?? '',
      name: lane.attrs.name ?? '',
      nodeIds: children(lane, 'flowNodeRef')
        .map((r) => textContent(r).trim())
        .filter((s) => s.length > 0),
    })),
  );
}

// ---------------------------------------------------------------------------
// Classic model: lanes and positions

interface ClassicLane {
  lane: Lane;
  /** <height>; undefined when missing or not a number. */
  height?: number;
}

interface ClassicPosition {
  laneIndex: number;
  /** location x,y of a flowObject (relative to its lane). */
  location?: { x: number; y: number };
  /** For an attachedEvent: the id of the activity it is attached to. */
  hostId?: string;
}

interface ClassicModel {
  lanes: ClassicLane[];
  positions: Map<string, ClassicPosition>;
}

function readClassic(bpd: XmlElement, bpmnProcess?: XmlElement): ClassicModel {
  let lanes: ClassicLane[] = [];
  const positions = new Map<string, ClassicPosition>();
  for (const diagram of children(bpd, 'BusinessProcessDiagram')) {
    for (const pool of children(diagram, 'pool')) {
      for (const laneEl of children(pool, 'lane')) {
        const laneIndex = lanes.length;
        const nodeIds: string[] = [];
        for (const fo of children(laneEl, 'flowObject')) {
          const foId = attr(fo, 'id');
          if (!foId) continue;
          nodeIds.push(foId);
          const loc = child(child(fo, 'position'), 'location');
          const x = Number(attr(loc, 'x'));
          const y = Number(attr(loc, 'y'));
          positions.set(foId, {
            laneIndex,
            ...(loc && Number.isFinite(x) && Number.isFinite(y) ? { location: { x, y } } : {}),
          });
          for (const ev of descendants(fo, 'attachedEvent')) {
            const evId = attr(ev, 'id');
            if (!evId) continue;
            nodeIds.push(evId);
            positions.set(evId, { laneIndex, hostId: foId });
          }
        }
        const height = Number(childText(laneEl, 'height'));
        lanes.push({
          lane: { id: attr(laneEl, 'id') ?? '', name: childText(laneEl, 'name') ?? '', nodeIds },
          ...(Number.isFinite(height) && height > 0 ? { height } : {}),
        });
      }
    }
  }
  if (bpmnProcess) lanes = withEmptyBpmnLanes(lanes, positions, bpmnProcess);
  setLaneBounds(lanes, bpd);
  return { lanes, positions };
}

/**
 * The classic model leaves out lanes without flow objects that BAW still
 * draws (e.g. an empty System lane); the BPMN2 laneSet has them, with their
 * height in nodeVisualInfo. They are added in laneSet order, as empty lanes.
 * Lanes without a height are not added (the lane bands need every height).
 * Updates the lane indexes in `positions`.
 */
function withEmptyBpmnLanes(
  lanes: ClassicLane[],
  positions: Map<string, ClassicPosition>,
  bpmnProcess: XmlElement,
): ClassicLane[] {
  if (lanes.length === 0) return lanes;
  const known = new Set(lanes.map((l) => l.lane.id));
  const merged: ClassicLane[] = [];
  let next = 0;
  for (const set of children(bpmnProcess, 'laneSet')) {
    for (const el of children(set, 'lane')) {
      const id = attr(el, 'id') ?? '';
      if (known.has(id)) {
        // Classic lanes keep their own order; take them up to this one.
        while (next < lanes.length) {
          const lane = lanes[next++];
          merged.push(lane);
          if (lane.lane.id === id) break;
        }
        continue;
      }
      if (!id || children(el, 'flowNodeRef').length > 0) continue;
      const height = nodeVisualInfo(el)?.height;
      if (height === undefined || !(height > 0)) continue;
      merged.push({ lane: { id, name: el.attrs.name ?? '', nodeIds: [] }, height });
    }
  }
  merged.push(...lanes.slice(next));
  if (merged.length === lanes.length) return lanes;
  const index = new Map(merged.map((l, i) => [l, i]));
  for (const pos of positions.values()) pos.laneIndex = index.get(lanes[pos.laneIndex])!;
  return merged;
}

/**
 * Lane bands as BAW draws them: stacked from y 0, each as high as its
 * <height>. Only when every lane has a height; the pool's <size w> is the width.
 */
function setLaneBounds(lanes: ClassicLane[], bpd: XmlElement): void {
  if (lanes.length === 0 || lanes.some((l) => l.height === undefined)) return;
  const size = child(child(first(bpd, 'pool'), 'dimension'), 'size');
  const width = Number(attr(size, 'w'));
  let top = 0;
  for (const l of lanes) {
    l.lane.bounds = { x: 0, y: top, width: Number.isFinite(width) && width > 0 ? width : 0, height: l.height! };
    top += l.height!;
  }
}

/**
 * BAW keeps the diagram of each sub-process and event sub-process as an
 * object of its own: "25." and the sub-process id, with the BPD as its
 * parentBpdId and no BPMN2 model. Its flowObjects are the nodes directly
 * inside the sub-process. Places them when the export holds that object;
 * otherwise they are left without bounds (and laid out when opened).
 */
function placeSubProcessNodes(nodes: FlowNode[], visual: Map<string, Bounds>, otherObject: (id: string) => string | undefined): void {
  for (const sub of nodes) {
    if (sub.kind !== 'subProcess') continue;
    const xml = otherObject(`25.${sub.id}`);
    if (xml === undefined) continue;
    let bpd: XmlElement | undefined;
    try {
      const root = parseXml(xml);
      bpd = child(root, 'bpd') ?? first(root, 'bpd');
    } catch {
      continue;
    }
    if (!bpd || !childText(bpd, 'parentBpdId')) continue;
    placeNodes(nodes, readClassic(bpd), visual, sub.id);
  }
}

/**
 * Sets absolute bounds on the nodes the classic model places: the top-level
 * nodes, or with `parentId` the nodes directly inside that sub-process (in
 * the coordinates of the sub-process's own diagram).
 */
function placeNodes(nodes: FlowNode[], classic: ClassicModel, visual: Map<string, Bounds>, parentId?: string): void {
  // Top of each lane: the heights of the lanes above it. Unknown after a lane without a height.
  const tops: Array<number | undefined> = [];
  let top: number | undefined = 0;
  for (const lane of classic.lanes) {
    tops.push(top);
    top = top !== undefined && lane.height !== undefined ? top + lane.height : undefined;
  }

  for (const node of nodes) {
    if (node.parentId !== parentId) continue;
    const pos = classic.positions.get(node.id);
    const laneTop = pos ? tops[pos.laneIndex] : undefined;
    if (!pos || laneTop === undefined) continue;
    const vis = visual.get(node.id);
    const size = vis && vis.width > 0 && vis.height > 0 ? { width: vis.width, height: vis.height } : nodeSize(node.kind);
    const at = pos.location ?? (pos.hostId !== undefined && vis ? { x: vis.x, y: vis.y } : undefined);
    if (!at) continue;
    node.bounds = { x: at.x, y: laneTop + at.y, ...size };
  }
}
