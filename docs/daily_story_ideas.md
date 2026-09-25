# Daily Instagram story ideas

Every morning each merchant who turned the feature on gets four story ideas on
WhatsApp, picks one, and it is published to their Instagram stories with the
best keywords and hashtags lettered on it.

## Flow

1. **09:00 IST**: `.github/workflows/daily-stories.yml` calls
   `POST /api/stories/cron/daily` (Bearer `STORY_CRON_SECRET`). The API answers
   202 and works in the background, one org at a time.
2. For each org with `StorySettings.enabled`, Gemini writes four ideas from the
   org name, brand persona, business description, products and recent stories,
   then draws a 9:16 image for each (stored as JPEG in `StoryOption.imageData`).
   One batch per org per day (`StoryBatch`, unique on `orgId` + `forDate`).
3. The Reel2Real WhatsApp number sends the approved template below to the
   merchant's own number. Business-initiated messages must be templates.
4. Tapping **Show ideas** opens the 24-hour window. The API sends the four images
   and a list message (reply buttons stop at three, lists allow ten). Replying
   with a bare `1` to `4` also works.
5. On a pick, Semrush (`phrase_related`, search volume and difficulty) and Apify
   (hashtags that co-occur on recent Instagram posts for the topic) are queried
   in parallel. Gemini letters the headline and hashtags onto the image; if that
   fails, an SVG overlay is used instead.
6. The final JPEG is published with the Graph API (`media_type=STORIES`, then
   `media_publish`) using the org's Instagram channel token, and the merchant
   gets a confirmation with the keywords used. If publishing fails the batch is
   `FAILED` and sending the number again retries.

Images are served to WhatsApp and Instagram from
`/api/stories/media/:optionId/:variant/:signature.jpg`, signed with
`STORY_MEDIA_SECRET` (falls back to `ENCRYPTION_SECRET`).

## WhatsApp template to submit

Create it in WhatsApp Manager on the Reel2Real number.

- Name: `daily_story_ideas`
- Category: Utility
- Language: English (`en`)
- Body: `Hi {{1}}, your 4 Instagram story ideas for today are ready. Tap below to see them and pick the one to post.`
  (`{{1}}` is the business name)
- Button: Quick reply, text `Show ideas`

Override the name or language with `STORY_WA_TEMPLATE` / `STORY_WA_TEMPLATE_LANG`.

## Configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | Render | Ideas and images (Google AI Studio) |
| `GEMINI_TEXT_MODEL`, `GEMINI_IMAGE_MODEL` | Render, optional | Defaults `gemini-2.5-flash`, `gemini-2.5-flash-image` |
| `SEMRUSH_API_KEY` | Render | Keyword volume (needs API units) |
| `APIFY_TOKEN` | Render | Instagram hashtag research |
| `APIFY_HASHTAG_ACTOR` | Render, optional | Default `apify~instagram-hashtag-scraper` |
| `STORY_CRON_SECRET` | Render and GitHub secret | Protects the daily trigger |
| `STORY_API_URL` | GitHub secret, optional | Default `https://reel2real-api.onrender.com` |
| `STORY_WA_PHONE_NUMBER_ID`, `STORY_WA_ACCESS_TOKEN` | Render, optional | Sender number; default `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_ACCESS_TOKEN` |
| `STORY_MEDIA_BASE_URL` | Render, optional | Public origin for image links; default `PUBLIC_BASE_URL` |

Semrush or Apify can be left unset; the other source (or the idea's own seed
keyword) fills in.

## Meta requirements

- The Instagram channel must be a Business or Creator account connected through
  a Facebook Page, with `instagram_content_publish` granted. Other merchants
  need App Review for Advanced Access.
- Instagram only accepts JPEG for stories, and the API cannot add stickers,
  captions or links to a story, so the keywords are part of the image.
- Instagram allows 50 API-published posts per account per 24 hours.

## API

- `GET /api/stories/settings`, `PUT /api/stories/settings` (owner or admin):
  `enabled`, `whatsappNumber`, `instagramChannelId`, `businessDescription`,
  `keywordDatabase`.
- `GET /api/stories/batches`: the last seven days with option previews.
- `POST /api/stories/run-now` (owner or admin): regenerates today's batch now.
