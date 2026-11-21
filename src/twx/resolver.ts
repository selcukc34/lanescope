// Resolves object references inside a TWX export: the services and BPDs a
// call activity calls (objects/1.*.xml, objects/25.*.xml), their parameters,
// and business object types (objects/12.*.xml). Names come from the object
// XML first and from package.xml otherwise. Object files are parsed on first
// use and cached. The inside of a called service is read on first use too
// (./serviceReader), once per service.
//
// Forms verified on BAW 8.6.6 exports:
//   service signature  process/processParameter (processParameterId 2055.…,
//                      parameterType 1 input / 2 output, classId, isArrayOf, seq)
//   BPD signature      bpd/bpdParameter (bpdParameterId 2007.…, same children)
//   business object    twClass/definition/property (name, classRef,
//                      arrayProperty, propertyRequired)
//   type references    "<dependency>/12.…", "/12.…", "12.…" and "itm.12.…"

import type { CalleeInternals, DataField, DataType } from '../model/model';
import { readPackageXml, type TwxPackageInfo } from './packageXml';
import { readServiceInternals } from './serviceReader';
import type { TwxLazySource } from './twxReader';
import { attr, child, childText, children, parseXml, type XmlElement } from './xml';
import { docText } from './text';

export interface CalleeParameter {
  /** processParameterId (2055.…) or bpdParameterId (2007.…). */
  id: string;
  name: string;
  direction: 'input' | 'output';
  /** Raw classId, e.g. "4a3c…/12.db884a3c-…". */
  typeRef?: string;
  /** Resolved type name, e.g. "String" or "OrderRequest". */
  typeName?: string;
  isList: boolean;
}

export interface CalleeInfo {
  id: string;
  name: string;
  /** Readable kind, e.g. "Service flow" or "Process". */
  kind: string;
  /** processType of a service (12 for a service flow); undefined for a BPD. */
  processType?: string;
  /** True for objects BAW generates and names after their own id (the UI of an inline user task). */
  generated: boolean;
  /** Parameters in signature order (inputs and outputs). */
  parameters: CalleeParameter[];
}

/**
 * System Data types by id, for exports that depend on System Data without
 * packing it (verified on the System Data toolkit 8.6.0.0_TC).
 */
export const SYSTEM_DATA_TYPES: Readonly<Record<string, string>> = {
  '12.db884a3c-c533-44b7-bb2d-47bec8ad4022': 'String',
  '12.83ff975e-8dbc-42e5-b738-fa8bc08274a2': 'Boolean',
  '12.3fa0d7a0-828a-4d60-99cc-db5ed143fc2d': 'Integer',
  '12.536b2aa5-a30f-4eca-87fa-3a28066753ee': 'Decimal',
  '12.68474ab0-d56f-47ee-b7e9-510b45a2a8be': 'Date',
  '12.d2e5a15a-ea53-4793-9e93-29af5bd80b13': 'NameValuePair',
  '12.8a176cc2-eebb-4310-a9c7-9bc62b3a8002': 'XMLElement',
};

/** processType of a service object. */
const PROCESS_TYPES: Readonly<Record<string, string>> = {
  '9': 'Undercover agent service',
  '10': 'Client-side human service',
  '11': 'External service',
  '12': 'Service flow',
  '13': 'Deployment service',
};

/** "dep/12.x" → "12.x", "itm.12.x" → "12.x"; a plain id stays as it is. */
export function localRef(ref: string): string {
  const id = ref.slice(ref.lastIndexOf('/') + 1).trim();
  return id.startsWith('itm.') ? id.slice('itm.'.length) : id;
}

export class TwxResolver {
  private readonly parsed = new Map<string, XmlElement | null>();
  private readonly callees = new Map<string, CalleeInfo | undefined>();
  private readonly insides = new Map<string, CalleeInternals | undefined>();
  private readonly viewNames = new Map<string, string | undefined>();
  private toolkitViews: Promise<Map<string, string>> | undefined;
  private readonly warned = new Set<string>();
  /** Problems found while reading services and toolkits, each reported once. */
  readonly warnings: string[] = [];

