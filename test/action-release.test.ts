import { describe, expect, test } from 'vitest';
import { parseActionReleaseVersion, planActionRelease } from '../src/action-release';

const MAIN_SHA = '1111111111111111111111111111111111111111';
const PRIOR_SHA = '2222222222222222222222222222222222222222';
const OTHER_SHA = '3333333333333333333333333333333333333333';

function plan(overrides: Partial<Parameters<typeof planActionRelease>[0]> = {}): ReturnType<typeof planActionRelease> {
  return planActionRelease({
    version: 'v1.2.3',
    targetSha: MAIN_SHA,
    mainSha: MAIN_SHA,
    targetIsMainAncestor: true,
    refs: {},
    releaseTags: [],
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
      majorTargetSha: MAIN_SHA,
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
        refs: { 'v1.2.2': PRIOR_SHA, v1: PRIOR_SHA },
        releaseTags: ['v1.2.2'],
      }),
    ).toMatchObject({
      majorTargetSha: MAIN_SHA,
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
        refs: { 'v2.0.0': OTHER_SHA, v2: OTHER_SHA },
        releaseTags: ['v2.0.0'],
      }),
    ).toMatchObject({ latestMajorVersion: null, createVersionTag: true, updateMajorTag: true });
  });

  test('supports safe retries after partial or complete publication', () => {
    expect(
      plan({
        refs: { 'v1.2.2': PRIOR_SHA, 'v1.2.3': MAIN_SHA, v1: PRIOR_SHA },
        releaseTags: ['v1.2.2'],
      }),
    ).toMatchObject({
      createVersionTag: false,
      updateMajorTag: true,
      createGitHubRelease: true,
      noop: false,
    });
    expect(
      plan({
        refs: { 'v1.2.3': MAIN_SHA, v1: MAIN_SHA },
        releaseTags: ['v1.2.3'],
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
        refs: { 'v1.2.2': PRIOR_SHA, 'v1.2.3': MAIN_SHA, v1: MAIN_SHA },
        releaseTags: ['v1.2.3'],
      }),
    ).toMatchObject({
      targetSha: PRIOR_SHA,
      majorTargetSha: MAIN_SHA,
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
        refs: { 'v1.2.3': PRIOR_SHA },
        targetIsMainAncestor: false,
      }),
    ).toThrow('retries must remain ancestors of main');
    expect(() => plan({ targetSha: 'ABC', mainSha: 'ABC' })).toThrow(
      'targetSha must be a lowercase full 40-character commit SHA',
    );
    expect(() => plan({ mainSha: '1'.repeat(39) })).toThrow('mainSha must be a lowercase full 40-character commit SHA');
  });

  test('rejects immutable-tag conflicts and version regression', () => {
    expect(() => plan({ refs: { 'v1.2.3': OTHER_SHA } })).toThrow(
      'immutable tag v1.2.3 already points to another commit',
    );
    expect(() =>
      plan({
        refs: { 'v1.2.4': OTHER_SHA, v1: OTHER_SHA },
        releaseTags: ['v1.2.4'],
      }),
    ).toThrow('v1.2.3 would regress v1 from v1.2.4');
  });

  test('rejects an alias that cannot be proven to be a known earlier release', () => {
    expect(() => plan({ refs: { v1: OTHER_SHA } })).toThrow('v1 does not point to a known release');
    expect(() =>
      plan({
        refs: { 'v1.2.2': PRIOR_SHA, v1: OTHER_SHA },
        releaseTags: ['v1.2.2'],
      }),
    ).toThrow('v1 does not point to a known release');
  });

  test('rejects malformed or inconsistent existing release state', () => {
    expect(() => plan({ refs: { 'v1.2': PRIOR_SHA } })).toThrow('unsupported or ambiguous version ref v1.2');
    expect(() => plan({ refs: { 'v1.2.2': 'ABC' } })).toThrow(
      'target for v1.2.2 must be a lowercase full 40-character commit SHA',
    );
    expect(() => plan({ releaseTags: ['v1.2.2'] })).toThrow('GitHub Release v1.2.2 has no corresponding immutable tag');
    expect(() => plan({ refs: { 'v1.2.2': PRIOR_SHA }, releaseTags: ['v1.2.2', 'v1.2.2'] })).toThrow(
      'duplicate GitHub Release v1.2.2',
    );
    expect(() => plan({ releaseTags: ['v1.2.3-rc.1'] })).toThrow('unsupported or ambiguous release tag v1.2.3-rc.1');
  });
});
