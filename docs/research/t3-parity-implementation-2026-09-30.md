# Umsetzung der untersuchten T3-Code-Unterschiede

Stand: 30. September 2026. Die Änderungen liegen auf `feat/workbench-parity`,
ausgehend von `82323e6a`, mit Main bis `b3c7cfa0` zusammengeführt.
Die acht Arbeitsbereiche wurden in eigenen Worktrees
umgesetzt und anschließend zusammengeführt. Der ursprüngliche Checkout bleibt
auf `feat/chatgpt-plan-sign-in`.

Der [Vergleich](t3code-vs-tau-2026-09-30.md) beschreibt den Ausgangsstand.
Diese Umsetzung beseitigt viele der dort gefundenen Unterschiede. Sie stellt
keine vollständige Gleichheit mit T3 Code her.

## Implementiert

| Bereich | Verhalten und Einstieg |
|---|---|
| Gemeinsamer Start | Die Mehrfachauswahl im Modellpicker kann unterschiedliche Runtimes mit demselben Prompt, Kontext und Anhängen starten. Jeder Start bekommt einen eigenen Worktree derselben committeten Basis. Fehlgeschlagene Ziele lassen sich einzeln erneut starten. |
| Gerätehub | Das optionale Devices-Kit verwaltet lokale und über SSH erreichbare iOS-Simulatoren und Android-Emulatoren. Es bietet Tabs, PNG-Livebilder, Eingaben, Plattformsteuerung, ein schwebendes Fenster und eine Perspektivansicht. Gerätesteuerung durch Agent-Werkzeuge braucht eine ausdrückliche Freigabe. Siehe [Devices](../../kits/devices/README.md). |
| Remote-Zugang | SSH installiert einen signierten portablen Host und verwaltet dessen Start und Tunnel. Tau Connect vermittelt ausgehende Verbindungen über einen eigenen Relay-Server. Desktop, iOS und Android prüfen weiterhin den angehefteten Host-Schlüssel; Hintergrund-Agents besitzen eigene Verbindungen. Siehe [Connect](../connect.md) und [Hosts](../hosts.md). |
| Mobile Funktionen | iOS 26 erhält lokale Diktierfunktion, Live Activities und Widgets. Android erhält laufende Aktivitätskarten und ein Widget. Push und Activity-Updates verwenden verschlüsselte Inhalte und versiegelte Zustellhandles. Siehe [Mobile](../../mobile/README.md) und [Push](../push.md). |
| Codex-Konten und Tiers | Kompatible CLI- und verwaltete Konten können denselben Thread fortsetzen, wenn beide ausdrücklich dasselbe Session-Home verwenden. Anmeldedaten bleiben getrennt. Der Tier-Picker folgt den vom Modell angebotenen Tiers; Ultrafast bleibt an CLI-Konten gebunden. Siehe [Runtimes](../runtimes.md). |
| Angesparte Resets | Usage zeigt Codex- und Claude-Reset-Credits und kann sie über den zuständigen Host einlösen. Dauerhafte Versuchsdaten und Idempotenz schützen vor doppeltem Verbrauch und veralteten Anzeigen. Claudes Plattformbeschränkung auf macOS bleibt bestehen. |
| GitHub über Hosts | Verbundene Hosts können GitHub-API-Zugriffe eines ausdrücklich freigegebenen Kontos übernehmen. Beide Seiten müssen zustimmen. Kontenidentität, Host-Schlüssel, Read-only-Grenzen und Zeitlimits werden geprüft. Siehe [GitHub-Freigabe](../agents/github-sharing.md). |
| Windows und Linux | WSL-Distributionen sind als Umgebungen auswählbar, inklusive portablem Host-Bootstrap. SnapShots unterstützt Windows und X11 sowie den Systemdialog für Fenster- oder Bildschirmaufnahmen unter Wayland. Siehe [Windows](../windows.md). |

