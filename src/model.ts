import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export type ModelApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages';
export interface ModelConnection {
  api: ModelApi;
  baseUrl: string;
  network: 'remote' | 'private';
  modelId: string;
  reasoning?: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  credential?: { type: 'bearer' | 'api-key'; value: string };
}

export interface LoadedModelConfiguration {
  connection: ModelConnection;
  credentialValues: readonly string[];
}

function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Model configuration must contain JSON objects');
  }
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).some(
      (key) => ['__proto__', 'constructor', 'prototype'].includes(key) || (keys && !keys.includes(key)),
    )
  ) {
    throw new Error('Unknown field in model configuration or credentials');
  }
  return result;
}

function parse(value: string, name: string): unknown {
  if (Buffer.byteLength(value, 'utf8') > 32_000) {
    throw new Error(`${name} exceeds 32000 bytes`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // JSON parser errors can include a fragment of a credential.
    throw new Error(`${name} must be valid JSON`);
  }
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) {
    throw new Error('Invalid model identifier or credential reference');
  }
  return value;
}

function tokenLimit(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2_000_000) {
    throw new Error(`${name} must be an integer between 1 and 2000000`);
  }
  return value;
}

export function loadModelConfiguration(
  config: string,
  credentials = '{}',
  reasoning = false,
): LoadedModelConfiguration {
  const root = object(parse(config, 'model-config'), ['version', 'provider', 'model']);
  if (root.version !== 1) throw new Error('model-config version must be 1');
  const provider = object(root.provider, ['api', 'baseUrl', 'network', 'credential']);
  const model = object(root.model, ['id', 'contextWindow', 'maxOutputTokens']);
  const api = provider.api;
  if (api !== 'openai-completions' && api !== 'openai-responses' && api !== 'anthropic-messages') {
    throw new Error('Unsupported model API; use openai-completions, openai-responses or anthropic-messages');
  }
  if (provider.network !== 'remote' && provider.network !== 'private') {
    throw new Error('provider.network must explicitly authorize remote or private source transmission');
  }
  if (typeof provider.baseUrl !== 'string' || provider.baseUrl.length > 2048 || /[\s{}$!\\?#]/.test(provider.baseUrl)) {
    throw new Error('Invalid provider baseUrl');
  }
  let url: URL;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    throw new Error('Invalid provider baseUrl');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['https:', 'http:'].includes(url.protocol) ||
    (provider.network === 'remote' && url.protocol !== 'https:')
  ) {
    throw new Error(
      'Provider URL requires HTTPS for remote access and must not contain credentials, query or fragment',
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || isLoopback(host)) {
    throw new Error('Container loopback is not the runner host; configure a reachable private endpoint');
  }
  const entries = object(parse(credentials, 'model-credentials'));
  if (Object.keys(entries).length > 16) throw new Error('At most 16 model credentials are accepted');
  const validated = new Map<string, NonNullable<ModelConnection['credential']>>();
  for (const [name, entry] of Object.entries(entries)) {
    identifier(name);
    const auth = object(entry, ['type', 'value']);
    if (
      (auth.type !== 'bearer' && auth.type !== 'api-key') ||
      typeof auth.value !== 'string' ||
      !auth.value.length ||
      auth.value.length > 8192 ||
      /[^\x21-\x7e]/.test(auth.value)
    ) {
      throw new Error(
        'Model credentials require type bearer or api-key and a nonempty printable token without whitespace',
      );
    }
    validated.set(name, { type: auth.type, value: auth.value });
  }
  let credential: ModelConnection['credential'];
  if (provider.credential !== undefined) {
    credential = validated.get(identifier(provider.credential));
    if (!credential) throw new Error('Selected provider credential is missing from model-credentials');
  }
  if (api === 'anthropic-messages' ? credential?.type !== 'api-key' : credential && credential.type !== 'bearer') {
    throw new Error(
      'Anthropic Messages requires api-key authentication; OpenAI APIs accept bearer authentication or no credential',
    );
  }
  // Pi auto-detects Anthropic OAuth by token content and changes wire auth.
  // This contract promises x-api-key consistently across both harnesses.
  if (api === 'anthropic-messages' && credential?.value.includes('sk-ant-oat')) {
    throw new Error('Anthropic OAuth tokens are unsupported; supply an Anthropic API key');
  }
  const contextWindow = tokenLimit(model.contextWindow, 'contextWindow', 128_000);
  const maxOutputTokens = tokenLimit(model.maxOutputTokens, 'maxOutputTokens', 8_192);
  if (maxOutputTokens >= contextWindow) throw new Error('maxOutputTokens must be less than contextWindow');
  return {
    connection: {
      api,
      baseUrl: url.href.replace(/\/$/, ''),
      network: provider.network,
      modelId: identifier(model.id),
      reasoning,
      contextWindow,
      maxOutputTokens,
      credential,
    },
    credentialValues: [...validated.values()].map((entry) => entry.value),
  };
}

export function loadModelConnection(config: string, credentials = '{}', reasoning = false): ModelConnection {
  return loadModelConfiguration(config, credentials, reasoning).connection;
}

const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  privateAddresses.addSubnet(address, prefix, 'ipv4');
}
privateAddresses.addSubnet('fc00::', 7, 'ipv6');
const reservedAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) {
  reservedAddresses.addSubnet(address, prefix, 'ipv4');
}
reservedAddresses.addSubnet('2001::', 23, 'ipv6');
reservedAddresses.addSubnet('2001:db8::', 32, 'ipv6');
reservedAddresses.addSubnet('2002::', 16, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

function isLoopback(address: string): boolean {
  return address === '::1' || /^127\./.test(address);
}

export function addressAllowed(address: string, network: ModelConnection['network']): boolean {
  const family = isIP(address);
  if (!family) return false;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  const privateAddress = privateAddresses.check(address, type);
  if (network === 'private') return privateAddress;
  return !privateAddress && !reservedAddresses.check(address, type) && (family === 4 || globalV6.check(address, type));
}

export async function validateModelEndpoint(
  connection: ModelConnection,
  resolve: (host: string) => Promise<{ address: string }[]> = (host) => lookup(host, { all: true }),
  timeoutMs = 5_000,
): Promise<void> {
  const host = new URL(connection.baseUrl).hostname.replace(/^\[|\]$/g, '');
  // These names are provided by the container engine, not the runner's DNS.
  if (connection.network === 'private' && ['host.docker.internal', 'host.containers.internal'].includes(host)) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    const addresses = isIP(host)
      ? [{ address: host }]
      : await Promise.race([
          resolve(host),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), Math.max(1, Math.min(5_000, timeoutMs)));
          }),
        ]);
    if (!addresses.length || addresses.some(({ address }) => !addressAllowed(address, connection.network))) {
      throw new Error('address not allowed');
    }
  } catch {
    throw new Error('Model endpoint resolution failed or violates the explicit remote/private network policy');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join('[REDACTED]');
    const escaped = JSON.stringify(secret).slice(1, -1);
    result = result.split(escaped).join('[REDACTED]');
  }
  return result;
}
