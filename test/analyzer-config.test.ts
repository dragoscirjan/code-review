import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  ANALYZER_CONFIG_PATH,
  DEFAULT_ANALYZER_LIMITS,
  loadAnalyzerConfiguration,
  parseAnalyzerConfiguration,
} from '../src/analyzer-config';
import type { PullRequestContext } from '../src/github';

const baseSha = 'a'.repeat(40);
const pullRequest: PullRequestContext = {
  owner: 'owner',
  repository: 'repo',
  number: 24,
  title: 'Analyzer support',
  body: '',
  baseSha,
  headSha: 'b'.repeat(40),
  author: 'author',
  url: 'https://github.com/owner/repo/pull/24',
};

function validConfig(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    analyzers: [
      { id: 'conflict-markers', rules: ['unresolved-conflict-marker'] },
      { id: 'typescript-syntax', rules: ['syntax-error'] },
      { id: 'json-syntax', rules: ['duplicate-property', 'syntax-error'] },
    ],
    limits: { ...DEFAULT_ANALYZER_LIMITS },
    ...overrides,
  });
}

test('parses and canonicalizes only the fixed analyzer/rule catalog with tightening limits', () => {
  const parsed = parseAnalyzerConfiguration(
    validConfig({
      analyzers: [
        { id: 'json-syntax', rules: ['duplicate-property', 'syntax-error'] },
        { id: 'conflict-markers', rules: ['unresolved-conflict-marker'] },
      ],
      limits: { ...DEFAULT_ANALYZER_LIMITS, maximumFiles: 4, timeoutSeconds: 2 },
    }),
    baseSha,
    'blob-sha',
  );
  assert.deepEqual(parsed.analyzers, [
    { id: 'conflict-markers', rules: ['unresolved-conflict-marker'] },
    { id: 'json-syntax', rules: ['syntax-error', 'duplicate-property'] },
  ]);
  assert.equal(parsed.limits.maximumFiles, 4);
  assert.equal(parsed.limits.timeoutSeconds, 2);
  assert.match(parsed.configDigest, /^sha256:[A-Za-z0-9_-]{43}$/u);
  assert.match(parsed.manifestDigest, /^sha256:[A-Za-z0-9_-]{43}$/u);
});

test('rejects duplicate keys, unknown tools/rules/fields, command-bearing configuration, and expanded limits', () => {
  const invalid = [
    '{"version":1,"version":1,"analyzers":[],"limits":{}}',
    validConfig({ analyzers: [{ id: 'eslint', rules: ['recommended'] }] }),
    validConfig({ analyzers: [{ id: 'json-syntax', rules: ['plugin:evil'] }] }),
    validConfig({ analyzers: [{ id: 'json-syntax', rules: ['syntax-error'], command: 'npm test' }] }),
    validConfig({ analyzers: [{ id: 'json-syntax', rules: ['syntax-error'], plugin: './evil.js' }] }),
    validConfig({ analyzers: [{ id: 'json-syntax', rules: ['syntax-error'], version: 'latest' }] }),
    validConfig({ analyzers: [{ id: 'json-syntax', rules: ['syntax-error'], paths: ['**/*'] }] }),
    validConfig({
      limits: { ...DEFAULT_ANALYZER_LIMITS, maximumFiles: DEFAULT_ANALYZER_LIMITS.maximumFiles + 1 },
    }),
    validConfig({ extra: { command: 'sh -c evil' } }),
  ];
  for (const raw of invalid) assert.throws(() => parseAnalyzerConfiguration(raw, baseSha));
});

test('loads configuration only from the exact base revision and treats a missing file as disabled', async () => {
  const calls: Array<{ path: string; revision: string; maximumBytes: number }> = [];
  const client = {
    async getRepositoryTextAtRevision(
      _pullRequest: PullRequestContext,
      path: string,
      revision: string,
      maximumBytes: number,
    ) {
      calls.push({ path, revision, maximumBytes });
      return { status: 'not-found' as const, bytes: 0, truncated: false };
    },
  };
  const configuration = await loadAnalyzerConfiguration({ client, pullRequest, mode: 'base-config' });
  assert.deepEqual(calls, [{ path: ANALYZER_CONFIG_PATH, revision: baseSha, maximumBytes: 16_384 }]);
  assert.equal(configuration.status, 'missing');
  assert.deepEqual(configuration.analyzers, []);
});

test('workflow mode none performs no repository read', async () => {
  let called = false;
  const configuration = await loadAnalyzerConfiguration({
    client: {
      async getRepositoryTextAtRevision() {
        called = true;
        throw new Error('must not run');
      },
    },
    pullRequest,
    mode: 'none',
  });
  assert.equal(called, false);
  assert.equal(configuration.status, 'disabled');
});
