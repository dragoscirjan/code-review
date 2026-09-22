import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { planActionRelease } from '../src/action-release';
import { GitActionReleaseRepository, runActionReleaseProcess } from '../src/action-release-git';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? tmpdir(),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      LC_ALL: 'C',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function fixture(): Promise<{ remote: string; work: string; firstSha: string }> {
  const root = await mkdtemp(join(tmpdir(), 'action-release-git-test-'));
  directories.push(root);
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  git(root, 'init', '--bare', '--quiet', remote);
  git(root, 'init', '--quiet', '-b', 'main', work);
  git(work, 'config', 'user.name', 'Release Test');
  git(work, 'config', 'user.email', 'release@example.invalid');
  git(work, 'commit', '--allow-empty', '--quiet', '-m', 'first');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '--quiet', '-u', 'origin', 'main');
  return { remote, work, firstSha: git(work, 'rev-parse', 'HEAD') };
}

const stableRelease = (tagName: string) => ({ tagName, draft: false, prerelease: false });

describe('GitActionReleaseRepository', () => {
  test('creates the immutable and major tags in one publication and verifies direct commit refs', async () => {
    const { remote, firstSha } = await fixture();
    const repository = GitActionReleaseRepository.forTest(remote, 'test-token');
    const snapshot = await repository.snapshot();
    const plan = planActionRelease({
      version: 'v1.0.0',
      targetSha: firstSha,
      mainSha: snapshot.mainSha,
      targetIsMainAncestor: true,
      refs: snapshot.refs,
      releases: [],
    });
    await repository.pushTags(plan);
    const after = await repository.snapshot();
    expect(after.refs).toEqual({
      v1: { targetSha: firstSha, objectType: 'commit' },
      'v1.0.0': { targetSha: firstSha, objectType: 'commit' },
    });
    await repository.close();
  });

  test('main lease prevents tagging a revision after authoritative main advances', async () => {
    const { remote, work, firstSha } = await fixture();
    const repository = GitActionReleaseRepository.forTest(remote, 'test-token');
    const snapshot = await repository.snapshot();
    const stalePlan = planActionRelease({
      version: 'v1.0.0',
      targetSha: firstSha,
      mainSha: snapshot.mainSha,
      targetIsMainAncestor: true,
      refs: snapshot.refs,
      releases: [],
    });
    git(work, 'commit', '--allow-empty', '--quiet', '-m', 'advance main');
    git(work, 'push', '--quiet', 'origin', 'main');
    await expect(repository.pushTags(stalePlan)).rejects.toThrow('git command was rejected');
    expect(git(work, 'ls-remote', '--tags', remote, 'refs/tags/v1.0.0')).toBe('');
    await repository.close();
  });

  test('force-with-lease rejects a stale major-alias plan atomically', async () => {
    const { remote, work, firstSha } = await fixture();
    git(work, 'tag', 'v1.0.0', firstSha);
    git(work, 'tag', 'v1', firstSha);
    git(work, 'push', '--quiet', 'origin', 'refs/tags/v1.0.0', 'refs/tags/v1');
    git(work, 'commit', '--allow-empty', '--quiet', '-m', 'second');
    const secondSha = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '--quiet', 'origin', 'main');

    const repository = GitActionReleaseRepository.forTest(remote, 'test-token');
    const snapshot = await repository.snapshot();
    const stalePlan = planActionRelease({
      version: 'v1.1.0',
      targetSha: secondSha,
      mainSha: snapshot.mainSha,
      targetIsMainAncestor: true,
      refs: snapshot.refs,
      releases: [stableRelease('v1.0.0')],
    });

    git(work, 'commit', '--allow-empty', '--quiet', '-m', 'side target');
    const sideSha = git(work, 'rev-parse', 'HEAD');
    git(work, 'tag', '--force', 'v1', sideSha);
    git(work, 'push', '--quiet', '--force', 'origin', 'refs/tags/v1');

    await expect(repository.pushTags(stalePlan)).rejects.toThrow('git command was rejected');
    expect(git(work, 'ls-remote', '--tags', remote, 'refs/tags/v1.1.0')).toBe('');
    expect(git(work, 'ls-remote', '--tags', remote, 'refs/tags/v1').split(/\s/)[0]).toBe(sideSha);
    await repository.close();
  });

  test('reports annotated version tags so policy rejects indirect object identity', async () => {
    const { remote, work, firstSha } = await fixture();
    git(work, 'tag', '-a', 'v1.0.0', firstSha, '-m', 'annotated');
    git(work, 'push', '--quiet', 'origin', 'refs/tags/v1.0.0');
    const repository = GitActionReleaseRepository.forTest(remote);
    const snapshot = await repository.snapshot();
    expect(snapshot.refs['v1.0.0']?.objectType).toBe('tag');
    expect(() =>
      planActionRelease({
        version: 'v1.0.0',
        targetSha: firstSha,
        mainSha: snapshot.mainSha,
        targetIsMainAncestor: true,
        refs: snapshot.refs,
        releases: [],
      }),
    ).toThrow('must point directly to a commit');
    await repository.close();
  });

  test('removes temporary repository state when remote initialization fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'action-release-cleanup-test-'));
    directories.push(root);
    const repository = GitActionReleaseRepository.forTest(join(root, 'missing.git'), undefined, root);
    await expect(repository.snapshot()).rejects.toThrow('git command was rejected');
    expect(await readdir(root)).toEqual([]);
    await repository.close();
  });

  test('removes temporary state when credential helper setup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'action-release-askpass-test-'));
    directories.push(root);
    const repository = GitActionReleaseRepository.forTest(join(root, 'remote.git'), 'test-token', root, {
      beforeAskpass: async (directory) => {
        await mkdir(join(directory, 'askpass.mjs'));
      },
    });
    await expect(repository.snapshot()).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
    await repository.close();
  });

  test('terminates credential-bearing process descendants before returning a timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'action-release-process-test-'));
    directories.push(root);
    const script = join(root, 'parent.mjs');
    const marker = join(root, 'late-write');
    await writeFile(
      script,
      `import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'late'), 150)", process.argv[2]], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await expect(
      runActionReleaseProcess(
        process.execPath,
        [script, marker],
        root,
        { PATH: process.env.PATH ?? '', HOME: root },
        [0],
        { timeoutMs: 50, maxOutputBytes: 1024 },
      ),
    ).rejects.toThrow('git command timed out');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await expect(access(marker)).rejects.toThrow();
  });
});
