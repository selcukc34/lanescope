// Readable names of the model's node kinds, shared by the views and the
// comparison (../diff). Pure: no vscode, no DOM.

import type { FlowNodeKind } from './model';

export const KIND_LABELS: Readonly<Record<FlowNodeKind, string>> = {
  startEvent: 'Start event',
  endEvent: 'End event',
  intermediateEvent: 'Intermediate event',
  task: 'Task',
  scriptTask: 'Script task',
  userTask: 'User task',
  serviceTask: 'Service task',
  callActivity: 'Call activity',
  subProcess: 'Sub-process',
  exclusiveGateway: 'Exclusive gateway',
  parallelGateway: 'Parallel gateway',
  inclusiveGateway: 'Inclusive gateway',
  eventBasedGateway: 'Event-based gateway',
  unknown: 'Unknown (drawn as task)',
};
