import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CGC_VERSION, DEFAULT_GITNEXUS_VERSION, type CodeIndexer } from './config';
import type { GitHubClient, PullRequestContext, PullRequestDiff } from './github';

const MAX_COMMAND_OUTPUT_BYTES = 5_000_000;
const MAX_INDEX_CONTEXT_BYTES = 50_000;
const INDEX_COMMAND_TIMEOUT_MS = 20 * 60_000;
const INSTALL_COMMAND_TIMEOUT_MS = 10 * 60_000;
const CACHE_SCHEMA = 'index-v1';

export interface CommandOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  killGraceMs?: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: CommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface CacheAdapter {
  isAvailable(): boolean;
  restore(paths: string[], primaryKey: string, restoreKeys: string[]): Promise<string | undefined>;
  save(paths: string[], key: string): Promise<number>;
}

export interface CodeIndexRequest {
  indexer: Exclude<CodeIndexer, 'none'>;
  cacheKey: string;
  cacheTtlMs: number;
  github: GitHubClient;
  pullRequest: PullRequestContext;
  diff: PullRequestDiff;
  environment?: NodeJS.ProcessEnv;
  cache?: CacheAdapter;
  commandRunner?: CommandRunner;
  now?: () => number;
  temporaryRoot?: string;
}

export interface CodeIndexResult {
  indexer: Exclude<CodeIndexer, 'none'>;
  context: string;
  cacheHit: boolean;
}

interface CacheMetadata {
  createdAt: string;
  indexer: Exclude<CodeIndexer, 'none'>;
  version: string;
  repository: string;
  baseSha: string;
  platform: NodeJS.Platform;
  architecture: string;
  schema: string;
}

const defaultCache: CacheAdapter = {
  isAvailable: () => Boolean(process.env.ACTIONS_CACHE_URL || process.env.ACTIONS_RESULTS_URL),
  restore: async (paths, primaryKey, restoreKeys) => {
    const actionsCache = await import('@actions/cache');
    return actionsCache.restoreCache(paths, primaryKey, restoreKeys);
  },
  save: async (paths, key) => {
    const actionsCache = await import('@actions/cache');
    return actionsCache.saveCache(paths, key);
  },
};

function cleanEnvironment(source: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'USER',
    'LOGNAME',
    'SHELL',
    'SYSTEMROOT',
    'COMSPEC',
    'PATHEXT',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
    'LD_LIBRARY_PATH',
    'NIX_LD_LIBRARY_PATH',
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    if (source[name]) {
      environment[name] = source[name];
    }
  }
  environment.HOME = home;
  if (!environment.LD_LIBRARY_PATH && environment.NIX_LD_LIBRARY_PATH) {
    environment.LD_LIBRARY_PATH = environment.NIX_LD_LIBRARY_PATH;
  }
  environment.CI = 'true';
  environment.NO_COLOR = '1';
  return environment;
}

function processGroupExists(child: ReturnType<typeof spawn>): boolean {
  if (!child.pid || process.platform === 'win32') {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminateProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    child.kill(signal);
  }
}

