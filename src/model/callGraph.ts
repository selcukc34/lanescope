// Who calls whom in a package: a graph of its processes and services, with
// one edge per calling activity (a call activity of a process, a call step
// of a service), wherever it sits (inside sub-processes too). Pure: no
// vscode, no file access; service diagrams come from the package's
// CalleeDiagramSource. Used by the search (callers, opening a hit where it
// is called) and meant as the source of a "Calls" tree later.
//
// Nodes are the processes of the package (Bob processes, TWX BPDs, linked
// processes among them) and the services of a TWX export (every kind; a
// service without a diagram has no outgoing edges). A call to something
// the package does not hold is not an edge.

import type { CalleeDiagramSource, Process, ProcessPackage, ServiceEntry } from './model';
import { subProcessLevels } from './subProcess';

/** A node of the graph. */
export type CallNodeRef =
  /** A process of the package, by its id in `processes`. */
  | { kind: 'process'; id: string }
  /** A service of a TWX export, by its object id ("1.…"). */
  | { kind: 'service'; id: string };

export interface CallGraphNode {
  ref: CallNodeRef;
  name: string;
  /** "Process", "Service flow", "Client-side human service", ... */
  label: string;
  /** The level id it is opened with as a diagram (a process: originalId ?? id; a service: its object id). */
  levelId: string;
  /** False for a service without a diagram. */
  hasDiagram: boolean;
}

/** One calling activity: who holds it, where, and what it calls. */
export interface CallSite {
  from: CallNodeRef;
  /** Diagram id of the call activity or call step. */
  nodeId: string;
  name: string;
  /** Sub-process levels of `from`'s diagram around the activity, outermost first. */
  levels: string[];
  to: CallNodeRef;
}

/** A service read for the graph: its entry and its diagram, when it has one. */
export interface ServiceDiagram {
  entry: ServiceEntry;
  diagram?: Process;
}

export const refKey = (ref: CallNodeRef): string => `${ref.kind}:${ref.id}`;

export class CallGraph {
  private readonly byKey = new Map<string, CallGraphNode>();
  private readonly out = new Map<string, CallSite[]>();
  private readonly in = new Map<string, CallSite[]>();

  constructor(nodes: CallGraphNode[], sites: CallSite[]) {
    for (const n of nodes) this.byKey.set(refKey(n.ref), n);
    for (const s of sites) {
      if (!this.byKey.has(refKey(s.from)) || !this.byKey.has(refKey(s.to))) continue;
      push(this.out, refKey(s.from), s);
      push(this.in, refKey(s.to), s);
    }
  }

  /** Every node: processes first, then services, in the order they were given. */
  nodes(): CallGraphNode[] {
    return [...this.byKey.values()];
  }

  node(ref: CallNodeRef): CallGraphNode | undefined {
    return this.byKey.get(refKey(ref));
  }

  /** The calls `ref` makes, in diagram order. */
  callees(ref: CallNodeRef): CallSite[] {
    return [...(this.out.get(refKey(ref)) ?? [])];
  }

  /** The calls made to `ref`: processes' activities first, then services' steps, each in node order. */
  callers(ref: CallNodeRef): CallSite[] {
    const sites = this.in.get(refKey(ref)) ?? [];
    return [...sites.filter((s) => s.from.kind === 'process'), ...sites.filter((s) => s.from.kind === 'service')];
  }

  /** Nodes nothing calls. */
  uncalled(): CallGraphNode[] {
    return this.nodes().filter((n) => (this.in.get(refKey(n.ref)) ?? []).length === 0);
  }

