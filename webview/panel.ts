// Side panel: element details, XSD data types, warnings, the changes
// against the compared version and the check against a description.
// Everything from the model (scripts, mappings, conditions included) is set
// as text (textContent / text nodes), never parsed as HTML, and never run.

import type {
  CalleeDetails,
  CalleeStepDetails,
  CoachDetails,
  DiffView,
  ElementDetails,
  FlowDetails,
  LaneDetails,
  MappingDetails,
  NodeDetails,
  OutgoingFlowDetails,
  ParameterDetails,
  ProcessSummary,
  RenderMessage,
  ScriptDetails,
  TimerDetails,
  TraceView,
  UserTaskDetails,
  VariableDetails,
} from '../src/views/protocol';
import type { DataType } from '../src/model/model';
import type { TraceRow, TraceTarget } from '../src/trace/trace';
import { clear, h } from './dom';
import {
  catchesLabel,
  catchesText,
  changeCount,
  changeGroups,
  changesTabTitle,
  type ChangeRow,
  comparedWithText,
  containsText,
  insideSummary,
  isLinkedType,
  NOTHING_TO_COMPARE,
  notCheckedText,
  STEP_KIND_LABELS,
  stepNote,
  TRACE_ICONS,
  TRACE_STATUS_LABELS,
  traceDetail,
  traceGroups,
  traceTabTitle,
} from './panelText';

export const TAB_IDS = ['details', 'data', 'warnings', 'changes', 'trace'] as const;
export type TabId = (typeof TAB_IDS)[number];

/** True for a known tab id; a saved webview state may hold anything. */
export function isTabId(value: unknown): value is TabId {
  return (TAB_IDS as readonly unknown[]).includes(value);
}

/** What the Changes tab asks of the viewer. */
export interface ChangesActions {
  /** Select a diagram element, scroll it into view and show its details. */
  reveal(id: string): void;
  /** Stop comparing with the picked file. */
  clearComparison(): void;
  /** Select a node or flow of the chosen process, opening the sub-processes around it. */
  revealTrace(target: Extract<TraceTarget, { type: 'node' | 'flow' }>): void;
  /** Stop checking against the description. */
  clearDescription(): void;
}

/** Types that have a row in the Data tab, and how to show one there. */
interface RevealType {
  known: ReadonlySet<string>;
  reveal(name: string): void;
}

/** What the details of an activity need besides the activity itself. */
interface NodeContext {
  types: RevealType;
  callees: Record<string, CalleeDetails>;
  openCallee(calleeId: string): void;
}

const STATUS_LABELS = { added: 'Added', changed: 'Changed', removed: 'Removed' } as const;

/** Scripts longer than this are folded to their first lines. */
const SCRIPT_FOLD_LINES = 20;

export class SidePanel {
  readonly element: HTMLElement;
  private readonly tabs = new Map<TabId, { button: HTMLButtonElement; body: HTMLElement }>();
  private active: TabId = 'details';
  private data: RenderMessage | undefined;
  private selectedId: string | undefined;

  constructor(
    private readonly onTabChange: (tab: TabId) => void,
    /** The user asked to open a called service or linked process as a diagram. */
    private readonly onOpenCallee: (calleeId: string) => void,
    private readonly changes: ChangesActions,
    /** The tab shown first, e.g. the one saved before the webview was hidden; not reported to onTabChange. */
    initialTab: TabId = 'details',
  ) {
    const tabBar = h('div', { class: 'tabs', role: 'tablist' });
    const bodies = h('div', { class: 'tab-bodies' });
    for (const [id, label] of [
      ['details', 'Details'],
      ['data', 'Data'],
      ['warnings', 'Warnings'],
      ['changes', 'Changes'],
      ['trace', 'Trace'],
    ] as Array<[TabId, string]>) {
      const button = h('button', { class: 'tab', role: 'tab', type: 'button', id: `tab-${id}` }, label);
      button.addEventListener('click', () => this.showTab(id));
      const body = h('div', { class: 'tab-body', role: 'tabpanel', 'aria-labelledby': `tab-${id}` });
      tabBar.append(button);
      bodies.append(body);
      this.tabs.set(id, { button, body });
    }
    // Shown once a render carries a description check.
    this.tabs.get('trace')!.button.hidden = true;
    this.element = h('aside', { class: 'panel' }, tabBar, bodies);
    this.applyTab(initialTab);
  }

  get activeTab(): TabId {
    return this.active;
  }

