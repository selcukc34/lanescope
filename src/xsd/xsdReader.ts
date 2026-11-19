// Reads XML Schema documents produced by Bob and maps named complex types
// onto DataType. Covers what BAW business objects use: sequence/all/choice,
// complexContent extension, attributes and annotation/documentation.

import { XMLParser } from 'fast-xml-parser';
import { DOCTYPE_MESSAGE, hasDoctype } from '../input/xmlGuard';
import type { DataField, DataType } from '../model/model';

type XsdNode = Record<string, unknown>;

/** Elements that are always parsed as arrays, so the walker never has to branch. */
const ARRAY_ELEMENTS = new Set([
  'complexType',
  'element',
  'attribute',
  'sequence',
  'choice',
  'all',
  'group',
  'documentation',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (name, _path, _isLeaf, isAttribute) => !isAttribute && ARRAY_ELEMENTS.has(name),
});

/** Parses one XSD document and returns its named complex types (and elements with anonymous types). */
export function readXsd(xml: string): DataType[] {
  if (hasDoctype(xml)) throw new Error(DOCTYPE_MESSAGE);
  const doc = parser.parse(xml) as XsdNode;
  const schema = doc.schema as XsdNode | undefined;
  if (!schema || typeof schema !== 'object') {
    throw new Error('Root element is not xs:schema.');
  }
  const namespace = attr(schema, 'targetNamespace');

  const named = new Map<string, XsdNode>();
  for (const ct of nodes(schema.complexType)) {
    const name = attr(ct, 'name');
    if (name) named.set(name, ct);
  }

  const types: DataType[] = [];
  const toType = (name: string, ct: XsdNode, outerDoc?: string): DataType => {
    const type: DataType = { name, fields: fieldsOf(ct, named, new Set([name])) };
    if (namespace) type.namespace = namespace;
    const doc = documentationOf(ct) ?? outerDoc;
    if (doc) type.documentation = doc;
    return type;
  };

  for (const [name, ct] of named) types.push(toType(name, ct));

  // Top-level elements with an inline anonymous complex type.
  for (const el of nodes(schema.element)) {
    const name = attr(el, 'name');
    const inline = nodes(el.complexType)[0];
    if (name && inline && !named.has(name)) types.push(toType(name, inline, documentationOf(el)));
  }
  return types;
}

function fieldsOf(ct: XsdNode, named: Map<string, XsdNode>, seen: Set<string>): DataField[] {
  const fields: DataField[] = [];

  const content = (ct.complexContent ?? ct.simpleContent) as XsdNode | undefined;
  const derivation = content ? ((content.extension ?? content.restriction) as XsdNode | undefined) : undefined;
  if (derivation) {
    // Extension: base type fields come first.
    const base = localName(attr(derivation, 'base') ?? '');
    const baseType = named.get(base);
    if (content?.extension && baseType && !seen.has(base)) {
      fields.push(...fieldsOf(baseType, named, new Set([...seen, base])));
    }
    collectParticles(derivation, true, fields);
    collectAttributes(derivation, fields);
  } else {
    collectParticles(ct, true, fields);
    collectAttributes(ct, fields);
  }
  return fields;
}

/** Walks sequence/all/choice groups. Fields under a choice (or an optional group) are optional. */
function collectParticles(node: XsdNode, groupRequired: boolean, fields: DataField[]): void {
  for (const el of nodes(node.element)) {
    const name = attr(el, 'name') ?? localName(attr(el, 'ref') ?? '');
    if (!name) continue;
    const minOccurs = attr(el, 'minOccurs') ?? '1';
    const maxOccurs = attr(el, 'maxOccurs') ?? '1';
    fields.push({
      name,
      type: fieldType(el),
      required: groupRequired && minOccurs !== '0',
      list: maxOccurs === 'unbounded' || Number(maxOccurs) > 1,
    });
  }
  for (const group of [...nodes(node.sequence), ...nodes(node.all)]) {
    collectParticles(group, groupRequired && attr(group, 'minOccurs') !== '0', fields);
  }
  for (const choice of nodes(node.choice)) {
    collectParticles(choice, false, fields);
  }
}

function collectAttributes(node: XsdNode, fields: DataField[]): void {
  for (const a of nodes(node.attribute)) {
    const name = attr(a, 'name') ?? localName(attr(a, 'ref') ?? '');
    if (!name) continue;
    fields.push({
      name,
      type: localName(attr(a, 'type') ?? 'string'),
      required: attr(a, 'use') === 'required',
      list: false,
    });
  }
}

function fieldType(el: XsdNode): string {
  const type = attr(el, 'type');
  if (type) return localName(type);
  const ref = attr(el, 'ref');
  if (ref) return localName(ref);
  const simple = el.simpleType as XsdNode | undefined;
  const restriction = simple?.restriction as XsdNode | undefined;
  const base = restriction ? attr(restriction, 'base') : undefined;
  if (base) return localName(base);
  // Inline anonymous complex type: no name to refer to.
  return 'anyType';
}

function documentationOf(node: XsdNode): string | undefined {
  const annotation = node.annotation as XsdNode | undefined;
  if (!annotation || typeof annotation !== 'object') return undefined;
  const parts = (Array.isArray(annotation.documentation) ? annotation.documentation : [])
    .map((d) => (typeof d === 'string' ? d : typeof d === 'object' && d ? String((d as XsdNode)['#text'] ?? '') : ''))
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function nodes(value: unknown): XsdNode[] {
  const arr = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return arr.filter((v): v is XsdNode => typeof v === 'object' && v !== null);
}

function attr(node: XsdNode, name: string): string | undefined {
  const v = node[`@_${name}`];
  return typeof v === 'string' ? v : undefined;
}

function localName(qname: string): string {
  const i = qname.indexOf(':');
  return i >= 0 ? qname.slice(i + 1) : qname;
}