export const runCommand: CommandRunner = async (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.environment,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const timeoutTimer = setTimeout(() => {
      stop(new Error(`${command} timed out after ${options.timeoutMs} ms`));
    }, options.timeoutMs);
    timeoutTimer.unref();

    const clearTimers = (): void => {
      clearTimeout(timeoutTimer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
    };
    const rejectAfterKill = (): void => {
      if (settled || !failure) {
        return;
      }
      terminateProcessGroup(child, 'SIGKILL');
      settled = true;
      clearTimers();
      reject(failure);
    };
    const stop = (error: Error): void => {
      if (failure || settled) {
        return;
      }
      failure = error;
      terminateProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(rejectAfterKill, options.killGraceMs ?? 5_000);
    };
    const append = (current: string, chunk: Buffer): string => {
      if (failure) {
        return current;
      }
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next, 'utf8') > MAX_COMMAND_OUTPUT_BYTES) {
        stop(new Error(`${command} output exceeded 5000000 bytes`));
        return current;
      }
      return next;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', (error) => {
      if (settled || (failure && processGroupExists(child))) {
        return;
      }
      settled = true;
      clearTimers();
      reject(failure ?? error);
    });
    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      clearTimeout(timeoutTimer);
      if (failure && processGroupExists(child)) {
        return;
      }
      if (!failure && code !== 0) {
        const details = `${stdout}\n${stderr}`.trim().slice(-4_000);
        const error = new Error(
          `${command} exited with code ${code ?? 'null'} and signal ${signal ?? 'none'}: ${details}`,
        );
        if (processGroupExists(child)) {
          stop(error);
          return;
        }
        failure = error;
      }
      settled = true;
      clearTimers();
      if (failure) {
        reject(failure);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

function versionFor(indexer: Exclude<CodeIndexer, 'none'>): string {
  return indexer === 'cgc' ? DEFAULT_CGC_VERSION : DEFAULT_GITNEXUS_VERSION;
}

function safeRepositoryId(pullRequest: PullRequestContext): string {
  return createHash('sha256').update(`${pullRequest.owner}/${pullRequest.repository}`).digest('hex').slice(0, 16);
}

function cacheKeys(request: CodeIndexRequest, now: number): { primary: string; restore: string[] } {
  const version = versionFor(request.indexer);
  const prefix = `${request.cacheKey}-${CACHE_SCHEMA}-${request.indexer}-${version}-${process.platform}-${process.arch}-${safeRepositoryId(request.pullRequest)}-`;
  const bucket = Math.floor(now / request.cacheTtlMs);
  const generation =
    process.env.GITHUB_RUN_ID && process.env.GITHUB_RUN_ATTEMPT
      ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
      : randomUUID();
  const revisionPrefix = `${prefix}${request.pullRequest.baseSha}-`;
  return {
    primary: `${revisionPrefix}${bucket}-${generation}`,
    restore: [`${revisionPrefix}${bucket}-`, revisionPrefix],
  };
}

async function cacheIsFresh(
  databasePath: string,
  metadataPath: string,
  request: CodeIndexRequest,
  now: number,
): Promise<CacheMetadata | undefined> {
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Partial<CacheMetadata>;
    const createdAt = Date.parse(metadata.createdAt ?? '');
    const valid =
      metadata.indexer === request.indexer &&
      metadata.version === versionFor(request.indexer) &&
      metadata.repository === `${request.pullRequest.owner}/${request.pullRequest.repository}` &&
      metadata.baseSha === request.pullRequest.baseSha &&
      metadata.platform === process.platform &&
      metadata.architecture === process.arch &&
      metadata.schema === CACHE_SCHEMA &&
      (await databaseHasContent(request.indexer, databasePath)) &&
      Number.isFinite(createdAt) &&
      now - createdAt >= 0 &&
      now - createdAt <= request.cacheTtlMs;
    return valid ? (metadata as CacheMetadata) : undefined;
  } catch {
    return undefined;
  }
}

