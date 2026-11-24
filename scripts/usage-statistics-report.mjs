#!/usr/bin/env node
import { execFileSync } from "node:child_process";

// Reporting stays on the Matomo server. No privileged token enters the app,
// command line, repository or output. Uses the operator's existing SSH access.
// Releases are published to both while the update feed moves to the source repository.
const REPOSITORIES = ["Rasalas/tau", "Rasalas/tau-releases"];
const SOURCE_REPOSITORY = "Rasalas/tau";
const LINKED_INSTALLERS = {
  "Tau-mac-arm64.dmg": "macOS arm64",
  "Tau-mac-x64.dmg": "macOS x64",
  "Tau-windows-x64.exe": "Windows",
  "Tau-linux-amd64.deb": "Linux deb",
  "Tau-linux-x86_64.AppImage": "Linux AppImage",
  "Tau-android.apk": "Android",
};

function readUsage(target) {
  const ssh = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes", target];
  const containers = execFileSync("ssh", [...ssh, "docker ps --format '{{.Image}} {{.Names}}'"], { encoding: "utf8" }).trim().split("\n")
    .map((line) => line.split(" ")).filter(([image]) => matomoImage(image)).map(([, name]) => name);
  if (containers.length !== 1 || !/^[a-zA-Z0-9_.-]+$/u.test(containers[0])) throw new Error("Expected one running Matomo 5 container.");
  const code = `<?php
chdir('/var/www/html');
define('PIWIK_DOCUMENT_ROOT','/var/www/html');
define('PIWIK_INCLUDE_PATH',PIWIK_DOCUMENT_ROOT);
define('PIWIK_ENABLE_ERROR_HANDLER',false);
require PIWIK_INCLUDE_PATH.'/core/bootstrap.php';
$environment=new Piwik\\Application\\Environment('cli');
$environment->init();
Piwik\\Console::initPlugins();
Piwik\\Access::doAsSuperUser(function(){
    $site=Piwik\\Plugins\\SitesManager\\API::getInstance()->getSiteFromId(4);
    if($site['name']!=='Tau App') throw new RuntimeException('Unexpected site');
    $result=['siteId'=>4,'timezone'=>'UTC','generatedAt'=>gmdate('c'),'metric'=>'unique participating desktop installations'];
    foreach(['promptActive'=>'human_prompt_accepted','workbenchActive'=>'workbench_used'] as $metric=>$event) {
        foreach(['last7','last30'] as $range) {
            $request=new Piwik\\API\\Request(['method'=>'VisitsSummary.getUniqueVisitors','idSite'=>4,'period'=>'range','date'=>$range,'segment'=>'eventAction=='.$event,'format'=>'json']);
            $data=json_decode($request->process(),true,512,JSON_THROW_ON_ERROR);
            if(!isset($data['value']) || !is_numeric($data['value'])) throw new RuntimeException('Missing unique count');
            $result[$metric][$range]=(int)$data['value'];
        }
    }
    echo json_encode($result,JSON_THROW_ON_ERROR)."\\n";
});
`;
  const output = execFileSync("ssh", [...ssh, `docker exec -i -w /var/www/html -u www-data ${containers[0]} php`], { input: code, encoding: "utf8", timeout: 60_000 });
  try { return JSON.parse(output); } catch { throw new Error("Matomo did not return a report. Check its server log."); }
}

/** The official image (`matomo:5-apache`) or the server's own build of it (`local/matomo:5.13.0-php8.4.27`). */
export function matomoImage(image) {
  return /^(?:[a-z0-9.-]+\/)?matomo:5(?:[.-]|$)/u.test(image ?? "");
}

async function fetchReleases(repository) {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "tau-stats" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
    const batch = await response.json();
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
}

