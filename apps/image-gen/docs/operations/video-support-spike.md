# Messenger video input/output spike (design note)

## Current status (now)

- Inbound Messenger video attachments are treated as unsupported media.
- No generated video output path exists for Messenger in this release.
- Existing photo and image-generation flows remain unchanged.
- Supported copy for non-photo uploads now explains what is and is not possible in Dutch, and keeps image edits available when the user already has an editable image.

## Why video as unsupported input now

- Existing pipeline expects a source image URL that maps to image fetch + normalization + image generation.
- Current media policy routes `video` attachments to a dedicated unsupported branch and does not call image handlers.
- This prevents queue/workflow divergence and avoids accidental image-generation jobs for non-photo assets.

## Future video input support sketch

- Convert the existing `MessengerAttachmentRoute` branch `unsupported_video`
  into a supported video processing path.
- Add ingestion validation and normalization for short-form clips.
- Decide where video content is temporarily stored:
  - short-lived encrypted object storage for source media
  - metadata-only references in state and logs
  - tenant-scoped retention policy matching existing image source policy.
- Extend generation job metadata with `mediaKind: "image" | "video"` and output type.
- Add a dedicated video feature flag to keep image and video jobs isolated by quota and billing.

## Future video output support sketch

- Separate render path for generated media artifacts:
  - content type and extension enforcement (mp4)
  - stricter payload size/length limits
  - different CDN/storage lifecycle rules.
- Add a Messenger-only rendering branch for video upload or quick-reply follow-up.

## Meta upload and delivery constraints to validate

- Validate allowed and blocked MIME/type combinations for Messenger attachments.
- Confirm attachment URL TTL behavior for temporary media URLs.
- Determine whether uploaded media can be fetched server-side with current token model.
- Validate whether video upload size and duration constraints differ from current image fetch assumptions.

## Storage, operations, and budget checks

- Budget guard should enforce a separate quota namespace for video jobs.
- Keep video generation out of the current image budget counters during spike unless explicitly merged.
- Add queue capacity, timeout and retry constraints before piloting.
- Add explicit storage cost estimate per minute/MB for temporary clip retention.

## UX copy baseline for pilot

- Input: current user-facing copy remains
  - "Ik kan momenteel alleen foto’s bewerken. Video’s worden nog niet ondersteund. Stuur een foto om verder te gaan."
  - for known previous image: "Ik kan nog geen video maken, maar ik kan wel een foto aanpassen..."
- Animation intent text should continue routing to the same "photo-edit fallback" path until actual video output is introduced:
  - "Ik kan nog geen video maken, maar ik kan wel een foto aanpassen. Wil je bijvoorbeeld een podium, disco-achtergrond of danspose?"

## Open questions

- What is the max practical clip duration for first production trial?
- Does Meta require a dedicated permission scope change for longer clip upload handling?
- Which job priority and cost model should video and image share (if any)?
