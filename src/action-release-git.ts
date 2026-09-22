import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionReleasePlan, ActionReleaseRef } from './action-release';
import type { ReleaseRepository, ReleaseRepositorySnapshot } from './action-release-publisher';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const PROCESS_TIMEOUT_MS = 30_000;

interface ProcessResult {
  code: number;
  stdout: string;
}

export async function runActionReleaseProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
  allowedCodes: readonly number[] = [0],
  limits: { timeoutMs: number; maxOutputBytes: number } = {
    timeoutMs: PROCESS_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  },
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve, reject) => {
    const useProcessGroup = process.platform !== 'win32';
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      detached: useProcessGroup,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let totalBytes = 0;
    let failure: string | null = null;
    const terminate = () => {
      if (useProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // Fall through to the direct child as a last-resort cleanup path.
        }
      }
      child.kill('SIGKILL');
    };
    const fail = (message: string) => {
      if (failure) return;
      failure = message;
      terminate();
    };
    const timer = setTimeout(() => fail('Action release failed: git command timed out'), limits.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > limits.maxOutputBytes) {
        fail('Action release failed: git command output exceeded its limit');
      } else if (!failure) {
        stdout.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > limits.maxOutputBytes) fail('Action release failed: git command output exceeded its limit');
    });
    child.on('error', () => fail('Action release failed: unable to start git'));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) {
        reject(new Error(failure));
        return;
      }
      const exitCode = code ?? -1;
      if (!allowedCodes.includes(exitCode)) {
        reject(new Error('Action release failed: git command was rejected'));
        return;
      }
      resolve({ code: exitCode, stdout: Buffer.concat(stdout).toString('utf8') });
    });
  });
}

const runProcess = runActionReleaseProcess;

function productionRemote(repository: string): string {
  if (!REPOSITORY_PATTERN.test(repository) || repository.includes('..') || repository.endsWith('.git')) {
    throw new Error('Action release failed: repository must be a canonical GitHub owner/name');
  }
  return `https://github.com/${repository}.git`;
}

export class GitActionReleaseRepository implements ReleaseRepository {
  private directory: string | null = null;
  private gitEnvironment: Record<string, string> | null = null;

  private constructor(
    private readonly remote: string,
    private readonly token: string | undefined,
    private readonly temporaryRoot: string,
    private readonly testHooks?: { beforeAskpass(directory: string): Promise<void> },
  ) {}

  static production(repository: string, token?: string): GitActionReleaseRepository {
    return new GitActionReleaseRepository(productionRemote(repository), token, tmpdir());
  }

  static forTest(
    remote: string,
    token?: string,
    temporaryRoot: string = tmpdir(),
    testHooks?: { beforeAskpass(directory: string): Promise<void> },
  ): GitActionReleaseRepository {
    return new GitActionReleaseRepository(remote, token, temporaryRoot, testHooks);
  }

  private async reset(): Promise<{ directory: string; env: Record<string, string> }> {
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.directory = null;
    this.gitEnvironment = null;
    const directory = await mkdtemp(join(this.temporaryRoot, 'code-review-action-release-'));
    try {
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        HOME: directory,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
      };
      if (this.token) {
        const askpass = join(directory, 'askpass.mjs');
        await this.testHooks?.beforeAskpass(directory);
        await writeFile(
          askpass,
          "#!/usr/bin/env node\nconst prompt=process.argv[2]??'';process.stdout.write(prompt.startsWith('Username')?'x-access-token':(process.env.ACTION_RELEASE_TOKEN??''));\n",
          { encoding: 'utf8', mode: 0o700 },
        );
        await chmod(askpass, 0o700);
        env.GIT_ASKPASS = askpass;
        env.ACTION_RELEASE_TOKEN = this.token;
      }
      this.directory = directory;
      this.gitEnvironment = env;
      await runProcess('git', ['init', '--bare', '--quiet'], directory, env);
      await runProcess('git', ['config', 'core.hooksPath', '/dev/null'], directory, env);
      await runProcess('git', ['remote', 'add', 'origin', this.remote], directory, env);
      await runProcess(
        'git',
        [
          'fetch',
          '--force',
          '--no-tags',
          '--quiet',
          'origin',
          'refs/heads/main:refs/remotes/origin/main',
          '+refs/tags/v*:refs/tags/v*',
        ],
        directory,
        env,
      );
      return { directory, env };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      this.directory = null;
      this.gitEnvironment = null;
      throw error;
    }
  }

  async snapshot(): Promise<ReleaseRepositorySnapshot> {
    const { directory, env } = await this.reset();
    const mainSha = (
      await runProcess('git', ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'], directory, env)
    ).stdout.trim();
    if (!SHA_PATTERN.test(mainSha)) throw new Error('Action release failed: main did not resolve to a commit');
    const refsOutput = (
      await runProcess(
        'git',
        ['for-each-ref', '--format=%(refname)\t%(objecttype)\t%(objectname)', 'refs/tags/v*'],
        directory,
        env,
      )
    ).stdout;
    const refs: Record<string, ActionReleaseRef> = {};
    for (const line of refsOutput.split('\n')) {
      if (!line) continue;
      const fields = line.split('\t');
      if (fields.length !== 3) throw new Error('Action release failed: malformed remote tag listing');
      const [refName, objectType, targetSha] = fields as [string, string, string];
      if (!refName.startsWith('refs/tags/')) throw new Error('Action release failed: malformed remote tag name');
      const tag = refName.slice('refs/tags/'.length);
      if (Object.hasOwn(refs, tag)) throw new Error('Action release failed: duplicate remote tag');
      refs[tag] = { objectType, targetSha };
    }
    return {
      mainSha,
      refs,
      isAncestor: async (commitSha: string) => {
        if (!SHA_PATTERN.test(commitSha)) return false;
        const result = await runProcess(
          'git',
          ['merge-base', '--is-ancestor', commitSha, mainSha],
          directory,
          env,
          [0, 1],
        );
        return result.code === 0;
      },
    };
  }

  async pushTags(plan: ActionReleasePlan): Promise<void> {
    if (!this.token) throw new Error('Action release failed: publication token is required');
    if (!this.directory || !this.gitEnvironment) throw new Error('Action release failed: remote state was not loaded');
    const observedVersionTarget = plan.createVersionTag ? '' : plan.targetSha;
    const args = [
      'push',
      '--atomic',
      '--quiet',
      `--force-with-lease=refs/heads/main:${plan.observedMainSha}`,
      `--force-with-lease=refs/tags/${plan.version.tag}:${observedVersionTarget}`,
    ];
    if (plan.updateMajorTag) {
      args.push(`--force-with-lease=refs/tags/${plan.version.majorTag}:${plan.observedMajorTargetSha ?? ''}`);
    }
    args.push('origin', `${plan.observedMainSha}:refs/heads/main`, `${plan.targetSha}:refs/tags/${plan.version.tag}`);
    if (plan.updateMajorTag) {
      args.push(`${plan.majorTargetSha}:refs/tags/${plan.version.majorTag}`);
    }
    await runProcess('git', args, this.directory, this.gitEnvironment);
  }

  async close(): Promise<void> {
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.directory = null;
    this.gitEnvironment = null;
  }
}
