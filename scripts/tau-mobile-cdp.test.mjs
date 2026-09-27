import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  DEVICES,
  assertLoopbackSocket,
  assertOwnProcess,
  assertPhoneUrl,
  chromeArgs,
  emulationSteps,
  findChromium,
  hostCall,
  instanceHost,
  isLoopbackHost,
  parseArgs,
  parseWindow,
  pickPairingUrl,
  sameCode,
  touchSteps,
} from "./tau-mobile-cdp.mjs";

describe("parseArgs", () => {
  it("splits the command, positionals and flags", () => {
    expect(parseArgs(["pair", "--label", "Phone", "--allow=owner", "--test-host"])).toEqual({
      command: "pair",
      args: [],
      flags: { label: "Phone", allow: "owner", "test-host": true },
    });
  });

  it("names one of several test hosts with --test-host=<name>", () => {
    expect(parseArgs(["host", "connections-list", "--test-host=rex"]).flags).toEqual({ "test-host": "rex" });
  });

  it("collects a repeated --resolve", () => {
    expect(parseArgs(["launch", "--resolve", "a.ts.net", "--resolve", "b.ts.net", "--fresh"]).flags).toEqual({ resolve: ["a.ts.net", "b.ts.net"], fresh: true });
  });

  it("keeps an expression with spaces as one positional", () => {
    expect(parseArgs(["tap", "document.querySelector('a b')"]).args).toEqual(["document.querySelector('a b')"]);
  });

  it("refuses a flag without its value", () => {
    expect(() => parseArgs(["pair", "--label"])).toThrow(/needs a value/);
  });
});

describe("the phone stays on this machine", () => {
  it("knows loopback", () => {
    for (const host of ["127.0.0.1", "127.8.9.1", "localhost", "::1", "[::1]"]) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ["192.168.1.2", "10.0.2.2", "example.com", "100.101.102.1", "127.0.0.1.nip.io"]) expect(isLoopbackHost(host)).toBe(false);
  });

  it("opens loopback, and a name only when launch maps it to loopback", () => {
    expect(assertPhoneUrl("http://127.0.0.1:5000/#pair=x")).toBe("http://127.0.0.1:5000/#pair=x");
    expect(assertPhoneUrl("http://box.tail0000.ts.net:18443/", ["box.tail0000.ts.net"])).toBe("http://box.tail0000.ts.net:18443/");
    expect(() => assertPhoneUrl("http://box.tail0000.ts.net:18443/")).toThrow(/stays on this machine/);
    expect(() => assertPhoneUrl("https://192.168.1.47:7788/")).toThrow(/neither loopback/);
    expect(() => assertPhoneUrl("file:///etc/passwd")).toThrow(/not a web page/);
  });

  it("calls a host as its owner over loopback only", () => {
    expect(assertLoopbackSocket("wss://127.0.0.1:7788")).toBe("wss://127.0.0.1:7788");
    expect(() => assertLoopbackSocket("wss://100.101.102.1:7788")).toThrow(/not on loopback/);
    expect(() => assertLoopbackSocket("http://127.0.0.1:7788")).toThrow(/not a host socket/);
  });

  it("maps --resolve names to 127.0.0.1 and nothing else", () => {
    const args = chromeArgs({ port: 9000, profile: "/p", device: "iphone", names: ["box.tail0000.ts.net"] });
    expect(args).toContain("--host-resolver-rules=MAP box.tail0000.ts.net 127.0.0.1");
    expect(args).toContain("--user-data-dir=/p");
    expect(args).toContain("--window-size=393,852");
    expect(chromeArgs({ port: 9000, profile: "/p", device: "iphone" }).some((arg) => arg.startsWith("--host-resolver-rules"))).toBe(false);
    expect(() => chromeArgs({ port: 9000, profile: "/p", device: "iphone", names: ["x, MAP * 1.2.3.4"] })).toThrow(/not a host name/);
  });

  it("signals only a process whose command line names this worktree", () => {
    expect(() => assertOwnProcess("/x/chrome --user-data-dir=/w/.tau-dev/mobile/chrome-profile", "--user-data-dir=/w/.tau-dev/mobile/chrome-profile", "pid 1")).not.toThrow();
    expect(() => assertOwnProcess("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--user-data-dir=/w/.tau-dev/mobile/chrome-profile", "pid 1")).toThrow(/refusing/);
    expect(() => assertOwnProcess("", "/w", "pid 1")).toThrow(/gone/);
  });
});

