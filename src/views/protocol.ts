// Messages exchanged between the extension host and the webview. Types only:
// this file is imported by both sides and must not import `vscode` or DOM code.

import type { DiffEntry, DiffMark } from '../diff/diff';
import type { CalleeStepKind, DataType } from '../model/model';
import type { TraceCounts, TraceRow } from '../trace/trace';
import { MAX_PATH_DEPTH } from './navigation';

/** Display options the user can toggle in the webview toolbar. */
export interface ViewOptions {
  hideGeneratedFlowLabels: boolean;
  /** The inverse of the toolbar's "Show empty lanes" toggle. */
  hideEmptyLanes: boolean;
  /** Mark added and changed elements of the comparison in the diagram (the Changes tab is there either way). */
  highlightChanges: boolean;
}

export const DEFAULT_VIEW_OPTIONS: ViewOptions = {
  hideGeneratedFlowLabels: true,
  hideEmptyLanes: true,
  highlightChanges: true,
};

/**
 * Options a viewer starts with, by input format: a TWX shows its empty lanes,
 * as BAW draws them; Bob output hides them (the Warnings tab names them).
 */
export function defaultViewOptions(format: 'bpmn' | 'zip' | 'twx'): ViewOptions {
  return { ...DEFAULT_VIEW_OPTIONS, hideEmptyLanes: format !== 'twx' };
}

/** Extension settings that change what the host sends (not toggled in the webview). */
export interface ViewerSettings {
  /** lanescope.showScripts: when false, script text never leaves the extension host. */
  showScripts: boolean;
}

export const DEFAULT_VIEWER_SETTINGS: ViewerSettings = {
  showScripts: true,
};

export interface ParameterDetails {
  name: string;
  /** Type name as shown, e.g. "OrderRequest" (falls back to the raw type reference). */
  type?: string;
  isCollection: boolean;
}

/** Script of a script task, or a marker that the showScripts setting withholds it. */
export type ScriptDetails =
  | { hidden: false; language?: string; text: string; lineCount: number }
  | { hidden: true };

/** One parameter of a call and what the caller maps to (input) or from (output) it. */
export interface MappingDetails {
  parameter: string;
  /** Type of the callee's parameter, when the signature is in the export. */
  type?: string;
  isCollection: boolean;
  /** Input: the mapped value (a literal without its quotes). Output: the target. */
  value?: string;
  mapped: boolean;
  literal: boolean;
}

export interface UserTaskDetails {
  assignment?: string;
  lane?: string;
  performer?: string;
  priority?: string;
  dueDate?: string;
  subject?: string;
}

export interface TimerDetails {
  duration: string;
  unit?: string;
  interrupting?: boolean;
  repeating?: boolean;
}

/** One outgoing flow of a gateway. */
export interface OutgoingFlowDetails {
  flowId: string;
  target: string;
  condition?: string;
  isDefault: boolean;
}

export interface VariableDetails {
  name: string;
  type?: string;
  isCollection: boolean;
  defaultValue?: string;
  tracked: boolean;
}

/** One step inside a called service. Start events and plain end events are left out. */
export interface CalleeStepDetails {
  name: string;
  kind: CalleeStepKind;
  /** Script steps; a hidden marker when showScripts is off. */
  script?: ScriptDetails;
  /** Call steps: what the step calls, e.g. "Service flowDB Connection (Service flow)". */
  calls?: string;
  inputMappings?: MappingDetails[];
  outputMappings?: MappingDetails[];
  /** REST steps: the external service and its operation. */
  rest?: { service: string; operation?: string };
  /** Gateways: every outgoing flow, in document order. */
  conditions?: Array<{ to: string; condition?: string; isDefault: boolean }>;
  errorBoundaries?: Array<{ name: string; catchAll: boolean; errorCode?: string; to?: string }>;
  /** Events and error end events, e.g. "Stay on page", "Error". */
  eventType?: string;
}

