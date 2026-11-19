// Every XML document read from an input file is untrusted. None of the
// formats the viewer reads needs a DOCTYPE, so a document that declares one
// is rejected before any parser sees it: no entity declarations (billion
// laughs), no external entities (XXE). The parsers do not expand them
// either; this check does not depend on that.

/** CDATA sections and comments: text there is not markup. */
const NOT_MARKUP = /<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<!--[\s\S]*?(?:-->|$)/g;

/** True when the document has a DOCTYPE declaration (outside CDATA sections and comments). */
export function hasDoctype(xml: string): boolean {
  if (!/<!DOCTYPE/i.test(xml)) return false;
  return /<!DOCTYPE/i.test(xml.replace(NOT_MARKUP, ''));
}

/** The message used when a document is rejected for its DOCTYPE. */
export const DOCTYPE_MESSAGE = 'XML documents with a DOCTYPE are not accepted.';
