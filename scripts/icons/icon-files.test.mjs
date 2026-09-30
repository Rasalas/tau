import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ANDROID_LAUNCHER, ANDROID_SPLASH, androidBackground, androidForeground, androidMonochrome, devBandSvg, iconComposerDocument,
  iconComposerGlyph, iosAppIconContents, iosSplashContents, nightFolder, readStrokes, splashSvg, strokeOutline, svgBody, webManifest,
} from "./icon-files.mjs";
import { decodePng, encodePng, packIco, withoutAlpha } from "./png.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const text = (path) => readFileSync(join(root, path), "utf8");
const png = (path) => decodePng(readFileSync(join(root, path)));
const source = (name) => text(`assets/icon/${name}`);
const res = "mobile/android/app/src/main/res";
const assets = "mobile/ios/App/App/Assets.xcassets";

describe("the committed icon files", () => {
  // Rasters need rsvg-convert; the text outputs are checked here, so an SVG edit without a run fails.
  it("match what the generator writes from assets/icon/", () => {
    const foreground = source("android-foreground.svg");
    expect(text(`${res}/drawable/ic_launcher_foreground.xml`)).toBe(androidForeground(foreground));
    expect(text(`${res}/drawable/ic_launcher_monochrome.xml`)).toBe(androidMonochrome(foreground));
    expect(text(`${res}/drawable/ic_launcher_background.xml`)).toBe(androidBackground());
    expect(text("assets/icon/Tau.icon/icon.json")).toBe(iconComposerDocument());
    expect(text("assets/icon/Tau.icon/Assets/tau.svg")).toBe(iconComposerGlyph(source("icon-light.svg"), "#fbfaf8"));
    expect(text("assets/icon/Tau.icon/Assets/tau-dark.svg")).toBe(iconComposerGlyph(source("icon-light.svg"), "#6b93e0"));
    expect(text("assets/icon/TauDev.icon/icon.json")).toBe(iconComposerDocument({ dev: true }));
    expect(text("assets/icon/TauDev.icon/Assets/dev-band.svg")).toBe(devBandSvg());
    expect(text("assets/icon/TauDev.icon/Assets/tau.svg")).toBe(text("assets/icon/Tau.icon/Assets/tau.svg"));
    expect(text(`${assets}/AppIcon.appiconset/Contents.json`)).toBe(iosAppIconContents());
    expect(text(`${assets}/Splash.imageset/Contents.json`)).toBe(iosSplashContents());
    expect(text("src/web/public/manifest.webmanifest")).toBe(webManifest());
    expect(text("src/web/public/favicon.svg")).toBe(source("mark-light.svg"));
  });

  it("mark Tau Dev's icon with a band in front of the released icon's layers", () => {
    const dev = JSON.parse(iconComposerDocument({ dev: true }));
    const stable = JSON.parse(iconComposerDocument());
    expect(dev.groups[0].layers).toEqual([{ "image-name": "dev-band.svg", name: "dev" }]);
    expect(dev.groups.slice(1)).toEqual(stable.groups);
    expect(dev["fill-specializations"]).toEqual(stable["fill-specializations"]);
  });

  it("wire the adaptive icon to all three layers, the themed one included", () => {
    for (const name of ["ic_launcher", "ic_launcher_round"]) {
      const xml = text(`${res}/mipmap-anydpi-v26/${name}.xml`);
      for (const layer of ["background", "foreground", "monochrome"]) expect(xml).toContain(`@drawable/ic_launcher_${layer}`);
    }
  });

  it("have the sizes each platform asks for, opaque where iOS requires it", () => {
    for (const [density, size] of Object.entries(ANDROID_LAUNCHER)) {
      expect(png(`${res}/mipmap-${density}/ic_launcher.png`)).toMatchObject({ width: size, height: size });
    }
    for (const [folder, width, height] of ANDROID_SPLASH) {
      expect(png(`${res}/${folder}/splash.png`)).toMatchObject({ width, height });
      expect(png(`${res}/${nightFolder(folder)}/splash.png`)).toMatchObject({ width, height });
    }
    for (const name of ["AppIcon-1024", "AppIcon-1024-dark", "AppIcon-1024-tinted"]) {
      expect(png(`${assets}/AppIcon.appiconset/${name}.png`)).toMatchObject({ width: 1024, height: 1024, channels: 3 });
    }
    expect(png(`${assets}/Splash.imageset/splash-dark.png`)).toMatchObject({ width: 2732, channels: 3 });
    expect(png("assets/tau-icon.png")).toMatchObject({ width: 1024, channels: 4 });
  });
});

describe("the generator's pieces", () => {
  it("reads the τ's two strokes and nothing of the plate", () => {
    for (const name of ["icon-light.svg", "square-dark.svg", "android-foreground.svg", "mark-light.svg"]) {
      const strokes = readStrokes(source(name));
      expect(strokes).toHaveLength(2);
      expect(strokes[0].d).toMatch(/^M[\d.]+ [\d.]+L/u);
      expect(strokes[0].width).toBeGreaterThan(0);
    }
  });

  it("centres the icon on a splash and puts night after the orientation", () => {
    const svg = splashSvg(source("icon-light.svg"), 720, 1280, "#1a1a19");
    expect(svg).toContain(`<svg x="288" y="568" width="144" height="144"`);
    expect(svg).not.toContain("<title>");
    expect(svgBody(source("mark-light.svg"))).toMatch(/^<rect/u);
    expect(nightFolder("drawable")).toBe("drawable-night");
    expect(nightFolder("drawable-port-xhdpi")).toBe("drawable-port-night-xhdpi");
  });

  it("outlines a stroke with outward round caps, for Icon Composer's filled layers", () => {
    expect(strokeOutline({ d: "M10 20L50 20", width: 8 })).toBe("M10 24L50 24A4 4 0 0 0 50 16L10 16A4 4 0 0 0 10 24Z");
    expect(strokeOutline({ d: "M10 20L50 20", width: 8 }, 2, [-10, 0])).toBe("M0 48L80 48A8 8 0 0 0 80 32L0 32A8 8 0 0 0 0 48Z");
  });

  it("round-trips a PNG, drops an opaque alpha channel and packs an .ico", () => {
    const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255]);
    const image = encodePng({ width: 2, height: 2, channels: 4, pixels });
    expect(decodePng(image).pixels).toEqual(pixels);
    const opaque = decodePng(withoutAlpha(image));
    expect(opaque.channels).toBe(3);
    expect([...opaque.pixels.subarray(0, 6)]).toEqual([255, 0, 0, 0, 255, 0]);
    expect(() => withoutAlpha(encodePng({ width: 1, height: 1, channels: 4, pixels: Buffer.from([1, 2, 3, 4]) }))).toThrow(/opaque/u);
    const ico = packIco([image, image]);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);
    expect(ico.readUInt32LE(6 + 12)).toBe(6 + 32);
    expect(ico.subarray(6 + 32, 6 + 32 + 8)).toEqual(image.subarray(0, 8));
  });
});