export interface CoachDetails {
  name: string;
  controls: Array<{ id: string; label?: string; type?: string; binding?: string }>;
}

/** The inside of a called service, sent once per service (RenderMessage.callees). */
export interface CalleeDetails {
  name: string;
  kind?: string;
  steps: CalleeStepDetails[];
  variables?: VariableDetails[];
  inputs?: ParameterDetails[];
  outputs?: ParameterDetails[];
  coaches?: CoachDetails[];
}

export interface NodeDetails {
  kind: 'node';
  id: string;
  /** Id in the source file, when `id` is a safe replacement for it. */
  originalId?: string;
  name: string;
  bpmnKind: string;
  originalType: string;
  serviceType?: string;
  /** What a call activity calls, e.g. "Validate Order SF (Service flow)". */
  calls?: string;
  lane?: string;
  performer?: string;
  documentation?: string;
  inputs: ParameterDetails[];
  outputs: ParameterDetails[];
  script?: ScriptDetails;
  inputMappings?: MappingDetails[];
  outputMappings?: MappingDetails[];
  userTask?: UserTaskDetails;
  timer?: TimerDetails;
  /** Gateways only: the outgoing flows, when one of them has a condition or is the default. */
  outgoing?: OutgoingFlowDetails[];
  /** Key into RenderMessage.callees: the inside of the service this activity calls. */
  callee?: string;
  /** A linked process in the package: the id of that process in `processes`. */
  openProcessId?: string;
  /** A call or sub-process that opens as a diagram: the level id to send in openCallee. */
  openCallee?: string;
  /** Sub-processes: how many nodes the diagram of its inside draws (its direct children). */
  containsNodes?: number;
  /** A call that does not open as a diagram, and why: "Not in this export", "External service". */
  openUnavailable?: string;
  /** REST steps of a service: the external service and its operation. */
  rest?: { service: string; operation?: string };
  /** Coaches of a client-side human service: the controls. */
  coach?: CoachDetails;
  /** Events of a service, e.g. "Stay on page", "Error _WEATHER_FAILED". */
  eventType?: string;
  /** Error boundary events: the node they are attached to and what they catch. */
  boundary?: { attachedTo: string; catchAll?: boolean; errorCode?: string };
}

export interface FlowDetails {
  kind: 'flow';
  id: string;
  /** Id in the source file, when `id` is a safe replacement for it. */
  originalId?: string;
  /** Name from the model, also when its label is hidden in the diagram. */
  name: string;
  /** True when the name exists but is not drawn (generated "To <target>" label). */
  labelHidden: boolean;
  source: string;
  target: string;
  condition?: string;
  isDefault: boolean;
}

export interface LaneDetails {
  kind: 'lane';
  id: string;
  /** Id in the source file, when `id` is a safe replacement for it. */
  originalId?: string;
  name: string;
  nodeCount: number;
}

export type ElementDetails = NodeDetails | FlowDetails | LaneDetails;

export interface ProcessSummary {
  id: string;
  /** What the diagram shows: "Process", "Service flow" or "Client-side human service". */
  kind: string;
  /** Id in the source file, when `id` is a safe replacement for it. */
  originalId?: string;
  name: string;
  documentation: string;
  sourceFile: string;
  exporter?: string;
  /** TWX: the process app and snapshot, e.g. "order-delivery-process / Initial Import 2". */
  app?: string;
  /** TWX: toolkit dependencies; packed toolkits are not read. */
  toolkits?: string[];
  variables?: VariableDetails[];
  inputs?: ParameterDetails[];
  outputs?: ParameterDetails[];
}

/** One level of the breadcrumb: a process, or a service opened from a call. */
export interface LevelSummary {
  /** Level id (see ../views/navigation): the BAW object id, or a Bob process id. */
  id: string;
  name: string;
  /** e.g. "Process", "Service flow". */
  kind: string;
}

/** A process of the package the user can switch to. */
export interface ProcessChoice {
  id: string;
  name: string;
}

