// Reads one service object of a TWX export (objects/1.*.xml), two ways:
//   - readServiceInternals: CalleeInternals for the details panel, its steps
//     in flow order, its variables and parameters, and the coaches of a
//     client-side human service. One level deep: a call step names the
//     service it calls (and keeps its id) but is not followed. Works on any
//     service id on its own (TwxResolver.internals).
//   - readServiceDiagram: the same steps as a Process to draw, with BAW's
//     positions (nodeVisualInfo, else the classic item/layoutData), read when
//     the viewer opens the service (./calleeDiagrams).
// Forms verified on BAW 8.6.6 exports:
//
//   service flow (12)  process/bpmn2Model/definitions/process, real elements
//                      (any namespace prefix; read by local name)
//   human service (10) process/coachflow/definitions/globalUserTask/
//                      extensionElements/userTaskImplementation; parameters in
//                      globalUserTask/ioSpecification
//   script             scriptTask@scriptFormat, script. Only the BPMN2 copy is
//                      read (not the classic item, not jsonData).
//   call               callActivity@calledElement "1.…", activityType
//                      CalledProcess, mappings as in a BPD
//   REST               serviceTask@operationRef, extensionElements/
//                      externalServiceRefPO (the external service, processType 11)
//                      and externalServiceRef; the operation and its business
//                      signature in the external service's interface/operation
//   gateway            exclusiveGateway@default; condition =
//                      sequenceFlow/conditionExpression, kept as written
//   error boundary     boundaryEvent@attachedToRef + errorEventDefinition/
//                      extensionElements/errorEventSettings (catchAll, errorCode)
//   error end event    endEvent + errorEventDefinition
//   coach              formTask/formDefinition/coachDefinition/layout: layoutItem
//                      and contributions (nested in a section), with
//                      layoutItemId, configData "@label", viewUUID, binding
//   human service      intermediateThrowEvent + stayOnPageEventDefinition or
//   events             postponeTaskEventDefinition
//
// Anything else is not guessed at: the step is kind "unknown" and a warning
// is reported once.

import { nodeSize } from '../bpmn/layout';
import type {
  Bounds,
  CalleeInternals,
  CalleeStep,
  CoachControl,
  CoachSummary,
  DataParameter,
  ErrorBoundary,
  Flow,
  FlowNode,
  FlowNodeKind,
  Process,
} from '../model/model';
import {
  dataObjectVariable,
  ioParameters,
  NON_FLOW_ELEMENTS,
  parametersOf,
  readCallMappings,
  readScript,
} from './activities';
import { nodeVisualInfo, readLinkPorts, withXmlIds } from './diagram';
import type { TwxResolver } from './resolver';
import { docText } from './text';
import { attr, child, childText, children, descendants, first, textContent, type XmlElement } from './xml';

/** processType of the services whose inside is read. */
const SERVICE_FLOW = '12';
const HUMAN_SERVICE = '10';

/** Event definitions of an intermediate throw event in a human service. */
const THROW_EVENTS: Readonly<Record<string, string>> = {
  stayOnPageEventDefinition: 'Stay on page',
  postponeTaskEventDefinition: 'Postpone task',
};

interface ServiceObject {
  name: string;
  label: string;
  processType: string;
  /** The classic <process> element. */
  process: XmlElement;
  /** Holds the flow elements: the BPMN2 process, or the userTaskImplementation. */
  container: XmlElement;
  /** Holds the ioSpecification: the BPMN2 process, or the globalUserTask. */
  signature: XmlElement;
}

/**
 * The parts of a service object that are read. Undefined for an object that
 * is not a service flow or a client-side human service; null (with a
 * warning) when such a service has no BPMN2 model.
 */
