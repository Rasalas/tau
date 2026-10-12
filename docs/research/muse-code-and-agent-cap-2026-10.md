# Muse Code als Provider und die Obergrenze für Subagents bei T3 Code

Recherchiert am 12. Oktober 2026 für die offenen Fragen aus `docs/research/t3code-last-week-2026-10-11.md` (Muse Code, Agentenobergrenze). Zwei Teile: **A** Muse Code (was es ist, wie man Zugang bekommt, wie T3 es anbindet, was ein Tau-Kit bräuchte) und **B** gibt es bei T3 Code eine Obergrenze für laufende Agenten. Gelesen wurden T3 Code `origin/main` `a27cf8af51` (nur Lesen mit `git show`/`git grep`), die Muse-Dokumentation von Meta, die SDK-Repo-README, die OpenCode-Zen-Dokumentation und Taus Kits. Es wurde kein Konto angelegt, nichts installiert, und kein `muse` ausgeführt; den SDK-Quelltext (`@muse-code/sdk`) habe ich nicht gelesen, weil der Checkout kein `node_modules/@muse-code` hat.

## Kurzfassung

- **Muse Code** ist Metas Coding-Agent für Terminal und CI (Befehl `muse`, Modell Muse Spark), seit 5. August 2026 in Beta, seit 31. August 2026 ohne Beta-Etikett. Zugang: Installationsskript, Anmeldung per Browser mit Meta-Konto oder `META_API_KEY`. **Einen kostenlosen Zugang bietet Meta selbst nicht an**; Abrechnung per Token oder Abo, laut Drittquellen mit hinterlegter Zahlungsmethode. Der einzige belegte kostenlose Weg ist das Modell `muse-spark-1.3-contributor-free` bei **OpenCode Zen**, „for a limited time“ und gegen die Erlaubnis, Prompts und Antworten für Metas Modelltraining zu nutzen.
- **T3** startet pro Thread einen eigenen `muse serve`-Prozess und spricht über das SDK `@muse-code/sdk` das Muse Session Protocol (JSON-RPC über stdio). Installation und Anmeldung bleiben beim Nutzer (`muse login`). Das Paket `packages/provider-muse` hat 4008 Zeilen Produktivcode, 2327 davon im Adapter.
- Ein **Tau-Kit** wäre ähnlich groß wie `kits/opencode` (rund 2300 bis 2600 Zeilen Produktivcode, mit Tests über 4000). Die Fachlogik der Anbindung lässt sich von T3 übernehmen, den Effect-Adapter nicht. Dagegen stehen: das Protokoll hängt an der CLI-Version, kein Auth-Signal im Protokoll, kein Rollback und kein Fork, nur zwei Rechtestufen. Wer nur die günstigen oder kostenlosen Muse-Modelle will, erreicht sie schon heute über das OpenCode-Kit, ohne neuen Code.
- **Obergrenze für Subagents bei T3:** **Es gibt keine.** Weder eine Zahl gleichzeitig laufender Agenten pro Maschine, Thread, Projekt oder Provider-Session noch eine Tiefengrenze. Die einzigen Grenzen kommen von den Programmen der Provider (Codex, Muse, OpenCode), die T3 weder liest noch setzt. Belege und Suchumfang unten.

---

# A. Muse Code

## Was es ist und von wem

