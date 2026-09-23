import { describe, expect, test } from 'vitest';
import {
  deriveActionReleaseBump,
  inspectActionReleaseBaseline,
  parseActionReleaseVersion,
  planActionRelease,
  resolveActionReleaseVersion,
} from '../src/action-release';

const MAIN_SHA = '1111111111111111111111111111111111111111';
const PRIOR_SHA = '2222222222222222222222222222222222222222';
const OTHER_SHA = '3333333333333333333333333333333333333333';

function ref(targetSha: string, objectType = 'commit') {
  return { targetSha, objectType };
}

function release(tagName: string, overrides: Partial<{ draft: boolean; prerelease: boolean }> = {}) {
  return { tagName, draft: false, prerelease: false, ...overrides };
}

function plan(overrides: Partial<Parameters<typeof planActionRelease>[0]> = {}): ReturnType<typeof planActionRelease> {
  return planActionRelease({
    version: 'v1.2.3',
    targetSha: MAIN_SHA,
    mainSha: MAIN_SHA,
    targetIsMainAncestor: true,
    refs: {},
    releases: [],
    ...overrides,
  });
}

function resolve(
  commitMessages: readonly string[] = ['fix(#57): change release behavior'],
  overrides: Partial<Parameters<typeof resolveActionReleaseVersion>[0]> = {},
): ReturnType<typeof resolveActionReleaseVersion> {
  return resolveActionReleaseVersion({
    commitMessages,
    targetSha: MAIN_SHA,
    refs: {},
    releases: [],
    ...overrides,
  });
}

describe('parseActionReleaseVersion', () => {
  test('parses canonical stable versions and derives the major alias', () => {
    expect(parseActionReleaseVersion('v0.0.0')).toEqual({
      tag: 'v0.0.0',
      majorTag: 'v0',
      major: '0',
      minor: '0',
      patch: '0',
    });
    expect(parseActionReleaseVersion('v12345678901234567890.2.3')).toEqual({
      tag: 'v12345678901234567890.2.3',
      majorTag: 'v12345678901234567890',
      major: '12345678901234567890',
      minor: '2',
      patch: '3',
    });
  });

  test.each([
    '1.2.3',
    'v1',
    'v1.2',
    'v01.2.3',
    'v1.02.3',
    'v1.2.03',
    'v1.2.3-rc.1',
    'v1.2.3+build',
    ' v1.2.3',
    'v1.2.3\n',
  ])('rejects noncanonical version %j', (version) => {
    expect(() => parseActionReleaseVersion(version)).toThrow(
      'version must use canonical stable vMAJOR.MINOR.PATCH syntax',
    );
  });
});

