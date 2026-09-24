import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The completion check of docs/CORE.md: no feature name in the core contracts
 * or the Electron entry. Words listed under KNOWN_DEBT are tracked leaks with
 * a reason; a new match anywhere fails.
 */
const FORBIDDEN: Array<{ label: string; test: RegExp }> = [
  { label: "checkpoint", test: /checkpoint/iu },
  { label: "git", test: /(^|[^a-z])git($|[^a-z])|[a-z]Git[A-Z]|Git[A-Z]/u },
  { label: "commit", test: /commit/iu },
  { label: "editor", test: /editor/iu },
  { label: "clone", test: /clone/iu },
  { label: "title generation", test: /titleGenerat|generateTitle|ThreadTitle|completeTitle/iu },
  { label: "tier", test: /(^|[^a-z])tier($|[^a-z])|Tier[A-Z]|[a-z]Tier/u },
  { label: "access", test: /access/iu },
  { label: "claude", test: /claude/iu },
];

const KNOWN_DEBT: Record<string, Record<string, string>> = {
  "src/shared/contracts.ts": {
    // Pi's own dialog kinds; `editor` is ctx.ui.editor, not an external editor.
    editor: "Pi dialog kind",
    // External editor ($EDITOR / Ctrl+G) prompt launch result
    ExternalEditorResult: "External editor prompt response contract",
    // Provenance metadata on ExtensionPackageSummary and DesktopExtensionBundle.
    commit: "Extension package provenance commit hash",
  },
  "src/main/index.ts": {},
};

function words(source: string): string[] {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
  return [...new Set(stripped.match(/[A-Za-z][\w-]*/gu) ?? [])];
}

/** The host keeps thread and title handling; only the moved features are checked there. */
const HOST_RULES = new Set(["checkpoint", "git", "editor", "tier", "access", "claude"]);
/**
 * Modules that used to sit in core. They live in `kits/workspace/` now, so a
 * reappearing import would be a copy: `kits-boundary.test.ts` forbids the path,
 * this forbids the name.
 * (Redundant with CORE_MODULE_ALLOWLIST below, but kept for clarity.)
 */
const HOST_FORBIDDEN_IMPORTS = ["git-coordinator", "workspace-git", "workspace-kit-checkpoints", "pi-turn-checkpoint-extension", "turn-checkpoint-codec"];

/**
 * The module specifiers the core may import, one line per resolved file.
 * This is the deliberate act the boundary wants: a new module under `src/main`
 * is a new entry here, and a module that was moved out and renamed back in is
 * not. `test-support` is excluded from the walk, so harnesses are free.
 */
