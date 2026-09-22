import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

/**
 * Noisy Neighbor Multi-Tenant Load Test
 *
 * Demonstrates real performance isolation:
 * - Scenario 1: Tenant A (Noisy Neighbor) hammers the backend with 10x normal traffic.
 *   Tenant A gets throttled (429s).
 * - Scenario 2: Tenant B (Standard Neighbor) sends continuous requests at normal rate.
 *   Tenant B's p99 latency MUST stay under 50ms, with 0% 429s.
 *
 * To run:
 *   k6 run load-tests/noisy-neighbor.k6.js
 */

const tenantALatency = new Trend('tenant_a_latency', true);
const tenantBLatency = new Trend('tenant_b_latency', true);
const tenantBSuccessRate = new Rate('tenant_b_success_rate');

// Environment variables or test defaults
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const TENANT_A_KEY = __ENV.TENANT_A_KEY || 'mt_tenant_a_heavy_load_key';
const TENANT_B_KEY = __ENV.TENANT_B_KEY || 'mt_tenant_b_normal_user_key';

export const options = {
  scenarios: {
    // Tenant A: Aggressive burst traffic (Noisy Neighbor)
    noisy_neighbor: {
      executor: 'constant-arrival-rate',
      rate: 150, // 150 req/sec
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 20,
      maxVUs: 50,
      exec: 'tenantAFlow',
    },
    // Tenant B: Consistent normal traffic (Well-behaved Neighbor)
    normal_neighbor: {
      executor: 'constant-arrival-rate',
      rate: 10, // 10 req/sec
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 5,
      maxVUs: 15,
      exec: 'tenantBFlow',
    },
  },
  thresholds: {
    // Tenant B's p99 latency must stay below 50ms despite Tenant A's heavy bombardment!
    tenant_b_latency: ['p(95)<30', 'p(99)<50'],
    tenant_b_success_rate: ['rate>0.99'],
  },
};

export function tenantAFlow() {
  const params = {
    headers: {
      Authorization: `Bearer ${TENANT_A_KEY}`,
      'Content-Type': 'application/json',
    },
  };

  const res = http.get(`${BASE_URL}/projects`, params);
  tenantALatency.add(res.timings.duration);

  // Expect either 200 (initially) or 429 (when rate limit kicked in)
  check(res, {
    'tenant A got 200 or 429': (r) => r.status === 200 || r.status === 429,
  });
}

export function tenantBFlow() {
  const params = {
    headers: {
      Authorization: `Bearer ${TENANT_B_KEY}`,
      'Content-Type': 'application/json',
    },
  };

  const res = http.get(`${BASE_URL}/projects`, params);
  tenantBLatency.add(res.timings.duration);

  const success = res.status === 200;
  tenantBSuccessRate.add(success);

  check(res, {
    'tenant B got 200 OK': (r) => r.status === 200,
  });
}
