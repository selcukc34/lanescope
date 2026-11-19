// SVG and PNG export of a diagram. The image does not follow the VS Code
// theme: a second, hidden NavigatedViewer draws the export BPMN the host sent
// with fixed light colours (white fill, black lines) on a white background.
// The PNG is drawn from the SVG through a data: URL (the CSP allows data:
// images; no blob: URL, no network).

import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';
import { h } from './dom';
import { EXPORT_FILL, EXPORT_STROKE, exportSvg, pngScale, svgDataUrl, svgViewBox } from './exportSvg';

/** Draws the BPMN in a hidden viewer with light colours and returns the export SVG. */
export async function renderExportSvg(xml: string): Promise<string> {
  // Off screen but laid out: bpmn-js measures the drawing for the SVG's size.
  const host = h('div', { class: 'export-host', 'aria-hidden': 'true' });
  document.body.append(host);
  const viewer = new NavigatedViewer({
    container: host,
    keyboard: { bind: false },
    bpmnRenderer: {
      defaultFillColor: EXPORT_FILL,
      defaultStrokeColor: EXPORT_STROKE,
      defaultLabelColor: EXPORT_STROKE,
    },
  });
  try {
    await viewer.importXML(xml);
    const { svg } = await viewer.saveSVG();
    return exportSvg(svg);
  } finally {
    viewer.destroy();
    host.remove();
  }
}

/** Draws the export SVG on a canvas and returns it as a PNG data URL. */
export async function renderExportPng(svg: string): Promise<string> {
  const box = svgViewBox(svg);
  if (!box) throw new Error('The drawn SVG has no size.');
  const image = new Image();
  image.src = svgDataUrl(svg);
  await image.decode();
  const scale = pngScale(box.width, box.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(box.width * scale));
  canvas.height = Math.max(1, Math.floor(box.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The browser cannot draw the PNG.');
  context.fillStyle = EXPORT_FILL;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const png = canvas.toDataURL('image/png');
  if (!png.startsWith('data:image/png;base64,')) throw new Error('The diagram is too large for a PNG.');
  return png;
}
