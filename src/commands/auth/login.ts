import { Command } from 'commander';
import { performDeviceFlow } from '../../auth/device-flow.ts';
import { handleError } from '../../errors/handler.ts';
import { resolveJsonMode } from '../../helpers/flags.ts';
import { isLoggedIn } from '../../auth/token-store.ts';
import { printWarning } from '../../output/formatter.ts';

export function makeLoginCommand(): Command {
  return new Command('login')
    .description('Sign in to Sevalla in your browser')
    .option('--no-browser', 'Type a code on any device instead of opening a browser')
    .addHelpText(
      'after',
      `
Opens your browser to approve the sign-in with one click. Check that the code in the
terminal matches the one in the browser before you approve.

The CLI asks for a code to type instead when you pass --no-browser, over SSH, in CI,
on Linux without a display, or when no browser can be opened. Type that code on
https://app.sevalla.com/authorize from any device.

Examples:
  $ sevalla login
  $ sevalla login --no-browser`,
    )
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const parentOpts = cmd.optsWithGlobals();
      const json = resolveJsonMode(parentOpts);
      try {
        if (isLoggedIn()) {
          printWarning('You are already logged in. Use "sevalla logout" first to switch accounts.');
        }
        await performDeviceFlow(parentOpts['apiUrl'] as string | undefined, undefined, {
          browser: opts['browser'] !== false,
        });
      } catch (error) {
        handleError(error, json);
      }
    });
}
