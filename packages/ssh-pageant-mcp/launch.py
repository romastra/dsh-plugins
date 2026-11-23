"""MCP entry: trusted CPython executable, isolated pinned packages, Pageant-only auth."""
import base64
import hashlib
import ipaddress
import json
import os
import re
from pathlib import Path
import site
import sys

ROOT = Path(__file__).resolve().parent
AGENT_FINGERPRINT = os.environ.get("DSH_SSH_PAGEANT_FINGERPRINT", "")


def prepare_runtime():
    if sys.platform != "win32" or sys.version_info[:2] != (3, 11):
        raise RuntimeError("Use the installed Windows CPython 3.11 interpreter with this environment")
    if not re.fullmatch(r"SHA256:[A-Za-z0-9+/]{43}", AGENT_FINGERPRINT):
        raise RuntimeError("Configure one trusted Pageant public fingerprint locally")
    venv = Path(os.environ.get("DSH_SSH_VENV", str(ROOT / ".venv")))
    packages = venv / "Lib" / "site-packages"
    if not venv.is_absolute() or not packages.is_dir():
        raise RuntimeError("Configure an existing absolute SSH MCP venv path")
    site.addsitedir(str(packages))
    os.environ["SSH_MCP_DISABLE_DOTENV"] = "1"
    os.environ["FASTMCP_ENV_FILE"] = ""
    os.environ["SSH_AUTH_SOCK"] = ""  # Use the already-running native Pageant, never start an agent.


def parse_host_endpoints(raw):
    """Only hostname and port of existing local host policies can be changed."""
    if not raw:
        return {}
    if len(raw.encode('utf-8')) > 16384:
        raise ValueError('SSH endpoint configuration exceeds 16 KiB')

    def unique(items):
        result = dict(items)
        if len(result) != len(items):
            raise ValueError('Duplicate SSH endpoint configuration key')
        return result

    try:
        entries = json.loads(raw, object_pairs_hook=unique)
    except (ValueError, RecursionError):
        raise ValueError('Invalid DSH_SSH_HOST_ENDPOINTS JSON') from None
    if not isinstance(entries, dict) or len(entries) > 32:
        raise ValueError('Expected up to 32 SSH endpoint overrides by alias')
    for alias, endpoint in entries.items():
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', alias) or not isinstance(endpoint, dict):
            raise ValueError('Invalid SSH endpoint alias or mapping')
        if set(endpoint) not in ({'hostname'}, {'hostname', 'port'}):
            raise ValueError('An SSH endpoint accepts hostname and optional port only')
        name = endpoint['hostname']
        if not isinstance(name, str) or not name or len(name) > 253 or '%' in name:
            raise ValueError('Invalid SSH hostname')
        try:
            ipaddress.ip_address(name)
        except ValueError:
            labels = name.removesuffix('.').split('.')
            if all(char in '0123456789.' for char in name) or not all(
                re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label) for label in labels
            ):
                raise ValueError('Use a DNS name or a literal IP address for SSH') from None
        if 'port' in endpoint and (type(endpoint['port']) is not int or not 1 <= endpoint['port'] <= 65535):
            raise ValueError('SSH port must be an integer in 1..65535')
    return entries


def install_host_endpoint_overrides(raw):
    endpoints = parse_host_endpoints(raw)
    if not endpoints:
        return
    from ssh_mcp import hosts
    source = Path(os.environ.get('SSH_HOSTS_FILE') or '.')
    known_hosts = Path(os.environ.get('SSH_KNOWN_HOSTS') or '.')
    if any(not value.is_absolute() or not value.is_file() for value in (source, known_hosts)):
        raise ValueError('Overrides require absolute local SSH_HOSTS_FILE and SSH_KNOWN_HOSTS files')
    source = source.resolve(strict=True)
    upstream_reader = hosts._read_toml

    def read_with_endpoints(path):
        contents = upstream_reader(path)
        if path.resolve(strict=True) != source:
            return contents
        registry = contents.get('hosts')
        if not isinstance(registry, dict) or any(not isinstance(registry.get(alias), dict) for alias in endpoints):
            raise ValueError('SSH endpoint overrides may reference existing hosts.toml aliases only')
        # Leave upstream policy validation, reload, known_hosts and authentication intact.
        return {**contents, 'hosts': {
            alias: {**block, **endpoints[alias]} if alias in endpoints else block
            for alias, block in registry.items()
        }}

    read_with_endpoints(source)  # Reject unknown aliases at startup, without opening a connection.
    hosts._read_toml = read_with_endpoints


def install_pageant_auth_guard():
    """Fix upstream's ineffective identities_only without editing its installed source."""
    from ssh_mcp.ssh import connection
    original = connection._resolve_auth
    if getattr(original, "_pageant_guard", False):
        return

    async def resolve(auth):
        if auth.method != "agent" or auth.identity_fingerprint != AGENT_FINGERPRINT:
            raise RuntimeError("This deployment permits only the verified existing Pageant identity")
        kwargs = await original(auth)
        keys = kwargs.get("client_keys")
        if not keys or len(keys) != 1:
            raise RuntimeError("Expected exactly one selected Pageant identity")
        key = keys[0]
        actual = "SHA256:" + base64.b64encode(hashlib.sha256(key.public_data).digest()).decode("ascii").rstrip("=")
        if actual != AGENT_FINGERPRINT:
            raise RuntimeError("Pageant identity fingerprint mismatch")
        # This handle signs through Pageant. AsyncSSH normalizes an empty agent
        # path to platform auto-detection, so restrict allowed agent identities
        # explicitly; adding another loaded key must not broaden authentication.
        kwargs.update(
            agent_path=None,
            agent_identities=[key.public_data],
            password_auth=False,
            kbdint_auth=False,
            host_based_auth=False,
            gss_auth=False,
            gss_kex=False,
            preferred_auth="publickey",
            pkcs11_provider=None,
        )
        return kwargs

    resolve._pageant_guard = True
    connection._resolve_auth = resolve


def main():
    prepare_runtime()
    install_host_endpoint_overrides(os.environ.pop('DSH_SSH_HOST_ENDPOINTS', ''))
    install_pageant_auth_guard()
    from ssh_mcp.server import mcp_server
    mcp_server.instructions = (
        "Use only the SSH hosts already configured by the owner. "
        "Authentication uses the already-running Pageant and pinned host keys; never start Pageant or export private keys. "
        "Discover operations with search_tools; call_tool takes name and arguments. "
        "For file transfers use the locally configured transfer directory. "
        "Output is capped. Shell sessions retain cwd only, not env or PTY. "
        "Use only the configured task workflow; do not blindly replay writes after transport errors."
    )
    from ssh_mcp.run_server import main as run
    run()


if __name__ == "__main__":
    main()
