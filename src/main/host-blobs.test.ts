import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_ERROR } from "../shared/host-transport.js";
import { BLOB_PIECE_BYTES, HostBlobStore, createBlobMethods, sendBlob, type BlobRequest, type HostBlobStoreOptions } from "./host-blobs.js";
import type { HostInvocationPrincipal } from "./host-invocation.js";
import { invokeHostMethod } from "./host-methods.js";

const directories: string[] = [];
const stores: HostBlobStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type ClientPrincipal = Extract<HostInvocationPrincipal, { kind: "workbench-client" }>;
const device = (id: string, readOnly = false): ClientPrincipal => Object.freeze({
  kind: "workbench-client", connection: `c-${id}`, pairedClient: id, ...(readOnly ? { readOnly: true as const } : {}),
});
const MINI = device("mini-agents");
const PHONE = device("phone");
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const ID = "0123456789abcdef0123456789abcdef";

async function open(options: Partial<HostBlobStoreOptions> = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), "tau-blobs-")), "blobs");
  directories.push(join(dir, ".."));
  let now = 1_000;
  const store = await HostBlobStore.open({
    dir,
    now: () => now,
    freeBytes: async () => 100 * 1024 ** 3,
    scheduleSweep: () => () => undefined,
    ...options,
  });
  stores.push(store);
  return { store, dir, advance: (ms: number) => { now += ms; } };
}

/** Sends `bytes` in pieces of `piece` bytes as `principal`, straight into the store. */
async function upload(store: HostBlobStore, bytes: Buffer, principal = MINI, id = ID, piece = 4) {
  for (let index = 0, offset = 0; offset < bytes.length || index === 0; index += 1, offset += piece) {
    await store.put(principal, id, index, bytes.subarray(offset, offset + piece).toString("base64"));
  }
  return store.commit(principal, id, sha(bytes), bytes.length);
}

