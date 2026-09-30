# Umsetzung der untersuchten T3-Code-Unterschiede

Stand: 30. September 2026. Die Änderungen liegen auf `feat/workbench-parity`,
ausgehend von `82323e6a`. Die acht Arbeitsbereiche wurden in eigenen Worktrees
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

Die Erweiterungs-API ist auf `1.33.0` angehoben. Transport und Maschinenidentität
liegen im Core; Gerätesteuerung, GitHub-Freigabe und weitere optionale Abläufe
bleiben in Kits. Der vorhandene Push-Relay-Zweig wurde wiederverwendet.

## Verifiziert

- Gesamttest: 979 Testdateien, 8.228 bestandene Tests, vier übersprungene Tests.
- Mobiler Testlauf mit `TAU_TEST_SLOW_RENDERS=30`: 18 Dateien, 115 bestandene Tests.
- Separater Connect-Relay-Test bestanden; die Gesamttests prüfen auch eine reale
  lokale TLS-Relay-Verbindung mit Pairing, Reconnect und Live-Updates.
- Vollständiger Typecheck, mobiler Typecheck und Lint bestanden. Lint meldet
  weiterhin Warnungen, aber keine Fehler.
- Desktop-, Web-, Mobile- und Push-Relay-Build bestanden. Capacitor synchronisiert
  die fertigen mobilen Assets in beide nativen Projekte.
- Desktop-Budget bestanden, unverändert bei 500.000 gzip-Bytes JavaScript.
  Gemessen wurden 499.837 Bytes, davon 233.827 initial und 266.010 nachgeladen.
  Der gesamte Build dauerte 15.179 ms. Auch das Web-Budget ist bestanden.
- iOS-Simulator-Build inklusive Widget-Erweiterung ohne Signierung bestanden.
  Android-Java-Kompilierung bestanden. Das sind keine signierten Store-Builds.
- Isolierte Tau-Instanz mit eigenen Daten und Runtime-Fixtures geprüft. Ein
  gemeinsamer Prompt startete Codex Luna und Cursor Composer 2 in zwei Worktrees
  mit identischem Ausgangscommit. Beide Antworten und die Threads nach einem
  Neustart wurden geprüft. Geräte-Tabs, Screenshot, Perspektivansicht,
  schwebendes Fenster, ausgeschaltete Agent-Freigabe und Connect-Einstellungen
  wurden ebenfalls geprüft. Die Instanzen sind beendet.

## Verbleibende Unterschiede und Voraussetzungen

Connect ist ein selbst betriebener Dienst. DNS, HTTPS, Server und die
Veröffentlichung der signierten portablen Releases sind für einen externen
Betrieb erforderlich. Es gibt keinen bereits bereitgestellten Konto- oder
Relay-Dienst. Browser-Connect ist noch nicht unterstützt; die Plattform stellt
die benötigte zweite TLS-Verbindung mit Host-Pin nicht direkt bereit.

Die 3D-Geräteansicht zeigt einen Screenshot in Perspektive. Sie bildet keine
mehrteilige Foldable-Geometrie ab und streamt kein H.264-Video. Die native
Orientierungs- und Fold-Steuerung ist implementiert. Gerätewerkzeuge werden
privat in getesteten Versionen installiert; eine Versionsprüfung meldet neuere
Pakete, ohne sie automatisch als kompatibel zu übernehmen.

Wayland nutzt den Systemdialog. Eine automatische Auswahl des Vordergrundfensters
für einzelne Compositoren ist noch nicht implementiert. Windows, WSL und Linux
wurden über Plattform-Fixtures geprüft, nicht auf realen Systemen.

Reale mobile Diktier-, Push- und Hintergrundabläufe brauchen die
[Geräteprüfung](../mobile-device-checklist.md). Live Activities starten im
Vordergrund; Push-to-start ist nicht enthalten. Der aktualisierte Push-Relay
und passende App-Group-/Keychain-Signierungsprofile müssen veröffentlicht
werden. Es wurden keine echten Geräte gestartet, Konten gewechselt,
Reset-Credits verbraucht oder Dienste veröffentlicht.

Die Desktop-Größenreserve beträgt nur 163 gzip-Bytes. Weitere UI-Erweiterungen
können das Budget erneut überschreiten.
