# Tau-Nutzungsstatistik mit Matomo

Recherchiert am 9. Oktober 2026 anhand der offiziellen Matomo-Dokumentation und des Quellcodes auf Commit `cfa50c9d638cdcb8884d983c0de814a2b0112966`. Der Nutzer hat seine selbst gehostete Installation unter `analytics.tbuck.de` bestätigt und das Anlegen eines separaten Tau-Eintrags autorisiert. Die angemeldete Oberfläche wurde anschließend geprüft; sie zeigt Matomo 5.13.0.

## Einrichtungsstand

`Tau App` wurde über die Matomo-Oberfläche angelegt. Die bestätigte Site-ID ist **4**. Matomo läuft als Docker-Dienst `matomo_app` unter Dokploy auf dem Strato-VPS; der vorhandene SSH-Alias `vps` funktioniert.

Die vorherigen Speicherfehler waren HTTP-400-Antworten mit `Bitte geben Sie einen Wert für 'siteName' an.` Die automatische Eingabe hatte zwar den sichtbaren Feldwert geändert, aber das Formularmodell nicht aktualisiert. Nach Eingabe über Tastatur und erneutem Speichern bestätigte Matomo `Webseite erstellt`. Es waren keine Server-, Container- oder Berechtigungsänderungen erforderlich.

Gespeicherte Werte:

- Name: `Tau App`; Typ: `Webseite` (die Oberfläche bietet nur Webseite und Intranet an).
- Tracking-Endpunkt: `https://analytics.tbuck.de/matomo.php`.
- Site-ID: `4`, im Tracking als `idsite=4`.
- Feste synthetische Aktions-URL: `https://rasalas.github.io/tau/app`. Diese URL bezeichnet die App-Aktion; die Anfrage geht an den Tracking-Endpunkt.
- Zeitzone: UTC; Währung: EUR; interne Suche und E-Commerce aus.
- Tracking auf den angegebenen Aktions-URL-Präfix beschränkt.
- Eigene Datenschutzeinstellungen nur für Site `4`: IP vollständig maskieren und die maskierte IP für die Aufbereitung verwenden. Matomo bestätigte die Speicherung mit `Webseite aktualisiert`.

Die Desktop-Integration ist als optionales Kit `tau.usage-statistics` umgesetzt und standardmäßig aus. Sie wird mit Tau 0.7.40 eingeführt. Die globale Datenschutzoberfläche zeigt IP-Maskierung von zwei Bytes, Anreicherung mit unmaskierter IP und keine regelmäßige Rohdatenlöschung. Die bestehende Matomo-Version bietet im Bearbeitungsformular pro Site eigene Anonymisierungseinstellungen; für Tau sind sie wie oben beschrieben gesetzt. Die globalen Einstellungen wurden nicht verändert. Webserver-/Proxy-Logs und Rohdatenaufbewahrung bleiben separat zu prüfen.

Die serverseitige Konfiguration ist jetzt `enable_processing_unique_visitors_range=1`. Rollierende 7-/30-Tage-Unique-Visitor-Abfragen wurden mit einem separaten Testeintrag bestätigt. Custom Dimensions im Visit-Scope sind für Tau als `1=App version`, `2=Platform` und `3=Release channel` angelegt. Zwei gespeicherte Segmente unterscheiden Prompt- und Workbench-Aktivität. Es wurden keine Geheimnisse aus der Matomo-Konfiguration ausgegeben. Details und der Abfragebefehl stehen in [der Betriebsdokumentation](../usage-statistics.md).

## Empfehlung

