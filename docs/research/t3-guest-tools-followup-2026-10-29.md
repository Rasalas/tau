# Gastfreigabe mit öffentlicher Toolprojektion, 29. Oktober 2026

Die Gastfreigabe überträgt jetzt gefilterte Toolnamen und Statuswerte. Sichtbare Textausgabe unterstützter Tools kommt erst nach explizitem Owner-Opt-in hinzu. Die HTTP-Gastseite benötigt eine bereits publizierte, vom Gast erreichbare HTTPS-Adresse mit browservertrauenswürdigem Zertifikat. Das vorhandene Tau-Connect-WebSocketrelay stellt diese HTTP-Seite nicht bereit.

Dieser Bericht aktualisiert die beiden entsprechenden offenen Punkte aus [t3-guest-sharing-2026-10-29.md](t3-guest-sharing-2026-10-29.md). Die übrigen Grenzen dieses Vorberichts gelten weiter. Neue Produktentscheidungen und eine Umgestaltung der Gastseite gehören nicht zu dieser Arbeit.

## Vorgaben und Arbeitsumfang

Gelesen wurden `AGENTS.md`, `CONTEXT.md`, `docs/agents/domain.md`, `kits/README.md`, die relevanten ADRs 0002, 0006, 0009, 0020, 0023, 0024, 0026 und 0037 sowie die beiden vorgegebenen Forschungsberichte. Abschnitt 6 von [t3-parity-next-ux-2026-10-29.md](t3-parity-next-ux-2026-10-29.md) bleibt die UX-Vorgabe. Seine Aussage, eine reine Tau-Connect-Einrichtung genüge für die HTTP-Gastseite, wird hier anhand des vorhandenen Transports korrigiert.

Ich habe selbst gearbeitet und keine Unteragenten gestartet. Bestehende uncommittete Vorarbeiten wurden erhalten. Es liefen keine Tests, Typechecks, Builds, Installationen, Lints, Appstarts oder Browserprüfungen. Es gibt keine Commits oder Pushes. Die unten genannten Regressionen sind geschrieben und im Source durchgesehen, aber nicht ausgeführt.

## Öffentlicher Sichtbarkeitsvertrag

`HostThread.publicTools(options)` ist ein optionaler, typisierter In-process-Anschluss. Der aktuelle gemeinsame HostThread-Erzeuger liefert ihn für die von Tau gehaltenen Runtimes. Der Vertrag besteht aus:

```ts
interface HostPublicToolOptions { includeOutput: boolean }
interface HostPublicTool {
  name: string;
  status: "running" | "done" | "error";
  output?: string;
  outputTruncated?: true;
}
interface HostPublicTools {
  tools: HostPublicTool[];
  truncated: boolean;
}
```

Die Generierung liegt in `ThreadProjection.publicTools()` und `public-thread-tools.ts`. Pi verwendet die bestehende serverseitige Ableitung der Workbench-Toolaktivität aus dem aktuellen Branch. Andere Runtimes verwenden ihre kanonische `adapterActivity`. Bei laufenden Tools ersetzt der aktuelle Wert aus `thread.tools` den historischen Preview. Damit ändern sich Name und Status auch während des Gast-Pollings. Es gibt keine neue Runtime-spezifische Sessioninterpretation in der Sharing-Extension und keinen Rohsessionexport.

Bei Pi gilt dabei der Name des ursprünglichen Toolcalls. Ein `toolName` im Resultat darf einen privaten oder unbekannten Call nicht nachträglich zu `bash` oder `read` umbenennen. Auch ein Live-Preview wird nur bei übereinstimmendem Toolnamen übernommen.

Die öffentliche Liste enthält ausschließlich die oben genannten Felder. Sie enthält keine Tool-/Turn-/Entry-IDs, Argumente, Commands, Input-Credentials, Zeitstempel, Extras, Mediendaten, Deferred-Handles, internen Fehlerobjekte, Systemnachrichten oder Reasoning. Die Gastansicht erhält keine Sessionobjekte, Dateirouten, Toolaufrufrechte oder Möglichkeit, vollständige Toolantworten nachzuladen. Bestehende User-/Assistant-Nachrichten bleiben bei der bisherigen allowlisteten `{ role, text }`-Projektion.

Toolnamen müssen mit einem ASCII-Buchstaben beginnen, danach sind Buchstaben, Zahlen, `_`, `.`, `-` erlaubt, insgesamt höchstens 128 Zeichen. Namen mit `secret`, `credential`, `password`, `token` oder `auth` entfallen vollständig und ohne Ausgabemetadaten. Diese konservative Prüfung erfasst insbesondere `request_secret`, `request_secret_file`, `release_secret_file`, deren MCP-Präfixe und Punkt-Aliase. Private Secret-Tools werden auch bei eingeschaltetem Output nicht angezeigt.

