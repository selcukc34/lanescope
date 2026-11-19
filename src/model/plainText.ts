// Documentation can be rich text: BAW stores it as an HTML fragment, often
// with a <STYLE> block from its editor. The viewer never renders HTML, so the
// readers turn it into plain text here, before anything reaches the webview.
// Text that is not HTML (Bob output, most BAW fields) is returned unchanged.

// Documentation comes from untrusted files, so every pattern here runs in
// linear time: no tag pattern can run past the next "<", and blocks that are
// dropped with their content are found with indexOf, not a lazy regex that
// would rescan the rest of the text for every unclosed opening tag.

/** An HTML comment or a tag HTML documentation uses. "amount < 1000" is neither. */
const LOOKS_LIKE_HTML =
  /<!--|<\/?(?:html|head|body|style|script|meta|title|p|br|hr|div|span|font|b|i|u|s|em|strong|small|big|sub|sup|ul|ol|li|dl|dt|dd|h[1-6]|a|img|table|thead|tbody|tfoot|tr|td|th|caption|blockquote|pre|code|center)\b[^<>]*>/i;

/** Elements dropped together with their content, and their end tags. */
const DROPPED_OPEN = /<(style|script|head)\b[^<>]*>/gi;
const DROPPED_CLOSE: Readonly<Record<string, RegExp>> = {
  style: /<\/style/gi,
  script: /<\/script/gi,
  head: /<\/head/gi,
};
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const LINE_BREAK = /<br\b[^<>]*>|<\/(?:p|div|li|h[1-6])\s*>/gi;
const LIST_ITEM = /<li\b[^<>]*>/gi;
/** A tag; quoted attribute values may hold ">" (onerror="a>b"), so they are matched whole. */
const ANY_TAG = /<\/?[a-z](?:[^<>"']|"[^<"]*"|'[^<']*')*>|<![^<>]*>|<\?[^<>]*>/gi;
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
    dropBlocks(s.replace(COMMENT, ''))
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

/**
 * Removes style, script and head elements with their content. An element
 * that is never closed runs to the end of the text, as in a browser.
 */
function dropBlocks(s: string): string {
  let out = '';
  let from = 0;
  DROPPED_OPEN.lastIndex = 0;
  for (let m = DROPPED_OPEN.exec(s); m; m = DROPPED_OPEN.exec(s)) {
    out += s.slice(from, m.index);
    const closeTag = DROPPED_CLOSE[m[1].toLowerCase()];
    closeTag.lastIndex = DROPPED_OPEN.lastIndex;
    const close = closeTag.exec(s);
    if (!close) return out;
    const end = s.indexOf('>', close.index);
    if (end < 0) return out;
    from = end + 1;
    DROPPED_OPEN.lastIndex = from;
  }
  return out + s.slice(from);
}

function decodeEntity(whole: string, name: string): string {
  if (name[0] === '#') {
    const hex = name[1] === 'x' || name[1] === 'X';
    const code = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  }
  return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
}
