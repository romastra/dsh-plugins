"""Isolated stdlib bridge to the existing Windows Parakeet NTFS queue.

The only commands are status, prepare and transcribe (raw PCM16 mono WAV stdin).
Status/prepare never launch a process or import a model/native ASR runtime.
Transcription shares the installed worker; this bridge never stops that worker.
Test injection seams are Python-only and are not configuration/CLI features.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import subprocess
import sys
import tempfile
import time
import uuid

DEFAULT_ROOT = str(Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "OpenClawASR")
EXPECTED_ENGINE = 'af6f146881cbb3877b515a5b50680ac5fe28d6ec22620ff66cc54108286016e2'
DSH_NONCE = 'dsh-local-parakeet-v1'
MAX_BYTES = 20 * 1024 * 1024
MAX_TEXT_BYTES = 2 * 1024 * 1024
MAX_JSON_BYTES = 16 * 1024 * 1024
MAX_SECONDS = 120
SAMPLE_RATE = 16000
MAX_QUEUE = 16
RUN_BUDGET_SECONDS = 240
BOOTSTRAP_TIMEOUT_SECONDS = 15
STARTUP_GRACE_SECONDS = 30
COOLDOWN_SECONDS = 30
POLL_SECONDS = 0.1
HEALTH_CHECK_SECONDS = 2
HEARTBEAT_SECONDS = 30
HEX = re.compile(r'[0-9a-f]{64}\Z')
NONCE = re.compile(r'[A-Za-z0-9._-]{1,80}\Z')
ERROR_CODE = re.compile(r'[a-z][a-z0-9_]{0,63}\Z')
WORKER_ID = re.compile(r'[A-Za-z0-9_.:-]{1,128}\Z')
PRIVATE_ORT = 'venv/Lib/site-packages/sherpa_onnx/lib/onnxruntime.dll'
REQUIRED = {'bootstrap.py', 'win_support.py', 'worker.py', 'audio_core.py', PRIVATE_ORT,
            'bin/ffmpeg.exe', 'bin/ffprobe.exe', 'model/encoder.int8.onnx',
            'model/decoder.int8.onnx', 'model/joiner.int8.onnx', 'model/tokens.txt'}
SAFE_DEMUXERS = {'ogg', 'wav', 'w64', 'flac', 'mp3', 'mov', 'matroska', 'avi',
                 'aac', 'ac3', 'eac3', 'amr', 'asf', 'aiff', 'ape', 'wv', 'tta',
                 'au', 'caf', 'dsf', 'iff', 'flv', 'mpeg', 'mpegts', 'tak', 'mpc',
                 'mpc8', 'shn'}


class BridgeError(RuntimeError):
    def __init__(self, code, message='Local Parakeet request failed.', **metadata):
        self.code = code if type(code) is str and ERROR_CODE.fullmatch(code) else 'bridge_failed'
        self.message = message
        self.metadata = {key: value for key, value in metadata.items()
                         if key in ('retryAfterAt', 'jobKey')}
        super().__init__(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=False, allow_nan=False).encode('utf-8')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def number(value):
    return ((type(value) is int and value >= 0) or
            (type(value) is float and math.isfinite(value) and value >= 0))


def integer(value):
    return type(value) is int and value >= 0


def hex64(value):
    return type(value) is str and HEX.fullmatch(value) is not None


def parse_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('Duplicate key')
            result[key] = value
        return result

    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        if type(value) is not dict:
            raise ValueError('Object required')
        canonical(value)  # Reject overflowed floats and unpaired UTF-8 surrogates.
        return value
    except (ValueError, UnicodeError, TypeError, RecursionError, OverflowError) as exc:
        raise BridgeError('corrupt_result', 'Invalid local JSON artifact.') from exc


def sealed(document):
    return {**document, 'documentSha256': digest(canonical(document))}


def unseal(document):
    expected = document.get('documentSha256')
    payload = {key: value for key, value in document.items() if key != 'documentSha256'}
    if not hex64(expected) or digest(canonical(payload)) != expected:
        raise BridgeError('corrupt_result', 'Local artifact integrity check failed.')
    return payload


def absolute_path(value):
    try:
        text = os.fspath(value)
        if (not isinstance(text, str) or not text or '\x00' in text or
                any(part in ('.', '..') for part in re.split(r'[\\/]', text))):
            raise ValueError()
        path = Path(text)
        if not path.is_absolute() or str(path.anchor).startswith('\\\\'):
            raise ValueError()
        if os.name == 'nt':
            # Ordinary local drive paths only: no UNC/device namespaces or ADS.
            if not re.fullmatch(r'[A-Za-z]:', path.drive):
                raise ValueError()
            if any(':' in part or part.endswith((' ', '.')) for part in path.parts[1:]):
                raise ValueError()
        return path.absolute()
    except (TypeError, ValueError, OSError) as exc:
        raise BridgeError('unsafe_path', 'An ordinary absolute local directory is required.') from exc


def path_identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def ordinary_path(path):
    """Check every existing ancestor, including above the trusted root."""
    chain = [*reversed(path.parents), path]
    for current in chain:
        try:
            info = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise BridgeError('unsafe_path', 'Reparse points are not permitted.')


class Artifacts:
    """Bounded, mutation-detecting IO; the installation owner's ACLs remain trusted."""
    def __init__(self, root, check=None, monotonic=None, sleep=None):
        self.root = absolute_path(root)
        self.check = check or (lambda: None)
        self.monotonic = monotonic or time.monotonic
        self.sleep = sleep or time.sleep
        ordinary_path(self.root)
        self.root_id = None
        if self.root.exists():
            if not self.root.is_dir():
                raise BridgeError('unsafe_path', 'Expected an ordinary directory.')
            info = self.root.stat()
            self.root_id = (info.st_dev, info.st_ino)

    def path(self, parts=()):
        path = self.root
        for part in parts:
            if (type(part) is not str or part in ('', '.', '..') or
                    any(char in part for char in ('/', '\\', ':', '\x00')) or
                    part.endswith((' ', '.'))):
                raise BridgeError('unsafe_path', 'Invalid artifact path component.')
            path = path / part
        ordinary_path(path)
        if self.root_id is not None:
            info = self.root.stat()
            if (info.st_dev, info.st_ino) != self.root_id:
                raise BridgeError('unsafe_path', 'The trusted directory changed.')
        return path

    def mkdir(self, parts=()):
        path = self.path(parts)
        path.mkdir(parents=True, exist_ok=True)
        ordinary_path(path)
        if not path.is_dir():
            raise BridgeError('unsafe_path', 'Expected an ordinary directory.')
        if self.root_id is None:
            info = self.root.stat()
            self.root_id = (info.st_dev, info.st_ino)
        return path

    def read(self, parts, maximum, missing=False):
        self.check()
        path = self.path(parts)
        try:
            with path.open('rb') as stream:
                before = os.fstat(stream.fileno())
                if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
                        before.st_size > maximum):
                    raise BridgeError('unsafe_path', 'Invalid local artifact size or link count.')
                raw = stream.read(maximum + 1)
                after = os.fstat(stream.fileno())
            current = self.path(parts).lstat()
            if (len(raw) != before.st_size or len(raw) > maximum or
                    path_identity(before) != path_identity(after) or
                    path_identity(before) != path_identity(current)):
                raise BridgeError('corrupt_result', 'A local artifact changed while being read.')
            self.check()
            return raw
        except FileNotFoundError:
            if missing:
                return None
            raise BridgeError('installation_missing', 'A required local artifact is missing.') from None

    def json(self, parts, maximum=MAX_JSON_BYTES, missing=False, require_seal=False):
        raw = self.read(parts, maximum, missing)
        if raw is None:
            return None
        document = parse_json(raw)
        return unseal(document) if require_seal else document

    def hash_file(self, parts, maximum=4 * 1024 * 1024 * 1024):
        path = self.path(parts)
        try:
            with path.open('rb') as stream:
                before = os.fstat(stream.fileno())
                if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > maximum:
                    raise BridgeError('unsafe_path', 'Invalid installation component.')
                result, count = hashlib.sha256(), 0
                while True:
                    self.check()
                    block = stream.read(1024 * 1024)
                    if not block:
                        break
                    result.update(block)
                    count += len(block)
                    if count > maximum:
                        raise BridgeError('unsafe_path', 'Installation component exceeds its bound.')
                after = os.fstat(stream.fileno())
            current = self.path(parts).lstat()
            if (count != before.st_size or path_identity(before) != path_identity(after) or
                    path_identity(before) != path_identity(current)):
                raise BridgeError('installation_changed', 'An installation component changed during validation.')
            return result.hexdigest()
        except FileNotFoundError:
            raise BridgeError('installation_missing', 'A required installation component is missing.') from None

    def atomic(self, parts, raw):
        self.check()
        self.mkdir(parts[:-1])
        destination = self.path(parts)
        if destination.exists():
            info = destination.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise BridgeError('unsafe_path', 'Unsafe publication target.')
        name = '.' + parts[-1] + '.' + uuid.uuid4().hex + '.tmp'
        temporary = self.path((*parts[:-1], name))
        try:
            with temporary.open('xb') as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            until = self.monotonic() + 2
            while True:
                self.check()
                self.path(parts)
                self.path((*parts[:-1], name))
                try:
                    os.replace(temporary, destination)
                    break
                except PermissionError as exc:
                    if getattr(exc, 'winerror', None) not in (5, 32) or self.monotonic() >= until:
                        raise
                    self.sleep(min(0.05, max(0, until - self.monotonic())))
        finally:
            # Only our exact, UUID-named temporary artifact is removed.
            if temporary.exists():
                self.path((*parts[:-1], name)).unlink()
        self.check()


