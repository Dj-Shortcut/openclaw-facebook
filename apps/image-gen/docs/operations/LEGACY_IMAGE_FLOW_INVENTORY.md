# Legacy image-flow inventory

Free text-to-image generation is now the primary direction for new image requests. The old style catalog remains as a compatibility layer until the generic flow is proven in production.

Keep these legacy flows working for now, but migrate or remove them in separate PRs:

- Messenger state quick replies for intro/help, `RESULT_READY`, and `FAILURE`.
- Messenger style category and style option payloads: `STYLE_CATEGORY_*`, `STYLE_*`, `CHOOSE_STYLE`.
- Retry payloads: `RETRY_STYLE` and `RETRY_STYLE_*`.
- Referral style entry via `style_*` refs.
- WhatsApp plain-text style/category selection flows.
- Static style catalog assets and preview UI.

Do not add new product behavior to these paths unless it preserves compatibility. New image-generation choices should originate as channel-neutral conversation actions and be rendered at the channel edge.
