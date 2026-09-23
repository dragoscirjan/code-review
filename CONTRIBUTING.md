# Contributing

## Development model

Use GitHub Issues for defects, features, and acceptance criteria. Put product requirements and design decisions in the GitHub Wiki. Link implementation pull requests to both when applicable.

The repository is in its bootstrap phase. The POC uses npm, TypeScript, esbuild, Vitest, and the shared Tempel ESLint and Prettier configurations. Mise manages tool versions and project tasks. Do not add a second package manager, task runner, formatter, or test framework without an accepted design change. Follow `package-lock.json`, `mise.toml`, and the scripts in `package.json`.

The current milestone supports the GitHub Action, OpenCode and Pi, configured existing model endpoints, GitHub-hosted runners, and PAT publication. `model-config` selects an explicitly permitted remote/private provider endpoint and model; `model-credentials` supplies separate named bearer or API-key credentials. See the Wiki's Provider-neutral-model-configuration page and issue #12. Both backends run in the fixed container sandbox without checkout, host mounts, or GitHub credentials. Generate native harness configuration inside the container and pass only the selected provider credential. Reject arbitrary native config, commands, headers, and ambient environment references. Podman is the default and Docker is the only fallback. Managed local-runtime lifecycle, enforced-egress gateway, self-hosted runner support and additional forges remain separate work.

## Set up the repository

Mise installs Node.js 24 and Python 3.12, and npm is the only supported package manager.

```bash
mise trust
mise run deps:sync
```

Run `mise tasks` to list the available tasks. Use `mise run <task>` when a task exists. Dependency installation also configures Husky hooks: staged files are linted and formatted before commits, and the test suite runs before pushes.

## Before starting

1. Read `AGENTS.md` and the linked issue.
2. Read relevant requirements and design pages in the Wiki.
3. Confirm the acceptance criteria and security impact.
4. Check the working tree for existing changes.
5. Create a focused branch. Use a worktree when parallel work could interfere with another task.

Do not start implementation when the requirement changes authentication semantics, comment ownership, trust boundaries, or forge compatibility without a corresponding design update.

## Branches and pull requests

- Do not commit directly to `main`.
- Keep one logical change per branch and pull request.
- Do not mix formatting sweeps or unrelated refactors with product changes.
- Describe the user-visible behavior, security impact, tests, and documentation changes in the pull request.
- Link the issue that defines the acceptance criteria.
- Never merge without owner approval.

## Implementation rules

- Write new production code in TypeScript unless an accepted design requires another language.
- Treat the GitHub Action as the main product entry point. Keep the review flow in shared code that other action wrappers can call.
- Keep the review domain independent from forge SDKs, action runtimes, Pi, and OpenCode.
- Add forge-specific behavior through adapters.
- Add authentication methods through credential providers. Never branch on authentication mode throughout the domain layer.
- Put Pi and OpenCode behind one review-backend interface.
- Put Ollama, LM Studio, llama.cpp, OpenRouter, and later model tools behind model-runtime adapters.
- Keep runtime lifecycle separate from review-backend configuration.
- Track ownership for every server process and loaded model. Cleanup must not affect resources that existed before the action.
- Validate all model output before using it.
- Keep backend tools and permissions read-only during reviews.
- Keep review instructions fixed and versioned. Do not add free-form trusted guidance; repository content and action context must remain explicitly delimited untrusted data.
- Do not execute code from the pull request under review.
- Keep forge credentials in the publication and API-client layers. Give a review backend only the model-provider credential it needs. Do not write credentials into the checkout or prompt.
- Use least-privilege tokens and short-lived GitHub App installation tokens.

## Tests

Each pull request must add or update tests for changed behavior.

Use these test levels:

- Unit tests cover pure review policy, parsing, validation, filtering, and mapping.
- Contract tests cover forge event payloads and API request or response translation.
- Integration tests cover Pi and OpenCode setup, action input parsing, authentication providers, model-runtime lifecycle, and multi-component flows with controlled dependencies.
- End-to-end tests may write to a dedicated test repository only. They must never target a production repository.

