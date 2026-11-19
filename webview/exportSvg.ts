// Pure helpers of the SVG and PNG export (no DOM), so they are unit-tested
// in plain Node. The drawing itself is in ./exportImage.

export const EXPORT_FILL = '#ffffff';
export const EXPORT_STROKE = '#000000';

/** Scale of a PNG export, before the limits below. */
export const PNG_SCALE = 2;
/** Longest side of a PNG export, in pixels. */
export const MAX_PNG_SIDE = 16384;
/** Most pixels of a PNG export. */
export const MAX_PNG_PIXELS = 64_000_000;

interface SvgSize {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The viewBox of the SVG's root element, or undefined when it has none. */
export function svgViewBox(svg: string): SvgSize | undefined {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0];
  const box = root && /\sviewBox="([^"]*)"/.exec(root)?.[1];
  if (!box) return undefined;
  const values = box.trim().split(/[\s,]+/).map(Number);
  if (values.length !== 4 || !values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) return undefined;
  const [x, y, width, height] = values;
  return { x, y, width, height };
}

/**
 * The SVG from saveSVG() as an export file: starting at the <svg> element
 * (the XML declaration and DOCTYPE dropped) with a white rectangle behind the
 * diagram.
 */
export function exportSvg(saved: string): string {
  const start = saved.indexOf('<svg');
  if (start < 0) throw new Error('The diagram could not be drawn as SVG.');
  const svg = saved.slice(start);
  const box = svgViewBox(svg);
  const open = /<svg\b[^>]*>/.exec(svg);
  if (!box || !open) throw new Error('The drawn SVG has no size.');
  const rect = `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="${EXPORT_FILL}"/>`;
  const end = open.index + open[0].length;
  return svg.slice(0, end) + rect + svg.slice(end);
}

/** Scale for a PNG of a width x height diagram: PNG_SCALE, or less to stay within the limits. */
export function pngScale(width: number, height: number): number {
  let scale = PNG_SCALE;
  const longest = Math.max(width, height);
  if (longest * scale > MAX_PNG_SIDE) scale = MAX_PNG_SIDE / longest;
  if (width * height * scale * scale > MAX_PNG_PIXELS) scale = Math.sqrt(MAX_PNG_PIXELS / (width * height));
  return scale;
}

/** The SVG as a data: URL an image can load. */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
