"""Explicit one-time setup. Runtime worker never downloads assets or sends content."""
import argparse
import concurrent.futures
import datetime
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parent
HEADERS = {"User-Agent": "DSH-content-origin/1.0"}

def fetch(url, maximum=64 * 1024 * 1024):
    with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=90) as response:
        data = response.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError("Asset exceeds size limit")
    return data


def install_model(item):
    key, model, data_dir = item
    for name, expected in model["files"].items():
        target = data_dir / "models" / key / name
        if not expected:
            raise ValueError(f"Missing pinned SHA256 for {key}/{name}")
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and expected and hashlib.sha256(target.read_bytes()).hexdigest() == expected:
            data = target.read_bytes()
        else:
            url = f'https://huggingface.co/{model["repo"]}/resolve/{model["revision"]}/{name}'
            data = fetch(url)
            actual = hashlib.sha256(data).hexdigest()
            if expected and actual != expected:
                raise ValueError(f"SHA256 mismatch for {key}/{name}")
            target.write_bytes(data)
        model["files"][name] = hashlib.sha256(data).hexdigest()
        print(f"Verified {key}/{name}: {len(data)} bytes", flush=True)
    return key, model


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', type=Path, required=True)
    data_dir = parser.parse_args().data_dir
    if not data_dir.is_absolute():
        parser.error('--data-dir must be an absolute local path')
    data_dir.mkdir(parents=True, exist_ok=True)
    lock = json.loads((ROOT / "models.lock.json").read_text(encoding="utf-8"))
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(install_model, [(key, model, data_dir) for key, model in lock.items()]))
    trust_dir = data_dir / "trust"
    trust_dir.mkdir(exist_ok=True)
    groups = [
        ("c2pa-org/conformance-public", "main", [
            ("trust-list/C2PA-TRUST-LIST.pem", "conformance.pem"),
            ("trust-list/C2PA-TSA-TRUST-LIST.pem", "tsa.pem")]),
        ("contentauth/verify-site", "main", [
            ("static/trust/anchors.pem", "interim-anchors.pem"),
            ("static/trust/allowed.pem", "interim-allowed.pem"),
            ("static/trust/store.cfg", "interim-store.cfg")]),
    ]
    records = []
    for repo, ref, paths in groups:
        commit = json.loads(fetch(f"https://api.github.com/repos/{repo}/commits/{ref}", 1024*1024))["sha"]
        for path, name in paths:
            url = f"https://raw.githubusercontent.com/{repo}/{commit}/{path}"
            data = fetch(url, 2*1024*1024)
            if name.endswith(".pem") and b"-----BEGIN CERTIFICATE-----" not in data:
                raise ValueError("Invalid trust asset")
            (trust_dir / name).write_bytes(data)
            records.append({"name": name, "url": url, "sha256": hashlib.sha256(data).hexdigest()})
            print(f"Fetched public trust input {name}: {len(data)} bytes", flush=True)
    (trust_dir / "snapshot.json").write_text(json.dumps({
        "fetched_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "max_age_days": 30, "inputs": records
    }, indent=2) + "\n", encoding="utf-8")

if __name__ == "__main__":
    main()
