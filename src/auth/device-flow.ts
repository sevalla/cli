import chalk from 'chalk';
import open from 'open';
import { ApiClient } from '../client/api-client.ts';
import { saveToken } from './token-store.ts';
import { AUTHORIZE_URL, getBaseUrl } from '../helpers/config.ts';
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

export async function performDeviceFlow(apiUrl?: string): Promise<void> {
  const baseUrl = apiUrl ? apiUrl : getBaseUrl();
  const client = new ApiClient({ baseUrl });

  // Step 1: Create device code
  const { user_code, device_code, expires_at, interval } =
    await client.post<DeviceCode>('/auth/device-codes');

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
    await open(AUTHORIZE_URL);
  } catch {
    // Browser open failed, user can do it manually
  }

  // Step 3: Exchange the device code for a token
  startSpinner('Waiting for authorization...');
  const token = await pollDeviceToken(
    client,
    device_code,
    new Date(expires_at).getTime(),
    interval ? interval * 1000 : POLL_INTERVAL_MS,
  );
  saveToken(token);
  succeedSpinner('Successfully logged in!');
}

export async function pollDeviceToken(
  client: ApiClient,
  deviceCode: string,
  expiresAt: number,
  intervalMs = POLL_INTERVAL_MS,
  wait = sleep,
): Promise<string> {
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
      }
      // Rate limits and network errors during polling - continue
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
        throw new SevallaCliError('Device code expired. Please try again.');

      case 'pending':
        // Continue polling
        break;
    }
  }

  failSpinner('Device code expired');
  throw new SevallaCliError('Device code expired. Please try again.');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
