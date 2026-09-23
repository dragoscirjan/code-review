export interface ActionReleaseVersion {
  tag: string;
  majorTag: string;
  major: string;
  minor: string;
  patch: string;
}

export interface ActionReleaseRef {
  targetSha: string;
  objectType: string;
}

export interface ActionReleaseRecord {
  tagName: string;
  draft: boolean;
  prerelease: boolean;
}

export interface ActionReleaseState {
  refs: Readonly<Record<string, ActionReleaseRef>>;
  releases: readonly ActionReleaseRecord[];
}

export type ActionReleaseBump = 'major' | 'minor' | 'patch';

export interface ActionReleaseBaseline {
  currentVersion: ActionReleaseVersion | null;
  latestVersion: ActionReleaseVersion | null;
  latestTargetSha: string | null;
}

export interface ResolveActionReleaseVersionInput extends ActionReleaseState {
  commitMessages: readonly string[];
  targetSha: string;
}

export interface ActionReleasePlan {
  version: ActionReleaseVersion;
  targetSha: string;
  observedMainSha: string;
  majorTargetSha: string;
  observedMajorTargetSha: string | null;
  latestMajorVersion: string | null;
  createVersionTag: boolean;
  updateMajorTag: boolean;
  createGitHubRelease: boolean;
  noop: boolean;
}

export interface PlanActionReleaseInput extends ActionReleaseState {
  version: string;
  targetSha: string;
  mainSha: string;
  targetIsMainAncestor: boolean;
}

interface ParsedVersion extends ActionReleaseVersion {
  numbers: readonly [bigint, bigint, bigint];
}

const VERSION_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAJOR_TAG_PATTERN = /^v(0|[1-9]\d*)$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const CONVENTIONAL_COMMIT_PATTERN = /^([a-z][a-z0-9-]*)(?:\(([^)\r\n]+)\))?(!)?: (.+)$/;
const FOOTER_BLOCK_START_PATTERN = /^(?:(?:BREAKING CHANGE|BREAKING-CHANGE|[A-Za-z0-9-]+):|[A-Za-z0-9-]+ #)/;
const BREAKING_CHANGE_PATTERN = /^(?:BREAKING CHANGE|BREAKING-CHANGE):(.*)$/gm;
const MAX_RELEASE_COMMITS = 1000;
const MAX_COMMIT_HISTORY_BYTES = 1024 * 1024;

function releaseError(message: string): Error {
  return new Error(`Invalid action release: ${message}`);
}

function containsAsciiControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function hasBreakingChangeFooter(message: string): boolean {
  let end = message.length;
  while (end > 0 && message[end - 1] === '\n') end -= 1;
  const paragraphs = message.slice(0, end).split('\n\n');
  let found = false;
  for (let index = paragraphs.length - 1; index > 0; index -= 1) {
    const footerBlock = paragraphs[index] as string;
    if (!FOOTER_BLOCK_START_PATTERN.test(footerBlock)) break;
    for (const match of footerBlock.matchAll(BREAKING_CHANGE_PATTERN)) {
      const breakingDescription = match[1] as string;
      if (
        !breakingDescription.startsWith(' ') ||
        breakingDescription.slice(1).trim().length === 0 ||
        containsAsciiControl(breakingDescription.slice(1))
      ) {
        throw releaseError('commit history contains an invalid breaking-change footer');
      }
      found = true;
    }
  }
  return found;
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

function validateRef(value: ActionReleaseRef, tag: string): ActionReleaseRef {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'objectType,targetSha'
  ) {
    throw releaseError(`ref ${tag} must have exactly objectType and targetSha`);
  }
  if (value.objectType !== 'commit') {
    throw releaseError(`ref ${tag} must point directly to a commit`);
  }
  assertCommitSha(value.targetSha, `target for ${tag}`);
  return value;
}

function validateRelease(value: ActionReleaseRecord): ActionReleaseRecord {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'draft,prerelease,tagName' ||
    typeof value.tagName !== 'string' ||
    typeof value.draft !== 'boolean' ||
    typeof value.prerelease !== 'boolean'
  ) {
    throw releaseError('GitHub Release records must have exactly tagName, draft, and prerelease');
  }
  return value;
}

