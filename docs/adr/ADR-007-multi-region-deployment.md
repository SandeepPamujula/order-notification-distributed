# ADR-007: Multi-Region Deployment Strategy

**Status:** Accepted  
**Date:** 2026-03-05  
**Deciders:** Platform Team  
**Story:** US-6.1 — Multi-Region CDK Deployment

---

## Context

The Order Notification Distributed System is designed for global availability with automatic failover between AWS regions (`ap-south-1` Mumbai and `us-east-1` N. Virginia). Up to this point (Milestones 0–5), all service stacks were deployed only to the primary region (`ap-south-1`), with the SharedStack (Route 53 hosted zone, health checks, and latency routing) deployed to `us-east-1` using placeholder API Gateway domain names.

US-6.1 requires:
1. Deploying all service stacks to **both regions** simultaneously.
2. Enabling **DynamoDB Global Tables** for cross-region data replication.
3. Provisioning **ACM certificates** and **API Gateway Custom Domain Names** for `api.spworks.click` in each region.
4. Updating **Route 53 latency records** from raw `execute-api` URLs to proper custom domain regional endpoints.

---

## Decision

### 1. Dual-Region Stack Instantiation

All service stacks (Order, Notification, Inventory, Helpdesk, Observability) are instantiated twice in `infra/bin/app.ts` — once per region:

```typescript
// Primary region (ap-south-1)
new OrderServiceStack(app, 'OrderServiceStack-ap-south-1-dev', { env: { region: 'ap-south-1' }, ... });
// Secondary region (us-east-1)
new OrderServiceStack(app, 'OrderServiceStack-us-east-1-dev', { env: { region: 'us-east-1' }, ... });
```

**Key design choices:**
- Each region gets its own `BaselineStack` for SSM parameters and tagging.
- Stack IDs include the region name to avoid CloudFormation naming collisions.
- The secondary `OrderServiceStack` depends on the primary to coordinate DynamoDB Global Table creation.

### 2. DynamoDB Global Tables

