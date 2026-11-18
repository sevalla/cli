import { makeCreateCommand } from '../../helpers/command-factory.ts';
import { omitValue } from '../../helpers/secrets.ts';
import { parseBool } from '../../helpers/validate.ts';

export const globalEnvVarsCreateCommand = makeCreateCommand({
  name: 'create',
  description: 'Create a global environment variable',
  options: [
    { flags: '--key <key>', description: 'Variable key', required: true },
    { flags: '--value <value>', description: 'Variable value', required: true },
    { flags: '--runtime <bool>', description: 'Available at runtime (true/false)' },
    { flags: '--buildtime <bool>', description: 'Available during the build (true/false)' },
    {
      flags: '--secret',
      description: 'Make the value write-only: it can be replaced but never read back. Permanent',
    },
  ],
  displayFields: (item: Record<string, unknown>) => ({
    ID: item['id'],
    Key: item['key'],
  }),
  apiCall: (client, opts) => {
    const body: Record<string, unknown> = { key: opts['key'], value: opts['value'] };
    if (opts['runtime'] !== undefined) body['is_runtime'] = parseBool(opts['runtime'], '--runtime');
    if (opts['buildtime'] !== undefined)
      body['is_buildtime'] = parseBool(opts['buildtime'], '--buildtime');
    if (opts['secret']) body['is_secret'] = true;
    return client
      .post<Record<string, unknown>>('/applications/global-env-vars', body)
      .then(omitValue);
  },
  successMessage: 'Global environment variable created.',
});
