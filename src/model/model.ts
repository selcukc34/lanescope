// Shared intermediate model. Every input format (Bob BPMN/XSD, IBM BAW TWX)
// is mapped onto these types; layout, validation and the views consume
// only this model.

/** Where a package came from. */
export interface PackageSource {
  /** Path of the file that was opened (.bpmn, .zip or .twx). */
  path: string;
  format: 'bpmn' | 'zip' | 'twx';
  /** File name (or zip entry path) of the BPMN document; empty for a TWX. */
  bpmnFile: string;
  /** File names (or zip entry paths) of the XSD documents that were read. */
  xsdFiles: string[];
  /** `exporter` attribute of bpmn:definitions, e.g. "generate-baw-bpmn". */
  exporter?: string;
  exporterVersion?: string;
  targetNamespace?: string;
  /** TWX only: the process app and the toolkits it depends on. */
  twx?: TwxSource;
}

export interface TwxSource {
  /** Process app name, e.g. "order-delivery-process". */
  app?: string;
  /** Snapshot name, e.g. "Initial Import 2". */
  snapshot?: string;
  /** Toolkit dependencies from package.xml, e.g. "System Data 8.6.0.0". */
  toolkits: string[];
  /** Number of toolkits packed in the export (toolkits/*.zip); they are not read. */
  packedToolkits: number;
}

export interface ProcessPackage {
  source: PackageSource;
  processes: Process[];
  dataTypes: DataType[];
  /** Non-fatal problems found while reading (unknown elements, unresolved references, ...). */
  warnings: string[];
  /** TWX: reads the diagrams of called services on demand. Undefined for Bob output. */
  calleeDiagrams?: CalleeDiagramSource;
}

/** Why a call cannot be opened as a diagram, or that it can. */
export type CalleeOpenability = { openable: true } | { openable: false; reason: string };

/** Diagrams of the services (1.…) a package calls, read when they are first opened. */
export interface CalleeDiagramSource {
  /** Name of a service of the export; undefined when the export does not hold it. */
  name(id: string): string | undefined;
  /** Whether the service can be opened, without reading its diagram. */
  openability(id: string): CalleeOpenability;
  /** The diagram of a service flow or client-side human service; undefined when it cannot be opened. */
  read(id: string): Promise<CalleeDiagram | undefined>;
}

export interface CalleeDiagram {
  process: Process;
  /** Problems found while reading this diagram (unsupported steps, mappings of unknown forms, ...). */
  warnings: string[];
}

export interface Process {
  id: string;
  /** Id as written in the source, when it is not a valid XML id and `id` is a safe replacement. */
  originalId?: string;
  name: string;
  documentation: string;
  lanes: Lane[];
  nodes: FlowNode[];
  flows: Flow[];
  /** Variables of the process (TWX: BPD variables), when the source declares them. */
  variables?: ProcessVariable[];
  /** Inputs of the process itself (TWX: the BPD's ioSpecification dataInput). */
  inputs?: DataParameter[];
  /** Outputs of the process itself (TWX: the BPD's ioSpecification dataOutput). */
  outputs?: DataParameter[];
  /** TWX: what kind of object the diagram was read from. Undefined for Bob output (a process). */
  source?: ProcessOrigin;
}

export interface ProcessOrigin {
  /** A BPD (25.…), a service flow (1.…, processType 12) or a client-side human service (1.…, processType 10). */
  kind: 'bpd' | 'serviceFlow' | 'humanService';
  /** processType of the service object. */
  processType?: string;
}

/** A variable of a process, as the source declares it. */
export interface ProcessVariable {
  name: string;
  /** Raw type reference, e.g. "itm.12.db884a3c-…". */
  typeRef?: string;
  /** Resolved type name, e.g. "String" or "OrderRequest". */
  typeName?: string;
  isCollection: boolean;
  /** Default value as the source stores it (e.g. "0.0"); undefined when there is none. */
  defaultValue?: string;
  /** True when the source tracks the variable for reporting (TWX trackedField). */
  tracked: boolean;
}

export interface Lane {
  id: string;
  /** Id as written in the source, when it is not a valid XML id and `id` is a safe replacement. */
  originalId?: string;
  name: string;
  nodeIds: string[];
  /**
   * Lane band in diagram coordinates, only when the source has it (TWX: the
   * BAW lane heights). The layout uses y and height; x and width follow the pool.
   */
  bounds?: Bounds;
}

export type FlowNodeKind =
  | 'startEvent'
  | 'endEvent'
  | 'intermediateEvent'
  | 'task'
  | 'scriptTask'
  | 'userTask'
  | 'serviceTask'
  | 'callActivity'
  | 'subProcess'
  | 'exclusiveGateway'
  | 'parallelGateway'
  | 'inclusiveGateway'
  | 'eventBasedGateway'
  | 'unknown';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A data input or output of an activity (from bpmn:ioSpecification). */