Textausgabe ist ausschließlich für diese bestehenden Texttools freigegeben:

`bash`, `Bash`, `read`, `Read`, `grep`, `Grep`, `find`, `ls`, `Glob`.

Die Prüfung beruht auf deren vorhandenen Übersetzern und Toolkarten. Auch bei diesen Namen gibt es keine Ausgabe für Subagent-Aktivität, Runs mit Extras oder Medien und als deferred gekennzeichnete Ausgabe. Unbekannte oder andere Tools liefern höchstens Name und Status. Insbesondere werden Computer-Use-Rohantworten, MCP-/App-Antworten, Edit-/Write-Diffs, reichhaltige Resultate und Delegationsantworten nicht als Textausgabe exportiert. Eine neue Toolart braucht eine bewusste Erweiterung der serverseitigen Texttool-Liste nach Prüfung ihrer Übersetzung und Darstellung. Das Owner-Opt-in umgeht diese Liste nicht.

`sanitizePublicToolOutput()` gehört zum kleinen öffentlichen Vertrag und verwendet dieselbe Texttool-Liste an den Cache- und HTTP-Grenzen. Die Bereinigung entfernt ANSI-/OSC-Steuersequenzen, sonstige Kontrollzeichen und Bidi-Steuerzeichen. Sie ersetzt erkennbare Credential-Zeilen, Bearerwerte, Tau-Gast-/Gerätetokens, übliche API-/GitHub-/AWS-Schlüssel, Credential-URLs und bestimmte Credential-Querystrings durch `[REDACTED]`. Ausgabe mit Private-Key-Markierungen wird vollständig ersetzt. Bei langen Ausgaben wird vor der Bereinigung begrenzt und die angeschnittene erste Zeile entfernt. So verliert eine angeschnittene Credential-Zeile nicht nur ihren erkennbaren Präfix.

Das ist keine allgemeine Geheimniserkennung. Ein beliebiger, unbeschrifteter Wert, den ein Shellbefehl oder ein Dateilesetool als sichtbaren Text ausgibt, kann weiterhin sensibel sein. Dasselbe gilt für Informationen, die der Agent bereits in einer normalen Antwort wiederholt hat. Die vorgegebene Nutzerwarnung bleibt deshalb unverändert:

> The guest sees this thread's messages and the agent's replies as they stream, and anything the agent read or printed in them. Share only what you'd show.

## Opt-in, Cache und Lebensdauer

- `Allow guest links` bleibt standardmäßig aus. Auch `showToolOutput` ist standardmäßig `false` und wird nur durch den lokalen Owner bei Erstellung eines konkreten Grants auf `true` gesetzt. Nichtboolesche Eingaben lehnt der Owner-Befehl ab.
- Der Managementzustand nennt unter `toolOutputThreads` die offenen Threads, deren HostThread den öffentlichen Anschluss anbietet. Die vorhandene Checkbox ist nur für den ausgewählten unterstützten Thread und bei verfügbarer Route aktiviert. Ein älterer Host ohne diese Angabe lässt sie deaktiviert. Der Server prüft die Methode unabhängig davon erneut und lehnt ein erzwungenes Opt-in ohne Methode ab.
- Der Gast kann das Opt-in weder im Request noch über eine Query ändern. Jeder Read nimmt es aus dem autorisierten Grant. Es wird bereits bei `publicTools()` angewendet, danach erneut bei der Gastprojektion, beim Speichern und beim HTTP-Response. Bei ausgeschaltetem Output fehlen sowohl `output` als auch `outputTruncated`.
- Der persistente Snapshot enthält nur öffentliche Nachrichten und öffentliche Tools. Cache-Lesen, Cache-Schreiben und das Lesen der Outputfreigabe verlangen jetzt zwingend die genaue Grant-ID und den passenden Thread. Ein alter asynchroner Read kann keine Projektion in den Ersatzlink schreiben. Ein Ersatzlink übernimmt das Opt-in nicht automatisch.
- Neustart erhält den optierten öffentlichen Snapshot und den Claim. Ein geschlossener Runtime-Thread wird für Gastreads nicht gestartet; der Gast erhält den letzten gespeicherten Snapshot. Alte Version-1-Datensätze ohne Opt-in-Feld und ohne Toolliste werden als Output-off mit leerer Toolliste gelesen. Ungültige oder zu große Tool-Snapshots werden abgewiesen.
- Widerruf, Stop, Archiv-/Trash-Ereignisse, `beforeRemove`, endgültiges Löschen und Linkersatz entfernen denselben Grant samt Toolcache. Ausschalten pausiert den Zugriff. Ein noch gültiger Grant kann beim Einschalten wieder verwendet werden. Nach allen asynchronen Reads prüft die HTTP-Route erneut Autorisierung und Threadzulässigkeit. Das schließt die Toolprojektion ein.
- Das Ende einer Extension-Aktivierung schließt den Store und nimmt die Route zurück. Ein erneuter Start liest ausschließlich die gespeicherte öffentliche Projektion. Schon empfangener Inhalt lässt sich durch Widerruf nicht zurückholen. Die im Vorbericht beschriebene Grenze bei fehlgeschlagener persistenter Widerrufsschreibung bleibt bestehen.

