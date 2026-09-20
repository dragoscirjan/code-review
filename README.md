# Pull request code review action

A GitHub Action that reviews pull requests with **OpenCode or Pi**, using a configured local/private or remote model endpoint, and publishes one managed summary plus an optional bounded batch of validated inline findings per backend.

## OpenRouter setup / migration

The provider-specific `openrouter-api-key` and `model` inputs have been removed. There is no default provider, free-model fallback, or fixed-model allowlist.

1. Keep your existing **`GH_TOKEN`** GitHub Actions secret (the PAT used to publish comments).
2. Create a GitHub Actions repository secret named **`REVIEW_MODEL_CREDENTIALS`**. Its value is this JSON, replacing the placeholder with your existing OpenRouter API key:

   ```json
   { "review-provider": { "type": "bearer", "value": "YOUR_OPENROUTER_API_KEY" } }
   ```

   You can reuse the key currently stored in `OPENROUTER_API_KEY`; you do not need a new OpenRouter account or key. Never commit this JSON with a real token.

3. Use the workflow below, replacing `REPLACE_WITH_COMMIT_SHA` with an immutable trusted commit **containing this change**. Do not pass the new inputs to an older action revision.

```yaml
name: Code review
on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]
permissions: {}
jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        backend: [opencode, pi]
    concurrency:
      group: code-review-${{ matrix.backend }}-${{ github.event.pull_request.number }}
      cancel-in-progress: true
    steps:
      - uses: dragoscirjan/code-review@REPLACE_WITH_COMMIT_SHA
        with:
          github-token: ${{ secrets.GH_TOKEN }}
          backend: ${{ matrix.backend }}
          model-config: |
            {
              "version": 1,
              "provider": {
                "api": "openai-completions",
                "baseUrl": "https://openrouter.ai/api/v1",
                "network": "remote",
                "credential": "review-provider"
              },
              "model": {
                "id": "z-ai/glm-5.3-flash",
                "contextWindow": 131072,
                "maxOutputTokens": 8192
              }
            }
          model-credentials: ${{ secrets.REVIEW_MODEL_CREDENTIALS }}
          prompt: Focus on correctness, security, regressions, and missing tests.
```

Do not add checkout or execute PR code in this `pull_request_target` job. Never reference the PR branch as the action revision or obtain configuration from PR-controlled content. The repository's own `.github/workflows/code-review.yml` remains pinned to its older trusted commit; update that pin and its inputs together after publishing a reviewed implementation commit. This change does not automatically deploy itself.

## Provider and model configuration

`model-config` is **our strict versioned schema**, not native Pi/OpenCode configuration. The action translates it into the selected harness's native configuration inside its disposable container, before launching the harness. Host/user configuration is never modified.

One invocation selects one provider/model. Use workflow matrices or separate invocations for more. Non-secret configuration can be inline workflow JSON or `${{ vars.REVIEW_MODEL_CONFIG }}`. Secrets belong only in `model-credentials`.

| Field                   | Meaning                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`               | Required; `1`.                                                                                                                                           |
| `provider.api`          | Required; one of the protocols below.                                                                                                                    |
| `provider.baseUrl`      | Required API base URL; no URL credentials, query, fragment, or interpolation.                                                                            |
| `provider.network`      | Required; `remote` explicitly permits sending source to a public HTTPS provider; `private` explicitly permits a private-network endpoint (HTTP allowed). |
| `provider.credential`   | Optional reference into `model-credentials`; never an environment variable or token.                                                                     |
| `model.id`              | Required exact provider model ID, not a Pi/OpenCode selector.                                                                                            |
| `model.contextWindow`   | Positive integer, default `128000`, maximum `2000000`. Set to the model's actual capability.                                                             |
| `model.maxOutputTokens` | Positive integer, default `8192`, strictly below `contextWindow`.                                                                                        |

Unknown fields are rejected. Each JSON input is capped at 32,000 UTF-8 bytes; at most 16 credentials, with tokens limited to 8,192 printable non-whitespace ASCII characters. References/model IDs use letters, digits, `.`, `_`, `:`, `/`, `-` (maximum 200 characters, starting with a letter/digit).

### Protocols and authentication

| API                  | Base URL example                                                      | Credential type                                  |
| -------------------- | --------------------------------------------------------------------- | ------------------------------------------------ |
| `openai-completions` | `https://openrouter.ai/api/v1` or an OpenAI-compatible `/v1` endpoint | `bearer`, or omit credential for keyless servers |
| `openai-responses`   | `https://api.openai.com/v1`                                           | `bearer`, or keyless compatible server           |
| `anthropic-messages` | `https://api.anthropic.com` (**without `/v1`**)                       | Required `api-key` (Anthropic `x-api-key`)       |

