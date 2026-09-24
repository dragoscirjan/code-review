# Pull request code review action

A GitHub Action that reviews pull requests with **OpenCode or Pi**, using a configured local/private or remote model endpoint, and publishes one managed summary plus an optional bounded batch of validated inline findings per backend.

## Use the released action

Use the moving major tag for the supported stable v1 channel:

```yaml
- uses: dragoscirjan/code-review@v1
```

Use the immutable full-version tag when reproducibility is more important than automatically receiving compatible v1 updates:

```yaml
- uses: dragoscirjan/code-review@v1.0.0
```

`vMAJOR.MINOR.PATCH` tags are immutable. A moving `vMAJOR` tag advances only through the guarded release workflow to a validated stable release in the same major line. Branch names such as `main`, pull request refs, and arbitrary commit references are not supported release channels.

## OpenRouter setup / migration

The provider-specific `openrouter-api-key` and `model` inputs have been removed. There is no default provider, free-model fallback, or fixed-model allowlist.

The free-form `prompt` input has also been removed. Review behavior now comes only from the action's fixed, versioned policy. Workflows upgrading to this revision must delete `prompt`; supplying it fails closed instead of being ignored. Repository guidance, linked issue criteria, pull-request metadata, index results, analyzer messages, and diffs remain explicitly delimited untrusted data rather than trusted instructions.

1. Keep your existing **`GH_TOKEN`** GitHub Actions secret (the PAT used to publish comments).
2. Create a GitHub Actions repository secret named **`REVIEW_MODEL_CREDENTIALS`**. Its value is this JSON, replacing the placeholder with your existing OpenRouter API key:

   ```json
   { "review-provider": { "type": "bearer", "value": "YOUR_OPENROUTER_API_KEY" } }
   ```

   You can reuse the key currently stored in `OPENROUTER_API_KEY`; you do not need a new OpenRouter account or key. Never commit this JSON with a real token.

3. Use the workflow below. It follows the supported stable v1 channel; replace `@v1` with `@v1.0.0` if you require an immutable full-version pin.

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
      - uses: dragoscirjan/code-review@v1
        with:
          github-token: ${{ secrets.GH_TOKEN }}
          backend: ${{ matrix.backend }}
          reasoning: true
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
                "contextWindow": 1048576,
                "maxOutputTokens": 943718
              }
            }
          model-credentials: ${{ secrets.REVIEW_MODEL_CREDENTIALS }}
```

Do not add checkout or execute PR code in this `pull_request_target` job. Never reference the PR branch, `main`, or another mutable branch as the action revision, and never obtain configuration from PR-controlled content.

## GitHub App authentication

`github-token` accepts either a personal access token or a short-lived GitHub App installation token. The action derives its identity from the token itself (`GET /user`, documented as supported for GitHub App installation access tokens; installation requests are attributed to the app's `bot-name[bot]` user) and binds managed-comment ownership, inline reviews, and incremental-reuse scope to that identity, so both credential kinds work without any action-side key handling.

Recommended setup uses the official [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token) action to mint an installation token one step ahead of the review; the App private key never leaves GitHub Secrets and never reaches the checkout, model prompt, sandbox, logs, or published output:

```yaml
permissions: {}
jobs:
  review:
    runs-on: ubuntu-24.04
    steps:
      - name: Generate GitHub App token
        id: app-token
        # The minting step receives the App private key, so pin it to a full commit SHA
        # (v3.2.0 here) and update the pin deliberately after reviewing changes.
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        with:
          app-id: ${{ secrets.REVIEW_APP_ID }}
          private-key: ${{ secrets.REVIEW_APP_PRIVATE_KEY }}
      - name: Review pull request
        uses: dragoscirjan/code-review@v1
        with:
          github-token: ${{ steps.app-token.outputs.token }}
          backend: pi
          model-config: |
            { ... }
          model-credentials: ${{ secrets.REVIEW_MODEL_CREDENTIALS }}