Tests must use temporary directories and repositories. They must not modify the contributor's checkout. Network tests must be opt-in and clearly named.

The required `npm run evaluation` quality gate is deterministic, recorded, offline, and credential-free. Seed fixtures are inert JSON data and must never be imported or executed. The specialist gate must replay fixed per-role and arbiter recordings through the production orchestrator and compare forced-specialist and auto results with the single-pass baseline. Repository review memory remains disabled in the protected quality corpus so suppression cannot improve measured precision, recall, mapping, or clean accuracy; focused synthetic tests cover exact-base regular-file acquisition, matching, protected selectors, preference-only inline ordering, and post-validation accounting separately. Repository-declared memory authors are reviewed file content, never authenticated forge identities; review the exact-base memory change and its provenance reference as code. Changes to the protected corpus, specialist recordings, role/selector/arbiter semantics, memory semantics, matching semantics, or either threshold file require explicit owner review. `npm run evaluation:live` is an opt-in observational run only; it must not become a required CI gate or receive a GitHub publication token.

Before pushing, run every formatting, type-checking, linting, evaluation, and test command defined by the repository:

```bash
mise run validate
```

## Security review

Treat every pull request diff, file, filename, comment, and configuration value as untrusted input.

A change requires explicit security review when it:

- Adds a tool or permission available to Pi or OpenCode.
- Adds or changes a model-runtime command, executable path, endpoint, health check, model download, or cleanup rule.
- Executes a repository command.
- Changes token permissions or secret storage.
- Changes prompt construction, specialist/arbiter orchestration, or model-visible context.
- Changes repository review-memory parsing, matching, expiry, suppression, preference, or audit semantics.
- Changes managed-comment ownership checks.
- Adds support for public fork pull requests.
- Sends source code to a new model provider.

Never include real tokens, GitHub App private keys, webhook secrets, or model credentials in fixtures, logs, snapshots, prompts, or issue comments.

## Releasing the action

The supported consumer references are immutable `vMAJOR.MINOR.PATCH` tags and the moving compatibility tag for that major, such as `v1.0.0` and `v1`. Branch names, pull request refs, and arbitrary commit references are not supported release channels. Never create, move, or delete release tags by hand.

### One-time repository setup

Before the first dispatch:

1. Create a protected GitHub environment named `release`. Configure required reviewers and restrict deployments to `main`. Create it explicitly—otherwise GitHub can auto-create an unprotected environment when the workflow first references it.
2. Configure repository tag rules for the `v*` namespace. Immutable full-version tags must not be updated or deleted. The trusted release workflow must be allowed to create full-version tags and atomically advance the matching `vMAJOR` alias; ordinary users and workflows must not.
3. Keep the workflow's top-level permissions empty. Preflight receives only `contents: read`; only the environment-gated publisher receives `contents: write`.
4. Confirm required branch checks and the release/tag rules with a repository administrator before dispatching.

Tag rules must distinguish the intentionally moving major alias from immutable full-version tags, or grant the trusted publisher an appropriately narrow bypass. Do not weaken immutable-tag protection merely to let `vMAJOR` move.

### Version selection

The operator does not choose a version or bump. Preflight inspects validated published releases and non-merge Conventional Commits from the highest published stable release to the exact current `main` revision:

