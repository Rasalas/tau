import type { UiRuntimeBackend } from "../../shared/contracts";
import { runtimeDriver } from "../../shared/runtime-instances";
import { updateAvailable } from "../../shared/runtime-version";
import type { RuntimeCatalogEntry } from "../../workbench/runtime-catalog-store";

/**
 * One entry of Settings → Runtimes, from what the host says of a runtime (its
 * backend entry and its catalog) and whether a card of the runtime's kit is
 * there to act on it. Pure, so the words and buttons are tested without the page.
 */
export type RuntimeState = "built-in" | "missing" | "broken" | "unsafe" | "update" | "current" | "installed" | "sign-in" | "unavailable" | "checking" | "unknown";

/** What the page offers beside a runtime; both scroll to the program row on its card and never run anything themselves. */
export type RuntimeAction = "update" | "install";

export type RuntimeTone = "accent" | "success" | "warn" | "danger" | "muted";

export interface RuntimeRow {
  kind: string;
  label: string;
  state: RuntimeState;
  isDefault: boolean;
  /** Under the name: the state, in a word or two. */
  status: Array<{ text: string; tone: RuntimeTone }>;
  /** The version column: the release, or where the program comes from. */
  version: { text: string; tool?: string };
  /** Why it cannot run, as the runtime said. */
  note?: string;
  /** The model providers its catalog names, in the order it lists them. */
  providers: string[];
  actions: RuntimeAction[];
}

const STATE_WORDS: Partial<Record<RuntimeState, { text: string; tone: RuntimeTone }>> = {
  missing: { text: "Not installed", tone: "muted" },
  broken: { text: "Version does not work", tone: "danger" },
  unsafe: { text: "Version has known problems", tone: "warn" },
  update: { text: "Update available", tone: "accent" },
  current: { text: "Installed · up to date", tone: "success" },
  installed: { text: "Installed", tone: "success" },
  "sign-in": { text: "Needs sign-in", tone: "warn" },
  unavailable: { text: "Unavailable", tone: "warn" },
  checking: { text: "Checking…", tone: "muted" },
};

function runtimeState(backend: UiRuntimeBackend, catalog: RuntimeCatalogEntry | undefined): RuntimeState {
  if (runtimeDriver(backend.kind) === "pi") return "built-in";
  const reason = catalog?.status === "unavailable" ? catalog.reason : undefined;
  if (reason === "not-installed") return "missing";
  const version = backend.version;
  const verdict = version?.compatibility?.status;
  if (verdict === "broken" || verdict === "unsafe") return verdict;
  if (updateAvailable(version)) return "update";
  if (reason === "sign-in-required") return "sign-in";
  if (version?.installed) return version.latest ? "current" : "installed";
  if (catalog?.status === "ready") return "installed";
  if (catalog?.status === "unavailable") return "unavailable";
  return catalog?.status === "loading" ? "checking" : "unknown";
}

export function runtimeRow(backend: UiRuntimeBackend, catalog: RuntimeCatalogEntry | undefined, options: {
  isDefault: boolean;
  /** Whether a card speaks for it. */
  card: boolean;
}): RuntimeRow {
  const state = runtimeState(backend, catalog);
  const version = backend.version;
  const status: RuntimeRow["status"] = [];
  const words = STATE_WORDS[state];
  if (words) status.push(words);
  const tool = version?.tool;
  // What Pi brings inside Tau, as the design words it (1j).
  const versionText = state === "built-in" ? "Built in · agents, worktrees, per-tool approvals"
    : state === "missing" ? "Not found"
      : updateAvailable(version) ? `${version.installed} → ${version.latest}`
        : version?.installed ?? "";
  const models = catalog && catalog.status !== "loading" ? catalog.catalog?.models ?? [] : [];
  const providers = [...new Set(models.map((model) => model.provider))];
  const actions: RuntimeAction[] = [];
  if (options.card && (state === "update" || state === "broken" || state === "unsafe")) actions.push("update");
  if (options.card && state === "missing") actions.push("install");
  return {
    kind: backend.kind,
    label: backend.label,
    state,
    isDefault: options.isDefault,
    status,
    version: { text: versionText, ...(tool && state !== "built-in" ? { tool } : {}) },
    ...(catalog?.status === "unavailable" && catalog.message ? { note: catalog.message } : {}),
    providers,
    actions,
  };
}