function serviceObject(root: XmlElement, warn: (message: string) => void): ServiceObject | undefined | null {
  const process = child(root, 'process') ?? first(root, 'process');
  if (!process) return undefined;
  const name = attr(process, 'name') ?? attr(process, 'id') ?? '';
  const label = `Service "${name}"`;
  const processType = childText(process, 'processType');

  let container: XmlElement | undefined;
  let signature: XmlElement | undefined;
  if (processType === SERVICE_FLOW) {
    container = child(child(child(process, 'bpmn2Model'), 'definitions'), 'process');
    signature = container;
  } else if (processType === HUMAN_SERVICE) {
    const task = child(child(child(process, 'coachflow'), 'definitions'), 'globalUserTask');
    container = child(child(task, 'extensionElements'), 'userTaskImplementation');
    signature = task;
  } else {
    return undefined;
  }
  if (!container || !signature) {
    warn(`${label} has no BPMN2 model in the export; its steps are not shown.`);
    return null;
  }
  return { name, label, processType, process, container, signature };
}

/**
 * Reads the inside of a service object (the root element of its file).
 * Undefined for an object that is not a service flow or a client-side human
 * service, or that has no BPMN2 model to read.
 */
export function readServiceInternals(root: XmlElement, resolver: TwxResolver): CalleeInternals | undefined {
  const service = serviceObject(root, (m) => resolver.warn(m));
  if (!service) return undefined;
  const ctx: ReadContext = { resolver, label: service.label, nameById: new Map(), warn: (m) => resolver.warn(m) };
  const read = readSteps(service.container, ctx);
  const internals: CalleeInternals = { steps: read.steps, flows: read.flows };
  Object.assign(internals, serviceData(service, resolver));
  if (service.processType === HUMAN_SERVICE) {
    internals.coaches = internals.steps
      .filter((s) => s.kind === 'coach')
      .map((s) => read.coaches.get(s.id))
      .filter((c): c is CoachSummary => c !== undefined);
  }
  return internals;
}

/** Variables, inputs and outputs of a service; each left out when empty. */
function serviceData(service: ServiceObject, resolver: TwxResolver): Pick<Process, 'variables' | 'inputs' | 'outputs'> {
  const out: Pick<Process, 'variables' | 'inputs' | 'outputs'> = {};
  const variables = children(service.container, 'dataObject').map((o) => dataObjectVariable(o, resolver));
  if (variables.length > 0) out.variables = variables;
  const { inputs, outputs } = ioParameters(service.signature, resolver);
  if (inputs.length > 0) out.inputs = inputs;
  if (outputs.length > 0) out.outputs = outputs;
  return out;
}

/**
 * Reads a service flow or a client-side human service (1.…) as a diagram:
 * every step a node, every sequence flow a flow, error boundaries as events
 * attached to their step. Positions come from nodeVisualInfo (absolute, as in
 * BAW's editor), else from the classic model (item/layoutData x,y); when a
 * node has neither, the layout lays out the whole diagram. A service has no
 * lanes: it is drawn as one pool. Undefined for any other object, or one not
 * in the export. Problems are reported to the resolver and to `warnings`.
 */
export function readServiceDiagram(id: string, resolver: TwxResolver, warnings: string[] = []): Process | undefined {
  const objectId = id.slice(id.lastIndexOf('/') + 1).trim();
  const root = objectId.startsWith('1.') ? resolver.object(objectId) : undefined;
  if (!root) return undefined;
  const warn = (m: string) => {
    resolver.warn(m);
    if (!warnings.includes(m)) warnings.push(m);
  };
  const service = serviceObject(root, warn);
  if (!service) return undefined;
  const ctx: ReadContext = { resolver, label: service.label, nameById: new Map(), warn };
  const read = readSteps(service.container, ctx);
  const classic = classicPositions(service.process);

  const nodes: FlowNode[] = [];
  for (const step of read.steps) {
    const node = stepNode(step, read.coaches.get(step.id), ctx);
    const element = read.elements.get(step.id);
    const doc = element ? docText(children(element, 'documentation').map(textContent).join('\n\n')) : undefined;
    if (doc) node.documentation = doc;
    const bounds = nodeBounds(step.id, node, read.visual, classic);
    if (bounds) node.bounds = bounds;
    nodes.push(node);
  }
  for (const b of read.boundaries) {
    if (!b.boundary || !b.hostId) continue;
    const node: FlowNode = {
      id: b.id,
      name: b.boundary.name,
      kind: 'intermediateEvent',
      originalType: 'boundaryEvent',
      inputs: [],
      outputs: [],
      attachedToId: b.hostId,
      errorEvent: { catchAll: b.boundary.catchAll, ...(b.boundary.errorCode !== undefined ? { errorCode: b.boundary.errorCode } : {}) },
      eventType: 'Error',
    };
    const vis = read.visual.get(b.id);
    if (vis && vis.width > 0 && vis.height > 0) node.bounds = { ...vis };
    nodes.push(node);
  }

  const documentation =
    docText(children(service.container, 'documentation').map(textContent).join('\n\n')) ??
    docText(childText(service.process, 'description')) ??
    '';
  const process: Process = {
    id: attr(service.process, 'id') ?? objectId,
    name: service.name,
    documentation,
    source: { kind: service.processType === HUMAN_SERVICE ? 'humanService' : 'serviceFlow', processType: service.processType },
    lanes: [],
    nodes,
    flows: read.flows.map((f) => ({ ...f })),
    ...serviceData(service, resolver),
  };
  return withXmlIds(process);
}

