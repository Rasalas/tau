# Tau usage statistics

The optional `tau.usage-statistics` kit counts participating desktop installations through the existing Matomo service on the Strato VPS under Dokploy. No additional collector service is needed.

Reporting is off until the person using the device enables **Settings → Usage statistics → Share usage statistics**. The choice and a cryptographically random 16-character hexadecimal ID live under `device:tau.usage-statistics.v1` in client storage. They are not host preferences and are not synced between devices. Different devices, user-data profiles and reinstalls can represent the same person more than once. These are installation counts, not registered users or verified people.

## What is counted

Each participating device reports at most one successful request of each kind per UTC day in a window:

| Event | Trigger | Purpose |
| --- | --- | --- |
| `workbench_used` | A trusted pointer or keyboard event in a visible, focused desktop workbench | Interactive use, including reading and reviewing |
| `human_prompt_accepted` | The local composer accepts a runtime prompt, a queued follow-up, steering, or a kit-claimed first prompt | Active prompt installations |

Rejected submissions, slash commands and shell commands do not emit the prompt event. Scheduler wakes, host user-message events, background agents and subagent turns do not independently emit it. A queued prompt counts when it is accepted into the queue, even if never run. The event carries no prompt contents. The renderer schedules delivery without awaiting it in the submission path.

Only a normal packaged desktop client advertises release metadata to the kit. Development, isolated instances, `TAU_USER_DATA`, `TAU_DEV_SERVER_URL`, `TAU_NO_FOCUS=1` and `TAU_USAGE_STATISTICS=0` disable reporting. Native mobile and browser clients are outside this first implementation. A connected remote host cannot enable reporting or supply the client's release version.

Daily flags suppress repeat delivery locally. Concurrent windows can send the same event, and a request with an opaque response can fail unnoticed. Matomo deduplicates the device ID for installation counts; event totals are not an exact-once metric. Network failures retry only on later activity, at most every five minutes. Requests time out after five seconds. Disabling reporting cancels pending requests and stops new reports. It retains the ID for deletion requests and does not delete historical data. Storage failure stops reporting in that window and shows an error.

## Server configuration

Configured and verified on 9 October 2026:

| Setting | Value |
| --- | --- |
| Service | Strato VPS, Dokploy `matomo_app`, Matomo 5.13.0 |
| Tracking endpoint | `https://analytics.tbuck.de/matomo.php` |
| Site | `Tau App`, ID `4`, UTC |
| Fixed action URL | `https://rasalas.github.io/tau/app` |
| Visitor ID | `cid`, random per participating device |
| Custom dimension 1 | App version, visit scope |
| Custom dimension 2 | Platform, visit scope |
| Custom dimension 3 | Release channel, visit scope |
| Site-specific privacy | Four-byte IP mask, enrichment uses the masked IP |
| Rolling unique visitors | `[General] enable_processing_unique_visitors_range = 1` |

The site restricts tracking to its fixed action URL prefix. Requests are form POSTs with no cookies, referrer or privileged token. Matomo receives generic `ua=Tau` and `lang=und` parameters. The HTTPS connection still exposes the source IP and real browser headers to the server. Matomo's stored IP is fully masked; this does not govern proxy or webserver logs. Raw-data auto-deletion remains disabled in the existing installation. No global retention or logging settings were changed.

The range setting applies globally. A backup of the prior config exists inside the Matomo container at `config/config.ini.php.before-tau-usage-20261009`.

## Read the numbers

Run with the operator's existing SSH key:

```sh
npm run stats
```

The command defaults to the SSH alias `vps`. Pass another host with `npm run stats -- other-ssh-alias`. SSH uses the operator's local SSH configuration, private key or agent; none of these credentials are included in the repository or sent to GitHub.

The script finds the running `matomo:5-apache` container and reads the counts through Matomo's internal Reporting API on that server. It prints JSON for `promptActive.last7`, `promptActive.last30`, `workbenchActive.last7` and `workbenchActive.last30`, with UTC and the report time. It needs administrative SSH access; it creates no app token or public reporting endpoint. The Docker image filter must be updated when the server moves to a different Matomo image.

Matomo also has two saved site-specific segments, **Tau: aktive Prompt-Installationen** and **Tau: aktive Workbench-Installationen**. In the UI select **Tau App**, the appropriate segment, and the desired date range. Use unique visitors rather than visits or event totals.

The API method is `VisitsSummary.getUniqueVisitors`, with `idSite=4`, `period=range`, `date=last7` or `last30`, and `segment=eventAction==human_prompt_accepted` or `eventAction==workbench_used`. Each range includes the current incomplete UTC day. Never add daily unique counts to derive a rolling count. Raw visit data must remain available for the queried range.

For a public claim use wording such as "N teilnehmende Desktop-Installationen haben Tau in den letzten 30 Tagen für Prompts genutzt, Stand … UTC." Opt-in, offline failures and excluded client types limit coverage. The public tracking API can accept fabricated IDs; these counts do not verify real people.

## Deletion and release

Settings displays the device's Statistics ID and the privacy-policy contact `info@tbuck.de`. In Matomo's GDPR tools search Site `4` using `visitorId==<id>`. Delete all matching visits, including further batches if the result limit is reached, and allow affected archives to be recalculated. There is no administrative token in the app and no automatic deletion endpoint.

The [public policy](https://tbuck.de/privacy/tau/) was updated in German and English on 9 October 2026 for Tau 0.7.40, including its former statements that there was no analytics or stored operator data. The [privacy-policy supplement](privacy-usage-statistics.md) records the disclosure. The app also discloses the payload and voluntary participation beside the switch. Keep the public policy aligned before distributing future changes.

## Verification

The live collector test used a separate temporary site with the same action URL, dimensions and IP settings. Three requests with two IDs returned HTTP 204 and yielded two unique visitors for both `last7` and `last30`. Stored IPs were `0.0.0.0` and dimensions matched the payload. The temporary site, its visits, actions and test archive rows were removed. The production site remained at zero.

Unit and component tests cover consent, daily deduplication, stable identity, retries, cancellation, storage failure, payload fields and development exclusions. An isolated desktop app checks that the settings page is present, initially off and disabled in a test instance.

Validation on 9 October 2026 against the integrated main with Node 22.23.3: all 1,136 test files passed, with 9,825 tests passed and five skipped. Typecheck, lint, desktop/web build budgets and startup budget passed. The consent component also passes with `TAU_TEST_SLOW_RENDERS=30`. The public policy deployment succeeded and both language sections were verified at the live URL.
