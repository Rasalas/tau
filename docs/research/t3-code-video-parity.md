# T3 Code broke me: Videoabgleich mit Tau

Stand 29. Oktober 2026. Geprüfter Tau-Checkout `61ef9b98af393270f232d41ec5635cc9b5a0ba89`. Recherche ohne eigene Produktcodeänderungen, Appstart oder Dependencyinstallation. Während der Recherche begonnene parallele Änderungen an `bin/tau.mjs` und neue `bin/tau-triage.*` gehören nicht zum geprüften HEAD und wurden nicht als fertige Implementierung bewertet.

## Antwort auf „Unterstützen wir das alles komplett und sauber?“

Nein. Für viele konkret besprochene Abläufe gibt es Tau-Implementierungen. Das Video enthält aber auch Funktionen, für die Tau keine entsprechende Implementierung liefert, und Abläufe, bei denen Tau eine andere oder eingeschränkte Lösung hat. Aus dem gelesenen Code lässt sich außerdem keine durchgehend saubere Laufzeitfunktion auf echten Konten, Geräten und Maschinen ableiten.

Die stärksten belegten Unterschiede sind Muse Code und eine allgemeine ACP-Registry, vollständige externe MCP-Steuerung, Runtimewechsel im selben Thread, Windows-ARM64-Auslieferung, der komfortable Zugriff des lokalen Editors auf eine entfernte Maschine und der eigenständige Triage-Befehl. Tau Connect hat Code für eigene Relays, aber laut Repository-Dokumentation keinen betriebenen öffentlichen Dienst. Webhooks sind vorhanden; der im Video beschriebene öffentliche Vermittlungsdienst mit 24-Stunden-Puffer ist damit nicht nachgewiesen.

Rate-Limit-Fortsetzung, Remote-Simulatoren, H.264, 3D und Floating sind ausdrücklich keine pauschalen Tau-Lücken. Die Tabelle trennt diese vorhandenen Teile von ihren konkreten Prüfgrenzen.

## Quellen und Verfahren