- `type!:` or `type(scope)!:`, or a trailing `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer, selects a major release;
- any `feat` commit selects a minor release when no breaking change exists;
- every other valid Conventional Commit history selects a patch release;
- the first stable release is always `v1.0.0`.

Malformed, empty, excessive, oversized, non-ancestor, orphaned, or ambiguous history fails closed. Merge commits are excluded, while their conventional branch commits remain in the range.

### Dispatch and approval

Use **Actions → Release versioned action → Run workflow**, select `main`, and run it without inputs. The equivalent CLI command is:

```bash
gh workflow run release.yml --repo dragoscirjan/code-review --ref main
```

Preflight validates and rebuilds the repository, proves the committed bundles are clean, derives the exact version, and performs no writes. After the `release` environment is approved, the privileged job checks out and executes only the reviewed `dist/action-release.js` bundle. Immediately before its first mutation, the publisher revalidates that the captured target is still current `main`. Once mutation starts, that invocation remains bound to the captured version and target and may finish if `main` advances concurrently. A later dispatch or failed-job rerun cannot publish that older target.

### Verification

After a successful run, verify the immutable tag and stable GitHub Release target the dispatched `main` commit, and inspect the moving major alias:

```bash
git ls-remote https://github.com/dragoscirjan/code-review.git \
  refs/tags/v1 refs/tags/v1.0.0
gh release view v1.0.0 --repo dragoscirjan/code-review \
  --json tagName,isDraft,isPrerelease,targetCommitish,url
```

Substitute the version selected in the preflight log. The immutable full-version tag must always resolve directly to the dispatched commit, and the release must be published, stable, and attached to that tag. Immediately after publication, `vMAJOR` must resolve to the same commit; if a later same-major release has since shipped, it must instead resolve to that latest validated stable release.

### Retry and recovery

A dispatch against an already released current `main` is a no-op. If a run fails after a write, inspect tags and the GitHub Release before doing anything manually. GitHub API visibility can lag behind a successful tag or Release write; rerunning the failed jobs against the same unchanged `main` safely revalidates the uniquely expected state:

```bash
gh run rerun RUN_ID --repo dragoscirjan/code-review --failed
```

Do not retry an old release after `main` advances. The publisher intentionally rejects stale ancestor publication, conflicting tags, unexpected orphan tags, and ambiguous remote state. Never force-push a release tag or create the GitHub Release manually to bypass a failed check.

### Rollback limitations

Published `vMAJOR.MINOR.PATCH` tags are immutable and releases are not rolled back by moving or deleting them. Correct a bad release with a reviewed fix-forward commit and a new release. The guarded workflow is the only supported mechanism for advancing `vMAJOR`; consumers requiring a permanently fixed revision should pin the immutable full-version tag.

The detailed trust boundaries and operator checklist are in the Wiki's [Release operations](https://github.com/dragoscirjan/code-review/wiki/Release-operations) runbook.

## Documentation

Update documentation in the same pull request when behavior or configuration changes.

- Keep `README.md` focused on installation, configuration, and basic use.
- Keep contribution workflow in this file.
- Keep instructions for coding agents in `AGENTS.md`.
- Keep requirements and low-level design in the GitHub Wiki.
- Record unsupported behavior and limitations.
- Use concrete names, defaults, examples, and failure behavior. Avoid claims that are not backed by code or tests.

## Commits

Use Conventional Commits with the linked GitHub issue number as the scope. The Husky `commit-msg` hook enforces this format:

```text
feat(#21): add GitHub App credential provider
fix(#22): reject comments outside changed lines
docs(#23): document PAT review identity
test(#24): cover renamed files in diff mapping
```

Keep commits reviewable. A commit should build and pass the relevant tests unless the pull request documents why an intermediate commit cannot do so.

## Pull request checklist

- [ ] The change has a linked issue and clear acceptance criteria.
- [ ] The implementation follows the current requirements and design.
- [ ] Tests cover normal, failure, and security-sensitive paths.
- [ ] Model output remains schema-validated.
- [ ] No caller-supplied trusted review guidance is accepted; model instructions remain fixed and versioned.
- [ ] Runtime cleanup stops or unloads only resources owned by the action.
- [ ] Runtime processes use trusted executables, fixed argument construction, readiness timeouts, and loopback binding by default.
- [ ] No credential can enter model context or logs.
- [ ] No pull request code executes during review.
- [ ] Documentation reflects the changed behavior.
- [ ] Required local validation passes.
- [ ] The working tree contains no generated or unrelated files.
