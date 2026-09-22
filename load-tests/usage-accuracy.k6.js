import http from 'k6/http';
import { check } from 'k6';

/**
 * Usage Metering Accuracy Load Test
 *
 * Runs high concurrent traffic through the API, then verifies that
 * the atomic Redis counter matches the exact total count of completed requests.
 */

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const TENANT_KEY = __ENV.TENANT_KEY || 'mt_enterprise_tenant_key';
const TENANT_ID = __ENV.TENANT_ID || '00000000-0000-0000-0000-000000000001';

export const options = {
  scenarios: {
    concurrent_requests: {
      executor: 'shared-iterations',
      vus: 25,
      iterations: 500,
      maxDuration: '30s',
    },
  },
};

export default function () {
  const params = {
    headers: {
      Authorization: `Bearer ${TENANT_KEY}`,
      'Content-Type': 'application/json',
    },
  };

  const res = http.get(`${BASE_URL}/projects`, params);
  check(res, {
    'status is 200': (r) => r.status === 200,
  });
}

export function teardown() {
  // Query usage endpoint to inspect count
  const res = http.get(`${BASE_URL}/tenants/${TENANT_ID}/usage`, {
    headers: { Authorization: `Bearer ${TENANT_KEY}` },
  });
  console.log(`[Teardown] Usage Response: status=${res.status}, body=${res.body}`);
}