For Anthropic, use `{"review-provider":{"type":"api-key","value":"YOUR_ANTHROPIC_API_KEY"}}` as the secret. The adapter accounts for the harnesses' different Anthropic base URL conventions. A bearer credential may be an API key or an already-issued access token; the action does not log in, refresh OAuth tokens, or run credential commands. Anthropic OAuth tokens containing `sk-ant-oat` are rejected because Pi would reinterpret them as OAuth rather than `x-api-key` authentication.

Support means the configured endpoint must implement the selected protocol. It does not imply support for every vendor's native authentication, reasoning options, or proprietary extensions. Google/Azure/Bedrock-specific protocols, arbitrary headers, plugins, shell commands, environment forwarding, raw harness config, and `model-config-file` are not supported in this milestone. Add explicit adapters rather than passing through arbitrary harness settings.

### Existing local/private models

For example, an existing Ollama server exposing its OpenAI-compatible endpoint:

```yaml
with:
  github-token: ${{ secrets.GH_TOKEN }}
  backend: pi
  model-config: |
    {
      "version": 1,
      "provider": {
        "api": "openai-completions",
        "baseUrl": "http://192.168.10.20:11434/v1",
        "network": "private"
      },
      "model": {"id": "qwen2.5-coder:7b", "contextWindow": 32768, "maxOutputTokens": 4096}
    }
```

Omit `model-credentials` for keyless servers. The harness adapters use a non-secret placeholder key for keyless endpoints because Pi and some SDKs require authentication configuration; the server must tolerate that placeholder Authorization header. No models are installed, downloaded, loaded, unloaded, or stopped by the action.

**Networking must already exist.** A GitHub-hosted runner cannot automatically reach your laptop or LAN. Configure trusted private connectivity first. Container `localhost` is not the runner host and is rejected. Podman supports `host.containers.internal`; Docker's `host.docker.internal` receives a host-gateway mapping only when explicitly selected with `network: private`. The server must listen on an address reachable from the container, with appropriate firewall/access controls. Host networking is never enabled. Self-hosted runner support and public-fork isolation remain out of scope.

## Inputs

| Input                  | Default                         | Description                                                                  |
| ---------------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| `github-token`         | Required                        | PAT for PR API access and publication.                                       |
| `model-config`         | Required                        | Provider/model JSON above.                                                   |
| `model-credentials`    | `{}`                            | Secret JSON credential map; only the selected credential enters the backend. |
| `backend`              | `opencode`                      | `opencode` or `pi`.                                                          |
| `container-engine`     | `podman`                        | `podman` or validated `docker` fallback.                                     |
| `prompt`               | Correctness and security review | Additional trusted review guidance.                                          |
| `opencode-version`     | `1.18.31`                       | Exact npm package version.                                                   |
| `pi-version`           | `0.85.1`                        | Exact npm package version.                                                   |
| `code-indexer`         | `none`                          | `none`, `cgc` or `gitnexus`; exact base revision only.                       |
| `code-index-cache-key` | `code-review-index-v1`          | Cache key prefix.                                                            |
| `code-index-cache-ttl` | `24h`                           | Maximum cache age (`ms`, `s`, `m`, `h`, `d`).                                |
| `max-diff-bytes`       | `120000`                        | Maximum model-visible diff bytes; only complete diff hunks are included.     |
| `minimum-confidence`   | `0`                             | Inclusive confidence threshold from `0` through `1`.                         |
| `max-inline-comments`  | `0`                             | Inline comment cap from `0` through `10`; `0` keeps summary-only behavior.   |
| `timeout-seconds`      | `600`                           | Backend timeout.                                                             |

Outputs: `comment-url`, `review-url`, `inline-comment-count`, `diff-truncated`, `context-truncated`, `context-unavailable-source-count`, `code-indexer`, `code-index-cache-hit`.

## Review context

The action derives at most six language-aware lexical anchors from the exact complete diff hunks sent to the model. Changed additions and deletions take priority, while enclosing context declarations are a fallback; renamed files query the base index with their old path while retaining side-specific provenance. When `code-indexer` is selected, the action queries the pinned adapter in a fixed order for definitions/types, callers/tests, callees, hierarchy, and relevant configuration. Each query has a 5-second and 16 KB acquisition limit; the whole query phase is bounded to 45 seconds and 128 KB before deterministic packing into a 50 KB supplemental-context envelope.

Root `AGENTS.md` and `CONTRIBUTING.md` are read only from the captured base SHA. Independently of indexer selection, the action includes at most four allowlisted configuration files and 8 KB selected by changed-path proximity and lexical path, such as `package.json`, TypeScript/JavaScript project configs, `Cargo.toml`, `go.mod`, Python project configs, and supported build files. Acceptance criteria are fetched for at most three explicit same-repository references: canonical issue URLs or closing-keyword forms such as `Fixes #23`. Bare mentions, pull-request URLs, code-fenced references, and cross-repository references are not fetched. Optional context requests have bounded deadlines. Missing, timed-out, truncated, and unavailable sources are reported in the managed summary and action outputs.

