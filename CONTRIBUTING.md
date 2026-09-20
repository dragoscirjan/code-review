# Contributing

## Development model

Use GitHub Issues for defects, features, and acceptance criteria. Put product requirements and design decisions in the GitHub Wiki. Link implementation pull requests to both when applicable.

The repository is in its bootstrap phase. The POC uses npm, TypeScript, esbuild, and Node's test runner through `tsx`. Do not add a second package manager, task runner, formatter, or test framework without an accepted design change. Follow `package-lock.json` and the scripts in `package.json`.

The current milestone supports the GitHub Action, OpenCode and Pi, configured existing model endpoints, GitHub-hosted runners, and PAT publication. `model-config` selects an explicitly permitted remote/private provider endpoint and model; `model-credentials` supplies separate named bearer or API-key credentials. See the Wiki's Provider-neutral-model-configuration page and issue #12. Both backends run in the fixed container sandbox without checkout, host mounts, or GitHub credentials. Generate native harness configuration inside the container and pass only the selected provider credential. Reject arbitrary native config, commands, headers, and ambient environment references. Podman is the default and Docker is the only fallback. Managed local-runtime lifecycle, enforced-egress gateway, self-hosted runner support and additional forges remain separate work.

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
- Build a custom action prompt by adding trusted user guidance to fixed security and output rules. Do not let custom text replace those rules.
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

Before pushing, run every formatting, type-checking, linting, and test command defined by the repository. The initial bootstrap pull request must add one documented validation command that runs the required local checks.

## Security review

Treat every pull request diff, file, filename, comment, and configuration value as untrusted input.

A change requires explicit security review when it:

- Adds a tool or permission available to Pi or OpenCode.
- Adds or changes a model-runtime command, executable path, endpoint, health check, model download, or cleanup rule.
- Executes a repository command.
- Changes token permissions or secret storage.
- Changes prompt construction or model-visible context.
- Changes managed-comment ownership checks.
- Adds support for public fork pull requests.
- Sends source code to a new model provider.

Never include real tokens, GitHub App private keys, webhook secrets, or model credentials in fixtures, logs, snapshots, prompts, or issue comments.

## Documentation

Update documentation in the same pull request when behavior or configuration changes.

- Keep `README.md` focused on installation, configuration, and basic use.
- Keep contribution workflow in this file.
- Keep instructions for coding agents in `AGENTS.md`.
- Keep requirements and low-level design in the GitHub Wiki.
- Record unsupported behavior and limitations.
- Use concrete names, defaults, examples, and failure behavior. Avoid claims that are not backed by code or tests.

## Commits

Use Conventional Commits, for example:

```text
feat: add GitHub App credential provider
fix: reject comments outside changed lines
docs: document PAT review identity
test: cover renamed files in diff mapping
```

Keep commits reviewable. A commit should build and pass the relevant tests unless the pull request documents why an intermediate commit cannot do so.

## Pull request checklist

- [ ] The change has a linked issue and clear acceptance criteria.
- [ ] The implementation follows the current requirements and design.
- [ ] Tests cover normal, failure, and security-sensitive paths.
- [ ] Model output remains schema-validated.
- [ ] Custom prompts cannot replace fixed security, permission, or schema rules.
- [ ] Runtime cleanup stops or unloads only resources owned by the action.
- [ ] Runtime processes use trusted executables, fixed argument construction, readiness timeouts, and loopback binding by default.
- [ ] No credential can enter model context or logs.
- [ ] No pull request code executes during review.
- [ ] Documentation reflects the changed behavior.
- [ ] Required local validation passes.
- [ ] The working tree contains no generated or unrelated files.
