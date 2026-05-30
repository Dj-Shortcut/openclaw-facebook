# Legacy image-flow inventory

Free text-to-image generation is now the primary direction for new image requests. The old style catalog remains as a compatibility layer until the generic flow is proven in production.

Keep these legacy flows working for now, but migrate or remove them in separate PRs:

- Messenger state quick replies that still exist as style-picker compatibility fallbacks.
- Messenger style category and style option payloads: `STYLE_CATEGORY_*`, `STYLE_*`, `CHOOSE_STYLE`.
- Retry payloads: `RETRY_STYLE` and `RETRY_STYLE_*`.
- Referral style entry via `style_*` refs.
- WhatsApp plain-text style/category selection flows.
- Static style catalog assets and preview UI.

The default Messenger generation success/failure follow-ups and their greeting fallbacks no longer open the style picker; new image choices originate as channel-neutral actions and Messenger maps those clicks back into normal text input.
The help/menu flow with an existing photo also uses channel-neutral actions instead of opening the style-category picker by default.
Conversational edits with no known previous style use the prompt-first generation fallback instead of opening the style picker.
`IDLE`, `RESULT_READY`, and `FAILURE` no longer define Messenger-state quick replies; their choices are conversation actions.
Messenger GDPR consent and delete-confirm choices also use channel-neutral conversation actions before the Messenger renderer converts them into quick replies.
WhatsApp generation follow-up copy no longer suggests `nieuwe stijl` / `new style` as the default next step; users are guided back to prompt-first creation or edits.

Do not add new product behavior to these paths unless it preserves compatibility. New image-generation choices should originate as channel-neutral conversation actions and be rendered at the channel edge.
