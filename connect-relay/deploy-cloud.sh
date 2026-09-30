#!/usr/bin/env bash
set -euo pipefail

# Build/push the image before calling this script. This script writes cloud state.
if [[ $# != 2 || ! "$1" =~ ^europe-west3-docker\.pkg\.dev/tau-push-e3c95/tau-connect/relay@sha256:[a-f0-9]{64}$ || ! "$2" =~ ^[a-z0-9][a-z0-9-]{0,38}$ ]]; then
  echo 'Usage: deploy-cloud.sh <tau-connect image digest> <revision suffix>' >&2
  exit 2
fi
cd "$(dirname "$0")"
image="$1"
revision="tau-connect-$2"
deploy_help="$(gcloud run deploy --help)"
if [[ "$deploy_help" != *--readiness-probe* ]]; then
  echo 'Update the Google Cloud CLI; this deployment requires --readiness-probe. No fence was changed.' >&2
  exit 1
fi
existing_service="$(gcloud run services list --project=tau-push-e3c95 --region=europe-west3 --filter='metadata.name=tau-connect' --format='value(metadata.name)' --quiet)"
previous_revision=""
if [[ -n "$existing_service" ]]; then
  previous_revision="$(gcloud run services describe tau-connect --project=tau-push-e3c95 --region=europe-west3 --format='value(status.latestReadyRevisionName)' --quiet)"
fi
gcloud firestore databases describe --project=tau-push-e3c95 --database=tau-connect --format='value(type)' --quiet
gcloud secrets describe TAU_CONNECT_ADMIN_TOKEN --project=tau-push-e3c95 --format='value(name)' --quiet

rollback() {
  local result=$?
  if [[ $result != 0 && -n "$previous_revision" ]]; then
    echo 'Deployment failed; restoring the previous revision fence and traffic.' >&2
    node cloud-state.mjs "$previous_revision" || echo 'Fence restoration failed; use the documented recovery commands.' >&2
    gcloud run services update-traffic tau-connect --project=tau-push-e3c95 --region=europe-west3 --to-revisions="$previous_revision=100" --quiet || echo 'Traffic restoration failed; use the documented recovery commands.' >&2
  fi
  exit "$result"
}
trap rollback EXIT
node cloud-state.mjs "$revision"
gcloud run deploy tau-connect \
  --project=tau-push-e3c95 --region=europe-west3 --image="$image" \
  --revision-suffix="$2" --service-account=connect-relay-runtime@tau-push-e3c95.iam.gserviceaccount.com \
  --allow-unauthenticated --ingress=all --port=8787 --no-use-http2 --no-session-affinity \
  --timeout=3600s --concurrency=512 --cpu=1 --memory=256Mi --min=0 --max=1 --max-instances=1 \
  --cpu-throttling --execution-environment=gen2 \
  --set-env-vars=TAU_CONNECT_BIND=0.0.0.0,TAU_CONNECT_BEHIND_TLS_PROXY=1,TAU_CONNECT_FIRESTORE_PROJECT=tau-push-e3c95,TAU_CONNECT_FIRESTORE_DATABASE=tau-connect \
  --set-secrets=TAU_CONNECT_ADMIN_TOKEN=TAU_CONNECT_ADMIN_TOKEN:latest \
  --startup-probe=httpGet.path=/ready,httpGet.port=8787,periodSeconds=5,timeoutSeconds=5,failureThreshold=48 \
  --readiness-probe=httpGet.path=/ready,httpGet.port=8787,periodSeconds=5,timeoutSeconds=5,failureThreshold=1,successThreshold=1 \
  --quiet
gcloud run services update-traffic tau-connect --project=tau-push-e3c95 --region=europe-west3 --to-revisions="$revision=100" --clear-tags --quiet
relay_url="$(gcloud run services describe tau-connect --project=tau-push-e3c95 --region=europe-west3 --format='value(status.url)' --quiet)"
curl --fail --silent --show-error --retry 12 --retry-all-errors --retry-delay 5 "$relay_url/ready"
printf '\nConnect relay: %s\n' "$relay_url"
