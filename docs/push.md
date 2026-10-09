# Push notifications

The phone app hears of a thread that finished, failed, asks something or hands over to
you ("your turn") while you are away from Tau. Push Kit (`kits/push/`) on your machine
decides when; this page is about how a notification gets to the phone.

"Away" works as on Discord. While you use Tau anywhere (a key, a click or a touch in a
window or the app within the last minutes), Tau tells you there and the phone stays quiet.
News you have not seen by the time you have been away for that long (5 minutes unless
Settings → Push → **When your phone hears** says otherwise) goes to the phone. News you saw
in the meantime is dropped. A window that only has focus but has not been used counts as
away, and so does a window you left for another app.

Apple and Google deliver to the app `de.tbuck.tau` only for a sender that proves it holds
the app's APNs key or the Firebase project's credentials. Your machine does not have
them, and never should. So there are two routes, chosen per platform:

| Route | When | Who reads the text |
|---|---|---|
| **Tau's relay** | The default: no key of your own is saved for that platform. | Only your phone and your machine. Your machine encrypts title and text with a key your phone made for it; nobody on the way can read them. |
| **Your own keys** | You saved an APNs key (iPhone) or a Firebase service account (Android) in Settings → Push. | Apple or Google, as with any push. Your machine sends directly; the relay carries none of its pushes. |

Settings → Push shows under **How pushes travel** which route each platform takes, and
each device row says `relay`, `APNs` or `FCM`.

## What the relay sees

The relay is a single Cloud Function (`relay/`, Firebase project `tau-push-e3c95`,
region `europe-west3`). It holds Tau's APNs key, the Firebase project's own identity and
a key for sealing handles, and nothing else. It has no database and writes nothing to disk.

- The phone always registers with the relay, once for each machine it pairs with, and
  again every 30 days. That includes a machine that sends with keys of its own. The
  relay sees the push token, the platform and the phone's IP address. It answers with a
  *handle*: the token and the time, encrypted under the relay's key. It keeps nothing.
- When your machine sends, the relay sees that handle (which it opens to find the token
  again), the encrypted notification, the id of the key it is encrypted with, an opaque
  collapse id so that a thread's newer notification replaces the older one, and your
  machine's IP address.
- The key id travels in the clear, so the phone knows which key opens a push. It is
  random, but it stays the same for as long as the phone keeps that machine. The relay,
  Apple and Google can therefore tell which pushes come from the same machine to the
  same phone, and count them. They cannot tell from it which machine that is.
- The relay never sees the thread's title, the agent's words, or the thread or host
  ids. They are inside the encrypted part.

Its own logs hold warnings and errors only (FCM or APNs refused a push, APNs is not set
up), as codes: no token, handle, payload or address. Cloud Run also writes a request log
for every call (time, path, status, latency, user agent and caller IP address) and keeps
it for 30 days. To stop that, the project owner can exclude the relay's request log
from the `_Default` sink once:

```sh
gcloud logging sinks update _Default --project tau-push-e3c95 \
  --add-exclusion='name=push-relay-requests,description=Tau push relay request log,filter=resource.type="cloud_run_revision" AND resource.labels.service_name="relay" AND log_id("run.googleapis.com/requests")'
```

Rate limits live in memory: 30 sends in a burst per handle, then one every 6 seconds; 60
per phone over all its handles, then one every 3 seconds; 10 registrations per address,
then one a minute. The address is the last `X-Forwarded-For` entry, the one Google's
front end appends; the entries before it are the caller's to write. At most two
instances run, each taking 10 requests at a time.

Apple and Google see the token, the ciphertext and the key id. An Android phone decrypts
the notification itself and shows the real title and text; a push it cannot decrypt (a
forgotten machine, another key) it drops without showing anything. An iPhone shows **"A
thread needs your attention"** for now; tapping it opens the thread. Decrypting on the
iPhone needs a Notification Service Extension, which is a later ticket. Once it exists,
it will drop a push it cannot decrypt the same way.

## How it works

1. The app gets its push token from iOS or Android. For each host it pairs with, it
   sends `POST /register { platform, token }` to the relay (`PUSH_RELAY_URL` in
   `kits/push/protocol.ts`) and keeps that host's handle in the Keychain or the
   Keystore-backed store. It asks again when the handle is 30 days old, when the token
   changed, or when the host says the relay refused the handle. While the relay cannot
   be reached, a saved handle serves until it is 60 days old; without one the app
   registers without a handle.
