import { describe, expect, test } from 'vitest';
import type { ActionReleasePlan, ActionReleaseRecord, ActionReleaseRef } from '../src/action-release';
import {
  inspectActionRelease,
  publishActionRelease,
  type GitHubReleaseStore,
  type ReleaseRepository,
  type ReleaseRepositorySnapshot,
} from '../src/action-release-publisher';

const OLD_SHA = '1111111111111111111111111111111111111111';
const MAIN_SHA = '2222222222222222222222222222222222222222';
const NEXT_SHA = '3333333333333333333333333333333333333333';

class FakeRepository implements ReleaseRepository {
  readonly refs: Record<string, ActionReleaseRef>;
  readonly ancestors: ReadonlySet<string>;
  readonly historyBaselines: string[] = [];
  mainSha: string;
  pushes = 0;
  closed = false;
  failPushAfterApplying = false;
  advanceMainAfterPush: string | null = null;

  constructor(
    mainSha: string,
    refs: Record<string, ActionReleaseRef> = {},
    ancestors?: ReadonlySet<string>,
    readonly commitMessages: readonly string[] = ['fix(#57): update release behavior'],
  ) {
    this.mainSha = mainSha;
    this.refs = { ...refs };
    this.ancestors = ancestors ?? new Set([mainSha, ...Object.values(refs).map((value) => value.targetSha)]);
  }

  async snapshot(): Promise<ReleaseRepositorySnapshot> {
    return {
      mainSha: this.mainSha,
      refs: structuredClone(this.refs),
      commitMessagesSince: async (sha) => {
        if (!this.ancestors.has(sha)) throw new Error('baseline is not an ancestor');
        this.historyBaselines.push(sha);
        return [...this.commitMessages];
      },
      isAncestor: async (sha) => this.ancestors.has(sha),
    };
  }