  /** Shows a tab and reports it to onTabChange (a click, a revealed element or type, Compare…). */
  showTab(id: TabId): void {
    this.applyTab(id);
    this.onTabChange(id);
  }

  private applyTab(id: TabId): void {
    this.active = id;
    for (const [tabId, { button, body }] of this.tabs) {
      const on = tabId === id;
      button.classList.toggle('active', on);
      button.setAttribute('aria-selected', String(on));
      body.hidden = !on;
    }
  }

  /**
   * @param importWarnings problems bpmn-js reported while importing the diagram
   * @param selection the element to select; when left out, the selection is kept while its id exists
   */
  setData(data: RenderMessage, importWarnings: string[] = [], selection?: { id: string | undefined }): void {
    this.data = data;
    this.renderData(data.dataTypes);
    this.renderWarnings([...data.warnings, ...importWarnings]);
    this.renderChanges(data);
    this.renderTrace(data.trace);
    const id = selection ? selection.id : this.selectedId;
    this.select(id && data.elements[id] ? id : undefined);
  }

  /** Id of the element whose details are shown; undefined for the process. */
  get selection(): string | undefined {
    return this.selectedId;
  }

  /** Shows the details of a diagram element, or of the process when undefined. */
  select(id: string | undefined): void {
    if (!this.data) return;
    const details = id ? this.data.elements[id] : undefined;
    this.selectedId = details ? id : undefined;
    const body = this.tabs.get('details')!.body;
    clear(body);
    const types: RevealType = {
      known: new Set(this.data.dataTypes.map((t) => t.name)),
      reveal: (type) => this.revealType(type),
    };
    const ctx: NodeContext = { types, callees: this.data.callees ?? {}, openCallee: (id) => this.onOpenCallee(id) };
    body.append(details ? renderElement(details, ctx) : renderProcess(this.data.process, types));
  }

  private revealType(name: string): void {
    this.showTab('data');
    const target = this.tabs.get('data')!.body.querySelector<HTMLElement>(`[data-type-name="${CSS.escape(name)}"]`);
    if (target) {
      target.scrollIntoView({ block: 'start' });
      target.classList.remove('flash');
      void target.offsetWidth;
      target.classList.add('flash');
    }
  }

  private renderData(types: DataType[]): void {
    const body = this.tabs.get('data')!.body;
    clear(body);
    if (types.length === 0) {
      body.append(h('p', { class: 'empty' }, 'No data types in the package.'));
      return;
    }
    for (const t of types) {
      const rows = t.fields.map((f) =>
        h(
          'tr',
          {},
          h('td', {}, f.name),
          h('td', { class: 'mono' }, f.type),
          h('td', { class: 'center' }, f.required ? 'yes' : 'no'),
          h('td', { class: 'center' }, f.list ? 'yes' : 'no'),
        ),
      );
      body.append(
        h(
          'section',
          { class: 'datatype', 'data-type-name': t.name },
          h('h3', {}, t.name),
          t.namespace ? h('div', { class: 'muted mono' }, t.namespace) : null,
          t.documentation ? h('p', { class: 'doc' }, t.documentation) : null,
          t.fields.length === 0
            ? h('p', { class: 'empty' }, 'No fields.')
            : h(
                'table',
                {},
                h(
                  'thead',
                  {},
                  h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Type'), h('th', {}, 'Required'), h('th', {}, 'List')),
                ),
                h('tbody', {}, ...rows),
              ),
        ),
      );
    }
  }

  private renderChanges(data: RenderMessage): void {
    const { button, body } = this.tabs.get('changes')!;
    const diff = data.diff;
    button.textContent = changesTabTitle(diff);
    button.classList.toggle('has-changes', diff !== undefined && diff.note === undefined && changeCount(diff) > 0);
    clear(body);
    if (!diff) {
      body.append(h('p', { class: 'empty' }, NOTHING_TO_COMPARE));
      return;
    }
    body.append(this.comparedWith(diff));
    if (diff.note !== undefined) {
      body.append(h('p', { class: 'hint' }, diff.note));
      return;
    }
    if (changeCount(diff) === 0) {
      body.append(h('p', { class: 'empty' }, 'No changes.'));
      return;
    }
    const groups = changeGroups(diff, data.elements);
    const group = (title: string, rows: ChangeRow[], badge: boolean) =>
      rows.length > 0
        ? h('section', { class: 'changes' }, h('h3', {}, `${title} (${rows.length})`), h('ul', { class: 'change-list' }, ...rows.map((r) => this.changeRow(r, badge))))
        : null;
    body.append(
      ...[
        group('Added', groups.added, false),
        group('Changed', groups.changed, false),
        group('Removed', groups.removed, false),
        group('Business objects', groups.businessObjects, true),
      ].filter((x): x is HTMLElement => x !== null),
    );
    if (groups.removed.length > 0) body.append(h('p', { class: 'hint' }, 'Removed elements are not drawn.'));
  }