Die Erweiterungs-API steht nach dem Main-Merge auf `1.35.0`. Transport und Maschinenidentität
liegen im Core; Gerätesteuerung, GitHub-Freigabe und weitere optionale Abläufe
bleiben in Kits. Der vorhandene Push-Relay-Zweig wurde wiederverwendet.

## Verifiziert

- Gesamttest nach dem Main-Merge: 988 Testdateien, 8.365 bestandene Tests,
  vier übersprungene Tests. Der korrigierte Codex-Host-Test besteht zusätzlich
  einzeln mit 42 Tests.
- Mobiler Testlauf mit `TAU_TEST_SLOW_RENDERS=30`: 18 Dateien, 117 bestandene Tests.
- Remote-Host-Smoke mit 81 Schritten, Erweiterungsinstallation und
  Remote-Arbeit inklusive Handoff und Widerruf bestanden.
- Separater Connect-Relay-Test bestanden; die Gesamttests prüfen auch eine reale
  lokale TLS-Relay-Verbindung mit Pairing, Reconnect und Live-Updates.
- Vollständiger Typecheck, mobiler Typecheck und Lint bestanden. Lint meldet
  weiterhin Warnungen, aber keine Fehler.
- Desktop-, Web-, Mobile- und Push-Relay-Build bestanden. Capacitor synchronisiert
  die fertigen mobilen Assets in beide nativen Projekte.
- Desktop-Budget bestanden, unverändert bei 500.000 gzip-Bytes JavaScript.
  Nach dem Main-Merge wurden 495.896 Bytes gemessen, davon 234.428 initial und
  261.468 nachgeladen.
  Der gesamte Build dauerte 21.207 ms. Auch das Web-Budget ist bestanden.
- Vor dem Main-Merge: iOS-Simulator-Build inklusive Widget-Erweiterung ohne
  Signierung bestanden.
  Android-Java-Kompilierung bestanden. Das sind keine signierten Store-Builds.
- Isolierte Tau-Instanz mit eigenen Daten und Runtime-Fixtures geprüft. Ein
  gemeinsamer Prompt startete Codex Luna und Cursor Composer 2 in zwei Worktrees
  mit identischem Ausgangscommit. Beide Antworten und die Threads nach einem
  Neustart wurden geprüft. Geräte-Tabs, Screenshot, Perspektivansicht,
  schwebendes Fenster, ausgeschaltete Agent-Freigabe und Connect-Einstellungen
  wurden ebenfalls geprüft. Die Instanzen sind beendet.

## Folge-MR und verbleibende Voraussetzungen