class WindowsMutex:
    """Per-owner/root named coordination; never touches the worker singleton lock."""
    def __init__(self, name, deadline, monotonic=time.monotonic):
        self.name, self.deadline, self.monotonic = name, deadline, monotonic
        self.kernel = self.handle = None
        self.acquired = False

    def __enter__(self):
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        kernel.CreateMutexW.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
        kernel.ReleaseMutex.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel = kernel
        self.handle = kernel.CreateMutexW(None, False, self.name)
        if not self.handle:
            raise BridgeError('coordination_failed', 'Cannot coordinate the local transcription request.')
        try:
            while True:
                left = self.deadline - self.monotonic()
                if left <= 0:
                    raise BridgeError('deadline', 'Local transcription deadline exceeded; the job remains queued.')
                result = kernel.WaitForSingleObject(self.handle, max(1, min(100, int(left * 1000))))
                if result in (0, 0x80):
                    self.acquired = True
                    return self
                if result != 0x102:
                    raise BridgeError('coordination_failed', 'Cannot coordinate the local transcription request.')
        except BaseException:
            kernel.CloseHandle(self.handle)
            self.handle = None
            raise

    def __exit__(self, *_):
        if self.handle:
            try:
                if self.acquired:
                    self.kernel.ReleaseMutex(self.handle)
            finally:
                self.kernel.CloseHandle(self.handle)
                self.handle = None


