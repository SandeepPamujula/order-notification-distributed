import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';

// ---------------------------------------------------------------------------
// Powertools Logger / Tracer factory
// ---------------------------------------------------------------------------

/**
 * Options for creating a Powertools logger instance.
 */
export interface LoggerOptions {
    /** The name of the service owning this logger. */
    serviceName: string;
    /**
     * Log level. Defaults to the value of the `LOG_LEVEL` environment variable,
     * or `'INFO'` if not set.
     */
    logLevel?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
}

/**
 * Creates a pre-configured Powertools Logger instance.
 *
 * The logger emits structured JSON, which works natively with CloudWatch
 * Logs Insights queries and the Powertools CloudWatch dashboard.
 *
 * @param options - Logger configuration.
 * @returns A Powertools `Logger` instance.
 */
export function createLogger(options: LoggerOptions): Logger {
    const { serviceName, logLevel } = options;

    return new Logger({
        serviceName,
        logLevel: logLevel ?? (process.env['LOG_LEVEL'] as LoggerOptions['logLevel']) ?? 'INFO',
    });
}

/**
 * Creates a pre-configured Powertools Tracer instance.
 *
 * All Lambdas provisioned by the `PowertoolsLambda` CDK construct have X-Ray
 * active tracing enabled at the runtime level; this tracer captures sub-segment
 * spans and annotates traces with correlationId / orderId.
 *
 * @param serviceName - The name of the service owning this tracer.
 * @returns A Powertools `Tracer` instance.
 */
export function createTracer(serviceName: string): Tracer {
    return new Tracer({ serviceName });
}