  private comparedWith(diff: DiffView): HTMLElement {
    const at = new Date(diff.loadedAt).toLocaleString();
    const text = h('span', { title: diff.baseKind === 'file' ? `Read ${at}` : `The version shown before the latest reload, read ${at}` }, comparedWithText(diff));
    let clearButton: HTMLButtonElement | null = null;
    if (diff.baseKind === 'file') {
      clearButton = h('button', { class: 'button small', type: 'button', title: 'Stop comparing with this file' }, 'Clear');
      clearButton.addEventListener('click', () => this.changes.clearComparison());
    }
    return h('div', { class: 'compared-with' }, text, clearButton);
  }

  /** One entry: its label (a button that selects the element, when it is drawn) and its change lines. */
  private changeRow(r: ChangeRow, badge: boolean): HTMLElement {
    let label: HTMLElement;
    const id = r.revealId;
    if (id !== undefined) {
      // A real button: mouse, Enter and Space all work; the listener is bound each time the list is drawn.
      const link = h('button', { class: 'link', type: 'button', title: 'Select in the diagram and show its details' }, r.label);
      link.addEventListener('click', () => this.changes.reveal(id));
      label = link;
    } else {
      label = h('span', { class: 'change-label' }, r.label);
    }
    return h(
      'li',
      { class: `change ${r.status}` },
      h('div', { class: 'change-line' }, badge ? h('span', { class: `badge kind diff-${r.status}` }, STATUS_LABELS[r.status]) : null, label),
      r.changes.length > 0 ? h('ul', { class: 'change-details' }, ...r.changes.map((c) => h('li', {}, c))) : null,
    );
  }

  /** The Trace tab: there only while a description is attached. */
  private renderTrace(trace: TraceView | undefined): void {
    const { button, body } = this.tabs.get('trace')!;
    button.hidden = trace === undefined;
    button.textContent = traceTabTitle(trace);
    button.classList.toggle('has-changes', trace !== undefined && trace.error === undefined && trace.counts.missing + trace.counts.extra > 0);
    clear(body);
    if (!trace) {
      // The description was cleared while its tab was shown.
      if (this.active === 'trace') this.showTab('details');
      return;
    }
    const clearButton = h('button', { class: 'button small', type: 'button', title: 'Stop checking against this description' }, 'Clear');
    clearButton.addEventListener('click', () => this.changes.clearDescription());
    body.append(
      h('div', { class: 'compared-with' }, h('span', { class: 'trace-file', title: 'Description the process is checked against' }, `Checked against ${trace.fileName}`), clearButton),
    );
    if (trace.error !== undefined) {
      body.append(h('p', { class: 'hint trace-error' }, trace.error));
      return;
    }
    body.append(h('p', { class: 'trace-summary' }, trace.summary));
    if (trace.rows.length === 0) body.append(h('p', { class: 'empty' }, 'The description has no steps, gateway paths, business objects or human tasks to check.'));
    for (const group of traceGroups(trace.rows)) {
      body.append(h('section', { class: 'trace' }, h('h3', {}, group.title), h('ul', { class: 'trace-list' }, ...group.rows.map((r) => this.traceRow(r)))));
    }
    const notChecked = notCheckedText(trace.notChecked);
    if (notChecked) body.append(h('p', { class: 'hint' }, notChecked));
  }

