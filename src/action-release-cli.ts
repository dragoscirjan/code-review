import type { ActionReleaseBump } from './action-release';
import { GitActionReleaseRepository } from './action-release-git';
import { GitHubActionReleaseStore } from './action-release-github';
import { inspectActionRelease, publishActionRelease } from './action-release-publisher';

export interface ActionReleaseCliEnvironment {
  GITHUB_TOKEN?: string;
}

interface CliOptions {
  mode: 'plan' | 'publish';
  version?: string;
  bump?: ActionReleaseBump;
  repository: string;
  expectedMainSha?: string;
}

function parseArguments(args: readonly string[]): CliOptions {
  const mode = args[0];
  if (mode !== 'plan' && mode !== 'publish') {
    throw new Error(
      'usage: action-release plan <--version vMAJOR.MINOR.PATCH|--bump major|minor|patch> --repository <owner/name> [--expected-main-sha <sha>]; publish requires --version',
    );
  }
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !name ||
      !value ||
      !['--version', '--bump', '--repository', '--expected-main-sha'].includes(name) ||
      values.has(name)
    ) {
      throw new Error('invalid action release arguments');
    }
    values.set(name, value);
  }
  const version = values.get('--version');
  const rawBump = values.get('--bump');
  const repository = values.get('--repository');
  if (!repository || Number(Boolean(version)) + Number(Boolean(rawBump)) !== 1) {
    throw new Error('repository and exactly one release selector are required');
  }
  if (rawBump && rawBump !== 'major' && rawBump !== 'minor' && rawBump !== 'patch') {
    throw new Error('invalid action release bump');
  }
  if (mode === 'publish' && !version) throw new Error('publication requires an exact version');
  return {
    mode,
    version,
    bump: rawBump as ActionReleaseBump | undefined,
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
      const selection = options.version ? { version: options.version } : { bump: options.bump as ActionReleaseBump };
      const plan = await inspectActionRelease(
        { ...selection, expectedMainSha: options.expectedMainSha },
        repository,
        releases,
      );
      console.log(JSON.stringify(plan, null, 2));
    } else {
      const result = await publishActionRelease(
        { version: options.version as string, expectedMainSha: options.expectedMainSha as string },
        repository,
        releases,
      );
      console.log(JSON.stringify(result, null, 2));
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const safeMessage =
      message.startsWith('Action release failed:') || message.startsWith('Action release aborted:')
        ? message
        : 'Action release failed; details suppressed';
    console.error(safeMessage);
    return 1;
  }
}
