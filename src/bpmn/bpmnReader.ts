// Maps Bob BPMN 2.0 output (exporter "generate-baw-bpmn") onto the shared
// model using bpmn-moddle, plus a small descriptor for the IBM extension
// namespace (icp:serviceType).

import { BpmnModdle, type ModdleElement } from 'bpmn-moddle';
import { XMLParser } from 'fast-xml-parser';
import type {
  Bounds,
  DataParameter,
  Flow,
  FlowNode,
  FlowNodeKind,
  Lane,
  Process,
  ProcessPackage,
} from '../model/model';
import type { BpmnPackageInput } from '../input/bpmnInput';
import { DOCTYPE_MESSAGE, hasDoctype } from '../input/xmlGuard';
import { htmlToPlainText } from '../model/plainText';
import { readXsd } from '../xsd/xsdReader';

export const ICP_NAMESPACE = 'http://www.ibm.com/xmlns/prod/websphere/ibmbpm/pal/bpmnextension';

/** Moddle descriptor for the IBM BPM PAL BPMN extension. Only what the viewer reads. */
export const icpDescriptor = {
  name: 'IBM BPM PAL BPMN extension',
  prefix: 'icp',
  uri: ICP_NAMESPACE,
  xml: { tagAlias: 'lowerCase' },
  associations: [],
  types: [
    {
      name: 'ServiceTypeHolder',
      isAbstract: true,
      extends: ['bpmn:Task'],
      properties: [{ name: 'serviceType', isAttr: true, type: 'String' }],
    },
  ],
};

const KIND_BY_TYPE: Record<string, FlowNodeKind> = {
  'bpmn:StartEvent': 'startEvent',
  'bpmn:EndEvent': 'endEvent',
  'bpmn:IntermediateCatchEvent': 'intermediateEvent',
  'bpmn:IntermediateThrowEvent': 'intermediateEvent',
  'bpmn:BoundaryEvent': 'intermediateEvent',
  'bpmn:Task': 'task',
  'bpmn:ScriptTask': 'scriptTask',
  'bpmn:UserTask': 'userTask',
  'bpmn:ServiceTask': 'serviceTask',
  'bpmn:CallActivity': 'callActivity',
  'bpmn:SubProcess': 'subProcess',
  'bpmn:AdHocSubProcess': 'subProcess',
  'bpmn:Transaction': 'subProcess',
  'bpmn:ExclusiveGateway': 'exclusiveGateway',
  'bpmn:ParallelGateway': 'parallelGateway',
  'bpmn:InclusiveGateway': 'inclusiveGateway',
  'bpmn:EventBasedGateway': 'eventBasedGateway',
};

export interface BpmnReadResult {
  processes: Process[];
  exporter?: string;
  exporterVersion?: string;
  targetNamespace?: string;
  /** bpmn:import locations of XML Schema imports, in document order. */
  xsdImports: string[];
  warnings: string[];
}

/** Reads a whole Bob package (BPMN + XSDs) into the shared model. */
export async function readProcessPackage(input: BpmnPackageInput): Promise<ProcessPackage> {
  const bpmn = await readBpmn(input.bpmnText);
  const warnings = [...bpmn.warnings];
  const dataTypes = [];
  const xsdNames = Object.keys(input.xsdFiles);

  for (const name of xsdNames) {
    try {
      dataTypes.push(...readXsd(input.xsdFiles[name]));
    } catch (err) {
      warnings.push(`Cannot read XSD "${name}": ${(err as Error).message}`);
    }
  }
  for (const location of bpmn.xsdImports) {
    if (!xsdNames.some((n) => sameFile(n, location, input.bpmnFileName))) {
      warnings.push(`Imported schema "${location}" was not found in the package.`);
    }
  }

  return {
    source: {
      path: input.path,
      format: input.format,
      bpmnFile: input.bpmnFileName,
      xsdFiles: xsdNames,
      exporter: bpmn.exporter,
      exporterVersion: bpmn.exporterVersion,
      targetNamespace: bpmn.targetNamespace,
    },
    processes: bpmn.processes,
    dataTypes,
    warnings,
  };
}

