# Sources, licenses and review notes

This private local bundle's own source and original icon: MIT. It is not published or packed. Python wheels retain their upstream license notices in .venv; pinned ONNX model cards are retained verbatim under models/. Models are loaded as data, without executing remote repository Python.

- C2PA SDK: https://github.com/contentauth/c2pa-python (c2pa-python 0.38.0, latest compatible Windows wheel at setup; newer 0.38.2 has no Windows wheel). MIT OR Apache-2.0. The official Rust validation engine is included in the binary wheel. Cryptographic validation, not a pixel watermark decoder.
- Russian text: https://huggingface.co/toiletsandpaper/russian-ai-text-detector-bert . MIT; based on cointegrated/rubert-tiny2 (MIT), trained on Russian LLMTrace. The pinned card provides training provenance and false-positive limitations; reported metrics are not independent validation.
- Image classifier: https://huggingface.co/onnx-community/ai-image-detect-distilled-ONNX . MIT; converted from https://huggingface.co/jacoballessio/ai-image-detect-distilled . Kept at float32, not re-quantized. Explicit fake=0 / real=1 labels. It is a weak screening model, not conclusive forensic evidence.
- ONNX Runtime: https://github.com/microsoft/onnxruntime (MIT); telemetry disabled.
- Hugging Face Tokenizers: https://github.com/huggingface/tokenizers (Apache-2.0).
- Pillow: https://github.com/python-pillow/Pillow (MIT-CMU / HPND notices retained in installed distribution).
- NumPy: https://github.com/numpy/numpy (BSD-3-Clause).
- Trust inputs: https://github.com/c2pa-org/conformance-public and https://github.com/contentauth/verify-site . Public certificate/trust data, retained verbatim with source commit and SHA-256; no private signing keys. These lists express upstream trust policy, not an independent guarantee.

## Research, not installed as detectors

- Official SynthID: https://deepmind.google/models/synthid/ ; public detector described in https://blog.google/innovation-and-ai/models-and-research/google-deepmind/synth-id-ai-content/ . Its existence does not supply this plugin with a public programmatic decoder or production text keys.
- SynthID Text: https://github.com/google-deepmind/synthid-text (Apache-2.0 code, CC-BY-4.0 other materials); matching secret/configuration needed. Not installed because it would not verify arbitrary Gemini text.
- Official C2PA MCP: https://github.com/contentauth/c2pa-mcp (MIT OR Apache-2.0). Reviewed v0.2.2; not installed directly: Reader errors are collapsed into no_credentials, URL input is fetched without the local plugin's bounds. This bundle uses the official SDK directly and disables remote network lookups.

No claim is made that SynthID is a generic standard or that a vendor uses it unless independently documented. C2PA is a separate provenance standard. Watermark declarations, pixel signals, text statistics and validated signatures are distinct evidence types.
