// What the keyword search looks at, in one place. buildSearchIndex walks the
// model of the whole open file: every process (with the nodes inside its
// sub-processes), every service of a TWX export, called or not (its diagram,
// as the viewer draws it when the service is opened), and every business
// object. Who calls whom comes from src/model/callGraph; from it the index
// works out where each object is drawn and who calls each service and
// linked process: activities of processes and steps of services. It reads nothing new itself: processes come with the package, the
// service diagrams from the package's CalleeDiagramSource (cached there).
// Packed toolkits are not read. Pure: no vscode.
//
// With showScripts off, script text is not put in the index at all; the
// index only counts what it left out.

import { KIND_LABELS } from '../model/labels';
import { buildCallGraph, readServiceDiagrams, type CallNodeRef } from '../model/callGraph';
import type { CalledElement, CoachSummary, DataMapping, DataParameter, FlowNode, Process, ProcessPackage, ProcessVariable } from '../model/model';
import { subProcessLevels } from '../model/subProcess';
import type { SearchCaller, SearchField, SearchGroup, SearchIndex, SearchLevel, SearchObject, SearchTarget } from './search';

export interface SearchIndexOptions {
  /** lanescope.showScripts: when false, no script text is indexed. */
  showScripts: boolean;
}

class IndexBuilder {
  readonly objects: SearchObject[] = [];
  readonly groups: SearchGroup[] = [];
  readonly fields: SearchField[] = [];
  scriptsOmitted = 0;

  constructor(private readonly showScripts: boolean) {}

  object(o: SearchObject): number {
    this.objects.push(o);
    return this.objects.length - 1;
  }

  group(object: number, target: SearchTarget, kind: string, name: string, where: string[]): number {
    this.groups.push({ object, target, kind, name, where });
    return this.groups.length - 1;
  }

  add(group: number, label: string, text: string | undefined, extra: Pick<SearchField, 'isName' | 'dataField'> = {}): void {
    if (text === undefined || text.trim() === '') return;
    this.fields.push({ group, label, text, ...extra });
  }

  script(group: number, label: string, text: string | undefined): void {
    if (text === undefined || text.trim() === '') return;
    if (!this.showScripts) {
      this.scriptsOmitted++;
      return;
    }
    this.add(group, label, text);
  }
}

/** The search index of a whole package: processes, services and business objects. */
export async function buildSearchIndex(pkg: ProcessPackage, options: SearchIndexOptions): Promise<SearchIndex> {
  const b = new IndexBuilder(options.showScripts);
  const services = await readServiceDiagrams(pkg);
  const graph = await buildCallGraph(pkg, services);

  // A service opens below the first activity of a process that calls it, else on its own.
  const levelOf = (ref: CallNodeRef): SearchLevel => {
    if (ref.kind === 'process') return { processId: ref.id, below: [] };
    const c = graph.callers(ref).find((s) => s.from.kind === 'process');
    return c ? { processId: c.from.id, below: [...c.levels, ref.id] } : { serviceId: ref.id, below: [] };
  };
  const callersOf = (ref: CallNodeRef): SearchCaller[] =>
    graph.callers(ref).map((site) => {
      const owner = levelOf(site.from);
      return {
        via: site.from.kind,
        ownerId: site.from.id,
        ownerName: graph.node(site.from)?.name ?? site.from.id,
        nodeId: site.nodeId,
        name: site.name,
        levels: site.levels,
        level: { ...owner, below: [...owner.below, ...site.levels] },
      };
    });
  /** The services a diagram calls directly, which the "Shown process" scope takes in. */
  const callsOf = (ref: CallNodeRef) => [...new Set(graph.callees(ref).filter((s) => s.to.kind === 'service').map((s) => s.to.id))];

  for (const process of pkg.processes) {
    const ref: CallNodeRef = { kind: 'process', id: process.id };
    const callers = callersOf(ref);
    const o = b.object({
      kind: 'process',
      label: 'Process',
      name: process.name || process.id,
      id: process.id,
      levelId: process.originalId ?? process.id,
      ...(callers.length > 0 ? { calledBy: callers } : {}),
      level: levelOf(ref),
      calls: callsOf(ref),
    });
    indexProcess(b, o, process, 'Process');
  }

  for (const { entry, diagram } of services) {
    const ref: CallNodeRef = { kind: 'service', id: entry.id };
    const o = b.object({
      kind: 'service',
      label: entry.kind,
      name: entry.name,
      id: entry.id,
      levelId: entry.id,
      calledBy: callersOf(ref),
      openable: diagram !== undefined,
      ...(diagram ? { level: levelOf(ref), calls: callsOf(ref) } : {}),
    });
    if (diagram) {
      indexProcess(b, o, diagram, entry.kind);
    } else {
      const g = b.group(o, { type: 'root' }, entry.kind, entry.name, []);
      b.add(g, 'Name', entry.name, { isName: true });
    }
  }

  for (const t of pkg.dataTypes) {
    const o = b.object({ kind: 'dataType', label: 'Business object', name: t.name, id: t.name });
    const g = b.group(o, { type: 'dataType', name: t.name }, 'Business object', t.name, []);
    b.add(g, 'Name', t.name, { isName: true });
    b.add(g, 'Documentation', t.documentation);
    for (const f of t.fields) b.add(g, 'Field', `${f.name} : ${f.type}${f.list ? '[]' : ''}`, { dataField: f.name });
  }
  return {
    objects: b.objects,
    groups: b.groups,
    fields: b.fields,
    scriptsOmitted: b.scriptsOmitted,
    toolkitsNotSearched: (pkg.source.twx?.packedToolkits ?? 0) > 0,
  };
}