```

Install the GitHub App on the repository and grant only these repository permissions:

| Permission    | Access | Why                                                                  |
| ------------- | ------ | -------------------------------------------------------------------- |
| Contents      | Read   | Base-revision guidance, configuration, and exact-base archive reads. |
| Issues        | Read   | Linked-issue acceptance criteria.                                    |
| Pull requests | Write  | Inline review submission and managed summary comments.               |
| Metadata      | Read   | Automatic.                                                           |

Publication modes do not change this set: summary-only and inline publication both write through the pull-request review and issue-comment endpoints of the pull request.

A PAT needs the same effective access. Prefer a fine-grained PAT scoped to one repository with exactly the permissions above (Contents read, Issues read, Pull requests write; Metadata read is automatic). Classic PATs only offer the coarse `repo` scope, which grants write access to all repositories the token owner can reach — use it only if a fine-grained PAT is not possible, and prefer a dedicated bot account so the managed comments have a distinct review identity.

Operational notes:

- Installation tokens expire after one hour. If a review outlives the token, the next GitHub API call fails with 401 and the action fails closed. If the token expired between the inline review and the managed summary, the inline review is already published and the next run reuses it instead of reposting. Rerun the workflow.
- A 403 means the App installation lacks a required permission or was blocked. Grant the permissions above and rerun. API failures never echo the token.
- Comments and reviews appear as `your-app[bot]`. Rotating the App private key requires no action changes: minted tokens are independent of the key that created them.
- Migrating from a PAT: the first App-authenticated run cannot reuse prior PAT summaries because incremental state is identity-bound; it performs a fresh full review and publishes a new `your-app[bot]` thread. Old PAT comments are never edited or deleted; archive them manually if unwanted.

`credential-isolation` defaults to `gateway`. The action runs a trusted host-side credential gateway for every credentialed provider endpoint, so the review container never receives the provider credential:

- The container's native harness configuration points at the gateway with a single-purpose per-run placeholder token instead of the provider credential. The placeholder is destination-bound (the gateway only forwards to the one configured provider origin), single-run (fresh random value, gateway closed with the backend), and unusable elsewhere.
- The gateway requires the placeholder on the provider's native credential header, strips it, and injects the real credential only after that authorization. Unused credential-map entries never leave the host.
- The gateway forwards to the configured provider origin only, rejects proxy-style absolute targets and wrong/missing credentials without contacting upstream, and blocks cross-origin redirects so a compromised harness dependency cannot steer the credential header to another destination.
- Container→gateway traffic is plain HTTP on the host-controlled container bridge; the gateway performs the upstream TLS connection from the host. The gateway port is reachable from the runner host and bridge, but every request requires the per-run placeholder.
- **Destination pinning.** The gateway resolves and authorizes the provider destination once at startup and pins that address for every upstream connection for the whole review. DNS is never re-resolved mid-review, so a rebinding or attacker-controlled record cannot move the destination after authorization. Every resolved address must satisfy the configured `remote`/`private` network policy; mixed public/private or reserved-address resolution fails closed. TLS still validates against the original provider hostname (SNI plus certificate identity).
- **Redirect policy.** Cross-origin redirects are blocked at the gateway. Same-origin redirects, whether relative or absolute, are rewritten to gateway-relative paths and re-enter the gateway, so every credential-carrying connection stays under host-side destination policy.
- **Timeout policy.** Upstream connections are bounded by an idle socket timeout (300 s): a hung provider connection is destroyed and surfaces as a fail-closed 502 inside the review deadline instead of hanging the harness.
- **Proxy bypass.** The gateway connects with the pinned address directly through a dedicated non-proxying HTTP(S) agent, so hostile `HTTP(S)_PROXY` environment variables (including Node's opt-in `NODE_USE_ENV_PROXY` handling) cannot reroute upstream connections, and the container environment never receives proxy variables.
- **Residual egress risk.** The review container itself keeps general bridge egress because the pinned harness binaries install through npm inside the sandbox. Direct provider calls from the container are useless (only the placeholder is present), but arbitrary non-provider egress is not network-blocked. Absolute lockdown requires network-level controls (root podman or self-hosted runner firewall rules) and remains future work.
- `credential-isolation: direct` restores the legacy behavior and passes the selected provider credential into the sandbox environment. Use it only to work around a harness incompatibility.
- Keyless local endpoints (`model-credentials` omitted or keyless entry) connect directly as before; there is no credential to protect.

Set `credential-isolation` to `direct` only to work around a specific endpoint incompatibility.

## Provider and model configuration

`model-config` is **our strict versioned schema**, not native Pi/OpenCode configuration. The action translates it into the selected harness's native configuration inside its disposable container, before launching the harness. Host/user configuration is never modified.

One invocation selects one provider/model. Use workflow matrices or separate invocations for more. Non-secret configuration can be inline workflow JSON or `${{ vars.REVIEW_MODEL_CONFIG }}`. Secrets belong only in `model-credentials`. Set the action-level `reasoning` input to `true` when the selected model supports or requires reasoning; it is translated into both native harness configurations. The action does not choose a model or reasoning cost for consumers.

| Field                   | Meaning                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`               | Required; `1`.                                                                                                                                                                   |
| `provider.api`          | Required; one of the protocols below.                                                                                                                                            |
| `provider.baseUrl`      | Required API base URL; no URL credentials, query, fragment, or interpolation.                                                                                                    |
| `provider.network`      | Required; `remote` explicitly permits sending source to a public HTTPS provider; `private` explicitly permits a private-network endpoint (HTTP allowed).                         |
| `provider.credential`   | Optional reference into `model-credentials`; never an environment variable or token.                                                                                             |
| `model.id`              | Required exact provider model ID, not a Pi/OpenCode selector.                                                                                                                    |
| `model.contextWindow`   | Optional positive integer, default `128000`, maximum `2000000`. Set it to the model's actual capability.                                                                         |
| `model.maxOutputTokens` | Optional positive integer, default `8192`, maximum `2000000` and strictly below `contextWindow`. Set it to the model's actual capability; consumers own their model/cost choice. |

