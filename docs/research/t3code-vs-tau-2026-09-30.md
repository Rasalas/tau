# T3 Code im Vergleich mit Tau

Stand: 30. September 2026. Zeitraum für neue Funktionen: 16. bis 30. September.
Tau wurde am lokalen Commit `82323e6a` untersucht. T3s neueste stabile Version ist
[0.0.44 vom 29. September](https://github.com/pingdotgg/t3code/releases/tag/v0.0.44).
Die umfangreichen Änderungen davor stehen in
[0.0.43](https://github.com/pingdotgg/t3code/releases/tag/v0.0.43).

Der Vergleich beruht auf Dokumentation, Quellcode und datierten GitHub-Merges.
Er ist kein Vergleich der Geschwindigkeit oder Stabilität im laufenden Betrieb.
Der Store-Rollout der neuesten mobilen Builds wurde nicht unabhängig geprüft.
T3s Multi-Modell-Start gilt für neue Git-Threads mit einer committeten Basis auf
Web/Desktop. Der mobile Geräte-PR meldet noch Probleme mit einzelnen
Touch-Gesten auf dem getesteten iOS-Simulator; die Integration ist damit
belegt, nicht die Fehlerfreiheit jeder Bedienung.
Ein Release-Datum belegt nicht, dass jede enthaltene Funktion erst an diesem Tag
entwickelt wurde. Besonders 0.0.42 vom 16. September enthält ältere Änderungen.

## Die belegten Unterschiede

| Bereich | Was T3 Code zusätzlich bietet | Tau heute |
|---|---|---|
| Geräte für mobile Entwicklung | Integriertes iOS-Simulator-/Android-Emulator-Panel mit Live-Bild, Touch-Eingaben, Agent-Werkzeugen, SSH-Gerätehosts und Einstellungen für Accessibility, Standort und Berechtigungen. [Geräte-Dokumentation](https://github.com/pingdotgg/t3code/blob/v0.0.44/docs/user/devices.md) | Preview und Computer Use sind vorhanden. Ein entsprechender Geräte-Hub samt Panel fehlt. Ein Simulator lässt sich über externe Werkzeuge bedienen; die Integration fehlt. |
| Ein Prompt an mehrere Modelle | Unterschiedliche Runtime-Provider und gemeinsame Anhänge werden in getrennten Worktrees gestartet. [Implementierung](https://github.com/pingdotgg/t3code/blob/v0.0.44/apps/web/src/components/ChatView.tsx#L7778) | `kits/thread-rail/desktop.tsx`, `claimNewThread`, unterstützt dies nur für Pi und nur ohne Anhänge. |
| Remote-Setup | T3 Connect stellt einen verwalteten Zugang ohne eigene Router-/Tunnel-Konfiguration bereit. Die Desktop-App installiert und startet Server über SSH. [Remote access](https://github.com/pingdotgg/t3code/blob/v0.0.44/docs/user/remote-access.md) | LAN, TLS, Tailscale, Pairing, Hintergrunddienst, SSH-Pairing und automatische Maschinenwahl sind vorhanden. Tau muss auf der Gegenstelle schon laufen. Kein eigener verwalteter Relay-Dienst. Siehe `docs/hosts.md`. |
| Mobile Funktionen | Eigene iPhone-Diktierfunktion mit lokaler Transkription, iOS Live Activities und Android-Karten für laufende Agentenarbeit. [Composer](https://github.com/pingdotgg/t3code/blob/v0.0.44/docs/user/composer.md), [Notifications](https://github.com/pingdotgg/t3code/blob/v0.0.44/docs/user/mobile-notifications.md) | iOS-/Android-App und Push sind vorhanden. Keine eigene Diktierfunktion oder Live-Activity-/Ongoing-Activity-Integration gefunden. `kits/push/` benötigt eigene APNs-/FCM-Schlüssel; T3 verwendet T3 Connect. Systemdiktat bleibt davon unabhängig. |
| Codex-Kontowechsel | Kompatible Konten können denselben Thread fortsetzen; CLI-Konten können Sessions über ein gemeinsames Home und getrennte Shadow-Homes teilen. [Codex](https://github.com/pingdotgg/t3code/blob/v0.0.44/docs/user/providers-codex.md) | Mehrere Instanzen und Konten vorhanden. Ein Thread bleibt an seine Instanz gebunden. Siehe `docs/runtimes.md` und `CONTEXT.md`. |
| Limit-Resets | Angesparte Codex- und Claude-Resets direkt anzeigen und einlösen. Claude ist auf macOS ausgenommen. [Usage](https://github.com/pingdotgg/t3code/blob/v0.0.44/docs/user/usage.md) | Limits werden angezeigt. `kits/codex/app-server.ts` schließt Reset-Credit-Details beim Lesen ausdrücklich aus; eine Einlösefunktion wurde nicht gefunden. Automatisches Fortsetzen nach einem regulären Reset ist in Tau vorhanden. |
| Codex Ultrafast | Der Service-Tier-Picker zeigt von Codex angebotene Tiers, einschließlich Ultrafast bei passenden Konten und Modellen. Nur CLI-Login, nicht der verwaltete ChatGPT-Login. [Fix in 0.0.44](https://github.com/pingdotgg/t3code/pull/14304) | `kits/service-tier/` bietet Standard/Fast für passende Pi-OpenAI-Modelle. Kein entsprechender Codex-Service-Tier-Picker gefunden. |
| GitHub-Zugriff über mehrere Hosts | Ein anderer verbundener Host kann bei entsprechender Freigabe PR-Lesezugriffe und Aktionen mit seiner GitHub-Anmeldung übernehmen. [Source control](https://github.com/pingdotgg/t3code/blob/v0.0.44/docs/user/source-control.md) | Die Review-Provider verwenden die Werkzeuge und Credentials ihres eigenen Hosts. Keine entsprechende Weiterleitung gefunden. |
| Windows/Linux | Explizite WSL-Umgebungen und SnapShots auch außerhalb von macOS. [Installation](https://github.com/pingdotgg/t3code/blob/v0.0.44/docs/user/install.md), [SnapShot](https://github.com/pingdotgg/t3code/blob/v0.0.44/docs/user/snap-shot.md) | Windows-Build vorhanden, aber reale Windows-Nutzung steht laut Roadmap aus. SnapShots ist laut `docs/CORE.md` derzeit macOS-only; keine integrierte WSL-Auswahl gefunden. |

## Was in den zwei Wochen tatsächlich neu dazu kam

Die Daten in dieser Tabelle sind Merge-Daten. Diese Änderungen sind in der
stabilen 0.0.43 beziehungsweise 0.0.44 enthalten.

| Datum | Änderung | Bedeutung gegenüber Tau |
|---|---|---|
| 17.09. | [Mehrere Modelle aus einem Prompt, getrennte Worktrees](https://github.com/pingdotgg/t3code/pull/12179) | Tau hat die Pi-/Text-Variante. Die Unterstützung anderer Runtimes und gemeinsamer Anhänge ist eine Lücke. |
| 19.09. | [Agent-Geräte auf dem Handy sehen und steuern](https://github.com/pingdotgg/t3code/pull/12531) | Neue Erweiterung des Geräte-Hubs, den Tau nicht integriert hat. |
| 21.09. | [Gerätewerkzeug-Versionen](https://github.com/pingdotgg/t3code/pull/12816), [Update-Fortschritt](https://github.com/pingdotgg/t3code/pull/12817), [manuelle Updates](https://github.com/pingdotgg/t3code/pull/12877) | Wartung und Updates lokaler sowie entfernter Gerätewerkzeuge direkt in der App. |
| 23.09. | [Umgebungs- und Provider-Updates mobil verwalten](https://github.com/pingdotgg/t3code/pull/13302) | Weitere mobile Verwaltungsfunktionen. Tau hat Runtime- und Host-Updatefunktionen; eine genaue Gleichheit dieser mobilen Oberflächen ist hier nicht belegt. |
| 24.09. | [Interaktiver 3D-Gerätebereich](https://github.com/pingdotgg/t3code/pull/12787) | Neu, aber nachrangig gegenüber der grundlegenden Geräteintegration. |
| 24.09. | [Claude-Resets anzeigen und einlösen](https://github.com/pingdotgg/t3code/pull/13118) | Konkrete neue Lücke; auf macOS deaktiviert. Codex-Resets waren schon vorher vorhanden. |
| 25.09. | [iPhone-Duo-Steuerung](https://github.com/pingdotgg/t3code/pull/12813), [Android-Foldables](https://github.com/pingdotgg/t3code/pull/13534) | Erweiterungen des Gerätebereichs. |
| 29.09. | [Verwalteter ChatGPT-Login für Codex](https://github.com/pingdotgg/t3code/pull/14290) | Tau hat dies am 30.09. ebenfalls implementiert, siehe Commit `4aa4815e` und `docs/runtimes.md`. Keine aktuelle Funktionslücke. |
| 29.09. | [Pro-Max-Konten und Ultrafast funktionieren](https://github.com/pingdotgg/t3code/pull/14304) | 0.0.44 ist im Wesentlichen dieser Fix. Der Ultrafast-Picker fehlt in Tau. |

T3 Connect, Diktat, Live Activities, WSL, der grundlegende Geräte-Hub und
GitHub-Weiterleitung sind allgemeine Unterschiede, keine Neuerungen dieses
Zeitraums. Die ergänzende Recherche dokumentiert ihre älteren Daten in
[t3code-last-two-weeks-2026-09-30.md](t3code-last-two-weeks-2026-09-30.md).

## Was bereits in beiden vorhanden ist

Cursor, Grok, Antigravity, Claude Code, Codex und OpenCode sind in Taus `kits/`
implementiert. Dazu kommen Worktrees, PR-Verknüpfungen und Stack-Aktionen,
Reviews mit Kommentaren und Viewed-Markierungen, Nutzung über mehrere Maschinen,
Kontolimits und eigene Modellpreise, Browser-Profile samt Cookie-Import,
Kontext-Chips, Zitate, Queue/Steer, Prompt-Stash, Snooze und Shell-Befehle aus
dem Composer. Belege: `docs/CORE.md`, `docs/runtimes.md`,
`docs/browser-cookie-import.md`, `kits/review/`, `kits/thread-rail/` und
`kits/usage/`. Diese Kategorien sollten nicht pauschal als fehlend bezeichnet
werden. Einzelne Abläufe und unterstützte Plattformen unterscheiden sich.

## Einschätzung für Tau

Der größte zusätzliche Arbeitsablauf ist mobile Entwicklung mit einem
integrierten Geräte-Hub. Danach folgen Multi-Modell-Starts über verschiedene
Runtimes samt Anhängen und einfacheres Remote-Setup. Ultrafast und Limit-Resets
sind kleinere, klar umrissene Verbesserungen. Die 3D-Darstellung ist für die
grundlegende Arbeit weniger wichtig.

Tau hat mit Pi, installierbaren und unabhängig nachladbaren Kits,
konfigurierbaren Sub-Agents samt Remote-Arbeit, lokalen Reviews und dem
Server-Deployment mit Drift-Erkennung und Rollback eigene Schwerpunkte.
Belege: `docs/EXTENSIONS.md`, `docs/agent-definitions.md`, `docs/hosts.md`,
`docs/servers.md` und `docs/CORE.md`. Daraus folgt keine gemessene Überlegenheit
bei Geschwindigkeit, Stabilität oder allgemeiner Bedienqualität.