  /** One row: icon, the description's text (a button when it points at something) and the match or reason. */
  private traceRow(r: TraceRow): HTMLElement {
    const target = r.target;
    let label: HTMLElement;
    if (target && (target.type === 'node' || target.type === 'flow')) {
      label = h('button', { class: 'link', type: 'button', title: 'Select in the diagram and show its details' }, r.text);
      label.addEventListener('click', () => this.changes.revealTrace(target));
    } else if (target && target.type === 'field') {
      const type = target.dataType;
      label = h('button', { class: 'link', type: 'button', title: 'Show in Data tab' }, r.text);
      label.addEventListener('click', () => this.revealType(type));
    } else {
      label = h('span', { class: 'trace-text' }, r.text);
    }
    const lineInfo = r.line !== undefined ? ` (line ${r.line})` : '';
    return h(
      'li',
      { class: `trace-row ${r.status}`, 'data-status': r.status },
      h('span', { class: 'trace-icon', title: TRACE_STATUS_LABELS[r.status], 'aria-label': TRACE_STATUS_LABELS[r.status] }, TRACE_ICONS[r.status]),
      h('span', { class: 'trace-body' }, label, h('span', { class: 'trace-detail muted', title: `${r.note}${lineInfo}` }, traceDetail(r))),
    );
  }

  private renderWarnings(warnings: string[]): void {
    const { button, body } = this.tabs.get('warnings')!;
    button.textContent = `Warnings (${warnings.length})`;
    button.classList.toggle('has-warnings', warnings.length > 0);
    clear(body);
    body.append(
      warnings.length === 0
        ? h('p', { class: 'empty' }, 'No warnings.')
        : h('ul', { class: 'warnings' }, ...warnings.map((w) => h('li', {}, w))),
    );
  }
}

function renderProcess(p: ProcessSummary, revealType: RevealType): HTMLElement {
  return h(
    'div',
    {},
    h('h2', {}, p.name || p.id),
    p.kind !== 'Process' ? h('div', { class: 'subtitle muted' }, p.kind) : null,
    h('p', { class: 'hint' }, 'Click a node or flow to see its details.'),
    fields([
      ['Kind', p.kind],
      ['Source', p.sourceFile],
      ['Process app', p.app],
      ['Exporter', p.exporter],
      ['Id', p.originalId ?? p.id, true],
    ]),
    p.documentation ? section('Documentation', h('p', { class: 'doc' }, p.documentation)) : null,
    p.inputs && p.inputs.length > 0 ? section('Inputs', parameters(p.inputs, revealType)) : null,
    p.outputs && p.outputs.length > 0 ? section('Outputs', parameters(p.outputs, revealType)) : null,
    p.variables && p.variables.length > 0 ? section('Variables', variablesTable(p.variables, revealType)) : null,
    p.toolkits && p.toolkits.length > 0
      ? section('Toolkits', h('ul', { class: 'params' }, ...p.toolkits.map((t) => h('li', {}, t))))
      : null,
  );
}

function renderElement(d: ElementDetails, ctx: NodeContext): HTMLElement {
  if (d.kind === 'node') return renderNode(d, ctx);
  if (d.kind === 'flow') return renderFlow(d);
  return renderLane(d);
}

function renderNode(d: NodeDetails, ctx: NodeContext): HTMLElement {
  const revealType = ctx.types;
  const callee = d.callee !== undefined ? ctx.callees[d.callee] : undefined;
  let open: HTMLElement | null = null;
  if (d.openCallee !== undefined) {
    const calleeId = d.openCallee;
    const isProcess = d.openProcessId !== undefined;
    const isSub = d.containsNodes !== undefined;
    const [title, label] = isSub
      ? ['Open the inside of the sub-process as a diagram (or double-click it)', 'Open sub-process']
      : isProcess
        ? ['Open the called process (or double-click the activity)', 'Open process']
        : ['Open the called service as a diagram (or double-click the activity)', 'Open diagram'];
    const button = h('button', { class: 'button', type: 'button', title }, label);
    button.addEventListener('click', () => ctx.openCallee(calleeId));
    open = button;
  } else if (d.openUnavailable !== undefined) {
    const title = d.containsNodes !== undefined ? 'This sub-process holds no nodes' : 'This call cannot be opened as a diagram';
    open = h('span', { class: 'muted', title }, d.openUnavailable);
  }
  return h(
    'div',
    {},
    h('h2', {}, d.name || '(unnamed)'),
    fields([
      ['BPMN kind', d.bpmnKind],
      ['Original type', d.originalType, true],
      ['Service type', d.serviceType],
      ['Calls', d.calls],
      ['Contains', d.containsNodes !== undefined ? containsText(d.containsNodes) : undefined],
      ['Event', d.eventType],
      ['Attached to', d.boundary?.attachedTo],
      ['Catches', d.boundary ? catchesText(d.boundary) : undefined],
      ['Service', d.rest?.service],
      ['Operation', d.rest?.operation],
      ['Lane', d.lane],
      // A user task shows its performer under Assignment.
      ['Performer', d.userTask ? undefined : d.performer],
      ['Id', d.originalId ?? d.id, true],
    ]),
    open ? h('p', { class: 'actions' }, open) : null,
    d.documentation ? section('Documentation', h('p', { class: 'doc' }, d.documentation)) : null,
    d.script ? scriptSection(d.script) : null,
    d.coach ? section('Controls', controlsTable(d.coach)) : null,
    d.userTask ? assignmentSection(d.userTask) : null,
    d.timer ? timerSection(d.timer) : null,
    d.outgoing ? section('Outgoing conditions', outgoingTable(d.outgoing)) : null,
    // A call's mapping lists every parameter of the signature, so it replaces the plain list.
    d.inputMappings
      ? section('Input mapping', inputMappingTable(d.inputMappings, revealType))
      : d.inputs.length > 0
        ? section('Inputs', parameters(d.inputs, revealType))
        : null,
    d.outputMappings
      ? section('Output mapping', outputMappingTable(d.outputMappings))
      : d.outputs.length > 0
        ? section('Outputs', parameters(d.outputs, revealType))
        : null,
    callee ? insideSection(callee, revealType) : null,
  );
}

