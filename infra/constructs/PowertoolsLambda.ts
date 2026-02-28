import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

// ---------------------------------------------------------------------------
// PowertoolsLambda — Lambda construct with AWS Lambda Powertools defaults
// ---------------------------------------------------------------------------

export interface PowertoolsLambdaProps {
    /**
     * The runtime for the Lambda function.
     * Defaults to `lambda.Runtime.NODEJS_22_X`.
     */
    readonly runtime?: lambda.Runtime;

    /** The handler string for the Lambda function (e.g. `handler.handler`). */
    readonly handler: string;

    /** The code asset for the Lambda function. */
    readonly code: lambda.Code;

    /**
     * The timeout for the Lambda function.
     * Defaults to 30 seconds.
     */
    readonly timeout?: cdk.Duration;

    /**
     * The memory size in MB for the Lambda function.
     * Defaults to 512 MB.
     */
    readonly memorySize?: number;

    /**
     * Additional environment variables to merge with the Powertools defaults.
     * Powertools env vars (`POWERTOOLS_SERVICE_NAME`, `LOG_LEVEL`, `POWERTOOLS_LOGGER_LOG_EVENT`)
     * are always set and can be overridden here.
     */
    readonly environment?: Record<string, string>;

    /**
     * The Powertools service name — sets `POWERTOOLS_SERVICE_NAME`.
     * Required so that all logs and traces are correctly attributed.
     */
    readonly powertoolsServiceName: string;

    /**
     * Log level for Powertools logger.
     * Defaults to `INFO`.
     */
    readonly logLevel?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

    /**
     * Architecture for the Lambda function.
     * Defaults to `lambda.Architecture.ARM_64` (Graviton — lower cost + better perf).
     */
    readonly architecture?: lambda.Architecture;

    /**
     * Reserved concurrent executions.
     * Undefined means unreserved (default AWS behaviour).
     */
    readonly reservedConcurrentExecutions?: number;

    /**
     * VPC configuration for the Lambda function.
     * Optional — only needed for VPC-isolated Lambdas.
     */
    readonly vpc?: lambda.FunctionOptions['vpc'];

    /**
     * Security groups for the Lambda function (only relevant if `vpc` is set).
     */
    readonly securityGroups?: lambda.FunctionOptions['securityGroups'];

    /**
     * VPC subnets for the Lambda function (only relevant if `vpc` is set).
     */
    readonly vpcSubnets?: lambda.FunctionOptions['vpcSubnets'];
}

/**
 * A pre-configured Lambda function construct with:
 * - **X-Ray active tracing** enabled by default.
 * - **Structured JSON logging** via `loggingFormat: JSON` (Lambda-native) and `POWERTOOLS_LOG_FORMATTER=json`.
 * - **AWS Lambda Powertools** environment variables pre-populated.
 * - **ARM_64 / Graviton** architecture for cost efficiency.
 *
 * Every service stack should use `PowertoolsLambda` instead of the bare
 * `lambda.Function` construct so that observability standards are applied
 * consistently across all services.
 *
 * @example
 * ```ts
 * const fn = new PowertoolsLambda(this, 'OrderHandler', {
 *   code: lambda.Code.fromAsset('./dist'),
 *   handler: 'handler.handler',
 *   powertoolsServiceName: 'order-service',
 * });
 * ```
 */
export class PowertoolsLambda extends cdk.Resource {
    /** The underlying Lambda function — use to grant permissions, add event sources, etc. */
    public readonly function: lambda.Function;

    constructor(scope: Construct, id: string, props: PowertoolsLambdaProps) {
        super(scope, id);

        const {
            runtime = lambda.Runtime.NODEJS_22_X,
            handler,
            code,
            timeout = cdk.Duration.seconds(30),
            memorySize = 512,
            environment = {},
            powertoolsServiceName,
            logLevel = 'INFO',
            architecture = lambda.Architecture.ARM_64,
            reservedConcurrentExecutions,
            vpc,
            securityGroups,
            vpcSubnets,
        } = props;

        /** Powertools-mandated environment variables. */
        const powertoolsEnv: Record<string, string> = {
            // Core Powertools settings
            POWERTOOLS_SERVICE_NAME: powertoolsServiceName,
            POWERTOOLS_LOG_FORMATTER: 'json',
            LOG_LEVEL: logLevel,
            POWERTOOLS_LOGGER_LOG_EVENT: 'true',
            POWERTOOLS_TRACER_CAPTURE_HTTPS_REQUESTS: 'true',
            POWERTOOLS_TRACER_CAPTURE_RESPONSE: 'true',
            // JavaScript runtime settings
            NODE_OPTIONS: '--enable-source-maps',
            // Caller-supplied env vars override the defaults above when keys collide
            ...environment,
        };

        this.function = new lambda.Function(this, 'Function', {
            runtime,
            handler,
            code,
            timeout,
            memorySize,
            environment: powertoolsEnv,
            architecture,
            tracing: lambda.Tracing.ACTIVE,
            // Emit CloudWatch Logs in JSON format (built-in Lambda logging)
            loggingFormat: lambda.LoggingFormat.JSON,
            systemLogLevelV2: lambda.SystemLogLevel.WARN,
            // Conditionally spread optional props to satisfy exactOptionalPropertyTypes
            ...(reservedConcurrentExecutions !== undefined && {
                reservedConcurrentExecutions,
            }),
            ...(vpc !== undefined && { vpc }),
            ...(securityGroups !== undefined && { securityGroups }),
            ...(vpcSubnets !== undefined && { vpcSubnets }),
        });
    }
}
