// parseDescription: the sections of Bob's description of the Order Delivery
// Process, the rules of the Lanescope description format (README), and the
// template that "New Process Description" writes.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DescriptionError, itemName, MAX_DESCRIPTION_BYTES, parseDescription, SECTION_HEADINGS, sectionKind } from '../../src/trace/description';
import { DESCRIPTION_TEMPLATE } from '../../src/trace/template';

const DESCRIPTION_MD = path.join(__dirname, '..', 'fixtures', 'bob', 'order-delivery-process-description.md');
const README = readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');

describe('parseDescription on the Bob description', () => {
  const d = parseDescription(readFileSync(DESCRIPTION_MD, 'utf8'));

  it('reads the title and the nine main steps', () => {
    expect(d.title).toBe('Order Delivery Process Description');
    expect(d.sections).toEqual(['steps', 'gatewayPaths', 'businessObject', 'humanTasks']);
    expect(d.steps).toHaveLength(1);
    expect(d.steps[0].section).toBe('Main process steps');
    expect(d.steps[0].steps.map((s) => s.text)).toEqual([
      'Submit Order',
      'Validate Order',
      'Lookup Country Info',
      'Determine Order Route',
      'Route Order',
      'Auto Complete Order',
      'Manager Approval',
      'Compliance Review',
      'Handle Exception',
    ]);
    expect(d.steps[0].steps[0].line).toBe(9);
  });

  it('reads the four gateway paths and the step the gateway follows', () => {
    expect(d.gatewayPaths).toEqual([
      {
        section: 'Gateway paths',
        after: 'Determine Order Route',
        paths: [
          { text: 'AUTO_APPROVE', line: 53 },
          { text: 'MANAGER_APPROVAL', line: 54 },
          { text: 'COMPLIANCE_REVIEW', line: 55 },
          { text: 'EXCEPTION', line: 56 },
        ],
      },
    ]);
  });

  it('reads OrderRequest and its eleven fields', () => {
    expect(d.businessObjects).toHaveLength(1);
    expect(d.businessObjects[0].name).toBe('OrderRequest');
    expect(d.businessObjects[0].fields.map((f) => f.text)).toEqual([
      'orderId',
      'customerId',
      'amount',
      'countryCode',
      'countryName',
      'countryRegion',
      'route',
      'requiresApproval',
      'status',
      'decisionReason',
      'externalErrorMessage',
    ]);
  });

  it('reads the three human tasks and their fields', () => {
    expect(d.humanTasks.map((t) => [t.name, t.fields.map((f) => f.text)])).toEqual([
      ['Manager Approval', ['orderId', 'customerId', 'amount', 'countryName', 'countryRegion', 'decisionReason']],
      ['Compliance Review', ['orderId', 'customerId', 'countryCode', 'countryName', 'countryRegion', 'decisionReason']],
      ['Handle Exception', ['orderId', 'customerId', 'countryCode', 'externalErrorMessage', 'decisionReason']],
    ]);
  });

  it('lists the other sections as not checked and takes nothing from them', () => {
    expect(d.notChecked).toEqual(['Business scenario', 'Validation rules', 'Country lookup', 'Routing rules', 'Expected output']);
    // Their lists ("Validation rules", "Country lookup", "Routing rules") are free text.
    const all = [
      ...d.steps.flatMap((g) => g.steps),
      ...d.gatewayPaths.flatMap((g) => g.paths),
      ...d.businessObjects.flatMap((b) => b.fields),
      ...d.humanTasks.flatMap((t) => t.fields),
    ];
    expect(all.some((i) => i.line >= 19 && i.line <= 47)).toBe(false);
    // "After country lookup, …" in Routing rules starts no gateway group.
    expect(d.gatewayPaths).toHaveLength(1);
  });
});