export interface DataParameter {
  id: string;
  name: string;
  /** Raw structureRef of the referenced itemDefinition, e.g. "bo:OrderRequest". */
  typeRef?: string;
  /** Local part of typeRef, e.g. "OrderRequest"; matches DataType.name. */
  typeName?: string;
  isCollection: boolean;
}

export interface FlowNode {
  id: string;
  /** Id as written in the source, when it is not a valid XML id and `id` is a safe replacement. */
  originalId?: string;
  name: string;
  kind: FlowNodeKind;
  /** Source element type as read, e.g. "bpmn:Task". Kept even when kind is "unknown". */
  originalType: string;
  /** IBM extension icp:serviceType, e.g. "ServiceFlow". */
  serviceType?: string;
  /** Performer name of a user task. */
  performer?: string;
  documentation?: string;
  inputs: DataParameter[];
  outputs: DataParameter[];
  laneId?: string;
  /** Id of the enclosing sub-process, if the node is nested. */
  parentId?: string;
  /** Sub-processes only: true for an event sub-process (triggeredByEvent="true"). */
  triggeredByEvent?: boolean;
  /** The service or process a call activity calls (TWX: calledElement="1.…" or "25.…"). */
  calledElement?: CalledElement;
  /** Diagram bounds, only when the source has them (a bpmndi section, the TWX diagram). */
  bounds?: Bounds;
  /** Script of a script task, as the source holds it (line ends normalised to LF). */
  script?: Script;
  /** Input data mapping at the call site, one entry per parameter of the callee. */
  inputMappings?: DataMapping[];
  /** Output data mapping at the call site, one entry per parameter of the callee. */
  outputMappings?: DataMapping[];
  /** Settings of a user task (TWX: userTaskSettings). */
  userTask?: UserTaskSettings;
  /** Settings of a timer event (TWX: timerEventSettings). */
  timer?: TimerSettings;
  /** Service diagrams: the external service and operation a REST step calls. */
  restOperation?: RestOperation;
  /** Service diagrams: the controls of a coach (a formTask, drawn as a user task). */
  coach?: CoachSummary;
  /** Service diagrams: what the event definition says, e.g. "Stay on page", "Error". */
  eventType?: string;
  /** Boundary events: the node the event is attached to. */
  attachedToId?: string;
  /** Error boundary and error end events: what is caught or thrown. */
  errorEvent?: { catchAll?: boolean; errorCode?: string };
}

export interface Script {
  /** scriptFormat, e.g. "text/x-javascript". */
  language?: string;
  text: string;
}

/**
 * One parameter of a call and what the caller maps to or from it. For an
 * input, `value` is the expression the caller passes; for an output, the
 * target the result is written to.
 */
export interface DataMapping {
  /** Id of the callee's parameter (TWX: 2055.… for a service, 2007.… for a BPD). */
  parameterId?: string;
  /** Parameter name (falls back to its id when the callee is not in the export). */
  parameter: string;
  /** Mapped expression or target; for a literal, the literal text without its quotes. */
  value?: string;
  /** False when the caller maps nothing to (or from) this parameter. */
  mapped: boolean;
  /** True when the value is a literal (TWX mappingMode "literal" or the ""text"" form), not an expression. */
  literal: boolean;
}

export interface UserTaskSettings {
  /** How the task is assigned, e.g. "Lane". */
  assignment?: string;
  /** e.g. "Normal". */
  priority?: string;
  /** Due date as written: the value and its unit, e.g. "1 Hours". */
  dueDate?: string;
  /** Task subject, may hold a <#= … #> expression. */
  subject?: string;
}

export interface TimerSettings {
  /** Duration: a number or an expression, as written (e.g. "3", "tw.epv.Settings.minutes"). */
  duration: string;
  /** e.g. "Minutes", "Hours", "Days". */
  unit?: string;
  /** Boundary timers only: true when the timer interrupts the activity. */
  interrupting?: boolean;
  /** Boundary timers only: true when the timer repeats. */
  repeating?: boolean;
}

export interface CalledElement {
  /** Object id, e.g. "1.bebd697e-…". */
  id: string;
  /** Resolved name; undefined when the export does not hold the object. */
  name?: string;
  /** Readable kind, e.g. "Service flow" or "Process". */
  kind?: string;
  /**
   * What the called service holds, one level deep (TWX: a service flow or a
   * client-side human service). Shared by every call of the same service.
   */
  internals?: CalleeInternals;
}

