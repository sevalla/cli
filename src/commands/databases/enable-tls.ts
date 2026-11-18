import { makeActionCommand } from '../../helpers/command-factory.ts';

export const databasesEnableTlsCommand = makeActionCommand<{ message: string }>({
  name: 'enable-tls',
  description: 'Turn on TLS for a database on an OCI cluster that was created without it',
  apiCall: (client, id) => client.post(`/databases/${id}/tls/enable`),
  // "started" or "already enabled"; when started, status goes to updating and back to ready
  successMessage: (result) => result.message,
  spinnerText: 'Enabling database TLS...',
  confirm:
    'TLS cannot be turned off again, the database restarts once, and Redis and Valkey external clients must switch to rediss://.',
});