describe('resolveActionReleaseVersion', () => {
  const state = {
    refs: {
      'v1.99.0': ref(OTHER_SHA),
      v1: ref(OTHER_SHA),
      'v2.3.9': ref(PRIOR_SHA),
      v2: ref(PRIOR_SHA),
    },
    releases: [release('v2.3.9'), release('v1.99.0')],
  };

  test('establishes v1.0.0 for the first stable release without reading historical commits', () => {
    expect(resolve([])).toEqual({
      tag: 'v1.0.0',
      majorTag: 'v1',
      major: '1',
      minor: '0',
      patch: '0',
    });
  });

  test('derives patch, minor, and major versions from conventional commits', () => {
    expect(resolve(['fix(#57): correct release behavior'], state).tag).toBe('v2.3.10');
    expect(resolve(['docs(#57): update notes', 'feat(#57): automate releases'], state).tag).toBe('v2.4.0');
    expect(resolve(['feat(#57)!: replace release contract'], state).tag).toBe('v3.0.0');
    expect(resolve(['fix(#57): update behavior\n\nBREAKING CHANGE: replace the public contract'], state).tag).toBe(
      'v3.0.0',
    );
    expect(resolve(['fix(#57): update behavior\n\nBREAKING-CHANGE: replace the public contract'], state).tag).toBe(
      'v3.0.0',
    );
    expect(
      resolve(
        ['fix(#57): update behavior\n\nBREAKING CHANGE: replace the public contract\n\nSigned-off-by: A <a@b>'],
        state,
      ).tag,
    ).toBe('v3.0.0');
    expect(
      resolve(
        ['fix(#57): clarify documentation\n\nThe previous output included:\nBREAKING CHANGE: example text'],
        state,
      ).tag,
    ).toBe('v2.3.10');
  });

  test('uses the highest release as baseline and returns an existing target version idempotently', () => {
    expect(inspectActionReleaseBaseline({ ...state, targetSha: MAIN_SHA })).toEqual({
      currentVersion: null,
      latestVersion: { tag: 'v2.3.9', majorTag: 'v2', major: '2', minor: '3', patch: '9' },
      latestTargetSha: PRIOR_SHA,
    });
    expect(
      resolve([], {
        refs: { 'v1.2.3': ref(MAIN_SHA), v1: ref(MAIN_SHA) },
        releases: [release('v1.2.3')],
      }).tag,
    ).toBe('v1.2.3');
  });

  test('recovers only the orphan tag selected by current commit history', () => {
    const partial = {
      refs: { 'v1.2.2': ref(PRIOR_SHA), 'v1.2.3': ref(MAIN_SHA), v1: ref(MAIN_SHA) },
      releases: [release('v1.2.2')],
    };
    expect(resolve(['fix(#57): complete publication'], partial).tag).toBe('v1.2.3');
    expect(() => resolve(['feat(#57): complete publication'], partial)).toThrow(
      'immutable tag v1.2.3 has no corresponding published GitHub Release',
    );
  });

  test('rejects malformed, empty, excessive, and oversized conventional commit history', () => {
    expect(() => deriveActionReleaseBump([])).toThrow('commit history must contain between 1 and 1000 commits');
    expect(() => deriveActionReleaseBump(['not conventional'])).toThrow('non-conventional commit');
    expect(() => deriveActionReleaseBump(['fix(#57): bad\tcontrol'])).toThrow('non-conventional commit');
    expect(() => deriveActionReleaseBump(['fix(#57): change\n\nBREAKING CHANGE: bad\tcontrol'])).toThrow(
      'invalid breaking-change footer',
    );
    expect(() => deriveActionReleaseBump(['fix(#57): change\n\nBREAKING CHANGE:'])).toThrow(
      'invalid breaking-change footer',
    );
    expect(() => deriveActionReleaseBump(['fix(#57): change\n\nBREAKING-CHANGE:   '])).toThrow(
      'invalid breaking-change footer',
    );
    expect(() => deriveActionReleaseBump(Array.from({ length: 1001 }, () => 'fix(#57): change'))).toThrow(
      'commit history must contain between 1 and 1000 commits',
    );
    expect(() => deriveActionReleaseBump([`fix(#57): ${'x'.repeat(1024 * 1024)}`])).toThrow(
      'commit history exceeded its byte limit',
    );
    expect(() => resolve([], state)).toThrow('commit history must contain between 1 and 1000 commits');
    expect(() => resolve(undefined, { targetSha: 'ABC' })).toThrow(
      'targetSha must be a lowercase full 40-character commit SHA',
    );
    expect(() => resolve([], { refs: { 'v1.0.1': ref(PRIOR_SHA) }, releases: [] })).toThrow(
      'immutable tag v1.0.1 has no corresponding published GitHub Release',
    );
  });
});