/** Parses BPMN XML and maps every bpmn:process onto the shared model. */
export async function readBpmn(xml: string): Promise<BpmnReadResult> {
  // Checked before bpmn-moddle and the raw scan below parse the text.
  if (hasDoctype(xml)) throw new Error(`Invalid BPMN: ${DOCTYPE_MESSAGE}`);
  const moddle = BpmnModdle({ icp: icpDescriptor });
  let result;
  try {
    result = await moddle.fromXML(xml);
  } catch (err) {
    throw new Error(`Invalid BPMN: ${firstLine((err as Error).message)}`, { cause: err });
  }
  const definitions = result.rootElement;
  if (!definitions || definitions.$type !== 'bpmn:Definitions') {
    throw new Error('Invalid BPMN: root element is not bpmn:definitions.');
  }

  const warnings = result.warnings.filter((w) => !isHarmlessAttribute(w)).map((w) => firstLine(w.message));
  const raw = scanRaw(xml, new Set(Object.keys(result.elementsById)));
  const bounds = collectBounds(definitions, raw.shapes);

  const processes = list(definitions.rootElements)
    .filter((e) => e.$type === 'bpmn:Process')
    .map((p) => mapProcess(p, raw, bounds, warnings));

  const xsdImports = list(definitions.imports)
    .filter((i) => str(i.importType) === 'http://www.w3.org/2001/XMLSchema' && str(i.location))
    .map((i) => str(i.location));

  return {
    processes,
    exporter: opt(definitions.exporter),
    exporterVersion: opt(definitions.exporterVersion),
    targetNamespace: opt(definitions.targetNamespace),
    xsdImports,
    warnings,
  };
}

function mapProcess(
  process: ModdleElement,
  raw: RawScan,
  bounds: Map<string, Bounds>,
  warnings: string[],
): Process {
  const nodes: FlowNode[] = [];
  const flows: Flow[] = [];
  collectElements(process, undefined, nodes, flows, raw, warnings);

  const lanes: Lane[] = [];
  const collectLanes = (laneSets: unknown) => {
    for (const laneSet of list(laneSets)) {
      for (const lane of list(laneSet.lanes)) {
        const id = str(lane.id);
        const rawRefs = raw.laneRefs.get(id);
        const nodeIds = rawRefs ?? list(lane.flowNodeRef).map((n) => str(n.id));
        lanes.push({ id, name: str(lane.name), nodeIds });
        if (lane.childLaneSet) collectLanes([lane.childLaneSet]);
      }
    }
  };
  collectLanes(process.laneSets);

  // Later (nested) lanes win, so a node ends up in its innermost lane.
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const lane of lanes) {
    for (const id of lane.nodeIds) {
      const node = nodeById.get(id);
      if (node) node.laneId = lane.id;
    }
  }
  for (const node of nodes) {
    const b = bounds.get(node.id);
    if (b) node.bounds = b;
  }

  return {
    id: str(process.id),
    name: str(process.name),
    documentation: documentation(process) ?? '',
    lanes,
    nodes,
    flows,
  };
}

function collectElements(
  container: ModdleElement,
  parentId: string | undefined,
  nodes: FlowNode[],
  flows: Flow[],
  raw: RawScan,
  warnings: string[],
): void {
  for (const el of list(container.flowElements)) {
    if (el.$type === 'bpmn:SequenceFlow') {
      flows.push(mapFlow(el, raw));
    } else if (el.$instanceOf('bpmn:FlowNode')) {
      nodes.push(mapNode(el, parentId));
      if (el.$instanceOf('bpmn:SubProcess')) {
        collectElements(el, str(el.id), nodes, flows, raw, warnings);
      }
    }
    // Data objects and other non-flow-node elements are not part of the graph.
  }

  // Elements bpmn-moddle could not parse are kept as kind "unknown".
  for (const u of raw.unknownChildren.get(str(container.id)) ?? []) {
    nodes.push({
      id: u.id,
      name: u.name,
      kind: 'unknown',
      originalType: u.tag,
      documentation: u.documentation,
      inputs: [],
      outputs: [],
      ...(parentId ? { parentId } : {}),
    });
    warnings.push(`Unsupported element <${u.tag}> "${u.id}" read as kind "unknown".`);
  }
}

