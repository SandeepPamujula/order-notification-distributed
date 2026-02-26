import {
    CountryCodeSchema,
    CurrencyCodeSchema,
    EmailSchema,
    MessagingModeSchema,
    OrderItemSchema,
    UuidSchema,
} from '../src/schemas';

describe('Zod base schemas', () => {
    describe('UuidSchema', () => {
        it('accepts a valid UUID', () => {
            expect(() =>
                UuidSchema.parse('123e4567-e89b-12d3-a456-426614174000'),
            ).not.toThrow();
        });
        it('rejects a non-UUID', () => {
            expect(() => UuidSchema.parse('not-a-uuid')).toThrow();
        });
    });

    describe('CountryCodeSchema', () => {
        it('accepts "IN"', () => {
            expect(() => CountryCodeSchema.parse('IN')).not.toThrow();
        });
        it('rejects lowercase', () => {
            expect(() => CountryCodeSchema.parse('in')).toThrow();
        });
        it('rejects 3-letter codes', () => {
            expect(() => CountryCodeSchema.parse('IND')).toThrow();
        });
    });

    describe('CurrencyCodeSchema', () => {
        it('accepts "INR"', () => {
            expect(() => CurrencyCodeSchema.parse('INR')).not.toThrow();
        });
        it('rejects 2-letter codes', () => {
            expect(() => CurrencyCodeSchema.parse('IN')).toThrow();
        });
    });

    describe('EmailSchema', () => {
        it('accepts a valid email', () => {
            expect(() => EmailSchema.parse('test@example.com')).not.toThrow();
        });
        it('rejects an invalid email', () => {
            expect(() => EmailSchema.parse('not-an-email')).toThrow();
        });
    });

    describe('MessagingModeSchema', () => {
        it('accepts "SNS"', () => {
            expect(() => MessagingModeSchema.parse('SNS')).not.toThrow();
        });
        it('accepts "STREAMS"', () => {
            expect(() => MessagingModeSchema.parse('STREAMS')).not.toThrow();
        });
        it('rejects unknown values', () => {
            expect(() => MessagingModeSchema.parse('KAFKA')).toThrow();
        });
    });

    describe('OrderItemSchema', () => {
        it('accepts a valid order item', () => {
            expect(() =>
                OrderItemSchema.parse({
                    productId: 'p1',
                    productName: 'Widget',
                    quantity: 2,
                    unitPrice: 9.99,
                }),
            ).not.toThrow();
        });
        it('rejects quantity < 1', () => {
            expect(() =>
                OrderItemSchema.parse({
                    productId: 'p1',
                    productName: 'Widget',
                    quantity: 0,
                    unitPrice: 9.99,
                }),
            ).toThrow();
        });
        it('rejects negative unitPrice', () => {
            expect(() =>
                OrderItemSchema.parse({
                    productId: 'p1',
                    productName: 'Widget',
                    quantity: 1,
                    unitPrice: -1,
                }),
            ).toThrow();
        });
    });
});
