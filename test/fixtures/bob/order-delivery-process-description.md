# Order Delivery Process Description

## Business scenario

A customer submits an order. The order is validated, enriched with country information, routed based on business rules, and then completed through one of several paths.

## Main process steps

1. Submit Order
2. Validate Order
3. Lookup Country Info
4. Determine Order Route
5. Route Order
6. Auto Complete Order
7. Manager Approval
8. Compliance Review
9. Handle Exception

## Validation rules

The process validates the order data:

- customerId is mandatory
- amount must be greater than zero
- countryCode is mandatory

If validation fails, the process should route to EXCEPTION.

## Country lookup

The process calls a country information service using countryCode.

The service returns:

- countryName
- countryRegion

If the lookup fails, the process should route to EXCEPTION.

## Routing rules

After country lookup, the process determines the route:

- if country lookup fails, route to EXCEPTION
- if amount is greater than 10000, route to MANAGER_APPROVAL
- if countryRegion is not Europe, route to COMPLIANCE_REVIEW
- otherwise route to AUTO_APPROVE

## Gateway paths

The gateway after Determine Order Route should have four outgoing paths:

- AUTO_APPROVE
- MANAGER_APPROVAL
- COMPLIANCE_REVIEW
- EXCEPTION

## Business object

OrderRequest:

- orderId
- customerId
- amount
- countryCode
- countryName
- countryRegion
- route
- requiresApproval
- status
- decisionReason
- externalErrorMessage

## Human tasks

### Manager Approval

Used when route is MANAGER_APPROVAL.

The manager reviews:

- orderId
- customerId
- amount
- countryName
- countryRegion
- decisionReason

### Compliance Review

Used when route is COMPLIANCE_REVIEW.

The compliance reviewer reviews:

- orderId
- customerId
- countryCode
- countryName
- countryRegion
- decisionReason

### Handle Exception

Used when route is EXCEPTION.

The user reviews:

- orderId
- customerId
- countryCode
- externalErrorMessage
- decisionReason

## Expected output

Generate a BPMN 2.0 draft suitable for IBM BAW import or further refinement.
