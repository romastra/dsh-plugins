# Codex overload recovery

Classifies the known Codex overload response as retryable in DSH `0.2.2-rc.3` or `0.2.2-rc.5`. It uses the selected provider’s normal bounded same-step recovery and does not repeat previously committed tool calls or change the provider’s policy. Use `autorecovery_status` to read the effective policy.
