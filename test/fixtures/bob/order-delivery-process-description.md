# Order Delivery Process

## Business scenario

A customer submits an order. The order is validated, enriched with country
information from an external REST service, routed by business rules and
completed through one of four paths.

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

- customerId is mandatory.
- amount must be greater than zero.
- countryCode is mandatory.
- If any rule fails, route is set to EXCEPTION and decisionReason explains why.

## Country lookup

Call the public country info REST API with countryCode. On success, set
countryName and countryRegion. On failure, set route to EXCEPTION and
externalErrorMessage.

## Routing rules

Apply in priority order:

1. If the country lookup failed, route = EXCEPTION.
2. If amount > 10000, route = MANAGER_APPROVAL.
3. If countryRegion is not Europe, route = COMPLIANCE_REVIEW.
4. Otherwise, route = AUTO_APPROVE.

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

The Order Manager reviews:

- orderId
- customerId
- amount
- countryName
- countryRegion
- decisionReason

### Compliance Review

The Compliance Reviewer reviews:

- orderId
- customerId
- countryCode
- countryName
- countryRegion
- decisionReason

### Handle Exception

The Operations Team reviews:

- orderId
- customerId
- countryCode
- externalErrorMessage
- decisionReason

## Expected output

A BAW process with lanes for Customer, System, Order Manager, Compliance
Reviewer and Operations Team, a business object OrderRequest and the four
completion paths above.
