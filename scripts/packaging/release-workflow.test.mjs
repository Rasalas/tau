// The release workflow's wiring, read as text: which job waits for which, what
// each artifact carries, and when something leaves for a store. actionlint
// checks the syntax; this checks the decisions docs/RELEASE.md describes.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const WORKFLOW = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");

/** Each job's block, by name. */
function jobs(text) {
  const body = text.slice(text.indexOf("\njobs:\n") + 7);
  const found = {};
  let name;
  for (const line of body.split("\n")) {
    const header = /^ {2}([\w-]+):$/u.exec(line);
    if (header) {
      name = header[1];
      found[name] = "";
    } else if (name) found[name] += `${line}\n`;
  }
  return found;
}

const JOBS = jobs(WORKFLOW);
const needs = (job) => /^ {4}needs: (?:\[(.*)\]|(\S+))$/mu.exec(JOBS[job])?.slice(1).find(Boolean).split(",").map((entry) => entry.trim()) ?? [];
const condition = (job) => /^ {4}if: (.*)$/mu.exec(JOBS[job])?.[1] ?? "";

describe("the release workflow", () => {
  it("publishes signed portable feeds and builds ARM Linux without replacing the desktop installer feed", () => {
    expect(JOBS.build).toContain("runner: ubuntu-24.04-arm");
    expect(JOBS.build).toContain("platform: --linux --arm64 --dir");
    expect(JOBS.build).toContain("node scripts/packaging/portable-host.mjs");
    expect(JOBS.build).toContain("release/*.tar.gz");
    expect(JOBS.sign).toContain("release-signing.mjs sign feed/latest*.yml");
  });
  it("has the jobs docs/RELEASE.md describes", () => {
    expect(Object.keys(JOBS)).toEqual(["gate", "preflight", "verify", "build", "android", "ios", "sign", "release", "nightly", "play"]);
  });

  it("pins every action to a commit, and uses only GitHub's own and the release action", () => {
    const uses = [...WORKFLOW.matchAll(/uses: (\S+)@(\S+)/gu)];
    expect(uses.length).toBeGreaterThan(10);
    for (const [, action, ref] of uses) {
      expect(ref).toMatch(/^[0-9a-f]{40}$/u);
      expect(action.startsWith("actions/") || action === "softprops/action-gh-release").toBe(true);
    }
  });

  it("skips verify only when CI and the performance gates passed on the commit", () => {
    expect(JOBS.gate).toContain("actions: read");
    expect(JOBS.gate).toContain('node scripts/packaging/verified-commit.mjs "$SHA"');
    expect(condition("verify")).toBe("needs.gate.outputs.build == 'true' && needs.gate.outputs.verified != 'true'");
  });

  it("builds without waiting for verify, and signs or ships nothing before it passed", () => {
    for (const job of ["build", "android"]) expect(needs(job)).toEqual(["gate", "preflight"]);
    const verifyPassed = "(needs.verify.result == 'success' || needs.verify.result == 'skipped')";
    for (const job of ["sign", "ios"]) {
      expect(needs(job)).toContain("verify");
      expect(condition(job)).toContain(verifyPassed);
      expect(condition(job)).toMatch(/^\$\{\{ !cancelled\(\) && /u);
    }
    expect(needs("release")).toEqual(["gate", "sign", "android"]);
    expect(condition("release")).toContain("needs.sign.result == 'success' && needs.android.result == 'success'");
    expect(condition("nightly")).toContain("needs.sign.result == 'success'");
  });

  it("builds each Mac architecture on its own runner and merges their feeds before signing", () => {
    expect(JOBS.build).toContain("platform: --mac --arm64\n");
    expect(JOBS.build).toContain("platform: --mac --x64\n");
    expect(JOBS.build).not.toContain("--arm64 --x64");
    const sign = JOBS.sign;
    expect(sign.indexOf("merge-feeds.mjs feeds-by-build feed")).toBeGreaterThan(-1);
    expect(sign.indexOf("merge-feeds.mjs")).toBeLessThan(sign.indexOf("release-signing.mjs sign"));
    // Each build's feed in a folder of its own: merged into one, the two latest-mac.yml would overwrite each other.
    expect(sign).not.toMatch(/pattern: feed-\*\n\s+path: \S+\n\s+merge-multiple: true/u);
    expect(sign).toContain("name: tau-feeds");
  });

  it("publishes the feeds only from tau-feeds, never a build's own copy", () => {
    const installers = /name: tau-\$\{\{ matrix\.artifact \}\}[\s\S]*?path: \|\n([\s\S]*?)\n\n/u.exec(JOBS.build)[1];
    expect(installers).toContain("release/*.blockmap");
    expect(installers).not.toContain("latest");
    expect(JOBS.release).toContain("pattern: tau-*");
  });

  it("releases the signed APK and hands the App Bundle to the play job only", () => {
    expect(JOBS.android).toContain("name: tau-android");
    expect(JOBS.android).toContain("path: android/*.apk");
    expect(JOBS.android).toContain("name: play-bundle");
    expect(condition("android")).toContain("needs.gate.outputs.nightly != 'true'");
    expect(needs("play")).toEqual(["gate", "release"]);
    expect(JOBS.play).toContain("--track internal");
    // No secret, no upload, no failure.
    expect(JOBS.play).toMatch(/if \[ -z "\$\{PLAY_SERVICE_ACCOUNT_JSON:-\}" \]; then\n\s+echo "::notice::[^\n]*"\n\s+exit 0/u);
  });

  it("uploads to TestFlight only for a release, numbered from the run", () => {
    expect(JOBS.ios).toContain("UPLOAD: ${{ startsWith(github.ref, 'refs/tags/v') || inputs.publish == true }}");
    expect(JOBS.ios).toContain('mobile-version.mjs ios-build --run "$RUN_NUMBER"');
    expect(JOBS.ios).toMatch(/if \[ "\$UPLOAD" != true \]; then[\s\S]*?exit 0\n\s+fi[\s\S]*-exportArchive/u);
    expect(JOBS.ios).toContain("<key>method</key><string>app-store-connect</string>");
    expect(JOBS.ios).toContain("<key>destination</key><string>upload</string>");
    expect(JOBS.ios).toContain("<key>teamID</key><string>V4MWQ28RZ2</string>");
    expect(condition("ios")).toContain("needs.gate.outputs.nightly != 'true'");
  });

  it("fails a release whose Firebase project lacks the app, and only warns in a dry run", () => {
    expect(JOBS.preflight).toContain("secrets.ANDROID_GOOGLE_SERVICES_JSON != ''");
    const guard = /package_name === "de\.tbuck\.tau"[\s\S]*?\n {10}fi\n/u.exec(JOBS.android)[0];
    expect(guard).toMatch(/if \[ "\$PUBLISHING" = true \]; then\n\s+echo "::error::[^\n]*"\n\s+exit 1/u);
    expect(guard).toContain("::warning::");
  });

  it("removes every key it writes to disk", () => {
    expect(JOBS.ios).toContain(`trap 'rm -f "$key"' EXIT`);
    expect(JOBS.android).toContain('rm -f "$RUNNER_TEMP/upload.p12"');
  });
});
