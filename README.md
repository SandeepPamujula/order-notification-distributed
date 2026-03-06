# Distributed Order Notification System

This project is a highly scalable, event-driven order and notification system built using Serverless technologies on AWS. It is designed to handle high-throughput order processing with built-in multi-region resilience.

## High-Level Business Use Cases

The system supports the following core business capabilities:

### 1. Seamless Order Processing
- **Create and Manage Orders:** Customers or internal systems can securely place orders. The system instantly accepts the order and asynchronously processes all backend fulfillment steps.
- **Order Tracking:** Users can query the current status and detailed breakdown of their orders at any time through the exposed APIs.

### 2. Automated Inventory Management
- **Real-time Stock Deductions:** As orders are placed, the system automatically validates and updates inventory levels to prevent overselling.
- **Distributed Consistency:** Inventory updates are synchronized globally, ensuring accurate stock representation regardless of where the customer is located.

### 3. Customer Notifications & Communication
- **Automated Status Alerts:** Customers receive immediate, automated email notifications (via Amazon SES) when their order status changes, keeping them informed throughout the fulfillment lifecycle.
- **Asynchronous Delivery:** Notification processing is decoupled from order creation, meaning customers experience zero lag when placing an order, even during high-volume periods.

### 4. Proactive Customer Support (Helpdesk)
- **Automated Issue Escalation:** If an order encounters an error or fails validation, the system automatically triggers an internal Helpdesk workflow.
- **Support Team Alerts:** Customer support representatives instantly receive detailed error reports via email, allowing them to proactively address issues before the customer even notices.

### 5. Multi-Region High Availability & Disaster Recovery
- **Active-Active Global Presence:** The application operates simultaneously across multiple geographic regions (e.g., `ap-south-1` and `us-east-1`).
- **Zero-Downtime Resilience:** If a regional outage occurs, DNS queries automatically route users to a healthy region. All business data (orders, inventory) is continuously replicated across regions in the background to prevent data loss.

---

## Technical Documentation & Context

For a deeper technical understanding of how the system is designed, structured, and managed, please refer to the documents in the `docs/` directory:

- **[System Architecture](docs/architecture.md):** A comprehensive breakdown of the event-driven architecture, AWS Serverless services used (API Gateway, Lambda, EventBridge, DynamoDB), and the data flow between microservices.
- **[Agile Delivery Plan](docs/agile-delivery-plan.md):** The project roadmap, outlining completed user stories, sprints, and feature progress.
- **[Architecture Decision Records (ADRs)](docs/adr/):** A log of critical technical and architectural decisions made during development (e.g., why DynamoDB Global Tables were chosen for multi-region data replication).

---

## API Testing & Validation (Postman)

The system includes a suite of integration tests to validate API functionality, cross-region replication, and overall system health. 

All testing resources and instructions are located in the **`tests/postman/`** directory:

- **[Testing Instructions (README.md)](tests/postman/README.md):** A detailed, step-by-step guide on how to import, configure, and execute the API test suites locally or via CI/CD using Postman and Newman.
- **Single-Region API Tests:** Collections designed to test core API endpoints (`order-service-integration.postman_collection.json`).
- **Multi-Region Test Suites:** Advanced test suites designed to validate data replication and API routing parity across the primary and secondary AWS deployment regions (`multi-region-integration.postman_collection.json`).

---

## Getting Started (Local Development)

### Prerequisites
- [Node.js](https://nodejs.org/) (v22+)
- [npm](https://www.npmjs.com/) (v10+)
- [AWS CLI](https://aws.amazon.com/cli/) configured with appropriate credentials
- [AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html) CLI (`npm i -g aws-cdk`)

### Installation & Build

This project is structured as a monorepo.

1. **Install dependencies** across all workspaces:
   ```bash
   npm install
   ```

2. **Build the project** (compiles TypeScript for all services and infrastructure):
   ```bash
   npm run build
   ```

3. **Run Unit Tests:**
   ```bash
   npm run test
   ```

---

## Deployment Instructions

The infrastructure is defined using the AWS Cloud Development Kit (CDK) in the `infra/` directory.

### Quick Deploy (CDK)
To synthesize and deploy the stacks to your configured AWS account:

```bash
# Navigate to the infrastructure directory
cd infra

# Install dependencies if not already done
npm install

# Synthesize the CloudFormation templates
npx cdk synth

# Deploy all stacks (Requires approval for IAM/Security changes)
npx cdk deploy --all
```

*Note: The project leverages multi-region deployments. Depending on the environment configuration, CDK may prompt you or require specific context parameters to deploy to `ap-south-1` and `us-east-1`.*
