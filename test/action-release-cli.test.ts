import { afterEach, describe, expect, test, vi } from 'vitest';
import { main } from '../src/action-release-cli';

const MAIN_SHA = '2222222222222222222222222222222222222222';
const SUPPRESSED_ERROR = 'Action release failed; details suppressed';

function captureErrors() {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

afterEach(() => vi.restoreAllMocks());

describe('action release CLI', () => {
  test.each([
    ['trailing flag', ['plan', '--version']],
    ['duplicate flag', ['plan', '--version', 'v1.0.0', '--repository', 'owner/repository', '--version', 'v1.0.1']],
    [
      'unknown flag',
      ['plan', '--version', 'v1.0.0', '--repository', 'owner/repository', '--unknown', 'untrusted-value'],
    ],
    ['multiple selectors', ['plan', '--version', 'v1.0.0', '--bump', 'patch', '--repository', 'owner/repository']],
    ['invalid bump', ['plan', '--bump', 'untrusted-value', '--repository', 'owner/repository']],
    [
      'publication without version',
      ['publish', '--bump', 'patch', '--repository', 'owner/repository', '--expected-main-sha', MAIN_SHA],
    ],
    [
      'publication without bump',
      ['publish', '--version', 'v1.0.0', '--repository', 'owner/repository', '--expected-main-sha', MAIN_SHA],
    ],
  ])('suppresses untrusted argument errors: %s', async (_name, args) => {
    const errors = captureErrors();
    await expect(main(args, {})).resolves.toBe(1);
    expect(errors).toHaveBeenCalledExactlyOnceWith(SUPPRESSED_ERROR);
    expect(JSON.stringify(errors.mock.calls)).not.toContain('untrusted-value');
  });

  test('requires a publication token and validated main revision without echoing either value', async () => {
    const errors = captureErrors();
    await expect(
      main(
        [
          'publish',
          '--version',
          'v1.0.0',
          '--bump',
          'patch',
          '--repository',
          'owner/repository',
          '--expected-main-sha',
          MAIN_SHA,
        ],
        {},
      ),
    ).resolves.toBe(1);
    await expect(
      main(['publish', '--version', 'v1.0.0', '--bump', 'patch', '--repository', 'owner/repository'], {
        GITHUB_TOKEN: 'untrusted-token',
      }),
    ).resolves.toBe(1);
    expect(errors).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenNthCalledWith(1, SUPPRESSED_ERROR);
    expect(errors).toHaveBeenNthCalledWith(2, SUPPRESSED_ERROR);
    expect(JSON.stringify(errors.mock.calls)).not.toContain('untrusted-token');
  });

  test('suppresses release-policy validation containing untrusted input', async () => {
    const errors = captureErrors();
    await expect(main(['plan', '--version', 'v1.0.0-untrusted', '--repository', 'owner/repository'], {})).resolves.toBe(
      1,
    );
    expect(errors).toHaveBeenCalledWith(SUPPRESSED_ERROR);
    expect(JSON.stringify(errors.mock.calls)).not.toContain('v1.0.0-untrusted');
  });

  test('preserves only fixed action-release adapter failure messages', async () => {
    const errors = captureErrors();
    await expect(main(['plan', '--version', 'v1.0.0', '--repository', 'invalid'], {})).resolves.toBe(1);
    expect(errors).toHaveBeenCalledWith('Action release failed: repository must be a canonical GitHub owner/name');
  });
});
