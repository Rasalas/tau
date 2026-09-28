import type { ReactNode } from "react";
import { Monitor, Moon, Palette, Sun } from "lucide-react";
import type { UiModel, UiRuntimeCatalog } from "../../shared/contracts";
import { ProviderIconStack, providerLabel } from "../components/ProviderIconStack";
import { billingBadge, modelKey, offeringKey } from "../components/model-offerings";
import type { PaletteItem, RuntimeModels, WorkbenchActions } from "../extension-system";
import type { PreferencesStore } from "../preferences";
import { DEFAULT_RUNTIME, modelOnPlan } from "../runtime-marks";
import { THEME_PREFERENCES, listUserThemes, type ThemePreference } from "../theme";

/**
 * The rows of core's own palette levels: the theme, a model from every
 * runtime's catalog, and the runtime a new thread runs on. Runtimes and
 * providers are drawn as their icons, named in the icon's label and in the
 * row's search words. Loaded when a level first opens (`runtime-controls`).
 */

const THEME_ROWS: Record<string, { label: string; Icon: typeof Sun }> = {
  system: { label: "System", Icon: Monitor },
  light: { label: "Light", Icon: Sun },
  dark: { label: "Dark", Icon: Moon },
};

export function themeItems(preferences: PreferencesStore, apply: (app: WorkbenchActions, theme: ThemePreference) => void): PaletteItem[] {
  const current = preferences.getSnapshot().theme;
  const row = (id: string, label: string, icon: ReactNode, detail?: string): PaletteItem => ({
    id, label, icon, current: current === id, keywords: ["theme", "appearance"], ...(detail ? { detail } : {}),
    // A Read-only device keeps its theme to itself.
    access: "read",
    run: (app) => apply(app, id),
  });
  return [
    ...THEME_PREFERENCES.map((id) => {
      const { label, Icon } = THEME_ROWS[id]!;
      return row(id, label, <Icon size={14} aria-hidden />);
    }),
    ...listUserThemes().map((theme) => row(theme.id, theme.name, <Palette size={14} aria-hidden />, theme.base && theme.base !== "system" ? `${theme.base} theme` : "your theme")),
  ];
}

/** What a runtime's row says instead of its name: whether a thread can start on it now. */
function runtimeState(catalog: UiRuntimeCatalog | undefined): { label: string; detail?: string } {
  if (catalog?.status === "not-installed") return { label: "Not installed" };
  if (catalog?.status === "sign-in-required") return { label: "Sign-in needed" };
  const count = catalog?.models.length ?? 0;
  if (catalog?.status === "unavailable" && count === 0) return { label: "Unavailable", ...(catalog.note ? { detail: catalog.note } : {}) };
  if (count === 0) return { label: "Ready", detail: "models listed once a thread runs" };
  const models = `${count} model${count === 1 ? "" : "s"}`;
  return { label: "Ready", detail: catalog?.model ? `${models} · starts on ${catalog.model.name}` : models };
}

/** The runtime a thread on screen runs on, or the one the draft on screen is bound for. */
function homeRuntime(app: WorkbenchActions): string {
  return app.activeThread()?.backendKind ?? DEFAULT_RUNTIME;
}

async function runtimeModels(app: WorkbenchActions): Promise<readonly RuntimeModels[]> {
  if (!app.runtimeModels) throw new Error("This window cannot list runtimes.");
  return app.runtimeModels();
}

export async function runtimeItems(actions: WorkbenchActions): Promise<PaletteItem[]> {
  const home = homeRuntime(actions);
  const draft = !actions.activeThread()?.sessionId;
  return (await runtimeModels(actions)).map(({ backend, catalog }) => {
    const state = runtimeState(catalog);
    return {
      id: backend.kind,
      label: state.label,
      ...(state.detail ? { detail: state.detail } : {}),
      icon: <ProviderIconStack runtimeProvider={backend.kind} />,
      keywords: [backend.label, backend.kind, "runtime"],
      current: draft && backend.kind === home,
      access: "write",
      run: (app) => {
        if (!app.startThreadOn) throw new Error("This window cannot start a thread on another runtime.");
        app.startThreadOn(backend.kind);
      },
    };
  });
}

/**
 * Every model a thread could take, the runtime on screen first: one on the
 * same runtime is set on the thread, one of another runtime starts a thread
 * there, as the model picker does. Hidden models stay hidden.
 */
export async function modelItems(preferences: PreferencesStore, actions: WorkbenchActions): Promise<PaletteItem[]> {
  const home = homeRuntime(actions);
  const inUse = actions.activeThread()?.model;
  const { modelPreferences, favouriteModels } = preferences.getSnapshot();
  const favourites = new Set(favouriteModels);
  const runtimes = [...await runtimeModels(actions)].sort((a, b) => Number(b.backend.kind === home) - Number(a.backend.kind === home));
  return runtimes.flatMap(({ backend, catalog }) => {
    const hidden = new Set(modelPreferences[backend.kind]?.hidden);
    const current = (model: UiModel) => backend.kind === home && inUse?.provider === model.provider && inUse.id === model.id;
    const models = (catalog?.models ?? []).filter((model) => !hidden.has(modelKey(model)) || current(model));
    const starred = (model: UiModel) => (favourites.has(offeringKey(backend.kind, model)) ? 0 : 1);
    return models
      .map((model, index) => ({ model, index }))
      .sort((a, b) => starred(a.model) - starred(b.model) || a.index - b.index)
      .map(({ model }): PaletteItem => {
        const badge = billingBadge(model);
        return {
          id: offeringKey(backend.kind, model),
          label: model.name,
          ...(badge ? { detail: badge.label } : {}),
          icon: <ProviderIconStack modelProvider={model.provider} runtimeProvider={backend.kind} plan={modelOnPlan(model)} runtimeName={backend.label} />,
          keywords: [model.id, model.provider, providerLabel(model.provider), backend.label, backend.kind],
          current: current(model),
          access: "write",
          run: async (app) => {
            if (backend.kind === home) {
              if (!app.setModel) throw new Error("This window cannot set a model.");
              await app.setModel(model.provider, model.id);
            } else if (app.startThreadOn) app.startThreadOn(backend.kind, model);
            else throw new Error("This window cannot start a thread on another runtime.");
          },
        };
      });
  });
}
