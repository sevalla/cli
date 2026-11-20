import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient } from '../../../src/client/api-client.ts';
import { pollDeviceToken } from '../../../src/auth/device-flow.ts';
import { SevallaCliError } from '../../../src/errors/cli-error.ts';

const DEVICE_CODE = 'kT3n9cQ0yVZr8mWbH1sLx4aPqE6uJ2dFgN7oRtYvS5w';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockResponses(...responses: Response[]) {
  const mockFetch = mock.fn(async () => responses.shift() ?? jsonResponse({ status: 'pending' }));
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  return mockFetch;
}

function poll(expiresAt = Date.now() + 300_000) {
  const waits: number[] = [];
  const client = new ApiClient({ baseUrl: 'https://api.test.com' });
  const result = pollDeviceToken(client, DEVICE_CODE, expiresAt, 5_000, async (ms) => {
    waits.push(ms);
  });
  return { result, waits };
}

describe('Device Flow', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  it('exchanges the device_code in the POST body, never in the URL', async () => {
    const mockFetch = mockResponses(
      jsonResponse({ status: 'pending' }),
      jsonResponse({ status: 'approved', token: 'svl_abc123' }),
    );

    const { result } = poll();

    assert.equal(await result, 'svl_abc123');
    assert.equal(mockFetch.mock.callCount(), 2);
    for (const call of mockFetch.mock.calls) {
      const [url, init] = call.arguments as unknown as [string, RequestInit];
      assert.equal(url, 'https://api.test.com/auth/device-codes/token');
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body as string), { device_code: DEVICE_CODE });
    }
  });

  it('throws when the request is denied', async () => {
    mockResponses(jsonResponse({ status: 'denied' }));
    await assert.rejects(poll().result, (error: Error) => {
      assert.ok(error instanceof SevallaCliError);
      assert.match(error.message, /denied/);
      return true;
    });
  });

  it('throws when the code has expired', async () => {
    mockResponses(jsonResponse({ status: 'expired' }));
    await assert.rejects(poll().result, /expired/);
  });

  it('throws when approved without a token', async () => {
    mockResponses(jsonResponse({ status: 'approved' }));
    await assert.rejects(poll().result, /no token/);
  });

  it('keeps polling with a longer interval after a 429', async () => {
    mockResponses(
      jsonResponse({ message: 'Too many requests', status: 429, data: {} }, 429),
      jsonResponse({ message: 'Too many requests', status: 429, data: {} }, 429),
      jsonResponse({ status: 'approved', token: 'svl_abc123' }),
    );

    const { result, waits } = poll();

    assert.equal(await result, 'svl_abc123');
    assert.deepEqual(waits, [5_000, 10_000, 15_000]);
  });

  it('keeps polling through network errors', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return jsonResponse({ status: 'approved', token: 'svl_abc123' });
    }) as typeof fetch;

    const { result, waits } = poll();

    assert.equal(await result, 'svl_abc123');
    assert.deepEqual(waits, [5_000, 5_000]);
  });

  it('stops once the code is past its expiry', async () => {
    const mockFetch = mockResponses();
    await assert.rejects(poll(Date.now() - 1).result, /expired/);
    assert.equal(mockFetch.mock.callCount(), 0);
  });
});