/** A step of a service as a diagram node. */
function stepNode(step: CalleeStep, coach: CoachSummary | undefined, ctx: ReadContext): FlowNode {
  const node: FlowNode = {
    id: step.id,
    name: step.name,
    kind: STEP_NODE_KINDS[step.kind],
    originalType: step.originalType,
    inputs: step.inputs ? [...step.inputs] : [],
    outputs: step.outputs ? [...step.outputs] : [],
  };
  if (step.script) node.script = step.script;
  if (step.inputMappings) node.inputMappings = step.inputMappings;
  if (step.outputMappings) node.outputMappings = step.outputMappings;
  if (step.restOperation) node.restOperation = step.restOperation;
  if (step.eventType) node.eventType = step.eventType;
  if (step.kind === 'end' && step.eventType?.startsWith('Error')) {
    const code = step.eventType.slice('Error'.length).trim();
    node.errorEvent = code ? { errorCode: code } : {};
  }
  if (coach) node.coach = coach;
  if (step.kind === 'call' && step.calledId !== undefined) {
    node.calledElement = { id: step.calledId };
    if (step.calledName !== undefined) node.calledElement.name = step.calledName;
    if (step.calledKind !== undefined) node.calledElement.kind = step.calledKind;
    const internals = ctx.resolver.internals(step.calledId);
    if (internals) node.calledElement.internals = internals;
  }
  return node;
}

const STEP_NODE_KINDS: Readonly<Record<CalleeStep['kind'], FlowNodeKind>> = {
  start: 'startEvent',
  end: 'endEvent',
  script: 'scriptTask',
  call: 'callActivity',
  rest: 'serviceTask',
  gateway: 'exclusiveGateway',
  // A coach is a page the user works on: drawn as a user task.
  coach: 'userTask',
  event: 'intermediateEvent',
  unknown: 'unknown',
};

/** nodeVisualInfo when it has a size, else the classic position with the default size of the kind. */
function nodeBounds(id: string, node: FlowNode, visual: Map<string, Bounds>, classic: Map<string, { x: number; y: number }>): Bounds | undefined {
  const vis = visual.get(id);
  if (vis && vis.width > 0 && vis.height > 0) return { ...vis };
  const at = classic.get(id) ?? (node.kind === 'startEvent' ? classic.get(START_POINT) : undefined);
  return at ? { ...at, ...nodeSize(node.kind) } : undefined;
}

const START_POINT = '#startPoint';

/**
 * Positions of the classic model: process/item/layoutData x,y by BPMN2 node
 * id (processItemId "2025.<id>"; a human service's BPMN2 ids keep the
 * prefix), and process/startPoint/layoutData for the start event.
 */
function classicPositions(process: XmlElement): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const position = (el: XmlElement | undefined) => {
    const layout = child(el, 'layoutData');
    const x = Number(attr(layout, 'x'));
    const y = Number(attr(layout, 'y'));
    return layout && attr(layout, 'x') !== undefined && attr(layout, 'y') !== undefined && Number.isFinite(x) && Number.isFinite(y)
      ? { x, y }
      : undefined;
  };
  for (const item of children(process, 'item')) {
    const itemId = childText(item, 'processItemId');
    const at = position(item);
    if (!itemId || !at) continue;
    out.set(itemId, at);
    if (itemId.startsWith('2025.')) out.set(itemId.slice('2025.'.length), at);
  }
  const start = position(child(process, 'startPoint'));
  if (start) out.set(START_POINT, start);
  return out;
}

