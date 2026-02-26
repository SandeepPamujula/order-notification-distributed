# Production-Grade Microservices — Project Planning Prompt

> Using `architecture.md` as the single source of truth, generate a structured project plan with milestones, user stories, tasks, and acceptance criteria to implement **production-grade microservices**.

---

## Project Structure

- Backend services → `src/`
- AWS CDK infrastructure → `infra/`

---

## Each User Story Must Include

- Story points
- Acceptance criteria
- Completion status (mark done once implemented)

---

## Code Must Enforce

- Strict TypeScript (`strict: true`, no `any`)
- Zod input validation on every Lambda entry point
- Structured error handling with custom error classes
- Least privilege IAM roles — no wildcard permissions
- All secrets via SSM Parameter Store or Secrets Manager
- No hardcoded ARNs or environment-specific values in code

---

## Testing Requirements Per Service

- Unit tests for all Lambda handlers (Jest)
- Integration tests for DynamoDB operations
- Minimum 80% code coverage as a pipeline gate
- Contract tests for all Kinesis/EventBridge event schemas

---

## Observability Requirements

- Structured JSON logging via `aws-lambda-powertools`
- AWS X-Ray tracing on all Lambdas
- CloudWatch alarms for error rate, throttle, and DLQ depth
- Correlation ID in every event payload for end-to-end tracing

---

## Infrastructure Standards

- One CDK stack per service
- Environment-specific config via CDK context (dev/staging/prod)
- Consistent resource tagging (`env`, `service`, `owner`)
- `cdk diff` runs as a required PR check

---

## CI/CD User Stories (DEV Environment)

- Pipeline stages: Lint → Type Check → Test → Build → CDK Synth → Deploy
- Per-service pipelines (not monolithic)
- Automatic rollback on CloudWatch alarm breach
- Manual approval gate before staging promotion

---

## Documentation Per Service

- `README.md` with setup instructions, env vars, and event schemas
- JSDoc on all public interfaces and functions
- ADR for every major architectural decision
