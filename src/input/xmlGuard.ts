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

/** Thrown instead of parsing a document that has a DOCTYPE. */
export class DoctypeError extends Error {
  constructor(message = DOCTYPE_MESSAGE) {
    super(message);
    this.name = 'DoctypeError';
  }
}

/** Throws DoctypeError when the document has a DOCTYPE declaration. */
export function assertNoDoctype(xml: string, message = DOCTYPE_MESSAGE): void {
  if (hasDoctype(xml)) throw new DoctypeError(message);
}

/** `first` and `N more`, for a list of names in a message. */
function listed(names: readonly string[]): { text: string; plural: boolean } {
  const rest = names.length - 1;
  return { text: rest > 0 ? `${names[0]} and ${rest} more` : names[0], plural: rest > 0 };
}

/**
 * The error shown when nothing could be opened and at least one document was
 * rejected for its DOCTYPE. `names` are object names or file paths, never content.
 */
export function doctypeOpenErrorMessage(names: readonly string[]): string {
  const { text, plural } = listed(names);
  return (
    `Lanescope could not open this file: ${text} ${plural ? 'contain' : 'contains'} a DOCTYPE declaration, ` +
    'which is rejected for security reasons (XML entity expansion). Export the process again without a DOCTYPE.'
  );
}

/**
 * The warning shown when the file opened but some documents were skipped for
 * their DOCTYPE. `noun` names what was skipped ("object", "XSD file").
 */
export function doctypeSkippedWarning(names: readonly string[], noun: string, consequence = ''): string {
  const n = names.length;
  const what = `${n} ${noun}${n === 1 ? ' was' : 's were'}`;
  return (
    `${what} skipped because ${n === 1 ? 'it contains' : 'they contain'} a DOCTYPE declaration ` +
    `(rejected for security reasons)${consequence}: ${names.join(', ')}.`
  );
}
