// Reads a process description written in Markdown (the document Bob builds a
// process from) into the parts the trace check compares with the process:
// the steps, the paths of gateways, the business objects and their fields,
// and the fields of human tasks. Line based and deterministic: headings and
// list items only, no Markdown library, no model of the prose. Pure: no
// vscode, no file access.
//
// The kind of a section comes from a keyword in its heading (English, any
// case): steps / activities, gateway / paths / routes, business object /
// data / entity, human task / user task. Deeper headings belong to the
// section above them (a business object or a task name). Sections with no
// keyword are listed as not checked and give no row.

/** Largest description read (bytes of UTF-8 text). */
export const MAX_DESCRIPTION_BYTES = 1024 * 1024;

/** Longest item text kept; longer text is cut. */
const MAX_ITEM_LENGTH = 200;

export class DescriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DescriptionError';
  }
}

/** One list item of the description. */
export interface DescriptionItem {
  text: string;
  /** 1-based line number in the description. */
  line: number;
}

export interface GatewayPathGroup {
  /** Heading of the section the group is in. */
  section: string;
  /** "after <X>": the step the gateway follows. */
  after?: string;
  /** A sub-heading that names the gateway itself. */
  gateway?: string;
  paths: DescriptionItem[];
}

export interface DescribedBusinessObject {
  section: string;
  /** "Name:" line or sub-heading; undefined when the section names none. */
  name?: string;
  fields: DescriptionItem[];
}

export interface DescribedHumanTask {
  section: string;
  name: string;
  line: number;
  fields: DescriptionItem[];
}

export interface StepGroup {
  section: string;
  steps: DescriptionItem[];
}

export interface ProcessDescription {
  /** The first level-1 heading, when it is the document's title. */
  title?: string;
  steps: StepGroup[];
  gatewayPaths: GatewayPathGroup[];
  businessObjects: DescribedBusinessObject[];
  humanTasks: DescribedHumanTask[];
  /** Headings of the sections the check does not look at, in document order. */
  notChecked: string[];
}

export type SectionKind = 'steps' | 'gatewayPaths' | 'businessObject' | 'humanTasks';

/** Most specific first: "Human tasks" is about tasks, not steps; "Business object" is not a step list. */
const SECTION_KEYWORDS: Array<[SectionKind, RegExp]> = [
  ['humanTasks', /\b(?:human|user)\s+tasks?\b/i],
  ['businessObject', /\b(?:business\s+objects?|data|entit(?:y|ies))\b/i],
  ['gatewayPaths', /\b(?:gateways?|paths?|routes)\b/i],
  ['steps', /\b(?:steps?|activit(?:y|ies))\b/i],
];

