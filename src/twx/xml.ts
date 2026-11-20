// A small, ordered XML element tree for the TWX readers, built with
// fast-xml-parser. TWX content is untrusted: documents with a DOCTYPE are
// rejected (no entity declarations, no external entities). Lookups use
// local names, so namespace prefixes (ns15:, p:) do not matter.

import { XMLParser } from 'fast-xml-parser';
import { assertNoDoctype } from '../input/xmlGuard';

export interface XmlElement {
  /** Local name, without the namespace prefix. */
  name: string;
  /** Attributes by local name. */
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Concatenated text of the element's own text and CDATA nodes. */
  text: string;
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  cdataPropName: '#cdata',
  processEntities: true,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

type OrderedNode = Record<string, unknown>;

/** Parses a document and returns its root element. Throws DoctypeError (never parsed) or XmlError. */
export function parseXml(xml: string): XmlElement {
  assertNoDoctype(xml);
  let nodes: OrderedNode[];
  try {
    nodes = parser.parse(xml) as OrderedNode[];
  } catch (err) {
    // Parser messages can quote the document; keep only the first line.
    throw new XmlError(`Invalid XML: ${String((err as Error).message).split('\n')[0]}`);
  }
  const root = toElements(nodes)[0];
  if (!root) throw new XmlError('Invalid XML: no root element.');
  return root;
}

function toElements(nodes: OrderedNode[]): XmlElement[] {
  const out: XmlElement[] = [];
  for (const node of nodes) {
    const tag = Object.keys(node).find((k) => k !== ':@');
    if (tag === undefined || tag === '#text' || tag === '#cdata' || tag.startsWith('?') || tag.startsWith('!')) continue;
    const children = node[tag];
    const element: XmlElement = {
      name: localName(tag),
      attrs: attributes(node[':@']),
      children: [],
      text: '',
    };
    if (Array.isArray(children)) {
      const kids = children as OrderedNode[];
      element.text = kids.map(textOf).join('');
      element.children = toElements(kids);
    }
    out.push(element);
  }
  return out;
}

function textOf(node: OrderedNode): string {
  if ('#text' in node) return String(node['#text']);
  if ('#cdata' in node && Array.isArray(node['#cdata'])) {
    return (node['#cdata'] as OrderedNode[]).map((n) => String(n['#text'] ?? '')).join('');
  }
  return '';
}

function attributes(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (key.startsWith('xmlns')) continue;
      out[localName(key)] = String(value);
    }
  }
  return out;
}

export function localName(qname: string): string {
  const i = qname.indexOf(':');
  return i >= 0 ? qname.slice(i + 1) : qname;
}

/** Direct children with the given local name. */
export function children(parent: XmlElement | undefined, name: string): XmlElement[] {
  return parent ? parent.children.filter((c) => c.name === name) : [];
}

/** First direct child with the given local name. */
export function child(parent: XmlElement | undefined, name: string): XmlElement | undefined {
  return parent?.children.find((c) => c.name === name);
}

/** First element (the root itself included) with the given local name, depth first. */
export function first(root: XmlElement | undefined, name: string): XmlElement | undefined {
  if (!root) return undefined;
  if (root.name === name) return root;
  for (const c of root.children) {
    const hit = first(c, name);
    if (hit) return hit;
  }
  return undefined;
}

/** Every element (the root itself included) with the given local name, in document order. */
export function descendants(root: XmlElement | undefined, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const visit = (e: XmlElement) => {
    if (e.name === name) out.push(e);
    e.children.forEach(visit);
  };
  if (root) visit(root);
  return out;
}

/** Attribute value, undefined when missing or empty. */
export function attr(e: XmlElement | undefined, name: string): string | undefined {
  const v = e?.attrs[name];
  return v === undefined || v === '' ? undefined : v;
}

/** All text below an element (like DOM textContent). */
export function textContent(e: XmlElement): string {
  return e.text + e.children.map(textContent).join('');
}

/**
 * Stripped text of the first direct child of that name; undefined when there
 * is none, it is empty or marked isNull="true".
 */
export function childText(parent: XmlElement | undefined, name: string): string | undefined {
  const c = child(parent, name);
  if (!c || c.attrs.isNull === 'true') return undefined;
  const t = textContent(c).trim();
  return t.length > 0 ? t : undefined;
}