describe("files another machine sends this host", () => {
  it("assembles the pieces, checks the sum, and hands the file over once, then deletes it", async () => {
    const { store, dir } = await open();
    const bytes = Buffer.from("a file from another machine\n");
    expect(await upload(store, bytes)).toEqual({ id: ID, size: bytes.length, sha256: sha(bytes) });
    expect(statSync(join(dir, `${ID}.blob`)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    let seen = "";
    let path = "";
    const answer = await store.take(ID, (blob) => {
      path = blob.path;
      seen = readFileSync(blob.path, "utf8");
      return { size: blob.size, sha256: blob.sha256, device: blob.device };
    });
    expect(answer).toEqual({ size: bytes.length, sha256: sha(bytes), device: "mini-agents" });
    expect(seen).toBe(bytes.toString());
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    await expect(store.take(ID, () => "again")).rejects.toThrow(/expired, was taken already, or never arrived/u);
    expect(store.usage()).toEqual({});
  });

  it("deletes the file even when the taker fails", async () => {
    const { store, dir } = await open();
    await upload(store, Buffer.from("x"));
    await expect(store.take(ID, () => { throw new Error("the kit broke"); })).rejects.toThrow("the kit broke");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("keeps nothing when the sum or the size disagrees", async () => {
    const { store, dir } = await open();
    const bytes = Buffer.from("twelve bytes");
    await store.put(MINI, ID, 0, bytes.toString("base64"));
    await expect(store.commit(MINI, ID, sha(Buffer.from("something else")), bytes.length)).rejects.toThrow(/arrived damaged/u);
    expect(readdirSync(dir)).toEqual([]);
    await expect(store.take(ID, () => undefined)).rejects.toThrow(/never arrived/u);

    await store.put(MINI, ID, 0, bytes.toString("base64"));
    await expect(store.commit(MINI, ID, sha(bytes), bytes.length + 1)).rejects.toThrow(/12 B of .* arrived, the sender sent 13 B/u);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("takes pieces only in order, and refuses what is not base64 or too large", async () => {
    const { store } = await open({ pieceBytes: 6 });
    await expect(store.put(MINI, ID, 1, "YWJj")).rejects.toThrow(/never arrived/u);
    await store.put(MINI, ID, 0, "YWJj");
    await expect(store.put(MINI, ID, 2, "YWJj")).rejects.toThrow(/expected piece 1 .* got 2/u);
    await expect(store.put(MINI, ID, 0, "YWJj")).rejects.toThrow(/started already/u);
    await expect(store.put(MINI, ID, 1, "YWJ!")).rejects.toMatchObject({ code: HOST_ERROR.invalidRequest });
    await expect(store.put(MINI, ID, 1, "YWJjZGVmZ2g=")).rejects.toThrow(/at most 6 bytes/u);
    await expect(store.put(MINI, "short", 0, "YWJj")).rejects.toThrow(/16 to 64/u);
    // The refused pieces changed nothing: piece 1 still fits.
    expect(await store.put(MINI, ID, 1, "ZGVm")).toEqual({ received: 6 });
  });

  it("drops what the sender aborts", async () => {
    const { store, dir } = await open();
    await store.put(MINI, ID, 0, "YWJj");
    expect(await store.abort(PHONE, ID)).toEqual({ aborted: false });
    expect(await store.abort(MINI, ID)).toEqual({ aborted: true });
    expect(readdirSync(dir)).toEqual([]);
    await expect(store.commit(MINI, ID, "0".repeat(64), 3)).rejects.toThrow(/never arrived/u);
  });

  it("lets an upload and a received file live an hour after their last piece, then sweeps them", async () => {
    const { store, dir, advance } = await open();
    const other = "fedcba9876543210fedcba9876543210";
    await upload(store, Buffer.from("ready"));
    await store.put(MINI, other, 0, "YWJj");
    advance(59 * 60_000);
    // A piece restarts the stalled upload's hour; the received file's keeps running.
    await store.put(MINI, other, 1, "ZGVm");
    advance(60_000);
    await expect(store.take(ID, () => undefined)).rejects.toThrow(/expired/u);
    expect(await store.sweep()).toBe(1);
    expect(readdirSync(dir)).toEqual([`${other}.part`]);
    advance(59 * 60_000);
    expect(await store.sweep()).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
    await expect(store.put(MINI, other, 2, "Z2hp")).rejects.toThrow(/never arrived/u);
  });

  it("holds each device to its quota, the size limit, the free disk and a few uploads at once", async () => {
    const { store, dir } = await open({ quotaBytes: 10, maxBytes: 8, maxOpenPerDevice: 2 });
    await upload(store, Buffer.from("abcdef"));
    const second = "1111111111111111";
    await expect(store.put(MINI, second, 0, Buffer.from("ghijkl").toString("base64"))).rejects.toThrow(/keeps 6 B of files here, and 10 B is its limit/u);
    expect(readdirSync(dir)).toEqual([`${ID}.blob`]);
    // Another device has a quota of its own.
    await upload(store, Buffer.from("ghijkl"), PHONE, second);
    expect(store.usage()).toEqual({ "mini-agents": { bytes: 6, files: 1 }, phone: { bytes: 6, files: 1 } });

    const large = "2222222222222222";
    await store.put(PHONE, large, 0, "YWJj");
    await expect(store.put(PHONE, large, 1, "ZGVmZ2hp")).rejects.toThrow(/larger than the 8 B/u);

    await store.put(PHONE, "3333333333333333", 0, "");
    await store.put(PHONE, "4444444444444444", 0, "");
    await expect(store.put(PHONE, "5555555555555555", 0, "")).rejects.toThrow(/already sending 2 files/u);

    const { store: full } = await open({ freeBytes: async () => 512 * 1024 * 1024 + 2 });
    await expect(full.put(MINI, ID, 0, "YWJj")).rejects.toThrow(/does not fit/u);
  });

  it("keeps a device's blob from every other device", async () => {
    const { store } = await open();
    await store.put(MINI, ID, 0, "YWJj");
    await expect(store.put(PHONE, ID, 0, "YWJj")).rejects.toThrow(/never arrived/u);
    await expect(store.put(PHONE, ID, 1, "YWJj")).rejects.toThrow(/never arrived/u);
    await expect(store.commit(PHONE, ID, sha(Buffer.from("abc")), 3)).rejects.toThrow(/never arrived/u);
    await store.commit(MINI, ID, sha(Buffer.from("abc")), 3);
    // A command names its caller: a blob someone else sent stays where it is.
    await expect(store.take(ID, () => undefined, { caller: { device: "phone", owner: false } })).rejects.toThrow(/never arrived/u);
    await expect(store.take(ID, () => undefined, { caller: { owner: true } })).rejects.toThrow(/never arrived/u);
    expect(await store.take(ID, (blob) => blob.size, { caller: { device: "mini-agents", owner: false } })).toBe(3);
  });

  it("empties what an earlier run left", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "tau-blobs-")), "blobs");
    directories.push(join(dir, ".."));
    mkdirSync(dir);
    writeFileSync(join(dir, `${ID}.blob`), "left over");
    const store = await HostBlobStore.open({ dir, scheduleSweep: () => () => undefined });
    stores.push(store);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("answers blob-* for a Full device only, and records one entry per file, not per piece", async () => {
    const { store } = await open();
    const methods = createBlobMethods(() => store);
    const audit: Array<[string, boolean]> = [];
    const full: HostInvocationPrincipal = { ...MINI, audit: (call, allowed) => { audit.push([call.action, allowed]); } };
    const readOnly: HostInvocationPrincipal = { ...device("phone", true), audit: (call, allowed) => { audit.push([call.action, allowed]); } };
    await invokeHostMethod(methods, "blob-put", [ID, 0, "YWJj"], full);
    await invokeHostMethod(methods, "blob-put", [ID, 1, "ZGVm"], full);
    await invokeHostMethod(methods, "blob-commit", [ID, sha(Buffer.from("abcdef")), 6], full);
    await expect(invokeHostMethod(methods, "blob-put", ["9999999999999999", 0, "YWJj"], readOnly)).rejects.toThrow(/Read only/u);
    expect(audit).toEqual([["blob-commit", true], ["blob-put", false]]);
    await expect(invokeHostMethod(methods, "blob-commit", [ID, "nope", 6], full)).rejects.toThrow(/64 hex/u);
    await expect(invokeHostMethod(createBlobMethods(() => undefined), "blob-put", [ID, 0, ""], full)).rejects.toMatchObject({ code: HOST_ERROR.unsupported });
  });
});

describe("sending a file to another host", () => {
  /** The other host, answering in-process through its method table. */
  async function receiver(principal = MINI) {
    const { store, dir } = await open();
    const methods = createBlobMethods(() => store);
    const calls: string[] = [];
    const request: BlobRequest = (method, params, _timeout, options) => {
      calls.push(`${method}:${String(params[1] ?? "")}${options?.compress === false ? ":raw" : ""}`);
      return invokeHostMethod(methods, method, params, principal);
    };
    return { store, dir, request, calls };
  }

  it("cuts a stream into 8 MB pieces, reports progress, and commits the sum the other side checked", async () => {
    const { store, request, calls } = await receiver();
    const bytes = Buffer.alloc(BLOB_PIECE_BYTES * 2 + 5);
    for (let index = 0; index < bytes.length; index += 4_099) bytes[index] = index % 251;
    // A stream in odd-sized chunks, as a file read hands them over.
    const chunks = [bytes.subarray(0, 3_000_001), bytes.subarray(3_000_001, 12_000_000), bytes.subarray(12_000_000)];
    const progress: unknown[] = [];
    const sent = await sendBlob(request, Readable.from(chunks), { size: bytes.length, onProgress: (step) => progress.push(step) });
    expect(sent).toMatchObject({ size: bytes.length, sha256: sha(bytes) });
    // Pieces go without deflate; base64 of random bytes is not worth its time.
    expect(calls).toEqual(["blob-put:0:raw", "blob-put:1:raw", "blob-put:2:raw", `blob-commit:${sent.sha256}`]);
    expect(progress).toEqual([
      { sent: BLOB_PIECE_BYTES, total: bytes.length },
      { sent: BLOB_PIECE_BYTES * 2, total: bytes.length },
      { sent: bytes.length, total: bytes.length },
    ]);
    const same = await store.take(sent.id, (blob) => sha(readFileSync(blob.path)));
    expect(same).toBe(sha(bytes));
  });

  it("sends an empty file as one empty piece", async () => {
    const { store, request } = await receiver();
    const sent = await sendBlob(request, new Uint8Array(0));
    expect(await store.take(sent.id, (blob) => blob.size)).toBe(0);
  });

  it("stops at an abort, and asks the other host to drop what it has", async () => {
    const { store, dir, request, calls } = await receiver();
    const controller = new AbortController();
    const bytes = Buffer.alloc(BLOB_PIECE_BYTES + 1);
    const sending = sendBlob(request, bytes, { signal: controller.signal, onProgress: () => controller.abort() });
    await expect(sending).rejects.toMatchObject({ code: HOST_ERROR.cancelled });
    await expect.poll(() => calls.at(-1)?.split(":")[0]).toBe("blob-abort");
    await expect.poll(() => readdirSync(dir)).toEqual([]);
    expect(store.usage()).toEqual({});
  });

  it("stops at the first refusal, and refuses a file over 2 GB before it sends anything", async () => {
    const { request, calls } = await receiver(device("phone", true));
    await expect(sendBlob(request, Buffer.from("abc"))).rejects.toThrow(/Read only/u);
    await expect(sendBlob(request, Readable.from([]), { size: 3 * 1024 ** 3 })).rejects.toThrow(/larger than the 2.0 GB/u);
    expect(calls.map((call) => call.split(":")[0])).toEqual(["blob-put", "blob-abort"]);
  });
});