/** The kind of a section by its heading, or undefined when the check does not look at it. */
export function sectionKind(heading: string): SectionKind | undefined {
  return SECTION_KEYWORDS.find(([, re]) => re.test(heading))?.[0];
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^( {0,3})(?:[-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^\s{0,3}(```|~~~)/;
/** "after Determine Order Route should have …": the words up to a verb or punctuation. */
const AFTER = /\bafter\s+(?:the\s+)?(?:step\s+|activity\s+|task\s+)?["'“”‘’`]?(.+?)["'“”‘’`]?(?=\s+(?:should|must|shall|will|has|have|is|are|with|leads?|splits?|branches)\b|\s*[,:;.(]|\s*$)/i;
/** "OrderRequest:" on a line of its own. */
const NAME_LINE = /^[*_`\s]*([A-Za-z_][\w.]*)[*_`\s]*:\s*$/;

/** Text of a list item or heading without Markdown emphasis, code marks and links. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, (m, offset: number, all: string) => {
      // Keep an underscore inside a word (AUTO_APPROVE, order_id).
      const before = all[offset - 1];
      const after = all[offset + m.length];
      return m[0] === '_' && before !== undefined && after !== undefined && /\w/.test(before) && /\w/.test(after) ? m : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The name a list item gives: the text before a ":", " (", " - " or a dash
 * that starts its explanation, without a trailing full stop.
 */
export function itemName(markdown: string): string {
  const text = plainText(markdown);
  const cut = text.search(/:\s|:$|\s\(|\s[-–—]\s/);
  const name = (cut >= 0 ? text.slice(0, cut) : text).replace(/[.;,]+$/, '').trim();
  return name.length > MAX_ITEM_LENGTH ? name.slice(0, MAX_ITEM_LENGTH) : name;
}

function utf8Length(text: string): number {
  // Fast bound first: UTF-8 takes at most 3 bytes per UTF-16 code unit.
  if (text.length * 3 <= MAX_DESCRIPTION_BYTES) return text.length;
  return new TextEncoder().encode(text).length;
}

/** Reads a description. Throws DescriptionError when it is larger than MAX_DESCRIPTION_BYTES. */
export function parseDescription(markdown: string): ProcessDescription {
  if (utf8Length(markdown) > MAX_DESCRIPTION_BYTES) {
    throw new DescriptionError(`The description is larger than ${MAX_DESCRIPTION_BYTES / (1024 * 1024)} MB.`);
  }
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const out: ProcessDescription = { steps: [], gatewayPaths: [], businessObjects: [], humanTasks: [], notChecked: [] };

  /** The section being read: its kind (undefined when not checked), heading and heading level. */
  let section: { kind: SectionKind | undefined; heading: string; level: number } | undefined;
  let steps: StepGroup | undefined;
  let gateway: GatewayPathGroup | undefined;
  let bo: DescribedBusinessObject | undefined;
  let task: DescribedHumanTask | undefined;
  let fence: string | undefined;
  let sawHeading = false;

  const startSection = (kind: SectionKind | undefined, heading: string, level: number) => {
    section = { kind, heading, level };
    steps = gateway = bo = task = undefined;
    if (kind === undefined) out.notChecked.push(heading);
  };

  for (const [index, raw] of lines.entries()) {
    const lineNo = index + 1;
    const fenceMatch = FENCE.exec(raw);
    if (fence !== undefined) {
      if (fenceMatch && fenceMatch[1] === fence) fence = undefined;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }

    const heading = HEADING.exec(raw);
    if (heading) {
      const level = heading[1].length;
      const text = plainText(heading[2]);
      const first = !sawHeading;
      sawHeading = true;
      if (first && level === 1 && sectionKind(text) === undefined) {
        out.title = text;
        section = undefined;
        continue;
      }
      const kind = sectionKind(text);
      // A deeper heading inside a checked section names a part of it (a business object, a task, a gateway).
      if (section?.kind !== undefined && level > section.level && (kind === undefined || kind === section.kind)) {
        if (section.kind === 'humanTasks') {
          task = { section: section.heading, name: itemName(heading[2]), line: lineNo, fields: [] };
          out.humanTasks.push(task);
        } else if (section.kind === 'businessObject') {
          bo = { section: section.heading, name: itemName(heading[2]), fields: [] };
          out.businessObjects.push(bo);
        } else if (section.kind === 'gatewayPaths') {
          const after = AFTER.exec(text)?.[1];
          gateway = {
            section: section.heading,
            ...(after ? { after: itemName(after) } : { gateway: itemName(heading[2].replace(/\bgateway\b/i, '')) }),
            paths: [],
          };
          out.gatewayPaths.push(gateway);
        }
        continue;
      }
      startSection(kind, text, level);
      continue;
    }

    if (!section || section.kind === undefined) continue;
    const item = LIST_ITEM.exec(raw);
    const kind = section.kind;

    if (!item) {
      const text = plainText(raw);
      if (text === '') continue;
      if (kind === 'gatewayPaths') {
        const after = AFTER.exec(text)?.[1];
        if (after) {
          gateway = { section: section.heading, after: itemName(after), paths: [] };
          out.gatewayPaths.push(gateway);
        }
      } else if (kind === 'businessObject') {
        const name = NAME_LINE.exec(raw.trim())?.[1];
        if (name) {
          bo = { section: section.heading, name, fields: [] };
          out.businessObjects.push(bo);
        }
      }
      continue;
    }

    const text = itemName(item[2]);
    if (text === '') continue;
    const entry: DescriptionItem = { text, line: lineNo };
    if (kind === 'steps') {
      if (!steps) out.steps.push((steps = { section: section.heading, steps: [] }));
      steps.steps.push(entry);
    } else if (kind === 'gatewayPaths') {
      if (!gateway) out.gatewayPaths.push((gateway = { section: section.heading, paths: [] }));
      gateway.paths.push(entry);
    } else if (kind === 'businessObject') {
      if (!bo) out.businessObjects.push((bo = { section: section.heading, fields: [] }));
      bo.fields.push(entry);
    } else if (task) {
      // Items before the first task heading name no task: nothing to compare them with.
      task.fields.push(entry);
    }
  }
  return out;
}
