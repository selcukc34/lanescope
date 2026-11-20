# Process Description

<!-- Lanescope description format. Only the four sections Main process steps,
     Gateway paths, Business object and Human tasks are checked; every other
     "##" section is free text. Replace the placeholder items below. -->

## Business scenario

<!-- Free text, not checked. -->

Describe what the process does and who takes part.

## Main process steps

<!-- Required. One activity, gateway or event name per item, in order. -->

1. Receive Request
2. Check Request
3. Route Request
4. Approve Request
5. Reject Request

## Gateway paths

<!-- Optional. The names of the outgoing flows of a gateway. Name the step the
     gateway follows with "after <step>" in a sentence, or with one
     "### After <step>" sub-heading per gateway. -->

The gateway after Check Request should have two outgoing paths:

- APPROVE
- REJECT

## Business object

<!-- Optional. A "<Name>:" line or a "### <Name>" sub-heading, then its fields.
     Repeat for more business objects. -->

RequestData:

- requestId
- status

## Human tasks

<!-- Optional. One "### <task>" sub-heading per user task, then the fields it shows. -->

### Approve Request

- requestId
- status

## Expected output

<!-- Free text, not checked. -->

Describe what should be generated.
