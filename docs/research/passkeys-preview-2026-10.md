# Passkeys im Preview-Browser: Apples Entitlement, der T3-Weg und was Tau ohne kann

Recherchiert am 12. Oktober 2026 für `W25-passkeys-research.md`. Frage: Was braucht ein Electron-Browser unter macOS, damit Seiten Passkeys anlegen und nutzen können, wie macht T3 Code das (#16952), und was bleibt für Tau übrig? Gelesen wurden der T3-Checkout (`origin/main` `a27cf8af51`, Commit `454b94a13a`), Apples Dokumentation und Entwicklerforum, die Electron-Dokumentation, die README von `electron-webauthn` und Taus Quellcode. Es wurde nichts bei Apple eingereicht und kein Konto angelegt; das Antragsformular verlangt eine Anmeldung und wurde nicht geöffnet. Nichts wurde gebaut oder ausgeführt.

## Kurzfassung

- T3 baut **zwei Wege**, die Apple unterschiedlich behandelt:
  1. **Touch ID über Electron selbst** (`app.configureWebAuthn`). Es braucht nur das Entitlement `keychain-access-groups` im Provisioning-Profil, keine Prüfung durch Apple. Die Passkeys sind an die Secure Enclave dieses Macs gebunden und werden nicht über iCloud synchronisiert.
  2. **Das System-Blatt von Apple** (iCloud-Schlüsselbund, Passwortmanager, Handy, Sicherheitsschlüssel) über `electron-webauthn` und `AuthenticationServices`. Es braucht das Entitlement `com.apple.developer.web-browser.public-key-credential`, das Apple als „managed capability“ vergibt.
- Für Weg 2 gelten feste Kriterien: Antragsteller ist der Account Holder, die App muss ein **Webbrowser** sein (HTTP- und HTTPS-Schemes in der `Info.plist`, beim Start ein URL-Feld, Suche oder Lesezeichen, Navigation direkt zum Ziel). Tau ist kein Browser. Ein Antrag wäre nur ehrlich, wenn Tau Standardbrowser wird, und genau das haben wir mit #17587 abgelehnt. T3 hat beides am selben Tag (09.10.2026) eingebaut; dass das zusammenhängt, ist meine Vermutung, T3 sagt es nicht.
- Weg 1 ist für Tau machbar, ohne dass Apple etwas freigeben muss, bringt aber wenig: Passkeys nur für diesen Mac und nur im Tau-Profil, jede Nutzung braucht Touch ID des Nutzers. Der Agent kann sich damit nie allein anmelden.
- Windows: Chromium reicht WebAuthn selbst an Windows Hello weiter (T3 tut dort nichts; Clerk bestätigt Windows Hello und Sicherheitsschlüssel). Linux: nur USB-Sicherheitsschlüssel. Beides ist für Tau nicht getestet.
- **Empfehlung:** Keinen Apple-Antrag stellen. Anmeldungen mit Passkey bleiben beim `request_takeover` (Seite im eigenen Browser, Sitzung per Cookie-Import herüberholen). Weg 1 nur als kleines, optionales Ticket mit Spike (`.scratch/passkeys/issues/01-touch-id-passkeys-in-preview.md`, `needs-triage`).

## Was Apple verlangt

Quelle ist Apples Dokumentation des Entitlements (als Markdown-Datenquelle gelesen, weil die HTML-Seite ohne JavaScript leer bleibt):
[`com.apple.developer.web-browser.public-key-credential`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.web-browser.public-key-credential), verfügbar ab macOS 13.3.

- Was es erlaubt: „registration and assertion requests for passkeys and security keys for any relying party identifier“. Dazu gehört die Klasse [`ASAuthorizationWebBrowserPublicKeyCredentialManager`](https://developer.apple.com/documentation/authenticationservices/asauthorizationwebbrowserpublickeycredentialmanager) (macOS 13.3).
- Wer: „you must hold the Account Holder role for an organization’s Apple Developer account and complete the request form at [macOS Browsers Passkeys](https://developer.apple.com/contact/request/macos-browsers-passkeys/)“. Ein Apple-DTS-Ingenieur bestätigt im [Entwicklerforum](https://developer.apple.com/forums/thread/829169) (Juni 2026), dass andere Rollen (Admin, App Manager, Developer, Marketing, Finance) das Formular nicht öffnen können.
- Wie vergeben: „Apple reviews each application using predefined criteria. If your request meets the criteria, Apple adds the entitlement to your developer account using managed capabilities.“ Danach muss das Provisioning-Profil neu erzeugt werden (so beschreibt es auch T3, siehe unten).
- Kriterien, wörtlich: „Only add this entitlement if your app can act as a user’s web browser.“ Die App muss HTTP und HTTPS in der `Info.plist` angeben und beim Start ein URL-Feld, Suchwerkzeuge oder kuratierte Lesezeichen bieten. Beim Öffnen einer URL muss sie direkt zum Ziel navigieren und die erwarteten Inhalte zeigen; „Apps that redirect to unexpected locations or render content not specified in the destination’s source code don’t meet the requirements of a web browser.“ Eingeschränkte Modi (Kindersicherung) sind erlaubt.
- Kosten: Die Doku nennt keine Gebühr. Das Entwicklerprogramm hat Tau ohnehin (Developer-ID-Zertifikat, Notarisierung in `docs/RELEASE.md`).
- Wartezeit: **Nirgends dokumentiert.** Ein Forenbeitrag ([März 2025](https://developer.apple.com/forums/thread/774904)) berichtet von einer Zusage, ohne Dauer oder Plattform.
- Developer-ID-Vertrieb außerhalb des App Stores: Die Doku schränkt das nicht ein. Chrome führt den Schlüssel in seiner [Entitlement-Datei](https://chromium.googlesource.com/chromium/src/+/lkgr/chrome/app/app-entitlements-chrome.plist) (`<true/>`), Firefox Nightly ebenfalls (laut Suchtreffer, [Searchfox](https://arai.searchfox.org/firefox-main/source/security/mac/hardenedruntime/production/nightly.browser.xml), nicht geöffnet). Ein [Forenbeitrag](https://developer.apple.com/forums/thread/790037) (Juni 2025, keine Antwort) beschreibt einen Chromium-Browser außerhalb des Stores mit dem Entitlement, bei dem die Passkey-Anmeldung auf GitHub jedes Mal das Rechnerpasswort abfragt und das Anlegen bei Google fehlschlägt. Das ist ein einzelner Bericht ohne Auflösung.
- Ein Beitrag zu iOS ([Juli 2026](https://developer.apple.com/forums/thread/837755)) zeigt, dass das Formular die Frage „Is your app a web browser on macOS?“ stellt. Apples Antwort dort betrifft iOS und nennt ein anderes Entitlement.
- Das Entitlement ist beschränkt und gehört in ein Provisioning-Profil (siehe T3). Apples Seite zum Profiltyp für Developer ID war nicht lesbar; die Aussage stützt sich auf T3.

**Folgerung für Tau:** Der Preview-Browser ist ein Entwicklerwerkzeug im Panel, ohne http/https-Registrierung und ohne Startseite mit URL-Feld als App. Die Kriterien erfüllt Tau nur, wenn es als Standardbrowser auftritt. Ohne das wäre der Antrag aussichtslos oder müsste Tau als Browser ausgeben. Ein Forenbeitrag ([Thread 790037](https://developer.apple.com/forums/thread/790037)) meldet außerdem, dass ein Antragsteller nach einigen Tagen wieder Fehler sah; das steht nur in einer Suchzusammenfassung und wurde nicht an der Quelle bestätigt.

## Wie T3 es macht

Commit [`454b94a13a`](https://github.com/pingdotgg/t3code/commit/454b94a13a) „passkeys in the in-app browser on macOS (#16952)“, 09.10.2026, Julius Marminge. 24 Dateien, 1762 Zeilen dazu, davon rund 710 Zeilen Produktivcode in `apps/desktop/src/preview/` und rund 700 Zeilen Tests.

- **Zwei Entitlements, jedes nur bei Freigabe.** `scripts/build-desktop-artifact.ts` (`resolveMacWebAuthnEntitlements`, ab Zeile ~1360) liest das Provisioning-Profil und trägt `keychain-access-groups` (`<TEAM>.com.t3tools.t3code.webauthn`) und `com.apple.developer.web-browser.public-key-credential` nur ein, wenn das Profil sie gewährt. Begründung im Code: macOS startet keine App, die mehr beansprucht als ihr Profil erlaubt. Das Ergebnis wird als `t3codeWebAuthn` in die `package.json` der App geschrieben; `Passkeys.ts:144-157` liest es zur Laufzeit. Das Profil kommt als `MACOS_PROVISIONING_PROFILE` (Base64-Secret) in den Build, electron-builder bekommt es als `provisioningProfile`. Die Anleitung steht in T3s [`docs/operations/release.md`](https://github.com/pingdotgg/t3code/blob/454b94a13a/docs/operations/release.md) („macOS Browsers Passkeys form“, danach Profil neu erzeugen).
- **Touch ID (Weg 1):** `Passkeys.ts:159-167` ruft `app.configureWebAuthn({ touchID: { keychainAccessGroup } })`. Dazu hört T3 auf `select-webauthn-account` an der Session (`:168-178`) und zeigt bei mehreren Passkeys einen nativen Dialog. Es braucht keine Brücke.
- **System-Blatt (Weg 2):** Das Paket [`electron-webauthn`](https://github.com/iamEvanYT/electron-webauthn) (MIT, Electron 28+, macOS 12+, Anbindung an `AuthenticationServices` über `objc-js`) liefert `createCredential` und `getCredential`. Weil Electron auf macOS selbst keine Oberfläche dafür hat, überschreibt ein Preload im Gast `navigator.credentials.create/get` (`PasskeyBridge.ts`, 286 Zeilen) und schickt den Aufruf per IPC an den Hauptprozess (`preview-pick-preload.ts:8-9`, Schalter über `--t3code-preview-passkey-bridge`). Dort prüft `Passkeys.ts:182-221`: nur der Hauptframe des Gasts, Ursprung aus `frame.origin` statt aus der Seite, nur `https:` oder `http` auf localhost/127.0.0.1/[::1], die Seite muss den Fokus haben, ein Vorgang gleichzeitig, Frist 10 Minuten plus 5 s, Ergebnis verworfen, wenn die Seite inzwischen woanders ist. `PasskeyBackendMac.ts` erlaubt nur ES256, filtert `allowCredentials` für Sicherheitsschlüssel nach und prüft Public-Suffix-Domains mit `tldts`.
- **Packaging:** `electron-webauthn` bleibt außerhalb des Bundles (`desktop-external-packages.ts`), `typescript` wird als optionaler Peer ausgeschlossen, damit kein Compiler in die App wandert, und die native Abhängigkeit wird per Override gepinnt. Das Modul wird erst beim ersten Vorgang geladen.
- **Windows:** Kommentar in `Passkeys.ts:53`: „Windows needs neither: Chromium already uses Windows Hello there.“ `backendFor` liefert dort keinen Backend.
- **Elektron-Version:** T3 nutzt 44.4.5, Tau `^44.4.4` (installiert 44.4.4). `configureWebAuthn` kam mit Electron 41.5 und 42 (Changelog-Spiegel, [PR #51411](https://github.com/electron/electron/pull/51411) laut Suchtreffer); die [Dokumentation](https://www.electronjs.org/docs/latest/api/app) führt es als macOS-API.
- T3 hat `@clerk/electron-passkeys` und ein Provisioning-Profil mit Associated Domains schon vorher, für den Login in die eigene App (Release-Doku, Schritte 2 und 3). Die Signier-Infrastruktur mit Profil bestand also; Tau hat sie nicht.

## Was Electron selbst kann (Tau: 44.4.4)

Aus der [App-Dokumentation](https://www.electronjs.org/docs/latest/api/app) und der [Session-Dokumentation](https://www.electronjs.org/docs/latest/api/session):

- `app.configureWebAuthn({ touchID: { keychainAccessGroup, promptReason? } })` (macOS). Bis zum Aufruf liefert `isUserVerifyingPlatformAuthenticatorAvailable()` `false`. Der Wert „must also be present in your app’s `keychain-access-groups` code-signing entitlement“, üblich `<TEAM_ID>.<BUNDLE_ID>.webauthn`. Die Zugangsdaten liegen im Schlüsselbund, gebunden an die Secure Enclave; sie „are device-bound and are not synced via iCloud Keychain“ und gibt es nur auf Macs mit Secure Enclave (Apple Silicon oder Intel mit T2).
- Session-Ereignis `select-webauthn-account`: Gibt es mehrere auffindbare Passkeys und keinen Zuhörer, wird die Anfrage abgebrochen. Das Ereignis kann auch bei Sicherheitsschlüsseln anderer Plattformen feuern.
- Die Dokumentation sagt nichts über Windows oder Linux. [Clerks Electron-Doku](https://clerk.com/docs/reference/electron/passkeys.md) ist die einzige Quelle: Windows Hello und Sicherheitsschlüssel gehen im Renderer „out of the box“, Linux nur Sicherheitsschlüssel; Touch ID braucht Electron 42 oder neuer, einen `https://`-Ursprung und kein `localhost`.
- Auf macOS gibt es ohne Entitlement weder iCloud-Schlüsselbund noch Handy (Hybrid/QR) noch eine Auswahl-Oberfläche. Ob USB-Sicherheitsschlüssel auf macOS durch Chromium allein laufen, ist nicht belegt. Vault12 schreibt, dass Electron auf macOS keine native Oberfläche für Passkey- oder Schlüsselauswahl bietet ([Pressemitteilung](https://vault12.com/press-posts/130126-electron-webauthn/)).

## Was Tau heute hat

- Der Preview-Browser verweigert jede Berechtigung (`kits/preview/view.ts:87-88`: `setPermissionRequestHandler` antwortet `false`, `setPermissionCheckHandler` `false`). WebAuthn ist in Chromium keine Berechtigung mit Abfrage; das ist meine Annahme und ungeprüft. Der `WebContentsView` läuft mit `sandbox: true`, `contextIsolation: true` und ohne Preload.
- Es gibt kein `webauthn`, `passkey` oder `configureWebAuthn` im Repo.
- macOS-Build: Developer-ID-Signatur und Notarisierung über electron-builder (`docs/RELEASE.md`, Abschnitt zu den Secrets), `hardenedRuntime: true`, Entitlements nur JIT, unsigned executable memory und Library-Validation aus (`assets/entitlements.mac.plist`). Es gibt **kein Provisioning-Profil** in der Konfiguration (`tooling/electron-builder.yml`, `appId: de.tbuck.tau`). Die Entitlements für Touch ID oder Browser-Passkeys setzen also ein Profil und eine App-ID-Registrierung voraus, die es noch nicht gibt.
- Lokale Builds sind die getrennte App „Tau Dev“ mit anderer Kennung; sie bräuchte eine eigene App-ID und ein eigenes Profil, sonst fehlt Passkey-Unterstützung dort.
- Anmeldungen, die der Agent nicht allein kann, laufen über `request_takeover` (`kits/takeover/`): Karte „Your turn“, „Open in my browser“ für die Seite im Systembrowser und „Bring my browser session over“ (Cookies aus Chrome, Arc, Brave, Edge, Vivaldi, Chromium, Firefox oder Safari über `tau.preview/cookie-import`; `docs/features.md:24`, `docs/CORE.md:462`). Eine Seite, die nur Passkey anbietet, lässt sich so im Systembrowser mit dessen Passkeys anmelden; die Sitzung kommt per Cookie herüber.

## Was ginge ohne das Browser-Entitlement

| Weg | Apple-Prüfung | Plattform | Was der Nutzer bekommt | Aufwand |
|---|---|---|---|---|
| Übergabe an den Systembrowser (`request_takeover` + Cookie-Import) | nein | alle | alle Passkeys des Nutzers, Sitzung kommt per Cookie herüber | besteht |
| Touch ID über `app.configureWebAuthn` | nein, nur App-ID mit Keychain Sharing und Profil | macOS | gerätegebundene Passkeys im Tau-Profil, jede Nutzung per Touch ID; kein iCloud, kein Handy | M, siehe unten |
| Systemblatt über `electron-webauthn` | ja, Browser-Kriterien | macOS | iCloud-Schlüsselbund, Passwortmanager, Handy, Sicherheitsschlüssel | L bis XL, Antrag aussichtslos |
| Windows Hello und USB-Schlüssel | nein | Windows, Linux (nur Schlüssel) | Chromium erledigt es | nichts zu bauen, nur testen |

Zum Touch-ID-Weg im Einzelnen:

- Bau: App-ID `de.tbuck.tau` mit Keychain Sharing, ein Developer-ID-Profil dafür als Secret im Environment `release`, `provisioningProfile` und `keychain-access-groups` (`<TEAM>.de.tbuck.tau.webauthn`) in `electron-builder.yml`, im Code `app.configureWebAuthn` nach dem Start, `select-webauthn-account` an der Preview-Session mit einem nativen Auswahldialog. Eine Brücke und ein Preload sind nicht nötig.
- Risiko: Beansprucht die signierte App ein Entitlement, das das Profil nicht trägt, startet sie nicht. T3 fängt das ab, indem es das Profil im Build liest und nur Gewährtes einträgt; Tau müsste dasselbe tun. Ein Fehler hier trifft jeden Release-Build, nicht nur Passkeys.
- Wert: gering. Der Agent kann sich damit nicht allein anmelden (Touch ID ist Nutzeranwesenheit), und der Passkey gilt nur in diesem Profil auf diesem Mac. Wer sich einmal selbst per Takeover anmeldet, hat die Sitzung per Cookie ohnehin.
- Wenn man ihn doch will: erst ein Spike mit einem lokal signierten Build, bevor das Profil in die CI geht.

## Empfehlung

1. **Keinen Antrag für das Browser-Entitlement stellen.** Tau erfüllt die Kriterien nicht, ohne Standardbrowser zu werden (#17587, abgelehnt). Das System-Blatt (iCloud-Schlüsselbund, Handy) bleibt damit aus.
2. **Das Takeover als Weg für Passkey-Seiten festhalten** und im Preview-Doc nennen: Wer eine Seite nur mit Passkey erreicht, öffnet sie im eigenen Browser und holt die Sitzung herüber.
3. **Touch ID als optionales Ticket** `.scratch/passkeys/issues/01-touch-id-passkeys-in-preview.md` (`needs-triage`). Es ist klein genug für einen Spike, aber der Nutzen ist gering und das Release-Risiko real. Entscheidung beim Nutzer.
4. **Windows und Linux nur prüfen**, wenn jemand es meldet: ein Test mit WebAuthn-Demo-Seite und Windows Hello im Preview. Bis dahin ist die Aussage „Chromium erledigt es“ nur aus T3 und Clerk übernommen.

## Offene Punkte

- Wartezeit und Ablehnungsgründe des Apple-Formulars: nicht ermittelbar ohne Konto-Anmeldung.
- Ob Apple bei einem Entwicklerwerkzeug mit Browser-Panel ein Gespräch zulässt: unbekannt; das Formular fragt „Is your app a web browser on macOS?“ (laut [Forum](https://developer.apple.com/forums/thread/837755)).
- Ob Touch ID im Tau-`WebContentsView` mit eigener Partition (`persist:tau-preview-<name>`) unter Hardened Runtime und `sandbox: true` läuft: T3 beweist es für seine Gäste, nicht für Tau.
- Ob zusätzlich `com.apple.application-identifier` und `com.apple.developer.team-identifier` in die Entitlements müssen: Apples DTS rät dazu, wenn ein beschränktes Entitlement signiert wird ([Forum](https://developer.apple.com/forums/thread/782415)); T3s Vorlage wurde nicht darauf geprüft.
- USB-Sicherheitsschlüssel und Hybrid-QR unter macOS ohne Entitlement: nicht belegt.
- Windows und Linux: aus Clerk-Doku und T3-Kommentar übernommen, nicht in Tau gemessen.