/**
 * The comparison of the drawn process with another version (src/diff). Only
 * names, labels and change lines: never script text or mapped values.
 */
export interface DiffView {
  /** A file the user picked, or the version read before the latest reload. */
  baseKind: 'file' | 'previous';
  /** File name of the base. */
  baseLabel: string;
  /** When the base was read (epoch milliseconds). */
  loadedAt: number;
  counts: { added: number; removed: number; changed: number };
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: DiffEntry[];
  /** Diagram element id → how to mark it. */
  marks: Record<string, DiffMark>;
  /**
   * Element id → the sub-processes it is inside, nearest first, for the
   * elements of the lists that are inside one: a row of an element that is
   * not drawn at the shown level selects the sub-process that holds it.
   */
  enclosing?: Record<string, string[]>;
  /** Why there is nothing to list, e.g. a service diagram is drawn or no process matches. */
  note?: string;
}

/**
 * The check of the chosen process against a description (src/trace). Only
 * names from the description and the process: never script text or conditions.
 */
export interface TraceView {
  /** File name of the description. */
  fileName: string;
  /** "24 of 24 checkable items found (19 exact, 5 near) · 0 missing · 17 unchecked · 1 extra"; empty with `error` or without sections. */
  summary: string;
  counts: TraceCounts;
  rows: TraceRow[];
  /** Headings of the sections that are not checked. */
  notChecked: string[];
  /** Why the description could not be checked (unreadable, too large); no rows then. */
  error?: string;
  /** A note on what the description lacks: no checked section at all (no rows then), or no Main process steps section. */
  notice?: string;
}

/** Host -> webview: draw a diagram. */
export interface RenderMessage {
  type: 'render';
  xml: string;
  options: ViewOptions;
  /** Keep the current zoom and scroll position (re-render after a toggle). */
  preserveView: boolean;
  process: ProcessSummary;
  /** Every process of the package, in display order; the one chosen in the picker is `rootProcessId`. */
  processes: ProcessChoice[];
  /** Id (in `processes`) of the process chosen in the picker: the first level of `path`. */
  rootProcessId: string;
  /** The open levels, from the chosen process down to the one drawn (the last). */
  path: LevelSummary[];
  /** A short note about the last navigation, e.g. that a level was already open. */
  note?: string;
  /** Details of every drawn element, keyed by diagram element id. */
  elements: Record<string, ElementDetails>;
  /** The inside of each service a drawn activity calls, keyed by NodeDetails.callee; one entry per service. */
  callees: Record<string, CalleeDetails>;
  dataTypes: DataType[];
  warnings: string[];
  /** When the package was read from disk (epoch milliseconds). */
  loadedAt: number;
  /** The comparison with the base version; undefined while there is nothing to compare with. */
  diff?: DiffView;
  /**
   * Once, on the render that follows a file picked with Compare…: the webview
   * switches its side panel to the Changes tab. Never set on any other render.
   */
  showChanges?: true;
  /** The check against the attached description; undefined while none is attached. */
  trace?: TraceView;
  /** Once, on the render that follows a description picked with Check Against Description…: show the Trace tab. */
  showTrace?: true;
}

/** Host -> webview: the file could not be shown (no diagram to fall back to). */
export interface ErrorMessage {
  type: 'error';
  title: string;
  message: string;
}

/**
 * Host -> webview: re-reading the changed file failed. The webview keeps the
 * last good diagram and shows this as a dismissible banner until the next render.
 */
export interface RefreshErrorMessage {
  type: 'refreshError';
  title: string;
  message: string;
}

/** What the drawn diagram can be exported as. */
export type ExportFormat = 'bpmn' | 'svg' | 'png';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['bpmn', 'svg', 'png'];

/** Largest export the host accepts from the webview (bytes, after decoding). */
export const MAX_EXPORT_BYTES = 50 * 1024 * 1024;

/**
 * Host -> webview: draw this BPMN (the export XML: every flow name and lane
 * kept) with fixed light colours and send it back as an image (exportData).
 */