interface ValidatedActionReleaseState {
  versionRefs: ReadonlyMap<string, { version: ParsedVersion; targetSha: string }>;
  releasedVersions: readonly { version: ParsedVersion; targetSha: string }[];
  releaseTags: ReadonlySet<string>;
}

function readValidatedState(state: ActionReleaseState): ValidatedActionReleaseState {
  const versionRefs = new Map<string, { version: ParsedVersion; targetSha: string }>();
  for (const [tag, rawRef] of Object.entries(state.refs)) {
    if (!tag.startsWith('v')) continue;
    const isVersion = VERSION_PATTERN.test(tag);
    if (!isVersion && !MAJOR_TAG_PATTERN.test(tag)) {
      throw releaseError(`unsupported or ambiguous version ref ${tag}`);
    }
    const ref = validateRef(rawRef, tag);
    if (isVersion) {
      versionRefs.set(tag, { version: parseVersion(tag), targetSha: ref.targetSha });
    }
  }

  const releaseTags = new Set<string>();
  for (const rawRelease of state.releases) {
    const release = validateRelease(rawRelease);
    const tag = release.tagName;
    if (!VERSION_PATTERN.test(tag)) {
      if (tag.startsWith('v')) throw releaseError(`unsupported or ambiguous release tag ${tag}`);
      continue;
    }
    if (releaseTags.has(tag)) throw releaseError(`duplicate GitHub Release ${tag}`);
    if (release.draft || release.prerelease) {
      throw releaseError(`GitHub Release ${tag} must be published and stable`);
    }
    if (!versionRefs.has(tag)) {
      throw releaseError(`GitHub Release ${tag} has no corresponding immutable tag`);
    }
    releaseTags.add(tag);
  }

  const releasedVersions = [...versionRefs.entries()].filter(([tag]) => releaseTags.has(tag)).map(([, entry]) => entry);
  return { versionRefs, releasedVersions, releaseTags };
}

function assertNoUnexpectedOrphans(state: ValidatedActionReleaseState, requestedTag: string): void {
  for (const tag of state.versionRefs.keys()) {
    if (!state.releaseTags.has(tag) && tag !== requestedTag) {
      throw releaseError(`immutable tag ${tag} has no corresponding published GitHub Release`);
    }
  }
}

function validateState(state: ActionReleaseState, requestedTag: string): ValidatedActionReleaseState {
  const validated = readValidatedState(state);
  assertNoUnexpectedOrphans(validated, requestedTag);
  return validated;
}

function publicVersion(version: ParsedVersion): ActionReleaseVersion {
  return {
    tag: version.tag,
    majorTag: version.majorTag,
    major: version.major,
    minor: version.minor,
    patch: version.patch,
  };
}

export function inspectActionReleaseBaseline(input: ActionReleaseState & { targetSha: string }): ActionReleaseBaseline {
  assertCommitSha(input.targetSha, 'targetSha');
  const state = readValidatedState(input);
  const releasedForTarget = state.releasedVersions
    .filter((entry) => entry.targetSha === input.targetSha)
    .sort((left, right) => compareVersions(left.version, right.version));
  const current = releasedForTarget.at(-1);
  const latest = [...state.releasedVersions].sort((left, right) => compareVersions(left.version, right.version)).at(-1);
  return {
    currentVersion: current ? publicVersion(current.version) : null,
    latestVersion: latest ? publicVersion(latest.version) : null,
    latestTargetSha: latest?.targetSha ?? null,
  };
}

export function deriveActionReleaseBump(commitMessages: readonly string[]): ActionReleaseBump {
  if (!Array.isArray(commitMessages) || commitMessages.length === 0 || commitMessages.length > MAX_RELEASE_COMMITS) {
    throw releaseError(`commit history must contain between 1 and ${MAX_RELEASE_COMMITS} commits`);
  }
  let totalBytes = 0;
  let bump: ActionReleaseBump = 'patch';
  for (const message of commitMessages) {
    if (typeof message !== 'string' || message.length === 0 || message.includes('\0')) {
      throw releaseError('commit history contains an invalid message');
    }
    totalBytes += Buffer.byteLength(message, 'utf8');
    if (totalBytes > MAX_COMMIT_HISTORY_BYTES) throw releaseError('commit history exceeded its byte limit');
    const header = message.split('\n', 1)[0] as string;
    const match = CONVENTIONAL_COMMIT_PATTERN.exec(header);
    if (
      !match ||
      (match[2] !== undefined && containsAsciiControl(match[2])) ||
      containsAsciiControl(match[4] as string)
    ) {
      throw releaseError('commit history contains a non-conventional commit');
    }
    if (match[3] || hasBreakingChangeFooter(message)) {
      bump = 'major';
    } else if (match[1] === 'feat' && bump === 'patch') {
      bump = 'minor';
    }
  }
  return bump;
}

