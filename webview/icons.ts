// Small line icons for the Search tab, drawn as inline SVG in the text
// colour (currentColor), so they follow every theme. No icon font, no
// dependency; the shapes are simple enough to read at 14 px.

import type { IconKind } from './panelText';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Path data per icon, on a 16 × 16 grid. */
const PATHS: Readonly<Record<IconKind, string[]>> = {
  // Objects.
  process: ['M2 4.5h12v7H2z', 'M5 8h6', 'M9 6l2 2-2 2'],
  service: ['M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z', 'M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4'],
  humanService: ['M8 2.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z', 'M3 14c0-3 2.2-5 5-5s5 2 5 5'],
  dataType: ['M2.5 2.5h11v11h-11z', 'M2.5 6h11M2.5 9.5h11M6 6v7.5'],
  // Elements.
  task: ['M2.5 4h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z'],
  userTask: ['M2.5 4h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'M6.5 6.2a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6z', 'M4.5 11c0-1.2.9-2 2-2s2 .8 2 2'],
  scriptTask: ['M2.5 4h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'M5 6.5h3M5 8h4M5 9.5h3'],
  callActivity: ['M2.5 4h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'M2.5 5.5h11', 'M7 8h3M9 7l1 1-1 1'],
  subProcess: ['M2.5 4h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'M6.5 8.5h3v2h-3zM8 9v1'],
  gateway: ['M8 1.8L14.2 8 8 14.2 1.8 8z', 'M6.2 6.2l3.6 3.6M9.8 6.2l-3.6 3.6'],
  event: ['M8 3a5 5 0 1 1 0 10A5 5 0 0 1 8 3z'],
  flow: ['M1.5 8h10', 'M9 5l3 3-3 3'],
  field: ['M2.5 4.5h11M2.5 8h11M2.5 11.5h7'],
};

/** An icon; `label` is what it stands for, for screen readers (it adds no text to the row). */
export function icon(kind: IconKind, label?: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('class', `ls-icon ls-icon-${kind}`);
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  for (const d of PATHS[kind]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