def validate_wav(raw):
    """Strict self-contained RIFF PCM16/mono WAV, with exact byte and duration bounds."""
    if not isinstance(raw, bytes) or not 0 < len(raw) <= MAX_BYTES:
        raise BridgeError('invalid_input_size', 'Audio must contain 1..20 MiB of WAV data.')
    if (len(raw) < 44 or raw[:4] != b'RIFF' or raw[8:12] != b'WAVE' or
            struct.unpack_from('<I', raw, 4)[0] != len(raw) - 8):
        raise BridgeError('invalid_wav', 'Expected a complete PCM16 mono WAV recording.')
    position, fmt, frames = 12, None, None
    while position < len(raw):
        if position + 8 > len(raw):
            raise BridgeError('invalid_wav', 'Invalid WAV chunk framing.')
        kind, size = raw[position:position + 4], struct.unpack_from('<I', raw, position + 4)[0]
        start, end = position + 8, position + 8 + size
        if end > len(raw) or end + (size & 1) > len(raw):
            raise BridgeError('invalid_wav', 'Invalid WAV chunk size.')
        if kind == b'fmt ':
            if fmt is not None or size not in (16, 18):
                raise BridgeError('invalid_wav', 'Expected ordinary PCM16 WAV formatting.')
            fmt = struct.unpack_from('<HHIIHH', raw, start)
            encoding, channels, rate, byte_rate, alignment, bits = fmt
            if (encoding != 1 or channels != 1 or not 1 <= rate <= SAMPLE_RATE or
                    byte_rate != rate * 2 or alignment != 2 or bits != 16 or
                    (size == 18 and raw[start + 16:start + 18] != b'\x00\x00')):
                raise BridgeError('invalid_wav', 'Audio must be PCM16 mono WAV at no more than 16 kHz.')
        elif kind == b'data':
            if fmt is None or frames is not None or size == 0 or size % 2:
                raise BridgeError('invalid_wav', 'Expected one nonempty, aligned WAV audio chunk.')
            frames = size // 2
        position = end + (size & 1)
    if fmt is None or frames is None:
        raise BridgeError('invalid_wav', 'The WAV recording has no audio samples.')
    if frames > fmt[2] * MAX_SECONDS:
        raise BridgeError('audio_too_long', 'The recording exceeds 120 seconds.')
    return frames / fmt[2]


def job_identity(engine, raw, test_nonce=None):
    nonce = DSH_NONCE
    if test_nonce is not None:
        if type(test_nonce) is not str or not NONCE.fullmatch(test_nonce):
            raise BridgeError('invalid_nonce', 'Invalid operator test nonce.')
        nonce += '.' + test_nonce
    if not NONCE.fullmatch(nonce) or not hex64(engine):
        raise BridgeError('invalid_identity', 'Invalid local request identity.')
    identity = {'engineId': engine, 'inputSha256': digest(raw), 'inputBytes': len(raw), 'nonce': nonce}
    return identity, digest(canonical(identity))


def base_matches(document, identity, key):
    if (type(document.get('schema')) is not int or document['schema'] != 1 or
            document.get('jobKey') != key or
            any(type(document.get(name)) is not type(value) or document[name] != value
                for name, value in identity.items())):
        raise BridgeError('corrupt_result', 'Local result identity does not match this recording.')


def validate_plan(plan, count):
    if not integer(count) or not 0 < count <= MAX_SECONDS * SAMPLE_RATE:
        raise BridgeError('corrupt_result', 'Invalid completed audio coverage.')
    if type(plan) is not list or not 0 < len(plan) <= 72:
        raise BridgeError('corrupt_result', 'Invalid completed segment plan.')
    cursor = 0
    for index, item in enumerate(plan):
        if (type(item) is not dict or set(item) != {'index', 'start', 'end', 'boundary'} or
                type(item.get('index')) is not int or item['index'] != index or
                not integer(item.get('start')) or item['start'] != cursor or
                not integer(item.get('end')) or not cursor < item['end'] <= count or
                item['end'] - cursor > 50 * SAMPLE_RATE or
                (len(plan) > 1 and item['end'] - cursor < 25 * SAMPLE_RATE) or
                item.get('boundary') not in ('pause', 'low_energy', 'end') or
                (item['boundary'] == 'end') != (index == len(plan) - 1)):
            raise BridgeError('corrupt_result', 'Invalid or incomplete segment coverage.')
        cursor = item['end']
    if cursor != count:
        raise BridgeError('corrupt_result', 'The completed result does not cover the recording.')


