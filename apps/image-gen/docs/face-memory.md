# Face Memory

Face memory is an optional Messenger feature that lets a user reuse one uploaded source photo for up to 30 days without uploading again.

The feature must stay disabled until legal/privacy copy is approved:

```env
ENABLE_FACE_MEMORY=false
```

## User Flow

1. User uploads a photo in Messenger.
2. The bot stores the inbound source image using the normal source-image storage path.
3. If `ENABLE_FACE_MEMORY=true` and the user has no prior face-memory decision, the bot asks for explicit consent.
4. If the user chooses `Ja, 30 dagen`, state stores:
   - `faceMemoryConsent.given=true`
   - consent timestamp
   - consent version `v1`
   - `lastSourceImageUrl`
   - `lastSourceImageUpdatedAt`
   - `pendingImageUrl` remains in state before the consent click, so consent still works after a server restart when Redis is configured.
5. If the user chooses `Nee`, the normal single-session image flow continues, but no reusable face-memory source is retained.
6. The user can generate styles from the retained source image during the 30-day window.
7. The user can send `verwijder mijn data` or `delete my data` to delete retained face-memory state.
8. A daily expiry task clears retained face-memory data older than 30 days.

A declined consent choice is respected and does not trigger repeated prompts on every later photo upload. If product wants users to opt in later, add an explicit opt-in command and have legal approve that copy.

## Legal Review Checklist

Legal should approve these exact surfaces before enabling the feature:

- Messenger consent copy and quick-reply labels.
- `/privacy` page text, especially the optional 30-day photo-memory paragraph.
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

Maximum retention is 30 days from `lastSourceImageUpdatedAt`.

Runtime state for active face memory or pending object-storage deletion is kept for 32 days. The extra two-day buffer lets the daily expiry sweep see inactive users after the 30-day retention window and delete object-storage files before Redis metadata expires.

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