Repository guidance, issue criteria, PR metadata, paths, symbols, index output, and the diff all remain untrusted data inside collision-checked prompt boundaries. They cannot replace the immutable safety rules, tool denial, output contract, finding validation, or publication policy.

## Security and limitations

- GitHub-hosted runners and GitHub PAT publication. Pi still uses its CLI for this milestone.
- No PR code execution. The diff, exact-base guidance, linked issue criteria, and bounded index results are untrusted prompt data.
- The backend container is digest-pinned, mount-free, non-root, read-only, capability-dropped, resource-limited and denies added privileges. OpenCode denies all tools; Pi disables tools and resource discovery.
- Native harness configuration is generated in container tmpfs with restrictive permissions. Fixed provider naming avoids built-in provider auto-configuration. Native interpolation syntax in credentials is handled without executing commands or loading referenced files.
- GitHub credentials never enter the model container. Only the selected model credential is passed through environment—not arguments or prompt. Every validated credential value, including unused entries, remains host-side and is masked, scanned against the complete assembled prompt, redacted from findings, and included in the final publication scan. Output is bounded and raw provider errors are suppressed.
- `network` permission and DNS/address preflight checks are **not an egress firewall**. DNS can change after checking; harness SDKs control redirects. Trust the endpoint and its redirect behavior. npm/package code also has container network access and the selected credential. A credential-isolating model gateway with enforced egress is future work.
- Private HTTP is not encrypted. Prefer TLS and authenticated private endpoints.
- Backends must return the strict version 1 JSON review contract; malformed, unknown-version, or oversized output is rejected without repair. The action strictly parses the model-visible unified diff, accepts only findings on exact added/deleted lines with exact changed-line evidence, removes anchor duplicates deterministically, and applies the configured confidence and inline limits. Rejected finding prose is never published.
- The action snapshots the PR base/head, changed-file count, title, body, and author around diff acquisition, checks them again before backend execution and publication, and refreshes fetched issue fingerprints. It also checks freshness between inline and summary publication. Inline findings are submitted in one pull-request review bound to the reviewed head SHA, then the managed summary is updated. GitHub offers neither a transaction spanning those two endpoints nor an atomic create-if-marker-absent operation: if the summary update fails after inline success, the action fails and a deterministic owned marker lets a retry reuse the inline review, but two truly concurrent first-time runs can still race. Keep workflow concurrency cancellation enabled. A force-push after the final pre-write check can make the SHA-bound review outdated but cannot move it to the replacement head.
- Managed comments require both a backend-specific hidden marker and the authenticated PAT actor. Legacy OpenRouter markers migrate to provider-neutral markers without creating a new comment. PAT comments appear as the token's owner.

Optional indexing downloads only the exact base SHA archive with a bounded request deadline. Every archive member is path/type/size preflighted before extraction; total members and directories are capped, and parsing aborts on the first violation. Symlinks, hardlinks, special files, duplicate destinations, file/directory conflicts, traversal, oversized entries, decompression amplification, and invalid restored cache trees are rejected. Repository-controlled indexer configuration and `.env*` files are removed before adapter startup. CGC/GitNexus still run on the host with a credential-stripped environment, which is **not OS isolation**, and their pinned transitive dependencies remain part of the POC trust boundary. Cache identity includes repository, base SHA, pinned indexer, platform and age; successful reads do not renew TTL. An unusable restore gets one clean rebuild. Cache service failures warn; installation/index construction failures for an explicitly selected indexer stop the review, while individual bounded query failures are reported and do not hide other available context.

Design: [Provider-neutral configuration](https://github.com/dragoscirjan/code-review/wiki/Provider-neutral-model-configuration). Work item: [#12](https://github.com/dragoscirjan/code-review/issues/12).

## Development

```bash
npm ci
npm run validate
```

Validation type-checks, runs tests, and rebuilds the committed `dist/index.js`. Unit tests exercise schema/network policy, credential boundaries, both native config translations and the actual bootstrap code using controlled dependencies. Live checks are opt-in:

```bash
# Controlled model responses through real pinned harness containers; no provider secret:
CONTAINER_ENGINE=podman npm run test:models
CONTAINER_ENGINE=docker npm run test:models

# Live provider smoke test (optional, may incur provider charges):
OPENROUTER_API_KEY=... npm run test:integration
GITHUB_TOKEN=... CODE_INDEXER=cgc npm run test:indexers
GITHUB_TOKEN=... CODE_INDEXER=gitnexus npm run test:indexers
```

The live test environment variable is only a test convenience, not a restored action input. See `CONTRIBUTING.md`.
