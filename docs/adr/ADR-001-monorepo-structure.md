# ADR-001 — Monorepo Structure

**Status:** Accepted  
**Date:** 2026-02-26  
**Authors:** Platform Team

---

## Context

The system consists of four independent microservices (Order, Notification, Inventory, Helpdesk)
plus a shared utilities package and a centralised CDK infrastructure app.
We needed to decide whether to use multiple separate repositories or a single monorepo.

Key considerations:

- All services share the same technology stack (Node.js, TypeScript, AWS CDK).
- Services share foundational utilities: error classes, correlation-ID helpers, Zod schemas, and Powertools factories.
- A single CI/CD system (GitHub Actions) must orchestrate lint, type-check, test, build, CDK synth, and deploy for every service.
- Developer experience: developers should be able to run a single `npm install` and `npm test` at the root and have all tests execute.
- Dependency management: shared packages must be importable with a stable workspace alias (`@order-notification/shared`) without needing a private npm registry.

---

## Decision

We adopt a **single monorepo** using **npm workspaces**.

### Directory layout

```
order-notification-distributed/
├── .github/
│   └── workflows/           # CI/CD pipelines (one per service + infra checks)
├── docs/
│   ├── adr/                 # Architecture Decision Records
│   ├── architecture.md      # System architecture source of truth
│   └── agile-delivery-plan.md
├── infra/                   # AWS CDK app (single CDK app, multi-stack)
│   ├── bin/app.ts           # CDK entry point — instantiates all stacks
│   ├── aspects/             # CDK Aspects (TaggingAspect)
│   ├── constructs/          # Reusable CDK constructs (PowertoolsLambda, DLQ, …)
│   ├── stacks/              # One stack per service + SharedStack
│   └── tests/               # CDK assertion tests (aws-cdk-lib/assertions)
├── src/
│   ├── shared/              # @order-notification/shared — cross-service utilities
│   ├── order-service/       # @order-notification/order-service
│   ├── notification-service/# @order-notification/notification-service
│   ├── inventory-service/   # @order-notification/inventory-service
│   └── helpdesk-service/    # @order-notification/helpdesk-service
├── jest.config.ts           # Root Jest config — runs all tests from one command
├── tsconfig.json            # Root TypeScript config (strict: true)
├── .eslintrc.json           # Shared ESLint rules
├── .prettierrc.json         # Shared Prettier rules
└── package.json             # npm workspaces root
```

### Workspace naming convention

All workspace packages are scoped under `@order-notification/`:

| Workspace path              | Package name                             |
|-----------------------------|------------------------------------------|
| `src/shared`                | `@order-notification/shared`             |
| `src/order-service`         | `@order-notification/order-service`      |
| `src/notification-service`  | `@order-notification/notification-service` |
| `src/inventory-service`     | `@order-notification/inventory-service`  |
| `src/helpdesk-service`      | `@order-notification/helpdesk-service`   |
| `infra`                     | `@order-notification/infra`              |

### Tooling

| Concern         | Tool                               | Config file              |
|-----------------|------------------------------------|--------------------------|
| Language        | TypeScript 5.x (`strict: true`)    | `tsconfig.json`          |
| Linting         | ESLint 8 + `@typescript-eslint`    | `.eslintrc.json`         |
| Formatting      | Prettier 3                         | `.prettierrc.json`       |
| Testing         | Jest 29 + ts-jest                  | `jest.config.ts`         |
| Coverage gate   | ≥ 80% (branches / functions / lines / statements) | `jest.config.ts` |
| Lambda bundling | esbuild (per service)              | Each service `package.json` `build` script |
| IaC             | AWS CDK 2.x                        | `infra/`                 |
| Runtime         | Node.js 22 LTS (pinned in `.nvmrc`)| `.nvmrc`, Lambda runtime |

---

## Consequences

### Positive

- **Single install / test / lint command** at root covers everything.
- **Shared utilities** (`@order-notification/shared`) are referenced directly via npm workspace symlinks — no private registry needed.
- **Atomic commits** across service + infra are possible, making cross-cutting changes (e.g. adding a new tag to all stacks) trivial.
- **Consistent tooling** — one ESLint config, one Prettier config, one Jest config enforced across all packages.
- **CDK single app** — one `cdk synth` / `cdk deploy` with multi-stack context makes cross-stack references (SSM exports) straightforward.

### Negative / Mitigations

| Concern | Mitigation |
|---------|-----------|
| CI build time increases as codebase grows | Per-service GitHub Actions workflows with `paths:` filters ensure only affected services are rebuilt on each PR |
| Large `node_modules` due to hoisting | npm workspaces hoist common dependencies; service `package.json` files only declare Lambda runtime dependencies, keeping Lambda ZIPs lean |
| Blast radius of a bad root dependency update | Dependabot configured per-workspace; `npm audit` runs in every pipeline |

---

## Alternatives Considered

### Option A — Polyrepo (one repo per service)

- **Rejected** because: sharing utilities would require a private npm registry or git submodules; cross-service changes require multiple PRs; harder to enforce consistent tooling.

### Option B — Turborepo / Nx monorepo

- **Considered** but deemed over-engineered at this stage. npm workspaces provides sufficient caching and parallelism for the current team size. Can be migrated to Turborepo without structural changes if build times become a concern.
