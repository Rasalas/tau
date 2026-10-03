import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerUsePolicy, approvedRecordingDirectory } from "./policy.js";

const roots: string[] = [];
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "tau-computer-policy-"));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("shared Computer Use policy", () => {
  it("caches only approved exact launch arguments, independent of object key order", async () => {
    const confirm = vi.fn(async () => true);
    const policy = new ComputerUsePolicy({ cwd: "/tmp", confirm });
    await policy.approve("launch_app", { name: "Safari", urls: ["https://example.com"] });
    await policy.approve("launch_app", { urls: ["https://example.com"], name: "Safari" });
    await policy.approve("launch_app", { name: "Safari", urls: ["https://other.example"] });
    expect(confirm).toHaveBeenCalledTimes(2);
    const another = new ComputerUsePolicy({ cwd: "/tmp", confirm });
    await another.approve("launch_app", { name: "Safari", urls: ["https://example.com"] });
    expect(confirm).toHaveBeenCalledTimes(3);
  });
  it("shares launch approval between transport callbacks without retaining a UI context", async () => {
    const policy = new ComputerUsePolicy({ cwd: "/tmp" });
    const piConfirm = vi.fn(async () => true);
    const mcpConfirm = vi.fn(async () => false);
    await expect(policy.approve("kill_app", {})).rejects.toThrow("interactive confirmation");
    await policy.approve("launch_app", { name: "Safari" }, undefined, piConfirm);
    await policy.approve("launch_app", { name: "Safari" }, undefined, mcpConfirm);
    expect(piConfirm).toHaveBeenCalledTimes(1);
    expect(mcpConfirm).not.toHaveBeenCalled();
    await expect(policy.approve("kill_app", {}, undefined, mcpConfirm)).rejects.toThrow("not approved");
  });
  it("does not cache rejected or cancelled launch approvals", async () => {
    const confirm = vi.fn().mockResolvedValueOnce(false).mockImplementationOnce(async ({ signal }) => {
      abort.abort(new Error("cancelled"));
      expect(signal.aborted).toBe(true);
      return true;
    }).mockResolvedValue(true);
    const abort = new AbortController();
    const policy = new ComputerUsePolicy({ cwd: "/tmp", confirm });
    await expect(policy.approve("launch_app", { name: "Safari" })).rejects.toThrow("not approved");
    await expect(policy.approve("launch_app", { name: "Safari" }, abort.signal)).rejects.toThrow("cancelled");
    await policy.approve("launch_app", { name: "Safari" });
    expect(confirm).toHaveBeenCalledTimes(3);
  });
  it.each(["browser_download", "browser_prepare", "browser_set_input_files", "install_ffmpeg", "kill_app", "replay_trajectory"])("confirms %s and respects explicit dangerous-action settings", async (name) => {
    const confirm = vi.fn(async () => true);
    await new ComputerUsePolicy({ cwd: "/tmp", confirm }).approve(name, {});
    await new ComputerUsePolicy({ cwd: "/tmp", config: { confirmDangerousActions: false }, confirm }).approve(name, {});
    expect(confirm).toHaveBeenCalledTimes(1);
  });
  it("always confirms recording, normalizes the approved directory and leaves caller arguments intact", async () => {
    const cwd = await workspace();
    const confirm = vi.fn(async () => true);
    const policy = new ComputerUsePolicy({ cwd, config: { confirmDangerousActions: false }, confirm });
    const args = { output_dir: "recordings/run", record_video: true };
    const approved = await policy.approve("start_recording", args);
    expect(approved.output_dir).toBe(await approvedRecordingDirectory(args.output_dir, cwd));
    expect(args.output_dir).toBe("recordings/run");
    await policy.approve("start_recording", args);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
  it("rejects lexical and symlink escapes before showing confirmation", async () => {
    const cwd = await workspace();
    const outside = await workspace();
    await symlink(outside, join(cwd, "escape"));
    await mkdir(join(cwd, "inside"));
    await symlink(join(cwd, "inside"), join(cwd, "final-link"));
    const confirm = vi.fn(async () => true);
    const policy = new ComputerUsePolicy({ cwd, confirm });
    for (const output_dir of ["../outside", outside, "escape/run", "final-link", ""]) {
      await expect(policy.approve("start_recording", { output_dir })).rejects.toThrow("inside");
    }
    expect(confirm).not.toHaveBeenCalled();
  });
  it("rechecks the directory after confirmation to detect symlink replacement", async () => {
    const cwd = await workspace();
    const outside = await workspace();
    await mkdir(join(cwd, "recordings"));
    const confirm = vi.fn(async () => {
      await rm(join(cwd, "recordings"), { recursive: true });
      await symlink(outside, join(cwd, "recordings"));
      return true;
    });
    const policy = new ComputerUsePolicy({ cwd, confirm });
    await expect(policy.approve("start_recording", { output_dir: "recordings/run" })).rejects.toThrow("changed");
  });
});