  constructor(
    private readonly objects: ReadonlyMap<string, string>,
    private readonly pkg?: TwxPackageInfo,
    private readonly lazy?: TwxLazySource,
  ) {}

  /** Adds a warning unless the same text was reported before. */
  warn(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.warnings.push(message);
  }

  /**
   * What a called service (1.…) holds, one level deep; undefined for a BPD,
   * a service not in the export, or a service kind that is not read. Read on
   * first use and cached: a service called many times is read once.
   * Control types of its coaches resolve with resolveControlTypes().
   */
  internals(ref: string): CalleeInternals | undefined {
    const id = localRef(ref);
    if (!this.insides.has(id)) {
      const root = id.startsWith('1.') ? this.object(id) : undefined;
      this.insides.set(id, root ? readServiceInternals(root, this) : undefined);
    }
    return this.insides.get(id);
  }

  /** Every service whose internals were read so far. */
  readInternals(): CalleeInternals[] {
    return [...this.insides.values()].filter((i): i is CalleeInternals => i !== undefined);
  }

  /**
   * Sets the type of every coach control from the coach view it uses: the
   * app's own coach views (objects/64.*.xml, coachView@name, else package.xml),
   * then the package.xml of the packed toolkits, opened only when needed.
   * A view that does not resolve leaves the type empty.
   */
  async resolveControlTypes(internals: CalleeInternals[]): Promise<void> {
    const controls = internals.flatMap((i) => i.coaches ?? []).flatMap((c) => c.controls);
    for (const control of controls) {
      if (control.type !== undefined || control.viewRef === undefined) continue;
      const name = await this.coachViewName(control.viewRef);
      if (name) control.type = name;
    }
  }

  private async coachViewName(ref: string): Promise<string | undefined> {
    const id = localRef(ref);
    if (!this.viewNames.has(id)) {
      let name = await this.appCoachViewName(id);
      if (name === undefined && this.lazy) {
        this.toolkitViews ??= this.readToolkitViews(this.lazy);
        name = (await this.toolkitViews).get(id);
      }
      this.viewNames.set(id, name);
    }
    return this.viewNames.get(id);
  }

  private async appCoachViewName(id: string): Promise<string | undefined> {
    let xml = this.objects.get(id);
    if (xml === undefined && this.lazy) {
      try {
        xml = await this.lazy.readObject(id);
      } catch {
        this.warn(`objects/${id}.xml could not be read; the control type is not shown.`);
      }
    }
    if (xml !== undefined) {
      try {
        const view = parseXml(xml).children[0];
        if (view?.name === 'coachView' && attr(view, 'name')) return attr(view, 'name');
      } catch {
        // Fall back to the name package.xml declares.
      }
    }
    return this.pkg?.objects.get(id)?.name;
  }

