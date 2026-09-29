#!/bin/bash
# electron-builder's after-install.tpl (app-builder-lib 26.16), with three changes:
# /usr/bin/${executable} is Tau's command wrapper (bin/tau), the AppArmor
# profile is written wherever AppArmor's tools are installed, loaded only where
# AppArmor runs, and the update helper's polkit files are put in place.

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/bin/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/bin/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/bin/${executable}' '/usr/bin/${executable}'
fi

# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# The profile lets Chromium use user namespaces where Ubuntu 24.04+ restricts
# them. The dry run skips AppArmor without abi/4.0 (Ubuntu 22.04), which needs none.
APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
if hash apparmor_parser 2>/dev/null && [ -d /etc/apparmor.d ]; then
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"
    # Not in a chroot, where an image is prepared and the kernel is not its own.
    if apparmor_status --enabled > /dev/null 2>&1 && ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; }; then
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi

# The update helper (K103): polkit lets the machine's administrators run exactly
# /opt/Tau/bin/tau-update-helper as root without a password, so a host without a
# window updates itself. The .rules file is for polkit 0.106+, the .pkla for 0.105.
POLKIT_SOURCE='/opt/${sanitizedProductName}/resources/polkit'
if [ -d "$POLKIT_SOURCE" ]; then
  install -D -m 0644 "$POLKIT_SOURCE/de.tbuck.tau.update.policy" /usr/share/polkit-1/actions/de.tbuck.tau.update.policy
  install -D -m 0644 "$POLKIT_SOURCE/50-tau-update.rules" /usr/share/polkit-1/rules.d/50-tau-update.rules
  install -D -m 0644 "$POLKIT_SOURCE/50-tau-update.pkla" /var/lib/polkit-1/localauthority/10-vendor.d/50-tau-update.pkla
fi
chown root:root '/opt/${sanitizedProductName}/bin/tau-update-helper' || true
chmod 0755 '/opt/${sanitizedProductName}/bin/tau-update-helper' || true
