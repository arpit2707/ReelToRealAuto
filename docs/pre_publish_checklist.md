# R2R — Pre-Publish Checklist
## "Meta App ko Live/Publish bhejne se pehle kya kya manage karna hai"

**App:** Reel2real · **App ID:** `1390089122590430`
**Business portfolio:** Amar Sahay (`293827523151274`)
**Domain:** `reel2realbooking.in`
**Current status:** `Unpublished` / In development

> **Sabse important baat:** Meta ka rule hai — *unpublished app ko sirf dashboard se bheje gaye test webhooks milte hain. Koi production data nahi — app admins, developers aur testers ke messages bhi nahi.* Matlab jab tak app publish nahi hota, real customer ka ek bhi message aapke server tak nahi aayega. Isliye ye checklist do hisson me hai: **publish se pehle** aur **publish ke turant baad**.

---

## Phase 0 — Code Hardening (ye publish se PEHLE hona chahiye)

Ye sabse zyada critical section hai. Ab webhooks live hain, to ye bugs theoretical nahi rahe.

- [x] **Signature verification actually call karo.** `verifySignature()` [webhook.controller.ts](../src/modules/webhook/webhook.controller.ts) se 200 se pehle call hota hai. `META_APP_SECRET` missing ho to fail-closed (reject).
- [x] **Raw body capture karo.** `NestFactory.create(AppModule, { rawBody: true })` — HMAC `req.rawBody` pe.
- [x] **`timingSafeEqual` ka length guard.** [hmac.ts](../src/common/hmac.ts) me length mismatch pe throw nahi, `false`.
- [x] **Shopify HMAC verify karo.** [shopify.controller.ts](../src/modules/shopify/shopify.controller.ts) `x-shopify-hmac-sha256` (base64) store `webhookSecret` ya `SHOPIFY_API_SECRET` se verify karta hai.
- [x] **Echo-loop guard — Messenger/Instagram.** `message.is_echo` skip.
- [x] **Self-comment guard.** `from.id === pageId` / IG account id skip.
- [x] **Idempotency / dedup.** `ProcessedWebhookEvent.eventId` unique — Meta retries skip.
- [x] **WhatsApp `statuses` handle karo.** `WhatsAppMessageStatus` me persist (frequency-cap retry ke liye foundation).
- [x] **Unknown `object` ka fallback theek karo.** Anjaan object ignore + warn, Instagram pe nahi jaata.
- [ ] Meta 500ms ke andar 200 expect karta hai. Abhi `setImmediate` se async processing hoti hai (achha hai), par proper queue (BullMQ, jo goal doc me hai) production ke liye behtar rahega.

---

## Phase 1 — Environment & Secrets

`.env` me abhi sirf `DATABASE_URL`, 2 page tokens aur `PORT` hai. Ye missing hain:

- [x] `META_APP_SECRET` — missing ho to webhook HMAC reject (fail-closed)
- [x] `META_VERIFY_TOKEN` — env se; hardcoded default hata diya. Meta dashboard token match karna zaroori hai.
- [ ] `META_APP_ID` = `1390089122590430` (env me set karo)
- [x] `ENCRYPTION_SECRET` — required; hardcoded fallback hata diya
- [ ] `AI_SERVICE_URL`
- [ ] `PUBLIC_BASE_URL`
- [ ] `SHOPIFY_API_SECRET` (webhook HMAC ke liye) + `SHOPIFY_ACCESS_TOKEN` live values
- [x] `.env.example` file banao (gitignore me `!.env.example` already allow hai)
- [ ] Confirm karo ki koi bhi real token git me commit nahi hua

---

## Phase 2 — Legal Pages (App Review ka hard blocker)

> **Status 11 Sep 2026 — pages LIVE hain.** Webapp Vercel pe deploy ho chuka hai (project `reel2real`), custom domain `reel2realbooking.in` attach hai, TLS cert issue ho gaya. GoDaddy me A record `@ -> 76.76.21.21` (Vercel) set hai, TTL 1 hour.
>
> **Ek baaki problem:** purane A record ka TTL **1 week** tha, isliye kai resolvers ne `122.176.213.75` cache kar rakha hai. Google DNS flush kar diya (ab sahi), aur 1.1.1.1 / 9.9.9.9 / OpenDNS bhi sahi hain — par **Meta ka resolver abhi purani IP pe hai**, isliye Meta ke legal-URL fields abhi bhi save nahi ho rahe ("should represent a valid URL"). Ye apne aap theek hoga jab unka cache expire hoga. Tab tak bas retry karte raho.

