# Contributing to Tau

Thanks for helping. Tau is a young project: expect the interfaces to move, and
open an issue before you start on anything bigger than a bug fix, so we can
agree on where it belongs first.

## Set up

You need Node.js 22 and Git. Pi, Codex and the other agent runtimes are
optional; Tau runs without them.

```bash
npm install
npm run dev       # Electron with hot reload
npm run dev:web   # the UI in a browser, with fixture data
```

To use your change as an app for a while, `npm run install:mac -- --local`
installs this checkout as **Tau Dev** (`/Applications/Tau Dev.app`) beside
your Tau, with its own data, ports and `~/.tau-dev` and without updates
([docs/install.md](docs/install.md#tau-dev-a-build-of-this-checkout-beside-tau)).
To try a change in isolation from your own data, use `npm run dev:instance`
([docs/agents/testing-the-app.md](docs/agents/testing-the-app.md)).

[docs/architecture.md](docs/architecture.md) explains the architecture; [docs/CORE.md](docs/CORE.md)
and [docs/EXTENSIONS.md](docs/EXTENSIONS.md) describe the core and the extension
API; [CONTEXT.md](CONTEXT.md) defines the words the code uses.

## Where a change goes

- **Core stays small.** `src/` owns threads, the transcript, the composer and
  placement. A feature belongs in a kit (`kits/<name>/`, see
  [kits/README.md](kits/README.md)). If a kit needs something no kit can do
  today, add a small, generic, documented seam to core first, then the kit.
  The boundary tests (`src/shared/core-boundary.test.ts` and its siblings)
  enforce this.
- **Kits don't import each other.** They talk through services and host
  commands ([ADR 0020](docs/adr/0020-host-command-authority.md)).
- **Decisions are recorded as ADRs** in [docs/adr/](docs/adr/). A change that
  reverses one needs a new ADR.

## Before you open a pull request

```bash
npm run lint && npm run typecheck && npm test
```

- Tests live next to the code (Vitest). A test must not depend on timing.
- Performance budgets live in [docs/PERFORMANCE.md](docs/PERFORMANCE.md);
  don't raise a budget to make a change fit.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
  in English (`feat(review): …`, `fix(core): …`). Keep them small.
- Describe what changed, why, and how you checked it. For UI changes, add a
  screenshot.
- For a change you checked in the running app, say so; for one you could not
  check (another OS, a runtime you don't have), say that too.

## Licence

Tau is licensed under the [MIT License](LICENSE). By contributing, you agree
that your contribution is licensed under the same terms. Don't add code copied from another project unless its licence allows
it; if you do, keep its copyright notice and say where it came from in the pull
request.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