Unknown fields are rejected. Each JSON input is capped at 32,000 UTF-8 bytes; at most 16 credentials, with tokens limited to 8,192 printable non-whitespace ASCII characters. References/model IDs use letters, digits, `.`, `_`, `:`, `/`, `-` (maximum 200 characters, starting with a letter/digit).

### Protocols and authentication

| API                  | Base URL example                                                      | Credential type                                  |
| -------------------- | --------------------------------------------------------------------- | ------------------------------------------------ |
| `openai-completions` | `https://openrouter.ai/api/v1` or an OpenAI-compatible `/v1` endpoint | `bearer`, or omit credential for keyless servers |
| `openai-responses`   | `https://api.openai.com/v1`                                           | `bearer`, or keyless compatible server           |
| `anthropic-messages` | `https://api.anthropic.com` (**without `/v1`**)                       | Required `api-key` (Anthropic `x-api-key`)       |

For Anthropic, use `{"review-provider":{"type":"api-key","value":"YOUR_ANTHROPIC_API_KEY"}}` as the secret. The adapter accounts for the harnesses' different Anthropic base URL conventions. A bearer credential may be an API key or an already-issued access token; the action does not log in, refresh OAuth tokens, or run credential commands. Anthropic OAuth tokens containing `sk-ant-oat` are rejected because Pi would reinterpret them as OAuth rather than `x-api-key` authentication.

Support means the configured endpoint must implement the selected protocol. The `reasoning` input declares model capability to the harnesses; it does not expose provider-specific reasoning effort, token budgets, or proprietary controls. Google/Azure/Bedrock-specific protocols, arbitrary headers, plugins, shell commands, environment forwarding, raw harness config, and `model-config-file` are not supported in this milestone. Add explicit adapters rather than passing through arbitrary harness settings.

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

| Input                     | Default                | Description                                                                                       |
| ------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------- |
| `github-token`            | Required               | GitHub token (PAT or GitHub App installation token) for PR API access and publication.            |
| `model-config`            | Required               | Provider/model JSON above.                                                                        |
| `model-credentials`       | `{}`                   | Secret JSON credential map; only the selected credential enters the backend.                      |
| `reasoning`               | `false`                | Set `true` when the selected model supports or requires reasoning.                                |
| `backend`                 | `opencode`             | `opencode` or `pi`.                                                                               |
| `container-engine`        | `podman`               | `podman` or validated `docker` fallback.                                                          |
| `opencode-version`        | `1.18.31`              | Exact npm package version.                                                                        |
| `pi-version`              | `0.85.1`               | Exact npm package version.                                                                        |
| `code-indexer`            | `none`                 | `none`, `cgc` or `gitnexus`; exact base revision only.                                            |
| `code-index-cache-key`    | `code-review-index-v1` | Cache key prefix.                                                                                 |
| `code-index-cache-ttl`    | `24h`                  | Maximum cache age (`ms`, `s`, `m`, `h`, `d`).                                                     |
| `max-diff-bytes`          | `120000`               | Maximum model-visible diff bytes; only complete diff hunks are included.                          |
| `minimum-confidence`      | `0`                    | Inclusive confidence threshold from `0` through `1`.                                              |
| `max-inline-comments`     | `0`                    | Inline comment cap from `0` through `10`; `0` keeps summary-only behavior.                        |
| `deterministic-analyzers` | `none`                 | `none` or `base-config`; trusted workflow gate for fixed parse-only checks.                       |
| `review-memory`           | `none`                 | `none` or `base-config`; exact-base reviewer memory gate.                                         |
| `review-strategy`         | `auto`                 | `single-pass`, `specialists`, or deterministic `auto` selection.                                  |
| `credential-isolation`    | `gateway`              | `gateway` keeps the provider credential host-side (default); `direct` passes it into the sandbox. |
| `specialist-token-budget` | `300000`               | Conservative aggregate specialist prompt/output reservation.                                      |
| `timeout-seconds`         | `600`                  | One call in single-pass mode; aggregate role/arbiter time in specialist mode.                     |

