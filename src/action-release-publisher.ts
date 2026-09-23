import type { ActionReleasePlan, ActionReleaseRecord, ActionReleaseState } from './action-release';
import {
  inspectActionReleaseBaseline,
  parseActionReleaseVersion,
  planActionRelease,
  resolveActionReleaseVersion,
} from './action-release';

export interface ReleaseRepositorySnapshot {
  mainSha: string;
  refs: ActionReleaseState['refs'];
  commitMessagesSince(commitSha: string): Promise<readonly string[]>;
  isAncestor(commitSha: string): Promise<boolean>;
}

export interface ReleaseRepository {
  snapshot(): Promise<ReleaseRepositorySnapshot>;
  pushTags(plan: ActionReleasePlan): Promise<void>;
  close(): Promise<void>;
}

export interface GitHubReleaseStore {
  list(): Promise<readonly ActionReleaseRecord[]>;
  create(tagName: string, targetSha: string): Promise<void>;
}

export interface ActionReleasePublisherInput {
  version?: string;
  expectedMainSha?: string;
}

export interface PublishActionReleaseInput {
  version: string;
  expectedMainSha: string;
}

export interface ActionReleaseResult {
  plan: ActionReleasePlan;
  published: boolean;
}

async function planFromRemote(
  input: ActionReleasePublisherInput,
  repository: ReleaseRepository,
  releases: GitHubReleaseStore,
  requiredTargetSha?: string,
  validateSelection = true,
): Promise<ActionReleasePlan> {
  const exactVersion = input.version === undefined ? undefined : parseActionReleaseVersion(input.version);
  const snapshot = await repository.snapshot();
  if (input.expectedMainSha && snapshot.mainSha !== input.expectedMainSha) {
    throw new Error('Action release aborted: current main does not match the validated workflow revision');
  }
  const targetRevision = input.expectedMainSha ?? snapshot.mainSha;
  const releaseRecords = await releases.list();
  let resolvedVersion;
  if (!exactVersion || validateSelection) {
    const baseline = inspectActionReleaseBaseline({
      targetSha: targetRevision,
      refs: snapshot.refs,
      releases: releaseRecords,
    });
    const commitMessages =
      baseline.currentVersion || !baseline.latestTargetSha
        ? []
        : await snapshot.commitMessagesSince(baseline.latestTargetSha);
    resolvedVersion = resolveActionReleaseVersion({
      commitMessages,
      targetSha: targetRevision,
      refs: snapshot.refs,
      releases: releaseRecords,
    });
  }
  if (exactVersion && resolvedVersion && exactVersion.tag !== resolvedVersion.tag) {
    throw new Error('Action release aborted: selected version no longer matches conventional commit history');
  }
  const selectedVersion = exactVersion ?? resolvedVersion;
  if (!selectedVersion) throw new Error('Action release failed: no release version was selected');
  const targetSha =
    requiredTargetSha === undefined
      ? (input.expectedMainSha ?? snapshot.refs[selectedVersion.tag]?.targetSha ?? snapshot.mainSha)
      : (snapshot.refs[selectedVersion.tag]?.targetSha ?? snapshot.mainSha);
  const targetIsMainAncestor = targetSha === snapshot.mainSha || (await snapshot.isAncestor(targetSha));
  const plan = planActionRelease({
    version: selectedVersion.tag,
    targetSha,
    mainSha: snapshot.mainSha,
    targetIsMainAncestor,
    refs: snapshot.refs,
    releases: releaseRecords,
  });
  if (requiredTargetSha && plan.targetSha !== requiredTargetSha) {
    throw new Error('Action release failed: immutable release target changed during publication');
  }
  return plan;
}

export async function inspectActionRelease(
  input: ActionReleasePublisherInput,
  repository: ReleaseRepository,
  releases: GitHubReleaseStore,
): Promise<ActionReleasePlan> {
  try {
    return await planFromRemote(input, repository, releases);
  } finally {
    await repository.close();
  }
}

function tagsMatchPlan(plan: ActionReleasePlan, next: ActionReleasePlan): boolean {
  return (
    next.targetSha === plan.targetSha &&
    next.majorTargetSha === plan.majorTargetSha &&
    !next.createVersionTag &&
    !next.updateMajorTag
  );
}

export async function publishActionRelease(
  input: PublishActionReleaseInput,
  repository: ReleaseRepository,
  releases: GitHubReleaseStore,
): Promise<ActionReleaseResult> {
  try {
    const initialPlan = await planFromRemote(input, repository, releases);
    const requiredTargetSha = initialPlan.targetSha;
    // A second authoritative read immediately before mutation prevents executing a stale dry-run plan.
    let plan = await planFromRemote(input, repository, releases, requiredTargetSha);
    // Once mutation starts, verify only the captured version and target so an unrelated main advance cannot strand it.
    const exactInput: ActionReleasePublisherInput = { version: input.version };
    let published = false;

    if (plan.createVersionTag || plan.updateMajorTag) {
      try {
        await repository.pushTags(plan);
        published = true;
      } catch {
        const afterConflict = await planFromRemote(exactInput, repository, releases, requiredTargetSha, false);
        if (!tagsMatchPlan(plan, afterConflict)) {
          throw new Error('Action release failed: tag publication conflicted with changed remote state');
        }
        published = true;
        plan = afterConflict;
      }
      const afterTags = await planFromRemote(exactInput, repository, releases, requiredTargetSha, false);
      if (!tagsMatchPlan(plan, afterTags)) {
        throw new Error('Action release failed: published tags did not verify against remote state');
      }
      plan = afterTags;
    }

    if (plan.createGitHubRelease) {
      try {
        await releases.create(plan.version.tag, plan.targetSha);
        published = true;
      } catch {
        const afterConflict = await planFromRemote(exactInput, repository, releases, requiredTargetSha, false);
        if (afterConflict.createGitHubRelease) {
          throw new Error('Action release failed: GitHub Release creation did not reach the requested stable state');
        }
        published = true;
      }
    }

    const verified = await planFromRemote(exactInput, repository, releases, requiredTargetSha, false);
    if (!verified.noop) {
      throw new Error('Action release failed: final remote state is incomplete');
    }
    return { plan: verified, published };
  } finally {
    await repository.close();
  }
}
