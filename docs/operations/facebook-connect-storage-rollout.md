# Facebook connect-state sealing rollout

Facebook authorization codes and Page access tokens live in Redis for at most
10 minutes while a customer completes Page connection. Their storage format is
a rolling-deploy protocol controlled by `FACEBOOK_CONNECT_STORAGE_MODE`.

The first reviewed runtime image containing the dual-reader understands three
exact values. This is not the separate `image-gen-bridge` schema-migration
artifact, which deliberately keeps the legacy application runtime unchanged.

| Mode            | Reads                | Writes            | Intended phase                                                   |
| --------------- | -------------------- | ----------------- | ---------------------------------------------------------------- |
| `legacy_compat` | plaintext and sealed | plaintext         | First dual-reader runtime rolling deploy                         |
| `sealed_compat` | plaintext and sealed | AES-GCM envelopes | Config-only release after every pre-dual-reader instance drained |
| `sealed_only`   | sealed only          | AES-GCM envelopes | Final config-only release after the legacy state TTL has elapsed |

An unset value defaults to `legacy_compat`. Any other non-empty value stops
startup. `JWT_SECRET` must remain identical across app instances and at least
32 bytes; changing it makes in-flight sealed states unreadable.

## Required sequence

1. Complete the protected schema transition first. Its migration bridge does
   not contain the OAuth dual-reader and does not advance this protocol.
2. Deploy the reviewed runtime image containing the dual-reader with the
   committed Fly value still set to `legacy_compat`. Do not change the mode in
   the code/image release. During this rolling deploy, old and new instances
   exchange only the legacy shape, while new instances prove they can read
   either shape.
3. Prove that every serving app instance uses that dual-reader runtime and that
   no pre-dual-reader instance can receive traffic or be restarted. In a
   separate, reviewed config-only release, change the Fly value to
   `sealed_compat`.
4. Wait more than 600 seconds after the last `sealed_compat` Machine becomes
   healthy. This covers the complete Redis state TTL after the last possible
   legacy writer. Then, in another config-only release, change the value to
   `sealed_only`.

Never deploy the first dual-reader runtime and `sealed_compat` together. A
pre-dual-reader instance can mistake an `fc1:` Page-token envelope for a usable
plaintext credential.
The committed `fly.toml` therefore stays on `legacy_compat` for the first code
release. Later mode changes must use the protected production workflow and the
same reviewed immutable dual-reader runtime image; do not perform an ad-hoc
workstation deploy or create unreviewed Fly config drift.

## Rollback boundary

- In phase 1, the previous image is compatible because all writes remain
  plaintext.
- From phase 2 onward, never roll back to a pre-dual-reader image. Every reviewed
  rollback image must be a dual-reader that recognizes both legacy and sealed
  records. Keep `sealed_compat` during a phase-2 rollback.
- Enter `sealed_only` only after the TTL wait and after confirming that the
  retained rollback image is the dual-reader runtime. A rollback must not
  restore legacy writes after sealed records exist.

Do not inspect or log Redis values while validating the rollout. Use only
image/config identity, Machine health, generic error counts, and a dedicated
test-tenant connect smoke. Authorization codes, Page tokens, PSIDs, and sealed
envelopes are customer secrets and must not appear in rollout evidence.
