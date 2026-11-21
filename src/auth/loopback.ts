import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';

export type CallbackPage = 'success' | 'denied' | 'failed';

export interface LoopbackServer {
  callbackUrl: string;
  close(): Promise<void>;
}

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  Connection: 'close',
};

// Listens on 127.0.0.1 for the browser to come back after the sign-in is approved or denied.
// Only GET on /callback/<random nonce> is answered; everything else is a bare 404.
export async function startLoopbackServer(
  onCallback: (query: URLSearchParams) => Promise<CallbackPage>,
): Promise<LoopbackServer> {
  const nonce = randomBytes(24).toString('base64url');
  const path = `/callback/${nonce}`;
  let port = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // The Host check stops pages on other origins that resolve to 127.0.0.1 from reaching us.
    if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${port}` || url.pathname !== path) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Length': '0' }).end();
      return;
    }

    let page: CallbackPage = 'failed';
    try {
      page = await onCallback(url.searchParams);
    } catch {
      // Show the "didn't work" page and keep waiting for a valid callback
    }
    const html = renderPage(page);
    res
      .writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
      })
      .end(html);
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;

  return {
    callbackUrl: `http://127.0.0.1:${port}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        // Responses send Connection: close, so give the last page a moment to flush first.
        const force = setTimeout(() => server.closeAllConnections(), 1_000);
        force.unref();
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
      }),
  };
}

const PAGES: Record<CallbackPage, { title: string; message: string; icon: string }> = {
  success: {
    title: "You're signed in to Sevalla",
    message: 'You can close this tab and return to your terminal.',
    icon: '<path d="M7 12.5l3.2 3.2L17 9"/>',
  },
  denied: {
    title: 'Sign-in denied',
    message: 'The CLI was not signed in. You can close this tab.',
    icon: '<path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/>',
  },
  failed: {
    title: "That link didn't work",
    message: 'Return to your terminal to finish signing in.',
    icon: '<path d="M12 7.5v5.5M12 16.5v.01"/>',
  },
};

export function renderPage(page: CallbackPage): string {
  const { title, message, icon } = PAGES[page];
  const accent = page === 'success' ? '#ff5f00' : '#71717a';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - Sevalla CLI</title>
<style>
:root { color-scheme: light dark; --bg: #fafafa; --card: #fff; --text: #18181b; --muted: #52525b; --border: #e4e4e7; }
@media (prefers-color-scheme: dark) { :root { --bg: #09090b; --card: #18181b; --text: #fafafa; --muted: #a1a1aa; --border: #27272a; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { width: 100%; max-width: 440px; padding: 40px 32px; text-align: center; background: var(--card); border: 1px solid var(--border); border-top: 3px solid ${accent}; border-radius: 12px; }
svg { width: 48px; height: 48px; color: ${accent}; }
h1 { margin: 16px 0 8px; font-size: 20px; font-weight: 600; }
p { margin: 0; color: var(--muted); }
.brand { margin-top: 24px; font-size: 13px; color: var(--muted); }
</style>
</head>
<body>
<main>
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/>${icon}</svg>
<h1>${title}</h1>
<p>${message}</p>
<p class="brand">Sevalla CLI</p>
</main>
</body>
</html>
`;
}