Outputs: `comment-url`, `review-url`, `inline-comment-count`, `inline-history-suppressed-count`, `inline-limit-omitted-count`, `diff-truncated`, `context-truncated`, `context-unavailable-source-count`, `review-mode`, `review-strategy`, `specialist-role-count`, `specialist-candidate-count`, `arbiter-rejected-count`, `review-memory-status`, `memory-suppressed-count`, `memory-active-suppression-count`, `memory-active-preference-count`, `memory-effective-digest`, `new-finding-count`, `unchanged-finding-count`, `resolved-finding-count`, `superseded-finding-count`, `analyzer-coverage`, `analyzer-run-count`, `analyzer-observation-count`, `analyzer-skipped-file-count`, `code-indexer`, `code-index-cache-hit`.

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

## Repository review memory

A trusted workflow may set `review-memory: base-config`. The action then reads the one fixed file `.github/code-review-memory.json` only from the captured **base SHA**. A pull request cannot suppress findings about itself by adding or changing its head copy. `none` performs no repository read; a missing base file is reported as `missing` and applies no memory. When enabled, an unavailable, non-regular/symlink, truncated, oversized, invalid-UTF-8, duplicate-keyed, malformed, unknown-version, expired, secret-bearing, or otherwise unsafe file aborts before any model backend or publication. The complete file is limited to 32 KiB, 32 suppressions, 32 preferences, eight paths per entry, and 256 paths total.

Version 1 uses exact objects and mandatory audit metadata:

```json
{
  "version": 1,
  "suppressions": [
    {
      "id": "generated-correctness-noise",
      "paths": ["generated/**/*.ts"],
      "scope": { "kind": "category", "category": "correctness" },
      "fingerprint": null,
      "reason": "Reviewed generator output is intentionally compatible.",
      "provenance": { "author": "maintainer", "kind": "issue", "reference": "#123" },
      "createdAt": "2026-01-01T00:00:00Z",
      "expiresAt": "2026-06-01T00:00:00Z"
    }
  ],
  "preferences": [
    {
      "id": "payments-testing-focus",
      "paths": ["src/payments/**"],
      "categories": ["security", "testing"],
      "reason": "Prefer already accepted payment findings when inline publication is capped.",
      "provenance": {
        "author": "security-team",
        "kind": "policy",
        "reference": "https://example.test/review/payments"
      },
      "createdAt": "2026-01-01T00:00:00Z",
      "expiresAt": "2026-06-01T00:00:00Z"
    }
  ]
}
```

Category suppressions apply only to host-labelled model findings. A `security` category suppression, and any actual suppression match against a critical finding, requires one full `sha256:` finding fingerprint plus an exact canonical path without wildcards. Fixed analyzer findings require an `analyzer-rule` scope containing the exact allowlisted `analyzer`, `rule`, and rule `revision`, plus the same full fingerprint and exact-path binding. Broad non-security category/path suppressions and stable exact-fingerprint replay across heads/backends are intentional for byte/anchor/explanation-identical false positives, bounded by exact-base code review and expiry. Broad category or wildcard policy cannot disable fixed analyzer/security controls, and memory cannot alter validation, sandbox, analyzer, arbiter, secret, freshness, or publication controls. Model output cannot forge origin or rule provenance.

