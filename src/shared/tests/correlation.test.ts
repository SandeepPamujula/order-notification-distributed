import {
    buildResponseHeaders,
    extractOrGenerateCorrelationId,
    generateCorrelationId,
} from '../src/correlation';

describe('generateCorrelationId', () => {
    it('should return a valid UUID v4', () => {
        const id = generateCorrelationId();
        expect(id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
    });

    it('should return unique IDs on successive calls', () => {
        const ids = new Set(Array.from({ length: 100 }, () => generateCorrelationId()));
        expect(ids.size).toBe(100);
    });
});

describe('extractOrGenerateCorrelationId', () => {
    it('should extract correlation ID from x-correlation-id header', () => {
        const id = extractOrGenerateCorrelationId({ 'x-correlation-id': 'my-id' });
        expect(id).toBe('my-id');
    });

    it('should extract correlation ID from X-Correlation-Id header', () => {
        const id = extractOrGenerateCorrelationId({ 'X-Correlation-Id': 'my-id-2' });
        expect(id).toBe('my-id-2');
    });

    it('should generate a new ID when header is absent', () => {
        const id = extractOrGenerateCorrelationId({});
        expect(id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
    });

    it('should generate a new ID when headers are null', () => {
        const id = extractOrGenerateCorrelationId(null);
        expect(id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
    });

    it('should generate a new ID when headers are undefined', () => {
        const id = extractOrGenerateCorrelationId(undefined);
        expect(id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
    });
});

describe('buildResponseHeaders', () => {
    it('should include X-Correlation-Id and Content-Type', () => {
        const headers = buildResponseHeaders('abc-123');
        expect(headers['X-Correlation-Id']).toBe('abc-123');
        expect(headers['Content-Type']).toBe('application/json');
    });

    it('should merge extra headers', () => {
        const headers = buildResponseHeaders('abc-123', { 'Cache-Control': 'no-cache' });
        expect(headers['Cache-Control']).toBe('no-cache');
        expect(headers['X-Correlation-Id']).toBe('abc-123');
    });
});
