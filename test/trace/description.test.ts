// parseDescription: the sections of Bob's description of the Order Delivery
// Process, and the Markdown forms the reader accepts.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DescriptionError, itemName, MAX_DESCRIPTION_BYTES, parseDescription, sectionKind } from '../../src/trace/description';

const DESCRIPTION_MD = path.join(__dirname, '..', 'fixtures', 'bob', 'order-delivery-process-description.md');

describe('parseDescription on the Bob description', () => {
  const d = parseDescription(readFileSync(DESCRIPTION_MD, 'utf8'));

  it('reads the title and the nine main steps', () => {
    expect(d.title).toBe('Order Delivery Process');
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
    expect(d.steps[0].steps[0].line).toBe(11);
  });

  it('reads the four gateway paths and the step the gateway follows', () => {
    expect(d.gatewayPaths).toEqual([
      {
        section: 'Gateway paths',
        after: 'Determine Order Route',
        paths: [
          { text: 'AUTO_APPROVE', line: 47 },
          { text: 'MANAGER_APPROVAL', line: 48 },
          { text: 'COMPLIANCE_REVIEW', line: 49 },
          { text: 'EXCEPTION', line: 50 },
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
    // "Routing rules" holds a numbered list: none of it is a step or a path.
    const all = [...d.steps.flatMap((g) => g.steps), ...d.gatewayPaths.flatMap((g) => g.paths)].map((i) => i.text);
    expect(all.some((t) => /amount|lookup failed/i.test(t))).toBe(false);
  });
});

describe('parseDescription forms', () => {
  it('finds the kind of a section by a keyword of its heading, in any case', () => {
    expect(sectionKind('Main process steps')).toBe('steps');
    expect(sectionKind('ACTIVITIES')).toBe('steps');
    expect(sectionKind('Gateway paths')).toBe('gatewayPaths');
    expect(sectionKind('Routes')).toBe('gatewayPaths');
    expect(sectionKind('Business object')).toBe('businessObject');
    expect(sectionKind('Data')).toBe('businessObject');
    expect(sectionKind('Entities')).toBe('businessObject');
    expect(sectionKind('Human tasks')).toBe('humanTasks');
    expect(sectionKind('User Task')).toBe('humanTasks');
    expect(sectionKind('Routing rules')).toBeUndefined();
    expect(sectionKind('Expected output')).toBeUndefined();
  });

  it('takes the name of an item before its explanation, without Markdown marks', () => {
    expect(itemName('**Validate Order**: checks the order')).toBe('Validate Order');
    expect(itemName('`orderId` (string)')).toBe('orderId');
    expect(itemName('Ship Order - sends the parcel')).toBe('Ship Order');
    expect(itemName('[Route Order](#route)')).toBe('Route Order');
    expect(itemName('AUTO_APPROVE.')).toBe('AUTO_APPROVE');
  });

  it('reads business objects from sub-headings, gateways by name, and skips code blocks', () => {
    const d = parseDescription(
      [
        '# Shipping',
        '## Steps',
        '- Pack',
        '```',
        '- Not a step',
        '```',
        '* Ship',
        '## Data',
        '### Parcel',
        '- weight',
        '### Address',
        '- street',
        '## Routes',
        '### Carrier Gateway',
        '1. ROAD',
        '2) AIR',
      ].join('\n'),
    );
    expect(d.steps[0].steps.map((s) => s.text)).toEqual(['Pack', 'Ship']);
    expect(d.businessObjects.map((b) => [b.name, b.fields.map((f) => f.text)])).toEqual([
      ['Parcel', ['weight']],
      ['Address', ['street']],
    ]);
    expect(d.gatewayPaths).toEqual([{ section: 'Routes', gateway: 'Carrier', paths: [{ text: 'ROAD', line: 15 }, { text: 'AIR', line: 16 }] }]);
    expect(d.notChecked).toEqual([]);
  });

  it('handles CRLF line ends and a byte order mark', () => {
    const d = parseDescription('﻿## Steps\r\n- One\r\n- Two\r\n');
    expect(d.steps[0].steps.map((s) => s.text)).toEqual(['One', 'Two']);
  });

  it('refuses a description larger than 1 MB', () => {
    expect(MAX_DESCRIPTION_BYTES).toBe(1024 * 1024);
    expect(() => parseDescription(`## Steps\n${'- x\n'.repeat(MAX_DESCRIPTION_BYTES / 4 + 1)}`)).toThrow(DescriptionError);
    // Multi-byte text counts in UTF-8 bytes.
    expect(() => parseDescription('ş'.repeat(MAX_DESCRIPTION_BYTES / 2 + 1))).toThrow(/larger than 1 MB/);
  });
});
