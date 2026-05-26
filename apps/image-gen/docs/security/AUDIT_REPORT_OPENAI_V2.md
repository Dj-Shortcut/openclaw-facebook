# Superseded OpenAI Audit V2

This historical follow-up has been superseded by the current Leaderbot architecture.

Current state:

- Free text remains deterministic across Messenger and WhatsApp.
- Removed chat rollout and chat memory experiment code is no longer part of the runtime.
- The old generic chat endpoint is no longer mounted by the server.
- Image generation keeps the current OpenAI Images behavior through the `openai-images` provider boundary.