  private async readToolkitViews(lazy: TwxLazySource): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    let result: { packages: string[]; warnings: string[] };
    try {
      result = await lazy.toolkitPackages();
    } catch (err) {
      this.warn(`The packed toolkits could not be read (${(err as Error).message}); control types from them are not shown.`);
      return out;
    }
    result.warnings.forEach((w) => this.warn(w));
    for (const xml of result.packages) {
      try {
        for (const o of readPackageXml(xml).objects.values()) {
          if (o.type === 'coachView' && o.name && !out.has(o.id)) out.set(o.id, o.name);
        }
      } catch {
        this.warn('The package.xml of a packed toolkit could not be parsed; control types from it are not shown.');
      }
    }
    return out;
  }

  /** Ids of every service object (1.…) of the export, as they are stored. */
  serviceIds(): string[] {
    return [...this.objects.keys()].filter((id) => id.startsWith('1.'));
  }

  /** The root element of an object file, or undefined when it is missing or unreadable. */
  object(id: string): XmlElement | undefined {
    if (!this.parsed.has(id)) {
      const xml = this.objects.get(id);
      let root: XmlElement | null = null;
      if (xml !== undefined) {
        try {
          root = parseXml(xml);
        } catch {
          root = null;
        }
      }
      this.parsed.set(id, root);
    }
    return this.parsed.get(id) ?? undefined;
  }

  /** Name of an object from its XML, else from package.xml. */
  objectName(id: string): string | undefined {
    const typed = this.object(id)?.children[0];
    return attr(typed, 'name') ?? this.pkg?.objects.get(id)?.name;
  }

  /** Name of a type reference (classId, classRef or itemSubjectRef). */
  typeName(ref: string | undefined): string | undefined {
    if (!ref) return undefined;
    const id = localRef(ref);
    if (!id.startsWith('12.')) return undefined;
    return this.objectName(id) ?? SYSTEM_DATA_TYPES[id];
  }

  /** The service (1.…) or BPD (25.…) a call activity calls; undefined when the export does not hold it. */
  callee(ref: string): CalleeInfo | undefined {
    const id = localRef(ref);
    if (!this.callees.has(id)) this.callees.set(id, this.readCallee(id));
    return this.callees.get(id);
  }

  private readCallee(id: string): CalleeInfo | undefined {
    const typed = this.object(id)?.children[0];
    const name = attr(typed, 'name') ?? this.pkg?.objects.get(id)?.name;
    if (!typed && name === undefined) return undefined;

    if (id.startsWith('25.')) {
      return {
        id,
        name: name ?? id,
        kind: 'Process',
        generated: false,
        parameters: this.parameters(children(typed, 'bpdParameter'), 'bpdParameterId'),
      };
    }
    const processType = childText(typed, 'processType');
    const kind = processType ? (PROCESS_TYPES[processType] ?? `Service (processType ${processType})`) : 'Service';
    return {
      id,
      name: name ?? id,
      kind,
      processType,
      generated: name === id,
      parameters: this.parameters(children(typed, 'processParameter'), 'processParameterId'),
    };
  }

  private parameters(elements: XmlElement[], idElement: string): CalleeParameter[] {
    const withSeq = elements.map((p, index) => {
      const type = childText(p, 'parameterType');
      const typeRef = childText(p, 'classId');
      const param: CalleeParameter = {
        id: childText(p, idElement) ?? '',
        name: attr(p, 'name') ?? childText(p, 'name') ?? '',
        direction: type === '2' ? 'output' : 'input',
        isList: childText(p, 'isArrayOf')?.toLowerCase() === 'true',
      };
      if (typeRef) {
        param.typeRef = typeRef;
        const typeName = this.typeName(typeRef);
        if (typeName) param.typeName = typeName;
      }
      const seq = Number(childText(p, 'seq'));
      // parameterType 1 is an input and 2 an output; others (3: an error) are not part of the signature.
      return { param, keep: type === '1' || type === '2', seq: Number.isFinite(seq) ? seq : index, index };
    });
    return withSeq
      .filter((p) => p.keep)
      .sort((a, b) => a.seq - b.seq || a.index - b.index)
      .map((p) => p.param);
  }

  /** The app's business objects (objects/12.*.xml) as data types, sorted by name. */
  dataTypes(): DataType[] {
    const out: DataType[] = [];
    for (const id of this.objects.keys()) {
      if (!id.startsWith('12.')) continue;
      const cls = this.object(id)?.children[0];
      if (!cls || cls.name !== 'twClass') continue;
      const fields: DataField[] = children(child(cls, 'definition'), 'property').map((p) => {
        const typeRef = childText(p, 'classRef');
        return {
          name: childText(p, 'name') ?? '',
          type: this.typeName(typeRef) ?? (typeRef ? localRef(typeRef) : ''),
          required: childText(p, 'propertyRequired')?.toLowerCase() === 'true',
          list: childText(p, 'arrayProperty')?.toLowerCase() === 'true',
        };
      });
      const type: DataType = { name: attr(cls, 'name') ?? id, fields };
      const doc = docText(childText(cls, 'description'));
      if (doc) type.documentation = doc;
      out.push(type);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}
