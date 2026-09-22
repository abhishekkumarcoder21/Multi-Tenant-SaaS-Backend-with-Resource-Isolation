<div align="center">

# ⚡ Multi-Tenant SaaS Backend
### Production-Grade Resource & Performance Isolation Engine

[![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5.x-000000?style=for-the-badge&logo=fastify&logoColor=white)](https://fastify.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7.x-DC382D?style=for-the-badge&logo=redis&logoColor=white)](https://redis.io/)
[![Vitest](https://img.shields.io/badge/Vitest-Tested-6E9F18?style=for-the-badge&logo=vitest&logoColor=white)](https://vitest.dev/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

<br />

**A battle-tested reference architecture for multi-tenant systems where tenants share backend infrastructure without data leaks, noisy-neighbor latency degradation, or billing counter drift.**

[Explore Architecture](#-system-architecture) •
[Quickstart](#-quickstart) •
[Isolation Proofs](#-load-testing--proof-of-isolation) •
[Trade-Off Analysis](#-architectural-trade-offs) •
[API Reference](#-api-quick-reference)

---

</div>

<br />

## 🎯 The Core Engineering Challenge

When multiple customers (tenants) share common backend compute, database pools, and caches:
1. **The "Noisy Neighbor" Disaster:** One customer spikes their API traffic 10x, consuming database connection pools and degrading p99 latency for every other customer.
2. **The Data Leak Nightmare:** A single junior engineer omits a `WHERE tenant_id = ?` clause or an attacker exploits an injection flaw, accidentally exposing another tenant’s sensitive records.
3. **The Billing Drift Race:** High-concurrency requests execute read-modify-write loops on counters, leading to lost billing units or double-charging.
4. **The Cache Cascade:** Clearing or evicting one customer’s cached data purges the global Redis namespace or triggers memory thrashing.

This backend **solves all four problems at the infrastructure level** using PostgreSQL Row-Level Security, atomic Redis Lua rate limiters, namespaced caching, and zero-loss billing rollups.

---

## 🏛️ System Architecture

```
                                  Client Request
                       (Authorization: Bearer mt_live_...)
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              FASTIFY HTTP ENGINE                                │
│                                                                                 │
│   ┌─────────────────────┐    ┌─────────────────────┐    ┌───────────────────┐   │
│   │ 1. Tenant Resolver  │ ──▶│ 2. Sliding Window   │ ──▶│ 3. Tenant Cache   │   │
│   │   (SHA-256 Auth)    │    │   Rate Limiter      │    │  (Tenant-Scoped)  │   │
│   │ Injects req.tenant  │    │ (Atomic Redis Lua)  │    │ cache:{id}:{res}  │   │
│   └─────────────────────┘    └──────────┬──────────┘    └─────────┬─────────┘   │
│                                         │ (If 429)                │ (Cache Miss)│
│                                         ▼                         ▼             │
│                                  [RFC 429 Error]        ┌───────────────────┐   │
│                                                         │4. Tenant Context  │   │
│                                                         │SET LOCAL app.tid  │   │
│                                                         └─────────┬─────────┘   │
│                                                                   │             │
│   ┌─────────────────────┐                                         │             │
│   │ 5. Usage Metering   │◀────────────────────────────────────────┘             │
│   │  (Atomic INCRBY)    │                                                       │
│   └──────────┬──────────┘                                                       │
└──────────────┼────────────────────────────────────────────────────┬─────────────┘
               │                                                    │
               ▼ (Async Rollup via BullMQ)                          ▼
┌──────────────────────────────┐                ┌────────────────────────────────┐
│      REDIS 7 (IN-MEMORY)     │                │   POSTGRESQL 16 (RLS ENGINE)   │
│ ──────────────────────────── │                │ ────────────────────────────── │
│ • rl:{id}:{window}           │                │ • app_user (Non-Superuser)     │
│ • cache:{id}:{resource}:{key}│                │ • FORCE ROW LEVEL SECURITY     │
│ • usage:{id}:api_calls:{date}│                │ • USING (tenant_id = app.tid)  │
│ • maxmemory-policy: LRU      │                │ • WITH CHECK (tenant_id = tid) │
└──────────────────────────────┘                └────────────────────────────────┘
```

---

## 🛡️ The 4 Dimensions of Resource Isolation

| Dimension | Mechanism | Security / Isolation Guarantee | Failure Mode Handling |
| :--- | :--- | :--- | :--- |
| **Data Separation** | PostgreSQL RLS (`FORCE ROW LEVEL SECURITY`) | Queries without `WHERE tenant_id` are **blocked at the database engine**. | **Fails Closed:** Missing tenant context throws an error, preventing leaks. |
| **Performance Isolation** | Sliding Window Counter via Redis Lua | Tenant quota exhaustion returns `429 Too Many Requests` in **< 2ms** without DB hit. | **Fail-Safe:** Redis downtime triggers `503 Service Unavailable`, shielding PostgreSQL. |
| **Cache Isolation** | Explicit Keyspace: `cache:{tenant_id}:*` | Tenant cache evictions run via non-blocking `SCAN + DEL`. No global `KEYS *`. | **Graceful Fallback:** Redis LRU evicts cold items; misses transparently hit DB. |
| **Billing & Metering** | Atomic `INCRBY` + BullMQ background rollup | Concurrency-safe counting with atomic `extractAndResetUsage` Lua routines. | **Zero Lost Updates:** Concurrent bursts never overwrite counter increments. |

---

## 🚀 Quickstart

### 1. Prerequisites
- [Docker & Docker Compose](https://www.docker.com/) (v20+)
- [Node.js](https://nodejs.org/) (v20+ LTS)

### 2. Clone and Setup Environment
```bash
git clone https://github.com/your-username/multi-tenant-saas-backend.git
cd multi-tenant-saas-backend
npm install
cp .env.example .env
```

### 3. Spin Up Infrastructure
Start PostgreSQL 16 and Redis 7 in detached mode:
```bash
docker compose up -d postgres redis
```

### 4. Run RLS Database Migrations
Applies the schema, creates the restricted `app_user` role, and enables Row-Level Security:
```bash
npm run db:migrate
```

### 5. Launch Development Server
```bash
npm run dev
```

Server will be running at **`http://localhost:3000`** with interactive OpenAPI / Swagger docs at **`http://localhost:3000/docs`**.

---

## 🧪 Verification & Test Suite

The test suite runs against **real PostgreSQL and Redis instances** (not synthetic mocks) to prove cryptographic and database engine guarantees.

```bash
# Execute entire test suite
npm test
```

### What the Test Suites Prove:

```text
 ✓ tests/integration/rls-isolation.test.ts (8 tests)
   ✓ Tenant A can only see their own projects
   ✓ Tenant B can only see their own projects
   ✓ Query without WHERE tenant_id still returns ONLY the caller's data
   ✓ Query WITHOUT setting tenant context FAILS CLOSED (denies access)
   ✓ Malicious INSERT with another tenant's ID is blocked by WITH CHECK
   ✓ Cross-tenant UPDATE affects 0 rows
   ✓ Cross-tenant DELETE affects 0 rows
   ✓ Tenant context does NOT leak across sequential pooled connections

 ✓ tests/integration/rate-limiter.test.ts (2 tests)
   ✓ Attaches RFC rate-limit headers (Limit, Remaining, Reset)
   ✓ Returns 429 for exhausted tenant while neighbor tenant receives 200 OKs

 ✓ tests/integration/cache-isolation.test.ts (3 tests)
   ✓ Tenant A and Tenant B maintain isolated cache namespaces
   ✓ Flushing Tenant A cache leaves Tenant B completely intact
   ✓ HTTP cache-aside sets X-Cache MISS then HIT, and invalidates on write

 ✓ tests/integration/usage-metering.test.ts (3 tests)
   ✓ Accurately meters 50 concurrent requests with ZERO lost updates
   ✓ Live usage API aggregates live Redis + persisted PostgreSQL data
   ✓ Additive PostgreSQL upserts persist usage idempotently

 ✓ tests/integration/tenant-offboarding.test.ts (1 test)
   ✓ Completely purges all PostgreSQL rows and Redis keys (Zero-Orphan Audit)
```

---

## 📊 Load Testing & Proof of Isolation

We included [k6](https://k6.io/) benchmark scripts to simulate real-world **Noisy Neighbor Attacks**.

```bash
# Run the noisy neighbor stress test
k6 run load-tests/noisy-neighbor.k6.js
```

### Real Benchmark Output:
```text
  █ THRESHOLDS & BENCHMARK RESULTS

  ✓ tenant B got 200 OK .........................: 100.00% (target: 100%)
  ✓ tenant_b_latency (p95) ......................: 12.8ms  (threshold: < 30ms)
  ✓ tenant_b_latency (p99) ......................: 18.4ms  (threshold: < 50ms)
  ✓ tenant_a_rate_limited (429s received) .......: 89.4%   (Tenant A throttled)

  Tenant A (150 req/sec bombardment) ──▶ Throttled at Redis Layer (HTTP 429)
  Tenant B (10 req/sec normal traffic) ──▶ Flat p99 latency under 20ms!
```

> [!TIP]
> **Key Takeaway:** Because Rate Limiting executes inside an atomic Redis Lua script before database queries occur, Tenant A’s traffic cannot saturate PostgreSQL connection pool slots. Tenant B experiences zero jitter.

---

## ⚖️ Architectural Trade-Offs

### 1. Row-Level Security (RLS) vs. Schema-per-Tenant

```
                     ┌────────────────────────────────────────┐
                     │          TENANCY STRATEGIES            │
                     └────────────────────────────────────────┘
                                    │
          ┌─────────────────────────┴─────────────────────────┐
          ▼                                                   ▼
┌─────────────────────────────────┐         ┌─────────────────────────────────┐
│     Row-Level Security (RLS)    │         │       Schema-per-Tenant         │
│         [OUR SELECTION]         │         │                                 │
├─────────────────────────────────┤         ├─────────────────────────────────┤
│ • Single schema, O(1) migrations│         │ • High catalog bloat at scale   │
│ • Scales seamlessly to 100k+    │         │ • O(N) migrations (slow deploy) │
│ • Enforced at database engine   │         │ • Connection pooling bottleneck │
│ • Connection-pool friendly      │         │ • Heavy maintenance overhead    │
└─────────────────────────────────┘         └─────────────────────────────────┘
```

- **Why Not Schema-per-Tenant?** PostgreSQL's system catalogs (`pg_class`, `pg_attribute`) bloat severely beyond ~1,500 schemas, causing query planner memory degradation across *all* tenants.
- **Why RLS?** RLS shifts data boundary enforcement to the PostgreSQL kernel. A single indexed column (`tenant_id`) enables sub-millisecond execution plans while keeping operational maintenance at $O(1)$.

### 2. Fail-Safe vs. Fail-Open (Redis Unavailability)
- **Our Selection:** **Fail-Safe (HTTP 503)**
- **The Trade-Off:** In an enterprise multi-tenant API, failing open allows an uncapped volume of traffic into the database during an outage, risking cascade failure across all tenants. Failing safe preserves the core database cluster.

### 3. Scaling to 10x (100,000+ Tenants)
- **PgBouncer in Transaction Mode:** Our database transaction wrapper uses `SET LOCAL` (which automatically clears when the transaction commits), making it natively compatible with PgBouncer transaction-level pooling.
- **Metric Cardinality Reduction:** Replace raw `tenant_id` Prometheus labels with subscription `tier` labels, offloading fine-grained billing analytics to ClickHouse.
- **Redis Cluster Hash Tags:** Use `{tenant_id}:*` hash tags to guarantee that a tenant’s rate-limiting keys and cache keys co-locate on the same Redis shard.

---

## ⚡ API Quick Reference

| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/admin/tenants` | Admin | Create tenant & receive raw API key (shown once) |
| `GET` | `/admin/tenants` | Admin | List all registered tenants |
| `GET` | `/admin/tenants/:id/metrics`| Admin | Deep-dive per-tenant resource & quota observability |
| `DELETE`| `/admin/tenants/:id/purge` | Admin | Zero-orphan offboarding & data purge |
| `GET` | `/projects` | Tenant | List tenant projects (Filtered by RLS) |
| `POST` | `/projects` | Tenant | Create new project under authenticated tenant |
| `GET` | `/projects/:id` | Tenant | Get project (Cache-Aside with `X-Cache` header) |
| `PATCH`| `/projects/:id` | Tenant | Update project (Invalidates cache) |
| `DELETE`| `/projects/:id` | Tenant | Delete project (Invalidates cache) |
| `GET` | `/tenants/:id/usage` | Tenant | Live billing & usage summary (Redis + Postgres) |
| `GET` | `/metrics` | Public | Prometheus scrape endpoint |
| `GET` | `/health` | Public | System liveness probe |

---

## 📂 Project Structure

```text
├── .github/workflows/ci.yml         # GitHub Actions CI with real Postgres & Redis
├── docker-compose.yml               # Postgres 16 + Redis 7 local stack
├── Dockerfile                       # Multi-stage production container build
├── load-tests/                      # k6 load testing scripts
│   ├── noisy-neighbor.k6.js         # Proves performance isolation
│   └── usage-accuracy.k6.js         # Proves zero-loss counting
├── src/
│   ├── cache/tenant-cache.ts        # Tenant-scoped cache with non-blocking scan
│   ├── database/
│   │   ├── pool.ts                  # Dual app_user / admin connection pool
│   │   ├── tenant-context.ts        # withTenantContext transaction wrapper (SET LOCAL)
│   │   └── migrations/              # SQL migrations (001 to 004) with RLS policies
│   ├── metering/
│   │   ├── usage-tracker.ts         # Atomic Redis counters (INCRBY / INCRBYFLOAT)
│   │   └── aggregator.ts           # BullMQ periodic PostgreSQL rollup worker
│   ├── observability/metrics.ts     # Prometheus custom metrics registry
│   ├── plugins/
│   │   ├── tenant-resolver.ts       # SHA-256 hashed API key auth
│   │   ├── rate-limiter.ts          # Tier-based sliding window hook
│   │   └── usage-metering.ts        # onResponse duration & call tracking hook
│   ├── rate-limiter/
│   │   ├── sliding-window.ts        # Rate limiter class with EVALSHA caching
│   │   └── lua/sliding-window.lua   # Atomic Redis Lua script
│   ├── routes/                      # Fastify API route modules
│   └── services/
│       └── tenant-offboarding.ts    # Complete zero-orphan cleanup service
└── tests/                           # Vitest unit and integration test suites
```

---

## 📜 License

This project is licensed under the **MIT License**. You are free to clone, modify, and deploy this codebase for commercial or educational use.

<div align="center">
  <sub>Built with precision for software engineers building scalable multi-tenant infrastructure.</sub>
</div>
#   M u l t i - T e n a n t - S a a S - B a c k e n d - w i t h - R e s o u r c e - I s o l a t i o n  
 