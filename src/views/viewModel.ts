// Turns a ProcessPackage into the messages the webview draws. Pure: no
// vscode, no file access, so it is unit-testable in plain Node.

import * as path from 'node:path';
import type {
  CalledElement,
  CalleeInternals,
  CalleeStep,
  CoachSummary,
  DataMapping,
  DataParameter,
  Flow,
  FlowNode,
  Process,
  ProcessPackage,
  ProcessVariable,
} from '../model/model';
import { toDiagramXml } from '../bpmn/toDiagramXml';
import { KIND_LABELS } from '../model/labels';
import { validateProcess } from '../validate/validate';
import {
  DEFAULT_VIEWER_SETTINGS,
  type CalleeDetails,
  type CalleeStepDetails,
  type CoachDetails,
  type ElementDetails,
  type LevelSummary,
  type ErrorMessage,
  type MappingDetails,
  type NodeDetails,
  type OutgoingFlowDetails,
  type ParameterDetails,
  type RenderMessage,
  type ScriptDetails,
  type VariableDetails,
  type ViewerSettings,
  type ViewOptions,
} from './protocol';

/** A level below the chosen process: what to draw instead of it, and the breadcrumb. */
export interface LevelView {
  /** The diagram to draw: a service, or a linked process. */
  process: Process;
  /** Every open level, the chosen process first and `process` last. */
  path: LevelSummary[];
  /** Problems found while reading this diagram. */
  warnings?: string[];
  note?: string;
}

/** The level id of a process of a package (see ./navigation). */
export function processLevelId(process: Process): string {
  return process.originalId ?? process.id;
}

/** "Process", "Service flow", "Client-side human service". */
export function processKindLabel(process: Process): string {
  if (process.source?.kind === 'serviceFlow') return 'Service flow';
  if (process.source?.kind === 'humanService') return 'Client-side human service';
  return 'Process';
}

export function levelSummary(process: Process): LevelSummary {
  return { id: processLevelId(process), name: process.name || process.id, kind: processKindLabel(process) };
}

/**
 * Lays out one process of a package and builds the render message: the one
 * with `processId`, or the first when that id is not (or no longer) there.
 * With `level`, its diagram is drawn instead (a service or linked process
 * opened from a call); `processId` stays the chosen process. With
 * `settings.showScripts` false, no script text is put in the message, at
 * any level.
 */