2. For each host, the app also makes a random 256-bit key and a random key id once, and
   keeps them in the same store (`mobile/src/push-keys.ts`). Forgetting the host deletes
   its key and its handle.
3. Over the existing pinned TLS connection, the app calls the host's `register`
   command with `{ platform, host, topic?, relay: { handle, keyId, key } }`, without
   the token. The host keeps it in `kit-state/tau.push/devices.json` (mode 0600). A host
   that sends to that platform with a key of its own answers `needsToken`, and the app
   registers again with `token`. A host on the relay route never gets the token and
   drops one an older app still sends; removing a key drops that platform's tokens.
4. For a notification, the host seals `{ title, body, url, kind, tag }` with the phone's
   key and sends `POST /send { handle, payload, collapseId }` to the relay.
5. The relay opens the handle and hands the payload to FCM as a high-priority data
   message `{ sealed }`, or to APNs with the generic alert, `mutable-content: 1` and the
   payload in its own field `sealed`. It tries APNs production first and then the
   sandbox, for a development build's token.
6. On Android, `TauMessagingService` (in the app's native plugin) finds the key by its
   id, decrypts, and shows the notification; a tap opens the thread's `tau://` link. On
   iOS the app decrypts the link when the notification is tapped.

A handle the relay cannot open or that is over 60 days old, a token that FCM calls
unregistered, or one that APNs answers with 410 or `BadDeviceToken`, comes back as
`410 gone`. The host then drops that phone's registration. When the phone next connects
with the same handle, the host answers `renewHandle`, and the phone gets a new one.

### Endpoints

Base URL: `https://europe-west3-tau-push-e3c95.cloudfunctions.net/relay`. Both take and
answer JSON. Bodies are at most 10 KiB; a larger `Content-Length` gets `413` before
anything else is done.

| Request | Answer |
|---|---|
| `POST /register { platform: "ios" \| "android", token }` | `200 { handle }`; `400` for a token that does not look like one; `429` with `Retry-After`. Answers any origin (CORS), since the app's web view calls it. |
| `POST /send { handle, payload, collapseId? }` | `200 { ok: true }`; `410 { error: "gone", reason }` for a handle the relay cannot open (`unknown-handle`), one over 60 days old (`expired-handle`), or a token that is gone for good; `400` for a payload over 3072 characters or outside base64url and dots, or a collapse id over 64; `429`; `502 { error: "upstream", reason }`; `503` for iPhones until the APNs key is set up. |

### Formats

**Handle, version 2** (the relay's own; nobody else opens it):
`base64url(0x02 ‖ keyId ‖ nonce ‖ AES-256-GCM(JSON { p, t, i }) ‖ tag)`, with `p` the
platform, `t` the token, `i` the issue time in Unix seconds, a random 96-bit nonce, a
one-byte key id, and the associated data `"tau-relay-handle" ‖ 0x02 ‖ keyId`. Changing
version or key id makes it fail to open. Version 1, without an issue time, is not read.
A handle is at most 6000 characters, and the longest one with the longest payload and
collapse id fits the body limit.

**Sealed push, version 1** (host to phone):
`1.<keyId>.<base64url(nonce ‖ ciphertext ‖ tag)>`, AES-256-GCM with a random 96-bit
nonce over the JSON `{ title, body, url?, kind?, tag? }`, with the associated data
`tau-push:1:<keyId>`. The host seals with Node's crypto (`kits/push/relay.ts`), the app
opens with WebCrypto (`mobile/src/push-crypto.ts`) and on Android with `javax.crypto`.
The collapse id is `HMAC-SHA256(HKDF-SHA256(key, info "tau-push:collapse"), threadId)`, cut to 22 characters, so
the relay cannot trace it back to a thread.

A new layout gets a new version number; readers refuse versions they do not know.

### Keys

- `RELAY_HANDLE_KEYS` in Secret Manager holds comma-separated `<id>:<32 bytes, base64>`
  entries, ids 1 to 255. The first one seals new handles; every listed one still opens.
  To rotate, put a new key first (`2:…,1:…`) and deploy. Phones get handles under the
  new key as theirs turn 30 days old. Remove the old key 60 days later, when every handle
  it sealed has expired anyway. Removed sooner, its handles answer `410`; each host drops
  that phone and asks it for a new handle when it next connects.
- `APNS_KEY_P8`, `APNS_KEY_ID` and `APNS_TEAM_ID` in Secret Manager hold the team's APNs key.
  Until it exists, any placeholder works (`none`); iPhones then get `503`.
- FCM needs no key file. The function runs as `push-relay-runtime@tau-push-e3c95.iam.gserviceaccount.com`,
  which firebase-admin uses to send.
- The phone makes one push key per host. Only the phone and that host have it.

## Your own keys (self-hosting)

With keys of your own, your machine sends to Apple and Google itself and the relay
carries none of its pushes: Settings → Push → iPhone (APNs key, Key ID, Team ID) or
Android (Firebase service account). The steps are in [mobile-testflight.md](mobile-testflight.md#8-push-notifications).
The phone still registers with the relay for this machine's handle, as it does for
every machine, so the relay sees its token and address then. This is also the way for
your own build of the app under another bundle id. The keys are kept in
`kit-state/tau.push/keys.json` (mode 0600). A saved key that no longer reads shows as an
error in Settings → Push, and that platform's phones get no pushes until you replace or
remove it; Tau does not switch them to the relay. Removing a key switches that platform
back to the relay.

Running a relay of your own takes a build of the app too: the relay's address is a
constant in `kits/push/protocol.ts` and in the app's content security policy
(`mobile/index.html`), and the relay pushes only to `APNS_TOPIC` (`relay/src/senders.ts`).
A host can be pointed at another relay with `TAU_PUSH_RELAY_URL` (https, or http on
loopback).

## Deploying the relay

`.github/workflows/push-relay.yml` checks every change under `relay/` (and
`kits/push/apns.ts`, which the relay bundles): typecheck, tests and build. On `main`, and
when run by hand, it deploys from the GitHub environment `push-relay`. It signs in to
Google through Workload Identity Federation, so no key file exists. It installs the
relay's packages with `--ignore-scripts` before it signs in, so no package's code runs
while the credentials exist, and deploys with the `firebase-tools` pinned in
`relay/package-lock.json`. From a checkout, `npm run relay:deploy` does the same with
your own login (`firebase login`, or `gcloud auth application-default login`).

The deploy runs `firebase deploy --only functions --force` from `relay/`. `--force`
removes functions of the `push-relay` codebase that the source no longer defines, and
sets the Artifact Registry cleanup policy without asking.

### Once, by hand

Project `tau-push-e3c95`, number `712111328256`. Replace the placeholders in angle brackets.

1. **Billing.** Link a billing account (Blaze plan) and set a budget alert at 5 €.
2. **APIs.** Enable `cloudfunctions`, `run`, `cloudbuild`, `artifactregistry`,
   `secretmanager`, `eventarc`, `pubsub`, `storage`, `iamcredentials`, `sts` and `fcm`
   (each `<name>.googleapis.com`).
3. **Secrets.**
   ```sh
   printf '1:%s' "$(openssl rand -base64 32)" | gcloud secrets create RELAY_HANDLE_KEYS --data-file=- --project tau-push-e3c95
   gcloud secrets create APNS_KEY_P8 --data-file=AuthKey_<KEYID>.p8 --project tau-push-e3c95
   printf '<KEYID>' | gcloud secrets create APNS_KEY_ID --data-file=- --project tau-push-e3c95
   printf '<TEAMID>' | gcloud secrets create APNS_TEAM_ID --data-file=- --project tau-push-e3c95
   ```
   Keep the `.p8` file, its Key ID and Team ID, and the value of `RELAY_HANDLE_KEYS` in
   the vault as well. Without the APNs key yet, create the three APNs secrets with the
   value `none`.
4. **Runtime service account** `push-relay-runtime`:
   ```sh
   gcloud iam service-accounts create push-relay-runtime --display-name "Push relay (runtime)" --project tau-push-e3c95
   gcloud projects add-iam-policy-binding tau-push-e3c95 --member serviceAccount:push-relay-runtime@tau-push-e3c95.iam.gserviceaccount.com --role roles/firebasecloudmessaging.admin
   for secret in RELAY_HANDLE_KEYS APNS_KEY_P8 APNS_KEY_ID APNS_TEAM_ID; do
     gcloud secrets add-iam-policy-binding $secret --member serviceAccount:push-relay-runtime@tau-push-e3c95.iam.gserviceaccount.com --role roles/secretmanager.secretAccessor --project tau-push-e3c95
   done
   ```
5. **Deploy service account** `push-relay-deployer`, with these project roles:
   `roles/cloudfunctions.developer`, `roles/run.admin` (for the public invoker on the
   function's Cloud Run service), `roles/artifactregistry.admin` (for the cleanup policy),
   `roles/secretmanager.viewer`, `roles/firebase.viewer` and
   `roles/serviceusage.serviceUsageConsumer`. It also needs `roles/iam.serviceAccountUser`
   on `push-relay-runtime@…` and on the default compute account
   `712111328256-compute@developer.gserviceaccount.com`, which Cloud Build runs as. This
   list follows Firebase's documentation for 2nd-gen functions. If the first deploy
   names a permission that is missing, grant it and run the workflow again.
6. **Workload Identity Federation.** A pool `github` with an OIDC provider `tau-repo`:
   ```sh
   gcloud iam workload-identity-pools create github --location global --display-name GitHub --project tau-push-e3c95
   gcloud iam workload-identity-pools providers create-oidc tau-repo --location global --workload-identity-pool github \
     --issuer-uri https://token.actions.githubusercontent.com \
     --attribute-mapping 'google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner_id=assertion.repository_owner_id,attribute.environment=assertion.environment' \
     --attribute-condition "assertion.repository_owner_id == '7483565' && assertion.repository == 'Rasalas/tau'" \
     --project tau-push-e3c95
   gcloud iam service-accounts add-iam-policy-binding push-relay-deployer@tau-push-e3c95.iam.gserviceaccount.com --role roles/iam.workloadIdentityUser \
     --member 'principalSet://iam.googleapis.com/projects/712111328256/locations/global/workloadIdentityPools/github/attribute.environment/push-relay' \
     --project tau-push-e3c95
   ```
   Only a job in the `push-relay` environment of `Rasalas/tau` can act as the deployer. The binding
   uses the environment attribute, not the subject: this repository's OIDC subject carries
   immutable ids (`repo:Rasalas@7483565/tau@1395847403:…`).
7. **Allowed actions.** Settings → Actions allows only selected actions; add
   `google-github-actions/auth@*`.
8. **GitHub environment** `push-relay` (Settings → Environments): deployment branches
   `main` only, and three variables:

   | Variable | Value |
   |---|---|
   | `PUSH_RELAY_WIF_POOL` | `github` |
   | `PUSH_RELAY_WIF_PROVIDER` | `tau-repo` |
   | `PUSH_RELAY_SERVICE_ACCOUNT` | `push-relay-deployer@tau-push-e3c95.iam.gserviceaccount.com` |

   The deploy job stops with an error that names any variable left out.

After the first deploy, `curl -si -X POST <base URL>/register -d '{}'` should answer
`400`. A test push from Settings → Push on a machine without keys of its own should
reach the phone.

A domain of our own (`push.tbuck.de`) would need a Firebase Hosting rewrite or a Cloud
Run domain mapping, a new `PUSH_RELAY_URL`, and the new origin in `mobile/index.html`.

## Testing

`relay/src/*.test.ts` run with the repository's `npm test`, with FCM mocked and APNs
answered by a loopback fake. They never reach Google or Apple. `relay/src/index.ts`, the
Firebase entry, is checked by `npm --prefix relay run typecheck` after
`npm --prefix relay ci`. For the host, `node scripts/push-fakes.mjs` also starts a fake
relay and prints `TAU_PUSH_RELAY_URL`. Its handles are only encoded, and it records every
send in `.tau-dev/push-fakes/pushes.jsonl` ([testing-the-app.md](agents/testing-the-app.md)).

### Native agent activity

The mobile app opts Android devices into ongoing cards with `activity-enable`.
Running, needs-input and completed lifecycle data travels inside the existing
sealed payload. A data message updates the card rather than creating another
alert. Android 16-compatible systems may promote an ongoing card as a Live
Update; system permissions and policy still decide.

An iPhone gets one Live Activity per host for all of its top-level threads
(thread id `tau.threads`, K163); Android keeps a card per thread. The host's
content lists up to four rows (a question first, running threads, then those
that ended within fifteen minutes), each with id, title, state, start, end and
the question or failure, kept under 1.7 KB inside the sealed payload. The first
thread at work starts the activity; the last one to end ends it.

Each iOS Live Activity has its own APNs update token. The phone registers that
token with the relay using `purpose: "activity"`, installs its content key in
the shared app/widget Keychain, and gives the host an opaque handle. Activity
handles use handle version 3, which an older relay cannot treat as alert tokens.
The relay validates the sealed handle's purpose against the requested update
metadata, then sends `apns-push-type: liveactivity` to
`de.tbuck.tau.push-type.liveactivity`. The content-state contains only ciphertext.
Host, thread, title and work state open in the widget on the device.

This is a source-level protocol addition. It needs the matching relay revision
and signed app/widget provisioning profiles before real background delivery.
No deployment, store rollout or real push send is part of the automated tests.
Foreground starts use this update path. Opt-in remote starts use the separate
flow below.

### Starting iOS Live Activities remotely

On iOS 17.2 or later, the phone's Hosts screen has a **Live Activities** switch
for each paired host. It starts off disabled. Enabling it lets that host start a
Live Activity for a new turn while the phone app is closed. Safari and the web
workbench do not offer this switch. Android keeps its existing ongoing cards.

Remote starts always use the encrypted Tau relay, including when a host uses its
own key for ordinary alerts. The phone keeps a separate activity key per host;
disabling activities does not disable alerts. It registers ActivityKit's rotating
push-to-start token as `purpose: "activity-start"` and gives the host the sealed
handle, the activity key and affirmative consent over its pinned connection.
The host stores consent for 30 days. Reconnecting an enabled phone renews it.

Start handles use version 3 with an authenticated `activity-start` purpose.
They cannot send alerts or updates; update handles cannot start an activity.
The relay rejects expired handles, invalid timestamps, unsafe startup attributes
and oversized payloads. APNs receives the `liveactivity` topic and push type,
a generic "Agent work started" alert, an opaque random activity id, and encrypted
bootstrap/content state. Host ids, thread ids and titles stay encrypted. The
start push expires at APNs after 60 seconds; its activity can live for eight hours.

Activity ciphertext version 2 authenticates
`tau-activity:2:<keyId>:<start|update>:<activityId>:<tokenHash>` as AES-GCM associated
data. `tokenHash` is empty for a start and SHA-256 of the activity's current APNs
token bytes for an update. Only the app holds paired credentials. Its extension
can read the dedicated content key and token binding from the shared Keychain,
validate the decrypted identity, state and expiry, and construct the thread link.
The existing version 1 activity update reader remains available for older starts.

The app starts its native ActivityKit observers at launch before Capacitor. When
iOS wakes it for a remote start, it observes the new activity and registers its
update token through the relay and an authenticated pinned host socket. It also
observes token rotation and terminal activity states. An update token arriving
after a turn finished gets the final state immediately. Reconnect/launch retries
current tokens after a temporary network failure. The host sends at most three
remote start attempts per phone per hour, keeps one active activity per phone and persists its state and start history across
restarts. A run after all threads ended starts another activity. APNs acceptance does not prove
that the system displayed an activity.

Turning the switch off first records a native disable marker, ends this host's
activities and deletes its shared content key. The phone tells the host to remove
start consent and update registrations; if it is offline, that cleanup retries
on next launch. Removing a host and host-side device removal also clear activity
registrations. A native connection refused with 4401 deletes the paired credential
and ends the host's activities. A start already queued at APNs cannot be recalled,
but the deleted key prevents its private content from opening and the native
observer ends it on wake.

Apple's [ActivityKit push guide](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications)
describes background wake, per-activity token registration and system push budgets.
Its [push-to-start token documentation](https://developer.apple.com/documentation/activitykit/activity/pushtostarttoken)
requires replacing rotated tokens. iOS controls delivery and may throttle starts
or updates; this implementation makes no fixed delivery-rate guarantee. iOS 26
uses the same push-to-start flow, without requiring scheduled activities or broadcast channels.

Release builds carry the widget extension and the App Group since 0.7.31. One
built with `TAU_IOS_WIDGETS=0` ([RELEASE.md](RELEASE.md#ios)) reports Live
Activities as unavailable and never registers activity tokens.
Before real delivery, both signed targets need the app group `group.de.tbuck.tau`
and shared Keychain group `$(AppIdentifierPrefix)de.tbuck.tau.shared`. The main app
also needs APNs and `NSSupportsLiveActivities`; the widget needs a separate profile
for `de.tbuck.tau.widgets`. A main-app-only `IOS_PROFILE` does not establish widget
or shared-group authorization. The unsigned simulator compile and fake-provider
tests cannot verify those entitlements or real delivery. Use the physical-device
steps in [mobile-device-checklist.md](mobile-device-checklist.md).
