import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from './api.js';

test('API bridge sends bearer authorization only to the configured origin', async () => {
  const original = globalThis.fetch;
  let seen: RequestInit | undefined;
  let requestedUrl = '';
  try {
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input);
      seen = init;
      return Response.json({ serverId: 'local', version: '1' });
    }) as typeof fetch;

    const health = await request<{ serverId: string }>(
      {
        url: 'http://ignored@127.0.0.1:4317/discarded/path?option=ignored#fragment',
        token: 'private-token',
      },
      '/api/health',
    );

    assert.equal(health.serverId, 'local');
    assert.equal(requestedUrl, 'http://127.0.0.1:4317/api/health');
    assert.equal(new URL(requestedUrl).search, '');
    assert.equal(new URL(requestedUrl).username, '');
    assert.equal(requestedUrl.includes('private-token'), false);
    assert.equal(
      (seen?.headers as Record<string, string>).Authorization,
      'Bearer private-token',
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('API bridge rejects a URL outside the configured server before sending the token', async () => {
  const original = globalThis.fetch;
  let fetchCalled = false;
  try {
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return Response.json({});
    }) as typeof fetch;

    await assert.rejects(
      request(
        { url: 'http://127.0.0.1:4317', token: 'private-token' },
        'https://outside.example/api/health',
      ),
      /configured server/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('API bridge preserves the server detail for a 409 conflict', async () => {
  const original = globalThis.fetch;
  const detail = 'This root cannot be deleted because its indexed history must be preserved.';
  try {
    globalThis.fetch = (async () =>
      Response.json({ error: detail }, { status: 409 })) as typeof fetch;

    await assert.rejects(
      request(
        { url: 'http://server', token: 'test-token' },
        '/api/roots/root-id',
        { method: 'DELETE' },
      ),
      (error: unknown) => error instanceof Error && error.message === detail,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('API bridge gives readable errors for common statuses and unreachable servers', async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, message] of [
      [401, /rejected/],
      [404, /not found/],
      [409, /conflict/],
      [503, /HTTP 503/],
    ] as const) {
      globalThis.fetch = (async () => new Response('{}', { status })) as typeof fetch;
      await assert.rejects(
        request({ url: 'http://server', token: 'test-token' }, '/api/test'),
        message,
      );
    }

    globalThis.fetch = (async () => {
      throw new Error('private transport detail');
    }) as typeof fetch;
    await assert.rejects(
      request({ url: 'http://server', token: 'test-token' }, '/api/test'),
      /Could not reach/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('generic API requests leave response fields unchanged', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (_input, init) => {
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, undefined);
      return Response.json({ open_count: 7, last_opened_at: 1_795_697_000 });
    }) as typeof fetch;

    const stats = await request<{ open_count: number; last_opened_at: number }>(
      { url: 'http://127.0.0.1:4317', token: 'local-test' },
      '/api/entries/book-id/open',
      { method: 'POST', body: '{}' },
    );

    assert.deepEqual(stats, { open_count: 7, last_opened_at: 1_795_697_000 });
  } finally {
    globalThis.fetch = original;
  }
});

test('credential settings writes reject redirects before a cookie body can be forwarded', async () => {
  const original = globalThis.fetch;
  let seen: RequestInit | undefined;
  let redirectedRequestCount = 0;
  try {
    globalThis.fetch = (async (_input, init) => {
      seen = init;
      if (init?.redirect === 'error') throw new TypeError('redirect blocked');
      redirectedRequestCount += 1;
      return Response.json({ site: 'exhentai.org', credentialsConfigured: true });
    }) as typeof fetch;

    await assert.rejects(
      request(
        { url: 'http://127.0.0.1:4317', token: 'fixture-token' },
        '/api/settings/eh',
        {
          method: 'PUT',
          body: JSON.stringify({
            site: 'exhentai.org',
            cookieHeader: 'session=synthetic-cookie-value',
          }),
        },
      ),
      /Could not reach/,
    );
    assert.equal(seen?.redirect, 'error');
    assert.match(String(seen?.body), /synthetic-cookie-value/);
    assert.equal(redirectedRequestCount, 0);
  } finally {
    globalThis.fetch = original;
  }
});
