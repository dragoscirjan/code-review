import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { ModelConnection } from './model';
import { addressAllowed } from './model';

/**
 * Host-side credential-isolating gateway (issue #67).
 *
 * The review container never receives the provider credential. It receives a
 * per-run placeholder and a base URL pointing at this gateway. The gateway
 * forwards to exactly one configured upstream origin, requires the placeholder
 * on the provider's native credential header, and injects the real credential
 * after that authorization. It never logs, never follows redirects for the
 * client, and blocks cross-origin redirects so the harness cannot be steered
 * to another destination while carrying a credential header.
 */

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface CredentialGateway {
  /** Origin the review container uses as the provider base URL. */
  origin: string;
  /** Single-purpose token the container carries instead of the real credential. */
  placeholder: string;
  /** Stops the gateway and destroys open sockets. Resolves when closed. */
  close: () => Promise<void>;
}

export interface CredentialGatewayRequest {
  connection: Pick<ModelConnection, 'api' | 'baseUrl' | 'network'> & {
    credential: { type: 'bearer' | 'api-key'; value: string };
  };
  /** Container-visible hostname alias for the host, chosen by the engine. */
  containerHostAlias: string;
  /** Injectable DNS resolution for tests; defaults to the platform resolver. */
  resolver?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  /** Bounded idle socket time for upstream connections (default 300000 ms). */
  upstreamIdleTimeoutMs?: number;
}

interface UpstreamHeaderPlan {
  name: string;
  prefix: string;
}

export function upstreamCredentialHeader(api: ModelConnection['api']): UpstreamHeaderPlan {
  return api === 'anthropic-messages'
    ? { name: 'x-api-key', prefix: '' }
    : { name: 'authorization', prefix: 'Bearer ' };
}

function stripHopByHop(headers: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const forwarded: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    forwarded[name] = value;
  }
  return forwarded;
}

function requestTarget(request: IncomingMessage): string | undefined {
  // Reject proxy-style absolute-form targets and CONNECT-style tunnel attempts:
  // the gateway forwards paths against one fixed upstream origin only.
  const target = request.url ?? '';
  if (!target.startsWith('/') || target.includes('://')) return undefined;
  return target;
}

