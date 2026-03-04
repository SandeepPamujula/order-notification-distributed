# ADR-006 — EventBridge Helpdesk Routing

**Status:** Accepted
**Date:** 2026-03-04
**Authors:** Platform Team

---

## Context

The system processes orders globally. We have a requirement to send a special notification to the helpdesk for any order that is placed from outside of India (i.e., `country != 'IN'`).
We needed to decide how to route this specific subset of orders to the Helpdesk Service.

Key considerations:
- The Order Service already publishes all `OrderPlaced` events to a custom EventBridge bus (`order-events-bus-{env}`).
- The routing logic should be decoupled from the Order Service's core business logic (to prevent Order Service from having to know about every new downstream consumer's specific filtering rules).
- We want to minimize unnecessary Lambda invocations for the Helpdesk Service to reduce costs and avoid having the Helpdesk Lambda filter out India orders itself.

---

## Decision

We will use **Amazon EventBridge content-based filtering** to route non-India orders to the Helpdesk Service.

Specifically, the `HelpdeskStack` will define an EventBridge rule on the shared `order-events-bus-{env}` with the following event pattern:

```json
{
  "source": ["order-service"],
  "detail-type": ["OrderPlaced"],
  "detail": {
    "country": [{ "anything-but": "IN" }]
  }
}
```

This rule will target the Helpdesk Lambda function.

---

## Consequences

### Positive

- **Decoupling:** The Order Service remains oblivious to the Helpdesk Service's routing requirements. It just publishes the event.
- **Cost Efficiency:** EventBridge evaluates the rule and drops events where `country == 'IN'`. The Helpdesk Lambda is only invoked when necessary, saving Lambda execution costs.
- **Simplicity in Handler:** The Helpdesk Lambda handler doesn't need to contain `if (country === 'IN') return;` logic. If it is invoked, it knows it must process the event.

### Negative / Mitigations

- **Schema Coupling in Rules:** The EventBridge rule pattern tightly couples the infrastructure to the specific structure of the event payload (`detail.country`). If the event schema changes (e.g., `country` is nested under `address.country`), the rule will fail silently.
  - **Mitigation:** We implement contract tests (US-6.2) to ensure that producers and consumers (including infrastructure rules) stay in sync regarding the schema.
