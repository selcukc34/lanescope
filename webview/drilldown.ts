// The drill-down arrow of a collapsed sub-process.
//
// The NavigatedViewer's own drill-down (bpmn-js DrilldownModule) puts an
// arrow on collapsed sub-processes that switches the canvas to a plane of
// the sub-process, which the diagram Lanescope sends does not fill, and
// draws a breadcrumb of its own. Both services are replaced with ones that
// do nothing. Instead the viewer puts the same arrow on every sub-process
// that opens as a level (NodeDetails.openCallee), shown only while that
// sub-process is selected (main.css: diagram-js marks the overlay container
// of a selected element "selected"), and a click on it opens that level, as
// a double-click or "Open sub-process" does. A guard keeps the canvas on the
// root it was imported with.

import type NavigatedViewer from 'bpmn-js/lib/NavigatedViewer';
import type Canvas from 'diagram-js/lib/core/Canvas';
import type ElementRegistry from 'diagram-js/lib/core/ElementRegistry';
import type EventBus from 'diagram-js/lib/core/EventBus';
import type Overlays from 'diagram-js/lib/features/overlays/Overlays';
import type { ElementDetails } from '../src/views/protocol';

type ModuleDeclaration = NonNullable<NonNullable<ConstructorParameters<typeof NavigatedViewer>[0]>['additionalModules']>[number];

/** Replaces bpmn-js's drill-down arrows and breadcrumbs with services that do nothing. */
export const NO_BPMN_DRILLDOWN: ModuleDeclaration = {
  drilldownOverlayBehavior: ['value', {}],
  drilldownBreadcrumbs: ['value', {}],
};

const OVERLAY_TYPE = 'lanescope-drilldown';
const SVG_NS = 'http://www.w3.org/2000/svg';

interface Services {
  get<T>(name: string): T;
}

/** An arrow pointing down and right, into the sub-process. */
function arrowIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M4.5 3.4 L10.5 9.4 L10.5 5 L12 5 L12 12 L5 12 L5 10.5 L9.4 10.5 L3.4 4.5 Z');
  svg.append(path);
  return svg;
}

/**
 * Puts the drill-down arrow on the drawn sub-processes that open as a level,
 * replacing the arrows of an earlier import. A click calls `open` with the
 * level id.
 */
export function addDrilldownArrows(viewer: Services, elements: Record<string, ElementDetails>, open: (levelId: string) => void): void {
  const overlays = viewer.get<Overlays>('overlays');
  const registry = viewer.get<ElementRegistry>('elementRegistry');
  overlays.remove({ type: OVERLAY_TYPE });
  for (const details of Object.values(elements)) {
    if (details.kind !== 'node' || details.containsNodes === undefined || details.openCallee === undefined) continue;
    // Only drawn shapes get an arrow.
    if (!registry.get(details.id)) continue;
    const levelId = details.openCallee;
    const label = `Open ${details.name || details.id}`;
    const button = document.createElement('button');
    button.type = 'button';
    // bjs-drilldown: the look of bpmn-js's own arrow (bpmn-js.css).
    button.className = 'bjs-drilldown ls-drilldown';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.append(arrowIcon());
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      open(levelId);
    });
    overlays.add(details.id, OVERLAY_TYPE, { position: { bottom: -7, right: -8 }, html: button });
  }
}

/** Keeps the canvas on the root an import set: nothing switches it to a plane of a sub-process. */
export function keepImportedRoot(viewer: Services): void {
  const eventBus = viewer.get<EventBus>('eventBus');
  const canvas = viewer.get<Canvas>('canvas');
  let imported: unknown;
  eventBus.on('diagram.clear', () => {
    imported = undefined;
  });
  eventBus.on('import.done', () => {
    imported = canvas.getRootElement();
  });
  eventBus.on('root.set', (e: { element: unknown }) => {
    if (imported !== undefined && e.element !== imported) canvas.setRootElement(imported as Parameters<Canvas['setRootElement']>[0]);
  });
}
