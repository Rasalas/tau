#!/usr/bin/env node
import { execFileSync } from "node:child_process";

// Reporting stays on the Matomo server. No privileged token enters the app,
// command line, repository or output. Uses the operator's existing SSH access.
const target = process.argv[2] ?? "vps";
if (!/^[a-zA-Z0-9_.@-]+$/u.test(target) || target.startsWith("-")) throw new Error("Expected an SSH host name or alias.");
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
let report;
try { report = JSON.parse(output); } catch { throw new Error("Matomo did not return a report. Check its server log."); }
console.log(JSON.stringify(report, null, 2));
