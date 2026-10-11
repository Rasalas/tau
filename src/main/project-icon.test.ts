import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProjectIcon } from "./project-icon.js";

const temporaryDirectories: string[] = [];

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tau-project-icon-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("resolveProjectIcon", () => {
  it("prefers the workspace-relative iconPath in t3.json", async () => {
    const project = await temporaryProject();
    await mkdir(join(project, "assets"));
    await mkdir(join(project, "public"));
    await writeFile(join(project, "t3.json"), JSON.stringify({ iconPath: "assets/brand.svg" }));
    await writeFile(join(project, "assets/brand.svg"), "<svg>brand</svg>");
    await writeFile(join(project, "public/favicon.svg"), "<svg>favicon</svg>");

    expect(await resolveProjectIcon(project)).toBe(
      `data:image/svg+xml;base64,${Buffer.from("<svg>brand</svg>").toString("base64")}`,
    );
  });

  it("finds a favicon in a common app path", async () => {
    const project = await temporaryProject();
    await mkdir(join(project, "src/app"), { recursive: true });
    await writeFile(join(project, "src/app/icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    expect(await resolveProjectIcon(project)).toBe("data:image/png;base64,iVBORw==");
  });

  it("follows a favicon link in the project HTML", async () => {
    const project = await temporaryProject();
    await mkdir(join(project, "public", "branding"), { recursive: true });
    await writeFile(join(project, "index.html"), '<link href="/branding/mark.webp?v=2" rel="shortcut icon">');
    await writeFile(join(project, "public", "branding", "mark.webp"), Buffer.from([1, 2, 3]));

    expect(await resolveProjectIcon(project)).toBe("data:image/webp;base64,AQID");
  });

  it("falls back to automatic detection when iconPath escapes the project", async () => {
    const parent = await temporaryProject();
    const project = join(parent, "project");
    await mkdir(project);
    await writeFile(join(parent, "outside.svg"), "<svg>outside</svg>");
    await writeFile(join(project, "t3.json"), JSON.stringify({ iconPath: "../outside.svg" }));
    await writeFile(join(project, "favicon.svg"), "<svg>inside</svg>");

    expect(await resolveProjectIcon(project)).toBe(
      `data:image/svg+xml;base64,${Buffer.from("<svg>inside</svg>").toString("base64")}`,
    );
  });

  it("rejects an icon symlink that leaves the project", async () => {
    const parent = await temporaryProject();
    const project = join(parent, "project");
    await mkdir(join(project, "assets"), { recursive: true });
    await writeFile(join(parent, "outside.svg"), "<svg>outside</svg>");
    await writeFile(join(project, "t3.json"), JSON.stringify({ iconPath: "assets/icon.svg" }));
    await symlink(join(parent, "outside.svg"), join(project, "assets/icon.svg"));

    expect(await resolveProjectIcon(project)).toBeUndefined();
  });

  it("draws a macOS app icon from the PNG inside its .icns", async () => {
    const project = await temporaryProject();
    await mkdir(join(project, "build"));
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(256, 16);
    const head = Buffer.alloc(16);
    head.write("icns");
    head.writeUInt32BE(16 + png.length, 4);
    head.write("ic08", 8);
    head.writeUInt32BE(8 + png.length, 12);
    await writeFile(join(project, "build/icon.icns"), Buffer.concat([head, png]));

    expect(await resolveProjectIcon(project)).toBe(`data:image/png;base64,${png.toString("base64")}`);
  });

  it("skips an .icns without a PNG and goes on to the next candidate", async () => {
    const project = await temporaryProject();
    await mkdir(join(project, "build"));
    await writeFile(join(project, "build/icon.icns"), "not an icns");
    await writeFile(join(project, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    expect(await resolveProjectIcon(project)).toBe("data:image/png;base64,iVBORw==");
  });
});
