import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src', '<rootDir>/infra'],
    testMatch: ['**/*.test.ts', '**/*.spec.ts'],
    testPathIgnorePatterns: ['/node_modules/', '/dist/', '/cdk.out/'],
    coverageDirectory: 'coverage',
    collectCoverageFrom: [
        'src/**/*.ts',
        'infra/**/*.ts',
        '!**/*.d.ts',
        '!**/node_modules/**',
        '!**/dist/**',
        '!**/cdk.out/**',
        '!**/*.test.ts',
        '!**/*.spec.ts',
        '!**/index.ts',
        '!infra/bin/**',         // CDK app entrypoint — not unit-testable
        '!**/powertools.ts',     // Thin Powertools factory wrapper — tested via integration
    ],
    coverageThreshold: {
        global: {
            branches: 80,
            functions: 80,
            lines: 80,
            statements: 80,
        },
    },
    coverageReporters: ['text', 'lcov', 'html'],
    moduleNameMapper: {
        '^@shared/(.*)$': '<rootDir>/src/shared/src/$1',
    },
    transform: {
        '^.+\\.tsx?$': [
            'ts-jest',
            {
                tsconfig: './tsconfig.test.json',
            },
        ],
    },
    // Separate integration tests — run only when --testPathPattern=integration
    testTimeout: 30000,
};

export default config;
