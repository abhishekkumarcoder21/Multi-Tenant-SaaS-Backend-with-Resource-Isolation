import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildServer } from '../../src/server.js';
import {
  cleanupTestData,
  createAdminPool,
} from '../helpers.js';

/**
 * TENANT PROVISIONING TEST SUITE
 *
 * Tests the full tenant lifecycle:
 * - Creating tenants via the admin API
 * - Authenticating with the returned API key
 * - Verifying tenant CRUD operations
 */
describe('Tenant Provisioning', () => {
  let server: FastifyInstance;
  let adminPool: pg.Pool;

  beforeAll(async () => {
    adminPool = createAdminPool();
    server = await buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await cleanupTestData(adminPool);
    await adminPool.end();
    await server.close();
  });

  beforeEach(async () => {
    await cleanupTestData(adminPool);
  });

  it('creates a new tenant and returns an API key', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/admin/tenants',
      payload: {
        name: 'Acme Corp',
        slug: 'acme-corp',
        tier: 'pro',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();

    // Verify tenant data
    expect(body.tenant.name).toBe('Acme Corp');
    expect(body.tenant.slug).toBe('acme-corp');
    expect(body.tenant.tier).toBe('pro');
    expect(body.tenant.status).toBe('active');
    expect(body.tenant.id).toBeDefined();

    // Verify API key is returned (starts with mt_)
    expect(body.api_key).toBeDefined();
    expect(body.api_key).toMatch(/^mt_/);
  });

  it('rejects duplicate slugs', async () => {
    // Create first tenant
    await server.inject({
      method: 'POST',
      url: '/admin/tenants',
      payload: { name: 'First', slug: 'unique-slug' },
    });

    // Try to create second tenant with same slug
    const response = await server.inject({
      method: 'POST',
      url: '/admin/tenants',
      payload: { name: 'Second', slug: 'unique-slug' },
    });

    expect(response.statusCode).toBe(409);
  });

  it('authenticates requests using the returned API key', async () => {
    // Create a tenant
    const createResponse = await server.inject({
      method: 'POST',
      url: '/admin/tenants',
      payload: { name: 'Auth Test', slug: 'auth-test' },
    });
    const { api_key } = createResponse.json();

    // Use the API key to make an authenticated request
    const response = await server.inject({
      method: 'GET',
      url: '/projects',
      headers: {
        authorization: `Bearer ${api_key}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().projects).toEqual([]);
  });

  it('rejects requests with invalid API key', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/projects',
      headers: {
        authorization: 'Bearer mt_invalid_key_that_does_not_exist',
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects requests without Authorization header', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/projects',
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects requests from suspended tenants', async () => {
    // Create tenant, then suspend it
    const createResponse = await server.inject({
      method: 'POST',
      url: '/admin/tenants',
      payload: { name: 'Suspended Corp', slug: 'suspended-corp' },
    });
    const { tenant, api_key } = createResponse.json();

    // Suspend the tenant
    await server.inject({
      method: 'PATCH',
      url: `/admin/tenants/${tenant.id}`,
      payload: { status: 'suspended' },
    });

    // Try to use the API key
    const response = await server.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${api_key}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toContain('suspended');
  });

  it('lists all tenants via admin endpoint', async () => {
    // Create multiple tenants
    await server.inject({
      method: 'POST',
      url: '/admin/tenants',
      payload: { name: 'Tenant 1', slug: 'tenant-1' },
    });
    await server.inject({
      method: 'POST',
      url: '/admin/tenants',
      payload: { name: 'Tenant 2', slug: 'tenant-2' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/admin/tenants',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().tenants).toHaveLength(2);
  });

  it('creates a project under the authenticated tenant', async () => {
    // Create tenant
    const createResponse = await server.inject({
      method: 'POST',
      url: '/admin/tenants',
      payload: { name: 'Project Owner', slug: 'project-owner' },
    });
    const { api_key } = createResponse.json();

    // Create a project
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: `Bearer ${api_key}` },
      payload: {
        name: 'My First Project',
        description: 'A test project',
      },
    });

    expect(projectResponse.statusCode).toBe(201);
    const project = projectResponse.json().project;
    expect(project.name).toBe('My First Project');
    expect(project.description).toBe('A test project');
    expect(project.status).toBe('active');
  });

  it('tenant cannot see other tenants\' projects via API', async () => {
    // Create two tenants
    const r1 = await server.inject({
      method: 'POST',
      url: '/admin/tenants',
      payload: { name: 'Tenant X', slug: 'tenant-x' },
    });
    const r2 = await server.inject({
      method: 'POST',
      url: '/admin/tenants',
      payload: { name: 'Tenant Y', slug: 'tenant-y' },
    });

    const keyX = r1.json().api_key;
    const keyY = r2.json().api_key;

    // Tenant X creates a project
    await server.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: `Bearer ${keyX}` },
      payload: { name: 'X Secret Project' },
    });

    // Tenant Y lists their projects — should not see X's project
    const response = await server.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${keyY}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().projects).toHaveLength(0);
    expect(response.json().total).toBe(0);
  });

  it('health check endpoint works without auth', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ok');
  });
});