/** One release published to several repositories counts once, with the downloads of all copies. */
export function mergeReleases(lists) {
  const byTag = new Map();
  for (const release of lists.flat()) {
    const seen = byTag.get(release.tag_name);
    if (!seen) byTag.set(release.tag_name, { ...release, assets: [...release.assets] });
    else {
      seen.assets.push(...release.assets);
      if (Date.parse(release.published_at) < Date.parse(seen.published_at)) seen.published_at = release.published_at;
    }
  }
  return [...byTag.values()];
}

/**
 * A running installed app checks at start and hourly; Tau's signature check and electron-updater
 * each fetch the feed, and a nightly app also reads the stable one. Counts land on the newest release.
 */
export function feedPlatform(name) {
  if (/^latest-host-.+\.yml$/u.test(name)) return "hosts";
  if (/^latest-mac(?:-.+)?\.yml$/u.test(name)) return "macOS";
  if (/^latest-linux(?:-.+)?\.yml$/u.test(name)) return "Linux";
  if (name === "latest.yml" || name === "latest-arm64.yml") return "Windows";
  return undefined;
}

/** Installers are what people download by hand; updates are the files the feeds hand to installed apps. */
export function assetKind(name) {
  if (/\.(yml|sig|blockmap)$/u.test(name) || name === "LICENSE") return undefined;
  if (name.startsWith("Tau-host-")) return { kind: "hosts" };
  if (LINKED_INSTALLERS[name]) return { kind: "installers", platform: LINKED_INSTALLERS[name] };
  if (name.endsWith(".dmg")) return { kind: "installers", platform: name.includes("arm64") ? "macOS arm64" : "macOS x64" };
  if (name.endsWith(".apk")) return { kind: "installers", platform: "Android" };
  if (/\.(zip|exe|AppImage|deb)$/u.test(name)) return { kind: "updates" };
  return undefined;
}

export function summarizeDownloads(releases) {
  const totals = { installers: 0, updates: 0, hosts: 0 };
  const platforms = {};
  const checks = { macOS: 0, Linux: 0, Windows: 0, hosts: 0 };
  const rows = [...releases].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at)).map((release) => {
    const row = { tag: release.tag_name, publishedAt: release.published_at, installers: 0, updates: 0, hosts: 0, checks: { macOS: 0, Linux: 0, Windows: 0, hosts: 0 } };
    for (const asset of release.assets) {
      const feed = feedPlatform(asset.name);
      if (feed) { row.checks[feed] += asset.download_count; checks[feed] += asset.download_count; }
      const kind = assetKind(asset.name);
      if (!kind) continue;
      row[kind.kind] += asset.download_count;
      totals[kind.kind] += asset.download_count;
      if (kind.platform) platforms[kind.platform] = (platforms[kind.platform] ?? 0) + asset.download_count;
    }
    return row;
  });
  return { repositories: REPOSITORIES, ...totals, installerPlatforms: platforms, updateChecks: checks, releases: rows };
}

/** Traffic needs push access, so it goes through the operator's own `gh` login. */
function readRepository() {
  const api = (path) => JSON.parse(execFileSync("gh", ["api", `repos/${SOURCE_REPOSITORY}${path}`], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }));
  const { count: views, uniques: viewers } = api("/traffic/views");
  const { count: clones, uniques: cloners } = api("/traffic/clones");
  const { stargazers_count: stars, forks_count: forks } = api("");
  return { repository: SOURCE_REPOSITORY, views, viewers, clones, cloners, stars, forks };
}

