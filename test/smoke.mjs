// Smoke tests for the Workers entry / express adapter.
// Run with: node --test test/smoke.mjs
//
// Builds the worker bundle first (npm run build) so we can boot the
// `default.fetch(request, env, ctx)` export against fake KV / ctx objects.

import assert from 'node:assert/strict';
import { test } from 'node:test';

function normalizeBackendPath(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '/') return null;
    if (!trimmed.startsWith('/')) return null;
    return trimmed.replace(/\/+$/, '') || null;
}

test('normalizeBackendPath rejects invalid values', () => {
    assert.equal(normalizeBackendPath(undefined), null);
    assert.equal(normalizeBackendPath(null), null);
    assert.equal(normalizeBackendPath(''), null);
    assert.equal(normalizeBackendPath('/'), null);
    assert.equal(normalizeBackendPath('abc'), null, 'must start with /');
    assert.equal(normalizeBackendPath('  '), null);
});

test('normalizeBackendPath strips trailing slashes', () => {
    assert.equal(normalizeBackendPath('/abc'), '/abc');
    assert.equal(normalizeBackendPath('/abc/'), '/abc');
    assert.equal(normalizeBackendPath('/abc//'), '/abc');
    assert.equal(normalizeBackendPath('  /abc  '), '/abc');
});

const BUNDLE = new URL('../dist/worker.js', import.meta.url).href;

let workerModule;
try {
    workerModule = await import(BUNDLE);
} catch (e) {
    console.warn(`[smoke] worker bundle not found, run npm run build first. ${e.message}`);
    process.exit(2);
}

function makeKV() {
    const store = new Map();
    return {
        async get(key) { return store.get(key) ?? null; },
        async put(key, value) { store.set(key, value); },
        async delete(key) { store.delete(key); },
        _store: store,
    };
}

function makeCtx() {
    const tasks = [];
    return {
        waitUntil(p) { tasks.push(p); },
        get _tasks() { return tasks; },
    };
}

const worker = workerModule.default;

test('OPTIONS preflight returns 204 with explicit allowed methods', async () => {
    const env = { SUB_STORE_DATA: makeKV() };
    const req = new Request('https://test.example/foo', { method: 'OPTIONS' });
    const res = await worker.fetch(req, env, makeCtx());
    assert.equal(res.status, 204);
    const allowMethods = res.headers.get('Access-Control-Allow-Methods');
    assert.match(allowMethods, /GET/);
    assert.match(allowMethods, /POST/);
    assert.notEqual(allowMethods, '*');
});

test('healthz works without auth and without KV data', async () => {
    const env = { SUB_STORE_DATA: makeKV(), SUB_STORE_FRONTEND_BACKEND_PATH: '/secret' };
    const req = new Request('https://test.example/healthz');
    const res = await worker.fetch(req, env, makeCtx());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'success');
    assert.equal(body.data.ok, true);
    assert.match(body.data.version, /^\d/);
});

test('management API without prefix → 401', async () => {
    const env = { SUB_STORE_DATA: makeKV(), SUB_STORE_FRONTEND_BACKEND_PATH: '/secret' };
    const req = new Request('https://test.example/api/subs');
    const res = await worker.fetch(req, env, makeCtx());
    assert.equal(res.status, 401);
});

test('management API with prefix → routed', async () => {
    const env = { SUB_STORE_DATA: makeKV(), SUB_STORE_FRONTEND_BACKEND_PATH: '/secret' };
    const req = new Request('https://test.example/secret/api/utils/worker-status');
    const res = await worker.fetch(req, env, makeCtx());
    assert.notEqual(res.status, 401);
    const body = await res.json();
    assert.equal(body.status, 'success');
    assert.equal(body.data.auth.backendPathConfigured, true);
});

test('share/download routes stay public (no /api/ prefix)', async () => {
    const env = { SUB_STORE_DATA: makeKV(), SUB_STORE_FRONTEND_BACKEND_PATH: '/secret' };
    const req = new Request('https://test.example/share/sub/nonexistent');
    const res = await worker.fetch(req, env, makeCtx());
    assert.notEqual(res.status, 401);
});

