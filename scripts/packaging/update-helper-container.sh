#!/bin/bash
# The .deb's update helper and polkit grant, for real, in a throwaway Debian
# container (K103). Run from the repository after `npm run build`:
#
#   docker run --rm -v "$PWD:/src:ro" node:22-bookworm bash /src/scripts/packaging/update-helper-container.sh
#
# For polkit 0.105 (its .pkla), the same on ubuntu:22.04 with Node 22's binary
# mounted at /usr/local/bin/node.
#
# It builds stand-in `tau` packages whose /opt/Tau/tau is Node (the helper runs
# on it exactly as it runs on Electron as Node), with the real helper, wrapper,
# polkit files and maintainer scripts; serves a release feed on loopback,
# signed with a throwaway key that the stand-in packages' helper lists instead
# of the release key;
# starts D-Bus and polkitd; and installs, refuses and removes as a user in
# `sudo` with no session and no password, and as one outside it.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

pass() { echo "✓ $*"; }
fail() { echo "✗ $*" >&2; exit 1; }

apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends pkexec polkitd dbus >/dev/null 2>&1 \
  || apt-get install -y -qq --no-install-recommends policykit-1 dbus >/dev/null
echo "polkit $(dpkg-query -W -f='${Version}' polkitd 2>/dev/null || dpkg-query -W -f='${Version}' policykit-1)"
mkdir -p /run/dbus
dbus-daemon --system --fork
for polkitd in /usr/lib/polkit-1/polkitd /usr/lib/policykit-1/polkitd; do [ -x "$polkitd" ] && break; done
"$polkitd" --no-debug >/tmp/polkitd.log 2>&1 &
sleep 1
useradd -m -G sudo rex
useradd -m guest
ARCH="$(dpkg --print-architecture)"
case "$ARCH" in amd64) INFO=latest-linux.yml ;; *) INFO="latest-linux-$ARCH.yml" ;; esac
FEED=/tmp/feed
mkdir -p "$FEED" /etc/tau
echo '{"feedUrl":"http://127.0.0.1:8765/"}' > /etc/tau/update-helper.json
SIGNING=/src/scripts/packaging/release-signing.mjs
node "$SIGNING" keygen /tmp/release-key.pem >/tmp/keygen.out
TEST_KEY="$(sed -n 's/^public key: *\([^ ]*\).*/\1/p' /tmp/keygen.out)"