interface ReadContext {
  resolver: TwxResolver;
  label: string;
  /** Reports a problem (each once to the resolver). */
  warn(message: string): void;
  /** Step and boundary names by id (the id when unnamed), for flow targets. */
  nameById: Map<string, string>;
}

interface Boundary {
  id: string;
  hostId?: string;
  boundary?: ErrorBoundary;
}

interface ReadSteps {
  steps: CalleeStep[];
  flows: Flow[];
  coaches: Map<string, CoachSummary>;
  /** Error boundaries, attached to their step in `steps` as well. */
  boundaries: Boundary[];
  /** nodeVisualInfo by node id. */
  visual: Map<string, Bounds>;
  /** Source element by step id. */
  elements: Map<string, XmlElement>;
}

function readSteps(container: XmlElement, ctx: ReadContext): ReadSteps {
  const steps: CalleeStep[] = [];
  const visual = new Map<string, Bounds>();
  const elements = new Map<string, XmlElement>();
  const flows: Flow[] = [];
  const defaults = new Map<string, string>();
  const boundaries: Boundary[] = [];
  const coaches = new Map<string, CoachSummary>();

  for (const el of container.children) {
    const id = attr(el, 'id');
    if (el.name === 'sequenceFlow') {
      flows.push(readFlow(el));
      continue;
    }
    if (NON_FLOW_ELEMENTS.has(el.name) || !id) continue;
    // Names are kept as written, trailing spaces included.
    const name = el.attrs.name ?? '';
    ctx.nameById.set(id, name || id);
    const vis = nodeVisualInfo(el);
    if (vis) visual.set(id, vis);
    if (el.name === 'boundaryEvent') {
      const b = readBoundary(el, id, name, ctx);
      if (b) {
        boundaries.push(b);
        continue;
      }
    }
    const step = readStep(el, id, name, ctx);
    if (step.kind === 'gateway') {
      const def = attr(el, 'default');
      if (def) defaults.set(id, def);
    }
    if (step.kind === 'coach') coaches.set(id, { id, name, controls: readControls(el) });
    elements.set(id, el);
    steps.push(step);
  }

  const stepIds = new Set(steps.map((s) => s.id));
  for (const flow of flows) {
    flow.isDefault = defaults.get(flow.sourceId) === flow.id;
  }
  const nameOf = (id: string) => ctx.nameById.get(id) ?? id;
  for (const step of steps) {
    if (step.kind !== 'gateway') continue;
    step.conditions = flows
      .filter((f) => f.sourceId === step.id)
      .map((f) => ({ to: nameOf(f.targetId), ...(f.condition !== undefined ? { condition: f.condition } : {}), isDefault: f.isDefault }));
  }

  // Attach each error boundary to its step; the step's error path follows it in the order.
  const boundaryTargets = new Map<string, string[]>();
  for (const b of boundaries) {
    const out = flows.filter((f) => f.sourceId === b.id);
    if (b.boundary) {
      if (out.length > 1) ctx.warn(`${ctx.label}: error boundary "${b.boundary.name || b.id}" has more than one outgoing flow; only the first target is shown.`);
      if (out[0]) b.boundary.to = nameOf(out[0].targetId);
    }
    const host = steps.find((s) => s.id === b.hostId);
    if (host && b.boundary) {
      (host.errorBoundaries ??= []).push(b.boundary);
      const targets = boundaryTargets.get(host.id) ?? [];
      targets.push(...out.map((f) => f.targetId));
      boundaryTargets.set(host.id, targets);
    }
  }

  return { steps: flowOrder(steps, flows, boundaryTargets, stepIds), flows, coaches, boundaries, visual, elements };
}

