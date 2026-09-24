import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { test } from 'vitest';
import { startCredentialGateway, upstreamCredentialHeader, type CredentialGateway } from '../src/gateway';

const realCredential = 'real-provider-secret-value';
const requests: { url?: string; method?: string; authorization?: string; apiKey?: string; body?: string }[] = [];

let upstream: Server;
let gateway: CredentialGateway;

async function listenUpstream(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<number> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  upstream = server;
  return (server.address() as { port: number }).port;
}

test.afterEach(async () => {
  await gateway?.close();
  await new Promise<void>((resolve) => upstream?.close(() => resolve()));
  requests.length = 0;
});

test('injects the real credential and forwards to exactly one upstream origin', async () => {
  const port = await listenUpstream((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk));
    request.on('end', () => {
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.authorization as string | undefined,
        apiKey: request.headers['x-api-key'] as string | undefined,
        body,
      });
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    });
  });
  gateway = await startCredentialGateway({
    connection: {
      api: 'openai-completions',
      baseUrl: `http://host.containers.internal:${port}`,
      network: 'private',
      credential: { type: 'bearer', value: realCredential },
    },
    containerHostAlias: '127.0.0.1',
  });

  const response = await fetch(`${gateway.origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${gateway.placeholder}`, 'content-type': 'application/json' },
    body: '{"model":"m"}',
  });
  assert.equal(response.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, '/v1/chat/completions');
  assert.equal(requests[0]?.authorization, `Bearer ${realCredential}`);
  assert.ok(!requests[0]?.authorization?.includes(gateway.placeholder));
  assert.ok(!requests[0]?.body?.includes(realCredential));
  assert.ok(!requests[0]?.body?.includes('authorization'));
});

test('injects the anthropic credential header without a bearer prefix', async () => {
  const port = await listenUpstream((request: IncomingMessage, response: ServerResponse) => {
    requests.push({
      apiKey: request.headers['x-api-key'] as string | undefined,
      authorization: request.headers.authorization,
    });
    response.end('{}');
  });
  gateway = await startCredentialGateway({
    connection: {
      api: 'anthropic-messages',
      baseUrl: `http://host.containers.internal:${port}`,
      network: 'private',
      credential: { type: 'api-key', value: realCredential },
    },
    containerHostAlias: '127.0.0.1',
  });
  assert.equal(upstreamCredentialHeader('anthropic-messages').name, 'x-api-key');
  const response = await fetch(`${gateway.origin}/v1/messages`, {
    headers: { 'x-api-key': gateway.placeholder },
  });
  assert.equal(response.status, 200);
  assert.equal(requests[0]?.apiKey, realCredential);
  assert.equal(requests[0]?.authorization, undefined);
});

test('rejects missing, wrong, and replayed credentials without contacting upstream', async () => {
  const port = await listenUpstream(() => {
    requests.push({});
  });
  gateway = await startCredentialGateway({
    connection: {
      api: 'openai-completions',
      baseUrl: `http://host.containers.internal:${port}`,
      network: 'private',
      credential: { type: 'bearer', value: realCredential },
    },
    containerHostAlias: '127.0.0.1',
  });
  for (const headers of [
    {} as Record<string, string>,
    { authorization: `Bearer ${realCredential}` },
    { authorization: 'Bearer gw-not-the-placeholder' },
  ]) {
    const response = await fetch(`${gateway.origin}/chat/completions`, { headers });
    assert.equal(response.status, 403);
    assert.equal(await response.text(), '');
  }
  assert.equal(requests.length, 0);
});

test('blocks proxy-style absolute targets and non-path requests', async () => {
  const port = await listenUpstream(() => {
    requests.push({});
  });
  gateway = await startCredentialGateway({
    connection: {
      api: 'openai-completions',
      baseUrl: `http://host.containers.internal:${port}`,
      network: 'private',
      credential: { type: 'bearer', value: realCredential },
    },
    containerHostAlias: '127.0.0.1',
  });
  const authorized = { authorization: `Bearer ${gateway.placeholder}` };
  const absolute = await fetch(`${gateway.origin}/http://evil.example.test/steal`, { headers: authorized });
  assert.equal(absolute.status, 403);
  assert.equal(requests.length, 0);
});

test('blocks cross-origin redirects instead of letting the harness follow them', async () => {
  const port = await listenUpstream((request: IncomingMessage, response: ServerResponse) => {
    requests.push({ url: request.url });
    response.writeHead(302, { location: 'https://evil.example.test/steal' });
    response.end();
  });
  gateway = await startCredentialGateway({
    connection: {
      api: 'openai-completions',
      baseUrl: `http://host.containers.internal:${port}`,
      network: 'private',
      credential: { type: 'bearer', value: realCredential },
    },
    containerHostAlias: '127.0.0.1',
  });
  const response = await fetch(`${gateway.origin}/chat/completions`, {
    headers: { authorization: `Bearer ${gateway.placeholder}` },
  });
  assert.equal(response.status, 502);
  assert.equal(requests.length, 1);
});

