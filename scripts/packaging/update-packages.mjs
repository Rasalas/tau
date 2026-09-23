#!/usr/bin/env node
// Writes every package manager's files for one release, and the release JSON
// they were written from (packaging/release.json), which the tests read back.
//
//   npm run packaging:update                    # the release of package.json's version
//   npm run packaging:update -- --tag v0.4.1
import { isMain, main, runUpdate, trimRelease } from "./release.mjs";
import { AUR_DIR, licenseSha256, renderPkgbuild, renderSrcinfo } from "./update-aur.mjs";
import { CASK_PATH, renderCask } from "./update-cask.mjs";
import { WINGET_DIR, renderWingetManifests } from "./update-winget.mjs";

export const RELEASE_PATH = "packaging/release.json";

export function renderPackages(assets, release, license = licenseSha256()) {
  if (assets.appImage.name !== `Tau-${assets.version}.AppImage`) throw new Error(`The PKGBUILD expects Tau-${assets.version}.AppImage, the release has ${assets.appImage.name}.`);
  return {
    [RELEASE_PATH]: `${JSON.stringify(trimRelease(release), null, 2)}\n`,
    [CASK_PATH]: renderCask(assets),
    ...Object.fromEntries(Object.entries(renderWingetManifests(assets)).map(([name, text]) => [`${WINGET_DIR}/${name}`, text])),
    [`${AUR_DIR}/PKGBUILD`]: renderPkgbuild(assets, license),
    [`${AUR_DIR}/.SRCINFO`]: renderSrcinfo(assets, license),
  };
}

if (isMain(import.meta.url)) {
  main(() => runUpdate(process.argv.slice(2), "npm run packaging:update -- [--tag v1.2.3] [--release-json <file>]", renderPackages));
}
