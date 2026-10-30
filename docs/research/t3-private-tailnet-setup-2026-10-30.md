# Webhooks und Gastfreigaben im privaten Tailnet

Der Nutzer hat ausschließlich Tailscale-Zugang gewählt und die öffentliche
Certificate-Transparency-Protokollierung ausdrücklich abgelehnt. Der
Tailscale-Admin-Dialog wurde abgebrochen. Es wurde kein öffentliches
HTTPS-Zertifikat beantragt und keine Tailscale-Serve-/Funnel-Freigabe eingerichtet.

## Umsetzung

- Scheduling registriert seinen bestehenden signierten Webhook-Empfang auch
  als `/extensions/tau.scheduling/webhooks/<jobId>` am vorhandenen Host-Listener.
  Der lokale `/webhooks/<jobId>`-Port bleibt kompatibel. Beide Eingänge teilen
  Signaturen, Zeitfenster, Filter, Aktivierung und persistente Deduplizierung.
  Die Registrierung öffnet selbst keinen Netzwerkport und verschwindet bei
  Deaktivierung. Die Automation zeigt den verfügbaren HTTPS-Endpunkt an.
- Der gemeinsame Host-Helfer `kits/_shared/https-origins.ts` ergänzt ausdrücklich
  konfigurierte private Zertifikate an reinen Tailscale-TLS-Listenern. Dazu
  müssen LAN ausgeschaltet, Tailscale eingeschaltet und das tatsächlich
  geladene, noch gültige Zertifikat mit der Konfiguration identisch und ohne
  Warnungen sein. Automatisch erzeugte Zertifikate, LAN-/Proxy-/Wildcard-
  Listener und fremde VPN-Adressen werden nicht übernommen.
- Diese Auswahl gilt für die HTTP-Gast-/Webhook-Routen. Sie ändert weder die
  Zertifikatsprüfung des Browsers noch die Schlüsselpins gepaarter Geräte.
  Private Zertifikate benötigen weiterhin ausdrückliches Vertrauen auf jedem
  verwendeten Gerät. Zertifikatswarnungen werden nicht automatisch umgangen.

## Installierter Stand

Die vorhandene Tau-Nightly `0.7.43-nightly.20261022.76` hatte das neue
Gastmodul noch nicht. Dieser Worktree wurde deshalb als separate Anwendung
`/Applications/Tau Dev.app` installiert. Tau.app und dessen bereits laufender
Host wurden nicht ersetzt. Tau Dev besitzt eigene Anwendungsdaten und die
Netzwerkports 7790/7791. Die Installation bleibt für die angeforderte Nutzung
vorhanden und läuft absichtlich weiter; sie ist keine zurückgelassene
Smoke-Testinstanz.

Private TLS-Dateien liegen unter
`~/Library/Application Support/tau-dev/private-tls/`. Das Verzeichnis hat Modus
0700, Root- und Server-Schlüssel jeweils 0600. Der Server besitzt ein privates
ECDSA-Zertifikat für den Tailscale-Namen und die eigenen Tailscale-IP-Adressen.
Die Zertifizierungsstelle läuft zehn Jahre, das Serverzertifikat ein Jahr.
Vor Ablauf muss das Serverzertifikat erneuert werden. Es gibt hierfür noch
keinen automatischen Erneuerungsdienst.

Konfiguriert sind `tailscale: true`, `lan: false`, `announce: false` sowie das
eigene Serverzertifikat. Der tatsächlich geprüfte IPv4-Endpunkt lautet:

`https://<tailnet-ip>:7790`

Die konkrete private Adresse wird ausschließlich in den lokalen, ignorierten
Einrichtungsartefakten unter `.tau-dev/` gehalten.

Guest links sind in dieser Dev-Installation aktiviert. Es wurde kein echter
Thread als Gastlink veröffentlicht und keine produktive Automation angelegt.
Der Nutzer wählt weiterhin Thread, Freigabe und Automation-Prompt selbst.

Das öffentliche Root-Zertifikat zum Einrichten der Geräte liegt zusätzlich
unter `.tau-dev/tailnet-root.crt`. Der konkrete SHA-256-Fingerabdruck steht
in `.tau-dev/private-tailnet-setup.json` und wird nicht veröffentlicht.

Die CA-Schlüssel dürfen die Maschine nicht verlassen. Geräte bekommen nur
das öffentliche Root-Zertifikat. Nach ausdrücklicher Nutzerfreigabe wurde auf
diesem Mac ein Eintrag im Benutzer-Schlüsselbund eingerichtet, ausschließlich
für die Policy `sslServer` und genau die eingerichtete Tailscale-Adresse. Es gibt kein
allgemeines Vertrauen für andere Namen, andere Policies oder alle Benutzer.
Die bestehenden Trust Settings wurden vorher unter
`.tau-dev/private-tailnet-trust-before.plist` gesichert. Andere Geräte
benötigen ihre eigene einmalige Einrichtung.

