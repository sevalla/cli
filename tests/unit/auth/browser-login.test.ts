import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  exchange: (secret: unknown) => Response,
  expiresAt = Date.now() + 300_000,
): ApiCall[] {
  const calls: ApiCall[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    if (url.endsWith('/auth/device-codes')) {
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

function startLogin() {
  let opened!: (url: string) => void;
  const openedUrl = new Promise<string>((resolve) => (opened = resolve));
  const openBrowser = mock.fn(async (url: string) => opened(url));
  const login = performDeviceFlow('https://api.test.com', openBrowser, DESKTOP);
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

  it('exits with code 1 when the sign-in is denied', async () => {
    const calls = fakeApi(approveWith(APPROVAL_SECRET));
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
});
