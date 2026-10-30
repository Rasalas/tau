# PR-Provider-Folgearbeit, 29. Oktober 2026

Umgesetzt im gemeinsamen Worktree, ausschließlich in `kits/review/` und diesem Bericht. Vorhandene Filter-, Shift-Viewed- und Guide-Änderungen wurden erhalten. Es wurden keine Tests, Typechecks, Builds, Installationen oder Appstarts ausgeführt. Keine Commits, Pushes oder Änderungen an echten PRs.

## Quellen und Vorgaben

- Repo-Vorgaben: `AGENTS.md`, `CONTEXT.md`, `docs/agents/domain.md`, ADR 0002, 0006, 0009, 0020 und 0034.
- Ausgangsbericht: [Implementierungsstand](t3-parity-implementation-2026-10-29.md), [Primärquelleninventur](t3code-since-2026-10-11.md).
- UI nach dem bereits vor den UI-Änderungen gelesenen [Opus-Bericht, Abschnitt 8](t3-parity-next-ux-2026-10-29.md). Die beschriebene Checkbox-Menüsemantik ist im vorhandenen `MenuItem.multiple` bereits verfügbar. Keine Core-Ergänzung nötig.
- Upstream read-only unter `/tmp/tau-t3code-upstream-20261029`, Pin `7a4f5b6188fed54ddc866723e39446a198b5835c`. Gelesen wurden insbesondere [Forgejo-Pflichtchecks c1a24f8](https://github.com/pingdotgg/t3code/commit/c1a24f884edd7f64f2039c89df9d5918e970d20b) und [Maintainer-Edits 5b89a53](https://github.com/pingdotgg/t3code/commit/5b89a53585622a3c082b5f5287ab991e88f570b1) samt Provider-Modulen.
- [Forgejo-Branchschutz](https://forgejo.codeberg.page/docs/latest/user/repository/protection/) beschreibt Schutzregeln und deren Vorrang. Die konkrete Branch-API liefert die wirksame Regel; Tau wählt nicht selbst aus einer Liste überlappender Branchglobs. Die kompatible [Gitea-Branch-API-Struktur](https://raw.githubusercontent.com/go-gitea/gitea/main/modules/structs/repo_branch.go) benennt `protected`, `enable_status_check`, `status_check_contexts`, erforderliche Reviews und `user_can_merge` separat.
- [GitHub GraphQL](https://docs.github.com/en/graphql/reference/pulls) dokumentiert `maintainerCanModify`, `viewerCanUpdate` und `UpdatePullRequestInput.maintainerCanModify`. [GitHubs Anleitung](https://docs.github.com/en/pull-requests/how-tos/work-with-forks/allowing-changes-to-a-pull-request-branch-created-from-a-fork) begrenzt den Grant auf persönliche Forks und erklärt die Wirkung auf Workflows und Secrets. [`gh pr create`](https://cli.github.com/manual/gh_pr_create) bietet dafür `--no-maintainer-edit`.

## Forgejo-Pflichtchecks

`PullRequestCheck.required` hat drei Zustände: `true` ist verpflichtend, `false` ist ausdrücklich optional, fehlend ist unbekannt. `requirementUnknown` benennt einen fehlgeschlagenen oder nicht auswertbaren Regel-Read. `expected` unterscheidet eine erwartete Pflichtprüfung von einem tatsächlich gemeldeten Jobstatus.

Der Provider liest `/statuses/<head>?sort=recentupdate` vollständig, einschließlich serverseitig verkleinerter Seiten. Er folgt der durch Link-Header angegebenen Fortsetzung über eigene Seitennummern, sonst bis zur leeren Seite. Eine leere Seite mit angekündigter Fortsetzung, fehlerhafte Antwort oder das Limit von 30 Seiten führt zum Fehler. Eine abgeschnittene Menge wird nicht als erfolgreich behandelt.

Die konkrete Zielbranch wird über `/branches/<base>` gelesen, mit kodiertem Branchnamen. 403 und 404 bedeuten unbekannte Pflichtregeln. Authentifizierungs-, Quoten-, Netzwerk- und Serverfehler bleiben Fehler. Der bestehende Branch-Detektor behält bei unlesbaren Checks den gefundenen PR und zeigt eine ausstehende Erwartung, statt ihn als nicht vorhanden zu behandeln.

Bekannte deaktivierte Statusregeln machen die beobachteten Checks optional. Bei aktivierter Regel bleiben leere, blanke, fehlerhafte oder fehlende Kontexte unbekannt. Unterstützt werden `*` und `?` über Unicode-Zeichen, auch über `/`. Klassen, Alternativen und Escapes führen zu unbekannter Regel plus ausstehender Erwartung. Es gibt Grenzen für Musteranzahl, Musterlänge, Kontextlänge und die gesamte Zahl der Matching-Schritte. Regex-Backtracking wird nicht verwendet.

Fehlende exakte Kontexte und Globs werden als ausstehende Pflichtzeilen ergänzt. Gleiche Namen in unterschiedlichen gemeldeten Workflows bleiben getrennt. Updates eines Jobs werden nach Datum und ID zusammengefasst; zwischen unterschiedlichen Job-URLs desselben Kontextes hat ein laufender Job Vorrang. Unter abgeschlossenen Duplikaten gewinnt der neueste. Ältere noch laufende Duplikate können dadurch konservativ weiter blockieren.

Rollup, Zusammenfassung und Rail-Zähler berücksichtigen bekannte optionale Checks nicht. `skipped` und `neutral` blockieren nicht. Beide PR-Ansichten zeigen `Required` und `Other`, Pflicht-Badges, `Not required` und bei unbekannter Regel die von Opus vorgegebene Fußnote. Das Rollup-Tooltip spricht bei bekannter Pflichtregel ausdrücklich über required checks.

Checks bleiben von Mergepolitik getrennt. Erforderliche Reviews, Konflikte, aktualisierte Basis, Nutzerrechte und weitere Serverregeln werden nicht aus grünen Checks abgeleitet. Diese Änderung bestätigt keine Mergeberechtigung, umgeht keinen Branchschutz und startet keine Mergeaktion.

## Forgejo-Watch

Der bestehende Watch liegt innerhalb des Eigentums. Er akzeptiert jetzt Forgejo-PRs, speichert deren Baseline und liest über den Forgejo-Provider statt über GitHub-GraphQL. Kommentare, Reviews und vorhandene Review-Kommentare werden vollständig paginiert, mit 30 Seiten je Verbindung und 100 Remark-Seiten je Snapshot. Fehlende Abdeckung macht den Watch unreadable. Remark-Inhalte werden zu einem SHA-256-Fingerprint zusammengefasst und nicht als Kommentartext im Watch-Zustand gespeichert.

`done` richtet sich bei bekannter Regel nach den Pflichtchecks. Ein neuer optionaler Fehler erzeugt einmal einen ausdrücklich als `optional` bezeichneten Wake, ohne den Abschluss der Pflichtchecks zu blockieren. Laufende optionale Jobs halten `done` nicht auf. Stop-, Settle-, Quoten-, Persistenz- und Wake-Regeln bleiben im bestehenden Modul. Der GitHub-Schnell-Probe fragt ausschließlich GitHub ab. Forgejo wird einmal je regulärem Poll gelesen, derzeit einmal pro Minute. Ein Watch führt keinen Merge aus.

## GitHub-Maintainer-Edits

Der vorhandene Autoren-GraphQL-Read lädt nun auch den Wert, `viewerCanUpdate`, PR-Zustand, Kopf-Repository, Fork-Eigentümertyp und Viewer. Ohne bestätigte Daten bleibt der Eintrag verborgen. Sichtbar ist er nur für einen offenen GitHub-Fork-PR, dessen persönlicher Fork dem angemeldeten Autor gehört. Eine allgemeine Upstream-Edit-Berechtigung allein genügt nicht.

Beide Ansichten verwenden denselben Header. Desktop zeigt einen `menuitemcheckbox`, Compact eine Switch-Zeile im Aktions-Sheet. Der Eintrag bleibt beim Umschalten offen, zeigt den optimistischen Wert und `Saving…`, und verhindert parallele Klicks. Read-only und Offline deaktivieren ihn über den vorhandenen `pr-update`-Zugang. Fehler setzen den optimistischen Wert zurück und melden die vorgegebene Toast-Nachricht mit Ursache.

`pr-update` akzeptiert den expliziten Zielwert und den erwarteten alten Wert. Es verbietet Mischmutationen mit Titel oder Beschreibung, verweigert andere Provider und prüft Typen. Vor dem GraphQL-Write werden Rechte und aktueller Wert frisch geladen. Soweit vom Provider unterstützt, bleibt die Credential-Identität für Read und Write gepinnt. Ein inzwischen geänderter Wert führt zum Fehler. Der Write muss den gespeicherten Wert und die PR-ID bestätigen. Normale Titel- und Beschreibungsmutationen enthalten keinen Maintainer-Grant.

Eine Detail-Revision schützt beide Ansichten gegen Reads, die vor dem erfolgreichen Speichern begannen und erst danach eintreffen. Der Offline-Cache speichert den zurückgegebenen Detailzustand und verwirft überholte ausstehende Detail-Reads. Ein später gestarteter Read darf wieder den echten Serverzustand anzeigen.

Beim Veröffentlichen eines PRs aus einem bestätigten eigenen persönlichen Fork steht im bestehenden Publish-Request-Formular die von Opus verlangte Checkbox, Standard an. Der Host prüft die Fork-Berechtigung erneut, bevor er pusht und erstellt. Ein ausdrückliches Aus verwendet `--no-maintainer-edit`; An folgt dem dokumentierten GitHub-Standard. Das Repository-Publish-Formular `publish-form.tsx` erstellt hingegen nur Repositories und hat keinen PR-Grant bekommen.

## Regressionen und noch ausstehende Prüfung

Neue Regressionen liegen in:

- `forgejo-required-checks.test.ts`: Required/Other/Unknown, fehlende Globs, blanke und nicht unterstützte Regeln, Work-Limit, übersprungene Checks, gleichnamige Workflows, laufende und abgeschlossene Duplikate.
- `provider-forgejo-required.test.ts`: echte API-Antwortformen, kleine Serverseiten, Link-Ende, kodierte Zielbranch, 403/404-Fallback, 401/429/503, ungültige und endlose Pagination, Forgejo-Watch und Remark-Pagination.
- `forgejo-watch.test.ts`: Required-Abschluss, einmaliger optionaler Fehler, fehlende Pflichtchecks, unbekannte Regeln und Fingerprints älterer Kommentaränderungen.
- `github-maintainer-edits.test.ts`: Read/Write, explizites Aus, fremde und Organisations-Forks, geschlossene PRs, fehlende Rechte, GraphQL-Fehler, nicht bestätigte Writes, veraltete Erwartung, gepinnte Credentials und Erstellungsargumente.
- `maintainer-access-view.test.tsx`: verspäteter Read nach Mutation, späterer autoritativer Read und Compact-Switch mit Saving-Zustand.

Erweitert wurden `provider-forgejo.test.ts`, `pr-watch-host.test.ts`, `pull-request-actions.test.ts`, `pull-request-cache.test.ts`, `publish-card.test.tsx`, `pull-request-view.test.tsx` und `review-detail.test.tsx`. Die letzten beiden prüfen beide betroffenen Ansichten mit kontrollierten Providerdaten.

Ausgeführt wurde nur `git diff --check -- kits/review`, ohne Befund. Alle genannten Tests sind geschrieben, nicht ausgeführt. Der Parent muss die gesammelten fokussierten Tests und `typecheck:kits` über die gemeinsame Check-Slot-Infrastruktur ausführen. Die zwei Ansichten sollten auch mit `TAU_TEST_SLOW_RENDERS=30` geprüft werden. Kein Claim über bestandene Laufzeit-, Typ- oder UI-Prüfung.

## Geänderte Dateien und Grenzen

Neu: `forgejo-required-checks.ts`, `required-checks.ts`, `forgejo-watch.ts`, `github-maintainer-edits.ts`, `maintainer-access.ts` und die fünf oben genannten neuen Testdateien. Alle liegen in `kits/review/`.

Bestehende Implementierung geändert: `protocol.ts`, `provider.ts`, `provider-forgejo.ts`, `provider-github.ts`, `pipeline-view.tsx`, `pull-request-logic.ts`, `pull-request-parts.tsx`, `pull-request-summary.tsx`, `pull-request-header-actions.tsx`, `pull-request-host.ts`, `pull-request-client.ts`, `pull-request-view.tsx`, `remote-review-detail.tsx`, `pull-request-cache.ts`, `request-cli.ts`, `requests.ts`, `requests-host.ts`, `publish-card.tsx`, `pr-watch-protocol.ts`, `pr-watch-host.ts`, `pr-watch-control.tsx`, `styles.css`, plus die oben genannten erweiterten Tests. Bereits vorhandene Änderungen an Code-/Dateifiltern, Viewed, Sidebar und Guide wurden nicht zurückgesetzt.

Keine Datei außerhalb des Eigentums geändert. Kein Parent-Anschluss außerhalb `kits/review/` nötig. Das bestehende `pr-update` liefert bereits die richtige Schreibberechtigung.

Grenzen: GitHubs Mutation bietet hier keinen atomaren Compare-and-swap. Der frische Erwartungs-Read verhindert veraltete UI-Writes, schließt aber eine fremde Änderung im kurzen Abstand zwischen Read und Write nicht aus. Nicht unterstützte Forgejo-Globs bleiben absichtlich unbekannt und ausstehend. Ohne verlässliche Workflow- oder Jobidentität kann Tau historische und parallel laufende Fremd-CI-Statusupdates nur anhand Kontext, URL, Zeit und ID unterscheiden. Forgejo hat keinen ETag-Schnell-Probe in dieser Änderung. Keine echte GitHub-/Forgejo-Mutation wurde zur Verifikation ausgeführt.