macOS prüft den Live-HTTPS-Endpunkt erfolgreich ohne übergebene Test-CA.
Der zusätzliche DNS-SAN desselben Serverzertifikats wird vom System dagegen
abgewiesen: Die Freigabe gilt tatsächlich nur für die genehmigte IP-Adresse.
Eine frische, nicht persistente native WebKit-Instanz lädt die Gastseite
erfolgreich ohne Authentication-Challenge-Override oder Zertifikats-Ausnahme.

**Browsergrenze auf diesem Mac:** Chromium ignoriert Trust-Einträge mit
`kSecTrustSettingsPolicyString`. Das isolierte Browserprofil meldet deshalb
`net::ERR_CERT_AUTHORITY_INVALID`; auch der installierte curl akzeptiert den
hostbeschränkten Eintrag nicht. Der aktuelle
[Chromium-Quellcode](https://chromium.googlesource.com/chromium/src/+/main/net/cert/internal/trust_store_mac.cc#112)
bestätigt diese Einschränkung ausdrücklich. Das Systemvertrauen wurde dafür
nicht erweitert und keine Browserprüfung deaktiviert. Auf diesem Mac ist
der native WebKit-/Safari-Weg zu verwenden. Eine browserübergreifende
Freigabe ist mit dem gegenwärtigen hostbeschränkten Eintrag nicht gegeben.

## Prüfung

- Der vorhandene Tailnet-TLS-Listener der Dev-Installation liefert die
  Gastseite mit HTTP 200. Ein echter HTTPS-Request mit ausdrücklich gesetzter
  privater CA prüfte die Zertifikatskette und die IP-SAN. Der TLS-Socket meldete
  `authorized: true`. Die aktiven Netzwerklistener wurden gegen die eigenen
  Tailscale-Adressen geprüft; es gibt keinen LAN-Wildcard-Listener.
- Der wiederholbare Durchlauf `npm run smoke:sharing-webhooks` startet einen
  vollständigen isolierten Tau-Host, eine echte Runtime mit lokalem Testmodell,
  einen lokalen Tailscale-Serve-Stand-in, einen TLS-Proxy und getrennte
  Browserkontexte. Fünf Schritte bestanden: Signatur/Filter/Replay und echter
  Automation-Lauf; ein Browser je Gastlink; moderierter Vorschlag vor/nach
  Owner-Send; laufende Aktualisierung; Widerruf mit geleerter Gastansicht.
  Alle zugehörigen Testprozesse und Listener wurden beendet.
- Fokussierte Regressionen für den gemeinsamen HTTPS-Helfer, Scheduling und
  Gast-HTTP/Host bestanden, ebenso die Kit- und Renderer-Typprüfung. Der
  Repository-Lint hat keine Fehler; vorhandene Warnungen bleiben.
- Es wurde kein vollständiger Testlauf ausgeführt. Ein Request von einer
  tatsächlich anderen physischen Tailnet-Maschine wurde noch nicht ausgeführt.
  Die lokale HTTPS-Prüfung und der Browser-Smoke werden nicht als solcher
  ausgegeben.

## Bedienung nach Einrichtung des Gerätevertrauens

In Tau Dev den gewünschten Thread öffnen und `Share with a guest…` verwenden.
Die erzeugte Adresse liegt auf dem privaten Tailscale-HTTPS-Endpunkt. Der
Gast braucht Tailnet-Zugang und Vertrauen zur privaten CA. Ein erster Browser
beansprucht den Link. Nach Ablauf oder Widerruf endet der Zugriff.

Automations werden in Tau Dev unter `Automations` mit `When → On webhook`
angelegt. `Webhook endpoint` nennt dieselbe HTTPS-Adresse mit der individuellen
Automation-ID. Der Sender muss im Tailnet sein, der privaten CA vertrauen und
die vorhandenen `X-Tau-*`-HMAC-Header erzeugen. Öffentliche GitHub-SaaS-Webhook-
Absender sind ohne zusätzlichen Tailnet-Runner/Übersetzer nicht erreichbar.
Der Payload bleibt ein Auslöser/Filter und wird nicht automatisch zum Prompt.

Tau Dev und sein Host müssen laufen. Es wurde kein Systemdienst installiert.
Für dauerhaftes Arbeiten nach Appende wäre dessen Einrichtung ein eigener
Schritt. Die ursprüngliche Nightly und ihre Netzwerkeinstellungen bleiben
erhalten. Keine Commits oder Pushes.