export function formatReport({ generatedAt, usage, downloads, repository }) {
  const lines = [`Tau usage, ${generatedAt.slice(0, 16).replace("T", " ")} UTC`, ""];
  lines.push("Opt-in statistics (participating desktop installations)");
  if (usage.error) lines.push(`  unavailable: ${usage.error}`);
  else {
    lines.push(`  ${"".padEnd(14)}${"7 days".padStart(8)}${"30 days".padStart(9)}`);
    lines.push(`  ${"Prompt use".padEnd(14)}${String(usage.promptActive.last7).padStart(8)}${String(usage.promptActive.last30).padStart(9)}`);
    lines.push(`  ${"Workbench use".padEnd(14)}${String(usage.workbenchActive.last7).padStart(8)}${String(usage.workbenchActive.last30).padStart(9)}`);
  }
  lines.push("");
  if (repository) {
    lines.push(`GitHub repository (${repository.repository ?? SOURCE_REPOSITORY}, last 14 days)`);
    if (repository.error) lines.push(`  unavailable: ${repository.error}`);
    else lines.push(`  Views ${repository.views} (${repository.viewers} unique), clones ${repository.clones} (${repository.cloners} unique, CI checkouts included), stars ${repository.stars}, forks ${repository.forks}`);
    lines.push("");
  }
  if (downloads.error) {
    lines.push("GitHub downloads", `  unavailable: ${downloads.error}`);
    return lines.join("\n");
  }
  const oldest = downloads.releases.at(-1)?.tag ?? "none";
  const platforms = Object.entries(downloads.installerPlatforms).filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]).map(([platform, count]) => `${platform} ${count}`).join(", ");
  lines.push(`GitHub downloads (${downloads.repositories.join(" + ")}, since ${oldest})`);
  lines.push(`  ${"Installers".padEnd(14)}${String(downloads.installers).padStart(5)}${platforms ? `   ${platforms}` : ""}`);
  lines.push(`  ${"App updates".padEnd(14)}${String(downloads.updates).padStart(5)}`);
  lines.push(`  ${"Host archives".padEnd(14)}${String(downloads.hosts).padStart(5)}`, "");
  lines.push(`  ${"".padEnd(22)}${"".padStart(10)}${"".padStart(9)}  Update checks`);
  lines.push(`  ${"Release".padEnd(10)}${"Published".padEnd(12)}${"Installers".padStart(10)}${"Updates".padStart(9)}${"macOS".padStart(8)}${"Linux".padStart(7)}${"Windows".padStart(9)}${"Hosts".padStart(7)}`);
  for (const row of downloads.releases.slice(0, 10)) {
    const { macOS, Linux, Windows, hosts } = row.checks;
    lines.push(`  ${row.tag.padEnd(10)}${row.publishedAt.slice(0, 10).padEnd(12)}${String(row.installers).padStart(10)}${String(row.updates).padStart(9)}${String(macOS).padStart(8)}${String(Linux).padStart(7)}${String(Windows).padStart(9)}${String(hosts).padStart(7)}`);
  }
  lines.push("", "Downloads count files, not people. Your own machines, reinstalls and the replaced nightly distort them.");
  lines.push("Update checks count feed downloads: a running app checks at start and hourly, about two downloads per check, a nightly app also");
  lines.push("reads the stable feed once. A release's checks cover the time it was newest; about 2 per hour an app ran on that platform.");
  return lines.join("\n");
}

async function main(argv) {
  const json = argv.includes("--json");
  const target = argv.find((arg) => arg !== "--json") ?? "vps";
  if (!/^[a-zA-Z0-9_.@-]+$/u.test(target) || target.startsWith("-")) throw new Error("Expected an SSH host name or alias.");
  const errorOf = (error) => String(error?.message ?? error).split("\n")[0];
  const downloads = Promise.all(REPOSITORIES.map(fetchReleases)).then((lists) => summarizeDownloads(mergeReleases(lists)), (error) => ({ error: errorOf(error) }));
  let usage;
  try { usage = readUsage(target); } catch (error) { usage = { error: errorOf(error) }; }
  // Optional: without a `gh` login with push access the rest still prints and the command succeeds.
  let repository;
  try { repository = readRepository(); } catch (error) { repository = { repository: SOURCE_REPOSITORY, error: errorOf(error) }; }
  const report = { generatedAt: new Date().toISOString(), usage, repository, downloads: await downloads };
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
  if (usage.error || report.downloads.error) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