/** "Inside <service>": the steps, data and coaches of the called service, folded by default. */
function insideSection(c: CalleeDetails, revealType: RevealType): HTMLElement {
  const steps =
    c.steps.length === 0
      ? h('p', { class: 'empty' }, 'No steps between start and end.')
      : h('ol', { class: 'steps' }, ...c.steps.map((s) => stepItem(s, revealType)));
  return h(
    'details',
    { class: 'inside' },
    h('summary', {}, h('span', { class: 'inside-title' }, `Inside ${c.name}`), h('span', { class: 'muted' }, insideSummary(c))),
    h('section', {}, h('h4', {}, 'Steps'), steps),
    c.inputs && c.inputs.length > 0 ? subsection('Inputs', parameters(c.inputs, revealType)) : null,
    c.outputs && c.outputs.length > 0 ? subsection('Outputs', parameters(c.outputs, revealType)) : null,
    c.variables && c.variables.length > 0 ? subsection('Variables', variablesTable(c.variables, revealType)) : null,
    c.coaches && c.coaches.length > 0 ? h('section', {}, h('h4', {}, 'Coaches'), ...c.coaches.map(coachBlock)) : null,
  );
}

function stepItem(s: CalleeStepDetails, revealType: RevealType): HTMLElement {
  const note = stepNote(s);
  const boundaries = (s.errorBoundaries ?? []).map((b) => {
    const catches = catchesLabel(b);
    return h(
      'div',
      { class: 'step-line' },
      h('span', { class: 'badge kind' }, 'Error boundary'),
      h('span', {}, b.name || '(unnamed)'),
      catches ? h('span', { class: 'muted' }, ` · ${catches}`) : null,
      b.to !== undefined ? h('span', { class: 'muted' }, ` · to ${b.to}`) : null,
    );
  });
  return h(
    'li',
    { class: 'step' },
    h(
      'div',
      { class: 'step-line' },
      h('span', { class: 'badge kind' }, STEP_KIND_LABELS[s.kind]),
      h('span', {}, s.name || '(unnamed)'),
      note ? h('span', { class: 'muted' }, ` · ${note}`) : null,
    ),
    ...boundaries,
    s.calls ? fields([['Calls', s.calls]]) : null,
    s.rest
      ? fields([
          ['Service', s.rest.service],
          ['Operation', s.rest.operation],
        ])
      : null,
    s.script ? foldedScript(s.script) : null,
    s.conditions ? conditionsTable(s.conditions) : null,
    s.inputMappings ? subsection('Input mapping', inputMappingTable(s.inputMappings, revealType)) : null,
    s.outputMappings ? subsection('Output mapping', outputMappingTable(s.outputMappings)) : null,
  );
}

/** A step's script, folded by default; the same block as a script task's. */
function foldedScript(s: ScriptDetails): HTMLElement {
  if (s.hidden) return h('p', { class: 'hint' }, 'Script content hidden by the lanescope.showScripts setting.');
  const lines = `${s.lineCount} ${s.lineCount === 1 ? 'line' : 'lines'}`;
  return h('details', { class: 'fold' }, h('summary', {}, `Script · ${lines}`), scriptSection(s));
}

