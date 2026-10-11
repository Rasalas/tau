# Antigravity-Quota auslesen: CodexBar, T3 Code und das Bannrisiko

Recherchiert am 11. Oktober 2026 für `.scratch/t3-weekly-2026-10-11/issues/W18-antigravity-quota-research.md`. Frage: Wie lesen CodexBar und vergleichbare Tools die Limits eines Antigravity-/Gemini-Abos, und welcher Weg riskiert bei Google am wenigsten einen Bann? Geprüft wurden der Quellcode (CodexBar `7c08c0a`, T3 Code `716357cbba`, ccusage, AntigravityQuota), Googles Dokumentation und Nutzungsbedingungen sowie das Google-AI-Developers-Forum. Es ging keine Anfrage mit einem echten Token an Google, und kein fremder Code wurde ausgeführt.

## Kurzfassung

- Es gibt **keine dokumentierte Google-API** für Antigravity-Quota. Jedes Tool nutzt entweder eine interne Schnittstelle oder die Ausgabe von Googles eigenem Programm.
- Drei Wege sind im Umlauf: (1) Refresh-Token plus `cloudcode-pa.googleapis.com` (T3 Code, CodexBars OAuth-Pfad), (2) der lokale Server des laufenden Antigravity-Programms oder von `agy` (CodexBar, AntigravityQuota), (3) `agy -p "/usage"`, das Googles eigenes CLI ausführt (CodexBar als Rückfall, im Changelog von Google dokumentiert).
- Googles Bedingungen verbieten, „third party software, tools, or services“ für den Zugriff auf den Dienst zu nutzen. Dokumentierte Bannfälle betreffen **Inferenz** über fremde Programme mit Antigravity-OAuth. Für reines Quota-Lesen habe ich keinen Bannbericht gefunden. Das ist ein fehlender Beleg, keine Entwarnung.
- Der Weg ohne Credential-Zugriff durch Tau existiert: `agy -p "/usage"` mit dem unveränderten Binary. Er ist nicht von Google als erlaubt bestätigt.

## Wie die Tools lesen

