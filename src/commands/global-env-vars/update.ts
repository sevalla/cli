import { makeUpdateCommand } from '../../helpers/command-factory.ts';
import { omitValue } from '../../helpers/secrets.ts';
import { parseBool } from '../../helpers/validate.ts';

export const globalEnvVarsUpdateCommand = makeUpdateCommand({
  name: 'update',
  description: 'Update a global environment variable',
  options: [
    { flags: '--key <key>', description: 'Variable key' },
    { flags: '--value <value>', description: 'Variable value' },
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
  apiCall: (client, id, opts) => {
    const body: Record<string, unknown> = {};
    if (opts['key']) body['key'] = opts['key'];
    if (opts['value']) body['value'] = opts['value'];
    if (opts['runtime'] !== undefined) body['is_runtime'] = parseBool(opts['runtime'], '--runtime');
    if (opts['buildtime'] !== undefined)
      body['is_buildtime'] = parseBool(opts['buildtime'], '--buildtime');
    if (opts['secret']) body['is_secret'] = true;
    return client
      .put<Record<string, unknown>>(`/applications/global-env-vars/${id}`, body)
      .then(omitValue);
  },
});
