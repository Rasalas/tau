# Claude subscriptions and third-party tools

Researched 2026-09-06 for `.scratch/agent-sdk-backend/`. Question: may Tau use a Claude subscription, and through which door?

## What Pi's Anthropic login does

`@earendil-works/pi-ai` 0.84.4, `dist/api/anthropic-messages.js` lines 703–751 and `dist/auth/oauth/anthropic.js`:

- OAuth client id `9d1c250a-e61b-44d9-88ed-5944d1962f5e` with the scopes of Claude Code, including `user:sessions:claude_code`.
- Headers `user-agent: claude-cli/<version>`, `x-app: cli`, `anthropic-beta: claude-code-20250219,oauth-2025-04-20`.
- First system block: "You are Claude Code, Anthropic's official CLI for Claude."

The traffic is indistinguishable from Claude Code by header; Anthropic separates harnesses by behaviour and has done so server-side.

## What Anthropic says

[Legal and compliance, Claude Code Docs](https://code.claude.com/docs/en/legal-and-compliance), section "Authentication and credential use":

- OAuth is "intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
- Developers "should use API key authentication". Anthropic "does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users."
- An end user may sign "in to the unmodified Claude Code binary with their own Claude subscription", including where a platform hosts Claude Code. The binary "must not be modified".
- "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."

[Use the Claude Agent SDK with your Claude plan, Claude Help Center](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan): since 2026-06-15 Pro, Max, Team and Enterprise plans carry a monthly Agent SDK credit (Pro 20 $, Max 5x 100 $, Max 20x 200 $) that covers Agent SDK usage, `claude -p`, GitHub Actions, and "third-party apps that authenticate with your Claude subscription through the Agent SDK". Interactive Claude Code keeps using the plan's own limits.

## Timeline

| Date | Event |
|---|---|
| 2026-01-09 | First server-side rejection of subscription OAuth outside Claude Code |
| 2026-02-19/20 | Terms updated: OAuth in third-party tools is prohibited |
| 2026-04-04 | Subscriptions stop covering third-party harnesses |
| 2026-05-13 / 06-15 | Partial reinstatement through the Agent SDK credit |

Sources: [VentureBeat](https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch), [GIGAZINE](https://gigazine.net/gsc_news/en/20260220-anthropic-third-party-block/), [TechTimes](https://www.techtimes.com/articles/317625/20260602/anthropic-ends-subscription-subsidy-agents-june-15-credit-pool-replaces-flat-rate-access.htm).

## Consequence for Tau

- Pi's Anthropic OAuth login is a terms violation regardless of what Tau does around it. Tau keeps it available anyway, because it is a core Pi feature and Tau runs on the user's `~/.pi/agent`: models behind such a login carry `login: "subscription"`, the picker marks them, the workbench asks once per provider with this page's findings before the first use, and a status item reminds afterwards. The two ways within the terms are an API key in Pi or a Claude Code thread.
- The subscription is reachable only through the unmodified `claude` binary driven by `@anthropic-ai/claude-agent-sdk`. Another open-source workbench does exactly this; Tau's `kits/claude-code/` did it in `--print` mode until 2026-09-07 and drives the SDK since (ADR 0005, amendment 2026-09-07).
- Tau identifies itself through `CLAUDE_AGENT_SDK_CLIENT_APP` and never sets Claude Code's headers or system prompt itself.
