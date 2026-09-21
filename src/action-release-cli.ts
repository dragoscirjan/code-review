import { GitActionReleaseRepository } from './action-release-git';
import { GitHubActionReleaseStore } from './action-release-github';
import { inspectActionRelease, publishActionRelease } from './action-release-publisher';

export interface ActionReleaseCliEnvironment {
  GITHUB_TOKEN?: string;
}

interface CliOptions {
  mode: 'plan' | 'publish';
  version: string;
  repository: string;
  expectedMainSha?: string;
}

function parseArguments(args: readonly string[]): CliOptions {
  const mode = args[0];
  if (mode !== 'plan' && mode !== 'publish') {
    throw new Error(
      'usage: action-release <plan|publish> --version <vMAJOR.MINOR.PATCH> --repository <owner/name> [--expected-main-sha <sha>]',
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
  if (!version || !repository) throw new Error('version and repository are required');
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
    const input = { version: options.version, expectedMainSha: options.expectedMainSha };
    if (options.mode === 'plan') {
      const plan = await inspectActionRelease(input, repository, releases);
      console.log(JSON.stringify(plan, null, 2));
    } else {
      const result = await publishActionRelease(
        { version: options.version, expectedMainSha: options.expectedMainSha as string },
        repository,
        releases,
      );
      console.log(JSON.stringify(result, null, 2));
    }
    return 0;
  } catch {
    console.error('Action release failed; details suppressed');
    return 1;
  }
}
