import { GitActionReleaseRepository } from './action-release-git';
import { GitHubActionReleaseStore } from './action-release-github';
import { inspectActionRelease, publishActionRelease } from './action-release-publisher';

export interface ActionReleaseCliEnvironment {
  GITHUB_TOKEN?: string;
}

/**
 * Fixed, host-generated validation messages that carry no remote-derived or untrusted content.
 * These are safe to surface verbatim so operators see why a release plan failed closed; every
 * other error (including release-state messages that interpolate remote tag names) stays
 * suppressed.
 */
const SAFE_INVALID_RELEASE_MESSAGES = new Set([
  'commit history contains an invalid breaking-change footer',
  'version must use canonical stable vMAJOR.MINOR.PATCH syntax',
  'commit history must contain between 1 and 1000 commits',
  'commit history contains an invalid message',
  'commit history exceeded its byte limit',
  'commit history contains a non-conventional commit',
  'GitHub Release records must have exactly tagName, draft, and prerelease',
  'a new target must be the current main revision; retries must remain ancestors of main',
]);

const INVALID_RELEASE_PREFIX = 'Invalid action release: ';

/** Maps a thrown release error to the operator-visible message without leaking untrusted content. */
export function safeReleaseErrorMessage(message: string): string {
  if (message.startsWith('Action release failed:') || message.startsWith('Action release aborted:')) return message;
  if (
    message.startsWith(INVALID_RELEASE_PREFIX) &&
    SAFE_INVALID_RELEASE_MESSAGES.has(message.slice(INVALID_RELEASE_PREFIX.length))
  ) {
    return message;
  }
  return 'Action release failed; details suppressed';
}

interface CliOptions {
  mode: 'plan' | 'publish';
  version?: string;
  repository: string;
  expectedMainSha?: string;
}

function parseArguments(args: readonly string[]): CliOptions {
  const mode = args[0];
  if (mode !== 'plan' && mode !== 'publish') {
    throw new Error(
      'usage: action-release plan [--version vMAJOR.MINOR.PATCH] --repository <owner/name> [--expected-main-sha <sha>]; publish requires --version',
    );
  }
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !value || !['--version', '--repository', '--expected-main-sha'].includes(name) || values.has(name)) {
      throw new Error('invalid action release arguments');
    }
    values.set(name, value);
  }
  const version = values.get('--version');
  const repository = values.get('--repository');
  if (!repository) throw new Error('repository is required');
  if (mode === 'publish' && !version) throw new Error('publication requires an exact version');
  return {
    mode,
    version,
    repository,
    expectedMainSha: values.get('--expected-main-sha'),
  };
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  environment: ActionReleaseCliEnvironment = process.env,
): Promise<number> {
  try {
    const options = parseArguments(args);
    const token = environment.GITHUB_TOKEN;
    if (options.mode === 'publish' && !token) throw new Error('publication token is required');
    if (options.mode === 'publish' && !options.expectedMainSha) {
      throw new Error('publication requires the validated main revision');
    }
    const repository = GitActionReleaseRepository.production(options.repository, token);
    const releases = new GitHubActionReleaseStore(options.repository, token);
    if (options.mode === 'plan') {
      const plan = await inspectActionRelease(
        { version: options.version, expectedMainSha: options.expectedMainSha },
        repository,
        releases,
      );
      console.log(JSON.stringify(plan, null, 2));
    } else {
      const result = await publishActionRelease(
        {
          version: options.version as string,
          expectedMainSha: options.expectedMainSha as string,
        },
        repository,
        releases,
      );
      console.log(JSON.stringify(result, null, 2));
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    console.error(safeReleaseErrorMessage(message));
    return 1;
  }
}
