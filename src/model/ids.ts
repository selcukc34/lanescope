// Element ids of the shared model end up as XML ids (xsd:ID, an NCName) in
// the BPMN the viewer draws. Ids from other tools need not be valid NCNames:
// BAW writes "25.98749a22-…" (starts with a digit) and "bpdid:…:-68b1"
// (contains colons). bpmn-moddle drops elements with such ids, so readers map
// them to safe ids and keep the original in `originalId`.

const NCNAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function isXmlId(id: string): boolean {
  return NCNAME.test(id);
}

/**
 * Maps ids to valid, unique XML ids. A valid id is kept as it is; any other
 * gets its invalid characters replaced by "_" and an "id_" prefix when it
 * does not start with a letter or "_". The same input gives the same output.
 */
export class XmlIdMap {
  private readonly byOriginal = new Map<string, string>();
  private readonly used = new Set<string>();

  /** The safe id of `original`; assigned on first use. */
  get(original: string): string {
    const known = this.byOriginal.get(original);
    if (known !== undefined) return known;
    let safe = original;
    if (!isXmlId(safe)) {
      safe = safe.replace(/[^A-Za-z0-9_.-]/g, '_');
      if (!/^[A-Za-z_]/.test(safe)) safe = `id_${safe}`;
    }
    let unique = safe;
    for (let n = 2; this.used.has(unique); n++) unique = `${safe}_${n}`;
    this.used.add(unique);
    this.byOriginal.set(original, unique);
    return unique;
  }

  /** Reserves ids that are valid already, so mapped ids never collide with them. */
  reserve(ids: Iterable<string>): void {
    for (const id of ids) {
      if (isXmlId(id) && !this.byOriginal.has(id)) {
        this.byOriginal.set(id, id);
        this.used.add(id);
      }
    }
  }
}