function mapNode(el: ModdleElement, parentId: string | undefined): FlowNode {
  const node: FlowNode = {
    id: str(el.id),
    name: str(el.name),
    kind: KIND_BY_TYPE[el.$type] ?? 'unknown',
    originalType: el.$type,
    inputs: [],
    outputs: [],
  };
  if (parentId) node.parentId = parentId;
  if (node.kind === 'subProcess' && el.triggeredByEvent === true) node.triggeredByEvent = true;

  const doc = documentation(el);
  if (doc !== undefined) node.documentation = doc;

  if (el.$type === 'bpmn:ScriptTask') {
    // Kept as written; only line ends are normalised.
    const text = typeof el.script === 'string' ? el.script.replace(/\r\n?/g, '\n') : '';
    const language = opt(el.scriptFormat);
    if (text.trim().length > 0) node.script = language ? { language, text } : { text };
  }

  if (el.$instanceOf('bpmn:Task')) {
    const serviceType = opt(el.get('icp:serviceType'));
    if (serviceType) node.serviceType = serviceType;
  }

  if (el.$instanceOf('bpmn:Activity')) {
    const performer = list(el.resources).find((r) => r.$instanceOf('bpmn:Performer'));
    if (performer) {
      const name = opt(performer.name) ?? opt((performer.resourceRef as ModdleElement | undefined)?.name);
      if (name) node.performer = name;
    }
  }

  const io = el.ioSpecification as ModdleElement | undefined;
  if (io) {
    node.inputs = list(io.dataInputs).map(mapParameter);
    node.outputs = list(io.dataOutputs).map(mapParameter);
  }
  return node;
}

function mapParameter(el: ModdleElement): DataParameter {
  const item = el.itemSubjectRef as ModdleElement | undefined;
  const typeRef = opt(item?.structureRef);
  const param: DataParameter = {
    id: str(el.id),
    name: str(el.name),
    isCollection: el.isCollection === true || item?.isCollection === true,
  };
  if (typeRef) {
    param.typeRef = typeRef;
    param.typeName = localName(typeRef);
  }
  return param;
}

function mapFlow(el: ModdleElement, raw: RawScan): Flow {
  const id = str(el.id);
  const source = el.sourceRef as ModdleElement | undefined;
  const target = el.targetRef as ModdleElement | undefined;
  const rawFlow = raw.flowRefs.get(id);
  const flow: Flow = {
    id,
    name: str(el.name),
    sourceId: source ? str(source.id) : (rawFlow?.sourceRef ?? ''),
    targetId: target ? str(target.id) : (rawFlow?.targetRef ?? ''),
    isDefault: !!source && (source.default as ModdleElement | undefined) === el,
  };
  const condition = el.conditionExpression as ModdleElement | undefined;
  const body = opt(condition?.body)?.trim();
  if (body) flow.condition = body;
  return flow;
}

function collectBounds(definitions: ModdleElement, rawShapes: Map<string, Bounds>): Map<string, Bounds> {
  const bounds = new Map(rawShapes);
  for (const diagram of list(definitions.diagrams)) {
    const plane = diagram.plane as ModdleElement | undefined;
    for (const shape of list(plane?.planeElement)) {
      if (shape.$type !== 'bpmndi:BPMNShape') continue;
      const target = shape.bpmnElement as ModdleElement | undefined;
      const b = shape.bounds as ModdleElement | undefined;
      if (target && b) {
        bounds.set(str(target.id), {
          x: Number(b.x),
          y: Number(b.y),
          width: Number(b.width),
          height: Number(b.height),
        });
      }
    }
  }
  return bounds;
}

// ---------------------------------------------------------------------------
// Raw scan: bpmn-moddle silently drops elements it does not know. A light
// pass over the plain XML recovers them (and the references to them) so they
// can be shown as kind "unknown" instead of disappearing.

interface UnknownChild {
  tag: string;
  id: string;
  name: string;
  documentation?: string;
}

interface RawScan {
  /** Unparsed children with an id, keyed by the id of their process/sub-process. */
  unknownChildren: Map<string, UnknownChild[]>;
  /** Raw sourceRef/targetRef of every sequence flow. */
  flowRefs: Map<string, { sourceRef: string; targetRef: string }>;
  /** Raw flowNodeRef ids of every lane, in document order. */
  laneRefs: Map<string, string[]>;
  /** Shapes that point at elements bpmn-moddle could not resolve. */
  shapes: Map<string, Bounds>;
}

const CONTAINERS = new Set(['process', 'subProcess', 'adHocSubProcess', 'transaction']);

type RawNode = Record<string, unknown>;