Die Gastseite zeigt die zusätzlichen Toolzeilen mit denselben inerten DOM-Bausteinen wie Nachrichtentext. Name, Status und optionaler Output werden ausschließlich mit `textContent` gesetzt. Die Toolliste folgt auf die Nachrichten und behält die Reihenfolge der kanonischen Aktivität; sie hat keine internen Anchor-IDs und keine Zuordnung zu einzelnen Nachrichten. HTML, Links, Bilder, Skripte oder Dateiverknüpfungen aus Tooloutput werden nicht ausgeführt oder geladen. Es gibt keine neue Seite, Styles oder zusätzliche Aktionsmöglichkeit.

## Grenzen

Die bestehenden Grenzen gelten auch für Tools. Es bleiben höchstens 20 Grants und 500 öffentliche Zeilen je Snapshot, wobei Nachrichten und Tools gemeinsam zählen. Toolnamen sind auf 128 Zeichen, einzelne Nachrichten und Toolausgaben auf 32.000 UTF-16-Zeichen begrenzt. Nachrichtentext, Toolnamen und Toolausgabe teilen sich insgesamt 200.000 Zeichen. Nachrichten erhalten zuerst ihr bisheriges Budget, Tools das verbleibende Budget. Überschreitungen setzen `truncated`; eine gekürzte exportierte Toolausgabe setzt zusätzlich `outputTruncated`.

Die serverseitige Toolprojektion ist schon vor dem Grant auf 500 Tools und insgesamt 200.000 Zeichen begrenzt. Es gibt keine Volltext-/Datei-Nachladefunktion für Gäste. Die HTTP-Request-, Parallelitäts-, Claim-, Grant- und Vorschlagslimits sowie No-store, CSP, Origin-Prüfung, getrennte Credentials und die anschließende Moderation bleiben auf demselben Pfad wirksam.

## Faktenkorrektur zur Erreichbarkeit

Der neue gemeinsame Produkttext in Hostfehler, Dialog und Connections-Hinweis lautet:

> Guests need a published HTTPS address their browser trusts, such as Tailscale HTTPS under Connections. Tau Connect's WebSocket relay does not serve guest pages. The guest must be able to reach that HTTPS address.

Das ist durch den vorhandenen Code belegt:

- [`kits/tailscale/host.ts`](../../kits/tailscale/host.ts) richtet nach ausdrücklicher Einrichtung die bestehende Serve-Weiterleitung ein, hält den Proxy und veröffentlicht den Endpoint als `Tailscale HTTPS` mit `trustedCertificate: true`.
- [`src/main/connect-tunnel.ts`](../../src/main/connect-tunnel.ts) verbindet Tau Connect über `wss:` und dessen `host`-/`client`-/`data`-Routen. [`connect-relay/service.mjs`](../../connect-relay/service.mjs) bietet Management-HTTP und WebSocket-Upgrades, aber keine Weiterleitung der Gast-HTML-/Script-/API-Routen als allgemeine HTTPS-Seite.
- `thread-sharing/host.ts` akzeptiert schon vorhandene publizierte HTTPS-Netzwerkendpunkte mit vertrauenswürdigem Zertifikat. Die Extension registriert ausschließlich ihre Route auf vorhandenen Listenern. Sie richtet weder Serve noch neue Listener, Zertifikate oder ein Relay ein.

