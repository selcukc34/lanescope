// BAW stores documentation as a small HTML fragment
// ("<html><body>Validates the order…</body></html>"). The viewer shows text.

import { htmlToPlainText } from '../model/plainText';

/**
 * The plain text of a BAW documentation or description field, or undefined
 * when it has none (BAW writes "<html><body></body></html>" for empty ones).
 */
export function docText(html: string | undefined): string | undefined {
  if (html === undefined) return undefined;
  const text = htmlToPlainText(html).trim();
  return text.length > 0 ? text : undefined;
}