def validate_complete(tree, document, identity, key, tokens_sha):
    base_matches(document, identity, key)
    count, plan, segments = document.get('sampleCount'), document.get('plan'), document.get('segments')
    if (document.get('status') != 'complete' or document.get('coverageVerified') is not True or
            type(document.get('sampleRate')) is not int or document['sampleRate'] != SAMPLE_RATE):
        raise BridgeError('corrupt_result', 'The local transcription is not a complete result.')
    validate_plan(plan, count)
    if (document.get('audioSeconds') != count / SAMPLE_RATE or
            not number(document.get('audioSeconds')) or
            document.get('planSha256') != digest(canonical(plan)) or
            not hex64(document.get('decodedSha256')) or document.get('tokensSha256') != tokens_sha or
            type(segments) is not list or len(segments) != len(plan)):
        raise BridgeError('corrupt_result', 'Completed plan or decoder integrity check failed.')
    assembled, total = [], 0
    for expected, item in zip(plan, segments):
        if (type(item) is not dict or item.get('status') != 'complete' or
                any(type(item.get(name)) is not int or item[name] != expected[name]
                    for name in ('index', 'start', 'end')) or
                type(item.get('text')) is not str or item['text'] != item['text'].strip() or
                not number(item.get('seconds')) or
                item['seconds'] != (item['end'] - item['start']) / SAMPLE_RATE or
                not number(item.get('inferenceSeconds'))):
            raise BridgeError('corrupt_result', 'Incomplete or inconsistent completed segments.')
        try:
            raw = item['text'].encode('utf-8')
        except UnicodeError as exc:
            raise BridgeError('corrupt_result', 'Invalid completed transcript encoding.') from exc
        total += len(raw) + (1 if raw and assembled else 0)
        if total > MAX_TEXT_BYTES or digest(raw) != item.get('textSha256'):
            raise BridgeError('corrupt_result', 'Completed segment text integrity check failed.')
        if raw:
            assembled.append(item['text'])
    metrics = ('jobSeconds', 'queueSeconds', 'decodeSeconds', 'inferenceSeconds', 'inferenceSecondsTotal',
               'modelLoadSeconds', 'peakWorkingSetMiB', 'createdAt', 'completedAt')
    affinity = document.get('affinity')
    if (any(not number(document.get(name)) for name in metrics) or
            document['inferenceSecondsTotal'] != sum(item['inferenceSeconds'] for item in segments) or
            type(document.get('modelLoadedThisJob')) is not bool or
            not integer(document.get('workerPid')) or document['workerPid'] <= 0 or
            type(document.get('workerId')) is not str or not WORKER_ID.fullmatch(document['workerId']) or
            type(document.get('threads')) is not int or document['threads'] != 6 or
            type(affinity) is not list or len(affinity) != 6 or
            any(not integer(cpu) for cpu in affinity) or len(set(affinity)) != 6 or
            document.get('inputFormat') not in SAFE_DEMUXERS or
            document.get('transcriptFile') != 'transcript.txt' or
            not integer(document.get('transcriptBytes')) or document['transcriptBytes'] > MAX_TEXT_BYTES or
            not hex64(document.get('transcriptSha256'))):
        raise BridgeError('corrupt_result', 'Invalid completed worker or transcript metadata.')
    raw = tree.read(('queue', 'results', key, 'transcript.txt'), MAX_TEXT_BYTES)
    try:
        text = raw.decode('utf-8')
    except UnicodeError as exc:
        raise BridgeError('corrupt_result', 'Invalid completed transcript encoding.') from exc
    if (len(raw) != document['transcriptBytes'] or digest(raw) != document['transcriptSha256'] or
            text != ' '.join(assembled)):
        raise BridgeError('corrupt_result', 'Completed transcript integrity check failed.')
    return text, document


def load_support(path):
    # Called only after the exact installed helper bytes have been verified.
    name = '_dsh_parakeet_win_support_' + digest(str(path).encode('utf-8'))[:16]
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise BridgeError('installation_invalid', 'Cannot load the verified Windows identity helper.')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def runtime_versions():
    import importlib.metadata
    import platform
    result = {'python': platform.python_version()}
    for name in ('numpy', 'sherpa-onnx', 'sherpa-onnx-core'):
        result[name] = importlib.metadata.version(name)  # Metadata only, never native imports.
    return result