Tailscale HTTPS bedeutet hier nicht automatisch öffentliche Erreichbarkeit für jeden Browser. Der Gast braucht auch Netzwerkzugriff auf diese Adresse. Diese Voraussetzung steht nun ausdrücklich im Produkttext. Eine selbstsignierte LAN-Adresse oder die Relay-Adresse von Tau Connect allein genügt nicht. Es wurde keine neue Relay-Infrastruktur entworfen oder implementiert.

## Geschriebene Regressionen

| Datei | Neue Abdeckung, noch nicht ausgeführt |
| --- | --- |
| `src/main/public-thread-tools.test.ts` | Öffentlicher Vertrag, fehlendes Opt-in, private Secret-Tools samt Aliasen, unbekannte/verborgene Antworten, Diffs, Deferred, Medien, Extras, Subagenten, Credential-/Steuerzeichenbereinigung, Private Keys und Budgets. |
| `src/main/thread-projection.test.ts` | Generierung aus echtem Pi-Branch und kanonischer Adapteraktivität, laufender Preview, Status, keine privaten Resultate oder Argumente. |
| `kits/thread-sharing/projection.test.ts` | Gemeinsames Nachrichten-/Toolbudget, Zeilenlimit, öffentliche Feld-Allowlist, Output-off, erneute Ablehnung verborgener Toolantworten und inertes DOM. |
| `kits/thread-sharing/store.test.ts` | Output-off auf Disk, grantgebundenes Opt-in, öffentlicher Toolcache nach Neustart, Pause, Ersatzlink ohne geerbtes Opt-in, alter Cachewriter, Widerruf, Migration alter Snapshots und zu große gespeicherte Toolausgabe. |
| `kits/thread-sharing/http.test.ts` | Echte isolierte HTTP-Requests mit Namen/Status, explizitem Output, fremdem Thread, Statuswechsel, Snapshot nach Runtime-Schließen/Neustart, Pause und Widerruf; Revoke/Pause/Replacement/Expiry während Toolread; Response-Allowlist und Größenlimit. |
| `kits/thread-sharing/host.test.ts` | Ownerpfad zur kanonischen Projektion, Cache nach Eviction, Stop, Archiv, Trash, Core-Removal und endgültiges Löschen mit Tooloutput; fehlende Projektion; korrekter HTTPS-Hinweis. |
| `kits/thread-sharing/desktop.test.tsx` | Checkbox standardmäßig aus, explizite Wahl, deaktiviert ohne passenden Serveranschluss, korrigierter Erreichbarkeitstext. |

Die bestehenden Tests des ersten Sharing-Pakets bleiben erhalten. Die Integrationsprüfungen führt der Parent gemäß den lokalen Check-Slots aus. Dieser Bericht behauptet keine erfolgreichen Testergebnisse.

## Dateien und Integration durch den Parent

Geändert unter `kits/thread-sharing/`: `protocol.ts`, `projection.ts`, `store.ts`, `host.ts`, `http.ts`, `page.ts`, `desktop.tsx` und die fünf oben genannten Sharing-Testdateien. `styles.css` und das Manifest wurden nicht geändert.

Die gemeinsamen Anschlüsse sind additiv:

- Neu `src/main/public-thread-tools.ts` und dessen Test.
- `src/main/host-extensions.ts` bekommt ausschließlich die optionale `HostThread.publicTools()`-Signatur.
- `src/main/host-extension-api.ts` exportiert die drei Vertragstypen und die kleine Sanitizer-Funktion.
- `src/main/thread-projection.ts` erzeugt die öffentliche Projektion aus den bestehenden kanonischen Aktivitäten. Der zugehörige Test wurde ergänzt.
- In `src/main/pi-host.ts` ergänzt genau eine Zeile am tatsächlichen gemeinsamen HostThread-Erzeuger die Methode. Sonstige dort schon vorhandene Änderungen sind Vorarbeiten und wurden erhalten.

Außerdem neu ist dieser Bericht. Keine Änderungen an `kits/workspace/`, `kits/search/`, Thread Rail, API-Versiondateien, Architektur-/Lifecycle-ADRs oder der globalen Lifecycleliste durch diese Arbeit.

Beim Parent verbleiben die gemeinsame API-Dokumentation und Versionierung, Architektur-/Lifecycle-ADRs, die globale Lifecycleliste und die Ausführung der kombinierten Prüfungen. Für diesen Zusatz sind insbesondere die beiden neuen/ergänzten Core-Projektionstests und alle fünf Sharing-Testdateien einzubeziehen. Die neuen Host-API-Exporte müssen vor einer Auslieferung mit der API-Linie der Gesamtintegration übereinstimmen; dieses Paket hat keine eigene konkurrierende Versionsnummer vergeben.
