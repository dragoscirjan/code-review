import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { packReviewContext, type ContextQueryPlan } from '../src/context-planner';
import { GitHubClient, type PullRequestContext } from '../src/github';
import {
  buildIndexSearchQuery,
  limitIndexContext,
  runCodeIndexer as runCodeIndexerImplementation,
  runCommand,
  type CacheAdapter,
  type CodeIndexRequest,
  type CommandRunner,
} from '../src/indexer';

const pullRequest: PullRequestContext = {
  owner: 'owner',
  repository: 'repository',
  number: 7,
  title: 'Improve review routing',
  body: '',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  author: 'contributor',
  url: 'https://example.test/7',
};

const diff = {
  text: [
    'diff --git a/src/index.ts b/src/index.ts',
    '--- a/src/index.ts',
    '+++ b/src/index.ts',
    '+const changed = true;',
  ].join('\n'),
  originalBytes: 120,
  truncated: false,
};

function github(): GitHubClient {
  return new GitHubClient(
    'token',
    'https://api.example.test',
    async () => new Response('not-a-real-tarball', { status: 200 }),
  );
}

async function fakeArchiveExtractor(
  _archivePath: string,
  destination: string,
): Promise<{ files: number; bytes: number }> {
  const content = 'export const value = true;\n';
  await mkdir(join(destination, 'src'), { recursive: true });
  await writeFile(join(destination, 'src', 'index.ts'), content);
  return { files: 1, bytes: Buffer.byteLength(content) };
}

function runCodeIndexer(request: CodeIndexRequest): ReturnType<typeof runCodeIndexerImplementation> {
  return runCodeIndexerImplementation({ ...request, archiveExtractor: fakeArchiveExtractor });
}

function fakeRunner(calls: Array<{ command: string; args: string[]; environment: NodeJS.ProcessEnv }>): CommandRunner {
  return async (command, args, options) => {
    calls.push({ command, args, environment: options.environment });
    if (args.includes('index') || args.includes('analyze')) {
      const storage = options.environment.GITNEXUS_STORAGE_PATH ?? args[args.indexOf('--path') + 1];
      if (storage) {
        await mkdir(storage, { recursive: true });
        await writeFile(join(storage, 'graph.db'), 'database');
      }
    }
    if (args.includes('query')) {
      return {
        stdout: '{"processes":[{"summary":"main to review"}]}',
        stderr: '',
      };
    }
    if (args.includes('content')) {
      return {
        stdout: 'Function runReview at src/review.ts:378',
        stderr: '',
      };
    }
    return { stdout: '', stderr: '' };
  };
}

function cacheAdapter(input?: {
  createdAt?: string;
  indexer?: 'cgc' | 'gitnexus';
  artifact?: 'valid' | 'unrelated';
  exactPrimary?: boolean;
}): {
  adapter: CacheAdapter;
  savedCreatedAt: string[];
  savedKeys: string[];
} {
  const savedCreatedAt: string[] = [];
  const savedKeys: string[] = [];
  return {
    savedCreatedAt,
    savedKeys,
    adapter: {
      isAvailable: () => true,
      restore: async (paths, primaryKey) => {
        if (!input?.createdAt || !input.indexer) {
          return undefined;
        }
        const path = paths[0];
        assert.ok(path);
        if (input.artifact === 'unrelated') {
          await mkdir(path, { recursive: true });
          await writeFile(join(path, 'unrelated.txt'), 'not a database');
        } else {
          await mkdir(join(path, 'graph'), { recursive: true });
          await writeFile(join(path, 'graph', 'cached.db'), 'database');
        }
        await writeFile(
          join(path, 'code-review-cache.json'),
          `${JSON.stringify({
            createdAt: input.createdAt,
            indexer: input.indexer,
            version: input.indexer === 'cgc' ? '0.6.13' : '1.6.12',
            repository: 'owner/repository',
            baseSha: 'a'.repeat(40),
            platform: process.platform,
            architecture: process.arch,
            schema: 'index-v1',
          })}\n`,
        );
        return input.exactPrimary ? primaryKey : 'restored-key';
      },
      save: async (paths, key) => {
        const path = paths[0];
        assert.ok(path);
        const metadata = JSON.parse(await readFile(join(path, 'code-review-cache.json'), 'utf8')) as {
          createdAt: string;
        };
        savedCreatedAt.push(metadata.createdAt);
        savedKeys.push(key);
        return 1;
      },
    },
  };
}

