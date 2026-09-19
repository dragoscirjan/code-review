---
name: code-review
description: Review an implementation against a GitHub issue and every descendant issue, then return an evidence-backed verdict with findings, coverage, tests, and next steps. Use when requirements live in issue trees or when a code review must trace each finding to an issue requirement.
metadata:
  short-description: Review code against an issue tree
---

# Issue-driven code review

Review the implementation against the complete issue tree. Treat the issues as the specification and the repository as the evidence. Do not modify code, tests, configuration, documentation, branches, issues, or pull requests during the review.

The review is complete only when every reachable descendant has been read, every material requirement has a coverage status, and every reported finding points to both a requirement and actual code behavior.

## Scope and routing

Start by identifying:

- The root issue URL, repository, issue number, and requested implementation ref or worktree.
- The repository's local instructions, review conventions, package manager, task runner, and required tools.
- Whether the request is a normal review, a high-risk review, or a review that needs a second independent pass.

Use the narrowest available supporting workflow. Do not invoke every skill for every review.

- Use a code walkthrough workflow such as `how` when the relevant behavior spans unfamiliar modules or services.
- Use a rationale or history workflow such as `why` when the issue depends on design intent that the current code and issue bodies do not establish.
- Use a blast-radius workflow when the change looks local but may affect callers, wire formats, persisted data, integrations, or other packages.
- Use an adversarial review workflow such as `interrogate` for high-risk, cross-cutting, security-sensitive, or disputed reviews. Give every reviewer the same scope and rubric, then deduplicate and judge the results yourself.
- Use a decision-trail workflow such as `show-me-your-work` for long, unattended, or high-stakes reviews.
- If no narrower workflow fits, design a short review playbook before inspecting code, following the principle behind `figure-it-out`.

If a supporting skill is unavailable, perform only the relevant part inline. Never expand the review merely to justify another skill invocation.

## 1. Read the complete issue tree

Read the root issue body completely. Then discover and read all direct children recursively, including grandchildren and deeper descendants.

For GitHub, use the connected GitHub tools or `gh` when available. Page every collection. A practical API route is:

```text
/repos/{owner}/{repo}/issues/{number}/sub_issues?per_page=100&page=N
```

Continue until a page is empty. For every discovered issue, read its complete body and relevant comments. Follow linked design documents, pull requests, commits, or wiki pages when the issue treats them as part of the requirement. Do not assume the title or checkbox list is complete.

Build an issue graph with at least:

```text
issue number, parent number, title, state, labels, body, comments,
linked requirement sources, direct children, and retrieval status
```

Check the graph before proceeding:

- Every child has a parent in the graph.
- No child was silently dropped because a response was truncated or paginated.
- Duplicate references resolve to one issue record.
- Cycles, inaccessible issues, and ambiguous parentage are recorded.
- An issue being closed does not count as evidence that its acceptance criteria are satisfied.

If the graph cannot be proven complete, return `BLOCKED — insufficient information` and name the missing branch or inaccessible source.

## 2. Build the consolidated specification

Convert the issue tree into one requirement ledger. Preserve the source issue for every entry. Assign stable local IDs such as `R-001` and `AC-001`.

Classify each item as one of:

- Functional behavior.
- Non-functional behavior such as security, reliability, performance, concurrency, compatibility, operability, or data integrity.
- Acceptance criterion.
- Constraint, invariant, edge case, or explicit non-goal.
- Required test, documentation, migration, configuration, packaging, release, or operational change.
- Ambiguity that needs clarification.

When parent and child issues overlap, keep one consolidated requirement and list every source issue. When they conflict, do not choose silently. Record the conflict as an ambiguity and evaluate whether the implementation satisfies either interpretation.

For each requirement, capture:

```text
id
source issue(s)
exact requirement in plain language
category
observable proof expected
dependencies or affected surfaces
ambiguity, if any
```

Separate requirements from recommendations. A suggestion in an issue is not an acceptance criterion unless the issue makes it binding.

## 3. Map the implementation before judging it

Read repository guidance before code. Check files such as `AGENTS.md`, `CONTRIBUTING.md`, package manifests, workspace configuration, CI workflows, release configuration, and documentation rules.

Identify:

- The implementation files and symbols related to the issue.
- Public API and adapter layers.
- Tests and fixtures.
- Database models, migrations, indexes, and seed data.
- Configuration schemas, loaders, defaults, and environment bindings.
- Error types, retry and timeout behavior, locks, transactions, cleanup, and rollback paths.
- Authentication, authorization, secret handling, logging, metrics, and tracing.
- Documentation, package metadata, generated artifacts, changesets, and release configuration.
- Callers, consumers, compatibility boundaries, and code in other packages or languages.

Use repository-mandated indexing tools when available. Scope every query to the target repository or worktree. If local instructions require an indexer and none is available, record that limitation instead of pretending a text search is equivalent.

Keep large raw outputs out of the main reasoning context. Store or delegate bulky issue, code, and test output, then retain concise notes with exact paths, symbols, line numbers, and commands.

## 4. Inspect and verify

