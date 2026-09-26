#!/bin/bash
# electron-builder's after-install.tpl (app-builder-lib 26.16), with two changes:
# /usr/bin/${executable} is Tau's command wrapper (bin/tau), and the AppArmor
# profile is written wherever AppArmor's tools are installed, loaded only where
# AppArmor runs.

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