for (const indexer of ['cgc', 'gitnexus'] as const) {
  test(`installs, indexes, and queries with ${indexer}`, async () => {
    const root = await mkdtemp(join(tmpdir(), `code-review-${indexer}-`));
    const calls: Array<{
      command: string;
      args: string[];
      environment: NodeJS.ProcessEnv;
    }> = [];
    const cache = cacheAdapter();
    try {
      const result = await runCodeIndexer({
        indexer,
        cacheKey: 'code-review-index-v1',
        cacheTtlMs: 86_400_000,
        github: github(),
        pullRequest,
        diff,
        cache: cache.adapter,
        commandRunner: fakeRunner(calls),
        now: () => Date.parse('2026-09-20T12:00:00Z'),
        temporaryRoot: root,
        environment: {
          PATH: process.env.PATH,
          GITHUB_TOKEN: 'github-secret',
          OPENROUTER_API_KEY: 'provider-secret',
        },
      });

      assert.equal(result.indexer, indexer);
      assert.equal(result.cacheHit, false);
      assert.match(result.context, new RegExp(`Indexer: ${indexer}`));
      assert.equal(cache.savedKeys.length, 1);
      assert.match(cache.savedKeys[0] ?? '', /aaaaaaaaaaaaaaaa/);
      for (const call of calls) {
        assert.equal(call.environment.GITHUB_TOKEN, undefined);
        assert.equal(call.environment.OPENROUTER_API_KEY, undefined);
      }
      if (indexer === 'cgc') {
        assert.ok(calls.some((call) => call.args.includes('codegraphcontext==0.6.13')));
        assert.ok(calls.some((call) => call.args.includes('--force')));
      } else {
        assert.ok(calls.some((call) => call.args.includes('gitnexus@1.6.12')));
        assert.ok(calls.some((call) => call.args.includes('--index-only')));
        assert.match(result.context, /main to review/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('uses a fresh previous-bucket cache without renewing its TTL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-review-cgc-cache-'));
  const calls: Array<{
    command: string;
    args: string[];
    environment: NodeJS.ProcessEnv;
  }> = [];
  const cache = cacheAdapter({
    createdAt: '2026-09-19T12:30:00Z',
    indexer: 'cgc',
  });
  try {
    const result = await runCodeIndexer({
      indexer: 'cgc',
      cacheKey: 'code-review-index-v1',
      cacheTtlMs: 86_400_000,
      github: github(),
      pullRequest,
      diff,
      cache: cache.adapter,
      commandRunner: fakeRunner(calls),
      now: () => Date.parse('2026-09-20T12:00:00Z'),
      temporaryRoot: root,
    });
    assert.equal(result.cacheHit, true);
    assert.equal(
      calls.some((call) => call.args.includes('--force')),
      false,
    );
    assert.deepEqual(cache.savedKeys, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ignores an expired cache and rebuilds CGC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-review-cgc-stale-'));
  const calls: Array<{
    command: string;
    args: string[];
    environment: NodeJS.ProcessEnv;
  }> = [];
  const cache = cacheAdapter({
    createdAt: '2026-09-18T12:00:00Z',
    indexer: 'cgc',
  });
  try {
    const result = await runCodeIndexer({
      indexer: 'cgc',
      cacheKey: 'code-review-index-v1',
      cacheTtlMs: 86_400_000,
      github: github(),
      pullRequest,
      diff,
      cache: cache.adapter,
      commandRunner: fakeRunner(calls),
      now: () => Date.parse('2026-09-20T12:00:00Z'),
      temporaryRoot: root,
    });
    assert.equal(result.cacheHit, false);
    assert.ok(calls.some((call) => call.args.includes('--force')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a cache without adapter database artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-review-cgc-invalid-cache-'));
  const calls: Array<{
    command: string;
    args: string[];
    environment: NodeJS.ProcessEnv;
  }> = [];
  const cache = cacheAdapter({
    createdAt: '2026-09-20T11:30:00Z',
    indexer: 'cgc',
    artifact: 'unrelated',
  });
  try {
    const result = await runCodeIndexer({
      indexer: 'cgc',
      cacheKey: 'code-review-index-v1',
      cacheTtlMs: 86_400_000,
      github: github(),
      pullRequest,
      diff,
      cache: cache.adapter,
      commandRunner: fakeRunner(calls),
      now: () => Date.parse('2026-09-20T12:00:00Z'),
      temporaryRoot: root,
    });
    assert.equal(result.cacheHit, false);
    assert.ok(calls.some((call) => call.args.includes('--force')));
    assert.equal(cache.savedKeys.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('removes a partial database after cache restore failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-review-cache-failure-'));
  let partialPath = '';
  const cache: CacheAdapter = {
    isAvailable: () => true,
    restore: async (paths) => {
      const path = paths[0];
      assert.ok(path);
      partialPath = join(path, 'partial.db');
      await mkdir(path, { recursive: true });
      await writeFile(partialPath, 'partial');
      throw new Error('restore interrupted');
    },
    save: async () => 1,
  };
  const calls: Array<{
    command: string;
    args: string[];
    environment: NodeJS.ProcessEnv;
  }> = [];
  const baseRunner = fakeRunner(calls);
  const runner: CommandRunner = async (command, args, options) => {
    if (args.includes('index')) {
      await assert.rejects(access(partialPath));
    }
    return baseRunner(command, args, options);
  };
  try {
    const result = await runCodeIndexer({
      indexer: 'cgc',
      cacheKey: 'code-review-index-v1',
      cacheTtlMs: 86_400_000,
      github: github(),
      pullRequest,
      diff,
      cache,
      commandRunner: runner,
      temporaryRoot: root,
    });
    assert.equal(result.cacheHit, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rebuilds once when a restored database cannot be used', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-review-cache-retry-'));
  const cache = cacheAdapter({
    createdAt: '2026-09-20T11:30:00Z',
    indexer: 'cgc',
    exactPrimary: true,
  });
  const calls: Array<{
    command: string;
    args: string[];
    environment: NodeJS.ProcessEnv;
  }> = [];
  const baseRunner = fakeRunner(calls);
  let indexAttempts = 0;
  const runner: CommandRunner = async (command, args, options) => {
    if (args.includes('index')) {
      indexAttempts += 1;
      if (indexAttempts === 1) {
        throw new Error('cached database is incompatible');
      }
    }
    return baseRunner(command, args, options);
  };
  try {
    const result = await runCodeIndexer({
      indexer: 'cgc',
      cacheKey: 'code-review-index-v1',
      cacheTtlMs: 86_400_000,
      github: github(),
      pullRequest,
      diff,
      cache: cache.adapter,
      commandRunner: runner,
      now: () => Date.parse('2026-09-20T12:00:00Z'),
      temporaryRoot: root,
    });
    assert.equal(result.cacheHit, false);
    assert.equal(indexAttempts, 2);
    assert.ok(calls.some((call) => call.args.includes('--force')));
    assert.equal(cache.savedKeys.length, 1);
    assert.match(cache.savedKeys[0] ?? '', /-repair-/);
    assert.deepEqual(cache.savedCreatedAt, ['2026-09-20T12:00:00.000Z']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('terminates indexer descendant processes after a timeout', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-review-process-group-'));
  const script = join(root, 'spawn-child.sh');
  const pidPath = join(root, 'child.pid');
  await writeFile(
    script,
    `#!/bin/sh\n(\n  trap '' TERM\n  exec </dev/null >/dev/null 2>&1\n  while :; do sleep 300; done\n) &\necho $! > "${pidPath}"\nwait\n`,
  );
  await chmod(script, 0o755);
  try {
    await assert.rejects(
      runCommand(script, [], {
        cwd: root,
        environment: { PATH: process.env.PATH },
        // Allow the shell to start and record its descendant on slower hosts.
        // The descendant still ignores TERM, so forced cleanup is exercised.
        timeoutMs: 2_000,
        killGraceMs: 25,
      }),
      /timed out/,
    );
    const childPid = Number((await readFile(pidPath, 'utf8')).trim());
    assert.ok(Number.isInteger(childPid));
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
      try {
        process.kill(childPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('terminates indexer descendants after a non-zero exit', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-review-process-exit-'));
  const script = join(root, 'failed-command.sh');
  const pidPath = join(root, 'child.pid');
  await writeFile(
    script,
    `#!/bin/sh\n(\n  trap '' TERM\n  exec </dev/null >/dev/null 2>&1\n  while :; do sleep 300; done\n) &\necho $! > "${pidPath}"\nexit 23\n`,
  );
  await chmod(script, 0o755);
  try {
    await assert.rejects(
      runCommand(script, [], {
        cwd: root,
        environment: { PATH: process.env.PATH },
        timeoutMs: 5_000,
        killGraceMs: 25,
      }),
      /exited with code 23/,
    );
    const childPid = Number((await readFile(pidPath, 'utf8')).trim());
    assert.ok(Number.isInteger(childPid));
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
      try {
        process.kill(childPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('executes fixed per-kind query argument arrays in deterministic order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-review-query-plan-'));
  const calls: Array<{ command: string; args: string[]; environment: NodeJS.ProcessEnv }> = [];
  const anchor = {
    value: 'reviewValue',
    kind: 'type' as const,
    language: 'javascript-typescript',
    path: 'src/value.ts',
    provenance: [{ path: 'src/value.ts', side: 'RIGHT' as const, line: 1, lineKind: 'addition' as const }],
  };
  const queries: ContextQueryPlan[] = [
    { id: 'q01', kind: 'definition-and-types', anchor },
    { id: 'q02', kind: 'callers-and-tests', anchor },
    { id: 'q03', kind: 'callees', anchor },
    { id: 'q04', kind: 'configuration', anchor },
  ];
  try {
    const result = await runCodeIndexer({
      indexer: 'cgc',
      cacheKey: 'query-plan',
      cacheTtlMs: 86_400_000,
      github: github(),
      pullRequest,
      queries,
      cache: cacheAdapter().adapter,
      commandRunner: fakeRunner(calls),
      temporaryRoot: root,
    });
    const queryCalls = calls
      .filter(
        (call) => call.args.includes('find') || (call.args.includes('analyze') && !call.args.includes('--index-only')),
      )
      .map((call) => call.args.slice(call.args.indexOf(join(root, 'code-review-index')) >= 0 ? 4 : 4));
    assert.deepEqual(
      queryCalls.map((args) => args.slice(0, 4)),
      [
        ['find', 'name', 'reviewValue', '--no-fuzzy'],
        ['analyze', 'tree', 'reviewValue', '--file'],
        ['analyze', 'callers', 'reviewValue', '--file'],
        ['analyze', 'calls', 'reviewValue', '--file'],
        ['find', 'content', 'reviewValue'],
      ],
    );
    assert.equal(result.results.length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('executes every GitNexus query category with fixed argument arrays', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-review-gitnexus-query-plan-'));
  const calls: Array<{ command: string; args: string[]; environment: NodeJS.ProcessEnv }> = [];
  const base = fakeRunner(calls);
  const runner: CommandRunner = async (command, args, options) => {
    if (['context', 'impact', 'query'].includes(args[0] ?? '')) {
      calls.push({ command, args, environment: options.environment });
      return { stdout: JSON.stringify({ results: [{ name: 'reviewValue' }] }), stderr: '' };
    }
    return base(command, args, options);
  };
  const anchor = {
    value: 'reviewValue',
    kind: 'type' as const,
    language: 'javascript-typescript',
    path: 'src/value.ts',
    provenance: [{ path: 'src/value.ts', side: 'RIGHT' as const, line: 1, lineKind: 'addition' as const }],
  };
  const queries: ContextQueryPlan[] = [
    { id: 'q01', kind: 'definition-and-types', anchor },
    { id: 'q02', kind: 'callers-and-tests', anchor },
    { id: 'q03', kind: 'callees', anchor },
    { id: 'q04', kind: 'configuration', anchor },
  ];
  try {
    const result = await runCodeIndexer({
      indexer: 'gitnexus',
      cacheKey: 'gitnexus-query-plan',
      cacheTtlMs: 86_400_000,
      github: github(),
      pullRequest,
      queries,
      cache: cacheAdapter().adapter,
      commandRunner: runner,
      temporaryRoot: root,
    });
    const queryCalls = calls.filter((call) => ['context', 'impact', 'query'].includes(call.args[0] ?? ''));
    assert.deepEqual(
      queryCalls.map((call) => call.args),
      [
        [
          'context',
          'reviewValue',
          '--repo',
          'code-review-base',
          '--file',
          'src/value.ts',
          '--limit',
          '20',
          '--content',
        ],
        [
          'impact',
          'reviewValue',
          '--repo',
          'code-review-base',
          '--file',
          'src/value.ts',
          '--direction',
          'upstream',
          '--depth',
          '2',
          '--include-tests',
          '--limit',
          '20',
        ],
        [
          'impact',
          'reviewValue',
          '--repo',
          'code-review-base',
          '--file',
          'src/value.ts',
          '--direction',
          'downstream',
          '--depth',
          '1',
          '--limit',
          '20',
        ],
        ['query', 'reviewValue configuration', '--repo', 'code-review-base', '--limit', '3', '--content'],
      ],
    );
    assert.deepEqual(
      result.results.map((item) => item.status),
      ['included', 'included', 'included', 'included'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects option-looking and control-character query arguments before adapter launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-review-unsafe-query-'));
  const calls: Array<{ command: string; args: string[]; environment: NodeJS.ProcessEnv }> = [];
  const provenance = [{ path: 'src/value.ts', side: 'RIGHT' as const, line: 1, lineKind: 'addition' as const }];
  const queries: ContextQueryPlan[] = [
    {
      id: 'q01',
      kind: 'definition-and-types',
      anchor: { value: '--help', kind: 'lexical', language: 'test', path: 'src/value.ts', provenance },
    },
    {
      id: 'q02',
      kind: 'callers-and-tests',
      anchor: { value: 'safeValue', kind: 'lexical', language: 'test', path: '-option.ts', provenance },
    },
    {
      id: 'q03',
      kind: 'callees',
      anchor: { value: 'safeValue', kind: 'lexical', language: 'test', path: 'src/unsafe\u202E.ts', provenance },
    },
  ];
  try {
    const result = await runCodeIndexer({
      indexer: 'cgc',
      cacheKey: 'unsafe-query',
      cacheTtlMs: 86_400_000,
      github: github(),
      pullRequest,
      queries,
      cache: cacheAdapter().adapter,
      commandRunner: fakeRunner(calls),
      temporaryRoot: root,
    });
    assert.deepEqual(
      result.results.map(({ status, reason }) => ({ status, reason })),
      [
        { status: 'unavailable', reason: 'query-failed' },
        { status: 'unavailable', reason: 'query-failed' },
        { status: 'unavailable', reason: 'query-failed' },
      ],
    );
    assert.equal(
      calls.some(
        (call) =>
          call.args.includes('--help') || call.args.includes('-option.ts') || call.args.includes('src/unsafe\u202E.ts'),
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('classifies query timeouts and output limits without aborting later queries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-review-query-limits-'));
  const anchor = {
    value: 'reviewValue',
    kind: 'symbol' as const,
    language: 'javascript-typescript',
    path: 'src/value.ts',
    provenance: [{ path: 'src/value.ts', side: 'RIGHT' as const, line: 1, lineKind: 'addition' as const }],
  };
  const queries: ContextQueryPlan[] = [
    { id: 'q01', kind: 'definition-and-types', anchor },
    { id: 'q02', kind: 'callers-and-tests', anchor },
    { id: 'q03', kind: 'callees', anchor },
  ];
  const base = fakeRunner([]);
  const runner: CommandRunner = async (command, args, options) => {
    if (args.includes('name')) throw new Error('cgc timed out after 5000 ms');
    if (args.includes('callers')) throw new Error(`cgc output exceeded ${options.maximumOutputBytes} bytes`);
    if (args.includes('calls')) return { stdout: 'callee result', stderr: '' };
    return base(command, args, options);
  };
  try {
    const result = await runCodeIndexer({
      indexer: 'cgc',
      cacheKey: 'query-limits',
      cacheTtlMs: 86_400_000,
      github: github(),
      pullRequest,
      queries,
      cache: cacheAdapter().adapter,
      commandRunner: runner,
      temporaryRoot: root,
    });
    assert.deepEqual(
      result.results.map(({ status, reason }) => ({ status, reason })),
      [
        { status: 'timed-out', reason: 'query-timeout' },
        { status: 'unavailable', reason: 'query-output-limit' },
        { status: 'included', reason: undefined },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('truncates query output at an exact UTF-8 boundary and digests only included bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-review-query-utf8-'));
  const anchor = {
    value: 'reviewValue',
    kind: 'symbol' as const,
    language: 'javascript-typescript',
    path: 'src/value.ts',
    provenance: [{ path: 'src/value.ts', side: 'RIGHT' as const, line: 1, lineKind: 'addition' as const }],
  };
  const base = fakeRunner([]);
  const runner: CommandRunner = async (command, args, options) => {
    if (args.includes('name')) return { stdout: `${'a'.repeat(5_999)}😀tail`, stderr: '' };
    return base(command, args, options);
  };
  try {
    const result = await runCodeIndexer({
      indexer: 'cgc',
      cacheKey: 'query-utf8',
      cacheTtlMs: 86_400_000,
      github: github(),
      pullRequest,
      queries: [{ id: 'q01', kind: 'definition-and-types', anchor }],
      cache: cacheAdapter().adapter,
      commandRunner: runner,
      temporaryRoot: root,
    });
    const queryResult = result.results[0];
    assert.equal(queryResult?.status, 'truncated');
    assert.equal(queryResult?.content, 'a'.repeat(5_999));
    assert.doesNotMatch(queryResult?.content ?? '', /�/u);
    const bundle = packReviewContext(
      [
        {
          source: {
            source: 'code-index',
            sourceId: 'q01',
            status: 'truncated',
            acquiredBytes: queryResult?.acquiredBytes ?? 0,
            includedBytes: 0,
          },
          content: queryResult?.content,
        },
      ],
      {
        indexer: 'cgc',
        anchorsPlanned: 1,
        queriesPlanned: 1,
        queriesCompleted: 1,
        queriesTimedOut: 0,
        queryByteLimitHits: 0,
        queryBudgetSkipped: 0,
        guidance: { agents: 'unavailable', contributing: 'unavailable' },
        configuration: { candidates: 0, included: 0, unavailable: 0, truncated: 0 },
        linkedIssues: { discovered: 0, fetched: 0, unavailable: 0 },
      },
    );
    assert.equal(
      bundle.items[0]?.source.contentDigest,
      `sha256:${createHash('sha256').update('a'.repeat(5_999)).digest('hex')}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skips remaining queries after the aggregate query deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-review-query-deadline-'));
  const anchor = {
    value: 'reviewValue',
    kind: 'symbol' as const,
    language: 'javascript-typescript',
    path: 'src/value.ts',
    provenance: [{ path: 'src/value.ts', side: 'RIGHT' as const, line: 1, lineKind: 'addition' as const }],
  };
  const queries: ContextQueryPlan[] = [
    { id: 'q01', kind: 'definition-and-types', anchor },
    { id: 'q02', kind: 'callers-and-tests', anchor },
    { id: 'q03', kind: 'callees', anchor },
  ];
  const times = [0, 0, 45_000, 45_000];
  try {
    const result = await runCodeIndexer({
      indexer: 'cgc',
      cacheKey: 'query-deadline',
      cacheTtlMs: 86_400_000,
      github: github(),
      pullRequest,
      queries,
      cache: cacheAdapter().adapter,
      commandRunner: fakeRunner([]),
      clock: () => times.shift() ?? 45_000,
      temporaryRoot: root,
    });
    assert.deepEqual(
      result.results.map(({ status, reason }) => ({ status, reason })),
      [
        { status: 'empty', reason: undefined },
        { status: 'budget-exhausted', reason: 'aggregate-time-limit' },
        { status: 'budget-exhausted', reason: 'aggregate-time-limit' },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('builds a bounded search query and index context', () => {
  assert.match(buildIndexSearchQuery(pullRequest, diff), /src\/index\.ts/);
  const limited = limitIndexContext(`\u001b[31m${'😀'.repeat(20_000)}`);
  // eslint-disable-next-line no-control-regex -- Verifies that ANSI ESC sequences are removed.
  assert.doesNotMatch(limited, /\u001b/);
  assert.ok(Buffer.byteLength(limited, 'utf8') <= 50_000);
  assert.match(limited, /index context truncated/);
});
