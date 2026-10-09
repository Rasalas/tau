import { createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionUiPrompt,
  HostClientObserver,
  HostExtensionServices,
  HostPairedDevice,
  HostThread,
  HostTurnObserver,
} from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { fakeRelayHandle, startFakeApns, startFakeFcm, startFakeRelay, throwawayApnsKey, throwawayServiceAccount, type FakeRequest } from "../../src/main/test-support/push-fakes.js";
import { createPushHostExtension } from "./host.js";
import { PUSH_EXTENSION_ID as ID, PUSH_STATE_EVENT, sealedPushAad, type PushRelayRegistration, type PushStatus } from "./protocol.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

const IOS_TOKEN = "ab".repeat(32);
const ANDROID_TOKEN = "fcm:APA91b-registration-token";
const OWNER = { kind: "workbench-client" } as const;
const phone = (id: string) => ({ kind: "workbench-client", connection: `c-${id}`, pairedClient: id }) as const;

/** What the phone's app does with a sealed push (mobile/src/push-crypto.ts), in Node. */
function openSealed(sealed: string, relay: PushRelayRegistration): Record<string, unknown> {
  const [version, keyId, data] = sealed.split(".");
  expect([version, keyId]).toEqual(["1", relay.keyId]);
  const bytes = Buffer.from(data!, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(relay.key, "base64url"), bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(sealedPushAad(keyId!)));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]).toString("utf8")) as Record<string, unknown>;
}

const relayFor = (platform: string, token: string): PushRelayRegistration => ({ handle: fakeRelayHandle(platform, token), keyId: randomBytes(16).toString("base64url"), key: randomBytes(32).toString("base64url") });

async function harness(options: { content?: "title" | "excerpt"; attended?: boolean; muted?: string; answer?: (input: unknown) => Record<string, unknown>; notifications?: boolean; relayAnswer?: (request: FakeRequest) => { status: number; body?: unknown }; keysFile?: unknown } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "tau-push-"));
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  if (options.keysFile) {
    await mkdir(join(stateDir, ID), { recursive: true });
    await writeFile(join(stateDir, ID, "keys.json"), JSON.stringify(options.keysFile), { mode: 0o600 });
  }
  const apple = await startFakeApns((request) => request.path.includes("dead") ? { status: 410, reason: "Unregistered" } : { status: 200 });
  const google = await startFakeFcm();
  const relay = await startFakeRelay(options.relayAnswer);
  cleanups.push(apple.close, google.close, relay.close);
  const events: PublishedKitEvent[] = [];
  const observers: HostTurnObserver[] = [];
  const decorators: Array<(prompt: ExtensionUiPrompt) => void> = [];
  const clientObservers: HostClientObserver[] = [];
  let devices: HostPairedDevice[] = [{ id: "iphone", name: "Alex's iPhone", access: "full" }, { id: "pixel", name: "Pixel", access: "full" }];
  const transcript = [{ role: "user", text: "fix it" }, { role: "assistant", text: "## Fixed the build\nThe tests pass now." }];
  const threads: Record<string, Partial<HostThread>> = {
    t1: { sessionId: "t1", sessionName: () => "Fix the build", transcript: async () => transcript as never },
    child: { sessionId: "child", parentThreadId: "t1", sessionName: () => "Index 1" },
  };
  const services: Partial<HostExtensionServices> = {
    stateDir,
    thread: (sessionId) => (sessionId ? threads[sessionId] : undefined) as HostThread | undefined,
    registerTurnObserver: (observer) => { observers.push(observer); return () => undefined; },
    registerThreadLifecycle: () => () => undefined,
    decorateUiPrompt: (decorator) => { decorators.push(decorator); return () => undefined; },
    clients: { count: () => 0, devices: () => devices, observe: (observer) => { clientObservers.push(observer); return () => undefined; } },
    settings: (async () => ({ options: {}, values: options.content ? { content: options.content } : {} })) as never,
  };
  let now = 1_700_000_000_000;
  const work: Array<Promise<unknown>> = [];
  const registry = await activateHostKit(createPushHostExtension({ apnsOrigin: apple.origin, fcmOrigin: google.origin, relayUrl: relay.url, now: () => now, debounceMs: 5_000, track: (promise) => work.push(promise) }), services, (event) => events.push(event));
  cleanups.push(() => registry.dispose());
  if (options.notifications !== false) {
    await registry.activate({
      id: "tau.notifications",
      name: "Notifications",
      activate: (context) => { context.registerCommand("attended", (input) => options.answer?.(input) ?? ({ attended: options.attended === true, muted: (input as { kind?: string } | undefined)?.kind === options.muted }), { callers: [ID] }); },
    });
  }
  const invoke = (command: string, input?: unknown, principal: Parameters<typeof registry.invoke>[3] = OWNER) => registry.invoke(ID, command, input, principal);
  const setUp = async () => {
    await invoke("set-apns", { keyId: "ABC123DEFG", teamId: "TEAM123456", key: throwawayApnsKey().pem });
    await invoke("set-fcm", { serviceAccount: throwawayServiceAccount(google.tokenUri).json });
    await invoke("register", { platform: "ios", token: IOS_TOKEN, host: "host-1", topic: "de.tbuck.tau" }, phone("iphone"));
    await invoke("register", { platform: "android", token: ANDROID_TOKEN, host: "host-1" }, phone("pixel"));
  };
  /** Pushes run after the hook returns; this waits for every one started so far. */
  const settle = async () => { await Promise.all(work.splice(0)); };
  const sends = () => google.requests.filter((request) => request.path !== "/token");
  return {
    stateDir, apple, google, relay, events, observers, decorators, clientObservers, registry, invoke, setUp, settle, sends,
    setDevices: (next: HostPairedDevice[]) => { devices = next; },
    tick: (ms: number) => { now += ms; },
  };
}

