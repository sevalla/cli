import chalk from 'chalk';
import open from 'open';
import { ApiClient } from '../client/api-client.ts';
import { saveToken } from './token-store.ts';
import { AUTHORIZE_URL, getBaseUrl, getVersion } from '../helpers/config.ts';
import { SevallaApiError } from '../errors/api-error.ts';
import { SevallaCliError } from '../errors/cli-error.ts';
import { startSpinner, succeedSpinner, failSpinner } from '../output/spinner.ts';

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

const POLL_INTERVAL_MS = 5_000;
const SLOW_DOWN_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 60_000;
const EXPIRED_MESSAGE =
  'Device code expired. Run "sevalla login" again. If you already approved this sign-in, check API keys in the Sevalla dashboard and delete any key you do not use.';

export async function performDeviceFlow(
  apiUrl?: string,
  openBrowser: (url: string) => Promise<unknown> = open,
): Promise<void> {
  const baseUrl = apiUrl ? apiUrl : getBaseUrl();
  const client = new ApiClient({ baseUrl });

  // Step 1: Create device code
  const { user_code, device_code, expires_at, interval } = await client.request<DeviceCode>({
    method: 'POST',
    path: '/auth/device-codes',
    headers: { 'x-sevalla-client': `sevalla-cli/${getVersion()}` },
  });
  if (!user_code || !device_code) {
    throw new SevallaCliError(
      `The API at ${new URL(baseUrl).host} does not support this sign-in flow. Check --api-url or SEVALLA_API_URL, or update the CLI.`,
    );
  }

  // Step 2: Show the code to type and open the authorize page without it
  console.log();
  console.log(chalk.bold('Your sign-in code is:'));
  console.log();
  console.log(`  ${chalk.cyan.bold(user_code)}`);
  console.log();
  console.log(`Type this code on ${chalk.bold(AUTHORIZE_URL)} to approve the sign-in.`);
  console.log(
    chalk.dim(
      `This terminal asked ${new URL(baseUrl).host} for it. Only approve a sign-in you started here, and never type a code someone sent you.`,
    ),
  );
  console.log(chalk.dim('If the browser does not open, visit the URL above manually.'));
  console.log();

  try {
    await openBrowser(AUTHORIZE_URL);
  } catch {
    // Browser open failed, user can do it manually
  }

  // Step 3: Exchange the device code for a token
  startSpinner('Waiting for authorization...');
  const token = await pollDeviceToken(
    client,
    device_code,
    new Date(expires_at).getTime(),
    interval,
  );
  saveToken(token);
  succeedSpinner('Successfully logged in!');
}

export async function pollDeviceToken(
  client: ApiClient,
  deviceCode: string,
  expiresAt: number,
  intervalSeconds?: unknown,
  wait = sleep,
): Promise<string> {
  let intervalMs = Math.max(POLL_INTERVAL_MS, Number(intervalSeconds) * 1000 || POLL_INTERVAL_MS);

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