class Bridge:
    def __init__(self, root=DEFAULT_ROOT, *, state_root=None, expected_engine=EXPECTED_ENGINE,
                 support_loader=None, version_provider=None, launcher=None, mutex_factory=None,
                 monotonic=None, wall_time=None, sleep=None):
        self.root = absolute_path(root)
        self.monotonic = monotonic or time.monotonic
        self.wall_time = wall_time or time.time
        self.sleep = sleep or time.sleep
        self.support_loader = support_loader or load_support
        self.version_provider = version_provider or runtime_versions
        self.launcher = launcher or self._launch
        self.mutex_factory = mutex_factory or WindowsMutex
        self.expected_engine = expected_engine
        namespace = digest(str(self.root).casefold().encode('utf-8'))
        local = Path(os.environ.get('LOCALAPPDATA') or (Path.home() / 'AppData' / 'Local'))
        self.state_root = absolute_path(state_root or (local / 'DSHParakeetBridge' / 'state' / namespace))
        self.namespace, self.manifest, self.support = namespace, None, None
        self.deadline = None
        self.expired_failure = False

    def check(self):
        if self.deadline is not None and self.monotonic() >= self.deadline:
            raise BridgeError('deadline', 'Local transcription deadline exceeded; the same job remains queued.')

    def tree(self):
        return Artifacts(self.root, self.check, self.monotonic, self.sleep)

    def lock(self, purpose):
        owner = digest(self.manifest['ownerSid'].encode('utf-8'))[:16]
        name = 'Local\\DSHParakeet.' + owner + '.' + self.namespace + '.' + purpose
        return self.mutex_factory(name, self.deadline, self.monotonic)

    def install(self, full=False):
        tree = self.tree()
        document = tree.json(('install-manifest.json',), maximum=4 * 1024 * 1024)
        identity = document.get('identity')
        if (type(document.get('schema')) is not int or document['schema'] != 1 or
                type(identity) is not dict or not hex64(document.get('engineId')) or
                digest(canonical(identity)) != document['engineId'] or
                document['engineId'] != self.expected_engine):
            raise BridgeError('installation_invalid', 'The installed Parakeet engine identity is not supported.')
        components = identity.get('components')
        if type(components) is not dict or not REQUIRED <= components.keys():
            raise BridgeError('installation_invalid', 'The installation is missing required component identities.')
        seen = set()
        for relative, expected in components.items():
            if (type(relative) is not str or not relative or ':' in relative or '\\' in relative or
                    PurePosixPath(relative).is_absolute() or
                    any(part in ('', '.', '..') for part in relative.split('/')) or
                    not hex64(expected) or relative.casefold() in seen):
                raise BridgeError('installation_invalid', 'Invalid installation component identity.')
            seen.add(relative.casefold())
            path = tree.path(tuple(relative.split('/')))
            try:
                info = path.lstat()
            except FileNotFoundError:
                raise BridgeError('installation_missing', 'A required installation component is missing.') from None
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise BridgeError('unsafe_path', 'An installation component is not an ordinary file.')
        for name in ('bootstrap.py', 'win_support.py', 'worker.py', 'audio_core.py'):
            if tree.hash_file((name,), maximum=4 * 1024 * 1024) != components[name]:
                raise BridgeError('component_mismatch', 'An installed source component changed.')
        python = absolute_path(document.get('windowsPython', ''))
        base_python = absolute_path(document.get('pythonBaseExecutable', ''))
        if str(python).casefold() != str(self.root / 'venv' / 'Scripts' / 'python.exe').casefold():
            raise BridgeError('installation_invalid', 'The installed interpreter is outside its fixed location.')
        for executable in (python, base_python):
            ordinary_path(executable)
            if not executable.is_file():
                raise BridgeError('installation_missing', 'The installed Windows interpreter is missing.')
        support = self.support_loader(tree.path(('win_support.py',)))
        owner = support.get_identity()
        if (type(owner) is not dict or type(owner.get('sid')) is not str or
                type(owner.get('elevated')) is not bool or owner['elevated'] or
                document.get('ownerSid') != owner['sid'] or
                type(document.get('ownerElevated')) is not bool or document['ownerElevated']):
            raise BridgeError('owner_mismatch', 'Run as the original non-elevated installation owner.')
        pinned = identity.get('runtimeVersions', identity.get('runtime'))
        try:
            actual = self.version_provider()
        except Exception as exc:
            raise BridgeError('runtime_mismatch', 'The pinned Windows runtime metadata is unavailable.') from exc
        if (type(pinned) is not dict or not {'python', 'numpy', 'sherpa-onnx', 'sherpa-onnx-core'} <= pinned.keys() or
                any(type(value) is not str or actual.get(name) != value for name, value in pinned.items()) or
                not pinned['python'].startswith('3.11.') or pinned['sherpa-onnx'] != '2.0.1' or
                pinned['sherpa-onnx-core'] != '2.0.1'):
            raise BridgeError('runtime_mismatch', 'The pinned Windows runtime metadata does not match.')
        self.manifest, self.support = document, support
        if full:
            for relative, expected in components.items():
                self.check()
                if tree.hash_file(tuple(relative.split('/'))) != expected:
                    raise BridgeError('component_mismatch', 'An installed component changed.')
        return document

    def process(self, pid):
        if not integer(pid) or pid <= 0:
            return None
        try:
            process = self.support.process_info(pid)
        except OSError:
            return None
        if (type(process) is not dict or type(process.get('pid')) is not int or process['pid'] != pid or
                type(process.get('creationTime')) is not int or process['creationTime'] <= 0 or
                type(process.get('executable')) is not str):
            return None
        allowed = {str(absolute_path(self.manifest[name])).casefold()
                   for name in ('windowsPython', 'pythonBaseExecutable')}
        try:
            executable = str(absolute_path(process['executable'])).casefold()
        except BridgeError:
            return None
        return process if executable in allowed else None

    def heartbeat(self, tree):
        try:
            h = tree.json(('state', 'heartbeat.json'), maximum=8192, missing=True)
        except BridgeError as exc:
            if exc.code == 'corrupt_result':
                return None, False
            raise
        if (h is None or type(h.get('schema')) is not int or h['schema'] != 1 or
                not integer(h.get('workerPid')) or h['workerPid'] <= 0 or
                type(h.get('processCreatedAt')) is not int or h['processCreatedAt'] <= 0 or
                type(h.get('workerId')) is not str or not WORKER_ID.fullmatch(h['workerId']) or
                not hex64(h.get('engineId')) or not number(h.get('updatedAt')) or
                h.get('status') not in ('loading', 'running', 'stopping', 'stopped') or
                type(h.get('modelReady')) is not bool or
                (h.get('busyJob') is not None and not hex64(h['busyJob']))):
            return None, False
        process = self.process(h['workerPid'])
        live = process is not None and process['creationTime'] == h['processCreatedAt']
        return h, live

    def status(self, prepare=False):
        self.deadline = self.monotonic() + RUN_BUDGET_SECONDS
        self.install(full=prepare)
        h, live = self.heartbeat(self.tree())
        matching = live and h['engineId'] == self.manifest['engineId']
        running = bool(matching and h['status'] in ('loading', 'running'))
        fresh = bool(running and 0 <= self.wall_time() - h['updatedAt'] <= HEARTBEAT_SECONDS)
        return {'ok': True, 'ready': True, 'running': running,
                'modelReady': bool(running and h['modelReady']), 'heartbeatFresh': fresh,
                'busy': bool(running and h.get('busyJob')), 'prepared': bool(prepare),
                'engineId': self.manifest['engineId'], 'engine': 'NVIDIA Parakeet TDT v3 INT8',
                'device': 'cpu', 'threads': 6, 'maxSegmentSeconds': 50,
                'maxRecordingSeconds': MAX_SECONDS, 'maxAudioBytes': MAX_BYTES,
                'message': 'Installed locally. The shared worker starts on the first uncached transcription.'}

    def result(self, tree, identity, key):
        self.expired_failure = False
        document = tree.json(('queue', 'results', key, 'result.json'), missing=True, require_seal=True)
        if document is None:
            return None
        base_matches(document, identity, key)
        if document.get('status') == 'complete':
            return validate_complete(tree, document, identity, key,
                                     self.manifest['identity']['components']['model/tokens.txt'])
        if (document.get('status') != 'failed' or type(document.get('errorCode')) is not str or
                not ERROR_CODE.fullmatch(document['errorCode']) or not number(document.get('retryAfterAt')) or
                not number(document.get('createdAt')) or not number(document.get('completedAt')) or
                not integer(document.get('workerPid')) or document['workerPid'] <= 0 or
                type(document.get('workerId')) is not str or not WORKER_ID.fullmatch(document['workerId'])):
            raise BridgeError('corrupt_result', 'Invalid failed local result metadata.')
        if document['retryAfterAt'] > self.wall_time():
            raise BridgeError(document['errorCode'], 'The local transcription failed; retry after its cooldown.',
                              retryAfterAt=document['retryAfterAt'], jobKey=key)
        self.expired_failure = True
        return None

    def active(self, tree, identity, key):
        active, duplicate = set(), False
        for location in ('pending', 'inflight'):
            folder = tree.mkdir(('queue', location))
            for entry in folder.iterdir():
                if not entry.name.endswith('.json'):
                    continue
                candidate = entry.name[:-5]
                if not hex64(candidate):
                    raise BridgeError('corrupt_result', 'Invalid shared request filename.')
                tree.path(('queue', location, entry.name))
                try:
                    info = entry.lstat()
                except FileNotFoundError:
                    continue
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise BridgeError('unsafe_path', 'Invalid shared request artifact.')
                active.add(candidate)
                if candidate == key:
                    request = tree.json(('queue', location, entry.name), maximum=8192, missing=True)
                    if request is None:  # Atomic worker pending -> inflight rename.
                        continue
                    base_matches(request, identity, key)
                    if (set(request) != {'schema', 'jobKey', *identity, 'createdAt'} or
                            type(request['createdAt']) is not float or not number(request['createdAt'])):
                        raise BridgeError('corrupt_result', 'A duplicate request has invalid metadata.')
                    duplicate = True
        return active, duplicate

    def enqueue(self, tree, identity, key, raw):
        with self.lock('queue'):
            ready = self.result(tree, identity, key)
            if ready is not None:
                return ready, False
            active, duplicate = self.active(tree, identity, key)
            if not duplicate and len(active) >= MAX_QUEUE:
                raise BridgeError('queue_full', 'The shared local transcription queue is full.')
            parts = ('queue', 'inputs', identity['inputSha256'] + '.bin')
            existing = tree.read(parts, MAX_BYTES, missing=True)
            if existing is None:
                tree.atomic(parts, raw)
                existing = tree.read(parts, MAX_BYTES)
            if existing != raw or len(existing) != identity['inputBytes'] or digest(existing) != identity['inputSha256']:
                raise BridgeError('input_integrity', 'The staged recording failed its integrity check.')
            if not duplicate:
                request = {'schema': 1, 'jobKey': key, **identity, 'createdAt': float(self.wall_time())}
                tree.atomic(('queue', 'pending', key + '.json'), canonical(request))
            return None, not duplicate

    def cooldown(self, identity, key):
        tree = Artifacts(self.state_root)
        marker = tree.json((key + '.json',), maximum=8192, missing=True, require_seal=True)
        if marker is None:
            return
        base_matches(marker, identity, key)
        if (marker.get('status') != 'cooldown' or not number(marker.get('retryAfterAt')) or
                type(marker.get('errorCode')) is not str or not ERROR_CODE.fullmatch(marker['errorCode'])):
            raise BridgeError('corrupt_result', 'Invalid local cooldown metadata.')
        if marker['retryAfterAt'] > self.wall_time():
            raise BridgeError('cooldown', 'The local request is cooling down; its existing job is retained.',
                              retryAfterAt=marker['retryAfterAt'], jobKey=key)

    def record_cooldown(self, identity, key, code):
        document = {'schema': 1, 'status': 'cooldown', 'jobKey': key, **identity,
                    'errorCode': code, 'retryAfterAt': float(self.wall_time() + COOLDOWN_SECONDS)}
        tree = Artifacts(self.state_root, monotonic=self.monotonic, sleep=self.sleep)
        tree.atomic((key + '.json',), canonical(sealed(document)))

    def _launch(self, manifest, remaining):
        system_root = os.environ.get('SystemRoot') or os.environ.get('WINDIR') or r'C:\Windows'
        names = ('TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA')
        env = {name: os.environ[name] for name in names if os.environ.get(name)}
        env.update(SystemRoot=system_root, WINDIR=system_root,
                   PATH=system_root.rstrip('/' + chr(92)) + chr(92) + 'System32')
        argv = [manifest['windowsPython'], '-X', 'utf8', '-I', '-B', str(self.root / 'bootstrap.py'), 'ensure']
        # File-backed capture avoids Windows sandbox named-pipe restrictions.
        with tempfile.TemporaryFile(mode='w+b') as output:
            try:
                result = subprocess.run(argv, cwd=str(self.root), env=env, shell=False,
                                        stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.DEVNULL,
                                        close_fds=True, timeout=min(BOOTSTRAP_TIMEOUT_SECONDS, remaining),
                                        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            except subprocess.TimeoutExpired as exc:
                # Only subprocess.run's bootstrap child is reaped; the worker is detached.
                raise BridgeError('bootstrap_failed', 'The local bootstrap did not complete in time.') from exc
            except OSError as exc:
                raise BridgeError('bootstrap_failed', 'The verified Windows bootstrap could not start.') from exc
            output.seek(0)
            raw = output.read(16385)
        if len(raw) > 16384:
            raise BridgeError('bootstrap_failed', 'The bootstrap returned invalid metadata.')
        try:
            answer = parse_json(raw)
        except BridgeError as exc:
            raise BridgeError('bootstrap_failed', 'The bootstrap returned invalid metadata.') from exc
        good = answer.get('ok') is True and answer.get('status') in ('running', 'started')
        pending = answer.get('ok') is False and answer.get('status') == 'startup_pending'
        if good and result.returncode == 0:
            if not integer(answer.get('workerPid')) or answer['workerPid'] <= 0:
                raise BridgeError('bootstrap_failed', 'The bootstrap did not identify a worker.')
            return answer
        if pending and result.returncode != 0:
            if not integer(answer.get('launcherPid')) or answer['launcherPid'] <= 0:
                raise BridgeError('bootstrap_failed', 'The bootstrap did not identify its pending worker.')
            return answer
        code = answer.get('status')
        if code not in ('version_conflict', 'stopping', 'startup_failed'):
            code = 'bootstrap_failed'
        raise BridgeError(code, 'The shared local worker is not available for this request.')

    def finish(self, ready, key, cache_hit):
        self.check()
        text, document = ready
        return {'ok': True, 'text': text, 'duration': document['audioSeconds'],
                'inferenceSeconds': document['inferenceSeconds'], 'windows': len(document['segments']),
                'cacheHit': bool(cache_hit), 'modelLoadedThisJob': document['modelLoadedThisJob'],
                'engineId': document['engineId'], 'workerId': document['workerId'],
                'workerPid': document['workerPid'], 'jobKey': key}

    def transcribe(self, raw, test_nonce=None, started=None):
        started = self.monotonic() if started is None else started
        self.deadline = started + RUN_BUDGET_SECONDS
        identity = key = None
        try:
            validate_wav(raw)
            self.check()
            self.install()
            identity, key = job_identity(self.manifest['engineId'], raw, test_nonce)
            tree = self.tree()
            with self.lock('job.' + key):
                ready = self.result(tree, identity, key)
                if ready is not None:
                    return self.finish(ready, key, True)
                self.cooldown(identity, key)
                ready, published = self.enqueue(tree, identity, key, raw)
                if ready is not None:
                    return self.finish(ready, key, True)
                h, live = self.heartbeat(tree)
                ever_live = bool(live)
                launched = recovery_used = False
                pending_process = None
                grace_until = 0
                next_health = self.monotonic()
                retried_expired = bool(published)
                while True:
                    self.check()
                    ready = self.result(tree, identity, key)
                    if ready is not None:
                        return self.finish(ready, key, False)
                    if self.monotonic() >= next_health:
                        h, live = self.heartbeat(tree)
                        if live:
                            if h['engineId'] != self.manifest['engineId']:
                                raise BridgeError('version_conflict', 'A different shared worker engine is still running.')
                            ever_live = True
                            pending_process = None
                            # Loading, busy, stale or stopping live workers are never restarted.
                        else:
                            pending_alive = False
                            if pending_process is not None:
                                process = self.process(pending_process['pid'])
                                pending_alive = bool(process and process['creationTime'] == pending_process['creationTime'])
                            if not pending_alive and self.monotonic() >= grace_until:
                                with self.lock('bootstrap'):
                                    ready = self.result(tree, identity, key)
                                    if ready is not None:
                                        return self.finish(ready, key, False)
                                    h, live = self.heartbeat(tree)
                                    if live:
                                        if h['engineId'] != self.manifest['engineId']:
                                            raise BridgeError('version_conflict', 'A different shared worker engine is still running.')
                                        ever_live = True
                                    else:
                                        if launched and not ever_live:
                                            raise BridgeError('bootstrap_failed', 'The shared worker did not become ready; the job remains queued.')
                                        if ever_live:
                                            if recovery_used:
                                                raise BridgeError('worker_stopped', 'The shared worker stopped after bounded recovery; the job remains queued.')
                                            recovery_used = True
                                        self.check()
                                        answer = self.launcher(self.manifest, self.deadline - self.monotonic())
                                        if (type(answer) is not dict or
                                                not ((answer.get('ok') is True and answer.get('status') in ('running', 'started')) or
                                                     (answer.get('ok') is False and answer.get('status') == 'startup_pending'))):
                                            raise BridgeError('bootstrap_failed', 'The bootstrap did not confirm a worker or bounded startup.')
                                        pid = answer.get('workerPid') if answer.get('ok') is True else answer.get('launcherPid')
                                        if not integer(pid) or pid <= 0:
                                            raise BridgeError('bootstrap_failed', 'The bootstrap did not identify its worker.')
                                        pending_process = self.process(pid)
                                        grace_until = self.monotonic() + STARTUP_GRACE_SECONDS
                                        launched = True
                                        self.check()
                        # An expired failed orphan is cleaned, not retried, by the worker.
                        # Publish one fresh pending request only after it is truly absent.
                        if self.expired_failure and not retried_expired:
                            ready, published = self.enqueue(tree, identity, key, raw)
                            if ready is not None:
                                return self.finish(ready, key, False)
                            retried_expired = bool(published)
                        next_health = self.monotonic() + HEALTH_CHECK_SECONDS
                    self.sleep(min(POLL_SECONDS, max(0, self.deadline - self.monotonic())))
        except BridgeError as exc:
            if identity is not None and exc.code in ('deadline', 'bootstrap_failed', 'worker_stopped', 'startup_failed'):
                try:
                    self.record_cooldown(identity, key, exc.code)
                except (BridgeError, OSError):
                    pass  # Keep the original bounded error; never alter shared job artifacts.
            raise


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise BridgeError('invalid_arguments', 'Invalid local bridge arguments.')


def main(argv=None, *, stdin=None, stdout=None, bridge_factory=Bridge, require_windows=True):
    stdout = sys.stdout if stdout is None else stdout
    try:
        parser = ArgumentParser(description=__doc__)
        parser.add_argument('action', choices=('status', 'prepare', 'transcribe'))
        parser.add_argument('--root', default=DEFAULT_ROOT)
        parser.add_argument('--test-nonce', help='Operator-only fresh test identity; never normal UI configuration')
        args = parser.parse_args(argv)
        if args.test_nonce is not None and args.action != 'transcribe':
            raise BridgeError('invalid_arguments', 'Test identity is only available for transcription.')
        if require_windows and (sys.platform != 'win32' or sys.version_info[:2] != (3, 11)):
            raise BridgeError('requires_windows_python_3_11', 'The installed native Windows Python 3.11 runtime is required.')
        bridge = bridge_factory(args.root)
        if args.action == 'transcribe':
            started = bridge.monotonic()
            source = sys.stdin.buffer if stdin is None else stdin
            chunks, count = [], 0
            while True:
                block = source.read(min(1024 * 1024, MAX_BYTES + 1 - count))
                if not block:
                    break
                chunks.append(block)
                count += len(block)
                if count > MAX_BYTES:
                    raise BridgeError('invalid_input_size', 'Audio exceeds the 20 MiB request limit.')
                if bridge.monotonic() - started >= RUN_BUDGET_SECONDS:
                    raise BridgeError('deadline', 'The local audio submission deadline exceeded.')
            result = bridge.transcribe(b''.join(chunks), args.test_nonce, started=started)
        else:
            result = bridge.status(prepare=args.action == 'prepare')
        raw = canonical(result)
        if len(raw) > MAX_JSON_BYTES:
            raise BridgeError('result_too_large', 'The local response exceeds its safe bound.')
        stdout.write(raw.decode('utf-8') + '\n')
        return 0
    except BridgeError as exc:
        result = {'ok': False, 'ready': False, 'running': False, 'modelReady': False,
                  'code': exc.code, 'error': exc.message, **exc.metadata}
    except (OSError, ValueError, TypeError, KeyError, RecursionError, OverflowError):
        result = {'ok': False, 'ready': False, 'running': False, 'modelReady': False,
                  'code': 'bridge_failed', 'error': 'Local Parakeet installation or queue access failed.'}
    except Exception:
        result = {'ok': False, 'ready': False, 'running': False, 'modelReady': False,
                  'code': 'bridge_failed', 'error': 'The local Parakeet request could not complete.'}
    stdout.write(canonical(result).decode('utf-8') + '\n')
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