describe("the push host half", () => {
  it("takes a registration only from a paired device, and keys only from this machine's owner", async () => {
    const { invoke } = await harness();
    await expect(invoke("register", { platform: "ios", token: IOS_TOKEN, host: "h", topic: "a.b" })).rejects.toThrow(/paired device/u);
    await expect(invoke("register", { platform: "ios", token: "nope", host: "h", topic: "a.b" }, phone("iphone"))).rejects.toThrow(/APNs device/u);
    await expect(invoke("register", { platform: "ios", token: IOS_TOKEN, host: "h" }, phone("iphone"))).rejects.toThrow(/bundle identifier/u);
    await expect(invoke("set-apns", { keyId: "ABC123DEFG", teamId: "TEAM123456", key: throwawayApnsKey().pem }, phone("iphone"))).rejects.toThrow(/owner/u);
    await expect(invoke("status", undefined, { kind: "workbench-client", connection: "lan" })).rejects.toThrow(/owner/u);
    await expect(invoke("notify", { threadId: "t1", kind: "turn" })).rejects.toThrow(/other kits/u);
  });

  it("keeps the keys in a file only this user reads, and never hands them back", async () => {
    const { invoke, setUp, stateDir } = await harness();
    await setUp();
    const status = await invoke("status") as PushStatus;
    expect(status.apns).toMatchObject({ keyId: "ABC123DEFG", teamId: "TEAM123456" });
    expect(status.fcm).toMatchObject({ projectId: "tau-test-project", clientEmail: "push@tau-test-project.iam.gserviceaccount.com" });
    expect(JSON.stringify(status)).not.toMatch(/PRIVATE KEY/u);
    expect(status.devices.map((device) => [device.name, device.platform])).toEqual([["Alex's iPhone", "ios"], ["Pixel", "android"]]);
    expect(status.file).toBe(join(stateDir, ID, "keys.json"));
    if (process.platform !== "win32") {
      expect((await stat(status.file)).mode & 0o777).toBe(0o600);
      expect((await stat(join(stateDir, ID, "devices.json"))).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(status.file, "utf8")).toMatch(/PRIVATE KEY/u);
  });

  it("refuses a key that does not read, naming what is wrong", async () => {
    const { invoke } = await harness();
    await expect(invoke("set-apns", { keyId: "ABC123DEFG", teamId: "TEAM123456", key: "not a key" })).rejects.toThrow(/not a \.p8 key/u);
    await expect(invoke("set-fcm", { serviceAccount: "{}" })).rejects.toThrow(/service_account/u);
  });

  it("pushes a finished turn to every device with the title and the first line of the agent's answer", async () => {
    const { observers, setUp, settle, apple, sends } = await harness();
    await setUp();
    await observers[0]!.runEnded!("t1", "completed");
    await settle();
    expect(apple.requests).toHaveLength(1);
    expect(JSON.parse(apple.requests[0]!.body)).toEqual({
      aps: { alert: { title: "Fix the build", body: "Fixed the build" }, sound: "default", "thread-id": "t1" },
      url: "tau://thread?host=host-1&thread=t1",
      kind: "completed",
    });
    expect(apple.requests[0]!.headers["apns-collapse-id"]).toBe("t1");
    expect(JSON.parse(sends()[0]!.body)).toEqual({
      message: {
        token: ANDROID_TOKEN,
        notification: { title: "Fix the build", body: "Fixed the build" },
        data: { url: "tau://thread?host=host-1&thread=t1", kind: "completed" },
        android: { priority: "HIGH", collapse_key: "t1", notification: { tag: "t1" } },
      },
    });
  });

  it("says only the title and what happened when the user chose titles only", async () => {
    const { observers, setUp, settle, apple } = await harness({ content: "title" });
    await setUp();
    await observers[0]!.runEnded!("t1", "failed");
    await settle();
    expect(JSON.parse(apple.requests[0]!.body).aps.alert).toEqual({ title: "Fix the build", body: "Failed" });
  });

  it("asks a question with the question itself, and a permission with what it is for", async () => {
    const { decorators, setUp, settle, apple, tick } = await harness();
    await setUp();
    decorators[0]!({ id: "q", sessionId: "t1", kind: "select", title: "Which region?", options: ["eu", "us"] });
    await settle();
    tick(10_000);
    decorators[0]!({ id: "p", sessionId: "t1", kind: "confirm", title: "Allow bash?", message: "npm publish" });
    await settle();
    expect(apple.requests.map((request) => JSON.parse(request.body))).toMatchObject([
      { aps: { alert: { body: "Which region?" } }, kind: "question" },
      { aps: { alert: { body: "Allow bash? — npm publish" } }, kind: "approval" },
    ]);
  });

  it("takes 'your turn' from Takeover and pushes the reason", async () => {
    const { registry, setUp, settle, apple } = await harness();
    await setUp();
    await registry.activate({
      id: "tau.takeover",
      name: "Takeover",
      activate: (context) => { context.registerCommand("ask", () => context.invokeHostExtension(ID, "notify", { threadId: "t1", kind: "turn", text: "Enter the code from your phone" })); },
    });
    await registry.invoke("tau.takeover", "ask");
    await settle();
    expect(JSON.parse(apple.requests[0]!.body).aps.alert.body).toBe("Your turn: Enter the code from your phone");
  });

  it("stays quiet while someone is at a client, for a sub-agent and for a thread's second news within seconds", async () => {
    const quiet = await harness({ attended: true });
    await quiet.setUp();
    await quiet.observers[0]!.runEnded!("t1", "completed");
    await quiet.settle();
    const { observers, setUp, settle, apple, tick } = await harness();
    await setUp();
    await observers[0]!.runEnded!("child", "completed");
    await observers[0]!.runEnded!("t1", "completed");
    await settle();
    await observers[0]!.runEnded!("t1", "completed");
    tick(6_000);
    await observers[0]!.runEnded!("t1", "completed");
    await settle();
    expect(quiet.apple.requests).toHaveLength(0);
    expect(apple.requests).toHaveLength(2);
  });

  it("holds news back while the user is at Tau and sends it once they are away, if still unseen", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const asked: unknown[] = [];
      let away = false;
      const seen = new Set<string>();
      const { observers, setUp, settle, apple } = await harness({
        answer: (input) => {
          asked.push(input);
          const threadId = (input as { threadId: string }).threadId;
          return { attended: !away, muted: false, awayInMs: away ? 0 : 240_000, unseen: !seen.has(threadId) };
        },
      });
      await setUp();
      await observers[0]!.runEnded!("t1", "completed");
      await observers[0]!.runEnded!("t2", "completed");
      await settle();
      expect(apple.requests).toHaveLength(0);
      expect(asked[0]).toEqual({ kind: "completed", threadId: "t1", awayAfterMs: 300_000 });
      // t2 was opened at the desk; when the user has gone, only t1 still waits.
      seen.add("t2");
      away = true;
      vi.advanceTimersByTime(241_000);
      await settle();
      await vi.waitFor(() => expect(apple.requests).toHaveLength(1));
      expect(JSON.parse(apple.requests[0]!.body).aps["thread-id"]).toBe("t1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks again later while the user stays at Tau, and lets news go once it was seen", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let unseen = true;
      const { observers, setUp, settle, apple } = await harness({ answer: () => ({ attended: true, muted: false, awayInMs: 300_000, unseen }) });
      await setUp();
      await observers[0]!.runEnded!("t1", "completed");
      await settle();
      vi.advanceTimersByTime(301_000);
      await settle();
      unseen = false;
      vi.advanceTimersByTime(301_000);
      await settle();
      expect(apple.requests).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends nothing the user silenced in Notifications, and asks by the kind of news", async () => {
    const { observers, setUp, settle, apple, tick } = await harness({ muted: "completed" });
    await setUp();
    await observers[0]!.runEnded!("t1", "completed");
    await settle();
    tick(6_000);
    await observers[0]!.runEnded!("t1", "failed");
    await settle();
    expect(apple.requests).toHaveLength(1);
  });

  it("pushes without Notifications Kit, since nobody can say anyone is looking", async () => {
    const { observers, setUp, settle, apple } = await harness({ notifications: false });
    await setUp();
    await observers[0]!.runEnded!("t1", "completed");
    await settle();
    expect(apple.requests).toHaveLength(1);
  });

  it("forgets a device whose token is gone, and one that was revoked", async () => {
    const { invoke, observers, clientObservers, setUp, settle, setDevices, events } = await harness();
    await setUp();
    await invoke("register", { platform: "ios", token: `${IOS_TOKEN}dead`.slice(0, 200), host: "host-1", topic: "de.tbuck.tau" }, phone("iphone"));
    await observers[0]!.runEnded!("t1", "completed");
    await settle();
    expect((await invoke("status") as PushStatus).devices.map((device) => device.id)).toEqual(["pixel"]);
    setDevices([]);
    clientObservers[0]!.devicesChanged!();
    await settle();
    expect((await invoke("status") as PushStatus).devices).toEqual([]);
    expect(events.filter((event) => event.name === PUSH_STATE_EVENT).every((event) => event.payload === undefined)).toBe(true);
  });

  it("sends a test push to one device on the owner's word and records how it went", async () => {
    const { invoke, setUp, apple } = await harness();
    await setUp();
    await expect(invoke("test", { id: "iphone" })).resolves.toEqual({ ok: true });
    expect(JSON.parse(apple.requests[0]!.body)).toEqual({ aps: { alert: { title: "Tau", body: "Push notifications reach this device." }, sound: "default" } });
    const [device] = (await invoke("status") as PushStatus).devices;
    expect(device!.lastPush).toMatchObject({ ok: true });
    await invoke("forget", { service: "apns" });
    await expect(invoke("test", { id: "iphone" })).resolves.toEqual({ ok: false, detail: "This phone's Tau app is too old for Tau's relay; update it, or save a key of your own." });
  });

  it("drops the iPhones' tokens with the APNs key", async () => {
    const { invoke, setUp, stateDir } = await harness();
    await setUp();
    await invoke("forget", { service: "apns" });
    const stored = await readFile(join(stateDir, ID, "devices.json"), "utf8");
    expect(stored).not.toContain(IOS_TOKEN);
    expect(stored).toContain(ANDROID_TOKEN);
  });

  it("never falls back to the relay for a saved key that does not read, and says so", async () => {
    const { invoke, relay } = await harness({ keysFile: { version: 1, apns: { keyId: "ABC123DEFG", teamId: "TEAM123456", key: "not a key", savedAt: "2026-09-24T10:00:00.000Z" } } });
    await invoke("register", { platform: "ios", token: IOS_TOKEN, host: "host-1", topic: "de.tbuck.tau", relay: relayFor("ios", IOS_TOKEN) }, phone("iphone"));
    const status = await invoke("status") as PushStatus;
    expect(status.routes).toEqual({ ios: "direct", android: "relay" });
    expect(status.apns!.error).toMatch(/\.p8/u);
    expect(status.fcm).toBeUndefined();
    await expect(invoke("test", { id: "iphone" })).resolves.toMatchObject({ ok: false, detail: expect.stringMatching(/^The saved APNs key does not read/u) });
    expect(relay.requests).toHaveLength(0);
  });

  it("lets a device stop its own pushes", async () => {
    const { invoke, setUp } = await harness();
    await setUp();
    await expect(invoke("unregister", undefined, phone("pixel"))).resolves.toBe(true);
    expect((await invoke("status") as PushStatus).devices.map((device) => device.id)).toEqual(["iphone"]);
  });
});

describe("the push host half through Tau's relay", () => {
  const IPHONE = relayFor("ios", IOS_TOKEN);
  const PIXEL = relayFor("android", ANDROID_TOKEN);
  const registerBoth = async (invoke: Awaited<ReturnType<typeof harness>>["invoke"]) => {
    await invoke("register", { platform: "ios", token: IOS_TOKEN, host: "host-1", topic: "de.tbuck.tau", relay: IPHONE }, phone("iphone"));
    await invoke("register", { platform: "android", token: ANDROID_TOKEN, host: "host-1", relay: PIXEL }, phone("pixel"));
  };

  it("takes the relay without keys of its own, and says which way each platform goes", async () => {
    const { invoke } = await harness();
    await expect(invoke("register", { platform: "android", token: ANDROID_TOKEN, host: "host-1", relay: PIXEL }, phone("pixel"))).resolves.toEqual({ registered: true, ready: true, route: "relay" });
    await expect(invoke("register", { platform: "ios", token: IOS_TOKEN, host: "host-1", topic: "de.tbuck.tau" }, phone("iphone"))).resolves.toEqual({ registered: true, ready: false, route: "relay" });
    let status = await invoke("status") as PushStatus;
    expect(status.routes).toEqual({ ios: "relay", android: "relay" });
    expect(status.devices.map((device) => [device.id, device.route])).toEqual([["pixel", "relay"], ["iphone", "unreachable"]]);
    // Neither the phone's key nor its handle leaves the host again.
    expect(JSON.stringify(status)).not.toContain(PIXEL.key);
    expect(JSON.stringify(status)).not.toContain(PIXEL.handle);
    await invoke("set-apns", { keyId: "ABC123DEFG", teamId: "TEAM123456", key: throwawayApnsKey().pem });
    status = await invoke("status") as PushStatus;
    expect(status.routes).toEqual({ ios: "direct", android: "relay" });
    // The relay route kept no token; the phone hands it over when it next connects.
    expect(status.devices.find((device) => device.id === "iphone")!.route).toBe("unreachable");
    await expect(invoke("register", { platform: "ios", host: "host-1", topic: "de.tbuck.tau", relay: IPHONE }, phone("iphone"))).resolves.toEqual({ registered: true, ready: false, route: "direct", needsToken: true });
    await expect(invoke("register", { platform: "ios", token: IOS_TOKEN, host: "host-1", topic: "de.tbuck.tau", relay: IPHONE }, phone("iphone"))).resolves.toEqual({ registered: true, ready: true, route: "direct" });
    expect((await invoke("status") as PushStatus).devices.find((device) => device.id === "iphone")!.route).toBe("direct");
  });

  it("keeps no token on the relay route, even from an app that sends one", async () => {
    const { invoke, stateDir } = await harness();
    await registerBoth(invoke);
    const stored = await readFile(join(stateDir, ID, "devices.json"), "utf8");
    expect(stored).not.toContain(IOS_TOKEN);
    expect(stored).not.toContain(ANDROID_TOKEN);
    expect(stored).toContain(PIXEL.handle);
  });

  it("seals what a push says with the phone's key, so the relay sees ciphertext and an opaque collapse id", async () => {
    const { invoke, observers, settle, relay, apple, sends } = await harness();
    await registerBoth(invoke);
    await observers[0]!.runEnded!("t1", "completed");
    await settle();
    expect(apple.requests).toHaveLength(0);
    expect(sends()).toHaveLength(0);
    const sent = relay.sends();
    expect(sent.map((request) => request.handle).sort()).toEqual([IPHONE.handle, PIXEL.handle].sort());
    for (const request of relay.requests) {
      // Spaces, colons and slashes never occur in base64url.
      expect(request.body).not.toMatch(/Fix the build|tau:\/\/|thread=/u);
      expect(request.body).not.toContain(IOS_TOKEN);
    }
    const toPixel = sent.find((request) => request.handle === PIXEL.handle)!;
    const opened = openSealed(toPixel.payload, PIXEL);
    expect(opened).toEqual({ title: "Fix the build", body: "Fixed the build", url: "tau://thread?host=host-1&thread=t1", kind: "completed", tag: toPixel.collapseId });
    expect(toPixel.collapseId).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    // Keyed by HKDF from the phone's key, never by the AES key itself.
    const collapseKey = Buffer.from(hkdfSync("sha256", Buffer.from(PIXEL.key, "base64url"), Buffer.alloc(0), "tau-push:collapse", 32));
    expect(toPixel.collapseId).toBe(createHmac("sha256", collapseKey).update("t1").digest("base64url").slice(0, 22));
    // Each phone's key makes its own collapse id for the same thread.
    expect(sent.find((request) => request.handle === IPHONE.handle)!.collapseId).not.toBe(toPixel.collapseId);
    expect(() => openSealed(toPixel.payload, { ...PIXEL, key: randomBytes(32).toString("base64url") })).toThrow();
  });

  it("forgets a device whose handle the relay calls gone, and asks the phone for a new one when it sends it again", async () => {
    const { invoke, observers, settle } = await harness({ relayAnswer: (request) => (request.body.includes(PIXEL.handle) ? { status: 410, body: { error: "gone", reason: "unknown-handle" } } : { status: 200, body: { ok: true } }) });
    await registerBoth(invoke);
    await observers[0]!.runEnded!("t1", "completed");
    await settle();
    expect((await invoke("status") as PushStatus).devices.map((device) => device.id)).toEqual(["iphone"]);
    await expect(invoke("register", { platform: "android", host: "host-1", relay: PIXEL }, phone("pixel"))).resolves.toEqual({ registered: true, ready: false, route: "relay", renewHandle: true });
    const renewed = { ...PIXEL, handle: fakeRelayHandle("android", `${ANDROID_TOKEN}-renewed`) };
    await expect(invoke("register", { platform: "android", host: "host-1", relay: renewed }, phone("pixel"))).resolves.toEqual({ registered: true, ready: true, route: "relay" });
  });

  it("reports the relay's refusal on the owner's test push", async () => {
    const { invoke } = await harness({ relayAnswer: () => ({ status: 503, body: { error: "unavailable", reason: "apns-not-configured" } }) });
    await registerBoth(invoke);
    await expect(invoke("test", { id: "iphone" })).resolves.toEqual({ ok: false, detail: "relay: apns-not-configured" });
    const [device] = (await invoke("status") as PushStatus).devices.filter((entry) => entry.id === "iphone");
    expect(device!.lastPush).toMatchObject({ ok: false, detail: "relay: apns-not-configured" });
  });

  it("keeps only the handle the phone sent last, and leaves out one that does not read", async () => {
    const { invoke } = await harness();
    await invoke("register", { platform: "android", host: "host-1", relay: PIXEL }, phone("pixel"));
    expect((await invoke("status") as PushStatus).devices[0]!.route).toBe("relay");
    await invoke("register", { platform: "android", host: "host-1" }, phone("pixel"));
    expect((await invoke("status") as PushStatus).devices[0]!.route).toBe("unreachable");
    await invoke("register", { platform: "android", host: "host-1", relay: { ...PIXEL, key: "short" } }, phone("pixel"));
    expect((await invoke("status") as PushStatus).devices[0]!.route).toBe("unreachable");
  });
});

it("requires paired phone consent for encrypted remote starts and cleans up on disable and revoke", async () => {
  const { invoke, observers, settle, relay, setDevices, clientObservers, tick } = await harness();
  const key = relayFor("ios", IOS_TOKEN);
  await invoke("register", { platform: "ios", host: "host-1", topic: "de.tbuck.tau", relay: key }, phone("iphone"));
  const input = { hostId: "host-1", topic: "de.tbuck.tau", enabled: true, relay: key };
  await expect(invoke("activity-start-register", input)).rejects.toThrow(/paired phone/u);
  await expect(invoke("activity-start-register", { ...input, hostId: "other" }, phone("iphone"))).rejects.toThrow(/belong/u);
  await expect(invoke("activity-start-register", { ...input, enabled: false }, phone("iphone"))).rejects.toThrow(/opt-in/u);
  await observers[0]!.prepare!("t1", "turn-1"); await settle(); expect(relay.sends()).toHaveLength(0);
  await invoke("activity-start-register", input, phone("iphone"));
  await observers[0]!.prepare!("t1", "turn-2"); await settle();
  expect(relay.sends()).toHaveLength(1);
  const wire = JSON.stringify(relay.sends()[0]); expect(wire).not.toContain("Fix the build"); expect(wire).not.toContain("host-1");
  const start = relay.sends()[0] as unknown as { activity: { activityId: string } };
  await expect(invoke("activity-register", { hostId: "host-1", threadId: "tau.threads", topic: "de.tbuck.tau", relay: key, activityId: "a".repeat(22), tokenHash: "b".repeat(64) }, phone("iphone"))).rejects.toThrow(/not started/u);
  await invoke("activity-register", { hostId: "host-1", threadId: "tau.threads", topic: "de.tbuck.tau", relay: key, activityId: start.activity.activityId, tokenHash: "b".repeat(64) }, phone("iphone"));
  await settle(); expect(relay.sends()).toHaveLength(2);
  await invoke("activity-disable", undefined, phone("iphone"));
  await observers[0]!.runEnded!("t1", "completed"); await settle();
  expect(relay.sends().filter((row) => "activity" in row)).toHaveLength(2);
  tick(5000); await invoke("activity-start-register", input, phone("iphone"));
  setDevices([]); clientObservers[0]!.devicesChanged!(); await settle();
  await observers[0]!.prepare!("t1", "turn-3"); await settle();
  expect(relay.sends().filter((row) => "activity" in row)).toHaveLength(2);
});

it("ends a fast turn when its remote update token arrives after completion, then permits a new turn", async () => {
  const { invoke, observers, settle, relay, tick } = await harness();
  const key = relayFor("ios", IOS_TOKEN);
  await invoke("register", { platform: "ios", host: "host-1", topic: "de.tbuck.tau", relay: key }, phone("iphone"));
  await invoke("activity-start-register", { hostId: "host-1", topic: "de.tbuck.tau", enabled: true, relay: key }, phone("iphone"));
  await observers[0]!.prepare!("t1", "fast-turn"); await settle();
  const first = relay.sends()[0] as unknown as { activity: { activityId: string } };
  await observers[0]!.runEnded!("t1", "completed"); await settle();
  await invoke("activity-register", { hostId: "host-1", threadId: "tau.threads", topic: "de.tbuck.tau", relay: key, activityId: first.activity.activityId, tokenHash: "b".repeat(64) }, phone("iphone"));
  await settle();
  const activityRequests = relay.sends().filter((row) => "activity" in row) as unknown as Array<{ activity: { event: string } }>;
  expect(activityRequests.map((row) => row.activity.event)).toEqual(["start", "end"]);
  tick(1000); await observers[0]!.prepare!("t1", "next-turn"); await settle();
  expect((relay.sends().filter((row) => "activity" in row) as unknown as Array<{ activity: { event: string } }>).map((row) => row.activity.event)).toEqual(["start", "end", "start"]);
});

/** What the widget extension does with a version 2 activity payload (ActivityCipher.openActivity), in Node. */
function openActivity(sealed: string, relay: PushRelayRegistration, purpose: "start" | "update", activityId: string, tokenHash = ""): Record<string, unknown> {
  const [version, keyId, data] = sealed.split(".");
  expect([version, keyId]).toEqual(["2", relay.keyId]);
  const bytes = Buffer.from(data!, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(relay.key, "base64url"), bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(`tau-activity:2:${keyId}:${purpose}:${activityId}:${tokenHash}`));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]).toString("utf8")) as Record<string, unknown>;
}

