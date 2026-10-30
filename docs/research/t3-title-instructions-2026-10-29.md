# Eigene Threadtitel-Anweisungen, 29. Oktober 2026

## Quellen und Schnitt

- [Upstream 51273020db3245f4ec29514a419d29b5dcb012dc](https://github.com/pingdotgg/t3code/commit/51273020db3245f4ec29514a419d29b5dcb012dc), „feat(settings): add thread title instructions“. Lokal read-only aus `/tmp/tau-t3code-upstream-20261029` gelesen, Pin `7a4f5b6188fed54ddc866723e39446a198b5835c`.
- [Bestandsaufnahme seit 11. Oktober](t3code-since-2026-10-11.md), insbesondere Rang 5. [Vorherige Implementierungsrunde](t3-parity-implementation-2026-10-29.md) als Kontext gelesen; deren Änderungen bleiben erhalten.
- `AGENTS.md`, `CONTEXT.md`, ADR 0002, 0005, 0006, 0008 und 0019. Titelprompt und Verhalten bleiben im Extension-Paket; keine Core-Erweiterung.

## Änderungen

`kits/thread-titles/settings.tsx` ergänzt „Thread title instructions“ unter Settings → Threads → New threads. Die Zeile nutzt `SettingRow`, mehrzeiliges `TextField` und `useSetting` mit Maschinenwert, Projekt-Override, Herkunft und Reset. Sie ist durchsuchbar und für Desktop, Web und Compact registriert. Der Manifest-Mindeststand steigt für die Settings-Karten auf API `^1.61.0`.

Gespeichert wird der normale Extension-Wert `values["tau.thread-titles.instructions"]`. Leer bedeutet Standardprompt; ein explizit leerer Projektwert kann Maschinenanweisungen aufheben. Höchstens 2.000 Zeichen nach CRLF-/CR-Normalisierung und äußerem Trimmen, keine versteckten ASCII-Steuerzeichen; Zeilenumbrüche und Tabs sind erlaubt. UI und Host-/Pi-Eingang validieren denselben normalisierten Grenzwert. Ungültige gespeicherte Strings bleiben in der UI sichtbar und korrigierbar; der Host meldet einen Fehler vor einer Tau-Modellanfrage.

Host und Pi verwenden `titleSystemPrompt` aus `protocol.ts`. Ohne Anweisungen bleibt der bisherige Prompt unverändert. Der Host liest die Anweisungen aus seinen aufgelösten Settings für das Arbeitsverzeichnis des betroffenen Threads, nicht aus einem Client-Payload. Angefügte Pi-Runtimes erhalten diesen gespeicherten Wert über die bestehende Bridge.

Automatische Titel übernehmen weiterhin zuerst einen nativen Runtime-Titel. Die bestehenden Native-Polls bleiben bestehen. Explizites Regenerieren nutzt wie zuvor den Tau-Modellpfad und damit die eigenen Anweisungen. Die UI erklärt diesen Geltungsbereich und dass vorhandene Titel unverändert bleiben.

Veraltete Ergebnisse überschreiben weder ein neueres Generieren noch eine zwischenzeitliche Umbenennung. Der Host verwirft Ergebnisse nach Close oder Deaktivierung und prüft vor dem Speichern erneut die Anweisungen. Ein auf Turn-Ende wartender Hostjob liest dann die aktuellen Anweisungen und bleibt an seine ursprüngliche Session-ID gebunden. Pi prüft zusätzlich Bridge-Kontext, Session-ID und Shutdown.

Bei angehängtem Pi bestätigt `generate` mit `deferApply` die Hintergrundarbeit sofort. Der Host fragt `result` in Sekundenabständen ab, liest die Settings erneut und fordert erst dann `apply` mit derselben Request-ID an; `cancel` räumt verworfene Jobs auf. Kein Bridge-Kommando wartet auf das Ende eines Agentenlaufs oder auf Inferenz. Die Host-Kommandos nutzen den vorhandenen `long`-Jobpfad, sodass auch dessen 30-Sekunden-Grenze keine lange Titelgenerierung beendet. Pi prüft bei `apply` erneut seine Sitzung und den ursprünglichen Namen und veröffentlicht anschließend den Snapshot. Alte Cancel-/Apply-Kommandos können neuere Jobs nicht verändern. Der direkte Pi-Generierungsweg ohne `deferApply` bleibt verfügbar.

## Regressionstests und Prüfung

Neu oder erweitert; durch die Integration geprüft:

- `kits/thread-titles/protocol.test.ts`: Default, mehrzeilige Normalisierung, Längenrand, Nicht-Text und Steuerzeichen.
- `kits/thread-titles/settings.test.tsx`: Registrierung, Scope-Erklärung, Laden, mehrzeiliges Speichern, Reset, Leeren und Längenfehler ohne Speichern des ungültigen Werts.
- `kits/thread-titles/host.test.ts`: Projektkontext und gemeinsamer Prompt, Native-Priorität, Regenerieren, geänderte Anweisungen vor/nach Inferenz, ungültige gespeicherte Anweisungen, Rename, Reihenfolge konkurrierender Jobs, Close und Deaktivierung, angehängtes Pi.
- `kits/thread-titles/pi.test.ts`: gemeinsamer Prompt nach Warten, getrennte Berechnung/Übernahme, Request-ID-Schutz, Rename auch bei explizitem Regenerieren und vor `apply`, konkurrierende Jobs, Session-/Kontextwechsel, Shutdown, geänderte wartende Anweisungen und Validierung.
- `kits/thread-titles/attached.test.ts`: beide echten Extension-Einträge gemeinsam mit direktem Bridge-Transport. Gespeicherte Anweisungen erreichen Pi; nach einer Settings-Änderung während der Inferenz wird kein alter Titel gesetzt, eine neue Anfrage nutzt die neuen Anweisungen.

Für die kombinierte Prüfung durch den Parent zusätzlich die bestehenden `kits/thread-titles/desktop.test.ts` und `kits/thread-titles/app.test.tsx` einbeziehen. Relevante bestehende Core-Integration: `src/main/pi-host-turn-activity.test.ts`; Typprüfung `npm run typecheck:kits` über den gemeinsamen Check-Slot.

Die Teilaufgabe führte auftragsgemäß keine Checks aus. Nach Integration und Reviewkorrekturen bestanden alle 69 Tests der sieben genannten Titel-Testdateien, `typecheck:kits`, Lint und der vollständige Build. Der echte Attached-Smoke-Test bestand mit zwölf Schritten, einschließlich wartendem Titeljob und getrenntem `result`/`apply`. Keine Commits oder Pushes.

## Grenzen und Übergabe

Host- und Pi-Eintrag müssen gemeinsam gebaut und geladen werden, damit die internen `result`-/`apply`-/`cancel`-Kommandos verfügbar sind. Die Integration erweiterte `scripts/attached-smoke.mjs` um den wartenden Titelpfad und die reale Bridge-Frist von 15 Sekunden.

Das Abschlussreview fand drei Fehler und machte eine erste Integrationskorrektur rückgängig: `settings(undefined)` liest ausschließlich Maschinenwerte, keinen impliziten Projektkontext. Angefügtes Pi hat keinen `HostThread`; der Host nutzt dafür wieder `services.cwd()` und deklariert `workspace:read` in Eintrag und Manifest. Ein lokaler Check mit dem echten `HostConfigManager`, `extensionSettings` und dem gebauten Titel-Host bestätigt Projekt-Overrides, leere Overrides und CRLF am Längenlimit. Alle Konfigurationsdateien lagen unter `.tau-dev` und wurden anschließend gelöscht.

Pi-Jobs vergleichen keine `ExtensionContext`-Objektreferenzen mehr: Die Session-ID, Bridge-Zugehörigkeit und Job-Identität binden einen wartenden Auftrag, der aktuelle Ereigniskontext übernimmt bei `agent_settled`. Regressionen verwenden neue Kontextobjekte, prüfen Deduplizierung, manuelle Umbenennung und asynchrone Fehler. Der Transporttest lässt den Agenten 40 Sekunden und die anschließende Inferenz 20 Sekunden laufen; alle Einzelaufrufe bleiben innerhalb der Bridge-Frist und genau ein Titel wird übernommen. Ein weiterer Test verwirft einen wartenden Job bei geänderten Projektanweisungen. Die Validierung zählt normalisierte Zeilenumbrüche; der zuvor abgelehnte 2.000-Zeichen-Randfall wurde vor dem Fix rot reproduziert.

Anweisungen betreffen ausschließlich durch Tau erzeugte Titel. Die bestehende Bereinigung und das bisherige Titel-Limit bleiben bestehen; ein Modell muss freie Stilwünsche nicht zuverlässig erfüllen. Modellwahl und Automatik-Schalter behalten ihre bisherige Speicherung und Auswertung.

Ändern sich die Anweisungen während einer bereits laufenden Inferenz, wird das Ergebnis verworfen. Es gibt keinen automatischen zweiten Modellaufruf; bei Bedarf „Regenerate title“ verwenden. Ein noch auf Turn-Ende wartender Tau-Hostjob liest die neuen Anweisungen; ein bereits an Pi übergebener Job wird bei der nächsten Statusabfrage verworfen. Inferenz wird nicht auf Provider-Ebene abgebrochen. Settings-Lesen und Titelübernahme sind keine gemeinsame atomare Transaktion. Echte Pi-Anbindung und visuelles Layout wurden geprüft; Details und Screenshots stehen im Integrationsbericht.

Prüflogs: `/tmp/tau-title-review-{red,green,types,lint,build,attached,settings}.log`. Der lokale Konfigurationscheck liegt in `.tau-dev/check-title-project-settings.mjs`.
