import copy
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).with_name('deploy.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def fixture():
    old_hash, old_source = 'a' * 64, 'b' * 64
    install = f'''expected = "{old_hash}"
key = "releases/old/runtime.tgz"
target = root / ("old-release-" + expected[:12])
assert response["ContentLength"] == 42
assert len(members) == 7
assert manifest["sourceManifestSha256"] == "{old_source}"
'''
    return json.dumps({'format': 'existing', 'scripts': [
        {'name': 'install-release.py', 'source': install},
        {'name': 'configure-prelive-service.py', 'source': f"digest = '{old_source}'\nreleases = 'old-release-*'"},
        {'name': 'configure-fleet-nginx.py', 'source': 'pass'},
        {'name': 'configure-active-fleet.py', 'source': f"assert name == 'old-release-{old_hash[:12]}'"},
    ]}).encode()


class DeploymentGuards(unittest.TestCase):
    def test_bootstrap_updates_all_pins_and_can_be_reused(self):
        meta = dict(sha256='c' * 64, sourceManifestSha256='d' * 64, bytes=123, members=12)
        raw, prior = deploy.update_bootstrap(fixture(), meta, 'releases/ci/runtime.tgz', 'ci-new')
        self.assertEqual(prior, 'b' * 64)
        text = raw.decode()
        self.assertNotIn('a' * 12, text)
        self.assertNotIn('old-release', text)
        self.assertIn('ci-new-cccccccccccc', text)
        raw2, prior2 = deploy.update_bootstrap(raw, {**meta, 'sha256': 'e' * 64, 'sourceManifestSha256': 'f' * 64}, 'releases/ci2/runtime.tgz', 'ci-next')
        self.assertEqual(prior2, 'd' * 64)
        self.assertIn('ci-next-eeeeeeeeeeee', raw2.decode())

    def test_unknown_bootstrap_fails_instead_of_deploying(self):
        obj = json.loads(fixture())
        obj['scripts'].pop()
        with self.assertRaises(AssertionError):
            deploy.update_bootstrap(json.dumps(obj).encode(), {}, 'x', 'x')

    def test_drift_comparison_ignores_only_json_format_and_line_endings(self):
        self.assertEqual(deploy.canonical('a.json', b'/* Auto */ {"a":1,"b":2}'), deploy.canonical('a.json', b'{"b":2,"a":1}'))
        self.assertEqual(deploy.canonical('a.liquid', b'a\r\nb'), deploy.canonical('a.liquid', b'a\nb'))
        self.assertNotEqual(deploy.canonical('a.liquid', b'{{ customer }}'), deploy.canonical('a.liquid', b'{{ product }}'))

    def test_missing_credentials_stop_before_external_operations(self):
        with patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(RuntimeError, 'TOKEN'):
            deploy.require_env(['TOKEN'])

    def test_numeric_template_required_for_rollback(self):
        class ASG:
            def describe_auto_scaling_groups(self, **kwargs):
                return {'AutoScalingGroups': [{'LaunchTemplate': {'LaunchTemplateId': 'lt-test', 'Version': '$Latest'}}]}
        with patch.dict(os.environ, {'ASG_NAME': 'test', 'LAUNCH_TEMPLATE_ID': 'lt-test'}), self.assertRaises(AssertionError):
            deploy.fleet(ASG())

    def test_failed_refresh_is_never_reported_as_success(self):
        class ASG:
            def describe_instance_refreshes(self, **kwargs):
                return {'InstanceRefreshes': [{'Status': 'RollbackSuccessful'}]}
        with patch.dict(os.environ, {'ASG_NAME': 'test'}), self.assertRaisesRegex(RuntimeError, 'RollbackSuccessful'):
            deploy.wait_refresh(ASG(), 'test')


if __name__ == '__main__':
    unittest.main()
