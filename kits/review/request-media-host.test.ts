import { describe, expect, it, vi } from "vitest";
import type { PullRequestRef } from "./protocol.js";
import type { CliRunner } from "./request-cli.js";
import { createRequestMediaResponder } from "./request-media-host.js";
import { requestMediaSource } from "./request-media.js";

const gitlab: PullRequestRef = { service: "gitlab", host: "login.example", repo: "root/repro", number: 1, url: "http://canonical.example/root/repro/-/merge_requests/1" };
const github: PullRequestRef = { service: "github", host: "github.com", repo: "owner/repo", number: 1, url: "https://github.com/owner/repo/pull/1" };
const png = "/uploads/e347d7ff85358d19b72222f1174b9a4b/shot.png";
const mp4 = "/uploads/a06b958502b7f0ce1588f2000a7ac2c0/clip.mp4";
const gh = "https://github.com/user-attachments/assets/1234-abcd";
const api = "https://api.example:3443/api/v4/";
const request = (init?: RequestInit) => new Request("http://capability.test/resources/token", init);

function harness(options: { protocol?: string; endpoint?: string; fetch?: typeof fetch } = {}) {
  const run = vi.fn<CliRunner>(async (command, args, _cwd, opts) => {
    if (command === "gh") return "github-secret";
    if (args[0] === "config") return options.protocol ?? "https";
    opts?.onStderr?.(`REST API Endpoint: ${options.endpoint ?? api}\nToken found in keyring: gitlab-secret\n`);
    return "";
  });
  const fetcher = vi.fn(options.fetch ?? (async () => new Response("image bytes", { headers: { "content-type": "application/octet-stream" } })) as typeof fetch);
  return { run, fetcher, respond: createRequestMediaResponder({ run, fetch: fetcher, cwd: "/workspace", findCommand: (name) => name }) };
}

describe("request upload references", () => {
  for (const source of [png, png.slice(1), `http://canonical.example/root/repro${png}`]) {
    it(`resolves ${source} in the request's project`, () => expect(requestMediaSource(source, gitlab)).toMatchObject({ project: "root/repro", fileName: "shot.png" }));
  }
  it("accepts copied project-ID links and decodes filenames once", () => {
    expect(requestMediaSource("http://canonical.example/-/project/123/uploads/e347d7ff85358d19b72222f1174b9a4b/shot%20one.png", gitlab)).toMatchObject({ project: "123", fileName: "shot one.png" });
  });
  for (const source of ["https://evil.example/root/repro" + png, "/uploads/e347d7ff85358d19b72222f1174b9a4b/%2Fsecret.png", "/uploads/e347d7ff85358d19b72222f1174b9a4b/%5Csecret.png", "/uploads/e347d7ff85358d19b72222f1174b9a4b/%00.png", png + "?token=x", "../secret.png"]) {
    it(`refuses credential-bearing resolution for ${source}`, () => expect(requestMediaSource(source, gitlab)).toBeUndefined());
  }
});

