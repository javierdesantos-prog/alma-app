# ALMA app

The ALMA phone app, served as a static site (Cloudflare Pages) and saving to Supabase.

- `index.html` — the whole app (one page)
- `alma-db.js` — sign-in by emailed code, saving feelings and journal entries, loading your own history
- `supabase.js` — the Supabase client library (kept here so the app does not depend on an outside CDN)
- `voices/`, icons, `manifest.webmanifest` — sounds and home-screen app files

Example data for presentations: Your ALMA (top right) → Your account → Example data.