| Tool | Quelle | Endpunkt | Credential | Von Google dokumentiert |
|---|---|---|---|---|
| T3 Code (#17530) | Datei, Refresh-Token, HTTPS | `oauth2.googleapis.com/token`, dann `POST …cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`, Rückfall `:fetchAvailableModels` | liest `antigravity-acp/acp_token.json` im Profil des Agenten (`client_id`, `client_secret`, `refresh_token`, `project_id`), Access-Token nur im Speicher | nein |
| CodexBar, Quelle 1 und 3 | lokaler Server des Antigravity-Programms oder der IDE-Erweiterung | `GetUserStatus`, `RetrieveUserQuotaSummary` auf localhost | keins, nur das CSRF-Token des Prozesses | nein |
| CodexBar, Quelle 2 | lokaler HTTPS-Server von `agy`; ab `agy` 1.2.2 mit CSRF-Pflicht, dann Rückfall `agy -p /usage --output-format json` | wie oben, oder CLI-Ausgabe | keins, `agy` hält seinen Login selbst | `-p "/usage"` ja (Changelog); der lokale Server nein |
| CodexBar, Quelle 4 (OAuth) | Google-Konto im Tool | `cloudcode-pa`: `loadCodeAssist`, `onboardUser`, `fetchAvailableModels`, `retrieveUserQuota`, `retrieveUserQuotaSummary` | eigener Login mit der OAuth-Client-ID von Antigravity, aus `Antigravity.app` ausgelesen oder per Umgebungsvariable; Tokens in `~/.codexbar/antigravity/oauth_creds.json` | nein |
| CodexBar, Gemini-Anbieter | `~/.gemini/oauth_creds.json` des Gemini-CLI | `…:retrieveUserQuota` | Refresh-Token plus Client-Secret aus der Gemini-CLI-Installation | nein; Google hat das Gemini-CLI-Login für Privat-, Pro- und Ultra-Konten am 18.06.2026 abgeschaltet |
| AntigravityQuota (VS-Code-Erweiterung) | lokaler `language_server`-Prozess | `GetUserStatus` auf 127.0.0.1 | CSRF-Token aus den Prozessargumenten | nein |
| ccusage | lokale Dateien unter `~/.gemini/antigravity*` und `~/.config/antigravity` | keiner | keins | nicht nötig; liefert Token und Kosten, keine Limits |
| opencode-antigravity-quota | Konten-Datei des Plugins `opencode-antigravity-auth` | nicht dokumentiert | Token aus `antigravity-accounts.json` | nein |

Belege: [T3-Code-Commit #17530](https://github.com/pingdotgg/t3code/commit/716357cbba) (`apps/server/src/provider/antigravityUsageLimits.ts`), [CodexBar `docs/antigravity.md`](https://github.com/steipete/CodexBar/blob/7c08c0a/docs/antigravity.md) und [`docs/gemini.md`](https://github.com/steipete/CodexBar/blob/7c08c0a/docs/gemini.md), [AntigravityQuota](https://github.com/Henrik-3/AntigravityQuota) (`src/core/quota_manager.ts`), [ccusage](https://github.com/ryoppippi/ccusage) (`docs/guide/environment-variables.md`), [opencode-antigravity-quota](https://github.com/frieser/opencode-antigravity-quota), [Google: Abschaltung für Privatkonten](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals).

Auffällig an den Wegen mit `cloudcode-pa`:

- T3 und CodexBar setzen einen **fremden User-Agent** (`antigravity/hub/1.0.0 (aidev_client; …)` bei T3, `antigravity/hub/2.9.1 <os>/<arch>` bei CodexBar). Das Tool gibt sich als Googles Programm aus.
- CodexBar liest die OAuth-Client-ID und das Secret **aus dem Binary** der installierten Antigravity-App. Konten, die mit dem anderen Client angemeldet wurden, bekommen `GOOGLE_TOS_NOT_SUPPORTED_BY_CLIENT` (CodexBar-Doku). Die Doku von CodexBar nennt kein Bann- oder ToS-Risiko; unter `steipete/CodexBar` fand die Suche nach „banned“ keinen Issue.
- T3 liest dieselbe Datei, die auch Tau für seinen ACP-Server im Profil anlegt (`profile/antigravity-acp/acp_token.json`, `kits/antigravity/profile.ts`). Der Pfad ist dort bekannt; Tau liest den Inhalt bisher bewusst nicht.

## Was Google dokumentiert

- **Nutzungsbedingungen, Abschnitt 6** ([antigravity.google/terms](https://antigravity.google/terms?hl=en)): „Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement.“ Das könne Grund für Sperrung oder Kündigung der Antigravity- und/oder Gemini-CLI-Konten sein. Die Seite nennt kein Datum und erwähnt Quotas nicht.
- **Antigravity-CLI** ([Headless-Doku](https://antigravity.google/docs/cli/headless)): `-p` führt einmal aus, `--output-format json` liefert einen Umschlag mit Tokenzahlen (`usage`). Quota steht dort nicht. Slash-Befehle wie `/model` und `/usage`, die das CLI selbst beantwortet, liefern „a text report rather than a standard event stream“.
- **Changelog** ([antigravity.google/docs/changelog](https://antigravity.google/docs/changelog)): v1.1.11 (07.08.2026) beantwortet `-p "/usage"`, `/quota` und `/credits` ohne Agenten-Turn und „without using quota“, mit tabulatorgetrennter Ausgabe. v1.2.15 (02.10.2026): bei Ausgabe in ein Terminal lokale Zeit, bei Pipe und `--json` UTC. `/usage` ist damit ein dokumentierter, vorgesehener Weg, Quota zu lesen.
- Google nennt keine Rate-Limit-Regel für das Lesen von Quota und keine freigegebene Quota-API.

## Dokumentierte Bannfälle

Alle Belege sind Nutzerberichte im [Google-AI-Developers-Forum](https://discuss.ai.google.dev); Google-Mitarbeiter schreiben dort wenig.

- [Account Restricted Without WARNING](https://discuss.ai.google.dev/t/account-restricted-without-warning-google-ai-ultra-oauth-via-openclaw/122778) (Februar 2026): Ultra-Konten gesperrt, Auslöser OpenClaw, OpenCode, die Gemini-CLI und andere Programme mit Antigravity-OAuth. Meldung: „This service has been disabled in this account for violation of Terms of Service.“ Ein Nutzer zitiert die Support-Antwort vom 17.02.: Anlass sei „the use of Antigravity servers to power a non-Antigravity product“, es gelte „zero tolerance“, die Sperre sei nicht umkehrbar. Das ist zweite Hand und nicht überprüfbar.
- [Antigravity banned](https://discuss.ai.google.dev/t/antigravity-banned/130562) (11.03.2026): Sperre nach einem Tag mit einem Coding-Agent-CLI eines anderen Anbieters über Antigravity-OAuth; der Nutzer meldet am 15.03. selbst die Entsperrung, ohne Bestätigung von Google.
- [Thread zur ToS-Durchsetzung](https://discuss.ai.google.dev/t/thank-you-to-the-google-for-the-tos-enforcement-and-a-reality-check-for-the-abusers/127137): Google-Mitarbeiter am 02.03.2026: „We are currently rolling out a system-wide automated unban for all affected accounts.“
- Suchtreffer ohne geöffnete Seite: Bann nach Nutzung eines Antigravity-Proxys für Fremdmodelle, Berichte zu `agy` ([Thread](https://discuss.ai.google.dev/t/appeal-antigravity-agy-account-disabled-403-tos-reinstatement-request/172568)).
- Die Sperre trifft laut Berichten Antigravity, Gemini-CLI und die Cloud-Code-Private-API, andere Google-Dienste nicht.

Gemeinsamer Nenner: **Inferenz** auf Antigravity-Kontingent durch ein Programm, das nicht von Google ist. Ein Bannbericht, der nur an einem Quota-Abruf hängt, ist mir nicht begegnet. Wer den Refresh-Token außerhalb von Googles Programm einsetzt, liegt aber im selben Muster wie die gesperrten Tools: fremder Client, interner Endpunkt, Antigravity-Token.

Zum Aufruf des offiziellen CLI aus fremden Tools gibt es eine direkte Frage im Forum ([Is invoking the official Antigravity CLI (agy --print) from a third-party developer tool an acceptable use?](https://discuss.ai.google.dev/t/is-invoking-the-official-antigravity-cli-agy-print-from-a-third-party-developer-tool-an-acceptable-use/175462), 20.07.2026). Die Antwort „That's fine“ stammt von einem Nutzer. Eine Aussage von Google fehlt.

## Was Tau schon weiß

- `kits/antigravity` startet Googles `agy_acp_server` (Release `agy_acp_server_1.1.1`) und lässt ihn den Google-Token selbst im Profil `<stateDir>/profile/antigravity-acp/acp_token.json` halten. Tau prüft nur, ob die Datei existiert (`profile.ts`, `host.ts`).
- ACP liefert Tau Kontextgröße und Kosten (`usage_update`) und Tokenzahlen je Turn, aber kein Quota (`kits/_acp/events.ts`). Das Usage Kit führt Antigravity deshalb nur als Thread-Quelle und nicht in `LIMIT_SOURCES` (`kits/usage/protocol.ts`: „Antigravity's agent reports none“).
- Tau merkt sich die Befehlsliste, die der Agent per `available_commands_update` meldet (`facts.commands`). Ob `agy_acp_server` `/usage` darin führt, ist **nicht geprüft**; das ginge nur mit einem echten Login.
- `agy` (das CLI) und `agy_acp_server` sind zwei Programme. CodexBar bestätigt, dass das CLI seinen Login im Schlüsselbund hält (`SSH_TTY` schaltet auf Dateispeicher um). Ein `agy -p "/usage"` zeigt daher das Konto des CLI-Logins, nicht zwingend das des Tau-Profils. Das ließe sich nur ohne Credential-Zugriff lösen, wenn der Nutzer in beiden dasselbe Konto verwendet. CodexBar umgeht das, indem es Credentials in ein Temp-Home schreibt; das wäre für Tau ein Credential-Zugriff.
- Betriebsrisiko laut [CodexBar #4441](https://github.com/steipete/CodexBar/issues/4441) (offen, 11.10.2026): Ein Hintergrund-Aufruf von `agy -p /usage` mit abgelaufenem Token öffnete alle fünf Minuten den Browser für eine interaktive OAuth-Anmeldung. Ein Tau-Aufruf bräuchte Timeout und Abbruch, wenn `agy` auf eine Anmeldung wartet, und dürfte nicht im Takt laufen.

## Empfehlung für Tau

1. **T3-Weg (Refresh-Token plus `cloudcode-pa`) nicht übernehmen.** Er bricht Taus Regel, Credentials nicht zu lesen, nutzt eine undokumentierte Schnittstelle, setzt einen fremden User-Agent und gleicht dem Muster der gesperrten Tools (Antigravity-Token in fremdem Client). Das Risiko ist nicht belegt, aber der Nutzer trägt es allein; ein Bann trifft auch die Gemini-CLI.
2. **Der risikoärmste Weg ist Googles eigenes Programm:** `agy -p "/usage"` (oder `--json`) mit dem unveränderten Binary, vom Nutzer ausgelöst. Das Binary liest seinen Login selbst, Tau sieht nur die Textausgabe, Google dokumentiert den Befehl, und die Antwort kostet laut Changelog keine Quota. Auflagen:
   - nur auf Knopfdruck oder beim Öffnen der Limits-Ansicht, nie im Hintergrundtakt;
   - kein Schreiben von Credentials, kein Temp-Home, kein Umbiegen von `HOME` oder `SSH_TTY`;
   - hartes Zeitlimit (CodexBar nutzt 90 s und 1 MiB Ausgabe) und Abbruch bei Login-Aufforderung; Konto im Ergebnis als „Konto des `agy`-Logins“ kennzeichnen;
   - `agy` über `findCommand` suchen; fehlt es, die Zeile ausblenden statt zu installieren.
   Restrisiko: Google hat den Aufruf aus fremden Programmen nicht ausdrücklich freigegeben (Abschnitt 6 der Bedingungen); das Binary bleibt aber Googles. Das ist dasselbe Muster wie der ACP-Server, den Tau schon startet.
3. **Prüfen, ob der ACP-Server `/usage` anbietet** (Eintrag in `facts.commands` nach einer Sitzung). Dann liefe die Abfrage über den Agenten des Tau-Profils, mit dem richtigen Konto und ohne zweiten Login. Das braucht eine Prüfung mit einem echten Login, die nur der Nutzer freigeben kann. Nicht Teil dieser Recherche.
4. **Lokaler Server (CodexBar-Weg 1 bis 3, AntigravityQuota)** ist für Tau keine Option: Er braucht das laufende Antigravity-Programm, liest das CSRF-Token aus den Prozessargumenten, und `agy` ab 1.2.2 lässt tokenlose Anfragen nicht mehr zu. Er sendet zwar nichts an Google, passt aber nicht zu Taus ACP-Server.
5. **Wenn nichts davon gewollt ist:** Tau bleibt bei Tokens und Kosten aus ACP und zeigt in der Limits-Ansicht für Antigravity einen Hinweis auf `/usage` im `agy`-Terminal. Das Risiko ist null.

Reihenfolge nach Bannrisiko, niedrig zuerst: Hinweis ohne Abruf, ACP-Befehl `/usage` im Tau-Profil (falls vorhanden), `agy -p "/usage"` auf Knopfdruck, lokaler Server, Refresh-Token mit `cloudcode-pa`.

## Offene Punkte

- Ob `agy_acp_server` `/usage` als Befehl meldet und beantwortet: ungeprüft.
- Ob `agy -p "/usage"` den Login des Tau-Profils oder den des CLI verwendet: ungeprüft, nur CodexBars Beschreibung.
- Ob Google den Aufruf des offiziellen CLI aus Drittprogrammen duldet: keine Aussage von Google, nur ein Nutzerurteil im Forum.
- Der Wortlaut der Bedingungen stammt von einer Seitenabfrage; die Seite nennt kein Gültigkeitsdatum.
