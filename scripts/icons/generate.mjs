#!/usr/bin/env node
// Writes every icon, splash and favicon from the SVGs in assets/icon/.
//
//   node scripts/icons/generate.mjs
//
// Needs rsvg-convert (librsvg: `brew install librsvg`, `apt install librsvg2-bin`).
// The outputs are committed, so only a change to the artwork runs this; CI never does.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANDROID_LAUNCHER, ANDROID_SPLASH, COLOURS, androidBackground, androidForeground, androidMonochrome, clippedSvg,
  iconComposerDocument, iconComposerGlyph, iosAppIconContents, iosSplashContents, nightFolder, splashSvg, tintedSvg, webManifest,
} from "./icon-files.mjs";
import { packIco, withoutAlpha } from "./png.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = (name) => readFileSync(join(root, "assets/icon", name), "utf8");
const icon = { light: source("icon-light.svg"), dark: source("icon-dark.svg") };
const square = { light: source("square-light.svg"), dark: source("square-dark.svg") };
const mark = source("mark-light.svg");
const foreground = source("android-foreground.svg");

const probe = spawnSync("rsvg-convert", ["--version"]);
if (probe.error || probe.status !== 0) {
  console.error("rsvg-convert is missing: brew install librsvg (macOS) or apt install librsvg2-bin (Linux)");
  process.exit(1);
}

function render(svg, width, height = width) {
  const result = spawnSync("rsvg-convert", ["--width", String(width), "--height", String(height), "--format", "png"], { input: svg, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`rsvg-convert failed: ${result.stderr}`);
  return result.stdout;
}

let written = 0;
function write(path, contents) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  written++;
}

// Desktop: the checkout's window and dock icon, the Linux and fallback source,
// Windows' .ico (the 32-unit mark up to 32 px, where the grid icon's margin wastes pixels),
// and the Icon Composer document macOS 26 needs to show the icon without a grey plate.
write("assets/tau-icon.png", render(icon.light, 1024));
write("assets/icon/tau.ico", packIco([
  ...[16, 24, 32].map((size) => render(mark, size)),
  ...[48, 64, 128, 256].map((size) => render(icon.light, size)),
]));
write("assets/icon/Tau.icon/icon.json", iconComposerDocument());
write("assets/icon/Tau.icon/Assets/tau.svg", iconComposerGlyph(icon.light, COLOURS.paper));
write("assets/icon/Tau.icon/Assets/tau-dark.svg", iconComposerGlyph(icon.light, COLOURS.blueDark));

// Android: vectors for the adaptive icon (with Android 13's monochrome layer),
// PNGs for launchers older than Android 8, and the splash in both themes.
const res = "mobile/android/app/src/main/res";
write(`${res}/drawable/ic_launcher_foreground.xml`, androidForeground(foreground));
write(`${res}/drawable/ic_launcher_monochrome.xml`, androidMonochrome(foreground));
write(`${res}/drawable/ic_launcher_background.xml`, androidBackground());
for (const [density, size] of Object.entries(ANDROID_LAUNCHER)) {
  write(`${res}/mipmap-${density}/ic_launcher.png`, render(clippedSvg(square.light, "square"), size));
  write(`${res}/mipmap-${density}/ic_launcher_round.png`, render(clippedSvg(square.light, "round"), size));
}
for (const [folder, width, height] of ANDROID_SPLASH) {
  write(`${res}/${folder}/splash.png`, render(splashSvg(icon.light, width, height, COLOURS.lightSurface), width, height));
  write(`${res}/${nightFolder(folder)}/splash.png`, render(splashSvg(icon.light, width, height, COLOURS.darkSurface), width, height));
}

// iOS: the app icon in its three appearances, opaque as the App Store requires, and the splash.
const assets = "mobile/ios/App/App/Assets.xcassets";
write(`${assets}/AppIcon.appiconset/AppIcon-1024.png`, withoutAlpha(render(square.light, 1024)));
write(`${assets}/AppIcon.appiconset/AppIcon-1024-dark.png`, withoutAlpha(render(square.dark, 1024)));
write(`${assets}/AppIcon.appiconset/AppIcon-1024-tinted.png`, withoutAlpha(render(tintedSvg(square.light), 1024)));
write(`${assets}/AppIcon.appiconset/Contents.json`, iosAppIconContents());
write(`${assets}/Splash.imageset/splash.png`, withoutAlpha(render(splashSvg(icon.light, 2732, 2732, COLOURS.lightSurface), 2732)));
write(`${assets}/Splash.imageset/splash-dark.png`, withoutAlpha(render(splashSvg(icon.light, 2732, 2732, COLOURS.darkSurface), 2732)));
write(`${assets}/Splash.imageset/Contents.json`, iosSplashContents());

// Web: favicon and manifest for the browser client and the phone app's web layer.
const web = "src/web/public";
write(`${web}/favicon.svg`, mark);
write(`${web}/favicon.ico`, packIco([16, 32, 48].map((size) => render(mark, size))));
write(`${web}/apple-touch-icon.png`, withoutAlpha(render(square.light, 180)));
write(`${web}/icon-192.png`, render(icon.light, 192));
write(`${web}/icon-512.png`, render(icon.light, 512));
write(`${web}/icon-maskable-512.png`, withoutAlpha(render(square.light, 512)));
write(`${web}/manifest.webmanifest`, webManifest());

console.log(`[icons] wrote ${written} files`);
