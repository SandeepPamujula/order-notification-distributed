import {
    AppError,
    DatabaseError,
    EmailError,
    InternalError,
    MessagingError,
    ValidationError,
} from '../src/errors';

describe('AppError subclasses', () => {
    const CORRELATION_ID = 'test-correlation-id';

    describe('ValidationError', () => {
        it('should have statusCode 400', () => {
            const err = new ValidationError('invalid payload', CORRELATION_ID, [{ field: 'x' }]);
            expect(err.statusCode).toBe(400);
            expect(err.message).toBe('invalid payload');
            expect(err.correlationId).toBe(CORRELATION_ID);
            expect(err.name).toBe('ValidationError');
        });

        it('should include details in toJSON()', () => {
            const details = [{ path: ['field'], message: 'Required' }];
            const err = new ValidationError('bad', CORRELATION_ID, details);
            const json = err.toJSON();
            expect(json['statusCode']).toBe(400);
            expect(json['details']).toEqual(details);
            expect(json['correlationId']).toBe(CORRELATION_ID);
        });

        it('should be an instance of AppError and Error', () => {
            const err = new ValidationError('x', CORRELATION_ID);
            expect(err).toBeInstanceOf(AppError);
            expect(err).toBeInstanceOf(Error);
        });
    });

    describe('DatabaseError', () => {
        it('should have statusCode 500', () => {
            const err = new DatabaseError('db failed', CORRELATION_ID);
            expect(err.statusCode).toBe(500);
            expect(err.name).toBe('DatabaseError');
        });

        it('should capture cause', () => {
            const cause = new Error('connection refused');
            const err = new DatabaseError('db failed', CORRELATION_ID, cause);
            expect(err.cause).toBe(cause);
        });
    });

    describe('MessagingError', () => {
        it('should have statusCode 502', () => {
            const err = new MessagingError('sns failed', CORRELATION_ID);
            expect(err.statusCode).toBe(502);
            expect(err.name).toBe('MessagingError');
        });
    });

    describe('EmailError', () => {
        it('should have statusCode 502', () => {
            const err = new EmailError('ses failed', CORRELATION_ID);
            expect(err.statusCode).toBe(502);
            expect(err.name).toBe('EmailError');
        });
    });

    describe('InternalError', () => {
        it('should have statusCode 500', () => {
            const err = new InternalError('unexpected', CORRELATION_ID);
            expect(err.statusCode).toBe(500);
            expect(err.name).toBe('InternalError');
        });
    });

    describe('base toJSON()', () => {
        it('should return correct shape', () => {
            const err = new DatabaseError('test', CORRELATION_ID);
            const json = err.toJSON();
            expect(json).toMatchObject({
                error: 'DatabaseError',
                message: 'test',
                statusCode: 500,
                correlationId: CORRELATION_ID,
            });
        });
    });
});