it("starts one Live Activity for all of the host's threads and ends it when the last one finishes", async () => {
  const { invoke, observers, decorators, settle, relay, tick } = await harness();
  const key = relayFor("ios", IOS_TOKEN);
  await invoke("register", { platform: "ios", host: "host-1", topic: "de.tbuck.tau", relay: key }, phone("iphone"));
  await invoke("activity-start-register", { hostId: "host-1", topic: "de.tbuck.tau", enabled: true, relay: key }, phone("iphone"));
  await observers[0]!.prepare!("t1", "turn-1"); await settle();
  tick(1000); await observers[0]!.prepare!("t2", "turn-1"); await settle();
  await observers[0]!.prepare!("child", "turn-1"); await settle();
  const sends = () => relay.sends().filter((row) => "activity" in row) as unknown as Array<{ payload: string; activity: { event: string; activityId?: string } }>;
  expect(sends().map((row) => row.activity.event)).toEqual(["start"]);
  const start = sends()[0]!;
  const opened = openActivity(start.payload, key, "start", start.activity.activityId!);
  expect(opened).toMatchObject({ threadId: "tau.threads", state: "running", threads: [{ id: "t1", title: "Fix the build", state: "running" }] });
  await invoke("activity-register", { hostId: "host-1", threadId: "tau.threads", topic: "de.tbuck.tau", relay: key, activityId: start.activity.activityId, tokenHash: "c".repeat(64) }, phone("iphone"));
  await settle();
  decorators[0]!({ id: "q1", sessionId: "t2", kind: "confirm", title: "Allow edit?", message: "src/app.ts" }); await settle();
  const asked = openActivity(sends().at(-1)!.payload, key, "update", start.activity.activityId!, "c".repeat(64));
  expect(asked).toMatchObject({ state: "needs-input", threads: [{ id: "t2", state: "waiting", reason: "Allow edit? — src/app.ts" }, { id: "t1", state: "running" }] });
  await observers[0]!.runEnded!("t1", "completed"); await settle();
  expect(sends().at(-1)!.activity.event).toBe("update");
  tick(60_000); await observers[0]!.runEnded!("t2", "failed"); await settle();
  expect(sends().at(-1)!.activity.event).toBe("end");
  const ended = openActivity(sends().at(-1)!.payload, key, "update", start.activity.activityId!, "c".repeat(64));
  expect(ended).toMatchObject({ state: "completed", threads: [{ id: "t2", state: "failed" }, { id: "t1", state: "done" }] });
  // The next run is a new activity.
  tick(1000); await observers[0]!.prepare!("t1", "turn-2"); await settle();
  expect(sends().map((row) => row.activity.event).filter((event) => event === "start")).toHaveLength(2);
});
