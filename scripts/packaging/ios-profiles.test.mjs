import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

// Validate synthetic metadata only. No real profile, certificate or Keychain is read.
const source = String.raw`
import datetime, importlib.util
spec = importlib.util.spec_from_file_location('profiles', 'scripts/packaging/ios-profiles.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def profile(bundle):
    return {
        'TeamIdentifier': [module.TEAM], 'ApplicationIdentifierPrefix': [module.TEAM],
        'UUID': '12345678-1234-1234-1234-123456789012',
        'ExpirationDate': datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=30),
        'Entitlements': {
            'application-identifier': module.TEAM + '.' + bundle,
            'com.apple.security.application-groups': [module.GROUP],
            'keychain-access-groups': [module.TEAM + '.de.tbuck.tau.shared'],
            'aps-environment': 'production',
        },
    }
for bundle in ['de.tbuck.tau', 'de.tbuck.tau.widgets']:
    assert module.validate(profile(bundle), bundle) == '12345678-1234-1234-1234-123456789012'
    for change in ['app', 'group', 'keychain', 'expired', 'development', 'ad-hoc', 'team']:
        bad = profile(bundle)
        if change == 'app': bad['Entitlements']['application-identifier'] += '.wrong'
        if change == 'group': bad['Entitlements']['com.apple.security.application-groups'] = []
        if change == 'keychain': bad['Entitlements']['keychain-access-groups'] = []
        if change == 'expired': bad['ExpirationDate'] = datetime.datetime(2020, 1, 1)
        if change == 'development': bad['Entitlements']['get-task-allow'] = True
        if change == 'ad-hoc': bad['ProvisionedDevices'] = ['synthetic-device']
        if change == 'team': bad['TeamIdentifier'] = ['OTHERTEAM']
        try: module.validate(bad, bundle)
        except ValueError: pass
        else: raise AssertionError(change + ' was accepted')
# Without the widgets, the existing app profile has no App Group and still signs the app.
plain = profile('de.tbuck.tau')
del plain['Entitlements']['com.apple.security.application-groups']
assert module.validate(plain, 'de.tbuck.tau', False) == '12345678-1234-1234-1234-123456789012'
try: module.validate(plain, 'de.tbuck.tau')
except ValueError: pass
else: raise AssertionError('a profile without the App Group was accepted for the widgets build')
`;
it("rejects profiles that cannot sign the app and widget with the shared entitlements", () => {
  const result = spawnSync("python3", ["-B", "-c", source], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
