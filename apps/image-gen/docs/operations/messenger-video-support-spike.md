# Messenger video support spike

Status: planning only.
Last reviewed: 2026-06-11.

## Scope

This document defines the minimum architecture requirements before Messenger generated-video support can be implemented.

This does not enable production video generation.

Out of scope for this spike:

- OpenAI video adapter implementation.
- Provider submission.
- Messenger video delivery code.
- Queue runtime changes.
- Gateway or deploy changes.
- Free-tier limit changes.

## Current behavior

Messenger video uploads are unsupported input.

The bot must keep replying with clear unsupported-media copy instead of sending videos into image generation or generic fallback paths.

Animation-style requests such as "laat hem dansen", "laat hem zingen", and "laat hem bewegen" are treated as video/animation intent recovery. They must not start image or video generation until generated video is explicitly enabled.

## Required product boundary

Video support has two separate product concepts:

- Uploaded video as input: currently unsupported.
- Generated video as output: future paid operation.

The first production video implementation should support generated video output only behind a feature flag unless uploaded-video input has its own product, safety, storage, and Meta-review plan.

## Paid-operation quota rule

Every paid external request must reserve quota before provider submission.

The required lifecycle is:

1. Reserve before any paid provider call.
2. Submit to provider only after a valid reservation exists.
3. Commit only on usable success.
4. Release on provider failure, validation failure, delivery-aborted failure, or user-visible cancellation.
5. Expire stale reservations automatically.

Future video generation must not copy the legacy image model of checking quota before the call and incrementing after success.

Video quota must use its own namespace and state, separate from image generation and audio transcription.

## Provider abstraction

Generated video should be behind a small provider interface before runtime routing is enabled.

The interface should isolate:

- prompt and source-image inputs;
- model/provider choice;
- timeout settings;
- retry eligibility;
- provider job id;
- generated artifact URL or bytes;
- final status;
- provider error class.

The Messenger router should not call provider SDKs directly.

## Storage requirements

Generated video artifacts must not depend on provider-hosted temporary URLs for Messenger delivery.

Before enabling production video, the implementation needs:

- durable storage for generated video files;
- content-type preservation;
- size and duration metadata;
- retention policy;
- deletion behavior aligned with GDPR deletion;
- signed or proxy URLs compatible with Messenger crawler access;
- redacted logs that never include raw PSIDs, provider URLs, storage URLs, or tokens.

## Messenger delivery constraints to verify

Before implementation, verify current Meta Messenger send API constraints for:

- supported video formats;
- max file size;
- max duration;
- upload-by-URL behavior;
- attachment reuse behavior;
- crawler access requirements;
- send timeout behavior;
- error codes for unsupported or expired media.

These constraints must be documented in the implementation PR before enabling the feature flag.

## Budget and safety controls

Generated video is expected to be higher cost than image generation.

Before provider calls are enabled, the implementation needs:

- per-user daily video quota;
- global daily video cap;
- feature flag defaulting off;
- provider timeout;
- retry cap;
- budget-aware failure copy;
- safe structured logs with provider status but no user content or raw identifiers;
- clear owner-facing metrics for reserved, committed, released, expired, failed, and delivered video attempts.

## UX requirements

While disabled:

- video uploads remain unsupported;
- animation requests explain that video is not available yet;
- users should be guided toward supported photo edits.

When generated video is enabled:

- copy must distinguish generated video from photo editing;
- quota exhaustion must be specific to video;
- provider timeout/failure must not fall back to generic "Oeps" when the failure class is known;
- if a source image is needed, the user must be asked for a photo before provider submission.

## Acceptance criteria before PR C implementation

PR C must include tests for:

- successful generated video flow;
- provider failure and reservation release;
- quota exhaustion before provider submission;
- timeout behavior;
- retry behavior;
- concurrent reservation attempts;
- feature flag disabled behavior;
- Messenger delivery failure handling;
- unsupported uploaded-video input remains unchanged.

PR C must also include an implementation plan covering:

- provider choice;
- API flow;
- storage flow;
- Messenger delivery flow;
- quota flow;
- migration risks;
- test plan.
