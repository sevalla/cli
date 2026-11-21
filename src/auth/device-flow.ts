import chalk from 'chalk';
import open from 'open';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiClient } from '../client/api-client.ts';
import { saveToken } from './token-store.ts';
import { startLoopbackServer } from './loopback.ts';
import { AUTHORIZE_URL, getBaseUrl, getVersion } from '../helpers/config.ts';
import { SevallaApiError } from '../errors/api-error.ts';
import { SevallaCliError } from '../errors/cli-error.ts';
import { startSpinner, stopSpinner, succeedSpinner, failSpinner } from '../output/spinner.ts';

interface DeviceCode {
  user_code: string;
  // Secret that collects the token: never print it, log it or put it in a URL.
  device_code: string;
  expires_at: string;
  interval?: number;
}

interface DeviceCodeStatus {
  status: 'pending' | 'approved' | 'denied' | 'expired';
  token?: string;
}

export interface LoginEnvironment {
  browser?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pollWait?: (ms: number, signal: AbortSignal) => Promise<unknown>;
}

type OpenBrowser = (url: string) => Promise<unknown>;
type BrowserOutcome = 'signed-in' | 'denied' | 'expired' | Error;

const POLL_INTERVAL_MS = 5_000;
const SLOW_DOWN_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const EXCHANGE_ATTEMPTS = 3;
const EXPIRED_MESSAGE =
  'Device code expired. Run "sevalla login" again. If you already approved this sign-in, check API keys in the Sevalla dashboard and delete any key you do not use.';

// Why the one-click browser flow can't work here, or null when it can.
export function headlessReason({
  browser = true,
  env = process.env,
  platform = process.platform,
}: LoginEnvironment = {}): string | null {
  if (!browser) return '--no-browser';
  if (env['SSH_CONNECTION'] || env['SSH_TTY']) return 'This looks like an SSH session';
  if (env['CI']) return 'This looks like a CI environment';
  if (platform === 'linux' && !env['DISPLAY'] && !env['WAYLAND_DISPLAY']) {
    return 'No graphical display was found';
  }
  return null;
}

export async function performDeviceFlow(
  apiUrl?: string,
  openBrowser: OpenBrowser = openInBrowser,
  environment: LoginEnvironment = {},
): Promise<void> {
  const baseUrl = apiUrl ? apiUrl : getBaseUrl();
  const client = new ApiClient({ baseUrl });

  const reason = headlessReason(environment);
  if (reason === '--no-browser') return performTypedFlow(client, baseUrl, null);
  if (reason) {
    return performTypedFlow(client, baseUrl, null, `${reason}, so sign in with a code instead.`);
  }

  const fallback = await performBrowserFlow(
    client,
    baseUrl,
    openBrowser,
    environment.pollWait ?? ((ms, signal) => delay(ms, undefined, { signal })),
  );
  if (fallback === 'no-listener') {
    return performTypedFlow(
      client,
      baseUrl,
      openBrowser,
      "Couldn't start the local sign-in listener, so sign in with a code instead.",
    );
  }
  if (fallback === 'no-callback') return performTypedFlow(client, baseUrl, openBrowser);
  if (fallback === 'no-browser') {
    return performTypedFlow(
      client,
      baseUrl,
      null,
      "Couldn't open a browser, so sign in with a code instead.",
    );
  }
}

async function createDeviceCode(
  client: ApiClient,
  baseUrl: string,
  body?: { callback_url: string },
): Promise<DeviceCode> {
  const code = await client.request<DeviceCode>({
    method: 'POST',
    path: '/auth/device-codes',
    headers: { 'x-sevalla-client': `sevalla-cli/${getVersion()}` },
    body,
  });
  if (!code?.user_code || !code.device_code) {
    throw new SevallaCliError(
      `The API at ${new URL(baseUrl).host} does not support this sign-in flow. Check --api-url or SEVALLA_API_URL, or update the CLI.`,
    );
  }
  return code;
}

