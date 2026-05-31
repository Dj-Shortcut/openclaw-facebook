# Legacy image-flow inventory

Free text-to-image generation is now the primary direction for new image requests. The old style-picker UI and payload routes are deprecated; any remaining style presets are internal compatibility for explicit natural-language/photo-edit requests.

Removed legacy flows:

- Messenger state quick replies used as style-picker fallbacks.
- Messenger style category and style option payloads: `STYLE_CATEGORY_*`, `STYLE_*`, `CHOOSE_STYLE`.
- WhatsApp style/category list menus.
- WhatsApp list-menu transport helper used by the old style/category menus.
- Referral style entry via `style_*` refs.
- Stored `preselectedStyle`, `selectedStyle`, and `chosenStyle` navigation state.
- Runtime `AWAITING_STYLE` state; old persisted values are normalized to `AWAITING_EDIT_PROMPT`.
- Static style catalog assets and preview UI.

Open work is tracked only in [`todo.md`](todo.md). Internal preset prompt compatibility may remain as a backend implementation detail while product behavior stays prompt-first.

The default Messenger generation success/failure follow-ups and their greeting fallbacks no longer open the style picker; new image choices originate as channel-neutral actions and Messenger maps those clicks back into normal text input.
The help/menu flow with an existing photo also uses channel-neutral actions instead of opening the style-category picker by default.
Conversational edits with no known previous style use the prompt-first generation fallback instead of opening the style picker.
New photo uploads move into `AWAITING_EDIT_PROMPT`; `AWAITING_STYLE` exists only as persisted-state migration input in the normalizer.
`IDLE`, `RESULT_READY`, and `FAILURE` no longer define Messenger-state quick replies; their choices are conversation actions.
Typed replies such as `1`, `nr 1`, or `optie 1` resolve against the latest stored conversation actions instead of legacy style payloads.
Messenger GDPR consent and delete-confirm choices also use channel-neutral conversation actions before the Messenger renderer converts them into quick replies.
WhatsApp generation follow-up copy no longer suggests `nieuwe stijl` / `new style` as the default next step; users are guided back to prompt-first creation or edits.

Do not add new product behavior to these paths unless it preserves compatibility. New image-generation choices should originate as channel-neutral conversation actions and be rendered at the channel edge.
