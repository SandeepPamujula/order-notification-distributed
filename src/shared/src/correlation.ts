import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Correlation ID utilities
// ---------------------------------------------------------------------------

/**
 * Generates a new UUID v4 correlation ID.
 *
 * @returns A new UUID v4 string suitable for use as a correlation ID.
 */
export function generateCorrelationId(): string {
    return randomUUID();
}

/**
 * Extracts a correlation ID from an API Gateway HTTP API event header.
 * Falls back to generating a new one if the header is absent.
 *
 * @param headers - The HTTP headers from the Lambda event.
 * @returns The existing or newly generated correlation ID.
 */
export function extractOrGenerateCorrelationId(
    headers: Record<string, string | undefined> | null | undefined,
): string {
    if (!headers) {
        return generateCorrelationId();
    }

    // The header may arrive case-insensitively from API GW
    const correlationId =
        headers['x-correlation-id'] ??
        headers['X-Correlation-Id'] ??
        headers['X-Correlation-ID'];

    return correlationId ?? generateCorrelationId();
}

/**
 * Returns response headers that always include X-Correlation-Id.
 *
 * @param correlationId - The correlation ID for this request.
 * @param extra - Any additional headers to merge in.
 */
export function buildResponseHeaders(
    correlationId: string,
    extra?: Record<string, string>,
): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        'X-Correlation-Id': correlationId,
        ...extra,
    };
}