  async pushTags(plan: ActionReleasePlan): Promise<void> {
    this.pushes += 1;
    const observed = this.refs[plan.version.majorTag]?.targetSha ?? null;
    if (observed !== plan.observedMajorTargetSha) throw new Error('stale lease');
    if (plan.createVersionTag) this.refs[plan.version.tag] = { targetSha: plan.targetSha, objectType: 'commit' };
    if (plan.updateMajorTag)
      this.refs[plan.version.majorTag] = { targetSha: plan.majorTargetSha, objectType: 'commit' };
    if (this.advanceMainAfterPush) this.mainSha = this.advanceMainAfterPush;
    if (this.failPushAfterApplying) throw new Error('ambiguous transport failure');
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeReleases implements GitHubReleaseStore {
  readonly records: ActionReleaseRecord[];
  creates = 0;
  failCreateAfterApplying = false;

  constructor(
    records: ActionReleaseRecord[] = [],
    readonly afterCreate?: () => void,
  ) {
    this.records = records;
  }

  async list(): Promise<readonly ActionReleaseRecord[]> {
    return structuredClone(this.records);
  }

  async create(tagName: string): Promise<void> {
    this.creates += 1;
    this.records.push({ tagName, draft: false, prerelease: false });
    this.afterCreate?.();
    if (this.failCreateAfterApplying) throw new Error('ambiguous API failure');
  }
}

const ref = (targetSha: string): ActionReleaseRef => ({ targetSha, objectType: 'commit' });
const release = (tagName: string): ActionReleaseRecord => ({ tagName, draft: false, prerelease: false });

describe('action release publisher', () => {
  test('dry-run planning performs no writes and closes temporary repository state', async () => {
    const repository = new FakeRepository(MAIN_SHA);
    const releases = new FakeReleases();
    const plan = await inspectActionRelease({ expectedMainSha: MAIN_SHA }, repository, releases);
    expect(plan).toMatchObject({
      version: { tag: 'v1.0.0' },
      createVersionTag: true,
      updateMajorTag: true,
      createGitHubRelease: true,
    });
    expect(repository.pushes).toBe(0);
    expect(releases.creates).toBe(0);
    expect(repository.closed).toBe(true);
  });

  test('resolves conventional commit history once against validated remote state', async () => {
    const repository = new FakeRepository(MAIN_SHA, {
      'v1.2.2': ref(OLD_SHA),
      'v1.2.3': ref(MAIN_SHA),
      v1: ref(MAIN_SHA),
    });
    const releases = new FakeReleases([release('v1.2.2')]);
    const plan = await inspectActionRelease({ expectedMainSha: MAIN_SHA }, repository, releases);
    expect(plan).toMatchObject({
      version: { tag: 'v1.2.3' },
      createVersionTag: false,
      updateMajorTag: false,
      createGitHubRelease: true,
    });
    expect(repository.historyBaselines).toEqual([OLD_SHA]);
    expect(repository.closed).toBe(true);
  });

  test('publishes and verifies the first release, including ambiguous successful writes', async () => {
    const repository = new FakeRepository(MAIN_SHA);
    repository.failPushAfterApplying = true;
    const releases = new FakeReleases();
    releases.failCreateAfterApplying = true;
    const result = await publishActionRelease({ version: 'v1.0.0', expectedMainSha: MAIN_SHA }, repository, releases);
    expect(result.plan.noop).toBe(true);
    expect(repository.refs).toEqual({ v1: ref(MAIN_SHA), 'v1.0.0': ref(MAIN_SHA) });
    expect(releases.records).toEqual([release('v1.0.0')]);
  });

  test('finishes an authorized publication when main advances after an ambiguous successful tag push', async () => {
    const repository = new FakeRepository(MAIN_SHA, {}, new Set([MAIN_SHA, NEXT_SHA]));
    repository.advanceMainAfterPush = NEXT_SHA;
    repository.failPushAfterApplying = true;
    const releases = new FakeReleases();
    const result = await publishActionRelease({ version: 'v1.0.0', expectedMainSha: MAIN_SHA }, repository, releases);
    expect(result.plan.noop).toBe(true);
    expect(result.plan.observedMainSha).toBe(NEXT_SHA);
    expect(repository.refs).toEqual({ v1: ref(MAIN_SHA), 'v1.0.0': ref(MAIN_SHA) });
    expect(releases.records).toEqual([release('v1.0.0')]);
  });

  test('rejects a later dispatch after main advances beyond an orphaned immutable tag', async () => {
    const repository = new FakeRepository(NEXT_SHA, { v1: ref(MAIN_SHA), 'v1.0.0': ref(MAIN_SHA) });
    const releases = new FakeReleases();
    await expect(
      publishActionRelease({ version: 'v1.0.0', expectedMainSha: NEXT_SHA }, repository, releases),
    ).rejects.toThrow('immutable tag v1.0.0 already points to another commit');
    expect(repository.pushes).toBe(0);
    expect(releases.creates).toBe(0);
  });

  test('retries partial tag publication and creates only the missing GitHub Release', async () => {
    const repository = new FakeRepository(MAIN_SHA, { v1: ref(MAIN_SHA), 'v1.0.0': ref(MAIN_SHA) });
    const releases = new FakeReleases();
    const result = await publishActionRelease({ version: 'v1.0.0', expectedMainSha: MAIN_SHA }, repository, releases);
    expect(result.plan.noop).toBe(true);
    expect(repository.pushes).toBe(0);
    expect(releases.creates).toBe(1);
  });

  test('publishes an automatically selected minor release and reads history only before mutation', async () => {
    const repository = new FakeRepository(
      MAIN_SHA,
      { 'v1.0.0': ref(OLD_SHA), v1: ref(OLD_SHA) },
      new Set([OLD_SHA, MAIN_SHA]),
      ['feat(#57): automate semantic releases'],
    );
    const releases = new FakeReleases([release('v1.0.0')]);
    const result = await publishActionRelease({ version: 'v1.1.0', expectedMainSha: MAIN_SHA }, repository, releases);
    expect(result.plan.noop).toBe(true);
    expect(repository.refs).toEqual({ v1: ref(MAIN_SHA), 'v1.0.0': ref(OLD_SHA), 'v1.1.0': ref(MAIN_SHA) });
    expect(releases.records).toEqual([release('v1.0.0'), release('v1.1.0')]);
    expect(repository.historyBaselines).toEqual([OLD_SHA, OLD_SHA]);
  });

  test('rejects malformed conventional history before any mutation', async () => {
    const repository = new FakeRepository(
      MAIN_SHA,
      { 'v1.0.0': ref(OLD_SHA), v1: ref(OLD_SHA) },
      new Set([OLD_SHA, MAIN_SHA]),
      ['not a conventional commit'],
    );
    const releases = new FakeReleases([release('v1.0.0')]);
    await expect(
      publishActionRelease({ version: 'v1.0.1', expectedMainSha: MAIN_SHA }, repository, releases),
    ).rejects.toThrow('non-conventional commit');
    expect(repository.pushes).toBe(0);
    expect(releases.creates).toBe(0);
  });

  test('rejects a pinned version when conventional history selects a different release', async () => {
    const repository = new FakeRepository(MAIN_SHA, {
      'v1.0.0': ref(OLD_SHA),
      v1: ref(OLD_SHA),
      'v2.0.0': ref(OLD_SHA),
      v2: ref(OLD_SHA),
    });
    const releases = new FakeReleases([release('v1.0.0'), release('v2.0.0')]);
    await expect(
      publishActionRelease({ version: 'v1.1.0', expectedMainSha: MAIN_SHA }, repository, releases),
    ).rejects.toThrow('selected version no longer matches conventional commit history');
    expect(repository.pushes).toBe(0);
    expect(releases.creates).toBe(0);
  });

  test('rejects a partial retry after main advances beyond its validated target', async () => {
    const repository = new FakeRepository(
      MAIN_SHA,
      { 'v1.0.0': ref(OLD_SHA), 'v1.1.0': ref(MAIN_SHA), v1: ref(MAIN_SHA) },
      new Set([OLD_SHA, MAIN_SHA]),
    );
    const releases = new FakeReleases([release('v1.1.0')]);
    await expect(
      publishActionRelease({ version: 'v1.0.0', expectedMainSha: MAIN_SHA }, repository, releases),
    ).rejects.toThrow('immutable tag v1.0.0 has no corresponding published GitHub Release');
    expect(repository.pushes).toBe(0);
    expect(releases.creates).toBe(0);
  });

  test('fails closed when current main differs from the validated workflow revision', async () => {
    const repository = new FakeRepository(MAIN_SHA);
    await expect(
      publishActionRelease({ version: 'v1.0.0', expectedMainSha: OLD_SHA }, repository, new FakeReleases()),
    ).rejects.toThrow('current main does not match');
    expect(repository.pushes).toBe(0);
  });

  test('rejects draft release state before any tag mutation', async () => {
    const repository = new FakeRepository(MAIN_SHA, { 'v1.0.0': ref(MAIN_SHA) });
    const releases = new FakeReleases([{ tagName: 'v1.0.0', draft: true, prerelease: false }]);
    await expect(
      publishActionRelease({ version: 'v1.0.0', expectedMainSha: MAIN_SHA }, repository, releases),
    ).rejects.toThrow('must be published and stable');
    expect(repository.pushes).toBe(0);
  });

  test('rejects immutable tag movement before final verification', async () => {
    const repository = new FakeRepository(MAIN_SHA, {}, new Set([OLD_SHA, MAIN_SHA]));
    const releases = new FakeReleases([], () => {
      repository.refs['v1.0.0'] = ref(OLD_SHA);
      repository.refs.v1 = ref(OLD_SHA);
    });
    await expect(
      publishActionRelease({ version: 'v1.0.0', expectedMainSha: MAIN_SHA }, repository, releases),
    ).rejects.toThrow('immutable release target changed during publication');
  });
});
