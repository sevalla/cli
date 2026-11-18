import { Command } from 'commander';
import { createClient } from '../../../client/api-client.ts';
import { handleError } from '../../../errors/handler.ts';
import { dryRunOption, jsonOption, resolveJsonMode } from '../../../helpers/flags.ts';
import { maskSecrets, omitValue } from '../../../helpers/secrets.ts';
import { parseBool, validateId } from '../../../helpers/validate.ts';
import { printJson, printSuccess } from '../../../output/formatter.ts';
import { startSpinner, stopSpinner } from '../../../output/spinner.ts';

export const envVarsUpdateCommand = new Command('update')
  .description('Update an environment variable')
  .requiredOption('--app-id <id>', 'Application ID')
  .argument('<env-var-id>', 'Environment variable ID')
  .option('--key <key>', 'Variable key')
  .option('--value <value>', 'Variable value')
  .option('--runtime <bool>', 'Available at runtime (true/false)')
  .option('--buildtime <bool>', 'Available during the build (true/false)')
  .option(
    '--secret',
    'Make the value write-only: it can be replaced but never read back. Permanent',
  )
  .addOption(jsonOption())
  .addOption(dryRunOption())
  .action(async (envVarId: string, opts: Record<string, unknown>) => {
    const client = createClient({ apiUrl: opts['apiUrl'] as string | undefined });
    const json = resolveJsonMode(opts);
    try {
      validateId(opts['appId'] as string, 'app-id');
      validateId(envVarId, 'env-var-id');
      const body: Record<string, unknown> = {};
      if (opts['key']) body['key'] = opts['key'];
      if (opts['value']) body['value'] = opts['value'];
      if (opts['runtime'] !== undefined)
        body['is_runtime'] = parseBool(opts['runtime'], '--runtime');
      if (opts['buildtime'] !== undefined)
        body['is_buildtime'] = parseBool(opts['buildtime'], '--buildtime');
      if (opts['secret']) body['is_secret'] = true;
      const path = `/applications/${opts['appId']}/env-vars/${envVarId}`;
      if (opts['dryRun']) {
        printJson({
          dry_run: true,
          command: 'update',
          method: 'PUT',
          path,
          body: maskSecrets(body),
        });
        return;
      }
      if (!json) startSpinner('Updating...');
      const result = await client.put<Record<string, unknown>>(path, body);
      stopSpinner();
      if (json) {
        printJson(omitValue(result));
      } else {
        printSuccess('Environment variable updated.');
      }
    } catch (error) {
      stopSpinner();
      handleError(error, json);
    }
  });
