import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { activateHostKit } from "../src/main/test-support/host-kit-harness.js";

function declarations(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { found.push(...declarations(path)); continue; }
    if (!/\.tsx?$/u.test(path) || /\.test\.tsx?$/u.test(path)) continue;
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const constants = new Map<string, ts.Expression>();
    const functions = new Map<string, ts.Node>();
    const collect = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) constants.set(node.name.text, node.initializer);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) functions.set(node.name.text, node.initializer);
      if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
      ts.forEachChild(node, collect);
    };
    collect(source);
    const readValue = (node: ts.Node | undefined, seen = new Set<string>()): boolean => {
      if (!node) return false;
      if (ts.isStringLiteral(node)) return node.text === "read";
      if (ts.isIdentifier(node) && !seen.has(node.text)) return readValue(constants.get(node.text), new Set([...seen, node.text]));
      if (ts.isAsExpression(node)) return readValue(node.expression, seen);
      return false;
    };
    const read = (node: ts.Node | undefined, seen = new Set<string>()): boolean => {
      if (!node) return false;
      if (ts.isIdentifier(node) && !seen.has(node.text)) return read(constants.get(node.text), new Set([...seen, node.text]));
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === "access") return readValue(node.initializer);
      if (ts.isShorthandPropertyAssignment(node) && node.name.text === "access") return readValue(node.name);
      return ts.forEachChild(node, (child) => read(child, seen) || undefined) ?? false;
    };
    const registers = (node: ts.Node): boolean => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "registerCommand"
      || (ts.forEachChild(node, (child) => registers(child) || undefined) ?? false);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && (
        /(?:^|\.)register(?:Command)?$/u.test(node.expression.getText(source)) && read(node.arguments[2])
        || ts.isIdentifier(node.expression) && functions.has(node.expression.text) && registers(functions.get(node.expression.text)!) && node.arguments.some((argument) => readValue(argument))
      )) {
        found.push(`${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}/${node.arguments[0].getText(source)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe("bundled read command path policy", () => {
  it("guards every kit's read declaration before its handler, including nested path arguments", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "tau-read-commands-")));
    const project = join(root, "project");
    const secondary = join(root, "secondary");
    const outside = join(root, ".tau", "host-token");
    await mkdir(project);
    await mkdir(secondary);
    await mkdir(join(root, ".tau"));
    await writeFile(outside, "fixture-token");
    await writeFile(join(project, "visible.txt"), "visible");
    await writeFile(join(project, ".env"), "project-fixture");
    await mkdir(join(project, ".git"));
    await writeFile(join(project, ".git", "config"), "fixture-secret");
    await symlink(outside, join(project, "linked.txt"));
    await symlink(join(project, ".env"), join(project, "public.txt"));
    await symlink(join(project, ".git", "config"), join(project, "internals.txt"));
    await symlink(outside, join(project, " padded.txt"));
    await mkdir(join(project, "back"));
    await symlink(outside, join(project, "back\\slash.txt"));
    const commands = declarations("kits").map((label, index) => ({ label, name: `read-${index}` }));
    const handler = vi.fn(() => "read");
    const registry = await activateHostKit({
      id: "test.read-policy", name: "Read policy",
      activate(context) {
        // Mirror the declarations at their common dispatch boundary; no kit side effects run.
        for (const command of commands) context.registerCommand(command.name, handler, { access: "read" });
      },
    }, {
      cwd: () => project,
      knownWorkspacePath: async (id) => {
        if (id === "ws-project" || id === project) return project;
        if (id === "ws-secondary") return secondary;
        throw new Error("Unknown workspace");
      },
    });
    const phone = { kind: "workbench-client", connection: "phone", pairedClient: "device", readOnly: true } as const;
    try {
      expect(commands.length).toBeGreaterThan(150);
      expect(commands.filter((command) => command.label.startsWith("kits/files/host.ts:")).length).toBeGreaterThanOrEqual(2);
      for (const command of commands) {
        await expect(registry.invoke("test.read-policy", command.name, { workspace: "ws-project", path: outside }, phone), command.label).rejects.toMatchObject({ code: "forbidden" });
      }
      expect(handler).not.toHaveBeenCalled();
      const command = commands[0].name;
      for (const input of [
        { path: "../.tau/host-token" }, { path: " .git/config " }, { relPath: ".git/config" },
        { paths: [outside] }, { files: [{ path: outside }] }, { filename: outside },
        { workspaces: [{ path: outside }] }, { path: " padded.txt" },
        { path: "back\\slash.txt" },
        { workspace: "ws-secondary", path: join(project, "linked.txt") },
        { files: [{ workspace: "ws-secondary", path: "linked.txt" }] },
        { path: "linked.txt" }, { path: "internals.txt" }, { path: outside, owner: true }, { cwd: root },
        { workspace: "unknown", path: "visible.txt" }, { path: "  ~/.tau/host-token  " },
      ]) await expect(registry.invoke("test.read-policy", command, input, phone)).rejects.toMatchObject({ code: "forbidden" });
      expect(handler).not.toHaveBeenCalled();
      await expect(registry.invoke("test.read-policy", command, { path: "visible.txt" }, phone)).resolves.toBe("read");
      await expect(registry.invoke("test.read-policy", command, { path: ".env" }, phone)).resolves.toBe("read");
      await expect(registry.invoke("test.read-policy", command, { path: "public.txt" }, phone)).resolves.toBe("read");
      await expect(registry.invoke("test.read-policy", command, { query: "/etc/passwd", text: "../outside" }, phone)).resolves.toBe("read");
      await expect(registry.invoke("test.read-policy", command, { path: outside }, { kind: "workbench-client" })).resolves.toBe("read");
      await expect(registry.invoke("test.read-policy", command, { path: outside }, { ...phone, readOnly: undefined })).rejects.toMatchObject({ code: "forbidden" });
      expect(registry.isActive("test.read-policy")).toBe(true);
    } finally {
      await registry.deactivate("test.read-policy");
      await rm(root, { recursive: true, force: true });
    }
  });
});
