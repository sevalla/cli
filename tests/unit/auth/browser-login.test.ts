import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { httpRequest } from './http-request.ts';

// The CLI saves credentials under the home directory, so point it at a throwaway one
const home = mkdtempSync(join(tmpdir(), 'sevalla-login-'));
process.env['HOME'] = home;
const { performDeviceFlow, headlessReason } = await import('../../../src/auth/device-flow.ts');
const { SevallaCliError } = await import('../../../src/errors/cli-error.ts');

const DEVICE_CODE = 'kT3n9cQ0yVZr8mWbH1sLx4aPqE6uJ2dFgN7oRtYvS5w';
const APPROVAL_SECRET = 'Qm9vdHN0cmFwU2VjcmV0VmFsdWVGb3JUZXN0cw';
const USER_CODE = 'ABCD-1234';
const DESKTOP = { env: {}, platform: 'darwin' as const };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface ApiCall {
  url: string;
  body: Record<string, unknown> | undefined;
}

// Fakes the API: answers the token exchange with `exchange(secret)` and records every call
function fakeApi(
  exchange: (secret: unknown) => Response | Promise<Response>,
  expiresAt = Date.now() + 300_000,
  create?: (body: Record<string, unknown> | undefined) => Response | undefined,
): ApiCall[] {
  const calls: ApiCall[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    if (url.endsWith('/auth/device-codes')) {
      const override = create?.(body);
      if (override) return override;
      return jsonResponse(
        {
          user_code: USER_CODE,
          device_code: DEVICE_CODE,
          expires_at: new Date(expiresAt).toISOString(),
        },
        201,
      );
    }
    return exchange(body?.approval_secret);
  }) as typeof fetch;
  return calls;
}

function approveWith(secret: string) {
  return (given: unknown) =>
    given === secret
      ? jsonResponse({ status: 'approved', token: 'svl_browser_token' })
      : jsonResponse({ status: 'pending' });
}

function captureOutput() {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
    return true;
  };
  mock.method(console, 'log', record);
  mock.method(console, 'error', record);
  mock.method(process.stderr, 'write', record);
  return () => lines.join('\n');
}

function startLogin(pollWait?: (ms: number, signal: AbortSignal) => Promise<unknown>) {
  let opened!: (url: string) => void;
  const openedUrl = new Promise<string>((resolve) => (opened = resolve));
  const openBrowser = mock.fn(async (url: string) => opened(url));
  const login = performDeviceFlow('https://api.test.com', openBrowser, { ...DESKTOP, pollWait });
  return { login, openedUrl, openBrowser };
}

function callbackUrl(calls: ApiCall[]): string {
  return calls[0]!.body!['callback_url'] as string;
}

