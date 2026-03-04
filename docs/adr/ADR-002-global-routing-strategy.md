# ADR-002 — Global Routing Strategy: Route 53 Latency-Based Routing with Health Checks

| Attribute   | Detail                       |
| ----------- | ---------------------------- |
| **Status**  | Accepted                     |
| **Date**    | 2026-02-28                   |
| **Author**  | Platform Team                |
| **Story**   | US-0.3                       |

---

## Context

The Order Notification Distributed System must serve `POST /orders` globally with:

- **Sub-second acknowledgement SLA** (`< 1 s`)
- **Automatic region failover** (no manual intervention when a region goes down)
- **Multi-region active-active** deployment in `ap-south-1` (Mumbai) and `us-east-1` (N. Virginia)

Users are expected to originate from both India-proximate and US-proximate locations. The public API must be reachable at `api.spkumarorder.com`.

---

## Decision

We will use **AWS Route 53 latency-based routing** combined with **Route 53 HTTP(S) health checks** to:

1. Route each client to the nearest healthy region automatically.
2. Fail over to the secondary region within ~30 seconds if the primary region becomes unhealthy.

### Architecture Summary

```
api.spkumarorder.com  (Route 53 public hosted zone)
├── CNAME  ap-south-1  (Latency record, Region=ap-south-1, SetIdentifier=primary)
│           └── HealthCheck → GET https://<apigw-ap-south-1>/health (HTTPS, threshold=3)
└── CNAME  us-east-1   (Latency record, Region=us-east-1, SetIdentifier=secondary)
            └── HealthCheck → GET https://<apigw-us-east-1>/health (HTTPS, threshold=3)
```

Health check configuration:

| Parameter             | Value      | Rationale                                      |
| --------------------- | ---------- | ---------------------------------------------- |
| Protocol              | HTTPS      | Matches production API Gateway protocol        |
| Path                  | `/health`  | Lightweight endpoint; no auth required         |
| Port                  | 443        | Standard HTTPS port                            |
| Request interval      | 30 s       | AWS Route 53 minimum for standard checks       |
| Failure threshold     | 3          | Three consecutive failures before unhealthy    |
| Measurement regions   | 3 (global) | Route 53 measures from us-east-1, eu-west-1, ap-southeast-1 |

> Time-to-failover ≈ 30 s × 3 failures = **90 seconds worst-case**.

### CDK Stack Placement

`SharedStack` is deployed to **`us-east-1`** for two reasons:

1. Route 53 is a global service, but CDK's `PublicHostedZone` and `CfnRecordSet` constructs require a concrete stack region for CloudFormation to manage DNS resources.
2. Industry convention and AWS documentation recommend placing Route 53 CDK resources in `us-east-1`.

### SSM Parameter Exports

The following parameters are written to AWS Systems Manager Parameter Store by `SharedStack`:

| SSM Parameter                          | Value                              |
| -------------------------------------- | ---------------------------------- |
| `/shared/{env}/hosted-zone-id`         | Route 53 hosted zone ID            |
| `/shared/{env}/hosted-zone-arn`        | Route 53 hosted zone ARN           |
| `/shared/{env}/primary-health-check-id` | Health check ID for ap-south-1    |
| `/shared/{env}/secondary-health-check-id` | Health check ID for us-east-1  |
| `/shared/{env}/api-subdomain`          | `api.spkumarorder.com`                  |

Regional stacks read these parameters at synth-time via `StringParameter.valueForStringParameter()` to avoid hard CloudFormation cross-stack references (which create tight coupling and complicate updates).

---

## Alternatives Considered

### 1. API Gateway custom domain + CloudFront

**Rejected.** CloudFront distributions add ~20–50 ms of edge processing overhead and complicate the caching model for write-heavy order endpoints. At 10K+ TPS writes, caching provides no benefit. Route 53 latency routing with direct API Gateway hits is simpler and lower-latency.