describe('Lanescope description format', () => {
  it('recognises exactly the four headings of the format, in any case, as "##" headings only', () => {
    expect(SECTION_HEADINGS).toEqual({
      steps: 'Main process steps',
      gatewayPaths: 'Gateway paths',
      businessObject: 'Business object',
      humanTasks: 'Human tasks',
    });
    expect(sectionKind('main PROCESS steps')).toBe('steps');
    expect(sectionKind('Human tasks')).toBe('humanTasks');
    // Keywords alone are not headings of the format.
    for (const free of ['Steps', 'Activities', 'Routes', 'Paths', 'Data', 'Entities', 'User tasks', 'Business objects', 'Routing rules', 'Expected output']) {
      expect(sectionKind(free)).toBeUndefined();
    }
    const d = parseDescription('# Title\n\n### Main process steps\n\n- Not a step\n\n# Main process steps\n\n- Not a step either\n');
    expect(d.sections).toEqual([]);
    expect(d.steps).toEqual([]);
  });

  it('documents the same headings in the README spec', () => {
    const spec = README.slice(README.indexOf('## Lanescope description format'), README.indexOf('## Description traceability'));
    expect(spec.length).toBeGreaterThan(200);
    for (const heading of Object.values(SECTION_HEADINGS)) expect(spec).toContain(`## ${heading}`);
  });

  it('reads the README example as the spec says', () => {
    const spec = README.slice(README.indexOf('## Lanescope description format'), README.indexOf('### Asking Bob'));
    const example = /```markdown\n([\s\S]*?)```/.exec(spec)![1];
    const d = parseDescription(example);
    expect(d.sections).toEqual(['steps', 'gatewayPaths', 'businessObject', 'humanTasks']);
    expect(d.notChecked).toEqual(['Business scenario']);
    expect(d.gatewayPaths[0].after).toBe('Determine Order Route');
    expect(d.businessObjects[0].name).toBe('OrderRequest');
    expect(d.humanTasks[0].name).toBe('Manager Approval');
  });

  it('takes the name of an item before its explanation, without Markdown marks', () => {
    expect(itemName('**Validate Order**: checks the order')).toBe('Validate Order');
    expect(itemName('`orderId` (string)')).toBe('orderId');
    expect(itemName('Ship Order - sends the parcel')).toBe('Ship Order');
    expect(itemName('[Route Order](#route)')).toBe('Route Order');
    expect(itemName('AUTO_APPROVE.')).toBe('AUTO_APPROVE');
  });

  it('reads one gateway group per "### After <step>" sub-heading', () => {
    const d = parseDescription(
      [
        '## Main process steps',
        '- Check Stock',
        '- Pack',
        '## Gateway paths',
        '### After Check Stock',
        '- IN_STOCK',
        '- OUT_OF_STOCK',
        '### After Pack',
        '1. ROAD',
        '2) AIR',
        '### Notes',
        '- not a path',
      ].join('\n'),
    );
    expect(d.gatewayPaths).toEqual([
      { section: 'Gateway paths', after: 'Check Stock', paths: [{ text: 'IN_STOCK', line: 6 }, { text: 'OUT_OF_STOCK', line: 7 }] },
      { section: 'Gateway paths', after: 'Pack', paths: [{ text: 'ROAD', line: 9 }, { text: 'AIR', line: 10 }] },
    ]);
  });

  it('reads paths with no step named as one group for any gateway', () => {
    expect(parseDescription('## Gateway paths\n\nFour paths:\n\n- A\n- B\n').gatewayPaths).toEqual([
      { section: 'Gateway paths', paths: [{ text: 'A', line: 5 }, { text: 'B', line: 6 }] },
    ]);
  });

  it('reads several business objects, by "<Name>:" line and by "### <Name>"; fields before a name belong to none', () => {
    const d = parseDescription(['## Business object', '- orphan', 'Parcel:', '- weight', '### Address', '- street', '- city'].join('\n'));
    expect(d.businessObjects.map((b) => [b.name, b.fields.map((f) => f.text)])).toEqual([
      ['Parcel', ['weight']],
      ['Address', ['street', 'city']],
    ]);
  });

  it('skips code blocks, HTML comments (also over several lines) and nested list items', () => {
    const d = parseDescription(
      [
        '## Main process steps',
        '- Pack',
        '```',
        '- Not a step',
        '```',
        '<!-- - Not a step either',
        '     the gateway after Pack has two paths -->',
        '    - nested, not a step',
        '* Ship <!-- a comment --> Parcel',
      ].join('\n'),
    );
    expect(d.steps[0].steps.map((s) => s.text)).toEqual(['Pack', 'Ship Parcel']);
  });

  it('gives no section for a description of paragraphs only', () => {
    const d = parseDescription('# Shipping\n\nWe pack the parcel and ship it.\n\n## Overview\n\nMore text.\n');
    expect(d.sections).toEqual([]);
    expect(d.notChecked).toEqual(['Overview']);
  });

  it('handles CRLF line ends and a byte order mark', () => {
    const d = parseDescription(String.fromCharCode(0xfeff) + '## Main process steps\r\n- One\r\n- Two\r\n');
    expect(d.steps[0].steps.map((s) => s.text)).toEqual(['One', 'Two']);
  });

  it('refuses a description larger than 1 MB', () => {
    expect(MAX_DESCRIPTION_BYTES).toBe(1024 * 1024);
    expect(() => parseDescription(`## Main process steps\n${'- x\n'.repeat(MAX_DESCRIPTION_BYTES / 4 + 1)}`)).toThrow(DescriptionError);
    // Multi-byte text counts in UTF-8 bytes.
    expect(() => parseDescription('ş'.repeat(MAX_DESCRIPTION_BYTES / 2 + 1))).toThrow(/larger than 1 MB/);
  });
});

describe('the template of "New Process Description"', () => {
  const d = parseDescription(DESCRIPTION_TEMPLATE);

  it('has every section of the format, and its comments give nothing', () => {
    expect(d.sections).toEqual(['steps', 'gatewayPaths', 'businessObject', 'humanTasks']);
    expect(d.notChecked).toEqual(['Business scenario', 'Expected output']);
    expect(d.steps[0].steps.map((s) => s.text)).toEqual(['Receive Request', 'Check Request', 'Route Request', 'Approve Request', 'Reject Request']);
    // The comment mentions "after <step>": only the sentence below it starts a group.
    expect(d.gatewayPaths.map((g) => [g.after, g.paths.map((p) => p.text)])).toEqual([['Check Request', ['APPROVE', 'REJECT']]]);
    expect(d.businessObjects.map((b) => [b.name, b.fields.map((f) => f.text)])).toEqual([['RequestData', ['requestId', 'status']]]);
    expect(d.humanTasks.map((t) => [t.name, t.fields.map((f) => f.text)])).toEqual([['Approve Request', ['requestId', 'status']]]);
  });

  it('is the template the README gives for Bob, word for word', () => {
    expect(README).toContain(DESCRIPTION_TEMPLATE.trimEnd());
  });
});
