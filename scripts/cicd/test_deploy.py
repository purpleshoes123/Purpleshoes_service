import copy
import importlib.util
import json
import os
import tempfile
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import patch, Mock

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

    def test_theme_media_is_compared_as_binary_without_utf8_conversion(self):
        media = b'\x00\xff\x89\x00'
        self.assertEqual(deploy.canonical('assets/movie.mp4', media), deploy.canonical('assets/movie.mp4', media))
        self.assertNotEqual(deploy.canonical('assets/movie.mp4', media), deploy.canonical('assets/movie.mp4', media+b'\x00'))

    def test_each_shopify_command_receives_only_its_dedicated_credential(self):
        env = {'SHOPIFY_SERVICE_ACCOUNT_TOKEN':'fixture-app','SHOPIFY_CLI_THEME_TOKEN':'fixture-theme'}
        with patch.dict(os.environ, env), patch.object(deploy.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=b'')) as run:
            deploy.cli(['theme','pull'])
            self.assertNotIn('SHOPIFY_SERVICE_ACCOUNT_TOKEN',run.call_args.kwargs['env'])
            self.assertEqual(run.call_args.kwargs['env']['SHOPIFY_CLI_THEME_TOKEN'],'fixture-theme')
            deploy.cli(['app','deploy'])
            self.assertNotIn('SHOPIFY_CLI_THEME_TOKEN',run.call_args.kwargs['env'])
            self.assertEqual(run.call_args.kwargs['env']['SHOPIFY_SERVICE_ACCOUNT_TOKEN'],'fixture-app')

    def test_cli_errors_keep_useful_reason_without_credentials_or_account_links(self):
        secret = 'fixture-credential-value'
        with patch.dict(os.environ, {'SHOPIFY_CLI_THEME_TOKEN': secret}):
            result = deploy.safe_diagnostic(f'Upload failed assets/demo.mp4: {secret} https://store.example/?token=unknown a@example.com opaqueTokenABCDEFGHIJKLMNOPQRSTUVWXYZ123456')
        self.assertIn('Upload failed assets/demo.mp4', result)
        for value in [secret, 'https://', 'a@example.com', 'opaqueToken']:
            self.assertNotIn(value, result)

    def test_cli_timeout_fails_in_time_to_restore_production(self):
        with patch.object(deploy.subprocess, 'run', side_effect=deploy.subprocess.TimeoutExpired('shopify', 300)):
            with self.assertRaisesRegex(RuntimeError, 'timed out: theme push'):
                deploy.cli(['theme', 'push'])

    def test_large_asset_uses_encrypted_expiring_download_and_stays_out_of_cli_payload(self):
        env = {'RELEASE_BUCKET':'fixture-bucket','AWS_ACCOUNT_ID':'123456789012','SHOPIFY_THEME_ID':'1'}
        s3 = Mock()
        s3.generate_presigned_url.return_value = 'https://fixture.invalid/signed?credential=private'
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root/'assets').mkdir()
            with (root/'assets/demo.mp4').open('wb') as stream:
                stream.truncate(5 * 1024 * 1024 + 1)
            (root/'assets/small.js').write_text('void 0;')
            with patch.dict(os.environ, env), patch.object(deploy,'theme_graphql',return_value={'themeFilesUpsert':{'job':None,'userErrors':[]}}) as graphql, patch.object(deploy,'cli') as cli:
                deploy.push_theme(s3,'releases/cicd/test',root,['assets/demo.mp4','assets/small.js','assets/absent.js'],[])
            self.assertEqual(s3.upload_file.call_args.kwargs['ExtraArgs']['ServerSideEncryption'],'AES256')
            self.assertEqual(s3.generate_presigned_url.call_args.kwargs['ExpiresIn'],300)
            self.assertEqual(graphql.call_args.args[1]['files'][0]['body'],{'type':'URL','value':s3.generate_presigned_url.return_value})
            self.assertNotIn('assets/demo.mp4',cli.call_args.args[0])
            self.assertIn('assets/small.js',cli.call_args.args[0])

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
