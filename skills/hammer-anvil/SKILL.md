---
name: hammer-anvil
description: Use a Hammer/Anvil workflow on a complex or ambiguous task. Hammer widens the search space (exploration, architecture, critique, de-risking). Anvil narrows it (implementation, repair, verification). Use for dual-pass work, ambiguous scope, or risky changes where the cost of a wrong first pass is high.
---

# Hammer/Anvil (Tier D)

Use this skill when a task is large, ambiguous, cross-cutting, or easy to get wrong on the first pass.

## Roles

### Hammer

- Exploration
- Architecture
- Adversarial critique
- Blast-radius discovery
- De-risking before edits

Hammer widens the search space and returns a small, actionable plan.

### Anvil

- Implementing a bounded plan
- Repair passes
- Cleanup
- Consistency work
- Verification

Anvil narrows the search space and aims for the smallest safe patch.

## When to use

Use Hammer/Anvil especially for:
- Cross-package refactors
- Migration work
- Security-sensitive changes
- Anything involving auth, billing, or data-access boundaries
- Features that touch more than 3 components

## Default workflow

1. **Hammer pass.** List the affected surfaces, risks, and the smallest-viable plan. Don't code yet.
2. **Freeze the plan.** Write it down. Confirm with the user before proceeding.
3. **Anvil pass.** Implement the frozen plan. Smallest possible diff.
4. **Hammer review.** If blast radius is non-trivial, re-critique before merging.

## Required output shape

### Hammer output

```
## Surfaces affected
- <file / package / system>

## Blast radius
<what else might break>

## Risks
<concrete failure modes>

## Plan (smallest viable)
1. <step>
2. <step>

## Open questions
<what we haven't decided>
```

### Anvil output

Just the diff. No narrative unless the user asks. Show:
- Files changed
- Key lines
- Test run results
- What to verify before merging

## Pairing with other agents

- If Hammer surfaces product ambiguity → hand off to **Piper** for PRD
- If Hammer surfaces UX concerns → **Piper**
- If Anvil finishes and needs external comms → **Aurelius**
- If it's an engineering implementation → **Kestrel-Coder** runs both passes
