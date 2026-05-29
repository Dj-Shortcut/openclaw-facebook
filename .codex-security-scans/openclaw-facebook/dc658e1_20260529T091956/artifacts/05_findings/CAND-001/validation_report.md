# CAND-001 Validation

`src/monitor.ts:704-715` returns the sole configured target even when a present `recipient.id` does not match any target. The caller at `src/monitor.ts:1277` uses that target for processing. HMAC validation is required, so this is wrong-Page binding rather than unauthenticated spoofing.