async function performBrowserFlow(
  client: ApiClient,
  baseUrl: string,
  openBrowser: OpenBrowser,
  pollWait: (ms: number, signal: AbortSignal) => Promise<unknown>,
): Promise<'no-listener' | 'no-callback' | 'no-browser' | null> {
  let deviceCode: string | null = null;
  let settledWith: BrowserOutcome | null = null;
  let resolveOutcome: (outcome: BrowserOutcome) => void = () => {};
  const outcome = new Promise<BrowserOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const stopPolling = new AbortController();

  // The callback and the poll race: the first result wins and the other is ignored.
  const finish = (result: BrowserOutcome) => {
    if (settledWith) return;
    settledWith = result;
    stopPolling.abort();
    resolveOutcome(result);
  };
  const signIn = (token: string) => {
    if (settledWith) return;
    try {
      saveToken(token);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    finish('signed-in');
  };

  // An API that doesn't bind codes to the callback hands the key to a plain poll, so poll too.
  const poll = async (code: DeviceCode) => {
    let intervalMs = pollIntervalMs(code.interval);
    try {
      while (!settledWith) {
        await pollWait(intervalMs, stopPolling.signal);
        let result: DeviceCodeStatus;
        try {
          result = await client.post<DeviceCodeStatus>('/auth/device-codes/token', {
            device_code: code.device_code,
          });
        } catch (error) {
          if (error instanceof SevallaApiError && error.status === 429) {
            intervalMs = Math.min(intervalMs + SLOW_DOWN_MS, MAX_POLL_INTERVAL_MS);
          } else if (error instanceof SevallaApiError && error.status < 500) {
            return;
          }
          continue;
        }
        if (result.status === 'approved' && result.token) signIn(result.token);
        else if (result.status === 'denied' || result.status === 'expired') finish(result.status);
      }
    } catch {
      // Aborted once the callback settled the sign-in
    }
  };

  let server;
  try {
    server = await startLoopbackServer(async (query) => {
      if (!deviceCode) return 'failed';
      if (query.get('error') === 'access_denied') {
        finish('denied');
        return 'denied';
      }
      const approvalSecret = query.get('approval_secret');
      if (!approvalSecret) return 'failed';

      const result = await exchangeApprovalSecret(client, deviceCode, approvalSecret);
      if (result?.status === 'approved' && result.token) {
        signIn(result.token);
        return settledWith === 'signed-in' ? 'success' : 'failed';
      }
      if (result?.status === 'denied') {
        finish('denied');
        return 'denied';
      }
      if (result?.status === 'expired') finish('expired');
      // A wrong or reused secret: keep listening for the real callback until the code expires
      return 'failed';
    });
  } catch {
    return 'no-listener';
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    let code: DeviceCode;
    try {
      code = await createDeviceCode(client, baseUrl, { callback_url: server.callbackUrl });
    } catch (error) {
      // An API that refuses callback_url still signs in with a typed code
      if (error instanceof SevallaApiError && error.status === 400) return 'no-callback';
      throw error;
    }
    const authorizeUrl = `${AUTHORIZE_URL}#code=${encodeURIComponent(code.user_code)}`;

    deviceCode = code.device_code;
    try {
      await openBrowser(authorizeUrl);
    } catch {
      return 'no-browser';
    }

    console.log();
    console.log('Opening your browser to sign in...');
    console.log(
      `Confirm the code ${chalk.cyan.bold(code.user_code)} matches the one in your browser.`,
    );
    console.log();
    console.log(chalk.dim("If your browser didn't open, go to:"));
    console.log(chalk.dim(`  ${authorizeUrl}`));
    console.log(
      chalk.dim('Browser on another machine? Press Ctrl+C and run "sevalla login --no-browser".'),
    );
    console.log();

    const expiresInMs = new Date(code.expires_at).getTime() - Date.now();
    timer = setTimeout(
      () => finish('expired'),
      Math.min(Math.max(expiresInMs, 0) || 0, MAX_TIMEOUT_MS),
    );

    startSpinner('Waiting for you to approve in your browser...');
    void poll(code);
    const result = await outcome;
    if (result instanceof Error) {
      failSpinner('Sign-in failed');
      throw result;
    }
    if (result === 'signed-in') {
      succeedSpinner('Signed in');
      return null;
    }
    stopSpinner();
    if (result === 'denied') throw new SevallaCliError('Sign-in was denied.');
    throw new SevallaCliError(
      'The sign-in request expired before it was approved. Run "sevalla login" to try again, or "sevalla login --no-browser" if your browser is on another machine.',
    );
  } finally {
    clearTimeout(timer);
    stopPolling.abort();
    stopSpinner();
    await server.close();
  }
}

async function exchangeApprovalSecret(
  client: ApiClient,
  deviceCode: string,
  approvalSecret: string,
): Promise<DeviceCodeStatus | null> {
  for (let attempt = 1; attempt <= EXCHANGE_ATTEMPTS; attempt++) {
    try {
      return await client.post<DeviceCodeStatus>('/auth/device-codes/token', {
        device_code: deviceCode,
        approval_secret: approvalSecret,
      });
    } catch (error) {
      if (error instanceof SevallaApiError && error.status < 500 && error.status !== 429) {
        return null;
      }
      if (attempt < EXCHANGE_ATTEMPTS) await sleep(attempt * 1_000);
    }
  }
  return null;
}

async function performTypedFlow(
  client: ApiClient,
  baseUrl: string,
  openBrowser: OpenBrowser | null,
  note?: string,
): Promise<void> {
  const { user_code, device_code, expires_at, interval } = await createDeviceCode(client, baseUrl);

  console.log();
  if (note) {
    console.log(chalk.dim(note));
    console.log();
  }
  console.log(chalk.bold('Your sign-in code is:'));
  console.log();
  console.log(`  ${chalk.cyan.bold(user_code)}`);
  console.log();
  console.log(
    `Type this code on ${chalk.bold(AUTHORIZE_URL)} to approve the sign-in. Any device works.`,
  );
  console.log(
    chalk.dim(
      `This terminal asked ${new URL(baseUrl).host} for it. Only approve a sign-in you started here, and never type a code someone sent you.`,
    ),
  );
  console.log();

  if (openBrowser) {
    try {
      await openBrowser(AUTHORIZE_URL);
    } catch {
      // The URL is printed above, so the user can open it themselves
    }
  }

  startSpinner('Waiting for authorization...');
  const token = await pollDeviceToken(
    client,
    device_code,
    new Date(expires_at).getTime(),
    interval,
  );
  saveToken(token);
  succeedSpinner('Signed in');
}

// open() resolves before the opener runs, so wait briefly for it to fail (no browser, no xdg-open).
export async function openInBrowser(url: string): Promise<void> {
  const child = await open(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 500);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code) reject(new Error(`The browser opener exited with code ${code}`));
      else resolve();
    });
  });
}