- [x] Webapp Vercel pe deploy — `reel2realbooking.in` live, HTTPS valid
- [x] `/privacy`, `/terms`, `/data-deletion` — teeno 200 dete hain
- [x] `next.config.ts` redirects: `/privacy-policy` -> `/privacy`, `/terms-of-service` -> `/terms`
- [x] Privacy policy me AI/sub-processor disclosure, user rights (DPDP + GDPR), children, cookies, grievance officer sections add
- [x] Data deletion page pe confirmation-code se status check karne ka section
- [ ] Landing page `/` abhi AuthGate hai — logged-out user `/login` pe redirect hota hai (policy links wahan footer me hain). Reviewer ke liye ek proper public product page behtar rahega.

## Phase 3 — App Settings → Basic

- [x] App domains → `reel2realbooking.in` — **done**
- [ ] Privacy policy URL -> `https://reel2realbooking.in/privacy` — **Meta abhi reject kar raha (DNS cache), retry karte raho**
- [ ] Terms of Service URL -> `https://reel2realbooking.in/terms` — same
- [ ] User data deletion URL -> `https://reel2realbooking.in/data-deletion` — same (abhi bhi `https://www.facebook.com/` padi hai)
- [x] Category -> "Business and pages" — verified
- [x] App domains -> `reel2realbooking.in` — verified
- [x] App icon uploaded — verified
- [x] **Page Tab aur Instant Game platforms remove kar diye** — verified
- [ ] Site URL set karo (Website platform) — abhi khaali
- [ ] Contact email abhi `arpitgaurav.goldi723@gmail.com` — `support@reel2realbooking.in` pe badlo **jab wo mailbox bana lo** (pehle badla to Meta ke notices miss ho jaayenge)
- [ ] Business address / DPO contact fields khaali hain

### Facebook Login for Business -> Settings

- [x] **Valid OAuth Redirect URIs** = `https://reel2realbooking.in/auth/meta/callback` — **set + verified**
- [x] **Deauthorize callback URL** = `https://reel2realbooking.in/auth/facebook/deauthorize` — **set + verified**
- [ ] Data deletion **callback** URL bhi set kar sakte ho (`POST auth/facebook/data-deletion`) — instructions URL ki jagah ya uske saath.

---

## Architecture note (11 Sep 2026) — apex ab Vercel pe hai

`reel2realbooking.in` ab **frontend (Vercel)** serve karta hai. Backend (NestJS, port 5002) alag hai. Dono ko ek hi domain pe rakhne ke liye webapp ke `next.config.ts` me rewrites add kiye gaye hain:

| Path | Proxy destination |
|---|---|
| `/auth/meta/*` | `${BACKEND_ORIGIN}/auth/meta/*` |
| `/auth/facebook/*` | `${BACKEND_ORIGIN}/auth/facebook/*` |
| `/webhook/*` | `${BACKEND_ORIGIN}/webhook/*` |
| `/api/*` | `${BACKEND_ORIGIN}/api/*` |

**Ab ye karna baaki hai:**

- [ ] Backend ko ek stable public HTTPS URL pe le jao (ngrok static domain, ya Railway/Render/Fly, ya `api.reel2realbooking.in`)
- [ ] Vercel project `reel2real` me env var **`BACKEND_ORIGIN`** = wahi URL set karo, phir redeploy
- [ ] Backend `.env` me `PUBLIC_BASE_URL="https://reel2realbooking.in"` already sahi hai — rewrites ke saath ye Meta ke callbacks ke liye match karta hai
- [ ] `NEXT_PUBLIC_API_URL` bhi `https://reel2realbooking.in` hi rahega (rewrites `/api/*` handle kar lenge)
- [ ] Meta webhook callback URL ngrok se `https://reel2realbooking.in/webhook` pe shift karo (Phase 4 ka pending item isse solve ho jaata hai)


---

## Phase 4 — Webhooks

- [x] Page object — callback + verify token set, Meta ne verify kiya (200)
- [x] Instagram object — same
- [x] WhatsApp Business Account object — same
- [x] Live test pass — Meta ne asli `comments` payload POST kiya, backend ne 200 diya