export async function buildRenderMessage(
  pkg: ProcessPackage,
  options: ViewOptions,
  preserveView = false,
  /** When the package was read from disk (epoch milliseconds). */
  loadedAt = Date.now(),
  processId?: string,
  settings: ViewerSettings = DEFAULT_VIEWER_SETTINGS,
  level?: LevelView,
): Promise<RenderMessage> {
  const root = pkg.processes.find((p) => p.id === processId) ?? pkg.processes[0];
  if (!root) {
    throw new Error('The BPMN file does not contain a process.');
  }
  const process = level?.process ?? root;
  const diagram = await toDiagramXml(process, {
    hideGeneratedFlowLabels: options.hideGeneratedFlowLabels,
    hideEmptyLanes: options.hideEmptyLanes,
  });
  const { layout } = diagram;

  const nodeById = new Map(process.nodes.map((n) => [n.id, n]));
  const laneById = new Map(process.lanes.map((l) => [l.id, l]));
  const elements: Record<string, ElementDetails> = {};
  // The inside of a called service is sent once, however many activities call it.
  const callees: Record<string, CalleeDetails> = {};
  const processByCalledId = new Map(pkg.processes.map((p) => [p.originalId ?? p.id, p.id]));

  const outgoingBySource = new Map<string, Flow[]>();
  for (const flow of process.flows) {
    if (layout.hiddenFlowIds.has(flow.id)) continue;
    const list = outgoingBySource.get(flow.sourceId) ?? [];
    list.push(flow);
    outgoingBySource.set(flow.sourceId, list);
  }

  for (const node of process.nodes) {
    if (layout.hiddenNodeIds.has(node.id)) continue;
    const lane = node.laneId !== undefined ? (laneById.get(node.laneId)?.name ?? node.laneId) : undefined;
    const details: NodeDetails = {
      kind: 'node',
      id: node.id,
      originalId: node.originalId,
      name: node.name,
      bpmnKind: KIND_LABELS[node.kind],
      originalType: node.originalType,
      serviceType: node.serviceType,
      calls: node.calledElement ? calledLabel(node.calledElement) : undefined,
      lane,
      performer: node.performer,
      documentation: node.documentation,
      inputs: node.inputs.map(parameter),
      outputs: node.outputs.map(parameter),
    };
    if (node.script) details.script = scriptDetails(node.script, settings);
    if (node.inputMappings) details.inputMappings = node.inputMappings.map((m) => mapping(m, node.inputs));
    if (node.outputMappings) details.outputMappings = node.outputMappings.map((m) => mapping(m, node.outputs));
    if (node.userTask) {
      details.userTask = { ...node.userTask, ...(lane ? { lane } : {}), ...(node.performer ? { performer: node.performer } : {}) };
    }
    if (node.timer) details.timer = { ...node.timer };
    const called = node.calledElement;
    if (called?.internals) {
      callees[called.id] ??= calleeDetails(called, called.internals, settings);
      details.callee = called.id;
    }
    const linked = called?.id.startsWith('25.') ? processByCalledId.get(called.id) : undefined;
    if (linked !== undefined) details.openProcessId = linked;
    Object.assign(details, openability(node, pkg, linked !== undefined));
    if (node.restOperation) {
      details.rest = { service: node.restOperation.service, ...(node.restOperation.operation ? { operation: node.restOperation.operation } : {}) };
    }
    if (node.coach) details.coach = coachDetails(node.coach);
    if (node.eventType) details.eventType = node.eventType;
    if (node.attachedToId !== undefined) {
      const host = nodeById.get(node.attachedToId);
      details.boundary = {
        attachedTo: host?.name || node.attachedToId,
        ...(node.errorEvent?.catchAll !== undefined ? { catchAll: node.errorEvent.catchAll } : {}),
        ...(node.errorEvent?.errorCode !== undefined ? { errorCode: node.errorEvent.errorCode } : {}),
      };
    }
    const outgoing = gatewayOutgoing(node, outgoingBySource.get(node.id) ?? [], (id) => nodeById.get(id)?.name || id);
    if (outgoing) details.outgoing = outgoing;
    elements[node.id] = details;
  }
  for (const flow of process.flows) {
    if (layout.hiddenFlowIds.has(flow.id)) continue;
    elements[flow.id] = {
      kind: 'flow',
      id: flow.id,
      originalId: flow.originalId,
      name: flow.name,
      labelHidden: flow.name.trim().length > 0 && !layout.flowLabels.has(flow.id),
      source: nodeById.get(flow.sourceId)?.name || flow.sourceId,
      target: nodeById.get(flow.targetId)?.name || flow.targetId,
      condition: flow.condition,
      isDefault: flow.isDefault,
    };
  }
  for (const lane of layout.lanes) {
    const nodeCount = process.nodes.filter(
      (n) => !layout.hiddenNodeIds.has(n.id) && (lane.synthetic ? !laneById.has(n.laneId ?? '') : n.laneId === lane.id),
    ).length;
    const original = laneById.get(lane.id)?.originalId;
    elements[lane.id] = { kind: 'lane', id: lane.id, ...(original ? { originalId: original } : {}), name: lane.name, nodeCount };
  }

  // The validation rules are about processes (BPDs, Bob output); service diagrams are not checked.
  const isProcess = (process.source?.kind ?? 'bpd') === 'bpd';
  const issues = isProcess ? validateProcess(process).map((i) => i.message) : [];
  const warnings = [...pkg.warnings, ...(level?.warnings ?? []), ...issues, ...diagram.warnings];

  return {
    type: 'render',
    xml: diagram.xml,
    options: { ...options },
    preserveView,
    process: {
      id: process.id,
      kind: processKindLabel(process),
      originalId: process.originalId,
      name: process.name,
      documentation: process.documentation,
      sourceFile:
        pkg.source.format === 'zip'
          ? `${path.basename(pkg.source.path)} / ${pkg.source.bpmnFile}`
          : path.basename(pkg.source.path),
      exporter: pkg.source.exporter
        ? `${pkg.source.exporter}${pkg.source.exporterVersion ? ` ${pkg.source.exporterVersion}` : ''}`
        : undefined,
      ...twxSummary(pkg),
      ...(process.variables ? { variables: process.variables.map(variable) } : {}),
      ...(process.inputs ? { inputs: process.inputs.map(parameter) } : {}),
      ...(process.outputs ? { outputs: process.outputs.map(parameter) } : {}),
    },
    processes: pkg.processes.map((p) => ({ id: p.id, name: p.name || p.id })),
    rootProcessId: root.id,
    path: level?.path ?? [levelSummary(root)],
    ...(level?.note ? { note: level.note } : {}),
    elements,
    callees,
    dataTypes: pkg.dataTypes,
    warnings: [...new Set(warnings)],
    loadedAt,
  };
}

