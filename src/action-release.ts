export interface ActionReleaseVersion {
  tag: string;
  majorTag: string;
  major: string;
  minor: string;
  patch: string;
}

export interface ActionReleaseState {
  refs: Readonly<Record<string, string>>;
  releaseTags: readonly string[];
}

export interface ActionReleasePlan {
  version: ActionReleaseVersion;
  targetSha: string;
  previousMajorVersion: string | null;
  createVersionTag: boolean;
  updateMajorTag: boolean;
  createGitHubRelease: boolean;
  noop: boolean;
}

export interface PlanActionReleaseInput extends ActionReleaseState {
  version: string;
  targetSha: string;
  mainSha: string;
}

interface ParsedVersion extends ActionReleaseVersion {
  numbers: readonly [bigint, bigint, bigint];
}

const VERSION_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAJOR_TAG_PATTERN = /^v(0|[1-9]\d*)$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

function releaseError(message: string): Error {
  return new Error(`Invalid action release: ${message}`);
}

function parseVersion(value: string): ParsedVersion {
  const match = VERSION_PATTERN.exec(value);
  if (!match) {
    throw releaseError('version must use canonical stable vMAJOR.MINOR.PATCH syntax');
  }
  const major = match[1] as string;
  const minor = match[2] as string;
  const patch = match[3] as string;
  return {
    tag: value,
    majorTag: `v${major}`,
    major,
    minor,
    patch,
    numbers: [BigInt(major), BigInt(minor), BigInt(patch)],
  };
}

export function parseActionReleaseVersion(value: string): ActionReleaseVersion {
  const version = parseVersion(value);
  return {
    tag: version.tag,
    majorTag: version.majorTag,
    major: version.major,
    minor: version.minor,
    patch: version.patch,
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < left.numbers.length; index += 1) {
    const leftPart = left.numbers[index] as bigint;
    const rightPart = right.numbers[index] as bigint;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

function assertCommitSha(value: string, name: string): void {
  if (!COMMIT_SHA_PATTERN.test(value)) {
    throw releaseError(`${name} must be a lowercase full 40-character commit SHA`);
  }
}

function validateState(state: ActionReleaseState): {
  fullVersions: readonly { version: ParsedVersion; targetSha: string }[];
  releaseTags: ReadonlySet<string>;
} {
  const fullVersions: { version: ParsedVersion; targetSha: string }[] = [];
  for (const [tag, targetSha] of Object.entries(state.refs)) {
    assertCommitSha(targetSha, `target for ${tag}`);
    if (VERSION_PATTERN.test(tag)) {
      fullVersions.push({ version: parseVersion(tag), targetSha });
      continue;
    }
    if (MAJOR_TAG_PATTERN.test(tag)) continue;
    if (tag.startsWith('v')) {
      throw releaseError(`unsupported or ambiguous version ref ${tag}`);
    }
  }

  const releaseTags = new Set<string>();
  for (const tag of state.releaseTags) {
    if (!VERSION_PATTERN.test(tag)) {
      if (tag.startsWith('v')) throw releaseError(`unsupported or ambiguous release tag ${tag}`);
      continue;
    }
    if (releaseTags.has(tag)) throw releaseError(`duplicate GitHub Release ${tag}`);
    releaseTags.add(tag);
    if (!Object.hasOwn(state.refs, tag)) {
      throw releaseError(`GitHub Release ${tag} has no corresponding immutable tag`);
    }
  }
  return { fullVersions, releaseTags };
}

export function planActionRelease(input: PlanActionReleaseInput): ActionReleasePlan {
  const version = parseVersion(input.version);
  assertCommitSha(input.targetSha, 'targetSha');
  assertCommitSha(input.mainSha, 'mainSha');
  if (input.targetSha !== input.mainSha) {
    throw releaseError('targetSha must equal the current default-branch revision');
  }

  const { fullVersions, releaseTags } = validateState(input);
  const existingVersionTarget = input.refs[version.tag];
  if (existingVersionTarget && existingVersionTarget !== input.targetSha) {
    throw releaseError(`immutable tag ${version.tag} already points to another commit`);
  }

  const sameMajor = fullVersions
    .filter((entry) => entry.version.major === version.major)
    .sort((left, right) => compareVersions(left.version, right.version));
  const latest = sameMajor.at(-1);
  if (latest && compareVersions(version, latest.version) < 0) {
    throw releaseError(`${version.tag} would regress ${version.majorTag} from ${latest.version.tag}`);
  }

  const currentMajorTarget = input.refs[version.majorTag];
  if (currentMajorTarget && currentMajorTarget !== input.targetSha) {
    const knownTargets = new Set(
      sameMajor.filter((entry) => compareVersions(entry.version, version) < 0).map((entry) => entry.targetSha),
    );
    if (!knownTargets.has(currentMajorTarget)) {
      throw releaseError(`${version.majorTag} does not point to a known earlier release in its major line`);
    }
  }

  const createVersionTag = existingVersionTarget === undefined;
  const updateMajorTag = currentMajorTarget !== input.targetSha;
  const createGitHubRelease = !releaseTags.has(version.tag);
  return {
    version: {
      tag: version.tag,
      majorTag: version.majorTag,
      major: version.major,
      minor: version.minor,
      patch: version.patch,
    },
    targetSha: input.targetSha,
    previousMajorVersion: latest && latest.version.tag !== version.tag ? latest.version.tag : null,
    createVersionTag,
    updateMajorTag,
    createGitHubRelease,
    noop: !createVersionTag && !updateMajorTag && !createGitHubRelease,
  };
}