/** The inside of a called service, as its object file holds it. */
export interface CalleeInternals {
  /** Every flow node, in flow order from the start event; nodes no flow reaches come last, in document order. */
  steps: CalleeStep[];
  /** Sequence flows as written; an error boundary's flows leave from the boundary (ErrorBoundary.id). */
  flows: Flow[];
  variables?: ProcessVariable[];
  inputs?: DataParameter[];
  outputs?: DataParameter[];
  /** Client-side human service: the coaches and their controls, in flow order. */
  coaches?: CoachSummary[];
}

export type CalleeStepKind =
  | 'start'
  | 'end'
  | 'script'
  | 'call'
  | 'rest'
  | 'gateway'
  | 'coach'
  | 'event'
  | 'unknown';

export interface CalleeStep {
  /** Node id inside the service object. */
  id: string;
  name: string;
  kind: CalleeStepKind;
  /** Source element name, e.g. "scriptTask" or "intermediateThrowEvent". */
  originalType: string;
  /** script: the script, as the source holds it (line ends normalised to LF). */
  script?: Script;
  /** call: object id of the called service ("1.…"), kept for following the call later. */
  calledId?: string;
  /** call: resolved name; undefined when the export does not hold the callee. */
  calledName?: string;
  /** call: readable kind of the callee, e.g. "Service flow". */
  calledKind?: string;
  /** call / rest: inputs of the callee's signature (the service, or the REST operation). */
  inputs?: DataParameter[];
  /** call / rest: outputs of the callee's signature. */
  outputs?: DataParameter[];
  inputMappings?: DataMapping[];
  outputMappings?: DataMapping[];
  /** rest: the external service and the operation the step calls. */
  restOperation?: RestOperation;
  /** gateway: its outgoing flows, in document order. */
  conditions?: StepCondition[];
  /** Error boundary events attached to the step. */
  errorBoundaries?: ErrorBoundary[];
  /** event / end: what the event definition says, e.g. "Stay on page", "Postpone task", "Error". */
  eventType?: string;
}

export interface RestOperation {
  /** Name of the external service object (processType 11). */
  service: string;
  /** Object id of the external service ("1.…"). */
  serviceId: string;
  /** Operation name from the external service's interface, when it resolves. */
  operation?: string;
}

export interface StepCondition {
  /** Name of the target step (its id when it has no name). */
  to: string;
  /** Condition text exactly as written (the editor's tabs included); undefined when the flow has none. */
  condition?: string;
  isDefault: boolean;
}

export interface ErrorBoundary {
  /** Node id of the boundary event. */
  id: string;
  name: string;
  /** True when the boundary catches every error (errorEventSettings/catchAll). */
  catchAll: boolean;
  /** Error code it catches, e.g. "_WEATHER_TIMEOUT". */
  errorCode?: string;
  /** Name of the step the boundary leads to. */
  to?: string;
}

export interface CoachSummary {
  /** Node id of the coach (formTask). */
  id: string;
  name: string;
  /** Every control of the coach, nested ones included, in document order. */
  controls: CoachControl[];
}

export interface CoachControl {
  /** layoutItemId, e.g. "Table1". */
  id: string;
  /** The "@label" configuration option. */
  label?: string;
  /** Name of the coach view the control uses, when it resolves (app or packed toolkit). */
  type?: string;
  /** viewUUID: the coach view's object id ("64.…"). */
  viewRef?: string;
  /** Data binding, e.g. "tw.local.orders[]". */
  binding?: string;
}

export interface Flow {
  id: string;
  /** Id as written in the source, when it is not a valid XML id and `id` is a safe replacement. */
  originalId?: string;
  name: string;
  sourceId: string;
  targetId: string;
  /** Condition expression text (BAW JavaScript for Bob output). */
  condition?: string;
  /** True when the source gateway/activity names this flow as its default. */
  isDefault: boolean;
  /** Where the flow leaves its source, when the source diagram says (TWX linkVisualInfo). */
  sourcePort?: PortLocation;
  /** Where the flow enters its target, when the source diagram says. */
  targetPort?: PortLocation;
}

export type PortSide = 'top' | 'right' | 'bottom' | 'left';

/** A point on the border of a node: the side, and the position along it. */
export interface PortLocation {
  side: PortSide;
  /** 0 to 1 along the side: left to right on top/bottom, top to bottom on left/right. */
  offset: number;
}

export interface DataField {
  name: string;
  /** Local type name, e.g. "string", "decimal", "OrderRequest". */
  type: string;
  required: boolean;
  list: boolean;
}

export interface DataType {
  name: string;
  namespace?: string;
  documentation?: string;
  fields: DataField[];
}
