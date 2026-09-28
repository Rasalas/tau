import type { UiRuntimeBackend } from "../../shared/contracts";
import { runtimeDriver } from "../../shared/runtime-instances";
import { updateAvailable } from "../../shared/runtime-version";
import type { RuntimeCatalogEntry } from "../../workbench/runtime-catalog-store";

/**
 * One row of Settings → Runtimes, from what the host says of a runtime (its
 * backend entry and its catalog) and whether a card on Providers is there to
 * act on it. Pure, so the table's words and buttons are tested without it.
 */
export type RuntimeState = "built-in" | "missing" | "broken" | "unsafe" | "update" | "current" | "installed" | "sign-in" | "unavailable" | "checking" | "unknown";

export type RuntimeAction = "default" | "update" | "install" | "config" | "permissions";

export type RuntimeTone = "accent" | "success" | "warn" | "danger" | "muted";

export interface RuntimeRow {
  kind: string;
  label: string;
  state: RuntimeState;
  isDefault: boolean;
  /** Under the name, in order: "Default for new threads", then the state. */
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
  /** Whether more than one runtime is there to choose the default from. */
  choosable: boolean;
  /** Whether a card on Providers speaks for it. */
  card: boolean;
  /** Whether the page has a section the Permissions button scrolls to. */
  permissions: boolean;
}): RuntimeRow {
  const state = runtimeState(backend, catalog);
  const version = backend.version;
  const status: RuntimeRow["status"] = [];
  if (options.isDefault) status.push({ text: "Default for new threads", tone: "accent" });
  const words = STATE_WORDS[state];
  if (words) status.push(words);
  const tool = version?.tool;
  const versionText = state === "built-in" ? "Built in"
    : state === "missing" ? "Not found"
      : updateAvailable(version) ? `${version.installed} → ${version.latest}`
        : version?.installed ?? "";
  const models = catalog && catalog.status !== "loading" ? catalog.catalog?.models ?? [] : [];
  const providers = [...new Set(models.map((model) => model.provider))];
  const actions: RuntimeAction[] = [];
  if (state === "update" || state === "broken" || state === "unsafe") {
    if (options.card) actions.push("update");
  }
  if (state === "missing") {
    if (options.card) actions.push("install");
  } else {
    if (!options.isDefault && options.choosable) actions.push("default");
    if (state === "built-in" && options.permissions) actions.push("permissions");
    // Update opens the same card Config would.
    if (state === "built-in" || (options.card && !actions.includes("update"))) actions.push("config");
  }
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