Trace each requirement through the real implementation. Read enough surrounding code to understand ownership, control flow, state transitions, failure handling, and callers. Do not mark a requirement satisfied because a related function or test exists.

For each requirement, look for the strongest available evidence:

1. Direct source inspection with an exact location.
2. A focused test or script that exercises the real behavior.
3. An integration or end-to-end test across the relevant boundary.
4. A safe runtime reproduction or observed command result.

Prefer direct evidence over agent summaries, comments, names, or compilation alone. A passing build does not prove behavior. A test that only checks implementation details does not prove a user-visible contract.

Run existing validation only when it is safe and non-mutating under the repository rules. Prefer the repository's documented task runner. Use disposable databases, temporary folders, isolated ports, and test fixtures where required. Do not run migrations, destructive cleanup, deployment, or external writes against shared resources. Do not repair failing tests during the review.

Before and after commands, check that the working tree remains unchanged. If a tool generates files, record the generated changes and stop rather than deleting user work. Only remove artifacts that the review itself created and can identify exactly.

Pay special attention to:

- Partial failure after a write, rename, commit, or remote request.
- Retry, timeout, cancellation, stale locks, and idempotency behavior.
- Concurrent operations and isolation between tenants, projects, scopes, or workspaces.
- Input validation before mutation and output contracts at every adapter.
- Backward compatibility for existing callers, data, configuration, and wire formats.
- Resource limits, pagination, ordering, cache freshness, and large inputs.
- Security boundaries, symlink or path traversal behavior, secrets, permissions, and information leakage.
- Test isolation, cleanup, fixture lifecycle, and whether the test actually reaches the claimed path.

## 5. Report findings

Report only issues supported by the issue ledger and actual evidence. Do not report hypothetical risks, style preferences, or duplicate descriptions of one root problem.

Use these severity levels:

- `BLOCKER`: The implementation cannot be safely merged or validated.
- `CRITICAL`: Data loss, corruption, security exposure, severe production failure, or a direct violation of a core requirement.
- `MAJOR`: Incorrect user-visible behavior, important missing requirement, serious reliability or compatibility risk, or a required acceptance test that is absent.
- `MINOR`: Limited requirement gap or low-impact correctness, documentation, or testing issue.
- `INFO`: Ambiguity, observation, or follow-up that does not by itself block the change.

Sort findings by severity. For every finding, use this exact information:

```text
ID: F-001
Severity: MAJOR
Type: missing requirement | incorrect behavior | edge case | regression |
      security | performance | reliability | testing | documentation | ambiguity
Requirement: R-### or AC-###, with the source issue number
Location: exact repository path and line number, or symbol when line numbers are unavailable
Problem: the concrete defect or missing work
Evidence: what the code, test, command, or artifact shows
Impact: what can happen in practice
Recommendation: the smallest concrete correction or clarification
```

A finding must answer all of these questions:

- What requirement is affected?
- Where is the behavior implemented or missing?
- What evidence proves the claim?
- What user, data, security, reliability, or maintenance impact follows?
- What should happen next?

If the implementation is correct, write exactly `No correctness or requirement gaps found.` in the findings section. Do not invent a finding to make the review look useful.

## 6. Use the required output

Begin with exactly one verdict:

```text
APPROVE
APPROVE WITH minor concerns
CHANGES REQUIRED
BLOCKED — insufficient information
```

Then use this structure:

```markdown
### 1. Executive summary

Briefly state whether the implementation satisfies the issue tree and why.

### 2. Findings

Findings sorted by severity. Use the required fields for each finding.

### 3. Requirement coverage matrix

| Requirement | Source issue | Status                                               | Evidence |
| ----------- | ------------ | ---------------------------------------------------- | -------- |
| ...         | ...          | Satisfied / Partial / Missing / Violated / Ambiguous | ...      |

### 4. Test assessment

Explain which requirements have behavioral coverage, which important cases are untested, whether tests validate behavior or implementation details, and the additional tests needed.

### 5. Positive observations

Mention correct and useful implementation choices that are supported by evidence.

### 6. Final recommendation

State whether the change can be merged, which findings must be fixed first, which tests or documentation are required, and which clarification questions remain.
```

Do not hide unresolved ambiguity inside a finding. Put it in the ambiguity register and mark affected requirements `Ambiguous` in the matrix. If one interpretation would violate a requirement and another would not, explain both and ask for clarification.

## 7. Writing pass

Before returning the review, remove filler and vague claims. Keep the meaning, evidence, and exact paths intact.

- Use short, direct sentences.
- Name the actor and mechanism instead of saying that something is "handled" or "ensured".
- Replace claims such as "the implementation appears robust" with the exact behavior and proof.
- Avoid decorative headings, repeated conclusions, stock chatbot phrases, and unnecessary jargon.
- Use straight quotes and ordinary punctuation. Avoid em dashes except for the required blocked verdict literal.
- Keep one idea per sentence where possible.
- Do not soften a confirmed defect with excessive hedging.
- Do not turn every finding into a three-part slogan.

The final review should sound like a senior engineer explaining what the code proves, what it does not prove, and what must happen next.