Path matching is case-sensitive over canonical repository-relative POSIX paths. `*` matches within one segment, `?` matches one character within one segment, and a complete `**` segment matches zero or more segments. Negation, escaping, bracket/brace classes, extglobs, embedded `**`, absolute paths, backslashes, empty/`.`/`..` segments, and control/format characters are rejected. Matching uses bounded dynamic programming rather than repository-provided regular expressions.

Every entry requires a lowercase ASCII ID, a bounded nonblank reason, a repository-declared ASCII author plus an issue, pull request, commit, or absolute credential-free HTTPS policy reference, and canonical UTC-second `createdAt`/`expiresAt` values. The declared author is repository-recorded text, not an authenticated GitHub identity; code review of the exact-base memory-file change is the trust source. Creation cannot be in the future, expiry is exclusive, and lifetime cannot exceed 366 days. An enabled file containing any expired entry is invalid and aborts rather than silently making the entry inactive. The file is public repository policy: never put credentials or sensitive incident detail in it. Reasons, references, paths, fingerprints, and raw file content never enter model/arbiter prompts, logs, comments, outputs, lifecycle state, or evaluation artifacts. Summaries/state expose only bounded counts plus escaped, non-mentioning IDs, explicitly labelled repository-declared authors, and host-generated entry/effective digests.

Memory runs only after strict result parsing, exact changed-line/evidence mapping, confidence and secret checks, host provenance assignment, and canonical anchor deduplication. Canonical winner selection is independent of memory: suppressing the winner never reveals a lower-ranked same-anchor variant. Suppression then runs before the fixed baseline severity/confidence/deterministic ranking and global ten-finding cap, so a suppressed canonical finding cannot occupy a slot. Multiple actual matching suppressions are ambiguous and abort rather than using order. Preferences never change that globally accepted set or summary order. They can only reorder equally severe unprotected findings inside the accepted set for inline selection. Security-category, critical-severity, and analyzer-origin findings are ordered ahead of unprotected findings, and comparisons between two protected findings always use the exact baseline comparator without consulting memory, so preferences cannot change protected selection or cause protected inline omission. Preferences cannot suppress, mutate, lower confidence, change role/analyzer selection, alter prompts, or bypass any cap, freshness, sandbox, tool, credential, arbiter, analyzer, validation, secret, or publication rule. The normal quality corpus remains memory-disabled so memory cannot improve measured quality.

The fixed file is resolved only from the captured exact base commit. Before its blob is fetched, bounded exact Git-tree traversal must prove one unambiguous regular-file entry (`100644` or `100755`) at every segment; symlinks, submodules, trees at the final path, duplicate entries, truncated/malformed metadata, permission/rate-limit failures, and unavailable blobs abort enabled memory. Only authoritative absence/HTTP 404 becomes `missing`. The canonical effective-memory digest and contract version bind incremental reuse. A file/mode/semantic change forces a full review; crossing expiry during a run aborts before the next write. State version 2 and managed marker v8 intentionally migrate older summaries through a full baseline. Suppressed findings do not enter active lifecycle state or historical inline markers; removing memory permits a later full review to report them again.

## Specialist review strategy

`review-strategy: auto` keeps the existing single review call for small, low-risk changes. It deterministically selects the fixed correctness, security, testing, and compatibility passes when the authoritative full diff is truncated, has more than two commentable files, has more than 80 changed lines, exceeds 24 KiB, has partial analyzer coverage, or touches a fixed sensitive surface such as workflows/actions, authentication, credentials/secrets, configuration, manifests/lockfiles, migrations/schemas, API/routes/interfaces, or canonical container/build metadata (`Dockerfile`, `Containerfile`, bounded suffixed variants, Compose files, and action metadata). Sensitive names use exact normalized path segments, filenames, or dot/dash/underscore-delimited filename tokens rather than substring matches. `single-pass` and `specialists` force either path. Pull-request content can trigger only these fixed effort-allocation signals; it cannot add, remove, reorder, or retry roles.

