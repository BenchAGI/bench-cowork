---
name: simplify
description: Review changed code for reuse, quality, and efficiency, then fix any issues found. Use after writing non-trivial code, before opening a PR, or when the user asks for a cleanup pass. Applies the "smallest safe change" rubric from the Bench monorepo.
---

# Simplify (Tier D)

Review code you (or the user) just wrote. Find opportunities to collapse, reuse, or clarify — then fix them.

## When to use

- After writing a feature, before opening a PR
- When the user says "can you simplify this", "review this", "tighten this up"
- When you notice yourself duplicating logic across files
- Before landing anything that touches a hot path

## Review rubric

### 1. Reuse

- Are we duplicating code that already exists elsewhere? (Grep before writing helpers.)
- Is there a shared `packages/` util for this? Check `@kestrel/utils`, `@kestrel/types`, etc.
- Is this a pattern that should be extracted? (Only if used 3+ times. Premature abstraction hurts more than copy-paste.)

### 2. Quality

- Does every function have a clear single purpose?
- Are variable names load-bearing? (`let result = ...` bad; `let mergedCanon = ...` good)
- Are error paths specific? (Don't catch, log, and continue — decide what state the system is in.)
- Are there comments that explain **what** the code does? (Delete them. Only keep comments that explain **why** something non-obvious.)

### 3. Efficiency

- Is this in a loop that doesn't need to be?
- Are we fetching data we don't use?
- Are we over-batching or under-batching? (Firestore reads: 1 per doc expensive; check if we can query-then-iterate.)
- Does this run client-side when it could run server-side (or vice versa)?

### 4. Surface area

- Does this introduce a new file when we could edit an existing one?
- Does this introduce a new function signature when we could widen an existing one?
- Does this introduce a new type when we could reuse or narrow an existing one?

## Output

After review, do ONE of these:

1. **"Looks good."** — if genuinely nothing to simplify. Be honest; not every diff is dirty.
2. **Show the diffs.** — for each finding, show the before/after and the reason.
3. **Apply the diffs.** — if the user is in auto mode, just apply them and report.

## Anti-patterns to watch for

- **Re-exports for no reason** — `export { foo } from './foo'` in a barrel file when there's no consumer yet.
- **Feature-flagged code that's always on** — if the flag's been 100% for 2+ weeks, remove the flag.
- **Error handling for impossible states** — validating internal code that already has TypeScript guarantees.
- **Premature helpers** — 3 similar lines are better than an abstraction used once.
- **Comments that repeat the function name** — `// fetches user from db` above `fetchUserFromDb`.

## When NOT to simplify

- Code that's working under production load. Unless there's a bug, don't touch it.
- Third-party library wrappers (React, Firebase, etc.) — their API shapes drive yours.
- Generated code.
- Test fixtures that are deliberately verbose for clarity.