/** A readable error for the editor instead of a blank page. */
export function buildErrorMessage(fileName: string, err: unknown): ErrorMessage {
  const message = err instanceof Error ? err.message : String(err);
  return { type: 'error', title: `Cannot show ${fileName}`, message };
}

function twxSummary(pkg: ProcessPackage): { app?: string; toolkits?: string[] } {
  const twx = pkg.source.twx;
  if (!twx) return {};
  const app = [twx.app, twx.snapshot].filter((s) => s).join(' / ');
  const toolkits = [...twx.toolkits];
  if (twx.packedToolkits > 0) toolkits.push(`(${twx.packedToolkits} packed in the export, not read)`);
  return { ...(app ? { app } : {}), ...(toolkits.length > 0 ? { toolkits } : {}) };
}

function calledLabel(c: CalledElement): string {
  if (c.name === undefined) return `${c.id} (not in the export)`;
  return c.kind ? `${c.name} (${c.kind})` : c.name;
}

/** The inside of a called service, as the panel shows it; script text only when showScripts is on. */
function calleeDetails(called: CalledElement, inside: CalleeInternals, settings: ViewerSettings): CalleeDetails {
  const out: CalleeDetails = {
    name: called.name ?? called.id,
    ...(called.kind ? { kind: called.kind } : {}),
    // Start events and plain end events frame every service; they are not listed.
    steps: inside.steps.filter((s) => !(s.kind === 'start' || (s.kind === 'end' && s.eventType === undefined))).map((s) => stepDetails(s, settings)),
  };
  if (inside.variables) out.variables = inside.variables.map(variable);
  if (inside.inputs) out.inputs = inside.inputs.map(parameter);
  if (inside.outputs) out.outputs = inside.outputs.map(parameter);
  if (inside.coaches) out.coaches = inside.coaches.map(coachDetails);
  return out;
}

function coachDetails(c: CoachSummary): CoachDetails {
  return {
    name: c.name,
    controls: c.controls.map((k) => ({
      id: k.id,
      ...(k.label !== undefined ? { label: k.label } : {}),
      ...(k.type !== undefined ? { type: k.type } : {}),
      ...(k.binding !== undefined ? { binding: k.binding } : {}),
    })),
  };
}

