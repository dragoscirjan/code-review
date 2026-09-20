import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CodeIndexer } from "../src/config";
import { GitHubClient, type PullRequestContext } from "../src/github";
import { runCodeIndexer, type CacheAdapter } from "../src/indexer";

const enabled = process.env.RUN_INDEXER_INTEGRATION === "1";
const selected = process.env.CODE_INDEXER;
const indexer: Exclude<CodeIndexer, "none"> =
  selected === "cgc" ? "cgc" : "gitnexus";

test(
  `${indexer} installs and indexes a real repository archive`,
  { skip: !enabled, timeout: 30 * 60_000 },
  async () => {
    const repository = process.env.GITHUB_REPOSITORY ?? "dragoscirjan/code-review";
    const [owner, name] = repository.split("/");
    assert.ok(owner && name);
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const pullRequest: PullRequestContext = {
      owner,
      repository: name,
      number: 1,
      title: "Review action indexing",
      body: "",
      baseSha,
      headSha: baseSha,
      author: "integration-test",
      url: `https://github.com/${repository}`,
    };
    const cacheRoot = await mkdtemp(join(tmpdir(), `code-review-${indexer}-cache-`));
    const firstRoot = await mkdtemp(join(tmpdir(), `code-review-${indexer}-first-`));
    const secondRoot = await mkdtemp(join(tmpdir(), `code-review-${indexer}-second-`));
    const snapshot = join(cacheRoot, "database");
    let saved = false;
    const localCache: CacheAdapter = {
      isAvailable: () => true,
      restore: async (paths) => {
        if (!saved) {
          return undefined;
        }
        const destination = paths[0];
        assert.ok(destination);
        await mkdir(join(destination, ".."), { recursive: true });
        await cp(snapshot, destination, { recursive: true });
        return "local-cache";
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
    const request = {
      indexer,
      cacheKey: "integration-index-v1",
      cacheTtlMs: 86_400_000,
      github: new GitHubClient(process.env.GITHUB_TOKEN ?? ""),
      pullRequest,
      diff: {
        text: "+++ b/src/index.ts\n+const integration = true;",
        originalBytes: 49,
        truncated: false,
      },
      cache: localCache,
      now: () => Date.parse("2026-09-20T12:00:00Z"),
    } as const;

    try {
      const first = await runCodeIndexer({
        ...request,
        temporaryRoot: firstRoot,
      });
      assert.equal(first.cacheHit, false);
      assert.match(first.context, new RegExp(`Indexer: ${indexer}`));
      assert.ok(first.context.length > 200, "expected indexed query context");

      const second = await runCodeIndexer({
        ...request,
        temporaryRoot: secondRoot,
      });
      assert.equal(second.cacheHit, true);
      assert.match(second.context, /Base revision:/);
    } finally {
      await Promise.all([
        rm(cacheRoot, { recursive: true, force: true }),
        rm(firstRoot, { recursive: true, force: true }),
        rm(secondRoot, { recursive: true, force: true }),
      ]);
    }
  },
);