const CORE_MODULE_ALLOWLIST = new Set<string>([
  "./app-menu.js",   "./app-shell.js",   "./app-updates.js",   "./attached-pi-session.js",   "./attached-runtime.js",
  "./attached-thread-backend.js",   "./backend-events.js",   "./bridge-snapshot.js",
  "./bundled-kits.js",   "./client-calls.js",   "./client-message-tracker.js",   "./client-tool-output.js",   "./client-turn-ledger.js",
  "./cli-versions.js",   "./clone-source.js",   "./config-watcher.js",   "./dangling-tool-calls.js",   "./dependency-loader.js",   "./desktop-extensions.js",
  "./extension-bundle-server.js",   "./extension-grants.js",   "./extension-installer.js",
  "./extension-package-activation.js",   "./extension-packages.js",   "./extension-signature.js",
  "./extension-sources.js",   "./extension-ui-coordinator.js",   "./extension-ui.js",
  "./external-editor.js",   "./external-session-shells.js",   "./host-completion.js",   "./host-config.js",
  "./host-clients.js",   "./host-access.js",   "./host-connections.js",   "./client-device.js",
  "./host-extension-errors.js",   "./host-extension-isolation.js",   "./host-extension-worker-protocol.js",
  "./host-extensions.js",   "./host-idle-compaction.js",   "./host-invocation.js",   "./host-jobs.js",   "./host-lifecycle.js",   "./host-lifecycle-coordinator.js",
  "./host-listen.js",   "./host-local-files.js",   "./host-log.js",   "./host-origin.js",
  "./host-messages.js",   "./host-methods.js",   "./host-ports.js",   "./host-publication.js",
  "./host-process-supervisor.js",   "./host-start.js",
  "./host-push-coalescer.js",   "./host-push-log.js",   "./host-report.js",   "./host-text.js",   "./host-tls.js",   "./host-tls-trust.js",   "./host-token.js",   "./host-uplink.js",
  "./host-transcript.js",   "./host-transport-clients.js",   "./host-transport-electron.js",   "./host-transport-socket.js",
  "./host-web-server.js",   "./image-clipboard.js",   "./image-preview.js",
  "./ipc-input.js",   "./lifecycle-queue.js",   "./live-turn-state.js",
  "./managed-workbench-source.js",   "./mcp-endpoint.js",   "./model-attribution.js",   "./model-login.js",   "./model-price-book.js",   "./models-config.js",   "./packaged-app.js",
  "./opencode-catalog.js",
  "./persisted-json.js",   "./persisted-transcript.js",   "./pi-bridge-client.js",
  "./pi-host-components.js",   "./pi-host-options.js",   "./pi-host-support.js",   "./pi-host.js",
  "./pi-kit-extensions.js",   "./pi-model-runtime.js",   "./pi-session-dir.js",   "./platform-process.js",
  "./project-facts-cache.js",   "./project-history.js",   "./project-icon.js",   "./remote-host-trust.js",
  "./prompt-attachments.js",   "./prompt-preparation.js",   "./resource-discovery-cache.js",
  "./runtime-adapters.js",   "./runtime-catalogs.js",   "./runtime-prewarm.js",   "./runtime-resource-cache.js",
  "./runtime-instance-settings.js",   "./runtime-types.js",   "./runtime-versions.js",   "./self-signed-certificate.js",   "./session-entries.js",   "./session-events.js",
  "./session-lineage.js",   "./session-model-provider.js",   "./session-usage.js",
  "./shared-files.js",   "./shell-environment.js",   "./single-instance.js",   "./skill-invocation.js",   "./small-completion-model.js",
  "./startup-workspace.js",   "./system-prompt-resolver.js",   "./tau-runtime-owner.js",
  "./thread-activation.js",   "./thread-binding.js",   "./thread-index.js",   "./thread-projection.js",
  "./thread-runtime-backend.js",   "./thread-runtime-lifecycle.js",   "./thread-runtime.js",
  "./thread-runtimes.js",   "./thread-trash.js",   "./tool-output-batcher.js",   "./transcript-cursor.js",
  "./turn-delivery.js",   "./turn-reconciliation.js",   "./turns-in-flight.js",   "./unavailable-thread-backend.js",
  "./queued-messages.js",   "./quit-shortcut.js",   "./release-notes.js",   "./thread-limits.js",   "./turn-settlement.js",   "./provider-limits.js",
  "./user-themes.js",   "./workbench-build.js",
  "./workbench-reload-coordinator.js",   "./workbench-reloader.js",   "./workbench-source.js",
  "./window-attention.js",   "./window-context-menu.js",   "./window-extensions.js",   "./window-host.js",   "./workspace-identity.js",   "./workspace-watch.js",
  // Runtime-neutral helpers backends share (API 1.12.0), and files that go with an answer.
  "./turn-activity-store.js",   "./elicitation-form.js",   "./answer-attachments.js",   "./turn-attachments.js",
  // What tokens cost: the user's prices, the runtime's, a subscription's value (API 1.12.0).
  "./usage-pricing.js",
  // Signing in from the window: the flows a kit runs and Pi's provider credentials (API 1.12.0).
  "./sign-in-flows.js",   "./model-auth.js",
  // The text of a backend's threads for a search index, answered as a delta (API 1.12.0).
  "./thread-texts.js",
]);

const CORE_ALLOWED_PACKAGES = new Set([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-ai/providers/opencode",
  "@earendil-works/pi-ai/providers/opencode-go",
  // Tool arguments over MCP are checked the way Pi checks them.
  "@earendil-works/pi-ai/utils/validation",
  // The host's MCP endpoint (ADR 0022), loaded on its first request.
  "@modelcontextprotocol/sdk/server/index.js",
  "@modelcontextprotocol/sdk/server/streamableHttp.js",
  "@modelcontextprotocol/sdk/types.js",
  "@earendil-works/pi-coding-agent",
  "electron",
  "electron-updater",
  "esbuild",
  "ws",
]);

/**
 * Whether a specifier may appear in a core module.
 *
 * A relative specifier inside `src/main` is checked against the allowlist, so a
 * renamed module reads as a violation rather than as a normal import - that is
 * the whole difference from matching forbidden words.
 */
function isAllowedCoreImport(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  if (CORE_ALLOWED_PACKAGES.has(specifier)) return true;
  // The shared layer is the contract core is allowed to depend on.
  if (specifier.startsWith("../shared/")) return true;
  if (specifier.startsWith("./")) return CORE_MODULE_ALLOWLIST.has(specifier);
  return false;
}

