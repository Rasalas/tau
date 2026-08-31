# Domain docs

Engineering skills use this repo's domain documentation before exploring the codebase.

## Before exploring, read these

- Read `CONTEXT.md` at the repo root.
- Read ADRs in `docs/adr/` that touch the area you are about to work in.

If either location does not exist, proceed silently. Do not suggest creating missing domain docs upfront. The `/domain-modeling` skill creates them when the team resolves terms or decisions.

## File structure

This is a single-context repo:

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Use the glossary's vocabulary

When output names a domain concept in an issue title, refactor proposal, hypothesis, or test name, use the term defined in `CONTEXT.md`. Do not substitute a synonym that the glossary avoids.

If a needed concept is absent, reconsider whether the project uses that language. If the gap is real, note it for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, state the conflict rather than silently overriding it:

> Contradicts ADR-0007, "Event-sourced orders," but may be worth reopening because...
