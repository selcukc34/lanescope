// The diagrams of the services a TWX export calls, read when the viewer
// first opens them (not when the export is read) and cached for the life of
// the package: a reload of the file reads a new package with a new cache.
// Only the app's own objects are opened; services of toolkits (System Data,
// ...) are not in the export's objects and cannot be opened.

import type { CalleeDiagram, CalleeDiagramSource, CalleeInternals, CalleeOpenability, ServiceEntry } from '../model/model';
import { localRef, type TwxResolver } from './resolver';
import { readServiceDiagram } from './serviceReader';

/** processType of the services that have a diagram. */
const DIAGRAM_TYPES = new Set(['10', '12']);
const EXTERNAL_SERVICE = '11';

export class TwxCalleeDiagrams implements CalleeDiagramSource {
  private readonly cache = new Map<string, Promise<CalleeDiagram | undefined>>();

  constructor(private readonly resolver: TwxResolver) {}

  list(): ServiceEntry[] {
    const out: ServiceEntry[] = [];
    for (const id of this.resolver.serviceIds()) {
      const callee = this.resolver.callee(id);
      if (callee) out.push({ id, name: callee.name, kind: callee.kind });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  key(ref: string): string {
    return localRef(ref);
  }

  name(ref: string): string | undefined {
    return this.resolver.callee(localRef(ref))?.name;
  }

  openability(ref: string): CalleeOpenability {
    const id = localRef(ref);
    const callee = id.startsWith('1.') && this.resolver.object(id) ? this.resolver.callee(id) : undefined;
    if (!callee) return { openable: false, reason: 'Not in this export' };
    if (callee.processType === EXTERNAL_SERVICE) return { openable: false, reason: 'External service' };
    if (callee.processType !== undefined && DIAGRAM_TYPES.has(callee.processType)) return { openable: true };
    return { openable: false, reason: `${callee.kind}: no diagram` };
  }

  read(ref: string): Promise<CalleeDiagram | undefined> {
    const id = localRef(ref);
    let pending = this.cache.get(id);
    if (!pending) {
      pending = this.load(id);
      this.cache.set(id, pending);
    }
    return pending;
  }

  private async load(id: string): Promise<CalleeDiagram | undefined> {
    if (!this.openability(id).openable) return undefined;
    const warnings: string[] = [];
    const process = readServiceDiagram(id, this.resolver, warnings);
    if (!process) return undefined;
    // Name the control types of the coaches drawn here and of those inside the services it calls.
    const coaches = process.nodes.flatMap((n) => (n.coach ? [n.coach] : []));
    const insides: CalleeInternals[] = [
      { steps: [], flows: [], coaches },
      ...process.nodes.flatMap((n) => (n.calledElement?.internals ? [n.calledElement.internals] : [])),
    ];
    const before = this.resolver.warnings.length;
    await this.resolver.resolveControlTypes(insides);
    warnings.push(...this.resolver.warnings.slice(before));
    return { process, warnings };
  }
}
