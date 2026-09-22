# Architecture & Resource Isolation Design

## 1. Request Lifecycle Overview

Every inbound request passes through a strictly layered, defense-in-depth pipeline before any data is read or returned:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Incoming Client Request                         │
│                    `Authorization: Bearer mt_...`                      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 1. Tenant Resolver (`tenant-resolver.ts`)                              │
│    - Extracts raw API key and computes SHA-256 hash.                  │
│    - Looks up tenant metadata from `tenants` table.                   │
│    - Validates account status ('active', 'suspended', 'deleted').      │
│    - Injects `request.tenant = { id, name, slug, tier, status }`.      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2. Per-Tenant Rate Limiter (`rate-limiter.ts`)                         │
│    - Reads `request.tenant.tier` (free / pro / enterprise).            │
│    - Executes atomic Redis Lua script (Sliding Window Counter).        │
│    - Sets RFC headers: `X-RateLimit-Limit`, `Remaining`, `Reset`.      │
│    - If quota exhausted: returns `429 Too Many Requests`.              │
│    - If Redis fails: returns `503 Service Unavailable` (Fail-Safe).    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 3. Tenant-Aware Caching (`tenant-cache.ts`)                            │
│    - Cache key namespace: `cache:{tenant_id}:{resource}:{key}`.        │
│    - Checks Redis for cached entity.                                   │
│    - On Cache Hit: sets `X-Cache: HIT` and immediately returns.        │
│    - On Cache Miss: falls through to Database Access Layer.            │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 4. RLS Database Transaction (`tenant-context.ts`)                      │
│    - Acquires connection from `appPool` (non-superuser role).          │
│    - Executes `BEGIN;`                                                 │
│    - Runs `SELECT set_config('app.tenant_id', $tenant_id, true);`      │
│    - Executes application SQL queries.                                 │
│    - PostgreSQL RLS filters rows using `USING` and `WITH CHECK`.       │
│    - Executes `COMMIT;` (or `ROLLBACK;` on error).                     │
│    - Connection released clean to pool (SET LOCAL automatically drops).│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 5. Usage Metering & Observability (`usage-metering.ts`)               │
│    - Fastify `onResponse` hook measures exact elapsed compute ms.      │
│    - Atomically increments Redis counters via `INCRBY` / `INCRBYFLOAT`.│
│    - Records Prometheus metrics with `tenant_id` labels.               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        HTTP Response to Client                         │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Resource Isolation Dimensions

### Dimension A: Data Isolation (Security Critical)
- **Engine-Level Enforcement:** Row-Level Security (RLS) is applied at the PostgreSQL engine level (`ALTER TABLE ... FORCE ROW LEVEL SECURITY`).
- **Non-Superuser App User:** The app connects as `app_user`, which does NOT hold `BYPASSRLS`. Even with raw SQL execution or missing `WHERE tenant_id = ?`, cross-tenant data cannot be returned.
- **Fail Closed:** If `app.tenant_id` is missing or undefined, `current_setting('app.tenant_id')::uuid` throws an exception, causing the transaction to abort rather than returning empty rows or leaking records.
- **Write Poisoning Prevention:** Policies define `WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid)`. Attempting to insert or update records with an unauthorized tenant ID is blocked by PostgreSQL constraint checks.

### Dimension B: Performance Isolation ("Noisy Neighbor" Prevention)
- **Token Bucket / Sliding Window in Redis:** Rate limits are calculated per `tenant_id`.
- **Atomic Lua Evaluation:** A tenant sending bursts of traffic consumes their own bucket. Once exhausted, they receive `429 Too Many Requests` in < 2ms without consuming PostgreSQL connection pool slots.
- **Independent Pools:** Other tenants sending normal traffic continue to receive `200 OK` responses with stable sub-50ms p99 latency.

### Dimension C: Memory & Cache Isolation
- **Tenant-Scoped Keyspaces:** All cache keys strictly adhere to `cache:{tenant_id}:{resource}:{key}`.
- **Safe Eviction:** Flushing a tenant (`flushTenant`) executes non-blocking `SCAN` and `DEL` on `cache:{tenant_id}:*`, never touching other tenants' keys.
- **LRU Memory Management:** Redis is configured with `maxmemory-policy allkeys-lru`. If memory pressure forces evictions, least-used keys are purged, and the cache gracefully falls back to database reads.

### Dimension D: Billing & Accounting Accuracy
- **Zero-Loss Counters:** API calls and compute milliseconds use Redis atomic commands (`INCRBY`, `INCRBYFLOAT`).
- **Safe Extraction:** The background aggregator uses an atomic Lua script (`extractAndResetUsage`) to retrieve and reset counters simultaneously. No concurrent requests arriving during the flush can be lost or double-counted.
- **Additive Idempotent Rollup:** Flushed data is upserted into PostgreSQL using `ON CONFLICT (tenant_id, recorded_date) DO UPDATE SET api_calls = usage_records.api_calls + EXCLUDED.api_calls`.

---

## 3. Failure Scenarios & Mitigations

### 1. Noisy Neighbor Overload
- **Scenario:** Tenant A launches 10,000 req/sec against the backend.
- **Behavior:** Tenant A is throttled at the Redis rate-limiter stage (returning HTTP 429). Fastify drops execution before hitting the database.
- **Guarantee:** Tenant B's p99 latency remains flat (< 50ms) because database pool connections are not monopolized by Tenant A.

### 2. Usage Counter Race Conditions
- **Scenario:** 100 concurrent requests arrive for Tenant A within the same millisecond.
- **Behavior:** Redis serializes execution through single-threaded atomic operations (`INCRBY`).
- **Guarantee:** Counter reads exactly +100. There are no lost updates or read-modify-write race conditions.

### 3. RLS Bypass Attempt
- **Scenario:** A rogue query executes `SELECT * FROM projects;` without any `WHERE tenant_id = ?` clause.
- **Behavior:** PostgreSQL intercepts the query plan and automatically injects the active RLS policy condition (`tenant_id = current_setting('app.tenant_id')::uuid`).
- **Guarantee:** Only rows belonging to the authenticated tenant are returned.

### 4. Redis Unavailability (Fail-Safe Choice)
- **Scenario:** Redis crashes or network partition occurs.
- **Decision:** **Fail-Safe (Closed)** — Return `503 Service Unavailable`.
- **Justification:** In a multi-tenant commercial backend, failing open would allow malicious or runaway tenants to send infinite unmetered traffic, crashing the underlying PostgreSQL database and causing unmetered revenue loss. Failing closed protects database integrity.

### 5. Tenant Offboarding & Data Deletion
- **Scenario:** Tenant offboards or requests GDPR data purge.
- **Behavior:** `offboardTenant()` service executes a complete purge:
  1. Deletes relational rows from `projects` and `usage_records` (cascaded from `tenants`).
  2. Scans and deletes all `cache:{tenant_id}:*` keys.
  3. Scans and deletes all `rl:{tenant_id}:*` rate limiting keys.
  4. Scans and deletes all `usage:{tenant_id}:*` accounting keys.
- **Guarantee:** Verifiably zero orphaned data remains in Postgres or Redis.