  /**
   * The cycles of calls: each group of nodes that call one another (a
   * strongly connected component of more than one node, or a node that calls
   * itself), its nodes in graph order.
   */
  cycles(): CallNodeRef[][] {
    // Tarjan's algorithm, iterative so a deep chain cannot overflow the stack.
    const keys = [...this.byKey.keys()];
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const out: string[][] = [];
    let next = 0;
    const targets = (k: string) => [...new Set((this.out.get(k) ?? []).map((s) => refKey(s.to)))];
    for (const start of keys) {
      if (index.has(start)) continue;
      const work: Array<{ key: string; edges: string[]; i: number }> = [];
      const open = (k: string) => {
        index.set(k, next);
        low.set(k, next);
        next++;
        stack.push(k);
        onStack.add(k);
        work.push({ key: k, edges: targets(k), i: 0 });
      };
      open(start);
      while (work.length > 0) {
        const top = work[work.length - 1];
        if (top.i < top.edges.length) {
          const t = top.edges[top.i++];
          if (!index.has(t)) open(t);
          else if (onStack.has(t)) low.set(top.key, Math.min(low.get(top.key)!, index.get(t)!));
          continue;
        }
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1].key;
          low.set(parent, Math.min(low.get(parent)!, low.get(top.key)!));
        }
        if (low.get(top.key) === index.get(top.key)) {
          const component: string[] = [];
          let k: string;
          do {
            k = stack.pop()!;
            onStack.delete(k);
            component.push(k);
          } while (k !== top.key);
          const selfCall = component.length === 1 && targets(component[0]).includes(component[0]);
          if (component.length > 1 || selfCall) out.push(component);
        }
      }
    }
    const order = new Map(keys.map((k, i) => [k, i]));
    return out
      .map((c) => c.sort((a, b) => order.get(a)! - order.get(b)!).map((k) => this.byKey.get(k)!.ref))
      .sort((a, b) => order.get(refKey(a[0]))! - order.get(refKey(b[0]))!);
  }
}

/** Every service of the package with its diagram (read through the package's source, which caches them). */
export async function readServiceDiagrams(pkg: ProcessPackage): Promise<ServiceDiagram[]> {
  const source = pkg.calleeDiagrams;
  if (!source) return [];
  const out: ServiceDiagram[] = [];
  for (const entry of source.list()) {
    const diagram = source.openability(entry.id).openable ? (await source.read(entry.id))?.process : undefined;
    out.push({ entry, ...(diagram ? { diagram } : {}) });
  }
  return out;
}

/**
 * The call graph of a package. `services` are its service diagrams as
 * readServiceDiagrams gives them (read here when left out).
 */
export async function buildCallGraph(pkg: ProcessPackage, services?: ServiceDiagram[]): Promise<CallGraph> {
  const diagrams = services ?? (await readServiceDiagrams(pkg));
  const source = pkg.calleeDiagrams;
  const nodes: CallGraphNode[] = [
    ...pkg.processes.map((p) => ({ ref: { kind: 'process' as const, id: p.id }, name: p.name || p.id, label: 'Process', levelId: p.originalId ?? p.id, hasDiagram: true })),
    ...diagrams.map((s) => ({ ref: { kind: 'service' as const, id: s.entry.id }, name: s.entry.name, label: s.entry.kind, levelId: s.entry.id, hasDiagram: s.diagram !== undefined })),
  ];
  const resolve = callTarget(pkg, source, new Set(diagrams.map((s) => s.entry.id)));
  const sites: CallSite[] = [];
  const add = (from: CallNodeRef, diagram: Process) => {
    for (const n of diagram.nodes) {
      const to = n.calledElement ? resolve(n.calledElement.id) : undefined;
      if (to) sites.push({ from, nodeId: n.id, name: n.name || n.id, levels: subProcessLevels(diagram, n), to });
    }
  };
  for (const p of pkg.processes) add({ kind: 'process', id: p.id }, p);
  for (const s of diagrams) if (s.diagram) add({ kind: 'service', id: s.entry.id }, s.diagram);
  return new CallGraph(nodes, sites);
}

/** What a calledElement reference stands for in the package, if anything. */
function callTarget(pkg: ProcessPackage, source: CalleeDiagramSource | undefined, services: ReadonlySet<string>): (ref: string) => CallNodeRef | undefined {
  const processByLevel = new Map<string, string>();
  for (const p of pkg.processes) {
    processByLevel.set(p.originalId ?? p.id, p.id);
    processByLevel.set(p.id, p.id);
  }
  return (ref) => {
    const id = source ? source.key(ref) : ref;
    if (services.has(id)) return { kind: 'service', id };
    const process = processByLevel.get(id) ?? processByLevel.get(ref);
    return process !== undefined ? { kind: 'process', id: process } : undefined;
  };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

