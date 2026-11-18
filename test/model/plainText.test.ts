import { describe, expect, it } from 'vitest';
import { htmlToPlainText } from '../../src/model/plainText';

describe('htmlToPlainText', () => {
  it('drops the STYLE block and head of BAW rich text with their content', () => {
    const html =
      '<HTML><HEAD>\r\n<STYLE type=text/css> p{margin:0px;}</STYLE>\r\n</HEAD>\r\n' +
      '<BODY style="FONT-SIZE: 10pt; FONT-FAMILY: arial" bgColor=#f5f5f5>Checks the order.</BODY></HTML>';
    expect(htmlToPlainText(html)).toBe('Checks the order.');
    expect(htmlToPlainText('<STYLE type=text/css> p{margin:0px;}</STYLE><p>Text</p>')).toBe('Text');
  });

  it('drops script blocks and comments', () => {
    expect(htmlToPlainText('<p>A<!-- hidden --></p><script>alert(1)</script><p>B</p>')).toBe('A\nB');
  });

  it('puts paragraphs and line breaks on lines of their own', () => {
    expect(htmlToPlainText('<p>First paragraph.</p><p>Second<br>line<br/>three</p>')).toBe(
      'First paragraph.\nSecond\nline\nthree',
    );
    expect(htmlToPlainText('<div>One</div><div>Two</div><h2>Head</h2>Tail')).toBe('One\nTwo\nHead\nTail');
  });

  it('turns list items into bullets', () => {
    expect(htmlToPlainText('<p>Steps:</p><ul><li>Validate</li><li>Route</li></ul>')).toBe('Steps:\n• Validate\n• Route');
  });

  it('decodes entities', () => {
    expect(htmlToPlainText('<p>a&nbsp;&amp;&nbsp;b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#65;&#x42;&#X43;</p>')).toBe(
      `a & b <c> "d" 'e' ABC`,
    );
    expect(htmlToPlainText('<p>&unknown; &#0;</p>')).toBe('&unknown; &#0;');
  });

  it('collapses spaces and keeps at most one blank line', () => {
    expect(htmlToPlainText('<p>  a \t  b  </p><br><br><br><br><p>c</p>\n\n')).toBe('a b\n\nc');
  });

  it('reads upper-case tags', () => {
    expect(htmlToPlainText('<P>One</P><P>Two<BR>Three</P><UL><LI>Four</LI></UL>')).toBe('One\nTwo\nThree\n• Four');
  });

  it('returns text without tags unchanged', () => {
    for (const text of [
      'Validates the order.\n\n  Then routes it.  ',
      'tw.local.amount < 1000 && tw.local.x > 5',
      'Tom &amp; Jerry',
      '',
    ]) {
      expect(htmlToPlainText(text)).toBe(text);
    }
  });
});
