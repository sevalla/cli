import { request } from 'node:http';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export function httpRequest(
  url: string,
  { method = 'GET', host }: { method?: string; host?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method,
        headers: host ? { host } : {},
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
