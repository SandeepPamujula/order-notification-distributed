import http from 'k6/http';
import { check } from 'k6';

// Read URL from environment variable, fallback to localhost for safety
const API_URL = __ENV.API_URL || 'https://api.spworks.click/orders';

// Random string generator for payload
function randomString(length) {
    const charset = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let res = '';
    while (length--) res += charset[Math.floor(Math.random() * charset.length)];
    return res;
}

export const options = {
    discardResponseBodies: true,
    scenarios: {
        ramp_up_and_sustain: {
            executor: 'ramping-arrival-rate',
            startRate: 0,
            timeUnit: '1s',
            // Pre-allocate enough VUs to handle the target RPS
            preAllocatedVUs: 5000,
            maxVUs: 30000,
            stages: [
                { target: 10000, duration: '5m' }, // Ramp up to 10k RPS over 5 min
                { target: 10000, duration: '10m' }, // Sustain 10k RPS for 10 min
            ],
        },
    },
    thresholds: {
        http_req_duration: ['p(99)<1000'], // p99 API Gateway latency < 1000ms
        http_req_failed: ['rate<0.001'], // Error rate < 0.1%
    },
};

export default function () {
    const payload = JSON.stringify({
        userId: `user-${randomString(8)}`,
        userEmail: `loadtest-${randomString(5)}@example.com`,
        country: 'US', // Hardcoding to target a specific region (us-east-1 routing)
        currency: 'USD',
        totalAmount: 150,
        items: [
            {
                productId: `prod-${randomString(6)}`,
                productName: 'Load Test Product',
                quantity: 1,
                unitPrice: 150
            }
        ]
    });

    const params = {
        headers: {
            'Content-Type': 'application/json',
        },
    };

    const res = http.post(API_URL, payload, params);

    check(res, {
        'is status 201': (r) => r.status === 201,
    });
}
