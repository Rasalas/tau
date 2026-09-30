# Connect in the existing Firebase project

Connect can run as a separate Cloud Run service in `tau-push-e3c95`, the same
Google project as Tau's push function. It uses Google's managed HTTPS URL.
No VM, domain purchase, DNS change or Firebase Hosting rewrite is needed.
The push function keeps its existing deployment and permissions.

This is an optional deployment, not a running service or a free hosted account.
The workflow checks changes on main and pull requests. It publishes only after
someone manually runs `Connect relay` on main with `deploy=true`, through the
`connect-relay` GitHub environment. The default is `false`.

## Operating cost

An open host-control WebSocket keeps Cloud Run handling a request even when no
phone is connected. Request-based billing therefore charges for that instance
while the host stays registered and online. `min=0` avoids a minimum warm
instance; it does not make a standing WebSocket free. Cloud Run closes requests
after at most one hour; Tau's host connector reconnects. See Google's
[WebSocket guidance](https://docs.cloud.google.com/run/docs/triggering/websockets).

The script requests one vCPU, 256 MiB RAM, request-based billing, zero minimum
instances and maximum one instance at both service and revision level, in
`europe-west3`. A host connected for 30 complete days consumes about 720
instance-hours, 2,592,000 vCPU-seconds and 648,000 GiB-seconds. Multiply those
figures by Frankfurt's current regional rates before allowing for remaining
free credits. At the checked rates, USD 0.0000336 per vCPU-second and USD
0.0000035 per GiB-second, that is about USD 89.36 before credits, or USD 84.14
if all CPU/RAM free credits remain unused. Internet transfer, Firestore,
secrets and image storage add charges. Credits are shared with the existing
project and billing account. This is a USD estimate, not a euro invoice or a
spending limit. See [Cloud Run pricing](https://cloud.google.com/run/pricing).

One active process renews its lease every 15 seconds, roughly 5,760 Firestore
document writes and reads per day, plus registrations, probes and retries.
Named databases do not receive Firestore's free quota, so `tau-connect` incurs
usage charges even below 20,000 writes per day.
See [Firestore pricing](https://cloud.google.com/firestore/pricing).

The route and socket limits bound service capacity. Maximum instances is a
scaling setting, not a hard bill limit, and Google may briefly exceed it.
Internet transfer also has no spending cap here. Set a billing alert suited to
a continuously connected host before enabling this deployment. The existing
Compose deployment in [connect.md](connect.md) remains available on a server
the operator already pays for.

## Persistent state and one active process

The dedicated Native-mode database `tau-connect` contains one document,
`tauConnect/state`. It holds at most 100 route ids with SHA-256 hashes of their
separate host and client credentials, a revision fence and a process lease.
It stores no host tokens, enrollment token, projects, messages, files, push
handles or TLS records. Google IAM restricts the two Connect identities to this
database. Deny-all Firebase Security Rules reject mobile/web SDK access.

Only a process with the transactional lease reports `/ready` as healthy.
Every HTTP request and WebSocket upgrade checks readiness again. Both directions
of every byte stream refuse forwarding after its local deadline. A failed
renewal closes every peer immediately. An idle process whose CPU stopped and
whose lease expired attempts to acquire a new lease on the next request.

The remote lease lasts 45 seconds. The process stops forwarding after at most
30 seconds from the start of its renewal request. Google response timestamps
determine remote lease expiry. This leaves a safety interval before another
process can acquire it. Additional instances stay unready and reject traffic.
The service uses both HTTP startup and ongoing readiness probes with session
affinity disabled. Google documents these probes in
[container health checks](https://docs.cloud.google.com/run/docs/configuring/healthchecks).
This remains a single active relay, not a distributed stream service.

Before deployment, the script sets the fence to the deterministic next revision
name. The old process observes it on its next renewal and closes its sockets.
The script preserves the old lease until expiry, so a process that missed the
fence still cannot overlap the new owner. The new revision waits for the lease,
then receives all traffic. Expect a reconnect gap of up to the remaining
45-second lease plus deployment/startup time and client backoff. A rollout is
not zero-downtime. Do not split traffic or keep tagged old revisions active.

On failure the script restores the previous fence and sends 100% of traffic
back to the previous ready revision. A failed first deployment has no prior
revision; rerun with a fresh suffix after correcting its prerequisites.
If a runner is killed before recovery executes, use the recovery commands below.

## Prerequisites checked without changing Google resources

Read-only inspection on 2026-09-30 found the existing `relay` Cloud Run service,
`gcf-artifacts` repository, push service accounts, and WIF pool/provider
`github` / `tau-repo`. The provider maps the GitHub environment attribute and
restricts repository `Rasalas/tau`, owner id `7483565`.

The following Connect resources were absent:

- The Firestore API is disabled, so no database could be inspected.
- `connect-relay-runtime` and `connect-relay-deployer` service accounts.
- The `tau-connect` Artifact Registry repository and Cloud Run service.
- Secret metadata named `TAU_CONNECT_ADMIN_TOKEN`.
- GitHub environment `connect-relay` and its three federation variables.

The locally installed Google Cloud CLI 557.0.0 lacks `--readiness-probe`.
The deploy script checks support and exits before changing the fence on such
a CLI. The GitHub job installs the current CLI through the pinned setup action.

These commands repeat the relevant read-only checks. They do not read secrets.

```sh
gcloud services list --enabled --project=tau-push-e3c95 --format='value(config.name)' --quiet
gcloud firestore databases describe --database=tau-connect --project=tau-push-e3c95 --quiet
gcloud iam service-accounts list --project=tau-push-e3c95 --format='value(email)' --quiet
gcloud artifacts repositories describe tau-connect --location=europe-west3 --project=tau-push-e3c95 --quiet
gcloud secrets describe TAU_CONNECT_ADMIN_TOKEN --project=tau-push-e3c95 --quiet
gcloud run services describe tau-connect --region=europe-west3 --project=tau-push-e3c95 --quiet
gh api repos/Rasalas/tau/environments/connect-relay/variables
```

## One-time setup after choosing this operating cost

These commands create resources and IAM bindings. They are instructions for
an authorized project administrator; source checks do not run them.

```sh
gcloud services enable firestore.googleapis.com --project=tau-push-e3c95
gcloud firestore databases create --database=tau-connect --location=europe-west3 --type=firestore-native --delete-protection --project=tau-push-e3c95
gcloud artifacts repositories create tau-connect --repository-format=docker --location=europe-west3 --project=tau-push-e3c95
gcloud iam service-accounts create connect-relay-runtime --display-name='Connect relay runtime' --project=tau-push-e3c95
gcloud iam service-accounts create connect-relay-deployer --display-name='Connect relay deployer' --project=tau-push-e3c95
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' | gcloud secrets create TAU_CONNECT_ADMIN_TOKEN --replication-policy=automatic --data-file=- --project=tau-push-e3c95
gcloud secrets add-iam-policy-binding TAU_CONNECT_ADMIN_TOKEN --member=serviceAccount:connect-relay-runtime@tau-push-e3c95.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --project=tau-push-e3c95
```

For each of `connect-relay-runtime` and `connect-relay-deployer`, grant
`roles/datastore.user` only for the Connect database:

```sh
for identity in connect-relay-runtime connect-relay-deployer; do
  gcloud projects add-iam-policy-binding tau-push-e3c95 \
    --member="serviceAccount:$identity@tau-push-e3c95.iam.gserviceaccount.com" \
    --role=roles/datastore.user \
    --condition='expression=resource.name=="projects/tau-push-e3c95/databases/tau-connect",title=connect-database'
done
```

These conditions follow Google's
[per-database access instructions](https://docs.cloud.google.com/firestore/native/docs/manage-databases#configure-per-database-access-permissions).
Runtime has no FCM role and cannot read any APNs or push handle secret. Deployer
can change the revision fence but does not need the enrollment secret's value.
Grant its image, identity and secret-metadata permissions:

```sh
gcloud artifacts repositories add-iam-policy-binding tau-connect --location=europe-west3 --member=serviceAccount:connect-relay-deployer@tau-push-e3c95.iam.gserviceaccount.com --role=roles/artifactregistry.writer --project=tau-push-e3c95
gcloud iam service-accounts add-iam-policy-binding connect-relay-runtime@tau-push-e3c95.iam.gserviceaccount.com --member=serviceAccount:connect-relay-deployer@tau-push-e3c95.iam.gserviceaccount.com --role=roles/iam.serviceAccountUser --project=tau-push-e3c95
gcloud secrets add-iam-policy-binding TAU_CONNECT_ADMIN_TOKEN --member=serviceAccount:connect-relay-deployer@tau-push-e3c95.iam.gserviceaccount.com --role=roles/secretmanager.viewer --project=tau-push-e3c95
gcloud projects add-iam-policy-binding tau-push-e3c95 --member=serviceAccount:connect-relay-deployer@tau-push-e3c95.iam.gserviceaccount.com --role=roles/serviceusage.serviceUsageConsumer
gcloud projects add-iam-policy-binding tau-push-e3c95 --member=serviceAccount:connect-relay-deployer@tau-push-e3c95.iam.gserviceaccount.com --role=roles/run.admin
gcloud iam service-accounts add-iam-policy-binding connect-relay-deployer@tau-push-e3c95.iam.gserviceaccount.com --role=roles/iam.workloadIdentityUser \
  --member='principal://iam.googleapis.com/projects/712111328256/locations/global/workloadIdentityPools/github/subject/repo:Rasalas/tau:environment:connect-relay' --project=tau-push-e3c95
```

`roles/run.admin` is needed for initial service creation and its public invoker
binding. It is broad at project scope during bootstrap. After the first deploy,
grant it on the `tau-connect` service, add project `roles/run.viewer` for the
script's listing and status checks, then remove the project-wide admin grant.
The existing push deployer's account and bindings stay separate. See Google's
[deployment roles](https://docs.cloud.google.com/run/docs/deploying#required_roles).

In the Firebase or Google Cloud console, select the named `tau-connect` database
and publish `connect-relay/firestore.rules`, which denies all client SDK reads
and writes. OAuth service-account access uses IAM instead of these rules. See
[Firebase Security Rules](https://firebase.google.com/docs/firestore/security/get-started).

Create GitHub environment `connect-relay`, restrict deployment branches to main,
and set these variables. Reuse the existing provider, not the push deployer.

| Variable | Value |
|---|---|
| `CONNECT_RELAY_WIF_POOL` | `github` |
| `CONNECT_RELAY_WIF_PROVIDER` | `tau-repo` |
| `CONNECT_RELAY_SERVICE_ACCOUNT` | `connect-relay-deployer@tau-push-e3c95.iam.gserviceaccount.com` |

## Publish and verify

Run the `Connect relay` workflow on main with `deploy=true`. It tests and builds
before authenticating, pushes an image, resolves its immutable digest, fences
the next revision, deploys it and checks `/ready`. The service URL appears in
the final step. Use that exact HTTPS URL in Tau's Connections settings.
Keep the enrollment credential private, transferring it through a private token
file or the settings field. Never put it in a URL or a command argument.

After deployment, register a test host, pair an approved native client, restart
the relay revision and verify the saved route reconnects. Then revoke the route
and confirm its sockets close. This live verification has not been run by the
source tests. The local tests cover credential roles, browser authentication,
transaction retries, lease ownership, process replacement, failed renewal and
failed-deploy rollback with fake Google endpoints.

For manual recovery, select the intended existing revision explicitly:

```sh
node connect-relay/cloud-state.mjs tau-connect-<known-good-suffix>
gcloud run services update-traffic tau-connect --to-revisions=tau-connect-<known-good-suffix>=100 --clear-tags --region=europe-west3 --project=tau-push-e3c95 --quiet
```

Wait for any prior lease to expire, then verify the service's `/ready` endpoint.
Do not erase the state document to recover traffic; that would erase all routes.
