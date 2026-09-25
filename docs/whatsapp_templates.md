# WhatsApp templates for COD and cart recovery

COD confirmations and cart reminders usually reach people who have not messaged the
business in the last 24 hours. Meta only delivers **approved templates** to them, so
each store needs these templates approved in its WABA, then saved through
`PATCH /api/commerce/settings` (or the Commerce tab).

| Setting | Category | Body variables | Buttons |
|---|---|---|---|
| `codTemplateName` | Utility | `{{1}}` customer name, `{{2}}` order number, `{{3}}` amount | Quick reply 1 = Confirm, Quick reply 2 = Cancel |
| `cartTemplateNames[0]` (15 min) | Marketing | `{{1}}` name, `{{2}}` cart value, `{{3}}` checkout link | none |
| `cartTemplateNames[1]` (6 h) | Marketing | `{{1}}` name, `{{2}}` cart value, `{{3}}` discount code, `{{4}}` checkout link | none |
| `cartTemplateNames[2]` (24 h) | Marketing | same as stage 2 | none |

`templateLanguage` is the template's language code (default `en`).
Discount codes come from `CART_DISCOUNT_STAGE2` / `CART_DISCOUNT_STAGE3` (defaults `SAVE5`, `SAVE10`).

Without a template the backend sends the free-form version only when the customer's
24h window is open. Otherwise nothing is sent, and the order or cart records
`NO_TEMPLATE_CONFIGURED` so the dashboard can show why.