Specialists run sequentially in the order above. Each receives the complete selected diff, bounded PR metadata, base guidance/configuration and issue criteria, only its allowlisted index context, and only matching prior findings. It can emit at most three findings in its assigned category. Every candidate passes the production strict result parser, exact changed-line/evidence mapper, confidence and secret policy before arbitration. The host first collapses competing claims at the same path/side/line by severity, confidence, and deterministic tie-breakers, reserves one candidate for every nonempty role, and fills the remaining ten-candidate budget by that global priority. The arbiter receives only those host-ID-labelled candidates, their exact hunks, at most 12 KB of base guidance/configuration/criteria, the immutable security policy, and one reject-only version 1 schema; it does not receive the finding-result contract. It can return only a duplicate-free subset of IDs to reject and cannot create, rewrite, rank, or suppress deterministic analyzer findings. Retained findings are validated again and merged with analyzers through the existing deduplicator and global ten-finding cap.

The action reserves one conservative token unit per UTF-8 prompt byte, 1,024 envelope units per call, every configured per-call maximum output, and the worst-case arbiter prompt/output before the first specialist. Each role is capped at `min(model.maxOutputTokens, 4096)` and the arbiter at `min(model.maxOutputTokens, 2048)`. `specialist-token-budget` must be 20,000–2,000,000. This reservation is a host-side safety bound, not provider billing telemetry. `timeout-seconds` is one monotonic deadline: in specialist mode all four roles and the arbiter share it, and each backend call propagates its remaining budget through endpoint resolution, workspace setup, process execution, termination grace, forced container removal, and workspace cleanup. A backend process is not started unless cleanup time remains reserved. Snapshot, linked-issue, and managed-summary lease freshness are checked around every phase. A timeout, stale input, malformed/secret-bearing output, role breach, budget breach, cleanup/backend failure, or arbiter violation aborts before any write; there is no partial publication, retry, or fallback.

All roles and the arbiter use the same configured model/provider and selected provider credential in separate mount-free sandbox calls. They are not an independent security quorum, and a provider may correlate the requests. Specialist mode increases provider calls, cost, credential-bearing harness starts, and the existing DNS/redirect/supply-chain exposure. GitHub credentials and unused provider credentials remain host-side.

## Review quality evaluation

`npm run evaluation` replays the checked-in version 1 seeded-defect corpus through the production result parser, unified-diff parser, exact evidence mapper, deterministic analyzer merge, and deduplicator. The corpus covers correctness, security, regression, testing, prompt injection, HTML-like syntax, clean changes, LEFT-side findings, and analyzer evidence. Every protected baseline recording is contract-valid, exactly mapped, and deduplicated; focused adversarial unit fixtures cover malformed, duplicate, unmapped, rejected, and false-positive outputs. The corpus records exact acceptable locations and intentional non-findings.

The deterministic gate reports precision, recall, line-mapping accuracy, duplicate rate, evidence/secret rejection rate, global finding-cap omission rate, repository-memory suppression count (zero in the protected memory-disabled corpus), malformed-output rate, execution-failure rate, clean-case accuracy, intentional non-finding hits, and recorded latency. It also replays fixed per-role and arbiter recordings through the production specialist orchestrator, verifies expected auto routes, and requires forced-specialist and auto precision/recall/mapping/clean accuracy plus per-case matches to be no worse than the single-pass baseline. Error counts cannot increase, p95 latency is bounded, and reservations must remain within the checked budget. This recorded non-regression gate enabled the `auto` default while retaining single-pass behavior for low-risk changes.

The gate writes canonical JSON and Markdown baseline and specialist reports to a newly created private directory directly below `RUNNER_TEMP` (or the operating-system temporary directory) and fails after writing when versioned thresholds regress. Normal CI is offline and credential-free; fixture content is inert JSON data and is never imported, compiled, installed, or executed.

Live evaluation is observational and never runs in normal CI. It may send the public seeded fixture source to the explicitly configured provider and can incur charges:

```bash
# Populate this through a secret manager; expected shape:
# {"review-provider":{"type":"bearer","value":"<provider token>"}}
export REVIEW_MODEL_CREDENTIALS_JSON

RUN_LLM_EVALUATION=1 \
REVIEW_EVALUATION_BACKEND=opencode \
REVIEW_EVALUATION_STRATEGY=auto \
REVIEW_EVALUATION_MODEL_CONFIG='{"version":1,"provider":{"api":"openai-completions","baseUrl":"https://openrouter.ai/api/v1","network":"remote","credential":"review-provider"},"model":{"id":"provider/model-id","contextWindow":128000,"maxOutputTokens":8192}}' \
REVIEW_EVALUATION_MODEL_CREDENTIALS="${REVIEW_MODEL_CREDENTIALS_JSON:?set REVIEW_MODEL_CREDENTIALS_JSON through a secret manager}" \
node scripts/run-review-evaluation.mjs --live
```