The `replicationRegions` property on `dynamodb.Table` enables Global Table replication. This property is set to `[ap-south-1, us-east-1]` (minus the current stack's region) on the **primary** stack only:

| Table | Primary Stack | Secondary Stack |
|---|---|---|
| `orders-{env}` | Creates table + adds `us-east-1` replica | Creates table independently (no replica — already replicated by primary) |
| `notifications-{env}` | Creates table + adds `us-east-1` replica | Creates table independently |

**Rationale:** CDK's `replicationRegions` uses a Custom Resource to call `UpdateTable` with replica regions. If both stacks try to add replicas, they would conflict. Therefore, only the primary stack specifies replication. The secondary stack creates a standalone table with the same name, which the primary stack's replication then discovers.

**Important:** For an existing deployed primary table, adding `replicationRegions` will trigger an in-place update (no table replacement). The secondary region's table is created by AWS as part of Global Tables replication, not by the secondary CDK stack. The secondary CDK stack's DynamoDB table will therefore reference the already-existing replica.

### 3. ACM Certificates (DNS-Validated)

Each regional `OrderServiceStack` provisions an ACM certificate for `api.spworks.click` using DNS validation:

```typescript
const certificate = new acm.Certificate(this, 'ApiCertificate', {
    domainName: 'api.spworks.click',
    validation: acm.CertificateValidation.fromDns(),
});
```

**Key considerations:**
- ACM certificates are **regional** — each region needs its own certificate.
- DNS validation requires a CNAME record in the Route 53 hosted zone (managed by `SharedStack` in `us-east-1`). The validation CNAME is the same for both regions when the domain name is the same, so only one DNS record is needed.
- Using `CertificateValidation.fromDns()` without a hosted zone reference means the CNAME must be added manually or via automation. This avoids a hard cross-stack/cross-region dependency.

**Alternatives considered:**
- `CertificateValidation.fromDns(hostedZone)` — Would auto-create the validation record, but requires the hosted zone to be in the same region as the certificate, which is not possible since SharedStack is in `us-east-1` and the primary OrderServiceStack is in `ap-south-1`.
- Email validation — Requires manual intervention per certificate request; not suitable for automation.

### 4. API Gateway Custom Domain Names

Each regional `OrderServiceStack` creates an API Gateway Custom Domain Name linked to its regional ACM certificate:

```typescript
const customDomain = new apigwv2.DomainName(this, 'ApiCustomDomain', {
    domainName: 'api.spworks.click',
    certificate,
});

new apigwv2.ApiMapping(this, 'ApiMapping', {
    api: this.httpApi,
    domainName: customDomain,
});
```

The custom domain's **regional endpoint** (e.g., `d-abc123.execute-api.ap-south-1.amazonaws.com`) is exported to SSM:
- `/order-service/{env}/custom-domain-regional-endpoint`
- `/order-service/{env}/custom-domain-regional-hosted-zone-id`

These SSM parameters allow the `SharedStack` to construct Route 53 latency records pointing to the correct regional endpoints.

### 5. Route 53 Latency Records Update

The `SharedStack` Route 53 latency records are updated from placeholder `execute-api` URLs to the actual custom domain regional endpoints. This is achieved by:

1. **OrderServiceStack** exports the regional endpoint to SSM.
2. **SharedStack** reads these endpoints (via `cdk.json` context or SSM) and creates latency-based CNAME records.

**Current approach:** The latency records in `SharedStack` use props (`primaryApiGatewayDomainName`, `secondaryApiGatewayDomainName`) which are set in `cdk.json` context. After initial deployment of the `OrderServiceStack`s, the operator updates `cdk.json` with the actual custom domain regional endpoints and redeploys `SharedStack`.

**Future enhancement:** These values could be read dynamically from SSM via `AwsCustomResource`, eliminating the manual update step.

---

## Deployment Order

The stacks must be deployed in the correct order to satisfy dependencies:

```
1. BaselineStack-ap-south-1-dev
2. BaselineStack-us-east-1-dev
3. SharedStack-us-east-1-dev
4. OrderServiceStack-ap-south-1-dev   (creates Global Table + replica)
5. OrderServiceStack-us-east-1-dev    (references replica table)
6. NotificationServiceStack-ap-south-1-dev  (creates Global Table + replica)
7. NotificationServiceStack-us-east-1-dev   (references replica table)
8. InventoryServiceStack-ap-south-1-dev
9. InventoryServiceStack-us-east-1-dev
10. HelpdeskStack-ap-south-1-dev
11. HelpdeskStack-us-east-1-dev
12. ObservabilityStack-ap-south-1-dev
13. ObservabilityStack-us-east-1-dev
```

CDK handles dependency resolution automatically via `addDependency()`.

---

## Consequences

### Positive
- **Active-active multi-region:** Both regions serve live traffic simultaneously.
- **Sub-second failover:** Route 53 health checks detect regional failure in ~90 seconds (3 failures × 30s interval) and route traffic to the healthy region.
- **Data replication:** DynamoDB Global Tables provide ~1 second cross-region replication with strong eventual consistency.
- **Single domain:** Users access `api.spworks.click` regardless of region — routing is transparent.
- **Consistent infrastructure:** Same CDK stack code deployed to both regions ensures configuration parity.

### Negative
- **Increased cost:** All resources are duplicated across two regions (~2× infrastructure cost).
- **Deployment complexity:** 13+ stacks to deploy (vs. 7 previously). Deployment time increases.
- **ACM certificate validation:** DNS validation records must be managed (automated or manual).
- **DynamoDB Global Table conflicts:** Concurrent writes to the same item in different regions may conflict. DynamoDB uses "last writer wins" conflict resolution.
- **SSM parameter scoping:** Regional SSM parameters (e.g., queue ARNs) are scoped per-region, so the same parameter name holds region-specific values in each region.

### Risks
- **Replication lag:** DynamoDB Global Tables have ~1 second replication lag. A write in `ap-south-1` may not be immediately visible in `us-east-1`. This is acceptable for order processing but may cause brief inconsistencies for reads.
- **SES regional availability:** SES sandbox mode may not be enabled in both regions. Verify SES identity verification in both `ap-south-1` and `us-east-1`.

---

## References

- [AWS DynamoDB Global Tables documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GlobalTables.html)
- [AWS ACM DNS Validation](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html)
- [API Gateway Custom Domain Names](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-custom-domain-names.html)
- [Route 53 Latency-Based Routing](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy-latency.html)
- `docs/architecture.md` — System architecture
- `docs/adr/ADR-002-global-routing-strategy.md` — Route 53 routing decisions