Primärquelle ist [Theos Video](https://www.youtube.com/watch?v=uLGxb4F3SyI), ausgewertet über das vollständig gelieferte, zeitgestempelte Transkript:

`/home/tbuck/.t3/userdata/attachments/b86f60b9-1590-45b8-af35-4504028ede25-61b86890-29d6-44f3-bd87-f0bda777015f-txt.txt`

SHA-256: `89d9656121d35e8abfd2e787cb4acb7bd891ebc50287f0c4c12889145f30e839`.

Gelesen wurden der Anfang, der vollständige Funktionsteil von 03:18 bis 37:31 und der Schluss bis 41:43. Die Zeitstempel unten folgen der Nutzerdatei. Verlinkt ist jeweils der Anfang des relevanten Abschnitts, keine behauptete sekundengenaue Grenze jedes Satzes. Die Transkription enthält offensichtliche Erkennungsfehler bei Produkt- und Modellnamen. Eindeutige Harnessnamen sind normalisiert; die exakten gesprochenen Modell-IDs werden nicht als bestätigte IDs behandelt.

Vor Lieferung der Datei wurden `/tmp/tau-video-page.html` und `/tmp/tau-video-player.json` gelesen. Sie bestätigen Titel, Video-ID, Autor, 2509 Sekunden Laufzeit und eine englische ASR-Spur. Web-Fetch war gedrosselt; fünf direkte `timedtext`-Varianten lieferten HTTP 200 mit leerem Body. `youtubei/v1/get_transcript` scheiterte mit HTTP 400 `FAILED_PRECONDITION`. Anschließend gelang mit einem frisch geladenen yt-dlp und `youtube:player_client=android` der Abruf von 634 JSON3-Events, davon 633 mit Text, bis 41:46. Temporäre Dateien sind `/tmp/tau-video-extracted.en.json3` und `/tmp/tau-video-transcript.txt`. Seit Lieferung der Nutzerdatei ist diese die Hauptquelle. Ein dauerhaftes Volltranskript wird hier nicht kopiert.

Damit besteht keine fehlende Transkriptstrecke mehr. Es gab jedoch keine audiovisuelle Sichtung. „Theo zeigt“ bedeutet nachfolgend, dass er die Bedienhandlung im Transkript beschreibt. Rein visuelle Zusatzfunktionen, exakte UI-Details und die tatsächliche erfolgreiche Ausführung der Videodemos bleiben ungeprüft. Aussagen über T3s aktuellen Stable-Stand beruhen auf seiner Aussage ab 40:02, nicht auf einem unabhängigen Release-Test. Alte Parity-Dokumente im Repo wurden nur zur Orientierung gelesen, nicht als Nachweis für dieses Video verwendet.

Die Tau-Nachweise stammen aus dem aktuellen Checkout. Gelesen wurden [CONTEXT.md](../../CONTEXT.md), ADRs [0005](../adr/0005-thread-runtime-backends.md), [0017](../adr/0017-worktrees-for-threads-and-agents.md), [0012](../adr/0012-preview-browser.md), [0030](../adr/0030-the-workbench-controls-every-machine.md), [0031](../adr/0031-attachments-follow-the-threads-home-machine.md), [0038](../adr/0038-delegation-across-runtimes.md) und [0045](../adr/0045-external-mcp-clients-use-separate-oauth-grants.md). Neuere Amendments sind gegenüber älteren ADR-Absätzen maßgeblich.

## Wie die Status zu lesen sind

- **Implementiert**: Ein konkreter Codepfad für die genannte Fähigkeit ist vorhanden. Keine Behauptung, dass er hier ausgeführt oder auf allen Plattformen bestätigt wurde.
- **Teilweise**: Ein Teil funktioniert laut Code, aber der im Video beschriebene Gesamtumfang hat eine konkrete Grenze oder einen anderen Ablauf.
- **Fehlend**: Keine entsprechende mitgelieferte Funktion gefunden; bei negativen Befunden sind Suchbereich oder positive Gegenbelege genannt. Ein beliebig nachrüstbares Extension-Modell zählt nicht als ausgelieferte Funktion.
- **Unbestätigt**: Die genaue Parität wurde nicht ausreichend belegt. Das ist keine Feststellung des Fehlens.

## Funktionsinventar aus dem Transkript

Wiederholungen sind zusammengeführt und mit zusätzlichen Zeiten versehen. Werbeaussagen, angekündigte Zukunft und technische Funktionen sind getrennt. Jede Zeile geht auf das Video zurück.

### Harnesses, Konten und Orchestrierung

| Video | Konkret besprochene Fähigkeit | Tau | Codebeleg und Grenze |
| --- | --- | --- | --- |
| [05:00](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=300s) | Eigene Abos, Logins, Modelle und Harnesses in einer App | Teilweise | Sieben relevante Runtimepfade vorhanden: Pi, Claude, Codex, Cursor, Grok, OpenCode und Antigravity. Muse fehlt. [docs/runtimes.md:3](../../docs/runtimes.md#L3), [kits/codex/host.ts:216](../../kits/codex/host.ts#L216). Kein Test aller Abos. |
| [05:16](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=316s) | Muse Code als direkt eingebauter Harness | Fehlend | Im vollständigen Kit-Verzeichnis kein Muse-Kit; Suche nach `muse`/`Muse` in Runtimehosts ohne entsprechenden Backendpfad. Ein Muse-Modell über einen anderen Provider wäre kein Nachweis des offiziellen Harnesses. |
| [05:23](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=323s) | Allgemeine ACP-Registry mit Amp, Cline, Copilot; manuell zusätzliche Agents | Fehlend | [kits/_acp/session.ts:1](../../kits/_acp/session.ts#L1) ist gemeinsame Infrastruktur für feste Runtimekits, keine generische installierbare Agent-Registry. [docs/runtimes.md:61](../../docs/runtimes.md#L61) beschreibt manuelle Modell-IDs für drei vorhandene ACP-Runtimes, keine frei registrierbaren Harnesses. |
| [05:38](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=338s) | CLI-Proxy als optionale Empfehlung | Unbestätigt | Theo empfiehlt ein externes Werkzeug. Keine exakte CLI-Proxy-Konfiguration oder deren Interoperabilität mit Tau geprüft. Keine eigene T3-Kernfunktion. |
| [05:45](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=345s) | Mehrere Instanzen desselben Providers mit Homes, Keys und Umgebungsvariablen | Implementiert | [kits/codex/host.ts:216](../../kits/codex/host.ts#L216), [docs/runtimes.md:41](../../docs/runtimes.md#L41). Instanzen sind eigene Backends; ein kompatibler Codex-Kontowechsel ist zusätzlich vorhanden und kein allgemeiner Runtimewechsel. |
| [06:26](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=386s) | Modell, Reasoning-Effort und Speed/Ultrafast wählen | Teilweise | [docs/runtimes.md:49](../../docs/runtimes.md#L49), [kits/codex/thread-backend.ts:1](../../kits/codex/thread-backend.ts#L1). Codex meldet seine Tiers; managed ChatGPT-Verbindungen blenden diese Steuerung laut Dokumentation aus. Exakte Videomodelle und Accountentitlements nicht geprüft. |
| [06:34](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=394s) | Vier verschiedene Modelle in offiziellen Harnesses als Delegates parallel starten | Teilweise | [kits/agents/host.ts:1358](../../kits/agents/host.ts#L1358), [kits/agents/delegation.ts:1](../../kits/agents/delegation.ts#L1). Runtime-/Modellwahl und Delegation vorhanden. Die konkrete Viererkombination scheitert an fehlendem Muse; keine Liveausführung. |
| [06:51](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=411s) | Arbeitsbaum für parallele Arbeit in app-eigenem Verzeichnis | Implementiert | [kits/workspace/agent-worktrees.ts:1](../../kits/workspace/agent-worktrees.ts#L1), ADR 0017 einschließlich Amendment vom 21. Oktober. Tau erzeugt standardmäßig zentrale Worktrees unter seinem Home. Topologie muss nicht identisch mit T3 sein. |
| [07:13](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=433s) | Bereits installierte CLIs und deren bestehende Anmeldungen nutzen; Gemini separat anmelden | Implementiert | [kits/claude-code/runtime-adapter.ts:219](../../kits/claude-code/runtime-adapter.ts#L219), [kits/codex/host.ts:216](../../kits/codex/host.ts#L216), [docs/runtimes.md:27](../../docs/runtimes.md#L27). Antigravity hat eigenen ACP-Server und Sign-in; Identität aller Loginabläufe nicht behauptet. |
| [07:49](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=469s) | In anderem Projekt einen neuen Thread mit derselben Aufgabe starten | Implementiert | [kits/agents/host.ts:1331](../../kits/agents/host.ts#L1331), [kits/agents/host.ts:1466](../../kits/agents/host.ts#L1466). `tau_create_thread` ist vom Start eines Subagents getrennt. |
| [08:07](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=487s) | Threads finden, anhand ID referenzieren und Nachrichten austauschen | Implementiert | [kits/agents/host.ts:1421](../../kits/agents/host.ts#L1421), [kits/agents/host.ts:1466](../../kits/agents/host.ts#L1466). Agentinterne Tools, nicht automatisch externes OAuth. |
| [08:31](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=511s), [26:49](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1609s) | Vollständige Threadsteuerung durch externe MCP-Clients wie Grok Bot oder ChatGPT | Teilweise | Interne MCP-Tools vorhanden, [src/main/mcp-endpoint.ts:170](../../src/main/mcp-endpoint.ts#L170). Der dedizierte externe Zugang bietet nur Projektliste, Threadliste und begrenztes Lesen, [src/main/external-mcp-read-tools.ts:15](../../src/main/external-mcp-read-tools.ts#L15). Keine externe Steuerung oder Grok-/ChatGPT-Interoperabilität nachgewiesen. ADR 0045 schließt `tau:threads` ausdrücklich aus. |
| [08:54](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=534s) | Bestehende Threads und Projekte beim Einstieg importieren | Teilweise | [kits/onboarding/host.ts:178](../../kits/onboarding/host.ts#L178) entdeckt Backend-Sessions über `import-scan`. Das ist ein expliziter Discovery-/Importablauf; vollständig automatischer Import jedes im Video genannten Harnesses ist nicht belegt. |

### Maschinen, Remotezugriff und Geräte

| Video | Konkret besprochene Fähigkeit | Tau | Codebeleg und Grenze |
| --- | --- | --- | --- |
| [10:23](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=623s), [11:26](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=686s) | Bei neuem Thread die ausführende Maschine wählen und Maschinen gemeinsam verwalten | Implementiert | [kits/environments/host.ts:112](../../kits/environments/host.ts#L112), [kits/environments/host.ts:149](../../kits/environments/host.ts#L149), [kits/environments/machine-backend.ts:1](../../kits/environments/machine-backend.ts#L1). Entspricht Home Machine aus ADR 0030. |
| [10:47](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=647s) | Headless-WebSocket-Server mit Weboberfläche ohne Desktop-App | Implementiert | [src/main/headless.ts:1](../../src/main/headless.ts#L1), [bin/tau.mjs:1](../../bin/tau.mjs#L1). Tau hat eigenen Headless-/Servicepfad. Der genaue `npx t3 serve`-Befehl ist selbstverständlich kein Tau-Befehl. |
| [11:11](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=671s) | Tailscale-Verbindungen | Implementiert | [kits/tailscale/host.ts:1](../../kits/tailscale/host.ts#L1). Realer Verbindungsaufbau nicht durchgeführt. |
| [12:00](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=720s) | Automatische Maschinenwahl nach CPU, RAM und Kapazität | Implementiert | [kits/environments/choice.ts:91](../../kits/environments/choice.ts#L91). Gewichte, Ausschlussgrenzen und Score aus freien CPU-/RAM-Anteilen sind konkret vorhanden. |
| [12:23](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=743s) | iOS-/Android-Simulatoren in der App, auch auf dedizierten Macs per SSH | Implementiert | [kits/devices/host.ts:21](../../kits/devices/host.ts#L21), [kits/devices/desktop.tsx:233](../../kits/devices/desktop.tsx#L233), [kits/devices/README.md:1](../../kits/devices/README.md#L1). Node, Xcode/SDKs und installierte Simulatoren müssen dort vorhanden sein. |
| [12:31](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=751s) | Auf Linux arbeiten, dabei iOS-Devserver/Build auf Mac nutzen | Teilweise | Remote-Devicehosts und Toolverzeichnis per SSH vorhanden, [kits/devices/desktop.tsx:239](../../kits/devices/desktop.tsx#L239). Das beweist nicht den vollständigen automatischen Quellcode-/Devserver-Transfer zwischen Linux-Workspace und Mac. |
| [12:46](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=766s) | Mobile App für vollständige Remote-Arbeit | Implementiert | [mobile/plugins/tau-native/ios/Sources/TauNativePlugin/TauNativePlugin.swift:1](../../mobile/plugins/tau-native/ios/Sources/TauNativePlugin/TauNativePlugin.swift#L1), [kits/environments/machine-backend.ts:1](../../kits/environments/machine-backend.ts#L1). Keine aktuelle Store-Auslieferung oder echte Gerätequalität geprüft. |
| [13:24](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=804s), [13:42](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=822s), [36:59](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=2219s) | Betriebenes Connect-Tunneling ohne VPN, Anmeldung per Link, drei Geräte kostenlos | Teilweise | [bin/tau-connect.mjs:1](../../bin/tau-connect.mjs#L1), [docs/connect.md:3](../../docs/connect.md#L3). Relayprotokoll und Selbstbetrieb vorhanden. Dokumentation verschiebt öffentliches Hosting ausdrücklich. Kein gleichwertiges kostenlos betriebenes Drei-Geräte-Angebot belegt. |
| [22:00](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1320s) | Infrastruktur selbst hosten und Forks betreiben | Implementiert | [docs/connect.md:25](../../docs/connect.md#L25), [LICENSE:1](../../LICENSE#L1). Code/Anleitung für Relaybetrieb vorhanden; daraus folgt kein produktiver öffentlicher Dienst. |
| [22:12](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1332s) | Interaktives Remote-Terminal über denselben Apptransport statt gesonderter SSH-Sitzung | Implementiert | [kits/terminal/machine-routing.ts:1](../../kits/terminal/machine-routing.ts#L1), [src/main/machine-kit-route.ts:108](../../src/main/machine-kit-route.ts#L108). Auch Relaytransport ist von einem realen Stabilitätsvergleich mit SSH zu trennen. |
| [22:26](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1346s) | CPU-/RAM-Diagnostik aller Maschinen als Dashboard | Implementiert | [kits/environments/machines.ts:175](../../kits/environments/machines.ts#L175), [kits/environments/choice.ts:109](../../kits/environments/choice.ts#L109). Messwerte werden dargestellt und zur Wahl genutzt. |
| [25:47](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1547s), [26:01](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1561s) | Remote-Simulator live steuern, auch aus der mobilen App | Implementiert | [kits/devices/README.md:3](../../kits/devices/README.md#L3), [kits/devices/desktop.tsx:181](../../kits/devices/desktop.tsx#L181). Authentifizierte H.264-Batches, WebCodecs, PNG-Fallback; keine echte Remote-Gerätesitzung ausgeführt. |
| [26:01](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1561s) | 3D-Geräteansicht, Drehung und Zoom per Touch | Implementiert | [kits/devices/desktop.tsx:168](../../kits/devices/desktop.tsx#L168), [kits/devices/README.md:9](../../kits/devices/README.md#L9). Tau verwendet generische CSS-Körper, keine vermessenen Originalgehäuse. |
| [26:19](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1579s) | Spezifischer iPhone-Duo-Support am ersten Tag | Unbestätigt | Im Video selbst als laufende Arbeit angekündigt. Tau hat generische Dual-Screen-/Foldable-Familien, [kits/devices/README.md:9](../../kits/devices/README.md#L9); das bestätigt kein konkretes zukünftiges Gerät oder dessen Release-Day-Unterstützung. |
| [26:27](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1587s) | Headless-Remote-Browser mit Bildübertragung, Eingabe und Sign-in | Implementiert | [kits/preview/headless-surface.ts:45](../../kits/preview/headless-surface.ts#L45), [kits/preview/screen-view.tsx:1](../../kits/preview/screen-view.tsx#L1), [kits/preview/headless-cookie-jar.ts:1](../../kits/preview/headless-cookie-jar.ts#L1). Browserprogramm muss vorhanden sein. Keine konkreten Loginanbieter geprüft. |
| [27:18](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1638s) | Geräteansicht schwebend über Chat | Implementiert | [kits/devices/README.md:9](../../kits/devices/README.md#L9), [kits/devices/desktop.tsx:1](../../kits/devices/desktop.tsx#L1). Floating und Rückkehr zur Stage sind dokumentierte Codefunktionen. |
| [27:57](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1677s), [28:33](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1713s) | macOS und Linux sowie ausdrücklich Windows ARM unterstützen | Teilweise | [.github/workflows/release.yml:209](../../.github/workflows/release.yml#L209), [scripts/packaging/publish-release.mjs:19](../../scripts/packaging/publish-release.mjs#L19). macOS, Linux und Windows x64 im Releasepfad; Windows ARM64 fehlt in der veröffentlichten Buildmatrix. ARM-Linux-Host ist vorhanden. Keine Aussage über x64-Emulation auf Windows ARM. |
| [28:25](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1705s) | In Omarchy integrierte Auslieferung | Unbestätigt | T3s Distributionsintegration ist keine generische Linuxfähigkeit. Für Tau keine Omarchy-Bündelung geprüft. |

### Inbox und Arbeitssteuerung

| Video | Konkret besprochene Fähigkeit | Tau | Codebeleg und Grenze |
| --- | --- | --- | --- |
| [16:14](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=974s), [16:30](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=990s) | Inbox mit Settle und eigener Ablage erledigter Threads | Implementiert | [kits/thread-rail/meta.ts:98](../../kits/thread-rail/meta.ts#L98), [kits/thread-rail/meta.ts:218](../../kits/thread-rail/meta.ts#L218). Archivieren und Settlen bleiben unterschiedliche Aktionen. |
| [16:46](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1006s) | Settle mit Cmd-Z zurücknehmen | Implementiert | [kits/thread-rail/undo.ts:1](../../kits/thread-rail/undo.ts#L1), [kits/thread-rail/desktop.tsx:44](../../kits/thread-rail/desktop.tsx#L44). Kein Tastatur-Laufzeittest. |
| [17:09](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1029s) | Snooze mit Zeitvorgaben, eigener Sektion und Wiederauftauchen | Implementiert | [kits/thread-rail/meta.ts:234](../../kits/thread-rail/meta.ts#L234), [kits/thread-rail/meta.ts:411](../../kits/thread-rail/meta.ts#L411), [kits/thread-rail/meta.ts:443](../../kits/thread-rail/meta.ts#L443). |
| [17:25](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1045s) | Threads mit ausstehender Frage sichtbar priorisieren | Implementiert | [src/workbench/thread-row-status.ts:9](../../src/workbench/thread-row-status.ts#L9), [kits/thread-rail/meta.ts:128](../../kits/thread-rail/meta.ts#L128). Ein Statusindikator ist belegt; visuelle Identität zu T3 nicht geprüft. |
| [17:43](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1063s), [18:18](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1098s) | Agent setzt täglichen Zeitplan; archivierter Thread läuft um 21 Uhr wieder | Teilweise | Zeitplaneditor, Cron und haltbare Jobs vorhanden, [kits/scheduling/planner.tsx:40](../../kits/scheduling/planner.tsx#L40), [kits/scheduling/host.ts:192](../../kits/scheduling/host.ts#L192). Tau-Automationen erzeugen gemäß CONTEXT einen neuen gewöhnlichen Thread pro Run. Derselbe archivierte Thread und ein entsprechendes Agententool zum Anlegen sind hier nicht nachgewiesen. |
| [18:02](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1082s) | Während eines Turns steuern oder Nachricht für später einreihen | Implementiert | [kits/prompt-tools/desktop.tsx:186](../../kits/prompt-tools/desktop.tsx#L186), [src/main/queued-messages.ts:1](../../src/main/queued-messages.ts#L1). Default und Hotkey zum Wechsel sind vorhanden. Backendfähigkeiten bleiben relevant. |
| [18:41](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1121s), [19:10](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1150s) | Optionaler Working-Bereich, fertige Threads zurück nach oben; Pins bleiben sichtbar | Implementiert | [kits/thread-rail/meta.ts:128](../../kits/thread-rail/meta.ts#L128), [kits/thread-rail/meta.ts:184](../../kits/thread-rail/meta.ts#L184). Standardmäßig ausgeschaltet, [kits/thread-rail/meta.ts:14](../../kits/thread-rail/meta.ts#L14). |
| [19:32](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1172s) | Cmd-Enter startet Thread im Hintergrund und lässt Platz für nächste Eingabe | Implementiert | [src/renderer/components/Composer.gate.test.tsx:137](../../src/renderer/components/Composer.gate.test.tsx#L137), [src/workbench/app-state.ts:215](../../src/workbench/app-state.ts#L215), [src/workbench/submission-controller.ts:523](../../src/workbench/submission-controller.ts#L523). Testdatei als Spezifikationsbeleg gelesen, nicht bestanden. |
| [20:19](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1219s) | Mehrere PRs an einen Thread binden und intern/extern öffnen | Implementiert | [kits/review/host.ts:55](../../kits/review/host.ts#L55), [kits/thread-rail/desktop.tsx:119](../../kits/thread-rail/desktop.tsx#L119). Exakte Cmd-Klick-Bedienung nicht separat verifiziert. |
| [20:34](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1234s), [20:53](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1253s) | Nach Merge automatisch settlen, global und pro Thread abschaltbar | Implementiert | [kits/thread-rail/meta.ts:396](../../kits/thread-rail/meta.ts#L396), [kits/thread-rail/meta.ts:419](../../kits/thread-rail/meta.ts#L419). Regel berücksichtigt Thread-Metadaten und PR-Zustand; kein echter Mergeversuch. |
| [21:02](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1262s) | Mobile Swipegesten für Archive und Snooze | Unbestätigt | Zustandsaktionen und mobile Oberflächen vorhanden; die zwei konkreten Gesten nicht bis zum Handler verfolgt. Daraus folgt keine bestätigte Gestenparität. |
| [24:30](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1470s) | Mehrfachauswahl und gemeinsames Snooze/Settle | Implementiert | [kits/thread-rail/organizer.tsx:519](../../kits/thread-rail/organizer.tsx#L519). Sammelaktionen vorhanden; konkretes Shift-Klick-Verhalten hier nicht separat nachgewiesen. |
| [24:39](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1479s) | Titel aller ausgewählten Threads neu erzeugen | Teilweise | Einzelaktion [kits/thread-rail/organizer.tsx:501](../../kits/thread-rail/organizer.tsx#L501). Das vollständige `bulkMenu` ab [kits/thread-rail/organizer.tsx:519](../../kits/thread-rail/organizer.tsx#L519) enthält Settle/Snooze, aber keine Titel-Neuerzeugung. |
| [24:47](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1487s) | Harness, Modell und Effort für Titel, Committexte und PR-Beschreibungen konfigurieren | Teilweise | Titel-Modellwahl [kits/thread-titles/desktop.tsx:11](../../kits/thread-titles/desktop.tsx#L11), Backend/Completion-Auswahl [kits/thread-titles/host.ts:105](../../kits/thread-titles/host.ts#L105). Keine einheitliche frei konfigurierbare Dreierwahl für alle drei Textarten belegt. |
| [24:55](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1495s) | Nach konfigurierbarer Inaktivität automatisch settlen | Implementiert | [kits/thread-rail/meta.ts:425](../../kits/thread-rail/meta.ts#L425), [kits/thread-rail/desktop.tsx:141](../../kits/thread-rail/desktop.tsx#L141). Identischer Default von drei Tagen nicht behauptet. |
| [25:19](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1519s) | Mehrere persistierte Entwürfe, oben erreichbar und löschbar | Implementiert | [src/workbench/draft-store.ts:1](../../src/workbench/draft-store.ts#L1), [kits/workspace/rail-drafts.test.tsx:1](../../kits/workspace/rail-drafts.test.tsx#L1). Kein ausgeführter Komponententest. |
| [25:32](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1532s) | Prompt samt Bildern stashen und in anderem Kontext wieder einsetzen | Teilweise | [kits/prompt-tools/desktop.tsx:149](../../kits/prompt-tools/desktop.tsx#L149), [kits/prompt-tools/stash.ts:58](../../kits/prompt-tools/stash.ts#L58), [kits/prompt-tools/stash.ts:91](../../kits/prompt-tools/stash.ts#L91). Tau-Stash ist projektgebunden. Bilder und Wiederherstellen sind implementiert; freies Wiederherstellen nach Wechsel in ein anderes Projekt ist damit nicht belegt. |

### Kontext, Darstellung, Usage und Personalisierung

| Video | Konkret besprochene Fähigkeit | Tau | Codebeleg und Grenze |
| --- | --- | --- | --- |
| [22:41](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1361s), [34:30](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=2070s) | Interaktives HTML mit JavaScript, Charts und Diagrammen im Chat | Implementiert | [kits/html-pages/host.ts:88](../../kits/html-pages/host.ts#L88), [kits/html-pages/tools.ts:54](../../kits/html-pages/tools.ts#L54). Tau-Sandbox mit eigener Netzpolitik; kein visueller Test durchgeführt. |
| [23:08](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1388s), [23:17](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1397s) | Usage nach Konten/Maschinen, auch von CLI-Arbeit außerhalb der App | Teilweise | [kits/usage/host.ts:241](../../kits/usage/host.ts#L241), [kits/usage/host.ts:337](../../kits/usage/host.ts#L337). Runtime-Logquellen werden gesammelt. OpenCode-2-Arbeit außerhalb Tau wird laut [docs/runtimes.md:59](../../docs/runtimes.md#L59) noch nicht aus dessen neuer Datenbank gelesen. |
| [23:25](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1405s) | Restlimits pro Konto, doppelte Konten zusammenführen | Teilweise | Limits und Accountreports [kits/usage/host.ts:337](../../kits/usage/host.ts#L337). Exakte Deduplizierung aller vom Video gemeinten Accountidentitäten nicht geprüft; Theo bezeichnet seinen Fix selbst als noch nicht im gezeigten Build. |
| [23:42](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1422s) | Bei Limit eine vorab geschriebene Nachricht zur Resetzeit senden | Teilweise | Persistiertes Resume nach bekanntem `resetsAt` implementiert, [src/main/thread-limits.ts:69](../../src/main/thread-limits.ts#L69), [src/main/thread-limits.ts:114](../../src/main/thread-limits.ts#L114). Fehlt Resetzeit, wird automatische Fortsetzung abgelehnt. Vorab verfasste Nachricht plus Queue/Reset im konkreten UI-Gesamtfluss nicht ausgeführt; kein pauschales Fehlen von Resume. |
| [23:57](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1437s) | Sehr schnelle Oberfläche, hundertfach weniger Daten als Codex, gut auf 3G/Flugzeug-WLAN | Unbestätigt | Kein reproduzierbarer Benchmark aus dem Video und kein Tau-Netz-/Latenzvergleich. Architektur ist kein Performancebeweis. |
| [25:03](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1503s) | Browserzugang ohne installierten Desktopclient über öffentliche Appadresse | Teilweise | Webworkbench und Headless-Host vorhanden, [src/main/headless.ts:1](../../src/main/headless.ts#L1). Kein gehosteter öffentlicher Tau-Webclient mit derselben Betriebszusage geprüft. |
| [27:18](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1638s), [27:35](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1655s) | Bestehenden Thread auf anderen Harness umschalten, Kontext und Gerät behalten | Teilweise | [kits/handoff/desktop.tsx:146](../../kits/handoff/desktop.tsx#L146) erzeugt einen neuen Thread. [kits/handoff/handoff.ts:15](../../kits/handoff/handoff.ts#L15) begrenzt Zusammenfassung auf ausgewählten sichtbaren Gesprächstext. ADR 0005 hält Backendowner unveränderlich. Gleichwertiger sichtbarer In-place-Wechsel mit identischer Session ist nicht implementiert; Geräteübernahme nach diesem Wechsel nicht live geprüft. |
| [28:40](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1720s) | Anderen Thread per Drag als Kontext anhängen | Implementiert | [kits/composer-context/desktop.tsx:448](../../kits/composer-context/desktop.tsx#L448), [kits/composer-context/host.ts:175](../../kits/composer-context/host.ts#L175). Tau erzeugt Kontext aus aktuellen Turns. Remote-Maschinenthreads sind im Picker ausgeschlossen, [kits/composer-context/desktop.tsx:220](../../kits/composer-context/desktop.tsx#L220). |
| [28:48](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1728s) | Aussagen im Chat oder Elemente im Browser zitieren/annotieren und mit nächstem Prompt senden | Implementiert | [kits/prompt-tools/desktop.tsx:167](../../kits/prompt-tools/desktop.tsx#L167), [kits/preview/desktop.tsx:151](../../kits/preview/desktop.tsx#L151), [kits/composer-context/desktop.tsx:353](../../kits/composer-context/desktop.tsx#L353). |
| [29:02](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1742s) | Themes, separate Light-/Dark-Themes, VS-Code-Import und eigener Themeeditor | Implementiert | [kits/appearance/page.tsx:101](../../kits/appearance/page.tsx#L101), [kits/appearance/page.tsx:137](../../kits/appearance/page.tsx#L137), [kits/appearance/vscode-import.ts:104](../../kits/appearance/vscode-import.ts#L104). Ein mitgeliefertes T3-Chat-Farbpreset ist damit nicht belegt. |
| [29:10](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1750s) | Chatbreite frei konfigurieren | Unbestätigt | In dieser Recherche kein konkreter persistierter Chatbreiten-Regler nachgewiesen. Stage-/Pane-Resize allein belegt ihn nicht. |
| [29:21](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1761s) | Eigene Keybindings | Implementiert | [kits/keybindings/desktop.tsx:88](../../kits/keybindings/desktop.tsx#L88). |
| [29:30](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1770s) | Einstellungen pro Projekt und Maschine, Überblick wo welcher Wert gilt | Teilweise | Person-Präferenzen aus ADR 0030, [src/shared/person-preferences.ts:1](../../src/shared/person-preferences.ts#L1); Runtimeeinstellungen mit Maschinen-/Projektscope [docs/runtimes.md:15](../../docs/runtimes.md#L15). Keine Prüfung, dass wirklich jede Settingsseite exakt dieselben Scopes und den gleichen Überblick bietet. |
| [35:27](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=2127s) | System-Snapshot mit Appinhalt und Accessibilitydaten per globalem Shortcut | Teilweise | [kits/snapshots/protocol.ts:14](../../kits/snapshots/protocol.ts#L14), [kits/snapshots/accessibility.ts:1](../../kits/snapshots/accessibility.ts#L1). Capture und Accessibility implementiert. Tau-Default ist Cmd/Ctrl-Shift-2; „beide Shift-Tasten“ ist kein identischer Trigger, [kits/snapshots/shortcut.ts:55](../../kits/snapshots/shortcut.ts#L55). Plattformberechtigungen nicht getestet. |
| [35:47](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=2147s) | Eigene Schriftarten | Implementiert | [kits/appearance/page.tsx:168](../../kits/appearance/page.tsx#L168), [kits/appearance/page.tsx:238](../../kits/appearance/page.tsx#L238). Keine gemessene „bessere als alle anderen“-Qualität. |
| [35:55](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=2155s) | App selbst anpassen ohne Fork | Implementiert | Tau hat bereits [kits/customize/host.ts:1](../../kits/customize/host.ts#L1) und ADR 0042. Im Video ist ein neues Customization-System erst angekündigt. Kein fehlendes T3-Releasefeature daraus ableiten. |

### Projekte, Git, Updates und Diagnose

| Video | Konkret besprochene Fähigkeit | Tau | Codebeleg und Grenze |
| --- | --- | --- | --- |
| [29:46](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1786s) | Worktree-Erzeugung und Speicherort konfigurieren | Implementiert | [kits/workspace/project-starts.ts:1](../../kits/workspace/project-starts.ts#L1), ADR 0017. Zentrales Verzeichnis ist Default, eigene Pfade bleiben möglich. |
| [29:54](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1794s) | Projektlos starten oder neues Projekt aus Name auf gewählter Maschine erstellen | Implementiert | [kits/environments/host.ts:149](../../kits/environments/host.ts#L149), [kits/workspace/project-starts.ts:1](../../kits/workspace/project-starts.ts#L1), [kits/workspace/add-project-menu.tsx:1](../../kits/workspace/add-project-menu.tsx#L1). |
| [30:00](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1800s) | Neues Projekt wahlweise automatisch mit GitHub synchronisieren | Unbestätigt | Neues Projekt und GitHubfunktionen sind vorhanden. Exakter Schalter plus dauerhafte Autosync-Semantik beim Erstellen nicht bis zur Implementierung nachgewiesen. |
| [30:22](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1822s) | Azure DevOps, GitLab, Bitbucket, Forgejo, GitCafe und GitHub | Teilweise | [kits/_git-hosts/hosts.ts:3](../../kits/_git-hosts/hosts.ts#L3), [kits/review/provider-registry.ts:60](../../kits/review/provider-registry.ts#L60). Fünf explizite Services; GitCafe fehlt als eigener Anbieter. Generische Forgejo-Kompatibilität beweist keine GitCafe-Unterstützung. |
| [30:29](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1829s) | Eingebaute PR-Beobachtung mit automatischer Fortsetzung bei Ereignissen | Implementiert | [kits/review/pr-watch-host.ts:304](../../kits/review/pr-watch-host.ts#L304). GitHub-spezifisch, beendet bei dokumentierten Stop-/Fehlerbedingungen. Die behauptete Reduktion auf ein Hundertstel der API-Abfragen ist für Tau nicht gemessen. |
| [30:54](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1854s) | Mehrere Verbindungsrouten zu derselben Maschine, etwa LAN/Tailscale/Connect | Unbestätigt | Mehrere Transportarten sind vorhanden, [docs/connect.md:7](../../docs/connect.md#L7). Der exakte Mehrfachrouten-/Failover-Ablauf für eine einzige Maschinenidentität wurde hier nicht vollständig geprüft. |
| [31:02](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1862s) | Granulare Berechtigungen für Remoteverbindungen | Implementiert | [docs/adr/0030-the-workbench-controls-every-machine.md:1](../../docs/adr/0030-the-workbench-controls-every-machine.md#L1), [src/main/machine-kit-route.ts:108](../../src/main/machine-kit-route.ts#L108). Pairing und Command-Autorität sind eigene Mechanismen; kein Penetrationstest. |
| [31:11](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1871s) | MCP-URL einer Maschine per Klick kopieren und anderswo steuern | Teilweise | Interner MCP-Endpunkt und externer OAuth-Lesezugang vorhanden, [src/main/mcp-endpoint.ts:101](../../src/main/mcp-endpoint.ts#L101), [src/main/external-mcp-read-tools.ts:15](../../src/main/external-mcp-read-tools.ts#L15). Gleichwertige allgemeine Steuer-URL nicht nachgewiesen; ADR 0045 begrenzt öffentliche HTTP-Funktionen. |
| [31:18](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1878s) | Webhooks lösen Arbeit aus, etwa GitHub-/Stripe-Ereignisse oder curl | Teilweise | Signierter Webhooklistener und Jobs vorhanden, [kits/scheduling/webhooks.ts:22](../../kits/scheduling/webhooks.ts#L22), [kits/scheduling/host.ts:46](../../kits/scheduling/host.ts#L46). Tau erwartet eigene signierte Deliveryheader. Native Stripe-/GitHub-Signaturkompatibilität ohne vorgeschalteten Adapter nicht belegt. |
| [31:27](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1887s) | Öffentlicher Relay-Webhook mit optional 24 Stunden Speichern/Wiederholen; eigene öffentliche URL | Fehlend | [kits/scheduling/webhooks.ts:22](../../kits/scheduling/webhooks.ts#L22) prüft Signatur und Frische, ist kein 24-Stunden-Store-and-forward-Dienst. ADR 0045 sagt ausdrücklich, dass Connect keine gewöhnlichen öffentlichen HTTP-Routen veröffentlicht. Selbstbetrieb mit eigenem Proxy ersetzt kein implementiertes verwaltetes Replayangebot. |
| [31:39](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1899s) | Projekticon automatisch aus Favicon; manuell wählen oder generieren | Teilweise | Automatisches/benutzerdefiniertes Iconmodell [kits/workspace/project-icons.ts:18](../../kits/workspace/project-icons.ts#L18), SVG-Iconerzeugung [kits/workspace/project-icons.ts:55](../../kits/workspace/project-icons.ts#L55). Identische Favicon-Suche und kompletter Generator-UI-Ablauf nicht geprüft. |
| [32:06](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1926s) | Mit einer Aktion App, Hosts und Runtimeprogramme mehrerer Maschinen aktualisieren | Implementiert | [kits/environments/update-plan.ts:28](../../kits/environments/update-plan.ts#L28), [kits/environments/update-plan.ts:140](../../kits/environments/update-plan.ts#L140). Updateplan, Toolupdates und Abschlussprüfung vorhanden; reale Neun-Maschinen-Aktion nicht durchgeführt. |
| [32:31](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1951s), [32:48](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1968s) | Lokalen Editor per Button mit Remoteprojekt über SSH öffnen | Teilweise | Lokales Öffnen [kits/workspace/host.ts:979](../../kits/workspace/host.ts#L979); generisches Routing auf Home Machine [kits/workspace/host.ts:204](../../kits/workspace/host.ts#L204). [kits/workspace/editors.ts:142](../../kits/workspace/editors.ts#L142) konstruiert Pfad-/Goto-Argumente, keine lokale `ssh-remote`-URI. Die vorhandene Funktion ist kein Nachweis des gezeigten lokalen VS-Code-SSH-Aufrufs. |
| [33:13](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1993s) | Projekt auf andere Maschine klonen/kopieren und dort Prompts starten | Implementiert | [kits/remote-work/host.ts:347](../../kits/remote-work/host.ts#L347), [kits/environments/bring-project.ts:1](../../kits/environments/bring-project.ts#L1). |
| [33:28](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=2008s) | Dabei .env und gewählte ignorierte Dateien mitnehmen | Implementiert | [kits/remote-work/host.ts:373](../../kits/remote-work/host.ts#L373), [kits/remote-work/host.ts:427](../../kits/remote-work/host.ts#L427). Auswahl wird bewusst übertragen; keine echte Geheimnisdatei kopiert. |
| [33:43](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=2023s), [36:04](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=2164s) | Eigenständiges Triage-CLI startet Claude/Codex mit Logs, hilft lokal und erstellt Issue | Fehlend | [bin/tau.mjs:25](../../bin/tau.mjs#L25) listet Tau-Befehle ohne Triage. Suche `triage|doctor` in `bin/` findet kein entsprechendes Kommando. Einzelne Diagnosemodule sind kein gleichwertiger Reparaturworkflow. Theos Erfolgsquote von über 80 % ist ungeprüfte Eigenangabe. |
| [36:36](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=2196s) | PRs nach Mergebereitschaft sortieren | Implementiert | [kits/review/pull-request-list-logic.ts:29](../../kits/review/pull-request-list-logic.ts#L29), [kits/review/pull-request-list-logic.ts:242](../../kits/review/pull-request-list-logic.ts#L242). Sortierung `ready` ist sogar Default. |

### Anhänge, PR-Ansicht und Auslieferungsgrenzen

| Video | Konkret besprochene Fähigkeit | Tau | Codebeleg und Grenze |
| --- | --- | --- | --- |
| [22:50](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=1370s), [35:02](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=2102s) | PRs in eigener Desktop-/Mobilansicht lesen, verwalten und mergen | Implementiert | [kits/review/pull-request-list-view.tsx:235](../../kits/review/pull-request-list-view.tsx#L235), [kits/review/provider-registry.ts:243](../../kits/review/provider-registry.ts#L243). Anbieterfähigkeiten sind unterschiedlich; hier kein echter Merge und keine mobile Abnahme. |
| [34:33](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=2073s) | Anhänge als echte lokale Bytes speichern, damit der Agent sie weiterverwenden kann | Implementiert | [kits/composer-context/host.ts:145](../../kits/composer-context/host.ts#L145) schreibt Attachmentbytes mit privatem Dateimodus. [src/main/prompt-attachments.ts:32](../../src/main/prompt-attachments.ts#L32) validiert Dateiverweise; ADR 0031 regelt Transfer zur Home Machine. |
| [34:33](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=2073s) | Gerade ein eingefügtes Bild zusätzlich zum visuellen Input als Datei verfügbar machen | Unbestätigt | Allgemeiner Attachment-Dateipfad ist belegt. Bilder haben daneben einen eigenen Datenpfad, [src/main/machine-prompt-attachments.ts:46](../../src/main/machine-prompt-attachments.ts#L46). Daraus allein folgt nicht, dass jeder Paste-/Imageinput auf jedem Backend zusätzlich als agentlesbare Bilddatei persistiert wird. |
| [35:02](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=2102s) | Bilder und Videos über Remoteverbindungen rendern | Implementiert | [src/renderer/components/AttachmentLightbox.tsx:152](../../src/renderer/components/AttachmentLightbox.tsx#L152), [kits/preview/headless-recorder.ts:1](../../kits/preview/headless-recorder.ts#L1), ADR 0031. Grenzen von Codecs und Dateigrößen bleiben; nicht jede Medienart getestet. |
| [35:10](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=2110s) | Aufzeichnungen/Bilder direkt in PR einbetten oder hochladen | Unbestätigt | Theo nennt ab 35:18 seinen eigenen Upload-Skill. Tau-Mediendarstellung beweist keinen Forgeupload. Ein entsprechender überall verfügbarer Tau-Upload-Skill und echte Uploadberechtigungen wurden nicht geprüft. |
| [35:18](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=2118s) | Benutzerdefinierte Tooldarstellung | Implementiert | [kits/codex/tool-presentation.tsx:1](../../kits/codex/tool-presentation.tsx#L1), [kits/claude-code/tool-presentation.tsx:1](../../kits/claude-code/tool-presentation.tsx#L1). „Custom rendering“ ist im Transkript unspezifisch; genaue visuelle Gleichheit bleibt offen. |
| [36:19](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=2179s) | iPhone Live Activities zur Agentbeobachtung | Implementiert | [mobile/plugins/tau-native/ios/Sources/TauNativePlugin/MobileActivity.swift:1](../../mobile/plugins/tau-native/ios/Sources/TauNativePlugin/MobileActivity.swift#L1), [mobile/ios/App/TauWidgets/LiveActivity.swift:1](../../mobile/ios/App/TauWidgets/LiveActivity.swift#L1). Pushtransportcode vorhanden; Signing, installierter Release und realer Sperrbildschirm hier nicht geprüft. |
| [36:51](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=2211s) | Nutzer stellt Compute selbst bereit | Implementiert | Headless- und Maschinenmodell, [src/main/headless.ts:1](../../src/main/headless.ts#L1). Kein Anspruch auf mitgelieferte Cloud-Compute-Kapazität. |
| [37:15](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=2235s) | Computer Use kommt vom Harness; eigenes T3-System erst angekündigt | Implementiert | Tau besitzt eigenes optionales Kit, [kits/computer-use/host.ts:83](../../kits/computer-use/host.ts#L83). Das Video nennt hier eine T3-Grenze, keine bereits gezeigte T3-Mehrfunktion. Keine Laufzeitprüfung von Tau Computer Use. |
| [39:53](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=2393s), [40:02](https://www.youtube.com/watch?v=uLGxb4F3SyI&t=2402s) | Stable und Nightly als getrennte Bezugsmöglichkeiten | Implementiert | [scripts/packaging/publish-release.mjs:1](../../scripts/packaging/publish-release.mjs#L1), [.github/workflows/release.yml:1](../../.github/workflows/release.yml#L1). Build-/Publishlogik vorhanden. Weder aktueller öffentlicher Releaseinhalt noch erfolgreicher Download geprüft. |

### Nicht als Produktparität gewertete Aussagen

03:18 bis 04:22 ist Apify-Sponsoring. Die konkrete Integrationsaussage ist, dass ein in Claude konfigurierter MCP-Server auch in T3 verfügbar ist. Tau übernimmt Claude-Einstellungen mit `settingSources`, [kits/claude-code/runtime-adapter.ts:219](../../kits/claude-code/runtime-adapter.ts#L219); ein echter Apify-Aufruf und alle beworbenen 90.000 Tools sind unbestätigt. Apifys Datenzugriff ist keine eingebaute T3-Funktion.

Nutzer-/Contributorzahlen, die Behauptung anderer Anbieter hätten die Sidebar kopiert, Überlegenheitsurteile über mobile Apps oder Schriftarten, Schlafmangel und Theos persönliche Arbeitsweise sind keine implementierbaren Paritätskriterien. Auch gleiche Tokenkosten pro identischem Lauf ab 38:28 sind hier nicht gemessen. Ein Modell, das Compaction erwähnt, ist kein Nachweis verlustfreier Kontextübernahme.

## Was die belegten Unterschiede bedeuten

**Runtimewechsel:** Das Video beschreibt ausdrücklich einen Wechsel im bestehenden sichtbaren Gespräch. Tau bietet einen neuen Thread mit Handoff-Zusammenfassung. Das ist eine bewusste Grenze aus ADR 0005, kein übersehener Pickerknopf. Für dieselbe Nutzererfahrung müsste entweder diese Entscheidung geändert oder eine zusätzliche sichtbare Gesprächsebene oberhalb der Runtime-Threads entworfen werden. Ein bloßes Umbenennen der Übergabe würde die Kontextgrenzen verdecken.

**Externes MCP:** Tau-intern können Agenten delegieren, Threads lesen und Nachrichten senden. Der externe HTTP/OAuth-Endpunkt ist eine andere Autoritätsgrenze. Seine drei Lesetools sind kein Beleg für die im Video gezeigte Fernsteuerung durch einen beliebigen Chatclient. ADR 0045 verlangt für Steuerung erst durchgesetzte Ausführungsgrenzen und dokumentiert noch offene Client-Kompatibilität.

**Remote-Editor:** Der vorhandene Editorlauncher gehört zur ausführenden Maschine. Das Video betont gerade einen lokalen Editorclient, der automatisch SSH zur fremden Maschine verwendet. Der bisher gelesene Tau-Pfad baut diese Verbindung nicht auf. Das ist unabhängig davon, dass Tau selbst Remote-Dateien und Terminals bedienen kann.

**Rate Limits und Devices:** Tau hat eine gespeicherte Wiederaufnahme zur bekannten Resetzeit und erhebliche Remote-Devicefunktionen. Die verbleibende Arbeit ist der konkrete End-to-End-Ablauf: Nachricht vor dem Reset einreihen, Host neu starten, genau einmal zustellen; sowie echte mobile H.264-/Input-/SSH-Gerätesitzungen. Dafür muss keine generische neue Geräteverwaltung behauptet werden.

**Auslieferung:** Windows-ARM64 fehlt in der Release-Matrix. Öffentlich betriebenes Connect ist laut Dokumentation zurückgestellt. Beides lässt sich nicht durch vorhandene plattformneutrale TypeScript-Dateien oder Relaytests als erledigt deklarieren.

## Validierung und offene Nachweise

Es wurden keine App und keine Simulatoren gestartet, keine Konten angemeldet, keine Dependencies installiert, keine Tests als bestanden gemeldet. Die parallele Prüfung des Auftraggebers hat versucht:

```sh
npm test -- kits/agents/delegation.test.ts kits/handoff/desktop-model-switch.test.tsx kits/environments/host.test.ts
```

Der Befehl scheiterte vor Runnerstart mit `Cannot find module 'vitest/package.json'`, weil Dependencies fehlen. Das ist ein blockierter Testlauf, kein fehlgeschlagener fachlicher Test und kein bestandener Nachweis. Die zitierten Testdateien wurden allenfalls als vorhandene Spezifikationen gelesen. Dieser Bericht selbst wurde nur auf vorhandene Linkziele und gültige Zeilennummern der Codebelege geprüft.

Für die Aussage „komplett und sauber“ fehlen damit zusätzlich zu den konkreten Produktunterschieden echte Nachweise für Multi-Harness-Delegation mit echten Konten, Auth/Revocation externer MCP-Clients, Limits mit vorab verfasster Nachricht und Neustart, Remote-Gerät mit H.264/Input auf einem Telefon, Updates mit unterbrochenen Turns und mobile Auslieferung. Die unbestätigten Tabellenzeilen sind gezielte Folgeprüfungen, keine bereits feststehenden Bugs.

## Umsetzung nach dem Audit

Der Audit oben beschreibt den Ausgangscommit. Im anschließenden Arbeitsstand
wurden die zuerst benannten vier Unterschiede bearbeitet:

- `bin/tau-triage.mjs` und der `tau triage`-Befehl sammeln private Diagnoseberichte
  und starten auf Wunsch Codex oder Claude Code.
- Windows ARM64 hat einen nativen Releasejob, einen eigenen signierten Updatefeed,
  ein portables Hostarchiv und einen festen Downloadnamen. Ein tatsächlicher
  Windows-Build bleibt eine CI-Prüfung.
- `kits/acp/` registriert Muse Code sowie manuelle ACP-Agents und Registryeinträge.
  npx/uvx und SHA-256-geprüfte Binärdistributionen sind vorhanden. Nicht unterstützte
  Archive können manuell installiert werden. Muse selbst bezeichnet ACP als
  experimentell; echte Konten und alle Registry-Agents wurden nicht geprüft.
- Core hält beim Runtimewechsel die Tau-Threadidentität und sichtbare Historie
  fest, während jedes Provider-Sessionformat unverändert bleibt. Pi verwendet
  eine eigene Sessiondatei. Der nächste Prompt erhält Gesprächskontext. Das neue
  Amendment in ADR 0005 nennt die Grenzen und Wiederaufnahmebedingungen.

Das ist keine nachträgliche Bestätigung aller 91 Auditpunkte. Insbesondere externes
MCP mit Schreibsteuerung, öffentlich betriebenes Connect, Webhook-Vermittlung und
Remote-Editor-SSH sind eigene verbleibende Arbeiten. Die ursprünglichen
Validierungsgrenzen des Audits gelten für seinen Ausgangsstand; der abschließende
Umsetzungsbericht nennt die danach tatsächlich ausgeführten Checks.

### Nachweise des anschließenden Arbeitsstands

Die Desktop- und Web-Builds, der abschließende Build aller 51 Kits sowie die
Typprüfungen für Host und Kits sind durchgelaufen. Gezielte Tests decken
Releasefeeds, Packaging, Triage, Registry-/Installationsprüfung, ACP-Prozesse,
Runtimewechsel, Lifecycle und Handoff ab. Der letzte Handoff-Lauf umfasst
17 bestandene Tests; ein vorheriger Fehler durch die neue Ereigniszuordnung
wurde im Lifecycle-Testaufbau korrigiert und mit den betroffenen Tests erneut
geprüft. Eine vollständige Testsuite wurde nicht ausgeführt.

In einer isolierten Linux-Tau-Instanz wurde die ACP-Einstellungsseite geöffnet.
Anschließend wechselte eine Unterhaltung über den neuen Switch-runtime-Knopf
zwischen zwei lokalen ACP-Testprozessen: dieselbe Tau-ID, zwei erhaltene
Nachrichten und zwei neue Nachrichten. Der Zielprozess erhielt den bisherigen
Text als Kontext, während die sichtbare Nutzernachricht unverändert blieb.
Nach vollständigem Fenster- und Hostneustart erschienen genau eine Unterhaltung
und alle vier Nachrichten; Zielruntime und verbrauchter Kontextübergang blieben
gespeichert. Es gab keine UI-Fehlermeldungen. Dafür wurden keine kostenpflichtigen
Modellaufrufe verwendet. Native Windows-Ausführung und echte Muse-Inferenz sind
weiterhin nicht nachgewiesen.

## Zweite Umsetzungsrunde

Stand 30. Oktober 2026. Ziel war alles, was ohne öffentlich betriebene Server
geht. Die Tabelle nennt den neuen Stand; die Auditzeilen oben bleiben der Befund
für den Ausgangscommit.

| Fähigkeit | Stand jetzt | Umsetzung |
|---|---|---|
| Threadsteuerung durch externe MCP-Clients | Lokal umgesetzt | [ADR 0046](../adr/0046-external-mcp-clients-control-their-own-threads.md). Loopback-Listener mit vom Besitzer ausgestellten Tokens unter Settings → Connections → MCP clients, dazu `tau mcp serve` für stdio-Clients. Werkzeuge `tau_start_thread`, `tau_send_message`, `tau_stop_thread`, `tau_thread_status` neben den Lesewerkzeugen. Ein Client steuert nur Threads, die er gestartet hat. Jede Runde läuft unter der Ausführungsobergrenze des Grants, auch nach Neustart und Neuladen der Access-Erweiterung. Der OAuth-Weg kann `tau:threads` jetzt ebenfalls erteilen. Grok/ChatGPT als gehostete Clients brauchen weiterhin eine öffentliche HTTPS-Adresse. |
| MCP-URL kopieren und anderswo steuern | Lokal umgesetzt | Adresse, Token und fertige Konfiguration für Claude Code, Codex, JSON und stdio zum Kopieren. |
| Webhooks von GitHub, Stripe oder curl | Umgesetzt | Native Signaturen `X-Hub-Signature-256` und `Stripe-Signature` sowie ein gemeinsames Geheimnis per Bearer; Wiederholungen werden über Delivery-ID und Body-Hash verworfen. Der Payload kann begrenzt und markiert in den Prompt. |
| Zeitplan führt bestehenden, auch archivierten Thread fort | Umgesetzt | Automationen können einen lokalen Thread fortsetzen. Agenten schlagen über `tau_schedule_thread` Zeitpläne vor; nur der Besitzer bestätigt. |
| Lokalen Editor per SSH mit Remoteprojekt öffnen | Umgesetzt | VS Code, Cursor, Windsurf, VSCodium und Zed über `--remote ssh-remote+…` bzw. `ssh://`; SSH-Ziel pro Maschine unter Settings → Machines. JetBrains bleibt mit Begründung deaktiviert. |
| Titel aller ausgewählten Threads neu erzeugen | Umgesetzt | Mehrfachauswahl → „Regenerate titles“. |
| Harness, Modell und Effort für Titel, Commits, PR-Texte | Umgesetzt | Ein Standard plus Überschreibung je Textart unter Extensions → Review. |
| Gestashten Prompt in anderem Projekt einsetzen | Umgesetzt | „From other projects“ im Stash-Menü, mit Bildern. |
| Chatbreite einstellen | Umgesetzt | Appearance → Chat width. |
| Nachricht bei Limit vorab schreiben, zur Resetzeit senden | Umgesetzt und in der App geprüft | Nach „Wait“ landet Enter in der Queue; ohne bekannte Resetzeit bietet „Retry later…“ feste Zeiten. |
| Usage von OpenCode-2-Arbeit außerhalb Tau | Bereits vorhanden | Die Dokumentation war veraltet und ist korrigiert; ein geänderter Datenbankaufbau wird jetzt mit Grund gemeldet. |
| Doppelte Konten zusammenführen | Vorhanden | Zusammenführung über Provider und Konto-ID. Ein Claude-Team-Platz über Pi und Claude Code erscheint weiter doppelt, nie falsch zusammengeführt. |
| Codex-Speed-Tier und Effort | Korrigiert | „Standard“ verlangsamt jetzt auch Modelle mit schnellem Standardtier; Effort „None“ ist benannt. |
| Eingefügtes Bild zusätzlich als Datei | Umgesetzt | Jedes Bild liegt zusätzlich im `prompt-images`-Ordner des Threads auf seiner Home Machine; der Agent erhält den Pfad. |
| Bilder und Videos in PRs einbetten | Umgesetzt als Agentenanleitung | `gh … --attach` ab gh 2.99, sonst Fallback; der lokale gh 2.46 kann es noch nicht. |
| Neues Projekt mit GitHub verbinden | Umgesetzt | Option beim Anlegen erstellt das Repository und setzt Upstream; Tau pusht nie selbstständig. |
| Mehrere Routen zu einer Maschine | Umgesetzt | Direkte Adressen zuerst, Connect als Ausweichroute, Rückkehr zur direkten Route; gleiche Maschine nur bei gleichem gepinntem Schlüssel. |
| Bestehende Threads beim Einstieg importieren | Erweitert | Zusätzlich Cursor und Grok, sobald deren CLI Sessions über ACP auflistet; sonst nennt der Assistent den Grund. Antigravity ist mangels Zugriff auf das eigene Gemini-Home nicht importierbar. |
| Linux-Arbeit mit iOS-Build auf einem Mac | Umgesetzt, nicht am echten Mac geprüft | Hosts melden Betriebssystem und Architektur; Settings → Machines zeigt „macOS arm64“, `tau_list_machines` nennt sie Agenten für `tau_spawn_thread`. Ein SSH-Gerätehost leitet Ports wie Metros 8081 per eigener `ssh -R`-Sitzung an den Mac weiter, und `device_sync_project` bzw. „Sync project“ kopiert die von Git gelisteten Dateien per tar über SSH. Ein Prune löscht nur, was die vorige Synchronisierung selbst gesendet hat. Der Hinweis nennt `npx expo run:ios --no-bundler --port 8081`. |
| Projekticon aus Favicon | Erweitert | Typische Ordner, `*.ico`, Apple-Touch-Icons und Webmanifest. |
| Mobile Wischgesten, Einstellungen pro Projekt/Maschine | Bereits vorhanden | Siehe Auditnachprüfung; eine einzelne Liste aller Überschreibungen fehlt. |

### Bewusst nicht umgesetzt

- Öffentlich betriebenes Connect, öffentliche Webhook-Vermittlung mit
  24-Stunden-Puffer und ein gehosteter Webclient brauchen eigene öffentliche
  Server.
- Ein globaler Doppel-Shift-Auslöser für Snapshots braucht einen nativen
  Tastaturhook mit macOS-Input-Monitoring und funktioniert unter Wayland nicht.
  Cmd/Ctrl-Shift-2 bleibt.
- GitCafe ist ein 2016 eingestellter Dienst und vermutlich ein
  Transkriptionsfehler. iPhone-Duo-Unterstützung, Omarchy-Bündelung,
  CLI-Proxy-Empfehlung und die Netzwerk-Performanceaussage sind keine
  überprüfbaren Produktfunktionen.

### Nachweise dieser Runde

Alle sieben Typprüfungen (Host, Renderer, Kits, Extensions, Pi-Extensions,
Beispiele, Relay) laufen fehlerfrei. 108 betroffene Testdateien mit 1669 Tests
bestehen, darunter Mobile. Die Mobile-Typprüfung scheitert wie zuvor nur an
nicht installierten Capacitor-Abhängigkeiten. Eine unabhängige Sicherheitsprüfung
fand keine kritischen Fehler. Ihre zwei bestätigten mittleren und sieben
weiteren Befunde sind behoben: `tau_start_thread` lief nur auf Pi, GitHub-Replay
über neue Delivery-IDs war möglich, und die Obergrenze eines fortgesetzten
Threads fiel nach der ersten Runde weg.

In einer isolierten Linux-Instanz mit lokalem Fake-Modell wurde Folgendes geprüft:

- MCP-Token in den Einstellungen erstellt, dann per HTTP initialisiert, Werkzeuge
  gelistet, Thread gestartet. Bei Workbench-Stufe „Full access“ wartete die
  Dateiänderung des Client-Threads auf Bestätigung durch den Besitzer.
- Nachricht nachgeschickt. Abgelehnt wurden Steuerung eines Besitzerthreads,
  fremder Origin (403), fremder Host (403) und falsches Token (401); der Listener
  bindet nur an 127.0.0.1.
- Nach Neustart gleicher Port und weiterhin „Ask“. Widerruf liefert sofort 401
  und beendet die wartende Runde.
- Rate Limit: „Wait“, Nachricht eingereiht, App vor dem Reset beendet und danach
  neu gestartet. Die Nachricht ging genau einmal.

Dabei gefunden und behoben: eine zu lange Kit-Beschreibung, die den Build brach,
und das Queue-Label „sends now“ während eines Limits. Der Zugriffschip im
Composer zeigte bei einem Client-Thread zunächst die Workbench-Stufe. Er liest
jetzt über `thread-narrowing` die Einschränkung des Threads und zeigt die
strengere Stufe, mit Hinweis im Tooltip.

Nicht in der App geprüft: echte Konten mit Claude Code, Codex und Muse,
Webhook-Zustellung per curl, Editorstart über SSH, Connect-Failover mit Relay,
Projektsync und Porttunnel gegen einen echten Mac sowie alles auf einem Mac oder
Telefon. Diese Teile sind nur durch Tests mit Fakes
abgedeckt.