/** The nodes, flows and data of one diagram (a process or a service), as groups of object `o`. */
function indexProcess(b: IndexBuilder, o: number, process: Process, kindLabel: string): void {
  const nodeById = new Map(process.nodes.map((n) => [n.id, n]));
  const laneName = new Map([...process.lanes, ...process.nodes.flatMap((n) => n.lanes ?? [])].map((l) => [l.id, l.name]));
  const levelsOf = (node: FlowNode | undefined) => (node ? subProcessLevels(process, node) : []);
  /** Names of the sub-processes around a node, outermost first. */
  const whereOf = (node: FlowNode | undefined): string[] => {
    const names: string[] = [];
    const seen = new Set<string>();
    let parent = node?.parentId !== undefined ? nodeById.get(node.parentId) : undefined;
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      names.unshift(parent.name || parent.id);
      parent = parent.parentId !== undefined ? nodeById.get(parent.parentId) : undefined;
    }
    return names;
  };

  for (const node of process.nodes) {
    const g = b.group(o, { type: 'node', id: node.id, levels: levelsOf(node) }, KIND_LABELS[node.kind], node.name, whereOf(node));
    b.add(g, 'Name', node.name, { isName: true });
    b.add(g, 'Documentation', node.documentation);
    b.add(g, 'Lane', node.laneId !== undefined ? laneName.get(node.laneId) : undefined);
    b.add(g, 'Performer', node.performer);
    if (node.calledElement) b.add(g, 'Calls', calledName(node.calledElement));
    b.script(g, 'Script', node.script?.text);
    addParameters(b, g, node.inputs, node.outputs, node.inputMappings, node.outputMappings);
    if (node.userTask) {
      b.add(g, 'Assignment', node.userTask.assignment);
      b.add(g, 'Priority', node.userTask.priority);
      b.add(g, 'Due date', node.userTask.dueDate);
      b.add(g, 'Subject', node.userTask.subject);
    }
    if (node.timer) b.add(g, 'Timer', node.timer.unit ? `${node.timer.duration} ${node.timer.unit}` : node.timer.duration);
    if (node.restOperation) {
      b.add(g, 'REST service', node.restOperation.service);
      b.add(g, 'Operation', node.restOperation.operation);
    }
    if (node.coach) addCoach(b, g, node.coach);
    b.add(g, 'Event', node.eventType);
    b.add(g, 'Catches', node.errorEvent?.errorCode);
  }

  for (const flow of process.flows) {
    const source = nodeById.get(flow.sourceId);
    const g = b.group(o, { type: 'flow', id: flow.id, levels: levelsOf(source) }, flow.isDefault ? 'Default flow' : 'Sequence flow', flow.name, whereOf(source));
    b.add(g, 'Name', flow.name, { isName: true });
    b.add(g, 'Condition', flow.condition);
  }

  const g = b.group(o, { type: 'root' }, kindLabel, process.name, []);
  b.add(g, 'Name', process.name, { isName: true });
  b.add(g, 'Documentation', process.documentation);
  for (const v of process.variables ?? []) b.add(g, 'Variable', variableText(v));
  for (const p of process.inputs ?? []) b.add(g, 'Input', parameterText(p));
  for (const p of process.outputs ?? []) b.add(g, 'Output', parameterText(p));
}

/** A call's mappings (every parameter of the callee) replace its plain parameter list, as in the panel. */
function addParameters(
  b: IndexBuilder,
  g: number,
  inputs: DataParameter[],
  outputs: DataParameter[],
  inputMappings: DataMapping[] | undefined,
  outputMappings: DataMapping[] | undefined,
): void {
  if (inputMappings) for (const m of inputMappings) b.add(g, 'Input mapping', inputMappingText(m));
  else for (const p of inputs) b.add(g, 'Input', parameterText(p));
  if (outputMappings) for (const m of outputMappings) b.add(g, 'Output mapping', outputMappingText(m));
  else for (const p of outputs) b.add(g, 'Output', parameterText(p));
}

function addCoach(b: IndexBuilder, g: number, coach: CoachSummary): void {
  for (const k of coach.controls) {
    b.add(g, 'Control', k.label ?? k.id);
    b.add(g, 'Control type', k.type);
    b.add(g, 'Binding', k.binding);
  }
}

function calledName(c: CalledElement): string {
  return c.name ?? c.id;
}

/** "customerId = tw.local.order.customerId", "customerId: not mapped". */
function inputMappingText(m: DataMapping): string {
  if (!m.mapped) return `${m.parameter}: not mapped`;
  return `${m.parameter} = ${m.literal ? `"${m.value ?? ''}"` : (m.value ?? '')}`;
}

/** "result → tw.local.result", "result: not mapped". */
function outputMappingText(m: DataMapping): string {
  return m.mapped ? `${m.parameter} → ${m.value ?? ''}` : `${m.parameter}: not mapped`;
}

function parameterText(p: DataParameter): string {
  const type = p.typeName ?? p.typeRef;
  return `${p.name || p.id}${type ? ` : ${type}${p.isCollection ? '[]' : ''}` : ''}`;
}

function variableText(v: ProcessVariable): string {
  const type = v.typeName ?? v.typeRef;
  const base = `${v.name}${type ? ` : ${type}${v.isCollection ? '[]' : ''}` : ''}`;
  return v.defaultValue !== undefined ? `${base} = ${v.defaultValue}` : base;
}
