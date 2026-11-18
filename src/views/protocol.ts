// Messages exchanged between the extension host and the webview. Types only:
// this file is imported by both sides and must not import `vscode` or DOM code.

import type { CalleeStepKind, DataType } from '../model/model';
import { MAX_PATH_DEPTH } from './navigation';

/** Display options the user can toggle in the webview toolbar. */
export interface ViewOptions {
  hideGeneratedFlowLabels: boolean;
  /** The inverse of the toolbar's "Show empty lanes" toggle. */
  hideEmptyLanes: boolean;
}

export const DEFAULT_VIEW_OPTIONS: ViewOptions = {
  hideGeneratedFlowLabels: true,
  hideEmptyLanes: true,
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
  /** A call that opens as a diagram: the level id to send in openCallee. */
  openCallee?: string;
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

export type HostMessage = RenderMessage | ErrorMessage | RefreshErrorMessage;

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

export type WebviewMessage = ReadyMessage | SetOptionsMessage | SelectProcessMessage | OpenCalleeMessage;

/** Longest id accepted from the webview. */
const MAX_ID_LENGTH = 256;

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH;

/** Validates a message received from the webview (it is untrusted input). */
export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const msg = value as Record<string, unknown>;
  if (msg.type === 'ready') return { type: 'ready' };
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
    if (typeof o.hideGeneratedFlowLabels === 'boolean' && typeof o.hideEmptyLanes === 'boolean') {
      return {
        type: 'setOptions',
        options: { hideGeneratedFlowLabels: o.hideGeneratedFlowLabels, hideEmptyLanes: o.hideEmptyLanes },
      };
    }
  }
  return undefined;
}
