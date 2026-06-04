# Deploy: run 24/7 with nothing open on your machine

Three free accounts. Do them in order. None need a credit card.
(Supabase = the database, GitHub = the every-30-min fetcher, Vercel = the live website.)

---
## 1) Supabase — the database
1. Go to **supabase.com**, sign up, click **New project**. Pick a name + a database
   password (save it), choose a region near the US, create it. Wait ~2 minutes.
2. Left menu -> **SQL Editor** -> **New query**. Paste everything from
   `cloud/schema.sql`, click **Run**. (Creates the table + a read-only public policy.)
3. Left menu -> **Project Settings** -> **API**. Copy these three values:
   - **Project URL**            (looks like https://abcd1234.supabase.co)
   - **anon public** key        (safe to expose - used by the dashboard)
   - **service_role** key       (SECRET - used only by GitHub, never in the browser)

---
## 2) GitHub — the every-30-minute fetcher
1. Create a new GitHub repo and upload the project (the `app/` folder,
   `requirements.txt`, and `.github/workflows/sync.yml`).
2. Repo -> **Settings** -> **Secrets and variables** -> **Actions** -> **New repository
   secret**. Add two:
   - `SUPABASE_URL` = your Project URL
   - `SUPABASE_SERVICE_KEY` = your service_role key
3. Repo -> **Actions** tab. If prompted, enable workflows. Click **news-sync** ->
   **Run workflow** to test it now. When it goes green, open Supabase -> **Table
   Editor** -> `articles` and you should see rows.
4. Done - it now runs every 30 minutes automatically, forever, with your PC off.

---
## 3) Vercel — the live dashboard + ad generation
1. In `cloud/config.js`, fill in:
   - `window.SB_URL` = your Project URL
   - `window.SB_KEY` = your **anon public** key   (NOT the service_role key)
   Commit this (it can be the same repo, in the `cloud/` folder, or its own repo).
2. Go to **vercel.com**, sign up, **Add New... -> Project**, import the repo.
   - **Root Directory**: set it to `cloud` (so Vercel deploys that folder).
   - **Framework Preset**: **Other** (no framework).
3. Add an **Environment Variable**: `GROQ_API_KEY` = your Groq key (from console.groq.com).
4. Click **Deploy**. Open the Vercel URL - that's your live site. It shows the news
   (updated every 30 min by GitHub), and the **Generate ad copy** button works via the
   serverless function.

---
## Notes
- The 30-min job keeps the Supabase project active, so the free 7-day inactivity
  pause never triggers.
- The anon key in `config.js` is meant to be public; the read-only policy from
  step 1.2 is what keeps the data safe. The service_role and Groq keys stay secret
  (only in GitHub/Vercel settings, never in the browser).
- GitHub Actions can be delayed a few minutes under load - normal for free cron.