async function containsRegularFile(path: string): Promise<boolean> {
  try {
    const pending = [path];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) {
        break;
      }
      const details = await lstat(current);
      if (details.isFile() && details.size > 0) {
        return true;
      }
      if (!details.isDirectory()) {
        continue;
      }
      for (const entry of await readdir(current)) {
        pending.push(join(current, entry));
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function databaseHasContent(indexer: Exclude<CodeIndexer, 'none'>, databasePath: string): Promise<boolean> {
  if (indexer === 'cgc') {
    return containsRegularFile(join(databasePath, 'graph'));
  }
  const required = [
    join(databasePath, 'graph', 'gitnexus.json'),
    join(databasePath, 'graph', 'lbug'),
    join(databasePath, 'home', '.gitnexus', 'registry.json'),
  ];
  return (await Promise.all(required.map((path) => containsRegularFile(path)))).every(Boolean);
}

function changedPaths(diff: PullRequestDiff): string[] {
  const paths = new Set<string>();
  if (diff.parsed) {
    for (const file of diff.parsed.files) {
      if (file.apiPath) paths.add(file.apiPath);
      if (paths.size >= 20) break;
    }
    return [...paths];
  }
  // Compatibility for callers constructing prompt-only fixtures; production diff acquisition always supplies parsed data.
  for (const line of diff.text.split(/\r?\n/)) {
    const match = /^\+\+\+ b\/(.+)$/.exec(line);
    if (match?.[1]) paths.add(match[1]);
    if (paths.size >= 20) break;
  }
  return [...paths];
}

export function buildIndexSearchQuery(pullRequest: PullRequestContext, diff: PullRequestDiff): string {
  const files = changedPaths(diff);
  return [`Pull request review: ${pullRequest.title}`, ...files].join(' ').slice(0, 1_000);
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex -- ANSI escape sequences begin with ESC.
  return value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

export function limitIndexContext(value: string): string {
  const bytes = Buffer.from(stripAnsi(value).trim(), 'utf8');
  if (bytes.length <= MAX_INDEX_CONTEXT_BYTES) {
    return bytes.toString('utf8');
  }
  const trailer = Buffer.from('\n[index context truncated]', 'utf8');
  let content = new TextDecoder().decode(bytes.subarray(0, MAX_INDEX_CONTEXT_BYTES - trailer.length));
  while (content.length > 0 && Buffer.byteLength(content, 'utf8') + trailer.length > MAX_INDEX_CONTEXT_BYTES) {
    content = content.slice(0, -1);
  }
  return `${content}${trailer.toString('utf8')}`;
}

async function validateSourceTree(sourcePath: string): Promise<void> {
  const pending = [sourcePath];
  let files = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) {
      break;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const details = await lstat(path);
      if (details.isSymbolicLink()) {
        await rm(path, { force: true });
        continue;
      }
      if (details.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!details.isFile()) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      files += 1;
      bytes += details.size;
      if (files > 100_000) {
        throw new Error('Base-revision source exceeds 100000 files');
      }
      if (details.size > 20_000_000) {
        throw new Error(`Base-revision file exceeds 20000000 bytes: ${path}`);
      }
      if (bytes > 2_000_000_000) {
        throw new Error('Base-revision source exceeds 2000000000 bytes');
      }
    }
  }
}

function parseGitNexusQuery(output: string): string {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error('GitNexus returned no query JSON');
  }
  let value: unknown;
  try {
    value = JSON.parse(output.slice(start, end + 1)) as unknown;
  } catch {
    throw new Error('GitNexus returned malformed query JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('GitNexus query JSON must be an object');
  }
  return JSON.stringify(value, null, 2);
}

async function installCgc(toolsPath: string, options: CommandOptions, runner: CommandRunner): Promise<string> {
  const venv = join(toolsPath, 'cgc');
  await runner('python3', ['-m', 'venv', venv], options);
  const python = join(venv, 'bin', 'python');
  await runner(
    python,
    ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', `codegraphcontext==${DEFAULT_CGC_VERSION}`],
    options,
  );
  return join(venv, 'bin', 'cgc');
}

async function installGitNexus(toolsPath: string, options: CommandOptions, runner: CommandRunner): Promise<string> {
  const prefix = join(toolsPath, 'gitnexus');
  const environment = {
    ...options.environment,
    GITNEXUS_SKIP_OPTIONAL_GRAMMARS: '1',
  };
  await runner(
    'npm',
    [
      'install',
      '--prefix',
      prefix,
      '--no-save',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      `gitnexus@${DEFAULT_GITNEXUS_VERSION}`,
    ],
    { ...options, environment },
  );
  return join(prefix, 'node_modules', '.bin', 'gitnexus');
}

async function indexWithCgc(
  executable: string,
  sourcePath: string,
  databasePath: string,
  searchQuery: string,
  cacheHit: boolean,
  options: CommandOptions,
  runner: CommandRunner,
): Promise<string> {
  const environment = {
    ...options.environment,
    CGC_EMBEDDED_BUFFER_POOL_MB: '512',
  };
  const indexArgs = ['--database', 'kuzudb', '--path', databasePath, 'index', sourcePath, '--no-progress'];
  if (!cacheHit) {
    indexArgs.push('--force');
  }
  await runner(executable, indexArgs, { ...options, environment });
  const result = await runner(
    executable,
    ['--database', 'kuzudb', '--path', databasePath, 'find', 'content', searchQuery],
    { ...options, environment },
  );
  return result.stdout;
}

async function rewriteGitNexusRegistry(databasePath: string, sourcePath: string): Promise<void> {
  const registryPath = join(databasePath, '..', 'home', '.gitnexus', 'registry.json');
  const value = JSON.parse(await readFile(registryPath, 'utf8')) as unknown;
  if (!Array.isArray(value)) {
    throw new Error('GitNexus cache registry must be an array');
  }
  let found = false;
  const entries = value.map((entry) => {
    if (typeof entry !== 'object' || entry === null || (entry as Record<string, unknown>).name !== 'code-review-base') {
      return entry;
    }
    found = true;
    return {
      ...(entry as Record<string, unknown>),
      path: sourcePath,
      storagePath: databasePath,
    };
  });
  if (!found) {
    throw new Error('GitNexus cache registry has no code-review-base entry');
  }
  await writeFile(registryPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');

  for (const name of ['gitnexus.json', 'meta.json']) {
    const metadataPath = join(databasePath, name);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as unknown;
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      throw new Error(`GitNexus ${name} must contain an object`);
    }
    await writeFile(
      metadataPath,
      `${JSON.stringify(
        {
          ...(metadata as Record<string, unknown>),
          repoPath: sourcePath,
          storagePath: databasePath,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
}

async function indexWithGitNexus(
  executable: string,
  sourcePath: string,
  databasePath: string,
  searchQuery: string,
  cacheHit: boolean,
  options: CommandOptions,
  runner: CommandRunner,
): Promise<string> {
  const gitNexusHome = join(databasePath, '..', 'home');
  await mkdir(gitNexusHome, { recursive: true });
  const environment = {
    ...options.environment,
    HOME: gitNexusHome,
    GITNEXUS_STORAGE_PATH: databasePath,
    GITNEXUS_CONTENT_RETENTION: 'symbol',
    GITNEXUS_SKIP_OPTIONAL_GRAMMARS: '1',
  };
  if (cacheHit) {
    await rewriteGitNexusRegistry(databasePath, sourcePath);
  } else {
    await runner(executable, ['analyze', sourcePath, '--index-only', '--skip-git', '--name', 'code-review-base'], {
      ...options,
      environment,
    });
  }
  const result = await runner(executable, ['query', searchQuery, '--repo', 'code-review-base', '--limit', '5'], {
    ...options,
    environment,
  });
  return parseGitNexusQuery(result.stdout);
}

export async function runCodeIndexer(request: CodeIndexRequest): Promise<CodeIndexResult> {
  const now = request.now?.() ?? Date.now();
  const root = request.temporaryRoot ?? process.env.RUNNER_TEMP ?? tmpdir();
  await mkdir(root, { recursive: true });
  const workspace = join(root, 'code-review-index', safeRepositoryId(request.pullRequest), request.indexer);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  const sourcePath = join(workspace, 'source');
  const toolsPath = join(workspace, 'tools');
  const databasePath = join(workspace, 'database');
  const metadataPath = join(databasePath, 'code-review-cache.json');
  const archivePath = join(workspace, 'base.tar.gz');
  const homePath = join(workspace, 'home');
  const runner = request.commandRunner ?? runCommand;
  const cache = request.cache ?? defaultCache;
  const environment = cleanEnvironment(request.environment ?? process.env, homePath);
  const installOptions: CommandOptions = {
    cwd: workspace,
    environment,
    timeoutMs: INSTALL_COMMAND_TIMEOUT_MS,
  };
  const indexOptions: CommandOptions = {
    cwd: sourcePath,
    environment,
    timeoutMs: INDEX_COMMAND_TIMEOUT_MS,
  };
  const keys = cacheKeys(request, now);
  let restoredKey: string | undefined;
  let restoredMetadata: CacheMetadata | undefined;
  let cacheHit = false;

  try {
    await Promise.all([
      mkdir(sourcePath, { recursive: true }),
      mkdir(toolsPath, { recursive: true }),
      mkdir(homePath, { recursive: true }),
    ]);

    if (cache.isAvailable()) {
      try {
        restoredKey = await cache.restore([databasePath], keys.primary, keys.restore);
        restoredMetadata =
          restoredKey === undefined ? undefined : await cacheIsFresh(databasePath, metadataPath, request, now);
        cacheHit = restoredMetadata !== undefined;
        if (restoredKey && !cacheHit) {
          console.log('Ignoring stale code index cache');
          await rm(databasePath, { recursive: true, force: true });
        }
      } catch (error) {
        await rm(databasePath, { recursive: true, force: true });
        console.warn(`Unable to restore code index cache: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      console.log('GitHub Actions cache service is unavailable; indexing without cache');
    }

    await mkdir(databasePath, { recursive: true });
    const archiveBytes = await request.github.downloadRepositoryArchive(
      request.pullRequest,
      request.pullRequest.baseSha,
      archivePath,
    );
    console.log(`Downloaded ${archiveBytes} base-revision archive bytes`);
    await runner(
      'tar',
      ['-xzf', archivePath, '-C', sourcePath, '--strip-components=1', '--no-same-owner', '--no-same-permissions'],
      installOptions,
    );

    await validateSourceTree(sourcePath);

    const executable =
      request.indexer === 'cgc'
        ? await installCgc(toolsPath, installOptions, runner)
        : await installGitNexus(toolsPath, installOptions, runner);
    const searchQuery = buildIndexSearchQuery(request.pullRequest, request.diff);
    const performIndex = async (): Promise<string> =>
      request.indexer === 'cgc'
        ? indexWithCgc(executable, sourcePath, join(databasePath, 'graph'), searchQuery, cacheHit, indexOptions, runner)
        : indexWithGitNexus(
            executable,
            sourcePath,
            join(databasePath, 'graph'),
            searchQuery,
            cacheHit,
            indexOptions,
            runner,
          );
    let queryOutput: string;
    try {
      queryOutput = await performIndex();
    } catch (error) {
      if (!cacheHit) {
        throw error;
      }
      console.warn(
        `Restored code index failed; rebuilding from an empty database: ${error instanceof Error ? error.message : String(error)}`,
      );
      cacheHit = false;
      restoredMetadata = undefined;
      await rm(databasePath, { recursive: true, force: true });
      await mkdir(databasePath, { recursive: true });
      queryOutput = await performIndex();
    }

    const metadata: CacheMetadata = {
      createdAt: restoredMetadata?.createdAt ?? new Date(now).toISOString(),
      indexer: request.indexer,
      version: versionFor(request.indexer),
      repository: `${request.pullRequest.owner}/${request.pullRequest.repository}`,
      baseSha: request.pullRequest.baseSha,
      platform: process.platform,
      architecture: process.arch,
      schema: CACHE_SCHEMA,
    };
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, 'utf8');

    if (cache.isAvailable() && !cacheHit) {
      const saveKey = restoredKey === keys.primary ? `${keys.primary}-repair-${randomUUID()}` : keys.primary;
      try {
        await cache.save([databasePath], saveKey);
      } catch (error) {
        console.warn(`Unable to save code index cache: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const context = limitIndexContext(
      `Indexer: ${request.indexer} ${versionFor(request.indexer)}\nBase revision: ${request.pullRequest.baseSha}\nSearch query: ${searchQuery}\n\n${queryOutput}`,
    );
    return { indexer: request.indexer, context, cacheHit };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