export interface ExportSourceMessage {
  type: 'exportSource';
  requestId: string;
  format: 'svg' | 'png';
  xml: string;
}

/** Host -> webview: whether <base>-description.md is there, so the Trace menu says Open or New. */
export interface DescriptionStatusMessage {
  type: 'descriptionStatus';
  exists: boolean;
}

export type HostMessage = RenderMessage | ErrorMessage | RefreshErrorMessage | ExportSourceMessage | DescriptionStatusMessage;

/** Webview -> host: the webview script is loaded and listening. */
export interface ReadyMessage {
  type: 'ready';
}

/** Webview -> host: the user changed a toolbar toggle. */
export interface SetOptionsMessage {
  type: 'setOptions';
  options: ViewOptions;
}

/** Webview -> host: the user picked another process of the package. */
export interface SelectProcessMessage {
  type: 'selectProcess';
  processId: string;
}

/**
 * Webview -> host: open a called service or linked process as a diagram.
 * `path` holds the ids of the levels it is opened from, root first; a
 * breadcrumb click sends the levels above the clicked one.
 */
export interface OpenCalleeMessage {
  type: 'openCallee';
  calleeId: string;
  path: string[];
}

/** Webview -> host: the user asked to compare the diagram with another file (Compare…). */
export interface CompareRequestMessage {
  type: 'compareRequest';
}

/** Webview -> host: stop comparing with the picked file (back to the previous version). */
export interface ClearComparisonMessage {
  type: 'clearComparison';
}

/** Webview -> host: the Trace button asks to pick a description (as Lanescope: Check Against Description…). */
export interface CheckDescriptionMessage {
  type: 'checkDescription';
}

/** Webview -> host: the Trace menu asks to open the description, written from the template when missing (as Lanescope: New or Open Process Description). */
export interface NewDescriptionMessage {
  type: 'newDescription';
}

/** Webview -> host: is <base>-description.md there? Answered with a DescriptionStatusMessage. */
export interface DescriptionStatusRequestMessage {
  type: 'descriptionStatus';
}

/** Webview -> host: stop checking against the attached description. */
export interface ClearDescriptionMessage {
  type: 'clearDescription';
}

/** Webview -> host: the user asked to export the drawn diagram. */
export interface ExportRequestMessage {
  type: 'exportRequest';
  format: ExportFormat;
}

/**
 * Webview -> host: the image for an exportSource. As sent, `data` is the SVG
 * text or a PNG data URL; parseWebviewMessage checks it and gives the file
 * bytes in `bytes`.
 */
export interface ExportDataMessage {
  type: 'exportData';
  requestId: string;
  format: 'svg' | 'png';
  data: string;
}

/** An exportData message that passed the checks, with the bytes to write. */
export interface ParsedExportData {
  type: 'exportData';
  requestId: string;
  format: 'svg' | 'png';
  bytes: Uint8Array;
}

export type WebviewMessage =
  | ReadyMessage
  | SetOptionsMessage
  | SelectProcessMessage
  | OpenCalleeMessage
  | ExportRequestMessage
  | ExportDataMessage
  | CompareRequestMessage
  | ClearComparisonMessage
  | ClearDescriptionMessage
  | CheckDescriptionMessage
  | NewDescriptionMessage
  | DescriptionStatusRequestMessage;

/** A webview message after parseWebviewMessage. */
export type ParsedWebviewMessage = Exclude<WebviewMessage, ExportDataMessage> | ParsedExportData;

/** The image export the host is waiting for: only data for it is accepted. */
export interface ExpectedExport {
  requestId: string;
  format: 'svg' | 'png';
}

/** Longest id accepted from the webview. */
const MAX_ID_LENGTH = 256;

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH;

/**
 * Validates a message received from the webview (it is untrusted input).
 * exportData is accepted only for `expected`, the latest image export the
 * host asked for; older or unknown request ids are rejected.
 */
