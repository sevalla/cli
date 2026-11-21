import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient } from '../../../src/client/api-client.ts';
import {
  clientHeader,
  hostLabel,
  performDeviceFlow,
  pollDeviceToken,
} from '../../../src/auth/device-flow.ts';
import { SevallaCliError } from '../../../src/errors/cli-error.ts';
import { getVersion } from '../../../src/helpers/config.ts';

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

function poll(expiresAt = Date.now() + 300_000, interval?: unknown) {
  const waits: number[] = [];
  const client = new ApiClient({ baseUrl: 'https://api.test.com' });
  const result = pollDeviceToken(client, DEVICE_CODE, expiresAt, interval, async (ms) => {
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

  it('polls every 5 to 60 seconds, whatever interval the server sends', async () => {
    for (const [interval, expected] of [
      [0.001, 5_000],
      [-3, 5_000],
      ['abc', 5_000],
      [undefined, 5_000],
      [10, 10_000],
      [1e9, 60_000],
    ] as const) {
      mockResponses(jsonResponse({ status: 'approved', token: 'svl_abc123' }));
      const { result, waits } = poll(undefined, interval);
      await result;
      assert.deepEqual(waits, [expected], `interval ${String(interval)}`);
    }
  });

  it('fails fast on a 4xx other than 429', async () => {
    const mockFetch = mockResponses(
      jsonResponse({ message: 'Bad Request', status: 400, data: {} }, 400),
    );
    await assert.rejects(poll().result, /HTTP 400/);
    assert.equal(mockFetch.mock.callCount(), 1);
  });

  it('keeps polling through server errors', async () => {
    mockResponses(
      jsonResponse({ message: 'Internal Server Error', status: 500, data: {} }, 500),
      jsonResponse({ status: 'approved', token: 'svl_abc123' }),
    );
    assert.equal(await poll().result, 'svl_abc123');
  });

  it('suggests checking API keys when the code expires', async () => {
    mockResponses(jsonResponse({ status: 'expired' }));
    await assert.rejects(poll().result, /check API keys in the Sevalla dashboard/);
  });

  describe('performDeviceFlow', () => {
    function mockCreate(body: unknown) {
      const mockFetch = mockResponses(jsonResponse(body, 201));
      const log = mock.method(console, 'log', () => {});
      const openBrowser = mock.fn(async (_url: string) => {});
      return { mockFetch, log, openBrowser };
    }

    it('with --no-browser, shows the user code, never the device_code, and opens nothing', async () => {
      const { mockFetch, log, openBrowser } = mockCreate({
        user_code: 'ABCD1234',
        device_code: DEVICE_CODE,
        code: 'ABCD1234',
        expires_at: new Date(Date.now() - 1).toISOString(),
      });

      await assert.rejects(
        performDeviceFlow('https://api.test.com', openBrowser, { browser: false }),
        /expired/,
      );

      const output = log.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
      assert.match(output, /ABCD1234/);
      assert.match(output, /app\.sevalla\.com\/authorize/);
      assert.match(output, /api\.test\.com/);
      assert.ok(!output.includes(DEVICE_CODE));
      assert.equal(openBrowser.mock.callCount(), 0);

      const [url, init] = mockFetch.mock.calls[0]!.arguments as unknown as [string, RequestInit];
      assert.equal(url, 'https://api.test.com/auth/device-codes');
      assert.match(
        (init.headers as Record<string, string>)['x-sevalla-client']!,
        /^sevalla-cli\/\S+( \([A-Za-z0-9][A-Za-z0-9-]*\))?$/,
      );
    });

    it('fails fast when the server returns no device_code', async () => {
      const { openBrowser } = mockCreate({
        code: 'ABCD1234',
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      });

      await assert.rejects(
        performDeviceFlow('https://api.test.com', openBrowser, { browser: false }),
        /does not support this sign-in flow/,
      );
      assert.equal(openBrowser.mock.callCount(), 0);
    });
  });

  describe('client header', () => {
    it('reduces the hostname to a safe short label', () => {
      for (const [host, expected] of [
        ['devbox', 'devbox'],
        ['build-01', 'build-01'],
        ['Peters-MacBook-Pro.local', 'Peters-MacBook-Pro'],
        ['web1.eu-west.example.com', 'web1'],
        ["Péter's MacBook Pro", 'P-ter-s-MacBook-Pro'],
        ['  my  laptop  ', 'my-laptop'],
        ['---odd___name---', 'odd-name'],
        ['名前', ''],
        ['', ''],
        ['.local', ''],
      ] as const) {
        assert.equal(hostLabel(host), expected, JSON.stringify(host));
      }
    });

    it('caps the label at 63 characters without a trailing dash', () => {
      assert.equal(hostLabel('a'.repeat(300)), 'a'.repeat(63));
      assert.equal(hostLabel(`${'a'.repeat(62)}-bbb`), 'a'.repeat(62));
    });

    it('sends the version and the computer name in printable ASCII', () => {
      assert.equal(clientHeader('devbox.local', {}), `sevalla-cli/${getVersion()} (devbox)`);
      const header = clientHeader("Péter's MacBook Pro.local", {});
      assert.match(header, /^sevalla-cli\/\S+ \(P-ter-s-MacBook-Pro\)$/);
      assert.match(header, /^[\x20-\x7e]{1,200}$/);
      assert.ok(clientHeader('x'.repeat(1000), {}).length <= 200);
    });

    it('matches the format the dashboard accepts', () => {
      const DASHBOARD_FORMAT =
        /^sevalla-cli\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?: \(([A-Za-z0-9][A-Za-z0-9-]{0,62})\))?$/;
      for (const host of [
        'devbox',
        'Peters-MacBook-Pro.local',
        'web1.eu-west.example.com',
        "Péter's MacBook Pro",
        '-.-a.b',
        'a'.repeat(300),
        `${'b'.repeat(62)}.-x`,
        '名前',
        '',
      ]) {
        const header = clientHeader(host, {});
        assert.match(header, DASHBOARD_FORMAT, JSON.stringify(host));
        assert.ok(!hostLabel(host).includes('.'));
      }
    });

    it('leaves out the computer name when SEVALLA_HIDE_HOSTNAME is set', () => {
      const base = `sevalla-cli/${getVersion()}`;
      assert.equal(clientHeader('devbox', { SEVALLA_HIDE_HOSTNAME: '1' }), base);
      assert.equal(clientHeader('devbox', { SEVALLA_HIDE_HOSTNAME: 'true' }), base);
      assert.equal(clientHeader('devbox', { SEVALLA_HIDE_HOSTNAME: '0' }), `${base} (devbox)`);
      assert.equal(clientHeader('devbox', { SEVALLA_HIDE_HOSTNAME: '' }), `${base} (devbox)`);
    });

    it('leaves out the parentheses when nothing of the name is left', () => {
      assert.match(clientHeader('名前', {}), /^sevalla-cli\/\S+$/);
      assert.match(clientHeader('', {}), /^sevalla-cli\/\S+$/);
    });
  });
});
