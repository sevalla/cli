import { makeCreateCommand } from '../../helpers/command-factory.ts';
import { omitValue } from '../../helpers/secrets.ts';

export const globalEnvVarsCreateCommand = makeCreateCommand({
  name: 'create',
  description: 'Create a global environment variable',
  options: [
    { flags: '--key <key>', description: 'Variable key', required: true },
    { flags: '--value <value>', description: 'Variable value', required: true },
    {
      flags: '--secret',
      description: 'Make the value write-only: it can be replaced but never read back. Permanent',
    },
  ],
  displayFields: (item: Record<string, unknown>) => ({
    ID: item['id'],
    Key: item['key'],
  }),
  apiCall: (client, opts) =>
    client
      .post<Record<string, unknown>>('/applications/global-env-vars', {
        key: opts['key'],
        value: opts['value'],
        ...(opts['secret'] ? { is_secret: true } : {}),
      })
      .then(omitValue),
  successMessage: 'Global environment variable created.',
});