# A stand-in tau package of a version; `extra` changes its bytes, not its name.
build() {
  local version="$1" extra="${2:-}"
  local root="/tmp/pkg-$version$extra"
  rm -rf "$root"
  mkdir -p "$root/DEBIAN" "$root/opt/Tau/bin" "$root/opt/Tau/resources/app.asar.unpacked/bin" "$root/opt/Tau/resources/polkit"
  ln -s /usr/local/bin/node "$root/opt/Tau/tau"
  TEST_KEY="$TEST_KEY" node -e '
    const fs = require("fs"); const file = process.argv[1];
    const text = fs.readFileSync("/src/bin/tau-update-helper.mjs", "utf8");
    const keyed = text.replace(/^export const RELEASE_PUBLIC_KEYS = \[[^\]]*\];/mu, `export const RELEASE_PUBLIC_KEYS = [${JSON.stringify(process.env.TEST_KEY)}];`);
    if (keyed === text) throw new Error("no key list in the helper");
    fs.writeFileSync(file, keyed);
  ' "$root/opt/Tau/resources/app.asar.unpacked/bin/tau-update-helper.mjs"
  cp /src/packaging/linux/tau-update-helper /src/packaging/linux/tau "$root/opt/Tau/bin/"
  cp /src/packaging/linux/polkit/* "$root/opt/Tau/resources/polkit/"
  printf 'provider: github\nowner: Rasalas\nrepo: tau-releases\n' > "$root/opt/Tau/resources/app-update.yml"
  echo "$version$extra" > "$root/opt/Tau/resources/version"
  printf 'Package: tau\nVersion: %s\nArchitecture: %s\nMaintainer: Test <test@example.invalid>\nDescription: stand-in for Tau\n' "${version//-/\~}" "$ARCH" > "$root/DEBIAN/control"
  sed 's/\${sanitizedProductName}/Tau/g; s/\${executable}/tau/g' /src/packaging/linux/after-install.tpl > "$root/DEBIAN/postinst"
  sed 's/\${sanitizedProductName}/Tau/g; s/\${executable}/tau/g' /src/packaging/linux/after-remove.tpl > "$root/DEBIAN/postrm"
  chmod 0755 "$root/DEBIAN/postinst" "$root/DEBIAN/postrm"
  dpkg-deb --root-owner-group -b "$root" "/tmp/Tau_${version}${extra}_${ARCH}.deb" >/dev/null
}

# The feed names `version` and the checksum of the package built for it, signed unless `unsigned`.
publish() {
  local version="$1" file="/tmp/Tau_$1_${ARCH}.deb"
  local sha512 size
  sha512="$(node -e 'process.stdout.write(require("crypto").createHash("sha512").update(require("fs").readFileSync(process.argv[1])).digest("base64"))' "$file")"
  size="$(stat -c %s "$file")"
  printf 'version: %s\nfiles:\n  - url: Tau_%s_%s.deb\n    sha512: %s\n    size: %s\npath: Tau_%s_%s.deb\n' "$version" "$version" "$ARCH" "$sha512" "$size" "$version" "$ARCH" > "$FEED/$INFO"
  rm -f "$FEED/$INFO.sig"
  [ "${2:-}" = unsigned ] || TAU_RELEASE_SIGNING_KEY="$(cat /tmp/release-key.pem)" node "$SIGNING" sign "$FEED/$INFO" >/dev/null
}

installed() { dpkg-query -W -f='${Version}' tau; }
as() { local user="$1"; shift; runuser -u "$user" -- "$@"; }
helper() { local user="$1" file="$2"; shift 2; as "$user" pkexec --disable-internal-agent /opt/Tau/bin/tau-update-helper "$@" < "$file"; }

node -e '
  const { createServer } = require("http"); const { readFile } = require("fs");
  createServer((q, r) => readFile("/tmp/feed" + q.url.replace(/\.\./g, ""), (e, b) => { r.statusCode = e ? 404 : 200; r.end(e ? "" : b); })).listen(8765, "127.0.0.1");
' >/tmp/feed.log 2>&1 &
sleep 1

build 0.7.6
build 0.7.14
build 0.7.14 -tampered
build 0.7.15
dpkg -i "/tmp/Tau_0.7.6_${ARCH}.deb" >/dev/null
[ "$(installed)" = 0.7.6 ] || fail "0.7.6 did not install"
for file in /usr/share/polkit-1/actions/de.tbuck.tau.update.policy /usr/share/polkit-1/rules.d/50-tau-update.rules /var/lib/polkit-1/localauthority/10-vendor.d/50-tau-update.pkla; do
  [ -f "$file" ] || fail "postinst did not install $file"
done
[ "$(stat -c '%U %a' /opt/Tau/bin/tau-update-helper)" = "root 755" ] || fail "the helper is not root's"
pass "the package puts the helper (root, 0755), the polkit action, the rule and the .pkla in place"
sleep 1

as rex sh -c 'pkcheck --action-id de.tbuck.tau.update --process $$' || fail "polkit does not allow rex (group sudo) without a password"
if as guest sh -c 'pkcheck --action-id de.tbuck.tau.update --process $$' 2>/dev/null; then fail "polkit allows guest"; fi
pass "pkcheck: rex (sudo, no session) is allowed without a password, guest is not"

publish 0.7.14 unsigned
set +e
helper rex "/tmp/Tau_0.7.14_${ARCH}.deb" install --version 0.7.14 2>/tmp/out; code=$?
set -e
[ "$code" = 65 ] && grep -q "release key" /tmp/out || fail "an unsigned feed was not refused (exit $code): $(cat /tmp/out)"
[ "$(installed)" = 0.7.6 ] || fail "a package from an unsigned feed was installed"
pass "the helper refuses a feed without the release key's signature: $(tail -n 1 /tmp/out)"

publish 0.7.14
set +e
helper guest "/tmp/Tau_0.7.14_${ARCH}.deb" install --version 0.7.14 2>/tmp/out; code=$?
set -e
[ "$code" = 126 ] || [ "$code" = 127 ] || fail "guest ran the helper (exit $code): $(cat /tmp/out)"
[ "$(installed)" = 0.7.6 ] || fail "guest changed the package"
pass "pkexec refuses guest (exit $code)"

set +e
helper rex "/tmp/Tau_0.7.14-tampered_${ARCH}.deb" install --version 0.7.14 2>/tmp/out; code=$?
set -e
[ "$code" = 65 ] && grep -Eq "checksum|larger" /tmp/out || fail "a package that is not the release's was not refused (exit $code): $(cat /tmp/out)"
[ "$(installed)" = 0.7.6 ] || fail "the tampered package was installed"
pass "the helper refuses a package whose checksum is not the release's: $(tail -n 1 /tmp/out)"

for args in "install --version 0.7.14 --file /tmp/x.deb" "install --version ../../etc" "remove --version 0.7.14" "install"; do
  set +e
  # shellcheck disable=SC2086
  helper rex "/tmp/Tau_0.7.14_${ARCH}.deb" $args 2>/tmp/out; code=$?
  set -e
  [ "$code" = 64 ] || fail "\"$args\" was not refused as usage (exit $code)"
done
pass "the helper takes no path and no other action (exit 64)"

helper rex "/tmp/Tau_0.7.14_${ARCH}.deb" install --version 0.7.14 --channel stable >/tmp/out 2>&1 || fail "rex could not install 0.7.14: $(cat /tmp/out)"
[ "$(installed)" = 0.7.14 ] || fail "0.7.14 is not installed"
pass "rex installs 0.7.14 through pkexec with no password and no session: $(grep '^tau-update-helper: installed' /tmp/out)"

set +e
helper rex "/tmp/Tau_0.7.6_${ARCH}.deb" install --version 0.7.6 2>/tmp/out; code=$?
set -e
[ "$code" = 66 ] && [ "$(installed)" = 0.7.14 ] || fail "a downgrade was not refused (exit $code)"
pass "the helper never goes back (exit 66)"

# The host's own side: debInstaller spawns pkexec with the download on its standard input.
publish 0.7.15
mkdir -p /tmp/stage && cp "/tmp/Tau_0.7.15_${ARCH}.deb" /tmp/stage/ && chmod -R a+rX /tmp/stage
as rex node --input-type=module -e "
  const m = await import('/src/dist-electron/main/update-installers.js');
  const installer = m.debInstaller(m.nodeInstallerSystem());
  const blocked = await installer.blocked();
  if (blocked) { console.error('blocked: ' + blocked); process.exit(1); }
  console.log(await installer.install({ version: '0.7.15', channel: 'stable', file: '/tmp/stage/Tau_0.7.15_${ARCH}.deb', sha512: '' }));
" >/tmp/out 2>&1 || fail "the host's deb installer failed: $(cat /tmp/out)"
[ "$(installed)" = 0.7.15 ] && grep -q restart /tmp/out || fail "the host's deb installer did not install 0.7.15: $(cat /tmp/out)"
pass "the host's deb installer (Node, as rex) installs 0.7.15 and asks for a restart"

dpkg -r tau >/dev/null
for file in /usr/share/polkit-1/actions/de.tbuck.tau.update.policy /usr/share/polkit-1/rules.d/50-tau-update.rules /var/lib/polkit-1/localauthority/10-vendor.d/50-tau-update.pkla; do
  [ ! -e "$file" ] || fail "postrm left $file"
done
pass "removing the package removes the polkit files"
echo "update helper container test passed"