test('exact-match prefix redirects to trailing-slash variant', async () => {
    const env = { SUB_STORE_DATA: makeKV(), SUB_STORE_FRONTEND_BACKEND_PATH: '/secret' };
    const req = new Request('https://test.example/secret');
    const res = await worker.fetch(req, env, makeCtx());
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), 'https://test.example/secret/');
});

test('preview/sub-flow are management endpoints behind prefix', async () => {
    const env = { SUB_STORE_DATA: makeKV(), SUB_STORE_FRONTEND_BACKEND_PATH: '/secret' };
    for (const path of ['/api/preview/sub', '/api/sub/flow/foo']) {
        const req = new Request(`https://test.example${path}`);
        const res = await worker.fetch(req, env, makeCtx());
        assert.equal(res.status, 401, `${path} must require auth`);
    }
});

test('invalid backend path → 500 with clear message', async () => {
    const env = { SUB_STORE_DATA: makeKV(), SUB_STORE_FRONTEND_BACKEND_PATH: 'no-leading-slash' };
    const req = new Request('https://test.example/api/subs');
    const res = await worker.fetch(req, env, makeCtx());
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.message, /must start with/i);
});

test('missing KV binding → 500 with helpful message', async () => {
    const env = {};
    const req = new Request('https://test.example/healthz');
    const res = await worker.fetch(req, env, makeCtx());
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.message, /KV/);
});

test('management API without backendPath set → public but warned', async () => {
    const env = { SUB_STORE_DATA: makeKV() };
    const req = new Request('https://test.example/api/utils/worker-status');
    const res = await worker.fetch(req, env, makeCtx());
    assert.notEqual(res.status, 401);
    assert.equal(
        res.headers.get('X-Sub-Store-Security-Warning'),
        'SUB_STORE_FRONTEND_BACKEND_PATH is not configured; management API is public',
    );
    const body = await res.json();
    assert.equal(body.data.auth.managementApiPublic, true);
});

test('malformed percent-encoded path does not 500 in router', async () => {
    const env = { SUB_STORE_DATA: makeKV() };
    // Use a path that doesn't go through upstream handlers — /api/utils/env
    // is a valid management endpoint and accepts no params
    const req = new Request('https://test.example/api/utils/worker-status?q=%E4');
    const res = await worker.fetch(req, env, makeCtx());
    assert.notEqual(res.status, 500, `unexpected 500 for malformed path: ${res.status}`);
});

test('CORS Allow-Origin set on regular responses', async () => {
    const env = { SUB_STORE_DATA: makeKV() };
    const req = new Request('https://test.example/healthz');
    const res = await worker.fetch(req, env, makeCtx());
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

test('worker-status reports KV status correctly', async () => {
    const env = { SUB_STORE_DATA: makeKV() };
    const req = new Request('https://test.example/api/utils/worker-status');
    const res = await worker.fetch(req, env, makeCtx());
    const body = await res.json();
    assert.equal(body.data.kv.bound, true);
    assert.equal(body.data.kv.binding, 'SUB_STORE_DATA');
    assert.equal(body.data.capabilities.scriptOperator.supported, false);
});

test('write to KV persists between requests', async () => {
    const kv = makeKV();
    const env = { SUB_STORE_DATA: kv };
    // Issue a settings PATCH to create some state
    const initial = await worker.fetch(
        new Request('https://test.example/api/settings'),
        env,
        makeCtx(),
    );
    assert.equal(initial.status, 200);
    const ctx = makeCtx();
    await worker.fetch(
        new Request('https://test.example/api/settings', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ syncTime: 12345 }),
        }),
        env,
        ctx,
    );
    // Wait for waitUntil tasks (KV persistence)
    await Promise.all(ctx._tasks);
    assert.ok(kv._store.size > 0, 'KV should have been written');
});
