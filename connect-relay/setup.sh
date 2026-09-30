#!/bin/sh
set -eu
if [ "$#" != 2 ]; then echo 'usage: ./setup.sh <real DNS name> <certificate contact email>' >&2; exit 1; fi
case "$1" in *[!a-zA-Z0-9.-]*|'') echo 'Invalid DNS name' >&2; exit 1;; esac
case "$2" in *[!a-zA-Z0-9@._+-]*|'') echo 'Invalid contact email' >&2; exit 1;; esac
[ ! -e .env ] || { echo '.env exists; preserve the current registration token' >&2; exit 1; }
command -v openssl >/dev/null
umask 077
token=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')
printf 'CONNECT_DOMAIN=%s\nACME_EMAIL=%s\nTAU_CONNECT_ADMIN_TOKEN=%s\n' "$1" "$2" "$token" > .env
echo 'Wrote .env with a new enrollment token. Start with docker compose up --build -d.'
