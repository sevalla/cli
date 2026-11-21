import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { httpRequest } from './http-request.ts';
import { startLoopbackServer, renderPage } from '../../../src/auth/loopback.ts';
import type { LoopbackServer } from '../../../src/auth/loopback.ts';

describe('Loopback server', () => {
  let server: LoopbackServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('listens on 127.0.0.1 with a random port and a 32-character base64url nonce', async () => {
    server = await startLoopbackServer(async () => 'success');
    const url = new URL(server.callbackUrl);
    assert.equal(url.protocol, 'http:');
    assert.equal(url.hostname, '127.0.0.1');
    assert.ok(Number(url.port) >= 1024);
    assert.match(url.pathname, /^\/callback\/[A-Za-z0-9_-]{32}$/);
    assert.ok(server.callbackUrl.length <= 120);
  });

  it('answers GET on the exact callback path with the page and strict headers', async () => {
    const queries: string[] = [];
    server = await startLoopbackServer(async (query) => {
      queries.push(query.toString());
      return 'success';
    });

    const reply = await httpRequest(`${server.callbackUrl}?approval_secret=abc`);

    assert.equal(reply.status, 200);
    assert.match(reply.body, /You're signed in to Sevalla/);
    assert.equal(reply.headers['cache-control'], 'no-store');
    assert.equal(reply.headers['referrer-policy'], 'no-referrer');
    assert.match(
      String(reply.headers['content-security-policy']),
      /^default-src 'none'; style-src 'unsafe-inline'/,
    );
    assert.match(String(reply.headers['content-type']), /^text\/html/);
    assert.deepEqual(queries, ['approval_secret=abc']);
  });

  it('returns a bare 404 for any other path, method or host', async () => {
    let calls = 0;
    server = await startLoopbackServer(async () => {
      calls += 1;
      return 'success';
    });
    const { origin, pathname } = new URL(server.callbackUrl);

    for (const reply of [
      await httpRequest(`${origin}/`),
      await httpRequest(`${origin}/callback/`),
      await httpRequest(`${origin}/callback/wrong-nonce-wrong-nonce-wrong-no`),
      await httpRequest(`${origin}${pathname}/extra`),
      await httpRequest(`${origin}${pathname.toUpperCase()}`),
      await httpRequest(server.callbackUrl, { method: 'POST' }),
      await httpRequest(server.callbackUrl, { method: 'HEAD' }),
      await httpRequest(server.callbackUrl, { host: 'evil.example:80' }),
      await httpRequest(server.callbackUrl, { host: 'localhost' }),
    ]) {
      assert.equal(reply.status, 404);
      assert.equal(reply.body, '');
      assert.equal(reply.headers['cache-control'], 'no-store');
    }
    assert.equal(calls, 0);
  });

  it('shows the failed page when the handler throws', async () => {
    server = await startLoopbackServer(async () => {
      throw new Error('boom');
    });
    const reply = await httpRequest(server.callbackUrl);
    assert.equal(reply.status, 200);
    assert.match(reply.body, /That link didn't work/);
    assert.ok(!reply.body.includes('boom'));
  });

  it('stops listening once closed', async () => {
    server = await startLoopbackServer(async () => 'success');
    const url = server.callbackUrl;
    await httpRequest(url);
    await server.close();
    server = undefined;
    await assert.rejects(httpRequest(url), /ECONNREFUSED/);
  });

  it('renders self-contained pages for each outcome', () => {
    for (const [page, text] of [
      ['success', "You're signed in to Sevalla"],
      ['denied', 'Sign-in denied'],
      ['failed', "That link didn't work"],
    ] as const) {
      const html = renderPage(page);
      assert.match(html, new RegExp(text));
      assert.ok(!/<script|<link|src=|https?:\/\//.test(html), `${page} loads nothing external`);
    }
  });
});
