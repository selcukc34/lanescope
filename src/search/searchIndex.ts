// What the keyword search looks at, in one place. buildSearchIndex walks the
// model the details panel shows (src/views/viewModel builds the panel from
// the same fields) and lists every text of the chosen process: its nodes and
// flows, the nodes inside its sub-processes, the inside of the services it
// calls (one level deep, as read with the package), its variables and the
// business objects of the package. It reads nothing itself. Pure: no vscode.
//
// With showScripts off, script text is not put in the index at all, so it
// never reaches the webview (SECURITY.md); the index only counts what it left out.

import { KIND_LABELS } from '../model/labels';
import type {
  CalledElement,
  CalleeInternals,
  CalleeStep,
  CoachSummary,
  DataMapping,
  DataParameter,
  FlowNode,
  Process,
  ProcessPackage,
  ProcessVariable,
} from '../model/model';
import { subProcessLevels } from '../model/subProcess';
import type { SearchField, SearchGroup, SearchIndex, SearchOpen, SearchTarget } from './search';

export interface SearchIndexOptions {
  /** The chosen process; the first one of the package when undefined or not there. */
  processId?: string;
  /** lanescope.showScripts: when false, no script text is indexed. */
  showScripts: boolean;
}

/** Kind of the group that holds the inside of a called service. */
export const INSIDE_SERVICE = 'Inside service';

class IndexBuilder {
  readonly groups: SearchGroup[] = [];
  readonly fields: SearchField[] = [];
  scriptsOmitted = 0;

  constructor(private readonly showScripts: boolean) {}

  group(target: SearchTarget, kind: string, name: string, where: string[], extra: Pick<SearchGroup, 'caller' | 'open'> = {}): number {
    this.groups.push({ target, kind, name, where, ...extra });
    return this.groups.length - 1;
  }

  add(group: number, label: string, text: string | undefined, extra: Pick<SearchField, 'isName' | 'open'> = {}): void {
    if (text === undefined || text.trim() === '') return;
    this.fields.push({ group, label, text, ...extra });
  }

  script(group: number, label: string, text: string | undefined, open?: SearchOpen): void {
    if (text === undefined || text.trim() === '') return;
    if (!this.showScripts) {
      this.scriptsOmitted++;
      return;
    }
    this.add(group, label, text, open ? { open } : {});
  }
}

/** The search index of one process of a package (the one the viewer shows). */
export function buildSearchIndex(pkg: ProcessPackage, options: SearchIndexOptions): SearchIndex {
  const b = new IndexBuilder(options.showScripts);
  const process = pkg.processes.find((p) => p.id === options.processId) ?? pkg.processes[0];
  if (process) indexProcess(b, pkg, process);
  for (const t of pkg.dataTypes) {
    const g = b.group({ type: 'dataType', name: t.name }, 'Business object', t.name, []);
    b.add(g, 'Name', t.name, { isName: true });
    b.add(g, 'Documentation', t.documentation);
    for (const f of t.fields) b.add(g, 'Field', `${f.name} : ${f.type}${f.list ? '[]' : ''}`);
  }
  return { groups: b.groups, fields: b.fields, scriptsOmitted: b.scriptsOmitted, otherProcesses: pkg.processes.length > 1 };
}

function indexProcess(b: IndexBuilder, pkg: ProcessPackage, process: Process): void {
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
    const target: SearchTarget = { type: 'node', id: node.id, levels: levelsOf(node) };
    const where = whereOf(node);
    const g = b.group(target, KIND_LABELS[node.kind], node.name, where);
    b.add(g, 'Name', node.name, { isName: true });
    b.add(g, 'Documentation', node.documentation);
    b.add(g, 'Lane', node.laneId !== undefined ? laneName.get(node.laneId) : undefined);
    b.add(g, 'Performer', node.performer);
    if (node.calledElement) b.add(g, 'Calls', calledName(node.calledElement));
    b.script(g, 'Script', node.script?.text);
    addParameters(b, g, '', node.inputs, node.outputs, node.inputMappings, node.outputMappings);
    if (node.userTask) {
      b.add(g, 'Assignment', node.userTask.assignment);
      b.add(g, 'Priority', node.userTask.priority);
      b.add(g, 'Due date', node.userTask.dueDate);
      b.add(g, 'Subject', node.userTask.subject);
    }
    if (node.timer) b.add(g, 'Timer', node.timer.unit ? `${node.timer.duration} ${node.timer.unit}` : node.timer.duration);
    if (node.restOperation) {
      b.add(g, 'Service', node.restOperation.service);
      b.add(g, 'Operation', node.restOperation.operation);
    }
    if (node.coach) addCoach(b, g, '', node.coach);
    b.add(g, 'Event', node.eventType);
    b.add(g, 'Catches', node.errorEvent?.errorCode);

    const inside = node.calledElement?.internals;
    if (inside) indexInside(b, pkg, node.calledElement!, inside, target, node.name, where);
  }

  for (const flow of process.flows) {
    const source = nodeById.get(flow.sourceId);
    const g = b.group({ type: 'flow', id: flow.id, levels: levelsOf(source) }, flow.isDefault ? 'Default flow' : 'Sequence flow', flow.name, whereOf(source));
    b.add(g, 'Name', flow.name, { isName: true });
    b.add(g, 'Condition', flow.condition);
  }

  const g = b.group({ type: 'process' }, 'Process', process.name, []);
  b.add(g, 'Name', process.name, { isName: true });
  b.add(g, 'Documentation', process.documentation);
  for (const v of process.variables ?? []) b.add(g, 'Variable', variableText(v));
  for (const p of process.inputs ?? []) b.add(g, 'Input', parameterText(p));
  for (const p of process.outputs ?? []) b.add(g, 'Output', parameterText(p));
}