**Abhi subscribed fields:**

| Object | Fields |
|---|---|
| Page | `feed`, `messages`, `messaging_postbacks`, `messaging_referrals` |
| Instagram | `comments`, `messages`, `messaging_postbacks`, `messaging_referral` |
| WhatsApp | `messages`, `account_update`, `account_alerts`, `business_capability_update`, `message_template_status_update`, `message_template_quality_update`, `phone_number_quality_update` |

- [ ] **Stable callback URL pe shift karo.** Abhi `https://1740-122-176-213-75.ngrok-free.app/webhook` hai — ngrok restart hote hi ye mar jaayega aur teeno objects me dobara daalna padega. Do options:
  - ngrok free account ka **1 free static domain** claim karo, ya
  - `api.reel2realbooking.in` → aapka static IP (GoDaddy me A record), port 443 forward, valid TLS cert
- [ ] Publish ke baad ye blocked fields dobara try karo — Advanced Access milte hi khul jaayenge:
  - `template_category_update` (WhatsApp) — template category badalne pe pricing badalti hai, wallet billing ke liye zaroori
  - `messaging_optins` (Page)
  - `live_comments`, `mentions` (Instagram)

> **Pattern yaad rakhna:** WhatsApp ke 4 fields pehle block the; WABA banate hi turant enable ho gaye. Gated fields tabhi khulte hain jab underlying asset ya permission mil jaaye.

---

## Phase 5 — Permissions & Advanced Access

Abhi **sab kuch "Ready for testing" (Standard Access)** pe hai. Ye sirf aapke apne assets pe kaam karta hai. Client ke Pages/WABA pe chalane ke liye **Advanced Access** chahiye — jo App Review se aata hai.

- [x] **Business verification — pehle se complete** (Advanced Access ka sabse bada blocker already hat chuka hai)
- [ ] Har permission ke liye Advanced Access request karo, saath me **specific justification**. Generic mat likhna — reviewer ko exact user flow batao:

| Permission | Justification me kya likhna hai |
|---|---|
| `whatsapp_business_messaging` | COD order confirmation ke interactive buttons bhejne, abandoned cart recovery, aur order tracking updates bhejne ke liye |
| `whatsapp_business_management` | Merchant ke WABA pe message templates create/submit karne aur unka approval status sync karne ke liye |
| `pages_manage_engagement` | Merchant ke Facebook Page posts pe aane wale customer comments ka reply karne ke liye |
| `pages_manage_metadata` | Merchant ke Page ko app ke webhook pe subscribe karne ke liye (iske bina comments/DMs aayenge hi nahi) |
| `pages_read_engagement` / `pages_read_user_content` | Customer comments padhne ke liye taaki AI relevant reply de sake |
| `pages_show_list` | Onboarding ke waqt merchant ko apne Pages me se choose karne dene ke liye |
| `pages_manage_posts` | Merchant ki taraf se product posts publish/manage karne ke liye |
| `instagram_basic` | Merchant ke connected IG business account ki basic details padhne ke liye |
| `instagram_manage_comments` | IG post/reel comments pe reply karne ke liye — product ka core feature |
| `instagram_manage_messages` | IG DM me product details aur checkout link bhejne ke liye |
| `business_management` | Multi-tenant — ek agency dashboard se multiple client business assets manage karne ke liye |
| `catalog_management` | Product catalog sync karke WhatsApp/IG pe product messages bhejne ke liye |
| `ads_management` / `ads_read` | Click-to-WhatsApp ad campaigns create karne aur unki performance track karne ke liye |

- [ ] **Screencast video record karo** (har permission ke liye zaroori). Video me ye dikhna chahiye:
  1. Merchant Facebook Login se app me aata hai
  2. Apna Page / IG account / WABA connect karta hai
  3. Ek real customer comment aata hai → app auto-reply karta hai
  4. Ek COD order aata hai → WhatsApp pe confirm/cancel buttons jaate hain
  5. Customer "Confirm" dabata hai → Shopify me order tag update hota hai
- [ ] Test credentials do — reviewer ko login karke khud verify karna hota hai
- [ ] `Marketing API Access Tier` abhi **"Limited access"** pe hai. CTWA ads scale pe chalane ke liye Advanced tier chahiye — alag se request karna padega.

