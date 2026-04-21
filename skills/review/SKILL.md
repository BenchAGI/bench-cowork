---
name: review
description: Review a pull request or a set of changes. Covers correctness, patterns, naming, tests, blast radius. For Bench monorepo work, applies the codebase conventions (CLAUDE.md). Use when the user says "review this PR", "look at my changes", "code review", or is about to merge something non-trivial.
---

# Review (Tier D)

Perform a substantive code review on a PR or a local diff. Substantive, not nit-picking.

## When to use

- User says: "review this PR", "code review", "look at the diff"
- User is about to merge something non-trivial
- You just implemented something and want a second-pass critique before calling it done

## Scope

A review covers:
1. **Correctness** — does the code do what the description says?
2. **Patterns** — does it match existing patterns in the repo? (Grep for similar code; check `CLAUDE.md`.)
3. **Naming** — are names load-bearing? Are abbreviations clear?
4. **Tests** — are critical paths tested? Are tests meaningful, not boilerplate?
5. **Blast radius** — what else might this change affect?
6. **Comments** — are there comments explaining *what* (delete them)? Are there comments missing that explain *why* (add them)?
7. **Simplification** — would the `simplify` skill find anything here?

## Workflow

### 1. Read the diff

If it's a PR: `gh pr diff <N>` or `gh pr view <N> --json files`.
If it's local: `git diff main...HEAD` or the user's specified base.

### 2. Understand the "why"

- PR description
- Linked issue
- Commit messages
- Canon: `mcp__bench-wiki__wiki_search` for related decisions

### 3. Produce findings

For each finding, use this shape:

```
**<file:line>** — <severity: nit | question | concern | blocker>
<what you noticed>
<why it matters>
<proposed fix if you have one>
```

Severity rubric:
- **nit**: style / micro-preference; author can ignore
- **question**: need info to judge; ask the author
- **concern**: real issue; would merge only with explanation
- **blocker**: must-fix before merge; correctness, security, or pattern violation

### 4. Give the verdict

One of:
- **LGTM** — approve, all findings are nits or questions
- **Request changes** — one or more concerns/blockers; list them
- **Needs discussion** — architectural question beyond line-by-line

### 5. Post the review (if asked)

Via GitHub: `gh pr review <N> --comment --body "$(cat <<'EOF' ... EOF)"` or `--approve` / `--request-changes`.

## What not to do

- **Don't rewrite the code in the review.** Suggest, don't impose. The author decides.
- **Don't repeat what the PR description already says.** Focus on what's in the diff.
- **Don't flag stylistic preferences as blockers.** If the repo has lint/format, trust it.
- **Don't cargo-cult existing patterns.** If the existing pattern is actually wrong, flag both the pattern and the new code.

## Bench monorepo specifics

- Check `CLAUDE.md` for conventions
- `packages/` changes need both web + desktop coordination — flag if only one side is updated
- Auth / billing / data access → also run `security-review`
- Firebase Firestore rules need companion rule updates in `firestore.rules`
- GeoJSON / 3D viewer changes need `@kestrel/viewer-core` test runs
