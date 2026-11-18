import { makeActionCommand } from '../../../helpers/command-factory.ts';
import { omitValue } from '../../../helpers/secrets.ts';
import { parseBool } from '../../../helpers/validate.ts';

export const envVarsCreateCommand = makeActionCommand<Record<string, unknown>>({
  name: 'create',
  description: 'Create an environment variable',
  idArg: 'app-id',
  options: [
    { flags: '--key <key>', description: 'Variable key', required: true },
    { flags: '--value <value>', description: 'Variable value', required: true },
    { flags: '--runtime <bool>', description: 'Available at runtime (true/false, default true)' },
    {
      flags: '--buildtime <bool>',
      description: 'Available during the build (true/false, default true)',
    },
    {
      flags: '--secret',
      description: 'Make the value write-only: it can be replaced but never read back. Permanent',
    },
  ],
  apiCall: (client, id, opts) => {
    const body: Record<string, unknown> = { key: opts['key'], value: opts['value'] };
    if (opts['runtime'] !== undefined) body['is_runtime'] = parseBool(opts['runtime'], '--runtime');
    if (opts['buildtime'] !== undefined)
      body['is_buildtime'] = parseBool(opts['buildtime'], '--buildtime');
    if (opts['secret']) body['is_secret'] = true;
    return client
      .post<Record<string, unknown>>(`/applications/${id}/env-vars`, body)
      .then(omitValue);
  },
  successMessage: 'Environment variable created.',
});