- Meta nennt es „Meta’s coding agent for the terminal and CI“, gebaut für das Modell Muse Spark; Standardmodell `muse-spark-1.2` ([Muse-Code-Doku](https://dev.meta.ai/docs/muse-code)). Es plant, ändert Dateien und führt Befehle aus, mit Freigaben und OS-Sandbox ab dem ersten Start. Unabhängig davon gibt es die Meta Model API für eigene Agenten.
- Ankündigung: „We’re excited to release Muse Code (beta), a terminal coding agent powered by Muse Spark 1.2.“ ([Meta Research](https://research.meta.ai/blog/introducing-muse-code-and-muse-spark-1-2)); Beta-Start 5. August 2026 laut Drittquellen. Die Beta endete am 31. August 2026 mit drei Monatsabos, Workflows (koordinierte Subagent-Teams) und dem SDK als Developer Preview ([Meta-Blog](https://dev.meta.ai/resources/blog/muse-code-new-plans-and-features/), [AI Weekly](https://aiweekly.co/alerts/meta-graduates-muse-code-out-of-beta-with-inter-session-messaging-workflow)).
- Plattformen: macOS, Linux, Windows (PowerShell statt Bash, keine Spracheingabe). Der Einzeiler für macOS und Linux steht in Metas Ankündigung (`curl -fsSL https://dev.meta.ai/install.sh | bash`).
- Programmgesteuert: `muse exec "<prompt>"` für einen Lauf, `muse serve` für das **Muse Session Protocol (MSP)**, `muse schema` für das JSON-Schema. Das [SDK](https://github.com/meta-models/muse-code-sdk) (`@muse-code/sdk`, MIT, Node 20+, keine Laufzeitabhängigkeiten, Developer Preview, vor 1.0 ohne Stabilitätszusage) startet einen lokalen `muse`-Host und redet über stdio mit ihm. Die Binary ist nicht im SDK. Ein inoffizieller [ACP-Adapter](https://github.com/bex-co/muse-code-acp) (Community, nicht von Meta) übersetzt MSP nach ACP; Meta selbst bietet kein ACP an, soweit ich es finden konnte.

## Zugang und Kosten

Aus Metas Seiten gesichert:

- Anmeldung beim ersten Start im Projekt: Browser-Anmeldung oder API-Schlüssel, später über `/login`; für CI `META_API_KEY` ([Doku](https://dev.meta.ai/docs/muse-code)). Abo-Seite: Man braucht ein Meta-Konto, Volljährigkeit, und „Subscription benefits and availability may vary by region“ ([Subscriptions](https://dev.meta.ai/docs/muse-code/subscriptions)).
- Die Subscriptions-Seite nennt **keine Preise** und **kein Gratis-Kontingent oder Probeabo**. Sie nennt drei Stufen (Everyday Usage mit „10-50 prompts every 5 hours“, High Usage mit „5x“, Power Usage mit „20x“). Das widerspricht Drittquellen, die 3x und 10x und Preise von 5, 15 und 50 US-Dollar im Monat nennen ([Subscription Insider](https://www.subscriptioninsider.com/blog/meta-adds-monthly-plans-as-muse-code-exits-beta), [eesel](https://www.eesel.ai/blog/meta-muse-code-pricing)). Ob die Seite Muse Code oder Metas allgemeines Abo beschreibt, ist nicht klar. Preise also nicht als gesichert behandeln.
- Pay-as-you-go über die Meta Model API (Zahlen laut [eesel](https://www.eesel.ai/blog/meta-muse-code-pricing), die sie von Metas Preisseite übernehmen; Meta-Seite selbst nicht geöffnet): `muse-spark-1.2` 1,25 US-Dollar Eingabe, 0,15 gecacht, 4,25 Ausgabe je Million Token. Die Zahlen decken sich mit der OpenCode-Zen-Preisliste unten.
- **Contributor-Stufe** `muse-spark-1.2-contributor`: 0,10 Eingabe und 0,20 Ausgabe je Million Token, „Used to improve our products“, strengere Limits, nur in einigen Ländern (Forenberichte: USA; EU und Australien nicht) ([aireiter](https://aireiter.com/blog/meta-muse-code-pricing-contributor-tier), [Hacker News](https://news.ycombinator.com/item?id=49187575)). Ein Forenkommentar berichtet von einem 403 „repeated policy violations“ ohne Vorwarnung.
- **Kostenlos?** Keine Meta-Seite nennt ein Free Tier, eine Warteliste oder Beta-Einladung für Muse Code. Drittquellen: keine Gratisstufe; eine Zahlungsmethode sei vor dem ersten Lauf nötig (eesel, aireiter; nicht von Meta zitiert). Die 20 US-Dollar Startguthaben gehörten laut Hacker-News-Kommentar zum Start von Muse Spark 1.1 in der API; Status heute unklar. Die API-Anmeldung hat laut einem Kommentar eine Selfie-Prüfung. Ein Spend-Cap fehlt laut eesel (nur E-Mail-Warnungen).
- **Einziger belegter Gratisweg:** [OpenCode Zen](https://opencode.ai/docs/zen/) listet `muse-spark-1.3-contributor-free` (Endpunkt `/responses`, `@ai-sdk/openai`) als „Free“, „available on OpenCode for a limited time“, mit dem Vermerk „Heavily discounted token pricing in exchange for permission to use your prompts and completions to train future Meta models“. Dieselbe Seite führt `muse-spark-1.3` und `muse-spark-1.2` zu 1,25 / 4,25 / 0,15 US-Dollar. Eine Drittquelle, die das als „unbestätigt“ führt ([Free-Token-Liste](https://freetokens.custats.info/offers/muse-spark-1-3-contributor-free.html)), verlangt ein kostenloses Zen-Konto.

Zum Tau-Bezug: `kits/opencode/catalog.ts:22` behandelt Preis null als „OpenCode Zen’s free models“. Taus OpenCode-Kit zeigt also jedes Zen-Modell, das OpenCode meldet, auch dieses, sofern das Zen-Konto des Nutzers es freigibt. Das habe ich nicht in einer laufenden Tau-Instanz geprüft.

## Wie T3 es anbindet

Alle Pfade unter `packages/provider-muse/src/` in [T3 Code](https://github.com/pingdotgg/t3code), Commits: `d6f47ff972` (#17082, 08.10.2026, Provider eingeführt), `5b78b34bba` (#17331, eigenes Paket), `d81afa0a6f` (#17329, Workflow-Subagents ohne verdeckte Freigaben), `953edeec9d` (#17163, Windows), `a4a1a803a3` (#18065), `c1d528a342` (#18353, native Subagents in eigenen Kind-Threads), `6ba6a0daf4` (#18409, Muse 1.4.6).

- **Prozessmodell:** SDK als MSP-Client; pro Thread ein eigener Kindprozess `muse serve --trust-workspace` (mit `--disable-sandbox` im Full-Access-Modus; schreibgeschützte Hosts für Modellliste und Textgenerierung mit `--disable-shell --disable-write --no-session-log`). Handshake `initialize` mit `clientInfo t3_code`, 20 s Frist, Schemaversion 1 (`server/sdk.ts:138-207`). Der Adapter ist `server/adapter.ts` (2327 Zeilen).
- **Binary:** Einstellung `binaryPath`, Standard `muse` im PATH. Keine Installation aus T3 (`docs/user/providers-muse.md`: „in-app installation and sign-in are not available“). Updates nur, wenn T3 den offiziellen Launcher erkennt (`maintenance.ts:45-87`, Aufruf mit `MUSE_SYNC_UPDATE=1`); neueste Version von `https://api.meta.ai/muse-code/channels/{muse-stable|muse-canary}`; T3 schaltet `MUSE_NO_AUTO_UPDATE=1` für seine Hosts. Windows: nur manuelle Updates.
- **Anmeldung:** nur `muse login` auf dem Host. `META_API_KEY` aus der Server-Umgebung wird **entfernt** (`sdk.ts:58-70`), damit das gespeicherte Login gilt; pro Provider-Instanz kann der Schlüssel gesetzt werden und hat dann Vorrang. MSP meldet keinen Anmeldestatus, T3 führt `auth: unknown` und merkt Fehler erst im ersten Turn (`status.ts:137-148`).
- **Modelle:** MSP-Anfrage `model/list` über einen Wegwerf-Host (`modelCatalog.ts:100-139`), Felder `modelId`, `displayLabel`, `providerId` (muss `meta` sein), Varianten und Denkstufen `none` bis `ultra`. Es gibt in T3 keine Free-Logik; Muse kann Modelle listen, die das Konto nicht nutzen darf (dann hilft ein eigenes Modell, Doku `:42-44`).
- **Sitzung:** `session/start`, `session/resume` (`excludeItems`), `session/setModel`, `session/compact`, `turn/start` mit `ifBusy: queue`, `turn/steer`, `turn/interrupt`, `session/read`. **Kein Rollback, kein natives Fork** (Fork über Kontext-Übergabe), nach einem Neustart sind offene Freigaben verloren.
- **Ereignisse:** Items mit Revisionen (`item/started|updated|completed`, `item/delta` im 50-ms-Takt), Tool-Namen auf T3-Typen abgebildet (`itemPresentation.ts:52-146`), `web_search` mit verlinkten Treffern (neu mit 1.4.6), Freigaben (`approval/*`; Muse-Shell kennt kein „denied“ außer `abort`), Fragen (`userInput/*`), Pläne (`session/todoListChanged`), Token- und Kontextnutzung. Native Subagents werden Kind-Threads, die nur Prompt, Status und Ergebnis zeigen (Muse 1.4.4 liest Kind-Sitzungen nicht inline); Workflow-Kinder werden Pseudo-Subagents ohne Thread, Freigaben von Workflow-Kindern bestätigt T3 im Full-Access-Modus selbst, weil Muse `allowAll` nicht vererbt.
- **MCP:** T3 reicht seinen MCP-Server als `mcpServers["t3-code"]` mit `mode: "optional"` an Muse weiter (Fähigkeit `sessionMcp`).
- **Version:** `@muse-code/sdk` auf 1.4.6 gepinnt (`packages/provider-muse/package.json:27`); empfohlene CLI `>=1.4.2` (`model-manifest.json:90-97`); CLI-Versionen haben die Form `x.y.z-R<rev>`.
- **Windows (#17163):** `turn/start` verlangt den verbatim-kanonischen Pfad (`\\?\C:\…`); `muse.cmd` wird über `cmd.exe /d /c` mit eigenem Quoting gestartet (`sdk.ts:72-135`).
- **Oberfläche:** Standardmäßig aus, Beta-Etikett, Formular nur mit `binaryPath`, Modi Supervised und Full access, kein Plan-Modus, nur der Slash-Befehl `/compact`.
- **Umfang:** Paket 23 Dateien, rund 6780 Zeilen, davon 4008 Produktivcode und 2722 Tests (rund 77 Testfälle gegen aufgezeichnete MSP-Mitschnitte, dazu 890 Zeilen Fixtures und ein 321-Zeilen-Rekorder außerhalb des Pakets).

## Was ein Tau-Kit bräuchte

Zahlen aus `wc -l` über das jeweilige Verzeichnis, mit Tests: `kits/opencode` 25 Dateien, 6104 Zeilen; `kits/antigravity` 27 Dateien, 3699 Zeilen; `kits/_acp` (geteilter ACP-Unterbau) 14 Dateien, 2217 Zeilen.

Ein Runtime-Kit besteht aus `tau-extension.json` (Berechtigungen `process`, `sessions`, `runtime:extend`, `network`), `host.ts` (Registrierung über `services.registerRuntimeBackend`), `thread-backend.ts`, `session-store.ts`, `runtime-adapter.ts` (nur Identität und Fähigkeiten), Ereignis- und Freigabeübersetzung, `mcp.ts` und `desktop.tsx` für die Karte unter Providers. Nutzbare Host-Seams: `findCommand`, `commandInvocation`, `killProcessTree`, `noteSubprocess`, `services.mcp.connect`, `registerSignIn` (Methoden `browser`, `device-code`, `api-key`, `terminal`, `credentials`), `cliMaintenance`, `runtimeVersionPolicy`, `loadDependency`.

| Teil | Vorbild | grobe Größe |
|---|---|---|
| Manifest, `protocol.ts`, `runtime-adapter.ts` | opencode | rund 100 |
| MSP-Start mit Windows-Launcher, Umgebung ohne `META_API_KEY` | T3 `sdk.ts` (245) | rund 250 |
| `host.ts`: Provider, Version, Wartung, Anmelde-Anzeige | opencode 565, antigravity 354 | rund 400 |
| Thread-Backend und Ereignisse: MSP-Items auf `ThreadRuntimeEvent`, Freigaben, Fragen, Abbruch, Fortsetzen | opencode `thread-backend.ts` 681 + `events.ts` 276 | rund 900 bis 1100 |
| Freigaben, Sitzungsablage, MCP | opencode 126, antigravity 316, 16 | rund 450 |
| Karte in den Einstellungen | antigravity `desktop.tsx` 286 | rund 250 |
| Summe Produktivcode | | rund 2300 bis 2600 |
| Tests und Fixtures (Mitschnitte gegen ein echtes `muse serve`) | | über 1000 dazu |

Übertragbar von T3: `sdk.ts`, `modelCatalog.ts`, das Schema aus `protocol.ts` und die Zuordnung der Freigabe-Antworten, die Namensheuristik aus `itemPresentation.ts`, die Versionslogik aus `maintenance.ts`, das Revisionsmuster und die Kind-Thread-Idee (Tau hat `kits/agents/native-events.ts`, `NativeAgentTracker`), das Auto-Bestätigen von Workflow-Kindern im Full-Access-Modus, die Rekorder- und Fixture-Anordnung. Neu zu bauen: alles, was an Effect hängt (Tau nutzt kein Effect), und die Übersetzung in Taus Ereignistypen.

Lücken und Risiken:

1. **Entscheidung:** `docs/research/t3code-last-week-2026-10-11.md:79` führt Muse Code unter „Nicht übernehmen“. Ein Kit bedeutet dauerhafte Wartung gegen ein Protokoll, das sich mit der CLI ändert (Punkt 4).
2. **Proprietäre Binary, kein Download-Weg:** `muse` kommt nur über Metas Installationsskript und Kanäle. Anders als bei Antigravity (`install.ts`, `release.ts`, SHA-256) hat Tau keinen geprüften Download. Das Kit würde wie bei T3 nur die vorhandene Binary finden.
3. **Kein Anmeldestatus im Protokoll.** Die Karte könnte „angemeldet“ nicht prüfen; `registerSignIn` ginge höchstens als `terminal`-Methode (`muse login`).
4. **Protokoll an CLI-Version gebunden.** SDK 1.4.6 ist exakt gepinnt, und T3 hat zwischen 1.4.2 und 1.4.6 Protokollzusätze nachgezogen. Das SDK ist eine Developer Preview ohne Stabilitätszusage.
5. **Fehlende Funktionen:** kein Rollback, kein Fork, Kind-Sitzungen nur mit Prompt, Status und Ergebnis, offene Freigaben überleben keinen Neustart.
6. **Rechtestufen:** Muse kennt zwei (`promptUnmatched`, `allowAll`), Tau vier (`read-only`, `ask`, `auto`, `full`). Nur-Lesen ginge allein über `--disable-shell --disable-write` für die ganze Sitzung.
7. **Windows:** Das Quoting über `cmd.exe` ist fehleranfällig; T3 hat dafür allein 194 Zeilen Tests in `sdk.test.ts`.
8. **Aufnahme:** Mitschnitte gegen ein echtes `muse serve` brauchen ein Konto mit Zahlungsmethode; das habe ich nicht angelegt.
9. **Zugang und Datenschutz:** Die billigen Modelle sind Contributor-Stufen mit Training auf Nutzerdaten und regionaler Beschränkung; eine Zahlungsmethode ist laut Drittquellen Pflicht.

**Weg ohne neues Kit:** Das OpenCode-Kit zeigt `muse-spark-1.3-contributor-free` und die Standardmodelle, wenn Zen sie meldet. Ein Muse-Kit lohnt sich erst, wenn Nutzer die Muse-eigenen Funktionen wollen (Workflows, Kindsitzungen, Muse-Anmeldung), nicht nur das Modell.

---

# B. Obergrenze für laufende Subagents bei T3 Code

Befund: **Es gibt keine.** Stand `origin/main` `a27cf8af51` (12.10.2026). Die Suche lief mit `git grep` auf `origin/main`, nicht im Arbeitsbaum.

## Wo man sie erwartet, und was dort steht

- **Delegieren:** `delegate_task` (`apps/server/src/mcp/OrchestratorMcpService.ts:1953`, `delegateTask`) prüft nur, dass der Elternlauf aktiv ist, dass Provider-Sitzung und Zielinstanz passen (`parent_not_active`, `provider_unavailable`). Es zählt keine laufenden Kinder. Der Orchestrator (`apps/server/src/orchestration-v2/Orchestrator.ts:6548`, `dispatchDelegatedTaskRequest`, aufgerufen bei `:10864`) prüft Elternlauf, Elternknoten und Adapter; `parentProjection.subagents.length + 1` dient nur der Titelnummer.
- **Tiefe:** Keine Prüfung. Auch ein Kind-Thread mit aktivem Lauf kann `delegate_task` aufrufen. `rootThreadId` steht in der Lineage (`Orchestrator.ts:2252`), wird aber nie gezählt.
- **Fähigkeiten der Provider:** nur Wahrheitswerte (`supportsSubagents`, `canWaitForSubagents` …, `packages/contracts/src/orchestrationV2.ts:267`), keine Zahl.
- **Einstellungen:** `packages/contracts/src/settings.ts` und `apps/server/src/serverSettings.ts` haben keine Einstellung zur Anzahl von Agenten.
- **Agent-SDK-Provider:** T3s Adapter schließt `maxTurns` ausdrücklich aus den erlaubten Query-Optionen aus; die Umgebungsvariablen des CLI kommen nur als `…_AUTO_CONNECT_IDE` und `…_IDE_SKIP_AUTO_INSTALL` vor.
- **Codex:** An die Thread-Konfiguration schickt T3 nur `{ "tools.update_plan.enabled": true }` (`CodexAdapterV2.ts:1301`).

## Grenzwerte, die nicht von T3 stammen

1. **Codex `agents.max_depth`:** nur im Aufnahmeskript für Test-Mitschnitte, `apps/server/scripts/record-codex-app-server-replay-fixture.ts:509` (`3`, Szene `subagent_v2_nested`) und `:530` (`2`). `packages/effect-codex-app-server/src/replay.ts:249-253` ignoriert diese Schlüssel beim Abgleich ausdrücklich („never sends“). Eingeführt mit `de34391427` (02.10.2026, #2829, neuer Orchestrator). Der Produktivclient sendet den Schlüssel nie, `agents.max_threads` kommt im Repo nirgends vor (`git log -S` leer). OpenAIs Doku kennt `agents.max_threads` nur noch als Altname von `agents.max_concurrent_threads_per_session` („Cap concurrently open spawned-agent threads, excluding the primary“, Standard nicht genannt, [Codex-Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)); zu `agents.max_depth` sagt die Seite nichts.
2. **Muse:** Das Programm meldet in einem Mitschnitt `"maxParallelAgents":16` und `"childLimit":16` (`apps/server/src/orchestration-v2/testkit/fixtures/muse_workflow/muse_transcript.ndjson:26`, mit `d6f47ff972`, 08.10.2026). T3 liest, wertet und setzt das nicht. Metas Doku: „One agent tree can execute eight agents at once by default, including the root agent“, einstellbar mit `agents.execution_capacity` von 1 bis 64 ([Muse: Extending](https://dev.meta.ai/docs/muse-code/extending)); Workflows: „up to 1,000 child tasks over its lifetime“ und „The local active-child limit is CPU-derived and capped at 16“ ([Workflows](https://dev.meta.ai/docs/muse-code/workflows)).
3. **OpenCode:** Kommentar in `packages/provider-opencode/src/server/v2/adapter.ts:2313`: „A refused call (unknown agent, the nesting limit) is a failed subagent.“ OpenCode lehnt Aufrufe also selbst ab; T3 kennt den Wert nicht.

## Grenzen für anderes (keine Obergrenze für Agenten)

| Fundstelle | Wert | Was es begrenzt | Commit |
|---|---|---|---|
| `packages/contracts/src/orchestratorMcp.ts:244-247` | `create_threads` höchstens 20 pro Aufruf | Batch-Größe für normale Threads, ausdrücklich „not delegation“ | `de34391427`, 02.10.2026, #2829 |
| `apps/server/src/orchestration-v2/ProviderSessionManager.ts:54-55` | 30 min Leerlauf, höchstens 4 h gehalten | wie lange eine Sitzung mit offener Subagent-Arbeit geladen bleibt (Option `maxIdlePinMs`, nicht in Nutzer-Settings) | `de34391427` |
| `apps/server/src/orchestration-v2/RestartContinuation.ts:27` | `MAX_CONTINUATION_CHAIN = 3` | automatische Fortsetzungen nach einem Neustart | `b9ad3daf8d`, 11.10.2026, #18461 |
| `apps/server/src/provider/CodexManagedRuntime.ts:25-26` | `features.multi_agent=false`, `features.multi_agent_v2=false` | schaltet Multi-Agent im ChatGPT-Sharing-Modus ganz ab (Schalter, kein Limit) | `0eef5d0c76`, 11.10.2026, #17499 |
| `apps/web/src/types.ts:36` | `MAX_TERMINALS_PER_GROUP = 4` | Terminals je Gruppe | `376efdd340`, `c52ad29b31` (2026) |
| `packages/provider-acp/src/server/clientTerminals.ts:25` | `MAX_LIVE_TERMINALS = 16` | Terminals eines ACP-Clients | `664bd5e524`, 08.10.2026, #17354 |
| `apps/server/src/htmlRender/HtmlRender.ts:325` | `MAX_CONCURRENT_BROWSERS = 2` | gleichzeitige Browser für HTML-Seiten | `677d1527c3`, 05.10.2026, #15968 |

`c2f8cb7ca1` (#5745) zeigt die Zahl laufender Subagents nur an. Die Commits mit „limit“ im Titel betreffen Nutzungskontingente und GitHub-Rate-Limits. `Effect.forEach`-Werte mit Nebenläufigkeit 8 oder 16 liegen in Aufräum-, Settlement- und Lesepfaden (`Orchestrator.ts:11216`, `ThreadSettlementService.ts`, `http.ts:74`), nicht in Agentenläufen.

## Suchumfang des Negativbefunds

- **Orte** (`git grep … origin/main`): `apps/` (server, desktop, web, mobile), `packages/` (contracts, shared, client-runtime, provider-core, provider-acp, provider-cursor, provider-grok, provider-muse, provider-opencode, provider-pi, effect-codex-app-server, effect-acp), `docs/`, `.agents/`, die Agent-Konfiguration, `AGENTS.md`. Treffer unter `.repos/` sind fremde Bibliotheken.
- **Muster:** `max_?threads`, `max_?depth`, `maxConcurren`, `max_?agents`, `maxSubagent`, `maxParallel`, `maxChild`, `nesting`, `agents.max`, `multi_agent`, `Semaphore`, `withPermits`, `Queue.bounded`, `concurrency:`, `maxTurns`, `maxSessions`, `MAX_(ACTIVE|RUNNING|LIVE|AGENTS|CHILDREN|TASKS|PARALLEL|CONCURRENT)`, `lineageDepth`, `ancestorDepth`, `nested`, `too many`, `delegat`.
- **Historie:** `git log --grep` für subagent, sub-agent, delegat, nested, concurren, parallel, limit, cap, throttle, max depth, max agents, fan-out, nesting; `git log -S` für `agents.max_depth`, `agents.max_threads`, `max_threads`, `MAX_SUBAGENT`, `MAX_CONCURRENT`, `maxConcurrentAgents`, `maxSubagents`, `maxParallelAgents`, `spawn_agent`, `multi_agent`. Die Subagent-Commits behandeln Anzeige, Stopp, Modelle und Settlement, nie eine Zahl.

## Was das für Tau heißt

- T3 ist kein Vorbild für eine eigene Tau-Obergrenze; wer dort eine sucht, findet die Grenzen nur bei den Providern. Eine Obergrenze in Tau wäre eine eigene Entscheidung, keine Übernahme.
- Die Provider setzen ihre Grenzen selbst: Muse 8 je Baum (einstellbar), 16 aktive Workflow-Kinder, OpenCode ein Verschachtelungslimit unbekannter Höhe, Codex ein Limit je Sitzung mit nicht dokumentiertem Standard. Für den Agent-SDK-Provider habe ich keine Grenze gesucht.
- Offen: ob OpenCodes Verschachtelungsgrenze und Codex’ Standardwert in den installierten Versionen messbar sind; das ginge nur mit einem Lauf gegen die echten Programme.

## Offene Punkte (A und B)

- Muse: Preise der Abos, Gratis-Kontingent, Länder der Contributor-Stufe und die Frage der Zahlungsmethode stammen aus Drittquellen oder Foren; Metas Preisseiten waren nicht lesbar (Anmeldung) oder nennen keine Zahlen. Vor einer Entscheidung auf `dev.meta.ai` prüfen, mit Konto.
- Muse: SDK-Quelltext und `muse serve` nicht gelesen oder ausgeführt; alles zum Protokoll stammt aus T3s Adapter.
- Ob `muse-spark-1.3-contributor-free` bei OpenCode noch läuft („limited time“) und für Nutzer ohne Zahlungsmethode geht: ungeprüft.
- T3: Der Negativbefund gilt für `a27cf8af51`. Nachträgliche Commits können eine Grenze bringen; ein erneutes `git grep` mit den Mustern oben dauert Sekunden.