describe('Browser sign-in', () => {
  const originalFetch = globalThis.fetch;
  let output: () => string;

  beforeEach(() => {
    rmSync(join(home, '.config'), { recursive: true, force: true });
    output = captureOutput();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  describe('flow selection', () => {
    it('uses the browser on a desktop', () => {
      assert.equal(headlessReason({ env: {}, platform: 'darwin' }), null);
      assert.equal(headlessReason({ env: {}, platform: 'win32' }), null);
      assert.equal(headlessReason({ env: { DISPLAY: ':0' }, platform: 'linux' }), null);
      assert.equal(
        headlessReason({ env: { WAYLAND_DISPLAY: 'wayland-0' }, platform: 'linux' }),
        null,
      );
    });

    it('types a code for each headless signal', () => {
      for (const environment of [
        { browser: false, env: {}, platform: 'darwin' as const },
        { env: { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 51234' }, platform: 'darwin' as const },
        { env: { SSH_TTY: '/dev/ttys001' }, platform: 'darwin' as const },
        { env: { CI: 'true' }, platform: 'darwin' as const },
        { env: {}, platform: 'linux' as const },
      ]) {
        assert.ok(headlessReason(environment), JSON.stringify(environment));
      }
    });

    it('does not open a browser or send a callback with --no-browser', async () => {
      const calls = fakeApi(() => jsonResponse({ status: 'expired' }), Date.now() - 1);
      const openBrowser = mock.fn(async () => {});

      await assert.rejects(
        performDeviceFlow('https://api.test.com', openBrowser, { ...DESKTOP, browser: false }),
        /expired/,
      );

      assert.equal(openBrowser.mock.callCount(), 0);
      assert.equal(calls[0]!.body, undefined);
      assert.match(output(), /ABCD-1234/);
    });

    it('falls back to typing a code when the browser does not open', async () => {
      const calls = fakeApi(() => jsonResponse({ status: 'expired' }), Date.now() - 1);
      const openBrowser = mock.fn(async () => {
        throw new Error('no browser');
      });

      await assert.rejects(
        performDeviceFlow('https://api.test.com', openBrowser, DESKTOP),
        /expired/,
      );

      const firstCallback = callbackUrl(calls);
      assert.equal(openBrowser.mock.callCount(), 1);
      assert.equal(calls[1]!.url, 'https://api.test.com/auth/device-codes');
      assert.equal(calls[1]!.body, undefined);
      assert.match(output(), /Couldn't open a browser/);
      assert.equal(output().match(/ABCD-1234/g)?.length, 1);
      assert.doesNotMatch(output(), /Confirm the code/);
      await assert.rejects(httpRequest(firstCallback), /ECONNREFUSED/);
    });
  });

  it('opens the authorize page with the code and signs in with the approval secret', async () => {
    const calls = fakeApi(approveWith(APPROVAL_SECRET));
    const { login, openedUrl } = startLogin();

    assert.equal(await openedUrl, 'https://app.sevalla.com/authorize#code=ABCD-1234');
    const url = callbackUrl(calls);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/callback\/[A-Za-z0-9_-]{32}$/);

    const reply = await httpRequest(`${url}?approval_secret=${APPROVAL_SECRET}`);
    assert.match(reply.body, /You're signed in to Sevalla/);
    await login;

    assert.deepEqual(calls[1], {
      url: 'https://api.test.com/auth/device-codes/token',
      body: { device_code: DEVICE_CODE, approval_secret: APPROVAL_SECRET },
    });
    const saved = JSON.parse(readFileSync(join(home, '.config/sevalla/credentials.json'), 'utf8'));
    assert.equal(saved.token, 'svl_browser_token');
    assert.match(output(), /Confirm the code .*ABCD-1234.* matches/);
    assert.match(output(), /Signed in/);
    await assert.rejects(httpRequest(url), /ECONNREFUSED/);
  });

  it('keeps waiting after a wrong secret or an empty callback', async () => {
    const calls = fakeApi(approveWith(APPROVAL_SECRET));
    const { login, openedUrl } = startLogin();
    await openedUrl;
    const url = callbackUrl(calls);

    assert.match(
      (await httpRequest(`${url}?approval_secret=forged`)).body,
      /That link didn't work/,
    );
    assert.match((await httpRequest(url)).body, /That link didn't work/);
    assert.match(
      (await httpRequest(`${url}?approval_secret=${APPROVAL_SECRET}`)).body,
      /signed in/,
    );
    await login;
  });

  it('ignores a denial the API does not confirm and keeps waiting', async () => {
    const calls = fakeApi(approveWith(APPROVAL_SECRET));
    const { login, openedUrl } = startLogin();
    await openedUrl;
    const url = callbackUrl(calls);

    assert.match((await httpRequest(`${url}?error=access_denied`)).body, /That link didn't work/);
    assert.deepEqual(calls[1]!.body, { device_code: DEVICE_CODE });
    assert.match(
      (await httpRequest(`${url}?approval_secret=${APPROVAL_SECRET}`)).body,
      /signed in/,
    );
    await login;
  });

  it('exits with code 1 when the sign-in is denied', async () => {
    const calls = fakeApi((given) =>
      jsonResponse({ status: given === undefined ? 'denied' : 'pending' }),
    );
    const { login, openedUrl } = startLogin();
    await openedUrl;

    const denied = assert.rejects(login, (error: Error) => {
      assert.ok(error instanceof SevallaCliError);
      assert.equal(error.exitCode, 1);
      assert.match(error.message, /Sign-in was denied/);
      return true;
    });
    const reply = await httpRequest(`${callbackUrl(calls)}?error=access_denied`);
    assert.match(reply.body, /Sign-in denied/);
    await denied;
  });

  it('stops listening and suggests --no-browser when the code expires', async () => {
    const calls = fakeApi(approveWith(APPROVAL_SECRET), Date.now() + 200);
    const { login, openedUrl } = startLogin();
    await openedUrl;

    await assert.rejects(login, /expired.*sevalla login --no-browser/);
    await assert.rejects(httpRequest(callbackUrl(calls)), /ECONNREFUSED/);
  });

  it('never prints the device code or the approval secret', async () => {
    const calls = fakeApi(approveWith(APPROVAL_SECRET));
    const { login, openedUrl } = startLogin();
    await openedUrl;
    await httpRequest(`${callbackUrl(calls)}?approval_secret=wrong-${APPROVAL_SECRET}`);
    await httpRequest(`${callbackUrl(calls)}?approval_secret=${APPROVAL_SECRET}`);
    await login;

    const printed = output();
    assert.ok(printed.includes(USER_CODE));
    assert.ok(!printed.includes(DEVICE_CODE));
    assert.ok(!printed.includes(APPROVAL_SECRET));
  });

  describe('polling alongside the callback', () => {
    it('signs in through the poll when the API releases the key without the secret', async () => {
      const calls = fakeApi((given) =>
        given === undefined
          ? jsonResponse({ status: 'approved', token: 'svl_from_poll' })
          : jsonResponse({ status: 'pending' }),
      );
      const { login, openedUrl } = startLogin(async () => {});
      await openedUrl;
      await login;

      assert.deepEqual(calls[1], {
        url: 'https://api.test.com/auth/device-codes/token',
        body: { device_code: DEVICE_CODE },
      });
      const saved = JSON.parse(
        readFileSync(join(home, '.config/sevalla/credentials.json'), 'utf8'),
      );
      assert.equal(saved.token, 'svl_from_poll');
      await assert.rejects(httpRequest(callbackUrl(calls)), /ECONNREFUSED/);
    });

    it('ends the flow when the poll reports a denial', async () => {
      fakeApi((given) => jsonResponse({ status: given === undefined ? 'denied' : 'pending' }));
      const { login } = startLogin(async () => {});
      await assert.rejects(login, /Sign-in was denied/);
    });

    it('keeps only the first result when the callback wins and the poll returns a key later', async () => {
      let pollStarted!: () => void;
      const pollInFlight = new Promise<void>((resolve) => (pollStarted = resolve));
      let releasePoll!: () => void;
      const pollGate = new Promise<void>((resolve) => (releasePoll = resolve));
      const calls = fakeApi(async (given) => {
        if (given === undefined) {
          pollStarted();
          await pollGate;
          return jsonResponse({ status: 'approved', token: 'svl_from_poll' });
        }
        return jsonResponse({ status: 'approved', token: 'svl_from_callback' });
      });
      let waits = 0;
      const { login, openedUrl } = startLogin((ms, signal) =>
        waits++ === 0 ? Promise.resolve() : delay(ms, undefined, { signal }),
      );
      await openedUrl;
      await pollInFlight;

      const reply = await httpRequest(`${callbackUrl(calls)}?approval_secret=${APPROVAL_SECRET}`);
      assert.match(reply.body, /You're signed in to Sevalla/);
      await login;
      releasePoll();
      await delay(20);

      const saved = JSON.parse(
        readFileSync(join(home, '.config/sevalla/credentials.json'), 'utf8'),
      );
      assert.equal(saved.token, 'svl_from_callback');
      assert.equal(output().match(/Signed in/g)?.length, 1);
      assert.equal(waits, 1);
    });

    it('lets an in-flight exchange decide when the poll sees the code expire', async () => {
      let exchangeStarted!: () => void;
      const exchangeInFlight = new Promise<void>((resolve) => (exchangeStarted = resolve));
      let releaseExchange!: () => void;
      const exchangeGate = new Promise<void>((resolve) => (releaseExchange = resolve));
      let pollAnswered!: () => void;
      const pollDone = new Promise<void>((resolve) => (pollAnswered = resolve));
      let startPoll!: () => void;
      const pollGo = new Promise<void>((resolve) => (startPoll = resolve));

      const calls = fakeApi(async (given) => {
        if (given === undefined) {
          pollAnswered();
          return jsonResponse({ status: 'expired' });
        }
        exchangeStarted();
        await exchangeGate;
        return jsonResponse({ status: 'approved', token: 'svl_from_callback' });
      });
      let waits = 0;
      const { login, openedUrl } = startLogin((ms, signal) =>
        waits++ === 0 ? pollGo : delay(ms, undefined, { signal }),
      );
      await openedUrl;

      const reply = httpRequest(`${callbackUrl(calls)}?approval_secret=${APPROVAL_SECRET}`);
      await exchangeInFlight;
      startPoll();
      await pollDone;
      await delay(20);
      releaseExchange();

      assert.match((await reply).body, /You're signed in to Sevalla/);
      await login;
      const saved = JSON.parse(
        readFileSync(join(home, '.config/sevalla/credentials.json'), 'utf8'),
      );
      assert.equal(saved.token, 'svl_from_callback');
    });

    it('saves the key when the code expires while the exchange is in flight', async () => {
      let exchangeStarted!: () => void;
      const exchangeInFlight = new Promise<void>((resolve) => (exchangeStarted = resolve));
      let releaseExchange!: () => void;
      const exchangeGate = new Promise<void>((resolve) => (releaseExchange = resolve));
      const calls = fakeApi(async (given) => {
        if (given === undefined) return jsonResponse({ status: 'pending' });
        exchangeStarted();
        await exchangeGate;
        return jsonResponse({ status: 'approved', token: 'svl_from_callback' });
      }, Date.now() + 150);
      const { login, openedUrl } = startLogin();
      await openedUrl;

      const reply = httpRequest(`${callbackUrl(calls)}?approval_secret=${APPROVAL_SECRET}`);
      await exchangeInFlight;
      await delay(250);
      releaseExchange();

      assert.match((await reply).body, /You're signed in to Sevalla/);
      await login;
      const saved = JSON.parse(
        readFileSync(join(home, '.config/sevalla/credentials.json'), 'utf8'),
      );
      assert.equal(saved.token, 'svl_from_callback');
    });

    it('exchanges the secret once when two callbacks arrive together', async () => {
      let exchanges = 0;
      const calls = fakeApi(async (given) => {
        if (given === undefined) return jsonResponse({ status: 'pending' });
        exchanges += 1;
        await delay(10);
        return exchanges === 1
          ? jsonResponse({ status: 'approved', token: 'svl_first' })
          : jsonResponse({ status: 'expired' });
      });
      const { login, openedUrl } = startLogin();
      await openedUrl;

      const url = `${callbackUrl(calls)}?approval_secret=${APPROVAL_SECRET}`;
      const replies = await Promise.all([httpRequest(url), httpRequest(url)]);
      await login;

      assert.equal(exchanges, 1);
      for (const reply of replies) assert.match(reply.body, /You're signed in to Sevalla/);
      const saved = JSON.parse(
        readFileSync(join(home, '.config/sevalla/credentials.json'), 'utf8'),
      );
      assert.equal(saved.token, 'svl_first');
      assert.equal(output().match(/Signed in/g)?.length, 1);
    });

    it('falls back to typing a code when the API rejects callback_url', async () => {
      const calls = fakeApi(
        () => jsonResponse({ status: 'expired' }),
        Date.now() - 1,
        (body) =>
          body?.['callback_url']
            ? jsonResponse({ message: 'Invalid callback_url', status: 400, data: {} }, 400)
            : undefined,
      );
      const openBrowser = mock.fn(async (_url: string) => {});

      await assert.rejects(
        performDeviceFlow('https://api.test.com', openBrowser, DESKTOP),
        /expired/,
      );

      assert.ok(calls[0]!.body?.['callback_url']);
      assert.equal(calls[1]!.url, 'https://api.test.com/auth/device-codes');
      assert.equal(calls[1]!.body, undefined);
      assert.deepEqual(
        openBrowser.mock.calls.map((call) => call.arguments[0]),
        ['https://app.sevalla.com/authorize'],
      );
      assert.match(output(), /ABCD-1234/);
      await assert.rejects(httpRequest(calls[0]!.body!['callback_url'] as string), /ECONNREFUSED/);
    });
  });
});