/** The inside of a called service, as a group of the activity that calls it. */
function indexInside(
  b: IndexBuilder,
  pkg: ProcessPackage,
  called: CalledElement,
  inside: CalleeInternals,
  caller: SearchTarget,
  callerName: string,
  where: string[],
): void {
  // The steps open in the service's diagram when it can be drawn.
  const levelId = pkg.calleeDiagrams?.openability(called.id).openable ? called.id : undefined;
  const g = b.group(caller, INSIDE_SERVICE, calledName(called), where, {
    caller: callerName || '(unnamed)',
    ...(levelId !== undefined ? { open: { levelId } } : {}),
  });
  const open = (stepId?: string): SearchOpen | undefined =>
    levelId === undefined ? undefined : { levelId, ...(stepId !== undefined ? { stepId } : {}) };
  const opened = (stepId?: string) => {
    const o = open(stepId);
    return o ? { open: o } : {};
  };

  for (const s of inside.steps) {
    // Start events and plain end events frame every service; the panel does not list them either.
    if (s.kind === 'start' || (s.kind === 'end' && s.eventType === undefined)) continue;
    const step = `Step "${s.name || s.id}"`;
    b.add(g, 'Step', s.name, opened(s.id));
    b.script(g, `${step} · Script`, s.script?.text, open(s.id));
    if (s.kind === 'call') b.add(g, `${step} · Calls`, s.calledName ?? s.calledId, opened(s.id));
    addStepMappings(b, g, step, s, open(s.id));
    if (s.restOperation) {
      b.add(g, `${step} · REST service`, s.restOperation.service, opened(s.id));
      b.add(g, `${step} · Operation`, s.restOperation.operation, opened(s.id));
    }
    for (const c of s.conditions ?? []) b.add(g, `${step} · Condition to ${c.to}`, c.condition, opened(s.id));
    for (const e of s.errorBoundaries ?? []) {
      b.add(g, `${step} · Error boundary`, e.name, opened(e.id));
      b.add(g, `${step} · Catches`, e.errorCode, opened(e.id));
    }
    b.add(g, `${step} · Event`, s.eventType, opened(s.id));
  }
  for (const c of inside.coaches ?? []) addCoach(b, g, `Coach "${c.name || c.id}" · `, c, open(c.id));
  for (const v of inside.variables ?? []) b.add(g, 'Service variable', variableText(v), opened());
  for (const p of inside.inputs ?? []) b.add(g, 'Service input', parameterText(p), opened());
  for (const p of inside.outputs ?? []) b.add(g, 'Service output', parameterText(p), opened());
}

function addStepMappings(b: IndexBuilder, g: number, step: string, s: CalleeStep, open: SearchOpen | undefined): void {
  const extra = open ? { open } : {};
  for (const m of s.inputMappings ?? []) b.add(g, `${step} · Input mapping`, inputMappingText(m), extra);
  for (const m of s.outputMappings ?? []) b.add(g, `${step} · Output mapping`, outputMappingText(m), extra);
}

/** A call's mappings (every parameter of the callee) replace its plain parameter list, as in the panel. */
function addParameters(
  b: IndexBuilder,
  g: number,
  prefix: string,
  inputs: DataParameter[],
  outputs: DataParameter[],
  inputMappings: DataMapping[] | undefined,
  outputMappings: DataMapping[] | undefined,
): void {
  if (inputMappings) for (const m of inputMappings) b.add(g, `${prefix}Input mapping`, inputMappingText(m));
  else for (const p of inputs) b.add(g, `${prefix}Input`, parameterText(p));
  if (outputMappings) for (const m of outputMappings) b.add(g, `${prefix}Output mapping`, outputMappingText(m));
  else for (const p of outputs) b.add(g, `${prefix}Output`, parameterText(p));
}

function addCoach(b: IndexBuilder, g: number, prefix: string, coach: CoachSummary, open?: SearchOpen): void {
  const extra = open ? { open } : {};
  if (prefix !== '') b.add(g, 'Coach', coach.name, extra);
  for (const k of coach.controls) {
    b.add(g, `${prefix}Control`, k.label ?? k.id, extra);
    b.add(g, `${prefix}Control type`, k.type, extra);
    b.add(g, `${prefix}Binding`, k.binding, extra);
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
