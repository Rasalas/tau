# Optional desktop usage statistics: policy supplement

Prepared for the public Tau privacy policy. The current public policy still says Tau has no analytics and the operator holds no app data. Replace those statements and incorporate this disclosure before distributing the implementation. Review the policy's retention and rights sections together with it.

## Deutsch

Die Desktop-App bietet eine freiwillige Nutzungsstatistik. Sie ist zunächst ausgeschaltet. Unter Einstellungen → Usage statistics → Share usage statistics kannst du für dieses Gerät entscheiden, ob du teilnimmst. Die Android- und iOS-App sowie der Browserclient senden diese Statistik nicht.

Wenn du einschaltest, erzeugt Tau eine zufällige Statistik-ID und speichert sie zusammen mit deiner Wahl auf diesem Gerät. Tau sendet bei Aktivität höchstens eine Meldung zur interaktiven Nutzung und eine Meldung zu angenommenen Composer-Prompts je UTC-Tag und Fenster. Mehrere Fenster können dieselbe Meldung senden; Matomo zählt die ID im gewählten Zeitraum nur einmal. Ein in die Warteschlange aufgenommener Prompt zählt bereits als angenommen, auch wenn er später nicht ausgeführt wird. Die Meldungen enthalten die Statistik-ID, die Art der Aktivität, die App-Version, die Plattform und den Releasekanal. Der Server ergänzt den Empfangszeitpunkt. Prompttexte, Dateien, Projektnamen, Providerkonten und andere Kontoidentitäten sind nicht Bestandteil dieser Meldungen.

Die Meldungen gehen per HTTPS an meine selbst gehostete Matomo-Installation unter analytics.tbuck.de auf meinem Strato-Server. Matomo speichert die IP-Adresse vollständig maskiert und verwendet die maskierte Adresse für die Aufbereitung. Bei der Verbindung erhält der Server technisch dennoch deine IP-Adresse und Browserheader. Die App sendet für die Statistik keine Cookies und keinen Referrer. Die IP-Maskierung in Matomo ist von möglichen Webserver- und Proxy-Zugriffslogs getrennt.

Die Statistik hilft mir, aktive teilnehmende Installationen zu zählen und die verwendeten Versionen und Plattformen zu verstehen. Sie identifiziert keine verifizierten Personen. Die Wahl bleibt auf dem Gerät und wird nicht mit anderen Geräten synchronisiert. Du kannst jederzeit ausschalten; Tau stoppt neue Meldungen und bricht ausstehende Anfragen ab. Frühere Meldungen werden dadurch nicht gelöscht. In der bestehenden Matomo-Installation gibt es derzeit keine automatische Löschfrist für diese Rohdaten.

Die Einstellungen zeigen deine Statistik-ID auch nach dem Ausschalten. Wenn du frühere Meldungen löschen lassen möchtest, sende mir diese ID an info@tbuck.de. Ich kann damit die zugehörigen Besuche in Matomo finden und löschen. Ohne diese zufällige ID kann ich eine Installation keiner Person zuordnen.

## English

The desktop app offers voluntary usage statistics, initially turned off. In Settings → Usage statistics → Share usage statistics you can choose whether this device participates. The Android and iOS apps and the browser client do not send these statistics.

When you turn reporting on, Tau generates a random statistics ID and stores it with your choice on this device. On activity it sends at most one interactive-use report and one accepted-composer-prompt report per UTC day in a window. Multiple windows can send the same report; Matomo counts the ID once within the selected period. A prompt accepted into a queue counts even if it is never run. Reports contain the statistics ID, activity type, app version, platform and release channel. The server adds the time received. They do not include prompt text, files, project names, provider accounts or other account identities.

Reports go over HTTPS to my self-hosted Matomo installation at analytics.tbuck.de on my Strato server. Matomo fully masks the stored IP and uses the masked IP for enrichment. The connection still exposes your source IP and browser headers to the server. The app sends no cookies or referrer with statistics. Matomo's IP masking is separate from any webserver or proxy access logs.

Statistics help me count active participating installations and understand their versions and platforms. They do not identify verified people. Your choice stays on this device and is not synced to other devices. Turning it off stops new reports and cancels pending requests. It does not delete earlier reports. The existing Matomo installation currently has no automatic deletion period for these raw records.

Settings continues to show your statistics ID after you turn reporting off. To request deletion of earlier reports, send that ID to info@tbuck.de. I can use it to find and delete the corresponding Matomo visits. Without the random ID I cannot associate an installation with a person.
