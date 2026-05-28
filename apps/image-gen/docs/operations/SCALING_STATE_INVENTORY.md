# Scaling State Inventory

This inventory tracks runtime state that affects horizontal scaling for Messenger image generation.

## Redis-backed or Redis-capable

- `stateStore.ts`: conversation state, quota state, pending image metadata, face-memory metadata, and ephemeral locks use Redis when `REDIS_URL` is configured. Production startup already requires `REDIS_URL`.
- `generationGuard.ts`: per-user generation locks use `stateStore` ephemeral keys, so the same lock is cross-instance when Redis is enabled.
- `webhookReplayProtection.ts`: webhook replay keys use Redis in production.
- `meta/webhookIngressQueue.ts`: Meta webhook deliveries can be queued in Redis, with inline fallback if enqueue fails.
- `messengerGenerationQueue.ts`: Messenger generation jobs can be queued in Redis when `MESSENGER_GENERATION_QUEUE_ENABLED=1`. Jobs move from a pending list to a processing list before execution and receive a Redis lease; expired reserved jobs are reclaimed on worker drain, so a worker restart does not silently drop jobs while active workers are left alone.

## Local process state

- `generatedImageStore.ts`: in-memory generated image fallback. This is safe for local/dev only; production startup requires object storage credentials and should not rely on this path.
- `webhookHandlers.ts`: `inFlightNoticeSent` is process-local and only suppresses duplicate "still working" notices. It does not protect generation; Redis-backed `generationGuard` does.
- `botRuntimeStats.ts`: node-local stats for bot diagnostics. Not used for generation correctness.
- `bot/features/rateLimitFeature.ts`: feature-level user throttling stores buckets through `stateStore`, so it is Redis-capable.

## Local disk / volume coupling

- `sourceImageFetcher.ts`: `DEBUG_IMAGE_PROOF=1` can write debug images to `os.tmpdir()` outside production. Production ignores this flag.
- Static assets under `public/` are bundled app assets, not generated runtime state.
- No production path should depend on a Fly volume for generated or source images. Source and generated images should use object storage via `BUILT_IN_FORGE_API_URL` and `BUILT_IN_FORGE_API_KEY`.

## Worker migration flags

- `MESSENGER_GENERATION_QUEUE_ENABLED=1`: enqueue Messenger generation jobs in Redis instead of running them immediately in the webhook processor.
- `MESSENGER_GENERATION_INLINE_FALLBACK=0`: disables same-process queue draining, intended only once a dedicated worker is running.
- `MESSENGER_GENERATION_WORKER=1`: starts the Messenger generation queue worker loop in this process.
- `MESSENGER_GENERATION_WORKER_ONLY=1`: starts only the Messenger generation worker and skips binding the HTTP gateway.
- `MESSENGER_GENERATION_JOB_LEASE_SECONDS`: optional reserved-job lease TTL, default `900`.
- `MESSENGER_GENERATION_WORKER_POLL_MS`: optional worker poll interval, default `1000`.

## Remaining scaling work

- Run gateway instances with `MESSENGER_GENERATION_QUEUE_ENABLED=1` and `MESSENGER_GENERATION_INLINE_FALLBACK=0`.
- Run at least one worker process with `MESSENGER_GENERATION_QUEUE_ENABLED=1` and `MESSENGER_GENERATION_WORKER_ONLY=1`.
- Replace the Redis list with a stronger queue primitive if strict retry visibility or dead-lettering becomes necessary.
- Add an idempotency marker before broad worker rollout if duplicate Messenger sends after worker crash become unacceptable. The current queue favors at-least-once completion over silently losing image jobs.
- Remove or isolate CPU-heavy base64/image buffer work from gateway processes completely once worker deployment is stable.