function conditionsTable(rows: NonNullable<CalleeStepDetails['conditions']>): HTMLElement {
  return table(
    ['To', 'Condition', 'Default'],
    rows.map((c) => [
      h('td', {}, c.to),
      c.condition !== undefined ? h('td', {}, h('code', { class: 'expr' }, c.condition)) : h('td', { class: 'muted' }, 'no condition'),
      h('td', { class: 'center' }, c.isDefault ? 'yes' : ''),
    ]),
  );
}

function coachBlock(c: CoachDetails): HTMLElement {
  return h(
    'div',
    { class: 'coach' },
    h('div', { class: 'step-line' }, h('span', { class: 'badge kind' }, 'Coach'), h('span', {}, c.name || '(unnamed)')),
    controlsTable(c),
  );
}

/** Control · Type · Binding of a coach. */
function controlsTable(c: CoachDetails): HTMLElement {
  if (c.controls.length === 0) return h('p', { class: 'empty' }, 'No controls.');
  return table(
    ['Control', 'Type', 'Binding'],
    c.controls.map((k) => [
      h('td', {}, k.label ?? k.id),
      h('td', {}, k.type ?? ''),
      k.binding !== undefined ? h('td', {}, h('code', { class: 'expr' }, k.binding)) : h('td', {}),
    ]),
  );
}

function subsection(title: string, content: Node): HTMLElement {
  return h('section', {}, h('h4', {}, title), content);
}

function scriptSection(s: ScriptDetails): HTMLElement {
  if (s.hidden) {
    return section('Script', h('p', { class: 'hint' }, 'Script content hidden by the lanescope.showScripts setting.'));
  }
  const lines = s.text.split('\n');
  const folded = lines.length > SCRIPT_FOLD_LINES;
  const pre = h('pre', { class: 'code script' });
  pre.textContent = folded ? lines.slice(0, SCRIPT_FOLD_LINES).join('\n') : s.text;

  const copy = h('button', { class: 'button small', type: 'button', title: 'Copy the script to the clipboard' }, 'Copy');
  let reset: ReturnType<typeof setTimeout> | undefined;
  copy.addEventListener('click', () => {
    const done = (label: string) => {
      copy.textContent = label;
      clearTimeout(reset);
      reset = setTimeout(() => (copy.textContent = 'Copy'), 1500);
    };
    // Only on a click: the clipboard is never read and never written otherwise.
    navigator.clipboard.writeText(s.text).then(
      () => done('Copied'),
      () => done('Copy failed'),
    );
  });

  let expand: HTMLButtonElement | null = null;
  if (folded) {
    const button = h('button', { class: 'link', type: 'button' }, `Show all ${s.lineCount} lines`);
    button.addEventListener('click', () => {
      pre.textContent = s.text;
      button.remove();
    });
    expand = button;
  }

  const meta = `${s.lineCount} ${s.lineCount === 1 ? 'line' : 'lines'}${s.language ? ` · ${s.language}` : ''}`;
  return h(
    'section',
    {},
    h('div', { class: 'section-head' }, h('h3', {}, 'Script'), h('span', { class: 'muted' }, meta), copy),
    pre,
    expand,
  );
}

function assignmentSection(u: UserTaskDetails): HTMLElement | null {
  const dl = fields([
    ['Assignment type', u.assignment],
    ['Lane', u.lane],
    ['Performer', u.performer],
    ['Priority', u.priority],
    ['Due date', u.dueDate],
    ['Subject', u.subject, true],
  ]);
  return dl.childElementCount > 0 ? section('Assignment', dl) : null;
}

function timerSection(t: TimerDetails): HTMLElement {
  const flag = (v: boolean | undefined) => (v === undefined ? undefined : v ? 'yes' : 'no');
  return section(
    'Timer',
    fields([
      ['Duration', t.unit ? `${t.duration} ${t.unit}` : t.duration, !/^\d+(\.\d+)?$/.test(t.duration)],
      ['Interrupting', flag(t.interrupting)],
      ['Repeating', flag(t.repeating)],
    ]),
  );
}

function outgoingTable(flows: OutgoingFlowDetails[]): HTMLElement {
  return table(
    ['To', 'Condition', 'Default'],
    flows.map((f) => [
      h('td', {}, f.target),
      f.condition !== undefined ? h('td', {}, h('code', { class: 'expr' }, f.condition)) : h('td', { class: 'muted' }, '—'),
      h('td', { class: 'center' }, f.isDefault ? 'yes' : ''),
    ]),
  );
}

