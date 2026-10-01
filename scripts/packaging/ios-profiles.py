#!/usr/bin/env python3
"""Install App Store profiles and prepare signing settings for each iOS target."""
import base64
import datetime
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tempfile

TEAM = "V4MWQ28RZ2"
GROUP = "group.de.tbuck.tau"
TARGETS = [("IOS_PROFILE", "App", "de.tbuck.tau"), ("IOS_WIDGET_PROFILE", "TauWidgets", "de.tbuck.tau.widgets")]


def widgets():
    # Without the widgets (K164), the app is built without the App Group too.
    return os.environ.get("TAU_IOS_WIDGETS") == "1"


def validate(profile, bundle, group=True):
    entitlements = profile.get("Entitlements", {})
    prefix = profile.get("ApplicationIdentifierPrefix", [])
    if profile.get("TeamIdentifier") != [TEAM] or prefix != [TEAM]:
        raise ValueError(f"The profile for {bundle} must belong to team {TEAM}.")
    if entitlements.get("application-identifier") != f"{TEAM}.{bundle}":
        raise ValueError(f"The profile must name the explicit App ID {bundle}.")
    if group and GROUP not in entitlements.get("com.apple.security.application-groups", []):
        raise ValueError(f"The profile for {bundle} must allow App Group {GROUP}.")
    shared = f"{TEAM}.de.tbuck.tau.shared"
    keychains = entitlements.get("keychain-access-groups", [])
    if not any(value == shared or value.endswith("*") and shared.startswith(value[:-1]) for value in keychains):
        raise ValueError(f"The profile for {bundle} must allow the shared Tau keychain group.")
    expires = profile.get("ExpirationDate")
    if not isinstance(expires, datetime.datetime) or expires.replace(tzinfo=datetime.timezone.utc) <= datetime.datetime.now(datetime.timezone.utc):
        raise ValueError(f"The profile for {bundle} has expired.")
    if entitlements.get("get-task-allow") or profile.get("ProvisionedDevices") or profile.get("ProvisionsAllDevices"):
        raise ValueError(f"The profile for {bundle} must be an App Store distribution profile.")
    if bundle == "de.tbuck.tau" and entitlements.get("aps-environment") != "production":
        raise ValueError("The app profile must allow production push notifications.")
    uuid = profile.get("UUID", "")
    if not re.fullmatch(r"[A-Fa-f0-9-]{36}", uuid):
        raise ValueError(f"The profile for {bundle} has an invalid UUID.")
    return uuid


def install(output):
    app = os.environ.get("IOS_PROFILE", "")
    widget = os.environ.get("IOS_WIDGET_PROFILE", "") if widgets() else ""
    targets = TARGETS if widgets() else TARGETS[:1]
    if not app and not widget:
        return False
    if widgets() and (not app or not widget):
        raise ValueError("Manual iOS signing requires both IOS_PROFILE and IOS_WIDGET_PROFILE. Each target needs its own App Store profile.")
    if not app:
        raise ValueError("Manual iOS signing requires IOS_PROFILE.")
    destination = Path.home() / "Library/MobileDevice/Provisioning Profiles"
    checked = []
    with tempfile.TemporaryDirectory(prefix="tau-ios-profiles-") as staging:
        for secret, target, bundle in targets:
            try:
                encoded = base64.b64decode(os.environ[secret], validate=True)
            except ValueError as error:
                raise ValueError(f"{secret} must contain a base64 provisioning profile.") from error
            source = Path(staging) / f"{target}.mobileprovision"
            source.write_bytes(encoded)
            source.chmod(0o600)
            decoded = subprocess.run(["security", "cms", "-D", "-i", str(source)], capture_output=True)
            if decoded.returncode:
                raise ValueError(f"{secret} is not a readable signed provisioning profile.")
            profile = plistlib.loads(decoded.stdout)
            checked.append((target, bundle, validate(profile, bundle, widgets()), encoded))
        # Validate every profile before publishing any.
        destination.mkdir(parents=True, exist_ok=True)
        for _, _, uuid, encoded in checked:
            path = destination / f"{uuid}.mobileprovision"
            path.write_bytes(encoded)
            path.chmod(0o600)
    output.mkdir(parents=True, exist_ok=True)
    settings = ["CODE_SIGN_STYLE = Manual", "CODE_SIGN_IDENTITY = Apple Distribution", f"DEVELOPMENT_TEAM = {TEAM}"]
    settings += [f"TAU_PROFILE_{target} = {uuid}" for target, _, uuid, _ in checked]
    # TARGET_NAME is resolved for each build target. Never give the widget the app's profile.
    settings += ["PROVISIONING_PROFILE_SPECIFIER = $(TAU_PROFILE_$(TARGET_NAME))"]
    (output / "profiles.xcconfig").write_text("\n".join(settings) + "\n")
    (output / "profiles.json").write_text(json.dumps({bundle: uuid for _, bundle, uuid, _ in checked}))
    return True


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("usage: ios-profiles.py <signing output directory>")
        if install(Path(sys.argv[1])):
            print("Installed validated App and TauWidgets distribution profiles." if widgets() else "Installed the validated App distribution profile; TauWidgets is left out.")
    except (ValueError, plistlib.InvalidFileException, OSError) as error:
        print(f"::error::{error}", file=sys.stderr)
        sys.exit(1)
