// Writes a Process as BPMN 2.0 XML with a bpmndi section, ready for bpmn-js.
// The process is wrapped in a collaboration with one participant so its
// lanes are drawn inside a pool. In memory only: nothing is written to disk,
// and the source file is never touched.

import { BpmnModdle, type ModdleElement } from 'bpmn-moddle';
import type { Bounds, FlowNode, FlowNodeKind, Process } from '../model/model';
import { icpDescriptor } from './bpmnReader';
import { layoutProcess, type LayoutOptions, type ProcessLayout } from './layout';

export interface DiagramXmlOptions extends LayoutOptions {
  /** A layout computed earlier with layoutProcess; laid out here when missing. */
  layout?: ProcessLayout;
}

export interface DiagramXmlResult {
  xml: string;
  layout: ProcessLayout;
  /** Layout warnings plus anything that could not be written as read. */
  warnings: string[];
}

const TYPE_BY_KIND: Record<FlowNodeKind, string> = {
  startEvent: 'bpmn:StartEvent',
  endEvent: 'bpmn:EndEvent',
  intermediateEvent: 'bpmn:IntermediateCatchEvent',
  task: 'bpmn:Task',
  scriptTask: 'bpmn:ScriptTask',
  userTask: 'bpmn:UserTask',
  serviceTask: 'bpmn:ServiceTask',
  callActivity: 'bpmn:CallActivity',
  subProcess: 'bpmn:SubProcess',
  exclusiveGateway: 'bpmn:ExclusiveGateway',
  parallelGateway: 'bpmn:ParallelGateway',
  inclusiveGateway: 'bpmn:InclusiveGateway',
  eventBasedGateway: 'bpmn:EventBasedGateway',
  unknown: 'bpmn:Task',
};

/** Source types that are written as they were read (a subtype of the kind's default type). */
const KEEP_ORIGINAL = new Set([
  'bpmn:IntermediateThrowEvent',
  'bpmn:AdHocSubProcess',
  'bpmn:Transaction',
]);

/** Element types that have a `default` attribute. */
const HAS_DEFAULT = ['bpmn:Activity', 'bpmn:ExclusiveGateway', 'bpmn:InclusiveGateway', 'bpmn:ComplexGateway'];

/**
 * Lays out a process (unless a layout is given) and serialises it with
 * diagram interchange. Flow names hidden by the layout (see
 * LayoutOptions.hideGeneratedFlowLabels) are left out of the XML, because
 * bpmn-js draws a label for every named flow; the model keeps them.
 * Likewise, lanes hidden by LayoutOptions.hideEmptyLanes are left out.
 *
 * The defaults are meant for display only. An export of the laid-out BPMN
 * (a planned feature) must pass `hideGeneratedFlowLabels: false` and
 * `hideEmptyLanes: false`, so that no flow names or lanes are lost.
 */
export async function toDiagramXml(process: Process, options: DiagramXmlOptions = {}): Promise<DiagramXmlResult> {
  const lay = options.layout ?? (await layoutProcess(process, options));
  const warnings = [...lay.warnings];
  const moddle = BpmnModdle({ icp: icpDescriptor });
  const ids = new IdSource(process);

  // --- Semantic part --------------------------------------------------------
  const bpmnProcess = moddle.create('bpmn:Process', {
    id: process.id || ids.next('Process'),
    isExecutable: false,
  });
  if (process.name) bpmnProcess.name = process.name;
  if (process.documentation) bpmnProcess.documentation = [doc(moddle, process.documentation)];

  const elements = new Map<string, ModdleElement>();
  const flowElements: ModdleElement[] = [];
  for (const node of process.nodes) {
    if (lay.hiddenNodeIds.has(node.id)) continue;
    const el = createNode(moddle, node, warnings);
    elements.set(node.id, el);
    flowElements.push(el);
  }

  const flowEls = new Map<string, ModdleElement>();
  for (const flow of process.flows) {
    if (lay.hiddenFlowIds.has(flow.id)) continue;
    const source = elements.get(flow.sourceId)!;
    const target = elements.get(flow.targetId)!;
    const el = moddle.create('bpmn:SequenceFlow', { id: flow.id, sourceRef: source, targetRef: target });
    const label = lay.flowLabels.get(flow.id);
    if (label) el.name = label;
    if (flow.condition !== undefined) {
      el.conditionExpression = moddle.create('bpmn:FormalExpression', { body: flow.condition });
    }
    if (flow.isDefault) {
      if (HAS_DEFAULT.some((t) => source.$instanceOf(t))) {
        source.default = el;
      } else {
        warnings.push(`Default flow "${flow.name || flow.id}" starts at a ${source.$type}, which cannot have a default flow.`);
      }
    }
    pushRef(source, 'outgoing', el);
    pushRef(target, 'incoming', el);
    flowEls.set(flow.id, el);
    flowElements.push(el);
  }
  bpmnProcess.flowElements = flowElements;

  const laneEls = new Map<string, ModdleElement>();
  if (lay.lanes.length > 0) {
    const lanes = lay.lanes.map((lane) => {
      const members = process.nodes.filter((n) =>
        lane.synthetic
          ? elements.has(n.id) && !lay.lanes.some((l) => !l.synthetic && l.id === n.laneId)
          : elements.has(n.id) && n.laneId === lane.id,
      );
      const el = moddle.create('bpmn:Lane', {
        id: lane.id,
        flowNodeRef: members.map((n) => elements.get(n.id)!),
      });
      if (lane.name) el.name = lane.name;
      laneEls.set(lane.id, el);
      return el;
    });
    bpmnProcess.laneSets = [moddle.create('bpmn:LaneSet', { id: ids.next('LaneSet'), lanes })];
  }

  const participant = moddle.create('bpmn:Participant', {
    id: ids.next('Participant'),
    name: process.name || process.id,
    processRef: bpmnProcess,
  });
  const collaboration = moddle.create('bpmn:Collaboration', {
    id: ids.next('Collaboration'),
    participants: [participant],
  });

  // --- Diagram interchange --------------------------------------------------
  const planeElements: ModdleElement[] = [];
  planeElements.push(shape(moddle, ids.next('Shape'), participant, lay.pool, { isHorizontal: true }));
  for (const lane of lay.lanes) {
    planeElements.push(shape(moddle, ids.next('Shape'), laneEls.get(lane.id)!, lane.bounds, { isHorizontal: true }));
  }
  for (const node of process.nodes) {
    const el = elements.get(node.id);
    if (!el) continue;
    const attrs: Record<string, unknown> = {};
    if (el.$instanceOf('bpmn:SubProcess')) attrs.isExpanded = false;
    if (el.$type === 'bpmn:ExclusiveGateway') attrs.isMarkerVisible = true;
    const s = shape(moddle, ids.next('Shape'), el, lay.shapes.get(node.id)!, attrs);
    const labelBounds = lay.nodeLabels.get(node.id);
    if (labelBounds) s.label = label(moddle, labelBounds);
    planeElements.push(s);
  }
  for (const [flowId, el] of flowEls) {
    const edge = moddle.create('bpmndi:BPMNEdge', {
      id: ids.next('Edge'),
      bpmnElement: el,
      waypoint: lay.edges.get(flowId)!.map((p) => moddle.create('dc:Point', { x: p.x, y: p.y })),
    });
    const labelBounds = lay.edgeLabels.get(flowId);
    if (labelBounds) edge.label = label(moddle, labelBounds);
    planeElements.push(edge);
  }

  const diagram = moddle.create('bpmndi:BPMNDiagram', {
    id: ids.next('Diagram'),
    plane: moddle.create('bpmndi:BPMNPlane', {
      id: ids.next('Plane'),
      bpmnElement: collaboration,
      planeElement: planeElements,
    }),
  });

  const definitions = moddle.create('bpmn:Definitions', {
    id: ids.next('Definitions'),
    targetNamespace: 'http://bpmn.io/schema/bpmn',
    exporter: 'lanescope',
    rootElements: [collaboration, bpmnProcess],
    diagrams: [diagram],
  });

  const { xml } = await moddle.toXML(definitions, { format: true });
  return { xml, layout: lay, warnings };
}

