import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { test } from 'vitest';
import type { ModelConnection } from '../src/model';
import { buildContainerArguments, buildContainerEnvironment } from '../src/review';
import { buildHarnessConfig, SANDBOX_BOOTSTRAP } from '../src/sandbox';

const connection: ModelConnection = {
  api: 'openai-completions',
  baseUrl: 'https://provider.example/v1',
  network: 'remote',
  modelId: 'vendor/model:latest',
  contextWindow: 64000,
  maxOutputTokens: 4096,
  credential: { type: 'bearer', value: '!danger$SECRET{file:/tmp/secret}{env:GH_TOKEN}"\\end' },
};
const versions = { piVersion: '0.85.1', opencodeVersion: '1.18.31' };

for (const backend of ['opencode', 'pi'] as const) {
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages'] as const) {
    test(`${backend} bootstrap writes native ${api} config before launch with literal credential handling`, () => {
      const input = { ...connection, api };
      const env = buildContainerEnvironment(
        { PATH: '/bin', GH_TOKEN: 'forge-secret', INPUT_MODEL_CREDENTIALS: 'unused-secret' },
        input,
        backend,
        versions,
      );
      const files = new Map<string, string>();
      const process = { env, exitCode: 0 };
      let launched = false;
      const errors: string[] = [];
      runInNewContext(SANDBOX_BOOTSTRAP, {
        process,
        console: { error: (message: string) => errors.push(message) },
        require: (name: string) => {
          if (name === 'node:fs')
            return {
              mkdirSync: () => undefined,
              writeFileSync: (path: string, value: string, options: { mode: number }) => {
                assert.equal(options.mode, 0o600);
                files.set(path, value);
              },
            };
          if (name === 'node:child_process')
            return {
              spawn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
                launched = true;
                assert.equal(command, 'npx');
                assert.ok(files.size > 0);
                assert.ok(!JSON.stringify(args).includes(connection.credential!.value));
                assert.equal(options.env.GH_TOKEN, undefined);
                assert.equal(options.env.INPUT_MODEL_CREDENTIALS, undefined);
                assert.equal(options.env.REVIEW_HARNESS_CONFIG, undefined);
                return new EventEmitter();
              },
            };
          throw new Error('Unexpected module');
        },
      });
      assert.deepEqual(errors, []);
      assert.ok(launched);
      assert.equal(process.exitCode, 0);
      if (backend === 'opencode') {
        const raw = files.get('/tmp/review-config/opencode.json')!;
        assert.ok(!raw.includes('{file:'));
        assert.ok(!raw.includes('{env:'));
        const parsed = JSON.parse(raw);
        assert.equal(parsed.provider['review-provider'].options.apiKey, connection.credential!.value);
        assert.equal(parsed.provider['review-provider'].models['review-model'].id, connection.modelId);
        assert.equal(parsed.permission['*'], 'deny');
        assert.deepEqual(parsed.enabled_providers, ['review-provider']);
        assert.equal(
          parsed.provider['review-provider'].npm,
          api === 'anthropic-messages'
            ? '@ai-sdk/anthropic'
            : api === 'openai-responses'
              ? '@ai-sdk/openai'
              : '@ai-sdk/openai-compatible',
        );
        assert.equal(env.REVIEW_MODEL_TOKEN, undefined);
      } else {
        const raw = files.get('/tmp/review-config/models.json')!;
        const provider = JSON.parse(raw).providers['review-provider'];
        assert.equal(provider.api, api);
        assert.equal(provider.apiKey, '$REVIEW_MODEL_TOKEN');
        assert.equal(provider.models[0].id, connection.modelId);
        assert.ok(!raw.includes(connection.credential!.value));
        assert.equal(env.REVIEW_MODEL_TOKEN, connection.credential!.value);
        assert.equal(env.PI_CODING_AGENT_DIR, '/tmp/review-config');
      }
    });
  }
}

test('keyless configuration contains no real credential; network policy cannot enable host networking', () => {
  const local: ModelConnection = {
    ...connection,
    credential: undefined,
    network: 'private',
    baseUrl: 'http://host.docker.internal:11434/v1',
  };
  assert.ok(!JSON.stringify(buildHarnessConfig(local, 'opencode')).includes('apiKey'));
  const env = buildContainerEnvironment({ REVIEW_MODEL_TOKEN: 'ambient-secret' }, local, 'pi', versions);
  assert.equal(env.REVIEW_MODEL_TOKEN, undefined);
  const args = buildContainerArguments({
    backend: 'pi',
    connection: local,
    containerName: 'test',
    containerEngine: 'docker',
  });
  assert.ok(args.includes('host.docker.internal:host-gateway'));
  assert.equal(args[args.indexOf('--network') + 1], 'bridge');
  assert.ok(!args.includes('--mount'));
});

for (const backend of ['opencode', 'pi'] as const) {
  test(`${backend} keyless Responses bootstrap uses only a fixed non-secret placeholder`, () => {
    const local = { ...connection, api: 'openai-responses' as const, credential: undefined };
    const env = buildContainerEnvironment({ REVIEW_MODEL_TOKEN: 'ambient-secret' }, local, backend, versions);
    const files = new Map<string, string>();
    let launched = false;
    runInNewContext(SANDBOX_BOOTSTRAP, {
      process: { env },
      console: { error: () => assert.fail('bootstrap failed') },
      require: (name: string) =>
        name === 'node:fs'
          ? {
              mkdirSync: () => undefined,
              writeFileSync: (path: string, content: string) => files.set(path, content),
            }
          : {
              spawn: () => {
                launched = true;
                return new EventEmitter();
              },
            },
    });
    assert.ok(launched);
    assert.ok(!JSON.stringify([...files.values()]).includes('ambient-secret'));
    if (backend === 'pi') {
      assert.equal(env.REVIEW_MODEL_TOKEN, 'keyless-local-model');
    } else {
      const parsed = JSON.parse(files.get('/tmp/review-config/opencode.json')!);
      assert.equal(parsed.provider['review-provider'].options.apiKey, 'keyless-local-model');
      assert.equal(env.REVIEW_MODEL_TOKEN, undefined);
    }
  });
}