function scanRaw(xml: string, knownIds: Set<string>): RawScan {
  const scan: RawScan = { unknownChildren: new Map(), flowRefs: new Map(), laneRefs: new Map(), shapes: new Map() };
  let doc: RawNode;
  try {
    doc = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseAttributeValue: false,
      parseTagValue: false,
      isArray: (_name, _path, _isLeaf, isAttribute) => !isAttribute,
    }).parse(xml) as RawNode;
  } catch {
    return scan;
  }

  const visit = (tag: string, node: RawNode) => {
    const local = localName(tag);
    const id = attr(node, 'id');
    if (local === 'sequenceFlow' && id) {
      scan.flowRefs.set(id, { sourceRef: attr(node, 'sourceRef') ?? '', targetRef: attr(node, 'targetRef') ?? '' });
    } else if (local === 'lane' && id) {
      const refs = childEntries(node)
        .filter(([t]) => localName(t) === 'flowNodeRef')
        .map(([, v]) => text(v).trim())
        .filter((s) => s.length > 0);
      scan.laneRefs.set(id, refs);
    } else if (local === 'BPMNShape') {
      const target = attr(node, 'bpmnElement');
      const b = childEntries(node).find(([t]) => localName(t) === 'Bounds')?.[1];
      if (target && !knownIds.has(target) && b && typeof b === 'object') {
        const r = b as RawNode;
        scan.shapes.set(target, {
          x: Number(attr(r, 'x')),
          y: Number(attr(r, 'y')),
          width: Number(attr(r, 'width')),
          height: Number(attr(r, 'height')),
        });
      }
    }

    if (CONTAINERS.has(local) && id) {
      for (const [childTag, child] of childEntries(node)) {
        if (typeof child !== 'object' || child === null) continue;
        const childId = attr(child as RawNode, 'id');
        if (!childId || knownIds.has(childId)) continue;
        const docNode = childEntries(child as RawNode).find(([t]) => localName(t) === 'documentation')?.[1];
        const docText = docNode === undefined ? undefined : htmlToPlainText(text(docNode)).trim();
        const list = scan.unknownChildren.get(id) ?? [];
        list.push({
          tag: childTag,
          id: childId,
          name: attr(child as RawNode, 'name') ?? '',
          ...(docText ? { documentation: docText } : {}),
        });
        scan.unknownChildren.set(id, list);
      }
    }

    for (const [childTag, child] of childEntries(node)) {
      if (typeof child === 'object' && child !== null) visit(childTag, child as RawNode);
    }
  };

  for (const [tag, value] of childEntries(doc)) {
    if (typeof value === 'object' && value !== null) visit(tag, value as RawNode);
  }
  return scan;
}

/** Child elements of a parsed node as [tag, value] pairs (arrays flattened). */
function childEntries(node: RawNode): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_') || key === '#text' || key.startsWith('?')) continue;
    for (const v of Array.isArray(value) ? value : [value]) out.push([key, v]);
  }
  return out;
}

function attr(node: RawNode, name: string): string | undefined {
  const v = node[`@_${name}`];
  return typeof v === 'string' ? v : undefined;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const t = (value as RawNode)['#text'];
    if (Array.isArray(t)) return t.join('');
    if (typeof t === 'string') return t;
  }
  return '';
}

// ---------------------------------------------------------------------------

/**
 * Attributes bpmn-moddle reports as unknown although they are harmless.
 * `implementation` is a BPMN 2.0 attribute of service, send, receive and
 * business rule tasks; Bob also writes it on plain tasks, with the BPMN
 * default value "##unspecified" (or another "##" technology name). It says
 * nothing the viewer shows.
 */
const HARMLESS_ATTRIBUTES: ReadonlyArray<{ property: string; value: RegExp }> = [
  { property: 'implementation', value: /^##[A-Za-z]+$/ },
];

function isHarmlessAttribute(w: { message: string; property?: string; value?: unknown }): boolean {
  if (!w.message.startsWith('unknown attribute')) return false;
  return HARMLESS_ATTRIBUTES.some((a) => a.property === w.property && typeof w.value === 'string' && a.value.test(w.value));
}

function documentation(el: ModdleElement): string | undefined {
  const parts = list(el.documentation)
    .map((d) => htmlToPlainText(str(d.text)).trim())
    .filter((t) => t.length > 0);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function list(value: unknown): ModdleElement[] {
  return Array.isArray(value) ? (value as ModdleElement[]) : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function opt(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function localName(qname: string): string {
  const i = qname.indexOf(':');
  return i >= 0 ? qname.slice(i + 1) : qname;
}

function firstLine(message: string): string {
  return message.split('\n')[0];
}

/** Compares a package file name with an import location relative to the BPMN file. */
function sameFile(fileName: string, location: string, bpmnFileName: string): boolean {
  const dir = bpmnFileName.includes('/') ? bpmnFileName.slice(0, bpmnFileName.lastIndexOf('/') + 1) : '';
  const resolved = normalizePosix(dir + location.replace(/\\/g, '/'));
  return normalizePosix(fileName) === resolved;
}

function normalizePosix(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}