/** Whether a call opens as a diagram (openCallee), or why it does not (openUnavailable). */
function openability(node: FlowNode, pkg: ProcessPackage, linked: boolean): Pick<NodeDetails, 'openCallee' | 'openUnavailable'> {
  if (node.restOperation) return { openUnavailable: 'External service' };
  const called = node.calledElement;
  if (!called) return {};
  if (called.id.startsWith('25.')) return linked ? { openCallee: called.id } : { openUnavailable: 'Not in this export' };
  // Bob output names services it cannot open: nothing to say there.
  if (!pkg.calleeDiagrams) return {};
  const o = pkg.calleeDiagrams.openability(called.id);
  return o.openable ? { openCallee: called.id } : { openUnavailable: o.reason };
}

function stepDetails(s: CalleeStep, settings: ViewerSettings): CalleeStepDetails {
  const out: CalleeStepDetails = { name: s.name, kind: s.kind };
  if (s.script) out.script = scriptDetails(s.script, settings);
  if (s.kind === 'call' && s.calledId !== undefined) {
    out.calls = calledLabel({ id: s.calledId, name: s.calledName, kind: s.calledKind });
  }
  if (s.inputMappings) out.inputMappings = s.inputMappings.map((m) => mapping(m, s.inputs ?? []));
  if (s.outputMappings) out.outputMappings = s.outputMappings.map((m) => mapping(m, s.outputs ?? []));
  if (s.restOperation) {
    out.rest = { service: s.restOperation.service, ...(s.restOperation.operation ? { operation: s.restOperation.operation } : {}) };
  }
  if (s.conditions) out.conditions = s.conditions.map((c) => ({ ...c }));
  if (s.errorBoundaries) {
    out.errorBoundaries = s.errorBoundaries.map((b) => ({
      name: b.name,
      catchAll: b.catchAll,
      ...(b.errorCode !== undefined ? { errorCode: b.errorCode } : {}),
      ...(b.to !== undefined ? { to: b.to } : {}),
    }));
  }
  if (s.eventType) out.eventType = s.eventType;
  return out;
}

function scriptDetails(script: NonNullable<FlowNode['script']>, settings: ViewerSettings): ScriptDetails {
  // Hidden scripts are dropped here, on the host: the text never reaches the webview.
  if (!settings.showScripts) return { hidden: true };
  return {
    hidden: false,
    ...(script.language ? { language: script.language } : {}),
    text: script.text,
    lineCount: script.text.split('\n').length,
  };
}

/** A mapping row, typed by the callee's parameter it names. */
function mapping(m: DataMapping, signature: DataParameter[]): MappingDetails {
  const param = m.parameterId !== undefined ? signature.find((p) => p.id === m.parameterId) : undefined;
  const type = param ? (param.typeName ?? param.typeRef) : undefined;
  return {
    parameter: m.parameter,
    ...(type ? { type } : {}),
    isCollection: param?.isCollection ?? false,
    ...(m.value !== undefined ? { value: m.value } : {}),
    mapped: m.mapped,
    literal: m.literal,
  };
}

/** Outgoing flows of a gateway, when the source gives one of them a condition or makes it the default. */
function gatewayOutgoing(node: FlowNode, flows: Flow[], nameOf: (id: string) => string): OutgoingFlowDetails[] | undefined {
  if (!node.kind.endsWith('Gateway')) return undefined;
  if (!flows.some((f) => f.condition !== undefined || f.isDefault)) return undefined;
  return flows.map((f) => ({
    flowId: f.id,
    target: nameOf(f.targetId),
    ...(f.condition !== undefined ? { condition: f.condition } : {}),
    isDefault: f.isDefault,
  }));
}

function variable(v: ProcessVariable): VariableDetails {
  const type = v.typeName ?? v.typeRef;
  return {
    name: v.name,
    ...(type ? { type } : {}),
    isCollection: v.isCollection,
    ...(v.defaultValue !== undefined ? { defaultValue: v.defaultValue } : {}),
    tracked: v.tracked,
  };
}

function parameter(p: DataParameter): ParameterDetails {
  return { name: p.name || p.id, type: p.typeName ?? p.typeRef, isCollection: p.isCollection };
}
