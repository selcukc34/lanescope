// Real BAW exports used by the tests. They are never committed (see
// .gitignore): each developer keeps them under test/fixtures/local/. A test
// that needs one is skipped when the file is not there, so CI runs without
// them; the synthetic export in ./syntheticTwx covers the TWX readers there.
//
// This is the only place that names the files. To run the full suite, put
// BAW 8.6.6 exports under these names into test/fixtures/local/.

import { existsSync } from 'node:fs';
import * as path from 'node:path';

export const LOCAL_FIXTURE_DIR = path.join(__dirname, 'fixtures', 'local');

export const LOCAL_TWX = {
  /** Two BPDs with sub-processes, an event subprocess, boundary events and a timer. */
  activities: 'activities.twx',
  /** Six BPDs calling service flows and a client-side human service with coaches. */
  services: 'services.twx',
  /** A BPD with an inline user task, a message boundary event and a timer. */
  events: 'events.twx',
  /** The Order Delivery Process demo app, toolkits removed. */
  orderDelivery: 'order-delivery-process.no-toolkits.twx',
  /** The same app as exported, with its packed toolkits. */
  orderDeliveryFull: 'order-delivery-process.twx',
} as const;

export type LocalTwx = keyof typeof LOCAL_TWX;

/** Path of a local export (whether or not it exists). */
export function localTwx(name: LocalTwx): string {
  return path.join(LOCAL_FIXTURE_DIR, LOCAL_TWX[name]);
}

/** True when every named export is present. */
export function hasLocalTwx(...names: LocalTwx[]): boolean {
  return names.every((name) => existsSync(localTwx(name)));
}
