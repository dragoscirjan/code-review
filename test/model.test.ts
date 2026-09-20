import assert from 'node:assert/strict';
import { test } from 'vitest';
import { addressAllowed, loadModelConnection, redactSecrets, validateModelEndpoint } from '../src/model';

const config = {
  version: 1,
  provider: {
    api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    network: 'remote',
    credential: 'router',
  },
  model: { id: 'z-ai/glm-5.3-flash' },
};
const credentials = JSON.stringify({
  router: { type: 'bearer', value: 'router-secret' },
  unused: { type: 'bearer', value: 'unused-secret' },
});
const load = (value: unknown = config, auth = credentials) => loadModelConnection(JSON.stringify(value), auth);

test('selects only the referenced provider credential without a model allowlist', () => {
  const connection = load({
    ...config,
    model: { id: 'vendor/paid-model:latest', contextWindow: 64000, maxOutputTokens: 4096 },
  });
  assert.equal(connection.modelId, 'vendor/paid-model:latest');
  assert.equal(connection.credential?.value, 'router-secret');
  assert.ok(!JSON.stringify(connection).includes('unused-secret'));
  assert.equal(connection.contextWindow, 64000);
  assert.equal(connection.maxOutputTokens, 4096);
});

test('supports keyless local endpoints and explicit authentication schemes', () => {
  const local = load(
    { ...config, provider: { api: 'openai-completions', baseUrl: 'http://192.168.1.8:11434/v1', network: 'private' } },
    '{}',
  );
  assert.equal(local.credential, undefined);
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages']) {
    const type = api === 'anthropic-messages' ? 'api-key' : 'bearer';
    assert.equal(
      load({ ...config, provider: { ...config.provider, api } }, JSON.stringify({ router: { type, value: 'token' } }))
        .api,
      api,
    );
  }
  assert.throws(
    () => load({ ...config, provider: { ...config.provider, api: 'anthropic-messages' } }),
    /requires api-key/,
  );
  assert.throws(
    () => load(config, JSON.stringify({ router: { type: 'api-key', value: 'token' } })),
    /OpenAI APIs accept bearer/,
  );
  assert.throws(
    () =>
      load(
        { ...config, provider: { ...config.provider, api: 'anthropic-messages' } },
        JSON.stringify({ router: { type: 'api-key', value: 'sk-ant-oat-sentinel' } }),
      ),
    /OAuth tokens are unsupported/,
  );
});

test('rejects unknown/native harness fields, missing credentials and malformed inputs', () => {
  for (const invalid of [
    { ...config, version: 2 },
    { ...config, plugin: ['evil'] },
    { ...config, provider: { ...config.provider, headers: { Authorization: 'token' } } },
    { ...config, provider: { ...config.provider, api: 'anything' } },
    { ...config, provider: { ...config.provider, credential: 'missing' } },
    { ...config, model: { ...config.model, samplingParams: { tools: [] } } },
    { ...config, model: { id: '{file:/tmp/secret}' } },
    { ...config, model: { id: '*' } },
    { ...config, model: { id: 'ok', contextWindow: 100, maxOutputTokens: 200 } },
  ])
    assert.throws(() => load(invalid));
  assert.throws(() => loadModelConnection('{"secret":"invalid'), /must be valid JSON/);
  assert.throws(() => loadModelConnection('x'.repeat(32001)), /exceeds/);
  assert.throws(
    () => load(config, '{"router":{"type":"bearer","value":"sensitive'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('sensitive'));
      return true;
    },
  );
  assert.throws(() => loadModelConnection(JSON.stringify(config).replace('"version":1', '"__proto__":{},"version":1')));
  for (const value of ['', 'a\nb', 'a b', 'a'.repeat(8193)]) {
    assert.throws(() => load(config, JSON.stringify({ router: { type: 'bearer', value } })));
  }
});

test('requires explicit network consent and forbids endpoint interpolation/secrets', () => {
  for (const baseUrl of [
    'http://api.example.com/v1',
    'https://user:token@api.example.com/v1',
    'https://api.example.com/?key=secret',
    'https://api.example.com/v1#',
    'https://api.example.com/v1?',
    'https://api.example.com/#secret',
    'file:///tmp/key',
    'https://api.example.com/{file:/tmp/key}',
    'https://api.example.com/$SECRET',
    'https://localhost/v1',
    'https://127.0.0.1/v1',
    'https://[::1]/v1',
  ]) {
    assert.throws(() => load({ ...config, provider: { ...config.provider, baseUrl } }));
  }
  assert.throws(
    () => load({ ...config, provider: { ...config.provider, network: undefined } }),
    /explicitly authorize/,
  );
});

test('fails closed for private, reserved, metadata, mixed DNS and resolution errors', async () => {
  for (const ip of [
    '127.0.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.100.100.200',
    '192.168.1.2',
    '10.1.2.3',
    '172.16.1.2',
    '::1',
    '::ffff:127.0.0.1',
    'fd00::1',
    'fe80::1',
    '2001:db8::1',
    '224.1.1.1',
  ]) {
    assert.equal(addressAllowed(ip, 'remote'), false, ip);
  }
  assert.equal(addressAllowed('8.8.8.8', 'remote'), true);
  assert.equal(addressAllowed('2606:4700:4700::1111', 'remote'), true);
  assert.equal(addressAllowed('192.168.1.2', 'private'), true);
  assert.equal(addressAllowed('fd00::2', 'private'), true);
  assert.equal(addressAllowed('8.8.8.8', 'private'), false);
  assert.equal(addressAllowed('169.254.169.254', 'private'), false);
  await validateModelEndpoint(load(), async () => [{ address: '8.8.8.8' }]);
  await assert.rejects(
    validateModelEndpoint(load(), async () => [{ address: '8.8.8.8' }, { address: '10.1.1.1' }]),
    /network policy/,
  );
  await assert.rejects(
    validateModelEndpoint(load(), async () => []),
    /network policy/,
  );
  await assert.rejects(
    validateModelEndpoint(load(), async () => {
      throw new Error('sensitive');
    }),
    /network policy/,
  );
});

test('redacts exact and JSON-escaped credentials without empty-secret corruption', () => {
  const secret = 'token"\\value';
  assert.equal(redactSecrets(`${secret} ${JSON.stringify(secret)}`, [secret, '']), '[REDACTED] "[REDACTED]"');
  assert.equal(redactSecrets('safe text', ['']), 'safe text');
});
