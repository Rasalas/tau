#!/usr/bin/env node
import { execFileSync } from "node:child_process";

// Reporting stays on the Matomo server. No privileged token enters the app,
// command line, repository or output. Uses the operator's existing SSH access.
const REPOSITORY = "Rasalas/tau-releases";
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
    .filter((line) => line.startsWith("matomo:5-apache ")).map((line) => line.split(" ")[1]);
  if (containers.length !== 1 || !/^[a-zA-Z0-9_.-]+$/u.test(containers[0])) throw new Error("Expected one running matomo:5-apache container.");
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

async function fetchReleases() {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=100&page=${page}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "tau-stats" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
    const batch = await response.json();
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
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
  const rows = [...releases].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at)).map((release) => {
    const row = { tag: release.tag_name, publishedAt: release.published_at, installers: 0, updates: 0, hosts: 0 };
    for (const asset of release.assets) {
      const kind = assetKind(asset.name);
      if (!kind) continue;
      row[kind.kind] += asset.download_count;
      totals[kind.kind] += asset.download_count;
      if (kind.platform) platforms[kind.platform] = (platforms[kind.platform] ?? 0) + asset.download_count;
    }
    return row;
  });
  return { repository: REPOSITORY, ...totals, installerPlatforms: platforms, releases: rows };
}

export function formatReport({ generatedAt, usage, downloads }) {
  const lines = [`Tau usage, ${generatedAt.slice(0, 16).replace("T", " ")} UTC`, ""];
  lines.push("Opt-in statistics (participating desktop installations)");
  if (usage.error) lines.push(`  unavailable: ${usage.error}`);
  else {
    lines.push(`  ${"".padEnd(14)}${"7 days".padStart(8)}${"30 days".padStart(9)}`);
    lines.push(`  ${"Prompt use".padEnd(14)}${String(usage.promptActive.last7).padStart(8)}${String(usage.promptActive.last30).padStart(9)}`);
    lines.push(`  ${"Workbench use".padEnd(14)}${String(usage.workbenchActive.last7).padStart(8)}${String(usage.workbenchActive.last30).padStart(9)}`);
  }
  lines.push("");
  if (downloads.error) {
    lines.push("GitHub downloads", `  unavailable: ${downloads.error}`);
    return lines.join("\n");
  }
  const oldest = downloads.releases.at(-1)?.tag ?? "none";
  const platforms = Object.entries(downloads.installerPlatforms).filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]).map(([platform, count]) => `${platform} ${count}`).join(", ");
  lines.push(`GitHub downloads (${downloads.repository}, since ${oldest})`);
  lines.push(`  ${"Installers".padEnd(14)}${String(downloads.installers).padStart(5)}${platforms ? `   ${platforms}` : ""}`);
  lines.push(`  ${"App updates".padEnd(14)}${String(downloads.updates).padStart(5)}`);
  lines.push(`  ${"Host archives".padEnd(14)}${String(downloads.hosts).padStart(5)}`, "");
  lines.push(`  ${"Release".padEnd(10)}${"Published".padEnd(12)}${"Installers".padStart(10)}${"Updates".padStart(9)}`);
  for (const row of downloads.releases.slice(0, 10)) {
    lines.push(`  ${row.tag.padEnd(10)}${row.publishedAt.slice(0, 10).padEnd(12)}${String(row.installers).padStart(10)}${String(row.updates).padStart(9)}`);
  }
  lines.push("", "Downloads count files, not people. Your own machines, reinstalls and the replaced nightly distort them.");
  return lines.join("\n");
}

async function main(argv) {
  const json = argv.includes("--json");
  const target = argv.find((arg) => arg !== "--json") ?? "vps";
  if (!/^[a-zA-Z0-9_.@-]+$/u.test(target) || target.startsWith("-")) throw new Error("Expected an SSH host name or alias.");
  const errorOf = (error) => String(error?.message ?? error).split("\n")[0];
  const downloads = fetchReleases().then(summarizeDownloads, (error) => ({ error: errorOf(error) }));
  let usage;
  try { usage = readUsage(target); } catch (error) { usage = { error: errorOf(error) }; }
  const report = { generatedAt: new Date().toISOString(), usage, downloads: await downloads };
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
  if (usage.error || report.downloads.error) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
