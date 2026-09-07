# External Setup Checklist

Use this checklist for the provider actions that cannot be completed from the repository. All links go directly to official provider consoles or documentation.

Do not paste credentials into this file, chat messages, issues, or commits. Add them directly to the staging/production host's encrypted secret store.

## 1. Choose and fund the first live path

Recommended first acceptance path:

- YouTube discovery and publishing.
- Anthropic script rewrite and QA.
- Gemini or Replicate video generation. (NVIDIA NIM is supported via `--video-vendor nvidia`, but it needs a self-hosted NIM container — NVIDIA hosts no Wan2.2 video endpoint — so it is not a quick first-run path. See the NVIDIA section below.)
- ElevenLabs narration, or no narration for the first run.
- OpenAI Whisper only when a source lacks captions.

### Anthropic

- [Create an Anthropic API key](https://platform.claude.com/settings/keys)
- [Configure Anthropic billing](https://platform.claude.com/settings/billing)

Required secret: `ANTHROPIC_API_KEY`

### Gemini

- [Create a Gemini API key in Google AI Studio](https://aistudio.google.com/apikey)
- [Open the Gemini API in Google Cloud](https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com)

Required secret: `GEMINI_API_KEY`

### Replicate

- [Create a Replicate API token](https://replicate.com/account/api-tokens)

Required secrets:

- `REPLICATE_API_TOKEN`
- `REPLICATE_MODEL`

### NVIDIA

- [Create an NVIDIA API key at build.nvidia.com](https://build.nvidia.com/)

The key is a Bearer token that starts `nvapi-`. Use it server-side only; never expose it to a browser or commit it.

**A self-hosted NIM is required.** Verified live 2026-09-06: NVIDIA does not serve Wan2.2 video generation on any hosted API (`integrate.api.nvidia.com`, `ai.api.nvidia.com`, NVCF) — the `nvapi-` key authenticates but there is no hosted `/videos/generations` to call. Wan2.2 Visual GenAI is distributed as a NIM container (`docs.nvidia.com/nim/visual-genai/`). Run it (NGC pull + `docker run`, port 8000), then set `NVIDIA_VIDEO_BASE_URL` to its base URL, e.g. `http://localhost:8000/v1`.

`--video-vendor nvidia` selects this provider (NVIDIA NIM Visual GenAI, Wan2.2 text-to-video / image-to-video); it is opt-in and not in any default fallback chain. Without a reachable NIM, a live run fails fast with a 404 and a hint pointing here.

Required secret: `NVIDIA_API_KEY`

Optional overrides:

- `NVIDIA_VIDEO_BASE_URL`
- `NVIDIA_VIDEO_MODEL`
- `NVIDIA_VIDEO_VARIANT`
- `NVIDIA_VIDEO_TIMEOUT_MS`

### ElevenLabs

- [Create an ElevenLabs API key](https://elevenlabs.io/app/developers/api-keys)

Required secrets:

- `ELEVENLABS_API_KEY`
- Optional `ELEVENLABS_VOICE_ID`

### OpenAI ASR fallback

- [Create an OpenAI API key](https://platform.openai.com/api-keys)

Required secret: `OPENAI_API_KEY`

## 2. YouTube and Google Cloud

Complete these in order:

1. [Open Google Cloud Console](https://console.cloud.google.com/)
2. Create or select the project owned by your company.
3. [Configure billing](https://console.cloud.google.com/billing)
4. [Enable YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com)
5. [Configure Google Auth branding and consent](https://console.cloud.google.com/auth/overview)
6. [Create OAuth credentials](https://console.cloud.google.com/apis/credentials)
7. Create a Web application OAuth client.
8. Add the staging callback URL.
9. Add the production callback URL after the production domain is fixed.

Required external values:

- Google OAuth client ID.
- Google OAuth client secret.
- Staging callback origin.
- Production callback origin.

Required discovery secret:

- `YOUTUBE_API_KEY`

OAuth implementation secrets to add:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`

Do not create a service account for YouTube channel uploads. Uploading to a user's channel requires user OAuth authorization.

## 3. TikTok

### Account and application

- [Create a TikTok developer account](https://developers.tiktok.com/signup/)
- [Log in to the TikTok developer portal](https://developers.tiktok.com/login/)
- [TikTok developer onboarding documentation](https://developers.tiktok.com/doc/overview/)

### Publishing

- [Content Posting API product page](https://developers.tiktok.com/products/content-posting-api)
- [Content Posting API setup](https://developers.tiktok.com/doc/content-posting-api-get-started/)
- [Direct Post requirements](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post)

TikTok states that unaudited Direct Post clients are restricted to private visibility. The application must pass TikTok's audit before public posting is enabled.

Required products/scopes:

- Login Kit or OAuth authorization.
- Content Posting API.
- `video.publish` for direct posting.
- Optionally `video.upload` for draft upload.

### Discovery warning

- [TikTok Research API eligibility and application](https://developers.tiktok.com/products/research-api/)

The Research API is restricted to qualifying research organizations and is not a general commercial trend-discovery API. Do not base the commercial launch promise on receiving Research API access. Keep YouTube as the dependable live discovery source and treat TikTok discovery as conditional until TikTok explicitly approves the use case.

Required values after application approval:

- Client key.
- Client secret.
- Approved redirect URI.
- Approved publishing scopes.
- Verified production domain or URL prefix if using pull-from-URL publishing.

## 4. Meta, Instagram, and Facebook

1. [Open Meta for Developers Apps](https://developers.facebook.com/apps/)
2. Create a Business-type application owned by the company.
3. Connect or create a Meta Business portfolio.
4. Connect a test Facebook Page.
5. Connect an Instagram Business or Creator account to that Page.
6. Add the relevant Instagram and Facebook products.
7. Configure valid OAuth redirect URIs.
8. Add test users and test assets.
9. Complete App Review for the permissions actually used.

Prepare these public URLs before App Review:

- Privacy policy.
- Terms of service.
- User data deletion instructions.
- OAuth callback.
- Product homepage.

Required values after setup:

- Meta App ID.
- Meta App Secret.
- Approved redirect URI.
- Test Page ID.
- Test Instagram Business/Creator account ID.
- Approved permissions and scopes.

Likely implementation secrets:

- `META_APP_ID`
- `META_APP_SECRET`
- `META_OAUTH_REDIRECT_URI`

Never rely on one global Page token for a multi-client product. Each client's destination must be selected and stored through its own encrypted connection.

## 5. Stripe

- [Open Stripe API keys](https://dashboard.stripe.com/test/apikeys)
- [Create test products and prices](https://dashboard.stripe.com/test/products)
- [Create webhook endpoints](https://dashboard.stripe.com/test/webhooks)

First configure test mode. Create three recurring monthly Prices matching the final approved product tiers.

Required secrets:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID_STARTER`
- `STRIPE_PRICE_ID_GROWTH`
- `STRIPE_PRICE_ID_AGENCY`

Do not switch to live Stripe mode until real pipeline unit economics have been measured.

## 6. Hosting, database, and production domain

- [Open Fly.io dashboard](https://fly.io/dashboard)
- [Fly.io Postgres documentation](https://fly.io/docs/postgres/)

Required decisions:

- Staging application hostname.
- Production application hostname.
- PostgreSQL provider.
- Backup retention period.
- Point-in-time recovery requirement.
- Monitoring and alert destination.

Required production configuration:

- `DATABASE_URL`
- `PUBLIC_BASE_URL`
- `SOCIAL_TOKEN_ENCRYPTION_KEY`
- `ASSET_SIGNING_SECRET`
- `DASHBOARD_USERNAME`
- `DASHBOARD_PASSWORD`

The application now refuses production startup when this core set is incomplete.

## 7. Secure secret generation

Generate two separate random values:

- Social-token encryption key.
- Asset URL signing key.

Each should contain at least 32 random bytes. Store the values only in the deployment platform's secret manager.

Never reuse:

- A staging key in production.
- The social-token encryption key as the asset-signing key.
- Provider credentials between staging and production when the provider supports separate applications.

## 8. Information engineering needs from you

Provide these as non-secret values:

- Selected first video vendor.
- Whether the first run uses narration.
- Staging public base URL.
- Production public base URL.
- OAuth callback paths approved for Google, TikTok, and Meta.
- Final price and monthly run limit for each tier.
- Maximum acceptable cost per completed video.
- Maximum acceptable completion time.

Add secrets directly to the deployment host. Do not send secret values in chat.