function createNode(moddle: ReturnType<typeof BpmnModdle>, node: FlowNode, warnings: string[]): ModdleElement {
  let type = KEEP_ORIGINAL.has(node.originalType) ? node.originalType : TYPE_BY_KIND[node.kind];
  if (node.kind === 'unknown') {
    warnings.push(`Node "${node.name || node.id}" of unsupported type ${node.originalType} is drawn as a task.`);
  } else if (node.originalType === 'bpmn:BoundaryEvent') {
    warnings.push(`Boundary event "${node.name || node.id}" is drawn as an intermediate event.`);
    type = 'bpmn:IntermediateCatchEvent';
  }
  const el = moddle.create(type, { id: node.id });
  if (node.name) el.name = node.name;
  if (node.documentation) el.documentation = [doc(moddle, node.documentation)];
  if (node.serviceType && el.$instanceOf('bpmn:Task')) el.set('icp:serviceType', node.serviceType);
  if (node.performer && el.$instanceOf('bpmn:Activity')) {
    el.resources = [moddle.create('bpmn:Performer', { name: node.performer })];
  }
  // Error end events and error boundaries (drawn as intermediate events) get the error marker.
  if (node.errorEvent && (el.$instanceOf('bpmn:EndEvent') || el.$instanceOf('bpmn:IntermediateCatchEvent'))) {
    el.eventDefinitions = [moddle.create('bpmn:ErrorEventDefinition', {})];
  }
  return el;
}

function doc(moddle: ReturnType<typeof BpmnModdle>, text: string): ModdleElement {
  return moddle.create('bpmn:Documentation', { text });
}

function shape(
  moddle: ReturnType<typeof BpmnModdle>,
  id: string,
  element: ModdleElement,
  b: Bounds,
  attrs: Record<string, unknown>,
): ModdleElement {
  return moddle.create('bpmndi:BPMNShape', {
    id,
    bpmnElement: element,
    bounds: moddle.create('dc:Bounds', { x: b.x, y: b.y, width: b.width, height: b.height }),
    ...attrs,
  });
}

function label(moddle: ReturnType<typeof BpmnModdle>, b: Bounds): ModdleElement {
  return moddle.create('bpmndi:BPMNLabel', {
    bounds: moddle.create('dc:Bounds', { x: b.x, y: b.y, width: b.width, height: b.height }),
  });
}

function pushRef(el: ModdleElement, property: 'incoming' | 'outgoing', flow: ModdleElement): void {
  (el.get(property) as ModdleElement[]).push(flow);
}

/** Generates ids for diagram elements that do not clash with ids of the process. */
class IdSource {
  private readonly used: Set<string>;
  private counter = 0;

  constructor(process: Process) {
    this.used = new Set([process.id, ...process.nodes.map((n) => n.id), ...process.flows.map((f) => f.id), ...process.lanes.map((l) => l.id)]);
  }

  next(prefix: string): string {
    let id: string;
    do {
      id = `bobViewer_${prefix}_${++this.counter}`;
    } while (this.used.has(id));
    this.used.add(id);
    return id;
  }
}