Live mode reuses the fixed sandbox and provider-neutral credential contract, runs cases serially, never reads a GitHub token, never publishes comments, and artifacts only aggregate safe identifiers and counters. Raw prompts, provider output/errors, finding prose, endpoints, credentials, and environment data are not stored. Set `REVIEW_EVALUATION_STRATEGY` to `single-pass`, `specialists`, or `auto`; specialist live evaluation is still observational and never a CI gate. `REVIEW_EVALUATION_TIMEOUT_SECONDS` is a bounded per-case aggregate timeout, `REVIEW_EVALUATION_SPECIALIST_TOKEN_BUDGET` adjusts the conservative reservation, and `REVIEW_EVALUATION_OUTPUT_DIR` selects a new direct child of trusted temporary storage.

## Incremental reviews

The managed summary stores a bounded, public, versioned state envelope immediately before its actor-owned final marker. State is bound to the API host, repository, pull request, backend, actor, base revision, and a versioned review-input digest. That digest covers non-secret policy/model settings, fixed review-policy/result-contract/fingerprint/state/execution-strategy semantic versions, requested and selected strategy, fixed reason codes, role/selector/context/arbiter versions, effective budgets, bounded authoritative PR title/body/author, the supplemental-context digest, and linked-issue fingerprints. Missing or mismatched input binding forces a full review. State contains only host-generated digests, fingerprints, anchors, locations, lifecycle/publication counts, and coverage metadata—never prompts, credentials, endpoints with secrets, or raw model prose.

The action builds and fingerprints current bounded context before permitting reuse. On a synchronize event, it uses incremental selection only when the previous completed head is a proven strict ancestor and both bounded compare responses are complete and consistent. The compare selects current-PR files for review but never authorizes a finding; every result must still map to the authoritative current PR diff with exact evidence. Unchanged findings in untouched files are carried only after unique host-side remapping proves their anchor still exists and their hunk was omitted. If truncated coverage omits an affected prior finding or cannot remap it uniquely, the action aborts before backend execution or publication. Rebases, amended or divergent histories, base changes, unavailable/truncated compares, review-input changes, malformed or unknown metadata, and incomplete prior coverage otherwise fall back to a full current review without guessing.

Each inline finding uses a full SHA-256 fingerprint marker. Actor-owned historical markers suppress duplicate inline comments across retries and synchronize events, including a retry after inline publication succeeded but summary publication failed. Historical suppression runs before the configured inline limit, so later new findings fill available capacity; history-suppressed and limit-omitted counts are reported separately. Legacy summaries are migrated by a full baseline review; legacy batch-only inline reviews suppress inline output for that migration generation because their individual findings cannot be identified safely. A truncated model-visible diff never advances the completed-through cursor.

GitHub does not provide an atomic transaction across inline review creation and summary update, an idempotency key for review creation, or compare-and-swap comment updates. State/body leases and repeated freshness checks prevent known stale overwrites, but workflow concurrency with cancellation remains required to reduce the residual concurrent first-create race.

## Review context

The action derives at most six language-aware lexical anchors from the exact complete diff hunks sent to the model. Changed additions and deletions take priority, while enclosing context declarations are a fallback; renamed files query the base index with their old path while retaining side-specific provenance. When `code-indexer` is selected, the action queries the pinned adapter in a fixed order for definitions/types, callers/tests, callees, hierarchy, and relevant configuration. Each query has a 5-second and 16 KB acquisition limit; the whole query phase is bounded to 45 seconds and 128 KB before deterministic packing into a 50 KB supplemental-context envelope.

Root `AGENTS.md` and `CONTRIBUTING.md` are read only from the captured base SHA. Independently of indexer selection, the action includes at most four allowlisted configuration files and 8 KB selected by changed-path proximity and lexical path, such as `package.json`, TypeScript/JavaScript project configs, `Cargo.toml`, `go.mod`, Python project configs, and supported build files. Acceptance criteria are fetched for at most three explicit same-repository references: canonical issue URLs or closing-keyword forms such as `Fixes #23`. Bare mentions, pull-request URLs, code-fenced references, and cross-repository references are not fetched. Optional context requests have bounded deadlines. Missing, timed-out, truncated, and unavailable sources are reported in the managed summary and action outputs.