describe("findChromium", () => {
  const home = "/home/me";

  it("prefers TAU_MOBILE_CHROME", () => {
    expect(findChromium({ env: { TAU_MOBILE_CHROME: "/opt/chrome" }, exists: () => false, list: () => [] })).toBe("/opt/chrome");
  });

  it("takes the newest Playwright build on macOS", () => {
    const found = findChromium({
      env: {},
      platform: "darwin",
      home,
      list: () => ["chromium-1148", "chromium-1243", "chromium_headless_shell-1243", "ffmpeg-1011"],
      exists: (path) => path.includes("chromium-1243/chrome-mac-arm64"),
    });
    expect(found).toBe("/home/me/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
  });

  it("falls back to an installed Chromium on Linux", () => {
    expect(findChromium({ env: {}, platform: "linux", home, list: () => [], exists: (path) => path === "/usr/bin/chromium" })).toBe("/usr/bin/chromium");
  });

  it("says how to get one when there is none", () => {
    expect(() => findChromium({ env: {}, platform: "linux", home, list: () => [], exists: () => false })).toThrow(/TAU_MOBILE_CHROME/);
  });
});

describe("emulationSteps", () => {
  it("makes a touch device in front with the device's metrics and insets", () => {
    const steps = Object.fromEntries(emulationSteps("iphone", "light"));
    expect(steps["Emulation.setDeviceMetricsOverride"]).toMatchObject({ width: 393, height: 852, mobile: true, screenOrientation: { type: "portraitPrimary" } });
    expect(steps["Emulation.setTouchEmulationEnabled"]).toEqual({ enabled: true, maxTouchPoints: 5 });
    expect(steps["Emulation.setFocusEmulationEnabled"]).toEqual({ enabled: true });
    expect(steps["Emulation.setEmulatedMedia"].features).toEqual([{ name: "prefers-color-scheme", value: "light" }]);
    expect(steps["Emulation.setSafeAreaInsetsOverride"].insets).toEqual(DEVICES.iphone.insets);
    expect(steps["Emulation.setUserAgentOverride"].userAgent).toMatch(/iPhone/);
  });

  it("keeps the device's screen when the app's window is smaller, as in Split View", () => {
    const [, metrics] = emulationSteps("ipad-landscape", "dark", { width: 592, height: 820 })[0];
    expect(metrics).toMatchObject({ width: 592, height: 820, screenWidth: 1180, screenHeight: 820 });
    expect(parseWindow(["full"])).toBeUndefined();
    expect(parseWindow(["375", "820"])).toEqual({ width: 375, height: 820 });
    expect(() => parseWindow(["wide"])).toThrow(/window <width> <height>/);
  });

  it("turns a landscape device sideways", () => {
    const [, metrics] = emulationSteps("ipad-landscape")[0];
    expect(metrics.screenOrientation).toEqual({ type: "landscapePrimary", angle: 90 });
  });

  it("refuses an unknown device", () => {
    expect(() => emulationSteps("nokia")).toThrow(/unknown device/);
  });
});

describe("touchSteps", () => {
  const box = { x: 100, y: 200, w: 300, h: 60 };

  it("taps with a start and an end at the center", () => {
    expect(touchSteps("tap", box)).toEqual([
      { type: "touchStart", touchPoints: [{ x: 100, y: 200, id: 1 }], waitMs: 0 },
      { type: "touchEnd", touchPoints: [], waitMs: 40 },
    ]);
  });

  it("holds a long press", () => {
    expect(touchSteps("longpress", box, { holdMs: 650 }).at(-1)).toEqual({ type: "touchEnd", touchPoints: [], waitMs: 650 });
  });

  it("starts a leftward swipe near the right edge and ends dx away", () => {
    const steps = touchSteps("swipe", box, { dx: -200, steps: 4 });
    expect(steps[0].touchPoints[0]).toEqual({ x: 230, y: 200, id: 1 });
    expect(steps.filter((step) => step.type === "touchMove")).toHaveLength(4);
    expect(steps.at(-2).touchPoints[0]).toEqual({ x: 30, y: 200, id: 1 });
    expect(steps.at(-1).type).toBe("touchEnd");
  });
});

describe("pairing", () => {
  const urls = [
    { url: "https://192.168.1.2:7788/#pair=abc&k=lan", reachability: "network", kind: "lan" },
    { url: "http://127.0.0.1:5000/#pair=abc&k=loopback", reachability: "loopback", kind: "loopback" },
  ];

  it("opens the loopback link", () => {
    expect(pickPairingUrl(urls)).toBe("http://127.0.0.1:5000/#pair=abc&k=loopback");
  });

  it("keeps the fragment when it goes through a proxy's origin", () => {
    expect(pickPairingUrl(urls, "http://box.tail0000.ts.net:18443")).toBe("http://box.tail0000.ts.net:18443/#pair=abc&k=loopback");
  });

  it("compares six digits, however they are spaced", () => {
    expect(sameCode("987 248", "987248")).toBe(true);
    expect(sameCode("987 248", "987249")).toBe(false);
    expect(sameCode("", "")).toBe(false);
  });
});

describe("instanceHost", () => {
  it("reads the host's socket and pid from the instance's userData", () => {
    const files = {
      "/w/.tau-dev/instance.json": JSON.stringify({ userData: "/w/.tau-dev/userdata" }),
      "/w/.tau-dev/userdata/host.json": JSON.stringify({ pid: 42, url: "ws://127.0.0.1:5000" }),
    };
    expect(instanceHost({ devDir: "/w/.tau-dev", readFile: (path) => files[path] })).toEqual({ url: "ws://127.0.0.1:5000", pid: 42, tokenFile: "/w/.tau-dev/host-token" });
  });

  it("says to start an instance when there is none", () => {
    expect(() => instanceHost({ devDir: "/w/.tau-dev", readFile: () => { throw new Error("ENOENT"); } })).toThrow(/npm run dev:instance/);
  });
});

class FakeSocket extends EventEmitter {
  static last;
  sent = [];
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    FakeSocket.last = this;
    queueMicrotask(() => this.emit("open"));
  }
  send(data) {
    const frame = JSON.parse(data);
    this.sent.push(frame);
    if (frame.type === "hello") queueMicrotask(() => this.emit("message", JSON.stringify({ type: "hello-reply", id: frame.id, reply: {} })));
    if (frame.type === "request") {
      const response = frame.request.method === "connections-list"
        ? { id: frame.request.id, result: { requests: [] } }
        : { id: frame.request.id, error: { message: "forbidden" } };
      queueMicrotask(() => this.emit("message", JSON.stringify({ type: "response", response })));
    }
  }
  close() {}
}

describe("hostCall", () => {
  it("says hello with the host token, then makes the call", async () => {
    const result = await hostCall({ url: "ws://127.0.0.1:5000", token: "secret", method: "connections-list", WebSocketImpl: FakeSocket });
    expect(result).toEqual({ requests: [] });
    expect(FakeSocket.last.sent).toEqual([
      { type: "hello", id: "owner", hello: { protocol: 1, token: "secret", auxiliary: true } },
      { type: "request", request: { id: "call", method: "connections-list", params: [] } },
    ]);
  });

  it("rejects with the host's error", async () => {
    await expect(hostCall({ url: "ws://127.0.0.1:5000", token: "t", method: "connections-approve", params: ["x"], WebSocketImpl: FakeSocket })).rejects.toThrow(/forbidden/);
  });

  it("never dials beyond loopback", async () => {
    await expect(hostCall({ url: "wss://192.168.1.2:7788", token: "t", method: "connections-list", WebSocketImpl: FakeSocket })).rejects.toThrow(/not on loopback/);
  });
});