export function resolveActionReleaseVersion(input: ResolveActionReleaseVersionInput): ActionReleaseVersion {
  assertCommitSha(input.targetSha, 'targetSha');
  const state = readValidatedState(input);
  const releasedForTarget = state.releasedVersions
    .filter((entry) => entry.targetSha === input.targetSha)
    .sort((left, right) => compareVersions(left.version, right.version));
  let version = releasedForTarget.at(-1)?.version;

  if (!version) {
    const latest = [...state.releasedVersions]
      .sort((left, right) => compareVersions(left.version, right.version))
      .at(-1);
    if (!latest) {
      version = parseVersion('v1.0.0');
    } else {
      const bump = deriveActionReleaseBump(input.commitMessages);
      let [major, minor, patch] = latest.version.numbers;
      if (bump === 'major') {
        major += 1n;
        minor = 0n;
        patch = 0n;
      } else if (bump === 'minor') {
        minor += 1n;
        patch = 0n;
      } else {
        patch += 1n;
      }
      version = parseVersion(`v${major}.${minor}.${patch}`);
    }
  }

  assertNoUnexpectedOrphans(state, version.tag);
  return publicVersion(version);
}

export function planActionRelease(input: PlanActionReleaseInput): ActionReleasePlan {
  const version = parseVersion(input.version);
  assertCommitSha(input.targetSha, 'targetSha');
  assertCommitSha(input.mainSha, 'mainSha');

  const { releasedVersions, releaseTags } = validateState(input, version.tag);
  const existingVersionTarget = input.refs[version.tag]?.targetSha;
  if (existingVersionTarget && existingVersionTarget !== input.targetSha) {
    throw releaseError(`immutable tag ${version.tag} already points to another commit`);
  }
  const isRetry = existingVersionTarget === input.targetSha;
  if (input.targetSha !== input.mainSha && (!isRetry || !input.targetIsMainAncestor)) {
    throw releaseError('a new target must be the current main revision; retries must remain ancestors of main');
  }

  const sameMajor = releasedVersions
    .filter((entry) => entry.version.major === version.major)
    .sort((left, right) => compareVersions(left.version, right.version));
  const latest = sameMajor.at(-1);
  const comparedWithLatest = latest ? compareVersions(version, latest.version) : 1;
  if (comparedWithLatest < 0 && !isRetry) {
    throw releaseError(`${version.tag} would regress ${version.majorTag} from ${latest?.version.tag}`);
  }

  const majorTargetSha = comparedWithLatest < 0 ? (latest?.targetSha as string) : input.targetSha;
  const currentMajorTarget = input.refs[version.majorTag]?.targetSha;
  if (currentMajorTarget && currentMajorTarget !== majorTargetSha) {
    const knownTargets = new Set(sameMajor.map((entry) => entry.targetSha));
    if (existingVersionTarget) knownTargets.add(existingVersionTarget);
    if (!knownTargets.has(currentMajorTarget)) {
      throw releaseError(`${version.majorTag} does not point to a known release in its major line`);
    }
  }

  const createVersionTag = existingVersionTarget === undefined;
  const updateMajorTag = currentMajorTarget !== majorTargetSha;
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
    observedMainSha: input.mainSha,
    majorTargetSha,
    observedMajorTargetSha: currentMajorTarget ?? null,
    latestMajorVersion: latest?.version.tag ?? null,
    createVersionTag,
    updateMajorTag,
    createGitHubRelease,
    noop: !createVersionTag && !updateMajorTag && !createGitHubRelease,
  };
}