Repository guidance, issue criteria, PR metadata, paths, symbols, index output, deterministic analyzer labels/messages, and the diff all remain untrusted data inside collision-checked prompt boundaries. The action accepts no caller-supplied trusted guidance. Untrusted data cannot replace the fixed versioned safety rules, tool denial, output contract, finding validation, or publication policy.

## Security and limitations

- GitHub-hosted runners and GitHub PAT publication. Pi still uses its CLI for this milestone.
- No PR code execution. The diff, exact-base guidance, linked issue criteria, bounded index results, and analyzer messages are untrusted prompt data. The removed `prompt` input is rejected; review instructions are fixed and versioned. Deterministic analyzers parse bounded in-memory text only.
- The backend container is digest-pinned, mount-free, non-root, read-only, capability-dropped, resource-limited and denies added privileges. OpenCode denies all tools; Pi disables tools and resource discovery.
- Native harness configuration is generated in container tmpfs with restrictive permissions. Fixed provider naming avoids built-in provider auto-configuration. Native interpolation syntax in credentials is handled without executing commands or loading referenced files.
- GitHub credentials never enter the model container. By default the provider credential never enters it either: a host-side credential gateway injects the selected credential only after destination authorization, and the container carries a single-purpose per-run placeholder (see "Model credential isolation"; `credential-isolation: direct` restores the legacy in-sandbox credential). Every validated credential value, including unused entries, remains host-side and is masked, scanned against the complete assembled prompt, redacted from findings, and included in the final publication scan. Output is bounded and raw provider errors are suppressed.
- `network` permission and DNS/address preflight checks are **not an egress firewall**. DNS can change after checking; harness SDKs control redirects. Trust the endpoint and its redirect behavior. npm/package code also has container network access and the selected credential. A credential-isolating model gateway with enforced egress is future work.
- Node DNS and filesystem promises cannot be cancelled after dispatch. Aggregate `Promise.race` deadlines bound how long orchestration waits and prevent publication, but the underlying operation can settle later. Workspace creation uses a preselected random path with immediate and late best-effort removal; an unhealthy operating system can still prevent cleanup confirmation, in which case the action fails closed.
- Private HTTP is not encrypted. Prefer TLS and authenticated private endpoints.
- Backends must return the strict version 1 JSON review contract; malformed, unknown-version, or oversized output is rejected without repair. The action strictly parses the model-visible unified diff, accepts only findings on exact added/deleted lines with exact changed-line evidence, removes anchor duplicates deterministically, and applies the configured confidence and inline limits. Rejected finding prose is never published.
- The action snapshots the PR base/head, changed-file count, title, body, and author around diff acquisition, checks them again before backend execution and publication, and refreshes fetched issue fingerprints. It also checks freshness between inline and summary publication. Inline findings are submitted in one pull-request review bound to the reviewed head SHA, then the managed summary is updated. GitHub offers neither a transaction spanning those two endpoints nor an atomic create-if-marker-absent operation: if the summary update fails after inline success, the action fails and a deterministic owned marker lets a retry reuse the inline review, but two truly concurrent first-time runs can still race. Keep workflow concurrency cancellation enabled. A force-push after the final pre-write check can make the SHA-bound review outdated but cannot move it to the replacement head.
- Managed comments require both a backend-specific hidden marker and the authenticated actor (PAT owner or GitHub App bot). Incremental metadata is public and treated as untrusted: malformed, unknown, oversized, ambiguous, stale, or scope-mismatched state is ignored for optimization and triggers a full baseline review. Legacy OpenRouter markers migrate without creating a new comment. PAT comments appear as the token's owner; App installation comments appear as the app's `bot-name[bot]` identity, and switching identity starts a fresh managed thread instead of reusing prior state.

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

# Live provider evaluation (optional, may incur provider charges):
# Configure RUN_LLM_EVALUATION, REVIEW_EVALUATION_MODEL_CONFIG, and
# REVIEW_EVALUATION_MODEL_CREDENTIALS as shown in “Review quality evaluation”.
npm run test:integration
GITHUB_TOKEN=... CODE_INDEXER=cgc npm run test:indexers
GITHUB_TOKEN=... CODE_INDEXER=gitnexus npm run test:indexers
```

The live test environment variable is only a test convenience, not a restored action input. See `CONTRIBUTING.md`.
