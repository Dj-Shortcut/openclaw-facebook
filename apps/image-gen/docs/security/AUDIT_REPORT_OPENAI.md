# Superseded OpenAI Audit

This historical audit has been superseded by the current Leaderbot architecture.

Current state:

- Free-text Messenger and WhatsApp replies are deterministic and do not use an OpenAI chat path.
- The old Messenger chat experiment and generic chat route have been removed from the active runtime.
- Image generation currently uses the existing OpenAI Responses image_generation tool provider boundary, `openai-images`.
- Future image-provider changes should stay behind the image provider boundary rather than through webhook or text-handler code.
