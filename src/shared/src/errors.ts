// ---------------------------------------------------------------------------
// Custom application error classes
// ---------------------------------------------------------------------------

/**
 * Base class for all application-level errors.
 * Adds `statusCode` and `correlationId` for structured HTTP responses.
 */
export abstract class AppError extends Error {
    /** HTTP status code that should be returned to the caller. */
    public abstract readonly statusCode: number;

    /**
     * @param message - Human-readable error description.
     * @param correlationId - Correlation ID of the failing request (for tracing).
     * @param cause - The underlying error that triggered this one, if any.
     */
    constructor(
        message: string,
        public readonly correlationId: string,
        cause?: Error,
    ) {
        super(message, cause ? { cause } : undefined);
        this.name = this.constructor.name;
        // Maintain correct prototype chain in transpiled ES5 targets
        Object.setPrototypeOf(this, new.target.prototype);
    }

    /**
     * Returns a structured JSON-serialisable representation of the error.
     */
    toJSON(): Record<string, unknown> {
        return {
            error: this.name,
            message: this.message,
            statusCode: this.statusCode,
            correlationId: this.correlationId,
        };
    }
}

// ---------------------------------------------------------------------------
// Concrete error types
// ---------------------------------------------------------------------------

/**
 * Raised when the incoming request payload fails Zod validation.
 * Maps to HTTP 400 Bad Request.
 */
export class ValidationError extends AppError {
    public readonly statusCode = 400;

    /**
     * @param message - Summary of the validation failure.
     * @param correlationId - Correlation ID of the failing request.
     * @param details - Structured Zod issue list for the response body.
     */
    constructor(
        message: string,
        correlationId: string,
        public readonly details?: unknown,
    ) {
        super(message, correlationId);
    }

    override toJSON(): Record<string, unknown> {
        return {
            ...super.toJSON(),
            details: this.details,
        };
    }
}

/**
 * Raised when a DynamoDB operation fails.
 * Maps to HTTP 500 Internal Server Error.
 */
export class DatabaseError extends AppError {
    public readonly statusCode = 500;

    /**
     * @param message - Human-readable description of the database failure.
     * @param correlationId - Correlation ID of the failing request.
     * @param cause - The underlying AWS SDK error.
     */
    constructor(message: string, correlationId: string, cause?: Error) {
        super(message, correlationId, cause);
    }
}

/**
 * Raised when an SNS, SQS, or EventBridge publish/send operation fails.
 * Maps to HTTP 502 Bad Gateway.
 */
export class MessagingError extends AppError {
    public readonly statusCode = 502;

    /**
     * @param message - Human-readable description of the messaging failure.
     * @param correlationId - Correlation ID of the failing request.
     * @param cause - The underlying AWS SDK error.
     */
    constructor(message: string, correlationId: string, cause?: Error) {
        super(message, correlationId, cause);
    }
}

/**
 * Raised when an SES email send fails.
 * Maps to HTTP 502 Bad Gateway.
 */
export class EmailError extends AppError {
    public readonly statusCode = 502;

    /**
     * @param message - Human-readable description of the email failure.
     * @param correlationId - Correlation ID of the failing request.
     * @param cause - The underlying AWS SDK error.
     */
    constructor(message: string, correlationId: string, cause?: Error) {
        super(message, correlationId, cause);
    }
}

/**
 * Raised for any unclassified internal server error.
 * Maps to HTTP 500 Internal Server Error.
 */
export class InternalError extends AppError {
    public readonly statusCode = 500;

    /**
     * @param message - Human-readable description of the failure.
     * @param correlationId - Correlation ID of the failing request.
     * @param cause - The underlying error, if any.
     */
    constructor(message: string, correlationId: string, cause?: Error) {
        super(message, correlationId, cause);
    }
}
