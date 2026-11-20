// Reads a process description in the Lanescope description format (README,
// "Lanescope description format") into the parts the trace check compares
// with the process: the steps, the paths of gateways, the business objects
// and their fields, and the fields of human tasks. Line based and
// deterministic: headings and list items only, no Markdown library, no
// model of the prose. Pure: no vscode, no file access.
//
// The rules here are the format's rules, no more: a "##" heading whose text
// is one of SECTION_HEADINGS (any case) starts a checked section; any other
// "##" heading starts free text. Inside a checked section:
//   - Main process steps: every list item is a step.
//   - Gateway paths: list items are paths; "after <step>" in a line, or a
//     "### After <step>" sub-heading, starts a group for the gateway after
//     that step.
//   - Business object: a "<Name>:" line or a "### <Name>" sub-heading starts
//     a business object; list items are its fields.
//   - Human tasks: a "### <task>" sub-heading starts a task; list items are
//     its fields.
// Everywhere: code blocks and HTML comments are skipped, only top-level list
// items count, and an item's name is its text up to ":", " (" or " - ".

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

export type SectionKind = 'steps' | 'gatewayPaths' | 'businessObject' | 'humanTasks';

/** The headings of the checked sections, as the format names them. */
export const SECTION_HEADINGS: Readonly<Record<SectionKind, string>> = {
  steps: 'Main process steps',
  gatewayPaths: 'Gateway paths',
  businessObject: 'Business object',
  humanTasks: 'Human tasks',
};

/** One list item of the description. */
export interface DescriptionItem {
  text: string;
  /** 1-based line number in the description. */
  line: number;
}

export interface GatewayPathGroup {
  /** Heading of the section the group is in. */
  section: string;
  /** "after <X>": the step the gateway follows; undefined: any gateway. */
  after?: string;
  paths: DescriptionItem[];
}

export interface DescribedBusinessObject {
  section: string;
  name: string;
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
  /** The first level-1 heading, when it comes before any other heading. */
  title?: string;
  /** The kinds of the checked sections the description has, in document order (once each). */
  sections: SectionKind[];
  steps: StepGroup[];
  gatewayPaths: GatewayPathGroup[];
  businessObjects: DescribedBusinessObject[];
  humanTasks: DescribedHumanTask[];
  /** Headings of the free-text sections, in document order. */
  notChecked: string[];
}

/** The kind of a "##" section by its heading text, or undefined for free text. */
export function sectionKind(heading: string): SectionKind | undefined {
  const text = heading.trim().toLowerCase();
  return (Object.keys(SECTION_HEADINGS) as SectionKind[]).find((k) => SECTION_HEADINGS[k].toLowerCase() === text);
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^( {0,3})(?:[-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^\s{0,3}(```|~~~)/;
/** "after Determine Order Route should have …": the step name ends at should/must/shall/will/has/have/is/are, punctuation or the line end. */
const AFTER = /\bafter\s+(.+?)(?=\s+(?:should|must|shall|will|has|have|is|are)\b|\s*[,:;.(]|\s*$)/i;
/** "### After Determine Order Route" */
const AFTER_HEADING = /^after\s+(.+)$/i;
/** "OrderRequest:" on a line of its own. */
const NAME_LINE = /^[*_`\s]*([A-Za-z_][\w.]*)[*_`\s]*:\s*$/;
const BOM = String.fromCharCode(0xfeff);

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

/** The name a list item gives: its text up to ":", " (" or " - " (or an en or em dash), without a trailing full stop. */
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

/** The lines with HTML comments blanked (a comment may span lines); line numbers stay. */
function withoutComments(lines: string[]): string[] {
  let inComment = false;
  return lines.map((line) => {
    let out = '';
    let rest = line;
    while (rest.length > 0) {
      if (inComment) {
        const end = rest.indexOf('-->');
        if (end < 0) return out;
        rest = rest.slice(end + 3);
        inComment = false;
      } else {
        const start = rest.indexOf('<!--');
        if (start < 0) return out + rest;
        out += rest.slice(0, start);
        rest = rest.slice(start + 4);
        inComment = true;
      }
    }
    return out;
  });
}

/** Reads a description. Throws DescriptionError when it is larger than MAX_DESCRIPTION_BYTES. */
export function parseDescription(markdown: string): ProcessDescription {
  if (utf8Length(markdown) > MAX_DESCRIPTION_BYTES) {
    throw new DescriptionError(`The description is larger than ${MAX_DESCRIPTION_BYTES / (1024 * 1024)} MB.`);
  }
  const text = markdown.startsWith(BOM) ? markdown.slice(1) : markdown;
  const lines = withoutComments(text.split(/\r\n|\r|\n/));
  const out: ProcessDescription = { sections: [], steps: [], gatewayPaths: [], businessObjects: [], humanTasks: [], notChecked: [] };

  /** The checked section being read, or undefined in free text. */
  let section: { kind: SectionKind; heading: string } | undefined;
  let steps: StepGroup | undefined;
  let gateway: GatewayPathGroup | undefined;
  let bo: DescribedBusinessObject | undefined;
  let task: DescribedHumanTask | undefined;
  let fence: string | undefined;
  let sawHeading = false;

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
      const headingText = plainText(heading[2]);
      const first = !sawHeading;
      sawHeading = true;
      if (level <= 2) {
        // A new section: checked when it is a "##" heading the format names.
        steps = gateway = bo = task = undefined;
        const kind = level === 2 ? sectionKind(headingText) : undefined;
        if (kind) {
          section = { kind, heading: headingText };
          if (!out.sections.includes(kind)) out.sections.push(kind);
        } else {
          section = undefined;
          if (level === 1 && first) out.title = headingText;
          else out.notChecked.push(headingText);
        }
        continue;
      }
      if (!section) continue;
      // A sub-heading inside a checked section.
      if (section.kind === 'humanTasks') {
        task = { section: section.heading, name: itemName(heading[2]), line: lineNo, fields: [] };
        out.humanTasks.push(task);
      } else if (section.kind === 'businessObject') {
        bo = { section: section.heading, name: itemName(heading[2]), fields: [] };
        out.businessObjects.push(bo);
      } else if (section.kind === 'gatewayPaths') {
        const after = AFTER_HEADING.exec(headingText)?.[1];
        // Only "### After <step>" starts a group; items under another sub-heading are not paths.
        gateway = after ? { section: section.heading, after: itemName(after), paths: [] } : undefined;
        if (gateway) out.gatewayPaths.push(gateway);
        else gateway = { section: section.heading, paths: [] };
      }
      continue;
    }

    if (!section) continue;
    const item = LIST_ITEM.exec(raw);
    const kind = section.kind;

    if (!item) {
      const line = plainText(raw);
      if (line === '') continue;
      if (kind === 'gatewayPaths') {
        const after = AFTER.exec(line)?.[1];
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

    const name = itemName(item[2]);
    if (name === '') continue;
    const entry: DescriptionItem = { text: name, line: lineNo };
    if (kind === 'steps') {
      if (!steps) out.steps.push((steps = { section: section.heading, steps: [] }));
      steps.steps.push(entry);
    } else if (kind === 'gatewayPaths') {
      if (!gateway) out.gatewayPaths.push((gateway = { section: section.heading, paths: [] }));
      // A group that is not in the list (another sub-heading) drops its items.
      if (out.gatewayPaths.includes(gateway)) gateway.paths.push(entry);
    } else if (bo) {
      // Fields before the first name belong to no business object.
      bo.fields.push(entry);
    } else if (task) {
      task.fields.push(entry);
    }
  }
  return out;
}