/** Breadth first from the start events along the flows (and error paths); unreached steps last, in document order. */
function flowOrder(steps: CalleeStep[], flows: Flow[], boundaryTargets: Map<string, string[]>, stepIds: Set<string>): CalleeStep[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const next = new Map<string, string[]>();
  for (const f of flows) {
    const list = next.get(f.sourceId) ?? [];
    list.push(f.targetId);
    next.set(f.sourceId, list);
  }
  const seen = new Set<string>();
  const order: CalleeStep[] = [];
  const queue: string[] = steps.filter((s) => s.kind === 'start').map((s) => s.id);
  queue.forEach((id) => seen.add(id));
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(byId.get(id)!);
    for (const target of [...(next.get(id) ?? []), ...(boundaryTargets.get(id) ?? [])]) {
      if (!stepIds.has(target) || seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  for (const s of steps) if (!seen.has(s.id)) order.push(s);
  return order;
}

function readFlow(el: XmlElement): Flow {
  const flow: Flow = {
    id: attr(el, 'id') ?? '',
    name: attr(el, 'name') ?? '',
    sourceId: attr(el, 'sourceRef') ?? '',
    targetId: attr(el, 'targetRef') ?? '',
    isDefault: false,
  };
  // Kept exactly as written: the editor puts tabs around the operator.
  const expressions = children(el, 'conditionExpression');
  if (expressions.length > 0) {
    const condition = expressions.map(textContent).join('');
    if (condition.trim().length > 0) flow.condition = condition;
  }
  readLinkPorts(el, flow);
  return flow;
}

function readStep(el: XmlElement, id: string, name: string, ctx: ReadContext): CalleeStep {
  const step: CalleeStep = { id, name, kind: 'unknown', originalType: el.name };
  const definitions = el.children.filter((c) => c.name.endsWith('EventDefinition'));
  switch (el.name) {
    case 'startEvent':
      if (definitions.length === 0) step.kind = 'start';
      break;
    case 'endEvent':
      if (definitions.length === 0) {
        step.kind = 'end';
      } else if (definitions.length === 1 && definitions[0].name === 'errorEventDefinition') {
        step.kind = 'end';
        const code = childText(child(child(definitions[0], 'extensionElements'), 'errorEventSettings'), 'errorCode');
        step.eventType = code ? `Error ${code}` : 'Error';
      }
      break;
    case 'intermediateThrowEvent': {
      const type = definitions.length === 1 ? THROW_EVENTS[definitions[0].name] : undefined;
      if (type) {
        step.kind = 'event';
        step.eventType = type;
      }
      break;
    }
    case 'scriptTask': {
      step.kind = 'script';
      const script = readScript(el);
      if (script) step.script = script;
      break;
    }
    case 'callActivity':
      readCall(el, step, ctx);
      break;
    case 'serviceTask':
      readRest(el, step, ctx);
      break;
    case 'exclusiveGateway':
      step.kind = 'gateway';
      break;
    case 'formTask':
      step.kind = 'coach';
      break;
  }
  if (step.kind === 'unknown') {
    ctx.warn(`${ctx.label}: unsupported step <${el.name}> "${name || id}" read as kind "unknown".`);
  }
  return step;
}

function readCall(el: XmlElement, step: CalleeStep, ctx: ReadContext): void {
  const calledRef = attr(el, 'calledElement');
  const activityType = childText(child(el, 'extensionElements'), 'activityType');
  if (!calledRef || (activityType !== undefined && activityType !== 'CalledProcess')) return;
  step.kind = 'call';
  const calledId = calledRef.replace(/^\//, '').trim();
  step.calledId = calledId;
  // Toolkit services (System Data SQL Execute Statement, …) are not among the app's objects.
  const callee = ctx.resolver.callee(calledId);
  if (callee) {
    step.calledName = callee.name;
    step.calledKind = callee.generated ? `${callee.kind}, generated` : callee.kind;
  }
  const inputs = callee ? parametersOf(callee, 'input') : [];
  const outputs = callee ? parametersOf(callee, 'output') : [];
  if (inputs.length > 0) step.inputs = inputs;
  if (outputs.length > 0) step.outputs = outputs;
  const label = `${ctx.label}: "${step.name || step.id}"`;
  Object.assign(step, withWarnings(ctx, (w) => readCallMappings(el, inputs, outputs, callee !== undefined, label, w)));
}

/** A REST step: the external service and operation it is bound to. */
function readRest(el: XmlElement, step: CalleeStep, ctx: ReadContext): void {
  const serviceRef = childText(child(el, 'extensionElements'), 'externalServiceRefPO');
  if (!serviceRef) return;
  step.kind = 'rest';
  const serviceId = serviceRef.slice(serviceRef.lastIndexOf('/') + 1).trim();
  const service = ctx.resolver.objectName(serviceId);
  const rest: CalleeStep['restOperation'] = { service: service ?? serviceId, serviceId };
  const opRef = attr(el, 'operationRef');
  const opId = opRef ? opRef.slice(opRef.lastIndexOf(':') + 1) : undefined;
  const definitions = ctx.resolver.object(serviceId);
  const operation = opId ? descendants(definitions, 'operation').find((o) => attr(o, 'id') === opId) : undefined;
  const opName = attr(operation, 'name');
  if (opName) rest.operation = opName;
  step.restOperation = rest;

  const sig = child(child(operation, 'extensionElements'), 'businessSignature');
  const param = (p: XmlElement): DataParameter => {
    const out: DataParameter = { id: attr(p, 'id') ?? '', name: childText(p, 'name') ?? '', isCollection: childText(p, 'isCollection') === 'true' };
    const typeRef = childText(p, 'typeRefPO');
    if (typeRef) {
      out.typeRef = typeRef;
      const typeName = ctx.resolver.typeName(typeRef);
      if (typeName) out.typeName = typeName;
    }
    return out;
  };
  const inputs = children(sig, 'input').map(param);
  const outputs = children(sig, 'output').map(param);
  if (inputs.length > 0) step.inputs = inputs;
  if (outputs.length > 0) step.outputs = outputs;
  const label = `${ctx.label}: "${step.name || step.id}"`;
  Object.assign(step, withWarnings(ctx, (w) => readCallMappings(el, inputs, outputs, sig !== undefined, label, w)));
}

/** An error boundary event; undefined (read as a step) when it is not one of a verified form. */
function readBoundary(el: XmlElement, id: string, name: string, ctx: ReadContext): Boundary | undefined {
  const definitions = el.children.filter((c) => c.name.endsWith('EventDefinition'));
  const settings = child(child(definitions[0], 'extensionElements'), 'errorEventSettings');
  if (definitions.length !== 1 || definitions[0].name !== 'errorEventDefinition' || !settings) return undefined;
  const hostId = attr(el, 'attachedToRef');
  const boundary: ErrorBoundary = { id, name, catchAll: childText(settings, 'catchAll') === 'true' };
  const code = childText(settings, 'errorCode');
  if (code) boundary.errorCode = code;
  if (!hostId) {
    ctx.warn(`${ctx.label}: error boundary "${name || id}" is attached to no step and is not shown.`);
  }
  return { id, ...(hostId ? { hostId } : {}), boundary };
}

/** Every control of a coach, nested ones (contributions of a section) included, in document order. */
function readControls(formTask: XmlElement): CoachControl[] {
  const layout = child(child(child(formTask, 'formDefinition'), 'coachDefinition'), 'layout');
  const out: CoachControl[] = [];
  const visit = (e: XmlElement) => {
    if ((e.name === 'layoutItem' || e.name === 'contributions') && child(e, 'layoutItemId')) {
      const control: CoachControl = { id: childText(e, 'layoutItemId') ?? '' };
      const labelOption = children(e, 'configData').find((c) => childText(c, 'optionName') === '@label');
      const label = childText(labelOption, 'value');
      if (label) control.label = label;
      const viewRef = childText(e, 'viewUUID');
      if (viewRef) control.viewRef = viewRef;
      const binding = childText(e, 'binding');
      if (binding) control.binding = binding;
      out.push(control);
    }
    for (const c of e.children) if (c.name !== 'configData') visit(c);
  };
  if (layout) layout.children.forEach(visit);
  return out;
}

/** Runs a shared reader that reports into an array, and passes its warnings on (each once). */
function withWarnings<T>(ctx: ReadContext, read: (warnings: string[]) => T): T {
  const warnings: string[] = [];
  const result = read(warnings);
  warnings.forEach((w) => ctx.warn(w));
  return result;
}
