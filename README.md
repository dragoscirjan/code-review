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

| Input                     | Default                         | Description                                                                  |
| ------------------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| `github-token`            | Required                        | PAT for PR API access and publication.                                       |
| `model-config`            | Required                        | Provider/model JSON above.                                                   |
| `model-credentials`       | `{}`                            | Secret JSON credential map; only the selected credential enters the backend. |
| `backend`                 | `opencode`                      | `opencode` or `pi`.                                                          |
| `container-engine`        | `podman`                        | `podman` or validated `docker` fallback.                                     |
| `prompt`                  | Correctness and security review | Additional trusted review guidance.                                          |
| `opencode-version`        | `1.18.31`                       | Exact npm package version.                                                   |
| `pi-version`              | `0.85.1`                        | Exact npm package version.                                                   |
| `code-indexer`            | `none`                          | `none`, `cgc` or `gitnexus`; exact base revision only.                       |
| `code-index-cache-key`    | `code-review-index-v1`          | Cache key prefix.                                                            |
| `code-index-cache-ttl`    | `24h`                           | Maximum cache age (`ms`, `s`, `m`, `h`, `d`).                                |
| `max-diff-bytes`          | `120000`                        | Maximum model-visible diff bytes; only complete diff hunks are included.     |
| `minimum-confidence`      | `0`                             | Inclusive confidence threshold from `0` through `1`.                         |
| `max-inline-comments`     | `0`                             | Inline comment cap from `0` through `10`; `0` keeps summary-only behavior.   |
| `deterministic-analyzers` | `none`                          | `none` or `base-config`; trusted workflow gate for fixed parse-only checks.  |
| `timeout-seconds`         | `600`                           | Backend timeout.                                                             |

Outputs: `comment-url`, `review-url`, `inline-comment-count`, `inline-history-suppressed-count`, `inline-limit-omitted-count`, `diff-truncated`, `context-truncated`, `context-unavailable-source-count`, `review-mode`, `new-finding-count`, `unchanged-finding-count`, `resolved-finding-count`, `superseded-finding-count`, `analyzer-coverage`, `analyzer-run-count`, `analyzer-observation-count`, `analyzer-skipped-file-count`, `code-indexer`, `code-index-cache-hit`.

## Deterministic analyzers

A trusted workflow may set `deterministic-analyzers: base-config`. The action then reads only `.github/code-review-analyzers.json` from the captured **base SHA**. A PR cannot enable analyzers for itself. Missing configuration disables analysis; malformed, truncated, duplicate-keyed, unknown, or capability-expanding configuration fails closed. The exact version 1 schema accepts only fixed analyzer IDs/rules and limits that tighten the defaults:

```json
{
  "version": 1,
  "analyzers": [
    { "id": "conflict-markers", "rules": ["unresolved-conflict-marker"] },
    { "id": "typescript-syntax", "rules": ["syntax-error"] },
    { "id": "json-syntax", "rules": ["syntax-error", "duplicate-property"] }
  ],
  "limits": {
    "maximumFiles": 32,
    "maximumFileBytes": 262144,
    "maximumTotalBytes": 4194304,
    "maximumObservations": 50,
    "timeoutSeconds": 30,
    "contextBytes": 12000
  }
}
```

The initial adapters are fixed, in-process, single-file parsers. They never invoke a shell, package manager, repository binary, project compiler, build/test script, dependency installer, plugin, import resolver, native config, or autofix. Exact-head files are fetched individually through GitHub as bounded regular UTF-8 files and remain in memory; repository paths never become command arguments. Executable bits and shebangs are inert text. NUL/binary, symlink/submodule, oversized, stale, unavailable, or parser-resource-limited supported inputs are skipped with partial coverage rather than called clean. Unsupported files remain outside the deterministic analyzer scope and are still covered by the normal model review.

Analyzer work is limited to at most 32 files, 256 KiB per file, 64 KiB per line, 4 MiB total source, 50 normalized observations, and a 30-second phase; exact-base configuration can only tighten these defaults. Fetch timeouts are derived from the phase time remaining, and the deadline is checked after each fetch and parser call. Because parsing stays in-process, one synchronous TypeScript or JSON parser call cannot be forcibly interrupted mid-call; fixed source ceilings bound that call, parser exceptions become partial coverage, and elapsed-time enforcement resumes immediately afterward.

Every observation is bound to fixed tool/rule/version provenance and an immutable input/result digest, then remapped to one exact `RIGHT` addition with evidence copied from the authoritative diff. Raw parser messages are bounded untrusted context and never become publication prose. Trusted fixed rule text is merged with model findings through the same evidence, secret, deduplication, ten-finding, inline-history, and publication controls. Partial analyzer coverage is visible in the summary/outputs and prevents the incremental completed-through cursor from advancing. Analyzer manifest and result digests are part of lifecycle reuse binding.

Project-aware type checking, dependency resolution, builds, tests, plugins, downloaded rules, arbitrary commands, deleted-line analysis, and repository-defined analyzer versions remain unsupported.

## Incremental reviews

The managed summary stores a bounded, public, versioned state envelope immediately before its actor-owned final marker. State is bound to the API host, repository, pull request, backend, actor, base revision, and a versioned review-input digest. That digest covers non-secret policy/model settings, fixed review-policy/result-contract/fingerprint/state semantic versions, bounded authoritative PR title/body/author, the supplemental-context digest, and linked-issue fingerprints. Missing or mismatched input binding forces a full review. State contains only host-generated digests, fingerprints, anchors, locations, lifecycle/publication counts, and coverage metadata—never prompts, credentials, endpoints with secrets, or raw model prose.