export function startCredentialGateway(input: CredentialGatewayRequest): Promise<CredentialGateway> {
  const upstream = new URL(input.connection.baseUrl);
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    return Promise.reject(new Error('Credential gateway requires an http or https provider endpoint'));
  }
  const sendUpstream = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
  // Loopback aliases only exist inside the container. The gateway connects from
  // the host, where those names do not resolve.
  const engineAlias = upstream.hostname === 'host.docker.internal' || upstream.hostname === 'host.containers.internal';
  const upstreamHostnameRaw = engineAlias ? '127.0.0.1' : upstream.hostname;
  const upstreamHostname = upstreamHostnameRaw.replace(/^\[|\]$/g, '');
  const upstreamOrigin = `${upstream.protocol}//${upstream.host}`;
  // Preserve the upstream path prefix (for example /v1) so harness requests
  // forwarded verbatim still land on the provider's real API base path.
  const upstreamPath = upstream.pathname.replace(/\/$/, '');
  const headerPlan = upstreamCredentialHeader(input.connection.api);
  const placeholder = `gw-${randomBytes(24).toString('hex')}`;
  const expectedAuthorization = `${headerPlan.prefix}${placeholder}`;

  // The gateway connects from the host: host-side loopback is the legitimate
  // trusted private-local case (a model server on the runner), while the
  // container-facing loopback remains forbidden by the action configuration.
  const addressAuthorized = (address: string): boolean =>
    input.connection.network === 'private'
      ? addressAllowed(address, 'private') || address === '::1' || /^127\./.test(address)
      : addressAllowed(address, 'remote');

  // Resolve and authorize the destination once, then pin it for every upstream
  // connection (epic #66): DNS is never re-resolved mid-review, so a rebinding
  // or attacker-controlled record cannot move the destination after startup.
  const resolveDestination = async (): Promise<{ address: string; family: number }> => {
    if (engineAlias) {
      // Provided by the container engine, not the runner's DNS; the host-side
      // loopback mapping is by design and skips address classification.
      return { address: '127.0.0.1', family: 4 };
    }
    const literalFamily = isIP(upstreamHostname);
    if (literalFamily) {
      if (!addressAuthorized(upstreamHostname)) {
        throw new Error('Model endpoint address violates the explicit remote/private network policy');
      }
      return { address: upstreamHostname, family: literalFamily };
    }
    const resolver = input.resolver ?? ((host: string) => lookup(host, { all: true }));
    const resolved = await resolver(upstreamHostname);
    if (!resolved.length || resolved.some((entry) => !addressAuthorized(entry.address))) {
      throw new Error('Model endpoint resolution failed or violates the explicit remote/private network policy');
    }
    return { address: resolved[0]!.address, family: resolved[0]!.family };
  };

  return (async () => {
    const pinned = await resolveDestination();
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
      else callback(null, pinned.address, pinned.family);
    };
    const upstreamIdleTimeoutMs = input.upstreamIdleTimeoutMs ?? 300_000;
    const openSockets = new Set<import('node:net').Socket>();
    const server = createServer((request, response) => {
      const authorizationHeader = request.headers[headerPlan.name];
      const presented = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
      if (presented !== expectedAuthorization) {
        response.statusCode = 403;
        response.end();
        return;
      }
      const target = requestTarget(request);
      if (target === undefined || request.method === undefined) {
        response.statusCode = 403;
        response.end();
        return;
      }
      const forwarded: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(stripHopByHop(request.headers))) {
        if (name.toLowerCase() === 'host') continue;
        forwarded[name] = value;
      }
      forwarded[headerPlan.name] = `${headerPlan.prefix}${input.connection.credential.value}`;
      const outgoing = sendUpstream(
        {
          protocol: upstream.protocol,
          hostname: upstreamHostname,
          port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
          method: request.method,
          path: target,
          headers: forwarded,
          // Every connection uses the address pinned at gateway startup; the
          // harness cannot re-resolve DNS through this path. TLS still validates
          // against the original hostname because the node client keeps the
          // hostname for SNI and certificate identity checks.
          lookup: pinnedLookup,
          timeout: upstreamIdleTimeoutMs,
        },
        (upstreamResponse) => {
          const status = upstreamResponse.statusCode ?? 0;
          const location = upstreamResponse.headers.location;
          if (
            status >= 300 &&
            status < 400 &&
            location &&
            new URL(location, upstreamOrigin).origin !== upstreamOrigin
          ) {
            upstreamResponse.destroy();
            response.statusCode = 502;
            response.end();
            return;
          }
          response.writeHead(status, stripHopByHop(upstreamResponse.headers as Record<string, string | string[]>));
          upstreamResponse.pipe(response);
        },
      );
      outgoing.on('timeout', () => outgoing.destroy(new Error('upstream idle timeout')));
      outgoing.on('error', () => {
        if (!response.headersSent) {
          response.statusCode = 502;
          response.end();
          return;
        }
        response.destroy();
      });
      request.pipe(outgoing);
      request.on('error', () => outgoing.destroy());
      response.on('close', () => outgoing.destroy());
    });
    server.on('connection', (socket) => {
      openSockets.add(socket);
      socket.on('close', () => openSockets.delete(socket));
    });

    return new Promise<CredentialGateway>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('Credential gateway did not acquire a port'));
          return;
        }
        resolve({
          origin: `http://${input.containerHostAlias}:${address.port}${upstreamPath}`,
          placeholder,
          close: () =>
            new Promise<void>((resolveClose) => {
              for (const socket of openSockets) socket.destroy();
              server.close(() => resolveClose());
            }),
        });
      });
    });
  })();
}