---

## Phase 6 — WhatsApp Production Setup

- [x] WABA created — ID `1085258617761731`
- [x] Test number `+1 555 661-8499` — Phone Number ID `1259818730556396`
- [ ] **Apna business phone number add karo** (Step 2. Production setup). Test number sirf 5 recipients tak bhej sakta hai — real clients ke liye kaam nahi karega.
- [ ] Display name approve karwao
- [ ] **Permanent access token generate karo.** Dashboard wala token 24 ghante me expire ho jaata hai — production me System User token chahiye.
- [ ] Message templates banao aur approve karwao — Meta approval me 1–24 ghante lagte hain, isliye ye **pehle** kar lo:
  - COD order confirmation (buttons ke saath)
  - Abandoned cart — Stage 1 (15 min), Stage 2 (6 hrs, 5% off), Stage 3 (24 hrs, 10% off)
  - Order shipped / out for delivery / delivered
  - Review request (delivery ke 3 din baad)
- [ ] Payment method add karo — Meta conversation charges ke liye
- [ ] Messaging limit tier check karo (naya number 250 conversations/day se shuru hota hai)

---

## Phase 7 — Database & Multi-Tenant Wiring

- [ ] Prisma migration **apply** karo (`npx prisma migrate deploy`) — SQL `prisma/migrations/` me hai; live DB pe chalana baaki hai
- [x] WhatsApp / Shopify seed path: `prisma/seed.ts` + boot-time env sync. Default phone number id `1259818730556396`; tokens env se.
- [x] `default_org` / `default_brand` / `mock_token` send paths hata diye — bina mapped store/channel ke WhatsApp nahi jaata
- [ ] `/api/meta/health-audit` chala kar confirm karo ki sab channels healthy hain aur koi identifier collision nahi hai

---

## Phase 8 — Publish (Go Live)

Ye tabhi karo jab Phase 0–5 complete ho:

- [ ] App Settings → Basic me koi bhi "Currently ineligible for submission" warning na bache
- [ ] Advanced Access request App Review me submit karo
- [ ] Review ka wait karo (aam taur pe 3–7 working days)
- [ ] Approve hone ke baad **Publish** toggle on karo
- [ ] Publish ke turant baad: ek real message bhej kar confirm karo ki production webhooks aa rahe hain (unpublished mode me nahi aate the)
- [ ] Blocked webhook fields dobara enable karo (Phase 4 ka last point)

---

## Phase 9 — Publish ke baad Monitoring

- [x] `/health` endpoint banao uptime monitoring ke liye (`GET /health`, DB ping; 503 if DB down)
- [ ] Webhook failure alerting — Meta lagataar fail hone par subscription **automatically disable** kar deta hai
- [ ] `account_alerts` aur `account_update` events pe alerting lagao — WABA ban/restriction ka pata chalega
- [ ] `phone_number_quality_update` track karo — quality gir rahi ho to broadcast rok do
- [ ] Alert Inbox aur Required actions weekly check karo

---

## Quick Reference

| Cheez | Value |
|---|---|
| App ID | `1390089122590430` |
| Business portfolio ID | `293827523151274` |
| WABA ID | `1085258617761731` |
| WhatsApp Phone Number ID | `1259818730556396` |
| WhatsApp test number | `+1 555 661-8499` |
| Webhook verify token | `reel2real_verify_secret` |
| Callback URL (temporary) | `https://1740-122-176-213-75.ngrok-free.app/webhook` |
| Domain | `reel2realbooking.in` (expires 8 Sep 2027) |
| Backend port | `5002` |
| AI service | `http://127.0.0.1:8000` |

---

## Remaining ops blockers (code Wave 1–3 done)

1. **Legal pages live nahi hain** — App Review yahin reject ho jaayega (`privacy-policy`, `terms-of-service`, `data-deletion`, landing on HTTPS)
2. **Callback URL temporary hai** — ngrok restart pe sab tootega; `api.reel2realbooking.in` ya ngrok static domain
3. **App icon missing** — Meta dashboard pe 1024×1024 upload
4. **Production WABA number + System User token + approved templates** (COD + 3 cart stages)
5. **Apply Prisma migration + seed live secrets**, then confirm `/health` and a signed webhook round-trip