The action builds and fingerprints current bounded context before permitting reuse. On a synchronize event, it uses incremental selection only when the previous completed head is a proven strict ancestor and both bounded compare responses are complete and consistent. The compare selects current-PR files for review but never authorizes a finding; every result must still map to the authoritative current PR diff with exact evidence. Unchanged findings in untouched files are carried only after unique host-side remapping proves their anchor still exists and their hunk was omitted. If truncated coverage omits an affected prior finding or cannot remap it uniquely, the action aborts before backend execution or publication. Rebases, amended or divergent histories, base changes, unavailable/truncated compares, review-input changes, malformed or unknown metadata, and incomplete prior coverage otherwise fall back to a full current review without guessing.

Each inline finding uses a full SHA-256 fingerprint marker. Actor-owned historical markers suppress duplicate inline comments across retries and synchronize events, including a retry after inline publication succeeded but summary publication failed. Historical suppression runs before the configured inline limit, so later new findings fill available capacity; history-suppressed and limit-omitted counts are reported separately. Legacy summaries are migrated by a full baseline review; legacy batch-only inline reviews suppress inline output for that migration generation because their individual findings cannot be identified safely. A truncated model-visible diff never advances the completed-through cursor.

GitHub does not provide an atomic transaction across inline review creation and summary update, an idempotency key for review creation, or compare-and-swap comment updates. State/body leases and repeated freshness checks prevent known stale overwrites, but workflow concurrency with cancellation remains required to reduce the residual concurrent first-create race.

## Review context

The action derives at most six language-aware lexical anchors from the exact complete diff hunks sent to the model. Changed additions and deletions take priority, while enclosing context declarations are a fallback; renamed files query the base index with their old path while retaining side-specific provenance. When `code-indexer` is selected, the action queries the pinned adapter in a fixed order for definitions/types, callers/tests, callees, hierarchy, and relevant configuration. Each query has a 5-second and 16 KB acquisition limit; the whole query phase is bounded to 45 seconds and 128 KB before deterministic packing into a 50 KB supplemental-context envelope.

Root `AGENTS.md` and `CONTRIBUTING.md` are read only from the captured base SHA. Independently of indexer selection, the action includes at most four allowlisted configuration files and 8 KB selected by changed-path proximity and lexical path, such as `package.json`, TypeScript/JavaScript project configs, `Cargo.toml`, `go.mod`, Python project configs, and supported build files. Acceptance criteria are fetched for at most three explicit same-repository references: canonical issue URLs or closing-keyword forms such as `Fixes #23`. Bare mentions, pull-request URLs, code-fenced references, and cross-repository references are not fetched. Optional context requests have bounded deadlines. Missing, timed-out, truncated, and unavailable sources are reported in the managed summary and action outputs.

Repository guidance, issue criteria, PR metadata, paths, symbols, index output, deterministic analyzer labels/messages, and the diff all remain untrusted data inside collision-checked prompt boundaries. They cannot replace the immutable safety rules, tool denial, output contract, finding validation, or publication policy.

## Security and limitations

- GitHub-hosted runners and GitHub PAT publication. Pi still uses its CLI for this milestone.
- No PR code execution. The diff, exact-base guidance, linked issue criteria, bounded index results, and analyzer messages are untrusted prompt data. Deterministic analyzers parse bounded in-memory text only.
- The backend container is digest-pinned, mount-free, non-root, read-only, capability-dropped, resource-limited and denies added privileges. OpenCode denies all tools; Pi disables tools and resource discovery.
- Native harness configuration is generated in container tmpfs with restrictive permissions. Fixed provider naming avoids built-in provider auto-configuration. Native interpolation syntax in credentials is handled without executing commands or loading referenced files.
- GitHub credentials never enter the model container. Only the selected model credential is passed through environment—not arguments or prompt. Every validated credential value, including unused entries, remains host-side and is masked, scanned against the complete assembled prompt, redacted from findings, and included in the final publication scan. Output is bounded and raw provider errors are suppressed.
- `network` permission and DNS/address preflight checks are **not an egress firewall**. DNS can change after checking; harness SDKs control redirects. Trust the endpoint and its redirect behavior. npm/package code also has container network access and the selected credential. A credential-isolating model gateway with enforced egress is future work.
- Private HTTP is not encrypted. Prefer TLS and authenticated private endpoints.
- Backends must return the strict version 1 JSON review contract; malformed, unknown-version, or oversized output is rejected without repair. The action strictly parses the model-visible unified diff, accepts only findings on exact added/deleted lines with exact changed-line evidence, removes anchor duplicates deterministically, and applies the configured confidence and inline limits. Rejected finding prose is never published.
- The action snapshots the PR base/head, changed-file count, title, body, and author around diff acquisition, checks them again before backend execution and publication, and refreshes fetched issue fingerprints. It also checks freshness between inline and summary publication. Inline findings are submitted in one pull-request review bound to the reviewed head SHA, then the managed summary is updated. GitHub offers neither a transaction spanning those two endpoints nor an atomic create-if-marker-absent operation: if the summary update fails after inline success, the action fails and a deterministic owned marker lets a retry reuse the inline review, but two truly concurrent first-time runs can still race. Keep workflow concurrency cancellation enabled. A force-push after the final pre-write check can make the SHA-bound review outdated but cannot move it to the replacement head.
- Managed comments require both a backend-specific hidden marker and the authenticated PAT actor. Incremental metadata is public and treated as untrusted: malformed, unknown, oversized, ambiguous, stale, or scope-mismatched state is ignored for optimization and triggers a full baseline review. Legacy OpenRouter markers migrate without creating a new comment. PAT comments appear as the token's owner.

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