Matomo eignet sich für die erste Tau-Nutzungsstatistik. Die vorhandene Installation kann Tages-, Wochen- und Monatszahlen sowie Versionen und Plattformen auswerten. Matomo dokumentiert ausdrücklich Software- und Desktop-App-Statistik über die HTTP Tracking API. Dafür einen eigenen Eintrag `Tau App` anlegen, getrennt von der Website. [Software-Statistik](https://matomo.org/blog/2012/04/how-to-use-matomo-to-track-mobile-apps-activity-clicks-phones-errors/).

Für den ersten Zähler genügt eine direkte HTTPS-Verbindung zum bestehenden `matomo.php`. Ein vorgeschalteter Dienst ist eine Entscheidung über zusätzliche Funktionen. Automatisches Löschen aus der App, verbindliche Tages-Deduplizierung und das Entfernen der Client-IP vor Matomo sind konkrete Gründe dafür. Sie sind keine Voraussetzung für eine korrekte Zahl unterschiedlicher Installationen.

## Tracking-Vertrag

Die API akzeptiert GET oder POST. Vorgesehen ist POST mit `application/x-www-form-urlencoded`. Erforderlich sind `idsite` und `rec=1`. Die lokale Statistik-ID besteht aus acht kryptografisch zufälligen Bytes, als 16 Hex-Zeichen, und wird als `cid` übertragen. `e_c=tau`, `e_a=human_prompt_accepted` beziehungsweise `workbench_used` erzeugen Ereignisse. `ca=1` kennzeichnet die Anfrage als andere Aktion als einen Seitenaufruf, `send_image=0` liefert eine leere 204-Antwort. `url` erhält einen festen synthetischen App-Pfad. Normales Tracking und `cid` benötigen keinen `token_auth`. [Tracking API](https://developer.matomo.org/api-reference/tracking-api).

`cid` ist hier der passende Parameter. Im Code erzwingt er die Auswahl genau dieser Besucherkennung. `_id` entspricht der übermittelten First-Party-Cookie-ID; standardmäßig darf Matomo alternativ eine vorhandene Konfiguration erkennen. Bei vielen Clients mit derselben IP und demselben User-Agent kann das Installationen zusammenführen. Ein Proxy mit gemeinsamer IP verschärft diesen Fall. [VisitorRecognizer, insbesondere `shouldLookupOneVisitorFieldOnly`](https://github.com/matomo-org/matomo/blob/cfa50c9d638cdcb8884d983c0de814a2b0112966/core/Tracker/VisitorRecognizer.php#L180).

`uid` ist eine Benutzerkennung mit zusätzlicher Zusammenführung von Besuchen. Tau braucht für Installationszahlen keine solche Kontoidentität. Die Auswertung verwendet daher `nb_uniq_visitors`, nicht `nb_users`. `cid` hat Vorrang vor `_id`; `uid` kann seinerseits die Besucher-ID überschreiben. [Request](https://github.com/matomo-org/matomo/blob/cfa50c9d638cdcb8884d983c0de814a2b0112966/core/Tracker/Request.php#L710).

Die Kennung gehört zum bedienten Client, bleibt außerhalb synchronisierter Einstellungen und wird weder aus einem Provider-Konto noch einem Host-Schlüssel abgeleitet. Freiwillige Teilnahme, Fehler außerhalb des Promptpfads, keine Berichte aus Tests, Dev-Builds, Demo oder Hintergrund-Hosts entsprechen dem bisherigen [Tau-Vorschlag](usage-metrics-opencode-t3code.md#empfehlung-für-tau).

Version, Plattform und Releasekanal können als konfigurierte Custom Dimensions im Visit-Scope übertragen werden. Ihre IDs müssen aus der Matomo-Konfiguration stammen. Das ist für den ersten Gesamtzähler optional. Die API unterstützt auch Action-Scope-Dimensionen, wenn eine Dimension pro Ereignis wechseln soll. [Tracking API, Custom Dimensions](https://developer.matomo.org/api-reference/tracking-api#optional-user-info).

Matomo bietet den Typ `mobileapp` über `MobileAppMeasurable`; er ist eine mögliche Kennzeichnung für den App-Eintrag, keine Tracking-Voraussetzung. Ein gewöhnlicher Website-Eintrag funktioniert ebenfalls. [App-Typ](https://github.com/matomo-org/matomo/blob/cfa50c9d638cdcb8884d983c0de814a2b0112966/plugins/MobileAppMeasurable/Type.php), [Desktop-App-Anleitung](https://matomo.org/blog/2012/04/how-to-use-matomo-to-track-mobile-apps-activity-clicks-phones-errors/).

## Aktive Installationen richtig zählen

Die offizielle Definition der Unique Visitors dedupliziert dieselbe Kennung im gewählten Zeitraum. Auf selbst gehostetem Matomo sind Tages-, Kalenderwochen- und Kalendermonatszahlen standardmäßig verfügbar. Unterschiedliche Geräte bleiben unterschiedliche Installationen. [Unique Visitors](https://matomo.org/faq/general/faq_43/).

Für die Hauptkennzahl `VisitsSummary.getUniqueVisitors` mit dem Segment `eventAction==human_prompt_accepted` abfragen. So zählen nur Besuche mit dem menschlichen Prompt-Ereignis. `week` und `month` meinen Kalenderperioden in der Zeitzone des Matomo-Eintrags. Für die bisher vorgeschlagenen sieben oder dreißig UTC-Tage den Eintrag auf UTC einstellen und `period=range&date=last7` beziehungsweise `last30` verwenden. Diese Zeiträume enthalten den heutigen, noch laufenden Tag. [Reporting API](https://developer.matomo.org/guides/reporting-api), [Ereignis-Segmente](https://developer.matomo.org/api-reference/reporting-api-segmentation).

Auf Matomo On-Premise muss dafür `[General] enable_processing_unique_visitors_range = 1` gesetzt sein. Rohdaten müssen für den abgefragten Zeitraum vorhanden sein. Tägliche Unique Visitors dürfen nicht addiert werden, weil wiederkehrende Installationen sonst mehrfach zählen. Die globale Gesamtmetrik hat diese Möglichkeit; die Unique-Visitors-Spalte einzelner Ereignisberichte ist für Wochen und Monate nicht derselbe verlässliche Abfrageweg. [Perioden und Custom Ranges](https://matomo.org/faq/faq_113/).

Lokales Begrenzen auf je ein Ereignis pro UTC-Tag hält das Datenvolumen klein. Ein wiederholtes Ereignis mit derselben `cid` erhöht zwar die Ereigniszahl, aber nicht die Anzahl unterschiedlicher Installationen. Die dokumentierte Tracking API bietet keinen allgemeinen Idempotenzschlüssel. Falls exakt einmalige Tageszeilen gefordert sind, muss ein vorgeschalteter Dienst sie selbst verwalten. Das ist eine Folgerung aus dem API-Vertrag und der Unique-Visitors-Definition.

## IP und User-Agent

Eine direkte Anfrage überträgt technisch ihre Quell-IP. Matomo kann sie vor dem Speichern vollständig zu `0.0.0.0` maskieren. Der Webserver oder Reverse Proxy kann trotzdem eigene Zugriffslogs führen; diese Einstellung ist separat. [IP-Anonymisierung](https://matomo.org/faq/general/how-does-ip-address-anonymisation-work-in-matomo/).

Die Defaults reichen für den bisherigen Vertrag mit ausschließlich ID und Produktmerkmalen nicht aus. Matomo aktiviert IP-Maskierung standardmäßig mit zwei Bytes und verwendet standardmäßig die unmaskierte IP zur Anreicherung der Besuchsdaten. Für `Tau App` vier Bytes maskieren und die anonymisierte IP auch für die Anreicherung verwenden. Die tatsächliche Konfiguration prüfen. [PrivacyManager-Defaults](https://github.com/matomo-org/matomo/blob/cfa50c9d638cdcb8884d983c0de814a2b0112966/plugins/PrivacyManager/Config.php#L54).

Der HTTP User-Agent kann ebenfalls Browser- und Betriebssysteminformationen liefern. Deshalb einen festen generischen App-User-Agent verwenden, keine Browserauflösung, Sprache, Referrer oder Client Hints mitsenden. Falls der Browser den HTTP-Header nicht ändern lässt, ersetzt der Tracking-Parameter `ua` ihn für Matomos Auswertung. Der Webserver sieht weiterhin den tatsächlichen Header. [Request, `getUserAgent`](https://github.com/matomo-org/matomo/blob/cfa50c9d638cdcb8884d983c0de814a2b0112966/core/Tracker/Request.php). Mit `cid` braucht die Zählung keinen Rückschluss aus IP und Browsermerkmalen. Matomo besitzt außerdem eine optionale globale Randomisierung des `config_id`; deren Auswirkung auf die konkrete Installation müsste geprüft werden, sie ist für diese Zählung keine notwendige Änderung. [Browsermerkmale und Randomisierung](https://matomo.org/faq/how-to/how-to-randomise-the-visitor-config_id-for-privacy/).

`cip=0.0.0.0` erfordert einen berechtigten `token_auth`; dieser gehört nicht in die ausgelieferte App. Die Authentifizierungsanforderung des Matomo-Servers abzuschalten wäre ebenfalls der falsche Weg. Ein vorgeschalteter Dienst kann die Client-IP weglassen und selbst mit festen Matomo-Parametern senden. [Tracking API, privilegierte Parameter](https://developer.matomo.org/api-reference/tracking-api#other-parameters-require-authentication-via-token-auth), [Standardkonfiguration](https://github.com/matomo-org/matomo/blob/cfa50c9d638cdcb8884d983c0de814a2b0112966/config/global.ini.php#L962).

## Löschen und vorgeschalteter Dienst

Matomo hat GDPR Tools zum Finden und Löschen einzelner Besuche. Tau kann die Statistik-ID anzeigen, damit ein manueller Löschwunsch über `visitorId==<cid>` zugeordnet werden kann. Abschalten der Statistik stoppt neue Berichte, löscht aber noch keine gespeicherten Besuche. [GDPR Tools](https://matomo.org/faq/new-to-piwik/how-to-exercise-user-rights-in-matomo/), [Segmentnamen](https://developer.matomo.org/api-reference/reporting-api-segmentation).

Für einen automatischen Löschknopf muss ein vertrauenswürdiger Server die administrativen Matomo-Aufrufe durchführen. `PrivacyManager.findDataSubjects` nimmt ein Segment, liefert höchstens 401 Treffer und setzt aktivierte Besucherlogs beziehungsweise Profile voraus. `deleteDataSubjects` erhält die gefundenen Paare aus Site- und Visit-ID und verlangt Admin-Zugriff. Eine Implementierung muss daher alle Treffer abarbeiten und darf nicht nach dem ersten Paket aufhören. [PrivacyManager API](https://github.com/matomo-org/matomo/blob/cfa50c9d638cdcb8884d983c0de814a2b0112966/plugins/PrivacyManager/API.php#L98). Das Löschen invalidiert betroffene Archive für eine spätere Neuberechnung. [DataSubjects](https://github.com/matomo-org/matomo/blob/cfa50c9d638cdcb8884d983c0de814a2b0112966/plugins/PrivacyManager/Model/DataSubjects.php#L110).

Wenn Tau den vollständigen früheren Vorschlag einschließlich automatischem Löschen und serverseitiger Tages-Deduplizierung umsetzen soll, empfiehlt sich ein schmaler Endpunkt auf derselben kontrollierten Infrastruktur wie Matomo, etwa `https://analytics.tbuck.de/tau/v1/activity`. Er validiert wenige Felder, begrenzt Anfragegrößen und Frequenz, verwaltet Löschberechtigungen und sendet an den festen Matomo-Eintrag. Domain und Pfad sind ein Vorschlag. Ein zusätzlicher Server ist dafür nicht nötig, wenn der bestehende Host diesen Dienst betreiben kann.

Wenn nur die erste aktive Installationszahl gefragt ist, direkt `https://analytics.tbuck.de/matomo.php` mit separatem Site-ID und geprüften Datenschutzeinstellungen verwenden. Die öffentliche Schreibschnittstelle ist bei beiden Varianten kein Beweis für die Anzahl wirklicher Menschen. Auch ein vorgeschalteter Dienst macht zufällige App-Kennungen nicht zu verifizierten Personen.

## Verifizierter Betrieb und ausstehende Veröffentlichung

Die Einrichtung und der Test stehen in [der Betriebsdokumentation](../usage-statistics.md). Ein temporärer Testeintrag mit identischen IP-Einstellungen und Dimensionen nahm drei Trackinganfragen an. Zwei Gerätekennungen ergaben zwei Unique Visitors für `last7` und `last30`; die gespeicherten IPs waren vollständig maskiert. Der Testeintrag, seine Rohdaten und Testarchive sind entfernt. Die echte Site `4` blieb unbefüllt.

Die Desktop-Integration erfasst freiwillig teilnehmende Installationen. Manuelle Löschung anhand der angezeigten Statistik-ID ist Teil dieses Umfangs. Ein automatischer Löschdienst wurde nicht hinzugefügt.

Die externe Datenschutzerklärung wurde am 9. Oktober 2026 auf Deutsch und Englisch für Tau 0.7.40 veröffentlicht. Sie beschreibt jetzt die freiwillige Statistik und die gespeicherten Betreiber-Daten. Der [deutsche und englische Zusatz](../privacy-usage-statistics.md) hält diese Angaben fest. Die globale Rohdatenaufbewahrung und Server-/Proxy-Logs wurden nicht verändert.