test('passes through same-origin redirects and streams response bodies', async () => {
  const port = await listenUpstream((request: IncomingMessage, response: ServerResponse) => {
    requests.push({ url: request.url });
    if (request.url === '/first') {
      response.writeHead(307, { location: '/second' });
      response.end();
      return;
    }
    response.setHeader('content-type', 'text/event-stream');
    response.write('data: part-1\n\n');
    setTimeout(() => {
      response.write('data: part-2\n\n');
      response.end();
    }, 20);
  });
  gateway = await startCredentialGateway({
    connection: {
      api: 'openai-completions',
      baseUrl: `http://host.containers.internal:${port}`,
      network: 'private',
      credential: { type: 'bearer', value: realCredential },
    },
    containerHostAlias: '127.0.0.1',
  });
  const first = await fetch(`${gateway.origin}/first`, {
    headers: { authorization: `Bearer ${gateway.placeholder}` },
    redirect: 'manual',
  });
  assert.equal(first.status, 307);
  assert.equal(first.headers.get('location'), '/second');
  const streamed = await fetch(`${gateway.origin}/stream`, {
    headers: { authorization: `Bearer ${gateway.placeholder}` },
  });
  const body = await streamed.text();
  assert.equal(body, 'data: part-1\n\ndata: part-2\n\n');
  assert.deepEqual(
    requests.map((request) => request.url),
    ['/first', '/stream'],
  );
});

test('returns a fixed 502 when the upstream is unreachable and closes cleanly', async () => {
  // Port 1 is reserved; nothing listens there.
  gateway = await startCredentialGateway({
    connection: {
      api: 'openai-completions',
      baseUrl: 'http://host.containers.internal:1',
      network: 'private',
      credential: { type: 'bearer', value: realCredential },
    },
    containerHostAlias: '127.0.0.1',
  });
  const response = await fetch(`${gateway.origin}/chat/completions`, {
    headers: { authorization: `Bearer ${gateway.placeholder}` },
  });
  assert.equal(response.status, 502);
  assert.ok(!JSON.stringify(response.headers).includes(realCredential));
  await gateway.close();
  await assert.rejects(fetch(`${gateway.origin}/v1`));
  gateway = undefined as unknown as CredentialGateway;
});

test('preserves the upstream base path prefix in the container-visible origin', async () => {
  const port = await listenUpstream((request: IncomingMessage, response: ServerResponse) => {
    requests.push({ url: request.url, authorization: request.headers.authorization as string | undefined });
    response.setHeader('content-type', 'application/json');
    response.end('{"ok":true}');
  });
  gateway = await startCredentialGateway({
    connection: {
      api: 'openai-completions',
      baseUrl: `http://host.containers.internal:${port}/v1`,
      network: 'private',
      credential: { type: 'bearer', value: realCredential },
    },
    containerHostAlias: '127.0.0.1',
  });
  assert.ok(gateway.origin.endsWith('/v1'));
  const response = await fetch(`${gateway.origin}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${gateway.placeholder}` },
    body: '{"model":"m"}',
  });
  assert.equal(response.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, '/v1/chat/completions');
  assert.equal(requests[0]?.authorization, `Bearer ${realCredential}`);
});

test('pins the authorized destination and never re-resolves DNS during the review', async () => {
  const port = await listenUpstream((request: IncomingMessage, response: ServerResponse) => {
    requests.push({ url: request.url });
    response.end('{}');
  });
  let resolutions = 0;
  const resolver = async (hostname: string) => {
    resolutions += 1;
    assert.equal(hostname, 'pinned-provider.test');
    return [{ address: '127.0.0.1', family: 4 }];
  };
  gateway = await startCredentialGateway({
    connection: {
      api: 'openai-completions',
      baseUrl: `http://pinned-provider.test:${port}`,
      network: 'private',
      credential: { type: 'bearer', value: realCredential },
    },
    containerHostAlias: '127.0.0.1',
    resolver,
  });
  for (let index = 0; index < 3; index += 1) {
    const response = await fetch(`${gateway.origin}/chat/completions`, {
      headers: { authorization: `Bearer ${gateway.placeholder}` },
    });
    assert.equal(response.status, 200);
  }
  assert.equal(resolutions, 1);
  assert.equal(requests.length, 3);
});

test('fails closed on mixed public and private resolution for remote endpoints', async () => {
  await assert.rejects(
    () =>
      startCredentialGateway({
        connection: {
          api: 'openai-completions',
          baseUrl: 'http://mixed-dns.test:8080',
          network: 'remote',
          credential: { type: 'bearer', value: realCredential },
        },
        containerHostAlias: '127.0.0.1',
        resolver: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.5', family: 4 },
        ],
      }),
    /resolution failed or violates/u,
  );
});

