// Documentation can be rich text: BAW stores it as an HTML fragment, often
// with a <STYLE> block from its editor. The viewer never renders HTML, so the
// readers turn it into plain text here, before anything reaches the webview.
// Text that is not HTML (Bob output, most BAW fields) is returned unchanged.

/** An HTML comment or a tag HTML documentation uses. "amount < 1000" is neither. */
const LOOKS_LIKE_HTML =
  /<!--|<\/?(?:html|head|body|style|script|meta|title|p|br|hr|div|span|font|b|i|u|s|em|strong|small|big|sub|sup|ul|ol|li|dl|dt|dd|h[1-6]|a|img|table|thead|tbody|tfoot|tr|td|th|caption|blockquote|pre|code|center)\b[^>]*>/i;

const DROPPED_WITH_CONTENT = /<(style|script|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const LINE_BREAK = /<br\b[^>]*>|<\/(?:p|div|li|h[1-6])\s*>/gi;
const LIST_ITEM = /<li\b[^>]*>/gi;
const ANY_TAG = /<\/?[a-z][^>]*>|<![^>]*>|<\?[^>]*>/gi;
const ENTITY = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Turns an HTML documentation fragment into plain text. Style, script and
 * head blocks and comments go with their content; line breaks and the ends
 * of paragraphs, divs, list items and headings become line breaks; list
 * items get a bullet; all other tags are dropped and entities decoded.
 * Spaces are collapsed, runs of blank lines kept to one, and the result
 * trimmed. Input without HTML tags is returned as it is. Pure: no DOM.
 */
export function htmlToPlainText(s: string): string {
  if (!LOOKS_LIKE_HTML.test(s)) return s;
  return (
    s
      .replace(COMMENT, '')
      .replace(DROPPED_WITH_CONTENT, '')
      // Source line breaks are plain white space in HTML.
      .replace(/\s+/g, ' ')
      .replace(LINE_BREAK, '\n')
      .replace(LIST_ITEM, '• ')
      .replace(ANY_TAG, '')
      .replace(ENTITY, decodeEntity)
      .split('\n')
      .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

function decodeEntity(whole: string, name: string): string {
  if (name[0] === '#') {
    const hex = name[1] === 'x' || name[1] === 'X';
    const code = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  }
  return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
}
