# Face Memory

Face memory is an optional Messenger feature that lets a user reuse one uploaded source photo for a limited retention window without uploading again.

The feature must stay disabled until legal/privacy copy is approved:

```env
ENABLE_FACE_MEMORY=false
# Optional; defaults to 30.
FACE_MEMORY_RETENTION_DAYS=30
```

## User Flow

1. User uploads a photo in Messenger.
2. The bot stores the inbound source image using the normal source-image storage path.
3. If `ENABLE_FACE_MEMORY=true` and the user has no prior face-memory decision, the bot asks for explicit consent.
4. If the user accepts the retention prompt, state stores:
   - `faceMemoryConsent.given=true`
   - consent timestamp
   - consent version `v1`
   - `lastSourceImageUrl`
   - `lastSourceImageUpdatedAt`
   - `pendingImageUrl` remains in state before the consent click, so consent still works after a server restart when Redis is configured.
5. If the user chooses `Nee`, the normal single-session image flow continues, but no reusable face-memory source is retained.
6. The user can request natural-language edits from the retained source image during the configured retention window.
7. The user can send `verwijder mijn data` or `delete my data` to delete retained face-memory state.
8. A daily expiry task clears retained face-memory data older than the configured retention window.

A declined consent choice is respected and does not trigger repeated prompts on every later photo upload. If product wants users to opt in later, add an explicit opt-in command and have legal approve that copy.

## Legal Review Checklist

Legal should approve these exact surfaces before enabling the feature:

- Messenger consent copy and quick-reply labels.
- `/privacy` page text, especially the optional photo-memory retention paragraph.
- `/data-deletion` page text if it claims deletion paths or retained image handling.
- The technical statement that Leaderbot stores the source photo URL and consent metadata, but does not create face embeddings, face vectors, face templates, or biometric identification profiles.
- The operational deletion controls: user command, daily expiry, and admin kill switch.

This feature is intended as limited photo retention for user convenience. It must not be used for identity verification, authentication, matching users across contexts, or uniquely identifying a person.

## Data Stored

Stored in Messenger state:

- pseudonymous Messenger state key
- `faceMemoryConsent`
- `lastSourceImageUrl`
- `lastSourceImageUpdatedAt`
- `pendingSourceImageDeleteUrl`, only when object-storage deletion failed and needs a later retry

Stored in object storage:

- the uploaded source image file referenced by `lastSourceImageUrl`

Not stored:

- face embeddings
- biometric templates
- facial geometry vectors
- identity matching records

## Retention And Deletion

Maximum retention is controlled by `FACE_MEMORY_RETENTION_DAYS`, counted from `lastSourceImageUpdatedAt`. The default is 30 days. Invalid, non-integer, or non-positive values fall back to 30 days.

Runtime state for active face memory or pending object-storage deletion is kept for the configured retention window plus two days. The extra two-day buffer lets the daily expiry sweep see inactive users after the retention window and delete object-storage files before Redis metadata expires.

Object storage retention must also be enforced by the Cloudflare R2 lifecycle
policy in [`r2-retention.md`](r2-retention.md). The application expiry job can
only delete objects while their state references still exist; the R2 lifecycle
rule is the required backstop for orphaned `inbound-source/` objects.

Deletion paths:

- User command: `verwijder mijn data` or `delete my data`.
- Daily expiry task: clears expired face-memory state and attempts object-storage deletion.
- Failed object-storage deletes leave a non-active `pendingSourceImageDeleteUrl` retry marker so later expiry runs can retry cleanup.
- Admin kill switch: `POST /admin/disable-face-memory` with `X-Admin-Token`. Auth failures, rate-limited attempts, and successful kill-switch runs are logged.

Generation refreshes stored source-image URLs through the storage proxy download-url endpoint when `BUILT_IN_FORGE_API_URL` is configured. This keeps retained source-photo generation compatible with short-lived signed public URLs.

Kill-switch example:

```bash
curl -X POST https://leaderbot.live/admin/disable-face-memory \
  -H "X-Admin-Token: <ADMIN_TOKEN>"
```

Before using the kill switch in production, set `ENABLE_FACE_MEMORY=false` and redeploy or restart so no new consent prompts are shown.

## Rollout

Recommended rollout:

1. Keep `ENABLE_FACE_MEMORY=false` while code and legal copy are reviewed.
2. Enable only for internal/test accounts.
3. Monitor bot logs, deletion behavior, storage deletion, and Meta dashboard warnings.
4. Roll out gradually only after the privacy policy is live and approved.