describe("authenticated request media", () => {
  it("uses the CLI login host's HTTPS API, not the canonical web host", async () => {
    const { respond, run, fetcher } = harness();
    const result = await respond(gitlab, png, request());
    expect(await result.text()).toBe("image bytes");
    expect(result.headers.get("content-type")).toBe("image/png");
    expect(run).toHaveBeenCalledWith("glab", ["auth", "status", "--hostname", "login.example", "--show-token"], "/workspace", expect.anything());
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${api}projects/root%2Frepro/uploads/e347d7ff85358d19b72222f1174b9a4b/shot.png`);
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({ "private-token": "gitlab-secret" });
  });
  it("rejects HTTP configuration before credential-bearing auth status", async () => {
    const { respond, run, fetcher } = harness({ protocol: "http" });
    expect((await respond(gitlab, png, request())).status).toBe(502);
    expect(run).toHaveBeenCalledTimes(1); expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects a non-HTTPS effective API endpoint", async () => {
    const { respond, fetcher } = harness({ endpoint: "http://api.example/api/v4/" });
    expect((await respond(gitlab, png, request())).status).toBe(502);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("strips credentials permanently on cross-origin redirects", async () => {
    const headers: Headers[] = [];
    const { respond } = harness({ fetch: (async (_url, init) => {
      headers.push(new Headers(init?.headers));
      if (headers.length === 1) return new Response(null, { status: 302, headers: { location: "https://storage.example/file" } });
      if (headers.length === 2) return new Response(null, { status: 302, headers: { location: `${api}returned` } });
      return new Response("image", { headers: { "content-type": "image/png" } });
    }) as typeof fetch });
    expect((await respond(gitlab, png, request())).status).toBe(200);
    expect(headers.map((h) => h.get("private-token"))).toEqual(["gitlab-secret", null, null]);
  });
  it("streams video ranges and validators with explicit MIME and no-store", async () => {
    const { respond, fetcher } = harness({ fetch: (async () => new Response("part", { status: 206, headers: { "content-type": "application/octet-stream", "content-range": "bytes 2-5/8", "accept-ranges": "bytes", "content-length": "4", etag: "v1" } })) as typeof fetch });
    const response = await respond(gitlab, mp4, request({ headers: { range: "bytes=2-5", "if-range": "v1" } }));
    expect(response.status).toBe(206); expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-range")).toBe("bytes 2-5/8"); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({ range: "bytes=2-5", "if-range": "v1" });
    expect(await response.text()).toBe("part");
  });
  it("HEAD sends no Range and returns no body", async () => {
    const { respond, fetcher } = harness();
    const response = await respond(gitlab, png, request({ method: "HEAD", headers: { range: "bytes=0-" } }));
    expect(response.body).toBeNull(); expect(fetcher.mock.calls[0]![1]?.method).toBe("HEAD");
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).has("range")).toBe(false);
  });
  it("preserves 416 and rejects malformed partial responses", async () => {
    const { respond } = harness({ fetch: (async () => new Response(null, { status: 416, headers: { "content-range": "bytes */8" } })) as typeof fetch });
    const result = await respond(gitlab, mp4, request());
    expect(result.status).toBe(416); expect(result.headers.get("content-range")).toBe("bytes */8");
    const invalid = harness({ fetch: (async () => new Response("bad", { status: 206, headers: { "content-type": "video/mp4" } })) as typeof fetch });
    expect((await invalid.respond(gitlab, mp4, request())).status).toBe(502);
  });
  it("resolves private GitHub uploads to storage without forwarding the token", async () => {
    const { respond, fetcher } = harness({ fetch: (async () => new Response(null, { status: 302, headers: { location: "https://storage.example/signed-image" } })) as typeof fetch });
    const result = await respond(github, gh, request());
    expect(result.status).toBe(302); expect(result.headers.get("location")).toBe("https://storage.example/signed-image");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: "manual", headers: { authorization: "token github-secret" } });
    expect(await result.text()).not.toContain("secret");
  });
  for (const source of [gh.replace("https:", "http:"), gh.replace("github.com", "github.com.evil.test"), gh.replace("github.com", "github.com:444"), gh + "?auth=x"]) {
    it(`never looks up GitHub credentials for ${source}`, async () => {
      const { respond, run } = harness(); expect((await respond(github, source, request())).status).toBe(502); expect(run).not.toHaveBeenCalled();
    });
  }
  it("propagates client aborts and never exposes CLI/request errors", async () => {
    let signal: AbortSignal | undefined;
    const { respond } = harness({ fetch: (async (_url, init) => { signal = init?.signal ?? undefined; throw new Error("gitlab-secret in request headers"); }) as typeof fetch });
    const controller = new AbortController();
    const result = await respond(gitlab, png, request({ signal: controller.signal }));
    controller.abort(); expect(signal?.aborted).toBe(true);
    expect(result.status).toBe(502); expect(await result.text()).toBe("");
  });
});