Connect enthält zunächst einen selbst betriebenen Dienst. Für externen Betrieb
braucht er einen veröffentlichten HTTPS-Endpunkt und signierte portable Releases.
Das vorhandene Firebase-Projekt `tau-push-e3c95` betreibt bereits das
Push-Message-Relay für APNs und FCM. Der Connect-Transport für dauerhafte
Chat-Verbindungen wurde für Cloud Run im selben Projekt vorbereitet, aber
wegen laufender Kosten ausdrücklich zurückgestellt. Die Vorbereitung bleibt
in [MR #4](https://github.com/Rasalas/tau/pull/4) auf `feat/cloud-connect`,
geschlossen ohne Merge. Sie wird nicht in den Folge-MR übernommen. Es wurden
keine Cloud-Ressourcen angelegt. Der bestehende Push-Deploy-Befehl aktiviert
keinen Connect-Dienst. Tailscale, SSH und direkte Verbindungen bleiben die
zunächst vorgesehenen Wege für Fernzugriff.
Browser-Connect nutzt einen separat und erst bei Bedarf geladenen
Rustls-WASM-Adapter für die zweite TLS-Verbindung mit Host-Pin. Die
[Adapter-Prüfung](browser-connect-tls-2026-09-30.md) dokumentiert Bibliotheken,
Sicherheitsgrenzen und echte TLS-/Pairing-/Reconnect-Tests. Ein öffentlicher
Relay und Tests auf allen Browser-Engines bleiben Betreiber- und Release-QA.


Der Folge-MR ergänzt die Perspektivansicht um zwei getrennte, scharnierbare
Foldable-Panels mit soliden Rückseiten. Die native Fold-Steuerung bleibt getrennt
von der Vorschau. Bestätigte Innen- und Cover-Aufnahmen werden passend aufgeteilt;
fehlende Cover-Geometrie wird nicht erfunden. H.264-Video läuft über WebCodecs,
mit ausdrücklichem PNG-Fallback bei fehlendem Decoder oder Stream. Die
Gerätewerkzeuge bleiben privat in getesteten Versionen installiert.

Wayland erhält Vordergrundfenster-Capture für GNOME, KDE, Hyprland und Niri.
Zusätzliche Helfer werden nur nach ausdrücklicher Installation verwendet; der
Portal-Systemdialog bleibt als Fallback verfügbar. Windows, WSL und Linux wurden
über Plattform-Fixtures und Linux-Transporttests geprüft. Reale Compositoren
bleiben Teil der Geräteprüfung.

Reale mobile Diktier-, Push- und Hintergrundabläufe brauchen die
[Geräteprüfung](../mobile-device-checklist.md). Der Folge-MR ergänzt verschlüsselte
iOS-Push-to-start-Nachrichten nach Opt-in. App und Widget benötigen getrennte
App-Store-Profile mit passenden App-Group- und Keychain-Rechten. Das zusätzliche
Release-Secret `IOS_WIDGET_PROFILE` fehlt derzeit. Unsigned Simulator-Builds
belegen die Kompilierung; physische APNs- und Hintergrundabläufe brauchen ein
signiertes Gerät. Der vorhandene Firebase-Push-Workflow wurde nach dem Merge
von MR #3 erfolgreich ausgeführt. Es wurden keine neuen Connect-Cloud-Ressourcen
angelegt, echten Geräte gestartet, Konten gewechselt oder Reset-Credits verbraucht.

Der abschließende Folge-Build misst 496.393 gzip-Bytes Desktop-JavaScript
bei unverändertem Limit von 500.000 Bytes. Der Desktop-Build dauert 15.467 ms;
auch das Web-Budget ist bestanden. Die Größenreserve beträgt 3.607 Bytes. Zusammengehörige Module
für Syntaxhervorhebung und Dialoge teilen nachgeladene Chunks, ohne zusätzliche
statische Imports im Einstieg. Die Größenlimits bleiben unverändert.

## Prüfung des Folge-MR

[MR #6](https://github.com/Rasalas/tau/pull/6) basiert auf dem gemergten
[MR #3](https://github.com/Rasalas/tau/pull/3). Gesamt-Typecheck und Lint sind
bestanden. 125 gezielte Geräte-/Push-/Release-Tests, 123 mobile Tests und
135 Browser-/Snapshot-/Packaging-Tests sind bestanden. Weitere Regressionstests
prüfen Geometrievariablen, Video-Abbruch und die gemeinsame Minifizierung.
Der Browser-Test verbindet den tatsächlichen WASM-Adapter mit dem realen
Host-Protokoll über einen CA-geprüften Relay, einschließlich Pairing,
Pin-Ablehnung, gespeichertem Token, Wiederverbindung und Routenbereinigung.

Der vollständige iOS-Simulator-Build einschließlich Widget sowie Androids
Java-Kompilierung sind ohne Release-Signierung bestanden. Die isolierte
Tau-Instanz verwendet ausschließlich eigene Daten und Geräte-Fixtures. Zwei
3D-Panels mit Vorder- und Rückseiten, das Vorschau-Scharnier, die native
Fold-Umschaltung mit bestätigter Cover-Aufnahme und der PNG-Fallback wurden
in der App geprüft. Physische Geräte und reale Linux-Compositoren bleiben
Teil der dokumentierten Release-Prüfung.
