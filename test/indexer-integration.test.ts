import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import type { CodeIndexer } from '../src/config';
import type { ContextQueryPlan } from '../src/context-planner';
import { GitHubClient, type PullRequestContext } from '../src/github';
import { runCodeIndexer, type CacheAdapter } from '../src/indexer';

const enabled = process.env.RUN_INDEXER_INTEGRATION === '1';
const selected = process.env.CODE_INDEXER;
const indexer: Exclude<CodeIndexer, 'none'> = selected === 'cgc' ? 'cgc' : 'gitnexus';

test(
  `${indexer} installs and indexes a real repository archive`,
  { skip: !enabled, timeout: 30 * 60_000 },
  async () => {
    const repository = process.env.GITHUB_REPOSITORY ?? 'dragoscirjan/code-review';
    const [owner, name] = repository.split('/');
    assert.ok(owner && name);
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const pullRequest: PullRequestContext = {
      owner,
      repository: name,
      number: 1,
      title: 'Review action indexing',
      body: '',
      baseSha,
      headSha: baseSha,
      author: 'integration-test',
      url: `https://github.com/${repository}`,
    };
    const cacheRoot = await mkdtemp(join(tmpdir(), `code-review-${indexer}-cache-`));
    const firstRoot = await mkdtemp(join(tmpdir(), `code-review-${indexer}-first-`));
    const secondRoot = await mkdtemp(join(tmpdir(), `code-review-${indexer}-second-`));
    const snapshot = join(cacheRoot, 'database');
    let saved = false;
    const localCache: CacheAdapter = {
      isAvailable: () => true,
      restore: async (paths) => {
        if (!saved) {
          return undefined;
        }
        const destination = paths[0];
        assert.ok(destination);
        await mkdir(join(destination, '..'), { recursive: true });
        await cp(snapshot, destination, { recursive: true });
        return 'local-cache';
      },
      save: async (paths) => {
        const source = paths[0];
        assert.ok(source);
        await rm(snapshot, { recursive: true, force: true });
        await cp(source, snapshot, { recursive: true });
        saved = true;
        return 1;
      },
    };
    const typeAnchor = {
      value: 'GitHubClient',
      kind: 'type' as const,
      language: 'javascript-typescript',
      path: 'src/github.ts',
      provenance: [{ path: 'src/github.ts', side: 'RIGHT' as const, line: 1, lineKind: 'addition' as const }],
    };
    const symbolAnchor = {
      value: 'runReview',
      kind: 'symbol' as const,
      language: 'javascript-typescript',
      path: 'src/review.ts',
      provenance: [{ path: 'src/review.ts', side: 'RIGHT' as const, line: 1, lineKind: 'addition' as const }],
    };
    const queries: ContextQueryPlan[] = [
      { id: 'q01', kind: 'definition-and-types', anchor: typeAnchor },
      { id: 'q02', kind: 'callers-and-tests', anchor: symbolAnchor },
      { id: 'q03', kind: 'callees', anchor: symbolAnchor },
      { id: 'q04', kind: 'configuration', anchor: symbolAnchor },
    ];
    const request = {
      indexer,
      cacheKey: 'integration-index-v1',
      cacheTtlMs: 86_400_000,
      github: new GitHubClient(process.env.GITHUB_TOKEN ?? ''),
      pullRequest,
      queries,
      cache: localCache,
      now: () => Date.parse('2026-09-20T12:00:00Z'),
    } as const;

    try {
      const first = await runCodeIndexer({
        ...request,
        temporaryRoot: firstRoot,
      });
      assert.equal(first.cacheHit, false);
      assert.match(first.context, new RegExp(`Indexer: ${indexer}`));
      assert.equal(first.results.length, queries.length);
      assert.ok(
        first.results.every((result) => ['included', 'empty', 'truncated'].includes(result.status)),
        `expected every ${indexer} command category to complete`,
      );

      const second = await runCodeIndexer({
        ...request,
        temporaryRoot: secondRoot,
      });
      assert.equal(second.cacheHit, true);
      assert.match(second.context, /Base revision:/);
      assert.equal(second.results.length, queries.length);
      assert.ok(second.results.every((result) => ['included', 'empty', 'truncated'].includes(result.status)));
    } finally {
      await Promise.all([
        rm(cacheRoot, { recursive: true, force: true }),
        rm(firstRoot, { recursive: true, force: true }),
        rm(secondRoot, { recursive: true, force: true }),
      ]);
    }
  },
);