export function parseWebviewMessage(value: unknown, expected?: ExpectedExport): ParsedWebviewMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const msg = value as Record<string, unknown>;
  if (msg.type === 'ready') return { type: 'ready' };
  // Messages without a payload: anything besides the type is refused.
  if ((msg.type === 'compareRequest' || msg.type === 'clearComparison' || msg.type === 'clearDescription' || msg.type === 'checkDescription' || msg.type === 'newDescription' || msg.type === 'descriptionStatus') && onlyKeys(msg, ['type'])) return { type: msg.type };
  if (msg.type === 'exportRequest' && isExportFormat(msg.format)) return { type: 'exportRequest', format: msg.format };
  if (msg.type === 'exportData') return parseExportData(msg, expected);
  if (msg.type === 'selectProcess' && typeof msg.processId === 'string' && msg.processId.length > 0) {
    return { type: 'selectProcess', processId: msg.processId };
  }
  if (
    msg.type === 'openCallee' &&
    isId(msg.calleeId) &&
    Array.isArray(msg.path) &&
    msg.path.length <= MAX_PATH_DEPTH &&
    msg.path.every(isId)
  ) {
    return { type: 'openCallee', calleeId: msg.calleeId, path: [...(msg.path as string[])] };
  }
  if (msg.type === 'setOptions' && typeof msg.options === 'object' && msg.options !== null) {
    const o = msg.options as Record<string, unknown>;
    if (typeof o.hideGeneratedFlowLabels === 'boolean' && typeof o.hideEmptyLanes === 'boolean' && typeof o.highlightChanges === 'boolean') {
      return {
        type: 'setOptions',
        options: { hideGeneratedFlowLabels: o.hideGeneratedFlowLabels, hideEmptyLanes: o.hideEmptyLanes, highlightChanges: o.highlightChanges },
      };
    }
  }
  return undefined;
}

function onlyKeys(msg: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(msg).every((k) => keys.includes(k));
}

function isExportFormat(v: unknown): v is ExportFormat {
  return typeof v === 'string' && (EXPORT_FORMATS as readonly string[]).includes(v);
}

const PNG_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Longest base64 text that can decode to at most MAX_EXPORT_BYTES. */
const MAX_PNG_BASE64 = Math.ceil(MAX_EXPORT_BYTES / 3) * 4;

function parseExportData(msg: Record<string, unknown>, expected: ExpectedExport | undefined): ParsedExportData | undefined {
  if (!expected || msg.requestId !== expected.requestId || msg.format !== expected.format) return undefined;
  if (typeof msg.data !== 'string') return undefined;
  const bytes = expected.format === 'svg' ? svgBytes(msg.data) : pngBytes(msg.data);
  return bytes ? { type: 'exportData', requestId: expected.requestId, format: expected.format, bytes } : undefined;
}

/** UTF-8 bytes of an SVG document: starts with <svg, has no script, at most MAX_EXPORT_BYTES. */
function svgBytes(data: string): Uint8Array | undefined {
  // UTF-8 takes at least one byte per UTF-16 code unit: what is longer can only be too large.
  if (data.length > MAX_EXPORT_BYTES || !data.startsWith('<svg') || /<script\b/i.test(data)) return undefined;
  const bytes = new TextEncoder().encode(data);
  return bytes.length <= MAX_EXPORT_BYTES ? bytes : undefined;
}

/** Bytes of a PNG data URL: base64 only, at most MAX_EXPORT_BYTES, with the PNG signature. */
function pngBytes(data: string): Uint8Array | undefined {
  if (!data.startsWith(PNG_PREFIX)) return undefined;
  const base64 = data.slice(PNG_PREFIX.length);
  if (base64.length === 0 || base64.length > MAX_PNG_BASE64 || base64.length % 4 !== 0) return undefined;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return undefined;
  const binary = atob(base64);
  if (binary.length > MAX_EXPORT_BYTES || binary.length < PNG_SIGNATURE.length) return undefined;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b) ? bytes : undefined;
}
