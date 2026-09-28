## Agent skills

### Issue tracker

Issues are tracked as local Markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five canonical label names. See `docs/agents/triage-labels.md`.

### Domain docs

This repo uses a single-context domain-doc layout. See `docs/agents/domain.md`.

### Testing the app

Verifying a change in the real app runs through an isolated Tau instance, never the user's real data or their own running window. See `.agents/skills/test-tau-app/SKILL.md` and `docs/agents/testing-the-app.md`.

A component test waits for the data it reads, not for the region around it; `TAU_TEST_SLOW_RENDERS=30` makes a test that does not fail every time. See "Component tests" in `docs/agents/testing-the-app.md`.