export async function pollDeviceToken(
  client: ApiClient,
  deviceCode: string,
  expiresAt: number,
  intervalSeconds?: unknown,
  wait = sleep,
): Promise<string> {
  let intervalMs = pollIntervalMs(intervalSeconds);

  while (Date.now() < expiresAt) {
    await wait(intervalMs);

    let result: DeviceCodeStatus;
    try {
      result = await client.post<DeviceCodeStatus>('/auth/device-codes/token', {
        device_code: deviceCode,
      });
    } catch (error) {
      if (error instanceof SevallaApiError && error.status === 429) {
        intervalMs = Math.min(intervalMs + SLOW_DOWN_MS, MAX_POLL_INTERVAL_MS);
      } else if (error instanceof SevallaApiError && error.status < 500) {
        failSpinner('Authorization failed');
        throw new SevallaCliError(
          `Sign-in failed: the API rejected the request (HTTP ${error.status}). Run "sevalla login" again.`,
        );
      }
      // Rate limits, server and network errors during polling - continue
      continue;
    }

    switch (result.status) {
      case 'approved':
        if (!result.token) {
          failSpinner('Authorization failed');
          throw new SevallaCliError('Approved but no token received');
        }
        return result.token;

      case 'denied':
        failSpinner('Authorization denied');
        throw new SevallaCliError('Authorization request was denied');

      case 'expired':
        failSpinner('Device code expired');
        throw new SevallaCliError(EXPIRED_MESSAGE);

      case 'pending':
        // Continue polling
        break;
    }
  }

  failSpinner('Device code expired');
  throw new SevallaCliError(EXPIRED_MESSAGE);
}

function pollIntervalMs(intervalSeconds: unknown): number {
  return Math.min(
    MAX_POLL_INTERVAL_MS,
    Math.max(POLL_INTERVAL_MS, Number(intervalSeconds) * 1000 || POLL_INTERVAL_MS),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
