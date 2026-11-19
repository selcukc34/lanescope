// HTML shell of the viewer webview. Pure, so the CSP can be unit-tested.

export interface WebviewHtmlParams {
  /** webview.cspSource */
  cspSource: string;
  /** Webview URI of dist/webview/main.js */
  scriptUri: string;
  /** Webview URI of dist/webview/main.css */
  styleUri: string;
  nonce: string;
  title: string;
}

/**
 * Strict CSP: only the bundled script (by nonce) and bundled styles; no
 * network. base-uri and form-action do not fall back to default-src, so they
 * are closed explicitly.
 */
export function buildCsp(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src ${cspSource}`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

export function buildWebviewHtml(p: WebviewHtmlParams): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeAttr(buildCsp(p.cspSource, p.nonce))}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${escapeAttr(p.styleUri)}">
  <title>${escapeText(p.title)}</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${escapeAttr(p.nonce)}" src="${escapeAttr(p.scriptUri)}"></script>
</body>
</html>`;
}

export function createNonce(random: (size: number) => Uint8Array): string {
  return Buffer.from(random(24)).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