describe('planActionRelease', () => {
  test('plans the first immutable tag, moving major alias, and GitHub Release', () => {
    expect(plan()).toEqual({
      version: {
        tag: 'v1.2.3',
        majorTag: 'v1',
        major: '1',
        minor: '2',
        patch: '3',
      },
      targetSha: MAIN_SHA,
      observedMainSha: MAIN_SHA,
      majorTargetSha: MAIN_SHA,
      observedMajorTargetSha: null,
      latestMajorVersion: null,
      createVersionTag: true,
      updateMajorTag: true,
      createGitHubRelease: true,
      noop: false,
    });
  });

  test('advances a major alias only from a known earlier release', () => {
    expect(
      plan({
        refs: { 'v1.2.2': ref(PRIOR_SHA), v1: ref(PRIOR_SHA) },
        releases: [release('v1.2.2')],
      }),
    ).toMatchObject({
      majorTargetSha: MAIN_SHA,
      observedMajorTargetSha: PRIOR_SHA,
      latestMajorVersion: 'v1.2.2',
      createVersionTag: true,
      updateMajorTag: true,
      createGitHubRelease: true,
    });
  });

  test('allows an independent release line for another major', () => {
    expect(
      plan({
        version: 'v1.2.3',
        refs: { 'v2.0.0': ref(OTHER_SHA), v2: ref(OTHER_SHA) },
        releases: [release('v2.0.0')],
      }),
    ).toMatchObject({ latestMajorVersion: null, createVersionTag: true, updateMajorTag: true });
  });

  test('supports safe retries after partial or complete publication', () => {
    expect(
      plan({
        refs: { 'v1.2.2': ref(PRIOR_SHA), 'v1.2.3': ref(MAIN_SHA), v1: ref(PRIOR_SHA) },
        releases: [release('v1.2.2')],
      }),
    ).toMatchObject({
      createVersionTag: false,
      updateMajorTag: true,
      createGitHubRelease: true,
      noop: false,
    });
    expect(
      plan({
        refs: { 'v1.2.3': ref(MAIN_SHA), v1: ref(MAIN_SHA) },
        releases: [release('v1.2.3')],
      }),
    ).toMatchObject({
      createVersionTag: false,
      updateMajorTag: false,
      createGitHubRelease: false,
      noop: true,
    });
  });

  test('finishes an existing older release without downgrading the major alias', () => {
    expect(
      plan({
        version: 'v1.2.2',
        targetSha: PRIOR_SHA,
        mainSha: MAIN_SHA,
        targetIsMainAncestor: true,
        refs: { 'v1.2.2': ref(PRIOR_SHA), 'v1.2.3': ref(MAIN_SHA), v1: ref(MAIN_SHA) },
        releases: [release('v1.2.3')],
      }),
    ).toMatchObject({
      targetSha: PRIOR_SHA,
      majorTargetSha: MAIN_SHA,
      observedMajorTargetSha: MAIN_SHA,
      latestMajorVersion: 'v1.2.3',
      createVersionTag: false,
      updateMajorTag: false,
      createGitHubRelease: true,
    });
  });

  test('rejects non-main and malformed commit identities', () => {
    expect(() => plan({ targetSha: OTHER_SHA })).toThrow('a new target must be the current main revision');
    expect(() =>
      plan({
        targetSha: PRIOR_SHA,
        refs: { 'v1.2.3': ref(PRIOR_SHA) },
        targetIsMainAncestor: false,
      }),
    ).toThrow('retries must remain ancestors of main');
    expect(() => plan({ targetSha: 'ABC', mainSha: 'ABC' })).toThrow(
      'targetSha must be a lowercase full 40-character commit SHA',
    );
    expect(() => plan({ mainSha: '1'.repeat(39) })).toThrow('mainSha must be a lowercase full 40-character commit SHA');
  });

  test('rejects immutable-tag conflicts and version regression', () => {
    expect(() => plan({ refs: { 'v1.2.3': ref(OTHER_SHA) } })).toThrow(
      'immutable tag v1.2.3 already points to another commit',
    );
    expect(() =>
      plan({
        refs: { 'v1.2.4': ref(OTHER_SHA), v1: ref(OTHER_SHA) },
        releases: [release('v1.2.4')],
      }),
    ).toThrow('v1.2.3 would regress v1 from v1.2.4');
  });

  test('rejects an alias that cannot be proven to be a known earlier release', () => {
    expect(() => plan({ refs: { v1: ref(OTHER_SHA) } })).toThrow('v1 does not point to a known release');
    expect(() =>
      plan({
        refs: { 'v1.2.2': ref(PRIOR_SHA), v1: ref(OTHER_SHA) },
        releases: [release('v1.2.2')],
      }),
    ).toThrow('v1 does not point to a known release');
  });

  test('ignores unrelated refs without weakening the release namespace', () => {
    expect(plan({ refs: { docs: ref(OTHER_SHA, 'tag') } })).toMatchObject({
      createVersionTag: true,
      updateMajorTag: true,
      createGitHubRelease: true,
    });
  });

  test('rejects orphaned, indirect, or unstable release provenance', () => {
    expect(() => plan({ refs: { 'v1.2.2': ref(PRIOR_SHA) } })).toThrow(
      'immutable tag v1.2.2 has no corresponding published GitHub Release',
    );
    expect(() => plan({ refs: { 'v1.2.3': ref(MAIN_SHA, 'tag') } })).toThrow(
      'ref v1.2.3 must point directly to a commit',
    );
    expect(() =>
      plan({
        refs: { 'v1.2.3': ref(MAIN_SHA) },
        releases: [release('v1.2.3', { draft: true })],
      }),
    ).toThrow('GitHub Release v1.2.3 must be published and stable');
    expect(() =>
      plan({
        refs: { 'v1.2.3': ref(MAIN_SHA) },
        releases: [release('v1.2.3', { prerelease: true })],
      }),
    ).toThrow('GitHub Release v1.2.3 must be published and stable');
  });

  test('rejects malformed or inconsistent existing release state', () => {
    expect(() => plan({ refs: { 'v1.2': ref(PRIOR_SHA) } })).toThrow('unsupported or ambiguous version ref v1.2');
    expect(() => plan({ refs: { 'v1.2.2': ref('ABC') } })).toThrow(
      'target for v1.2.2 must be a lowercase full 40-character commit SHA',
    );
    expect(() => plan({ releases: [release('v1.2.2')] })).toThrow(
      'GitHub Release v1.2.2 has no corresponding immutable tag',
    );
    expect(() =>
      plan({
        refs: { 'v1.2.2': ref(PRIOR_SHA) },
        releases: [release('v1.2.2'), release('v1.2.2')],
      }),
    ).toThrow('duplicate GitHub Release v1.2.2');
    expect(() => plan({ releases: [release('v1.2.3-rc.1')] })).toThrow(
      'unsupported or ambiguous release tag v1.2.3-rc.1',
    );
  });
});