test('fails closed when remote resolution returns only private or reserved addresses', async () => {
  for (const addresses of [[{ address: '10.0.0.5', family: 4 }], [{ address: '169.254.169.254', family: 4 }], []]) {
    await assert.rejects(
      () =>
        startCredentialGateway({
          connection: {
            api: 'openai-completions',
            baseUrl: 'http://remote-provider.test:8080',
            network: 'remote',
            credential: { type: 'bearer', value: realCredential },
          },
          containerHostAlias: '127.0.0.1',
          resolver: async () => addresses,
        }),
      /resolution failed or violates/u,
    );
  }
});

test('allows private resolution for explicitly trusted private endpoints', async () => {
  const port = await listenUpstream((request: IncomingMessage, response: ServerResponse) => {
    requests.push({ url: request.url });
    response.end('{}');
  });
  gateway = await startCredentialGateway({
    connection: {
      api: 'openai-completions',
      baseUrl: `http://lan-model.lan:${port}`,
      network: 'private',
      credential: { type: 'bearer', value: realCredential },
    },
    containerHostAlias: '127.0.0.1',
    resolver: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  const response = await fetch(`${gateway.origin}/v1/chat/completions`, {
    headers: { authorization: `Bearer ${gateway.placeholder}` },
  });
  assert.equal(response.status, 200);
  assert.equal(requests.length, 1);
});

test('ignores hostile proxy environment variables for upstream connections', async () => {
  const port = await listenUpstream((request: IncomingMessage, response: ServerResponse) => {
    requests.push({ url: request.url });
    response.end('{}');
  });
  let proxyHits = 0;
  const proxy = createServer(() => {
    proxyHits += 1;
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const previousHttp = process.env.HTTP_PROXY;
  const previousHttps = process.env.HTTPS_PROXY;
  process.env.HTTP_PROXY = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  process.env.HTTPS_PROXY = process.env.HTTP_PROXY;
  try {
    gateway = await startCredentialGateway({
      connection: {
        api: 'openai-completions',
        baseUrl: `http://host.containers.internal:${port}`,
        network: 'private',
        credential: { type: 'bearer', value: realCredential },
      },
      containerHostAlias: '127.0.0.1',
    });
    const response = await fetch(`${gateway.origin}/v1/chat/completions`, {
      headers: { authorization: `Bearer ${gateway.placeholder}` },
    });
    assert.equal(response.status, 200);
    assert.equal(requests.length, 1);
    assert.equal(proxyHits, 0);
  } finally {
    if (previousHttp === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = previousHttp;
    if (previousHttps === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previousHttps;
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});

test('bounds hung upstream connections with an idle timeout and fails closed', async () => {
  let opened = 0;
  const hungServer = createServer(() => {
    opened += 1;
    // Never respond.
  });
  await new Promise<void>((resolve) => hungServer.listen(0, '127.0.0.1', resolve));
  const port = (hungServer.address() as { port: number }).port;
  try {
    gateway = await startCredentialGateway({
      connection: {
        api: 'openai-completions',
        baseUrl: `http://host.containers.internal:${port}`,
        network: 'private',
        credential: { type: 'bearer', value: realCredential },
      },
      containerHostAlias: '127.0.0.1',
      upstreamIdleTimeoutMs: 150,
    });
    const startedAt = Date.now();
    const response = await fetch(`${gateway.origin}/v1/chat/completions`, {
      headers: { authorization: `Bearer ${gateway.placeholder}` },
    });
    assert.equal(response.status, 502);
    assert.ok(Date.now() - startedAt >= 100);
    assert.equal(opened, 1);
  } finally {
    hungServer.closeAllConnections();
    await new Promise<void>((resolve) => hungServer.close(() => resolve()));
  }
});

test('rewrites absolute same-origin redirect locations to gateway-relative paths', async () => {
  const port = await listenUpstream((request: IncomingMessage, response: ServerResponse) => {
    requests.push({ url: request.url });
    if (request.url === '/absolute-redirect') {
      // The provider advertises its own public origin; the gateway must keep
      // the harness from connecting there directly.
      response.writeHead(302, { location: `http://pinned-provider.test:${port}/final` });
      response.end();
      return;
    }
    response.end('{}');
  });
  gateway = await startCredentialGateway({
    connection: {
      api: 'openai-completions',
      baseUrl: `http://pinned-provider.test:${port}`,
      network: 'private',
      credential: { type: 'bearer', value: realCredential },
    },
    containerHostAlias: '127.0.0.1',
    resolver: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  const response = await fetch(`${gateway.origin}/absolute-redirect`, {
    headers: { authorization: `Bearer ${gateway.placeholder}` },
    redirect: 'manual',
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/final');
  const followed = await fetch(`${gateway.origin}${response.headers.get('location')}`, {
    headers: { authorization: `Bearer ${gateway.placeholder}` },
  });
  assert.equal(followed.status, 200);
  assert.equal(requests.length, 2);
});
