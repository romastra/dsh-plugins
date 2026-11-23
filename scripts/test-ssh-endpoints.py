"""Verify Pageant address settings offline with the pinned upstream parser."""
import json
import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch


PACKAGE = Path(__file__).resolve().parents[1] / 'packages' / 'ssh-pageant-mcp'
launcher = runpy.run_path(str(PACKAGE / 'launch.py'))


class EndpointConfigTest(unittest.TestCase):
    def test_parse_rejects_non_endpoint_fields(self):
        parse = launcher['parse_host_endpoints']
        self.assertEqual(parse(''), {})
        self.assertEqual(parse('{"host":{"hostname":"2001:db8::1","port":2222}}')['host']['port'], 2222)
        examples = [
            '{"host":{"hostname":"ssh://example.invalid"}}',
            '{"host":{"hostname":"ssh.example.invalid","port":0}}',
            '{"host":{"hostname":"ssh.example.invalid","port":true}}',
            '{"host":{"hostname":"ssh.example.invalid","port":22.2}}',
            '{"host":{"hostname":"user@ssh.example.invalid"}}',
            '{"host":{"hostname":"ssh.example.invalid","user":"other"}}',
            '{"host":{"hostname":"a.invalid"},"host":{"hostname":"b.invalid"}}',
        ]
        for raw in examples:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                parse(raw)

    def test_upstream_load_and_reload_keep_auth_and_policy(self):
        from ssh_mcp import hosts
        from ssh_mcp.config import Settings

        fixture = (PACKAGE / 'hosts.example.toml').read_text(encoding='utf-8')
        fingerprint = 'SHA256:' + 'A' * 43
        fixture = fixture.replace('<your Pageant public-key fingerprint>', fingerprint)
        with tempfile.TemporaryDirectory(prefix='dsh-ssh-fixture-') as temp:
            source = Path(temp) / 'hosts.toml'
            keys = Path(temp) / 'known_hosts'
            source.write_text(fixture, encoding='utf-8')
            keys.touch()
            settings = Settings(_env_file=None, SSH_HOSTS_FILE=source, SSH_KNOWN_HOSTS=keys,
                                ALLOW_PASSWORD_AUTH=False, ALLOW_DANGEROUS_TOOLS=False)
            original = hosts._read_toml
            env = {'SSH_HOSTS_FILE': str(source), 'SSH_KNOWN_HOSTS': str(keys)}
            with patch.dict(os.environ, env):
                with self.assertRaisesRegex(ValueError, 'existing hosts.toml aliases'):
                    launcher['install_host_endpoint_overrides']('{"absent":{"hostname":"ssh.example.invalid"}}')
                self.assertIs(hosts._read_toml, original)
                self.addCleanup(setattr, hosts, '_read_toml', original)
                launcher['install_host_endpoint_overrides'](json.dumps({'example': {
                    'hostname': '192.0.2.50', 'port': 2222,
                }}))
                for _ in range(2):
                    entries = hosts.load_hosts(source, settings)
                    self.assertEqual(list(entries), ['example'])
                    policy = entries['example']
                    self.assertEqual((policy.hostname, policy.port, policy.user), ('192.0.2.50', 2222, 'example'))
                    self.assertEqual(policy.path_allowlist, [])
                    self.assertEqual(policy.auth.method, 'agent')
                    self.assertEqual(policy.auth.identity_fingerprint, fingerprint)
                    self.assertTrue(policy.auth.identities_only)
                self.assertEqual(source.read_text(encoding='utf-8'), fixture)


if __name__ == '__main__':
    unittest.main()