const IMPORT_PATTERN = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;

function extractImportSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    found.push(match[1] ?? match[2]);
  }
  return found;
}

function coreSourceFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      // Exclude test-support from core module checking
      if (name.startsWith(".") || name === "test-support") continue;
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (/\.[cm]?[jt]sx?$/u.test(name) && !name.includes(".test.")) {
        found.push(path);
      }
    }
  };
  walk("src/main");
  return found;
}

describe("core boundary", () => {
  it.each(["src/main/pi-host.ts", "src/main/pi-host-components.ts", "src/main/host-report.ts", "src/main/host-lifecycle-coordinator.ts", "src/main/thread-activation.ts"])("%s names no moved feature and imports no feature module", (file) => {
    const source = readFileSync(file, "utf8");
    const offenders = words(source).filter((word) => FORBIDDEN.some((rule) => HOST_RULES.has(rule.label) && rule.test.test(word)));
    expect(offenders).toEqual([]);
    // Redundant with allowlist check below, but kept for clarity.
    const imports = HOST_FORBIDDEN_IMPORTS.filter((name) => source.includes(`./${name}.js`) || source.includes(`/${name}.js`));
    expect(imports).toEqual([]);
  });

  it("core modules import only allowed dependencies", () => {
    const violations: string[] = [];
    for (const file of coreSourceFiles()) {
      const source = readFileSync(file, "utf8");
      const specifiers = extractImportSpecifiers(source);
      for (const specifier of specifiers) {
        if (!isAllowedCoreImport(specifier)) {
          violations.push(`${file}: imports "${specifier}" (not in allowlist)`);
        }
      }
    }
    if (violations.length > 0) {
      const message = [
        "Core modules import forbidden dependencies.",
        "If adding a new core file, add its specifier to CORE_MODULE_ALLOWLIST deliberately.",
        "Violations:",
        ...violations,
      ].join("\n  ");
      expect.fail(message);
    }
    expect(violations).toEqual([]);
  });

  // The counter-proof ticket 19 asked for, kept as a test instead of a one-off
  // edit: a module that was moved out and renamed back in must read as a
  // violation without any forbidden word being involved.
  it("rejects a relative module that is not in the allowlist", () => {
    expect(isAllowedCoreImport("./pi-host.js")).toBe(true);
    expect(isAllowedCoreImport("./vcs-bridge.js")).toBe(false);
    expect(isAllowedCoreImport("./git-coordinator.js")).toBe(false);
    // A new third-party dependency is a decision too.
    expect(isAllowedCoreImport("lodash")).toBe(false);
    expect(isAllowedCoreImport("@earendil-works/pi-coding-agent")).toBe(true);
  });

  it("src/ has no extensions directory: a kit lives under kits/", () => {
    const found: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === "extensions") found.push(join(directory, entry.name));
        else walk(join(directory, entry.name));
      }
    };
    walk("src");
    expect(found).toEqual([]);
  });

  // A kit owns the words it sends a model. Core carried a second copy of the
  // title prompt until it stopped titling threads itself; this catches a third.
  it("no core module carries a kit's model prompt", () => {
    // Assembled so this file is not itself a copy of the phrase it forbids.
    const phrase = ["coding-thread", "title"].join(" ");
    const found: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/u.test(entry.name) && readFileSync(path, "utf8").includes(phrase)) found.push(path);
      }
    };
    walk("src");
    expect(found).toEqual([]);
  });

  // The two core files only shrink. Raise a ceiling deliberately, in the same
  // change that explains why the core had to grow.
  for (const [file, ceiling] of Object.entries({ "src/main/pi-host.ts": 2_300, "src/renderer/App.tsx": 700 })) {
    it(`${file} stays under ${ceiling} lines`, () => {
      expect(readFileSync(file, "utf8").split("\n").length).toBeLessThanOrEqual(ceiling);
    });
  }

  for (const [file, debt] of Object.entries(KNOWN_DEBT)) {
    it(`${file} names no feature outside the known debt`, () => {
      const offenders = words(readFileSync(file, "utf8"))
        .filter((word) => !(word in debt))
        .filter((word) => FORBIDDEN.some((rule) => rule.test.test(word)));
      expect(offenders).toEqual([]);
      // Debt that no longer exists should leave the list.
      const stale = Object.keys(debt).filter((word) => !readFileSync(file, "utf8").includes(word));
      expect(stale).toEqual([]);
    });
  }
});
