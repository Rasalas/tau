#!/bin/bash
# electron-builder's after-remove.tpl (app-builder-lib 26.16), for the link
# after-install.tpl makes to /opt/${sanitizedProductName}/bin/${executable}
# and the update helper's polkit files.

# `remove` also runs in the middle of an upgrade; the new package's after-install
# puts both back, so only a real removal takes them away.
if [ "$1" = upgrade ] || [ "$1" = failed-upgrade ]; then
    exit 0
fi

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/bin/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove and unload apparmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi

# The update helper's polkit files (K103).
rm -f /usr/share/polkit-1/actions/de.tbuck.tau.update.policy \
  /usr/share/polkit-1/rules.d/50-tau-update.rules \
  /var/lib/polkit-1/localauthority/10-vendor.d/50-tau-update.pkla