function inputMappingTable(rows: MappingDetails[], revealType: RevealType): HTMLElement {
  return table(
    ['Parameter', 'Type', 'Value'],
    rows.map((m) => [h('td', {}, m.parameter), h('td', {}, typeLink(m.type, m.isCollection, revealType)), mappedValue(m)]),
  );
}

function outputMappingTable(rows: MappingDetails[]): HTMLElement {
  return table(
    ['Parameter', 'Target'],
    rows.map((m) => [h('td', {}, m.parameter), mappedValue(m)]),
  );
}

function mappedValue(m: MappingDetails): HTMLElement {
  if (!m.mapped) return h('td', { class: 'muted' }, 'not mapped');
  const value = m.value ?? '';
  return h(
    'td',
    {},
    value === '' ? h('span', { class: 'muted' }, m.literal ? '(empty text)' : '(empty)') : h('code', { class: 'expr' }, value),
    m.literal ? h('span', { class: 'badge', title: 'A literal value, not an expression' }, 'literal') : null,
  );
}

function variablesTable(vars: VariableDetails[], revealType: RevealType): HTMLElement {
  return table(
    ['Name', 'Type', 'List', 'Default', 'Tracked'],
    vars.map((v) => [
      h('td', {}, v.name),
      h('td', {}, typeLink(v.type, false, revealType)),
      h('td', { class: 'center' }, v.isCollection ? 'yes' : 'no'),
      v.defaultValue !== undefined ? h('td', {}, h('code', { class: 'expr' }, v.defaultValue)) : h('td', {}),
      h('td', { class: 'center' }, v.tracked ? 'yes' : 'no'),
    ]),
  );
}

function table(headers: string[], rows: HTMLElement[][]): HTMLElement {
  return h(
    'table',
    { class: 'grid' },
    h('thead', {}, h('tr', {}, ...headers.map((t) => h('th', {}, t)))),
    h('tbody', {}, ...rows.map((cells) => h('tr', {}, ...cells))),
  );
}

/** A type name; a link that opens the type in the Data tab when the tab has it. */
function typeLink(type: string | undefined, isCollection: boolean, revealType: RevealType): Node | null {
  if (!type) return isCollection ? h('span', { class: 'muted' }, 'list') : null;
  const text = isCollection ? `${type}[]` : type;
  if (!isLinkedType(type, revealType.known)) return h('span', { class: 'mono' }, text);
  const link = h('button', { class: 'link mono', type: 'button', title: 'Show in Data tab' }, text);
  link.addEventListener('click', () => revealType.reveal(type));
  return link;
}

function renderFlow(d: FlowDetails): HTMLElement {
  return h(
    'div',
    {},
    h('h2', {}, d.name || '(unnamed flow)'),
    d.labelHidden ? h('p', { class: 'hint' }, 'Generated label, hidden in the diagram.') : null,
    fields([
      ['Kind', 'Sequence flow'],
      ['From', d.source],
      ['To', d.target],
      ['Default flow', d.isDefault ? 'yes' : 'no'],
      ['Id', d.originalId ?? d.id, true],
    ]),
    d.condition !== undefined ? section('Condition', h('pre', { class: 'code' }, d.condition)) : null,
  );
}

function renderLane(d: LaneDetails): HTMLElement {
  return h(
    'div',
    {},
    h('h2', {}, d.name || '(unnamed lane)'),
    fields([
      ['Kind', 'Lane'],
      ['Nodes', String(d.nodeCount)],
      ['Id', d.originalId ?? d.id, true],
    ]),
  );
}

function fields(rows: Array<[string, string | undefined, boolean?]>): HTMLElement {
  const dl = h('dl', { class: 'fields' });
  for (const [label, value, mono] of rows) {
    if (value === undefined || value === '') continue;
    dl.append(h('dt', {}, label), h('dd', mono ? { class: 'mono' } : {}, value));
  }
  return dl;
}

function section(title: string, content: Node): HTMLElement {
  return h('section', {}, h('h3', {}, title), content);
}

function parameters(params: ParameterDetails[], revealType: RevealType): HTMLElement {
  return h(
    'ul',
    { class: 'params' },
    ...params.map((p) => {
      const type = typeLink(p.type, p.isCollection, revealType);
      return h('li', {}, h('span', {}, p.name), type ? ' : ' : null, type);
    }),
  );
}
