// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { PreferencesStore } from "./preferences";
import { STORAGE_KEYS } from "../workbench/storage-keys";
import { createMemoryStorage, setClientStorage, type ClientStorage } from "../workbench/client-storage";

let preferences: PreferencesStore;
let storage: ClientStorage;

beforeEach(() => {
  storage = createMemoryStorage();
  setClientStorage(storage);
  preferences = new PreferencesStore();
});

describe("settled threads", () => {
  it("can be idempotently returned to active when work resumes", () => {
    preferences.toggleSettled("thread");
    expect(preferences.isSettled("thread")).toBe(true);
    preferences.unsettle("thread");
    preferences.unsettle("thread");
    expect(preferences.isSettled("thread")).toBe(false);
  });
});

describe("transcript detail", () => {
  const write = (value: Record<string, unknown>) => {
    storage.set(STORAGE_KEYS.preferences, JSON.stringify(value));
  };

  it("starts focused", () => {
    expect(new PreferencesStore().getSnapshot().transcriptDetail).toBe("focused");
  });

  it("migrates someone who expanded thinking to the level that shows it", () => {
    write({ showThinking: true });
    expect(new PreferencesStore().getSnapshot().transcriptDetail).toBe("detailed");
  });

  it("leaves someone who never expanded thinking focused", () => {
    write({ showThinking: false });
    expect(new PreferencesStore().getSnapshot().transcriptDetail).toBe("focused");
  });

  it("prefers a stored level over the old flag, and ignores an unknown one", () => {
    write({ showThinking: true, transcriptDetail: "everything" });
    expect(new PreferencesStore().getSnapshot().transcriptDetail).toBe("everything");
    write({ transcriptDetail: "verbose" });
    expect(new PreferencesStore().getSnapshot().transcriptDetail).toBe("focused");
  });

  it("gives one thread its own level and leaves the others alone", () => {
    preferences.overrideTranscriptDetail("thread-a", "everything");
    expect(preferences.transcriptDetailFor("thread-a")).toBe("everything");
    expect(preferences.transcriptDetailFor("thread-b")).toBe("focused");
    expect(preferences.transcriptDetailFor(undefined)).toBe("focused");
  });

  it("holds one override at a time, so leaving a thread drops its own level", () => {
    preferences.overrideTranscriptDetail("thread-a", "everything");
    preferences.overrideTranscriptDetail("thread-b", "detailed");
    expect(preferences.transcriptDetailFor("thread-a")).toBe("focused");
  });

  it("never persists the override", () => {
    preferences.overrideTranscriptDetail("thread-a", "everything");
    const stored = JSON.parse(storage.get(STORAGE_KEYS.preferences) ?? "{}") as Record<string, unknown>;
    expect(stored.transcriptDetailOverride).toBeUndefined();
    expect(stored.transcriptDetail).toBe("focused");
  });

  it("a new default clears whatever one thread had chosen", () => {
    preferences.overrideTranscriptDetail("thread-a", "everything");
    preferences.setTranscriptDetail("detailed");
    expect(preferences.transcriptDetailFor("thread-a")).toBe("detailed");
  });
});

describe("new thread runtime", () => {
  it("is unset until chosen and survives a reload", () => {
    expect(preferences.getSnapshot().newThreadRuntime).toBeUndefined();
    preferences.setNewThreadRuntime("acme");
    expect(new PreferencesStore().getSnapshot().newThreadRuntime).toBe("acme");
    preferences.setNewThreadRuntime(undefined);
    expect(new PreferencesStore().getSnapshot().newThreadRuntime).toBeUndefined();
  });
});

describe("subscription login acknowledgements", () => {
  it("remember each provider once, across reloads", () => {
    expect(preferences.hasAcknowledgedSubscriptionLogin("anthropic")).toBe(false);
    preferences.acknowledgeSubscriptionLogin("anthropic");
    preferences.acknowledgeSubscriptionLogin("anthropic");
    expect(new PreferencesStore().getSnapshot().acknowledgedSubscriptionLogins).toEqual(["anthropic"]);
  });
});

describe("host configuration sync", () => {
  it("synchronizes preferences from host config", async () => {
    const fakeClient = {
      getConfig: async () => ({ theme: "light" as const, showCosts: false, transcriptDetail: "everything" as const }),
      updateConfig: async () => ({}),
    } as unknown as import("../workbench/host-client").HostClient;

    preferences.bindHost(fakeClient);
    await preferences.syncFromHost();

    expect(preferences.getSnapshot().theme).toBe("light");
    expect(preferences.getSnapshot().showCosts).toBe(false);
    expect(preferences.getSnapshot().transcriptDetail).toBe("everything");
  });

  it("sends updates to host config when preferences change", async () => {
    let sentPatch: unknown;
    const fakeClient = {
      getConfig: async () => ({}),
      updateConfig: async (patch: unknown) => { sentPatch = patch; return {}; },
    } as unknown as import("../workbench/host-client").HostClient;

    preferences.bindHost(fakeClient);
    preferences.setTheme("dark");

    expect(sentPatch).toEqual({ theme: "dark" });
  });

  it("syncs user themes from host and registers them", async () => {
    const store = new PreferencesStore();
    const fakeClient = {
      getConfig: async () => ({ theme: "nordic" }),
      listUserThemes: async () => [
        { id: "nordic", name: "Nordic", css: ":root { --acid: #88c0d0; }" },
      ],
    } as unknown as import("../workbench/host-client").HostClient;

    store.bindHost(fakeClient);
    await store.syncFromHost();

    const { getUserTheme, allAvailableThemes } = await import("./theme");
    expect(getUserTheme("nordic")?.name).toBe("Nordic");
    expect(allAvailableThemes()).toContain("nordic");
    expect(store.getSnapshot().theme).toBe("nordic");
  });

  it("syncs keybindings, typography, density, and agent params from host config", async () => {
    const store = new PreferencesStore();
    const fakeClient = {
      getConfig: async () => ({
        keybindings: { "workbench.focus-composer": "ctrl+1" },
        fontFamily: "JetBrains Mono",
        fontSize: 15,
        density: "compact" as const,
        temperature: 0.5,
        maxTokens: 2048,
      }),
    } as unknown as import("../workbench/host-client").HostClient;

    store.bindHost(fakeClient);
    await store.syncFromHost();

    const snapshot = store.getSnapshot();
    expect(snapshot.keybindings).toEqual({ "workbench.focus-composer": "ctrl+1" });
    expect(snapshot.fontFamily).toBe("JetBrains Mono");
    expect(snapshot.fontSize).toBe(15);
    expect(snapshot.density).toBe("compact");
    expect(snapshot.temperature).toBe(0.5);
    expect(snapshot.maxTokens).toBe(2048);
  });

  it("updates and persists density, fontSize, and fontFamily", () => {
    preferences.setDensity("relaxed");
    preferences.setFontSize(14);
    preferences.setFontFamily("Fira Code");

    const snapshot = preferences.getSnapshot();
    expect(snapshot.density).toBe("relaxed");
    expect(snapshot.fontSize).toBe(14);
    expect(snapshot.fontFamily).toBe("Fira Code");

    const reloaded = new PreferencesStore().getSnapshot();
    expect(reloaded.density).toBe("relaxed");
    expect(reloaded.fontSize).toBe(14);
    expect(reloaded.fontFamily).toBe("Fira Code");
  });
});