### 2. Global Accelerator

**Considered.** AWS Global Accelerator provides anycast IP routing with ~millisecond-level failover. However:

- It adds ~$36/month per accelerator + data transfer cost (significant at 10K TPS).
- Route 53 latency routing with health checks achieves the same active-active failover pattern for a fraction of the cost (~$1/month hosted zone + ~$0.75 per health check/month).
- Global Accelerator would be re-evaluated at Phase 2 (100K TPS) where the latency improvement may justify the cost.

**Decision: use Route 53 for Phase 1; re-evaluate Global Accelerator for Phase 2.**

### 3. Geolocation routing

**Rejected** in favour of latency routing. Geolocation routing routes based on the client's geographic location, which may not match the lowest-latency region (e.g., a user from South Korea may have lower latency to `ap-south-1` but would be routed to `us-east-1` by geographic rules). Latency routing dynamically measures and selects the lowest-latency endpoint regardless of geography.

### 4. Weighted routing (A/B traffic splitting)

**Not applicable** to this use case. Weighted routing is best suited for canary deployments. Active-active failover with automatic health-check-based routing is required here.

---

## Consequences

### Positive

- **Zero-downtime failover**: if `ap-south-1` fails its health check three times consecutively, Route 53 automatically routes all traffic to `us-east-1` within ~90 seconds.
- **Low latency**: Indian users resolve to `ap-south-1` (~20 ms); US users resolve to `us-east-1` (~20 ms).
- **Cost-effective**: Route 53 hosted zone ($0.50/month) + 2 health checks (~$1.50/month) is negligible vs. infrastructure cost.
- **Simple failover test**: simulating a failed health check endpoint verifies the entire failover mechanism in `dev`.

### Negative / Trade-offs

- **NS propagation lag**: new zone NS records must be delegated from the domain registrar. This is a one-time manual step that cannot be automated via CDK.
- **~90 s failover time**: this is acceptable for the order service (not real-time financial transactions), but operators should note this SLA.
- **HTTPS required for `/health`**: the API Gateway endpoint must be reachable over HTTPS (port 443). HTTP-only endpoints would require downgrading the health check type, reducing security.
- **Placeholder API GW domains until US-1.1**: `SharedStack` is provisioned in M0 before `OrderServiceStack` exists. Placeholder domain names are used until real API Gateway endpoints are available. The latency records will return `SERVFAIL` until updated with real targets — this is acceptable during development.

---

## Implementation Notes

1. The `/health` route is provisioned by `OrderServiceStack` (US-1.1) on each regional API Gateway. It returns `200 OK` with no authentication.
2. The `SharedStack` must be deployed **before** `OrderServiceStack` in any CI/CD pipeline so that SSM parameters are available to import.
3. After deployment, the Route 53 NS records output by `SharedStack` (`NameServers` CFn output) must be added to the domain registrar (e.g., Route 53 domains, GoDaddy) as NS records for the `api.spkumarorder.com` subdomain.
4. Route 53 resolver tests and `dig` queries should be run against the deployed hosted zone per the US-0.3 acceptance criteria.

### Verification commands (post-deploy)

```bash
# Query the hosted zone name servers
dig NS api.spkumarorder.com

# Query latency of the primary record (from ap-south-1 vicinity)
dig CNAME api.spkumarorder.com

# Simulate failover: take down the /health endpoint in ap-south-1, wait ~90s, then:
dig CNAME api.spkumarorder.com  # should now return us-east-1 API GW
```

---

## References

- [Route 53 Latency-Based Routing](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy-latency.html)
- [Route 53 Health Checks](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/health-checks-creating.html)
- [AWS CDK `aws-cdk-lib/aws-route53`](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_route53-readme.html)
- Architecture diagram: [`docs/architecture.md §7.1`](../architecture.md)
- Failover sequence diagram: [`docs/architecture.md §4.3`](../architecture.md)
