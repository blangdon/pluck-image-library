# Pluck Image Library

A searchable, AI-tagged gallery of every image in the Pluck Google Drive.

- **Tagger** (`tagger/`, runs hourly on GitHub Actions): walks the Drive folders, makes a thumbnail of each new or changed image, asks Claude what's in it (shaker, sachet, food, people, flavour, old/new packaging, render vs photo…) and saves the result to Supabase.
- **Gallery** (`web/`, hosted on Vercel): team members sign in with Google, filter by tag, flavour and type, search, see what's new since their last visit, and fix wrong tags. Fixes are saved for everyone and never overwritten by re-tagging.

Nothing is ever written to Drive. The tagger has read-only access.

---

## Setup

### 1. Google Cloud: read access to Drive
1. console.cloud.google.com → create a project.
2. Enable **Google Drive API**.
3. **Service Accounts** → create one → **Keys** → **Add key** → **JSON**. Keep the downloaded file safe.
4. In Google Drive, share the Pluck folder(s) with the service account's email as **Viewer**. For a Shared Drive, add the email as a member.
5. Note each folder's ID: open the folder in Drive. The ID is the last part of the address, after `/folders/`.

### 2. Anthropic: the tagging model
1. console.anthropic.com → sign up → **Billing**: add some credit and set a monthly spend limit.
2. **API keys** → **Create key**. Copy it straight into GitHub in step 4.

### 3. Supabase: database, sign-in and thumbnails
1. supabase.com → **New project** (choose the Sydney region). Save the database password somewhere.
2. **SQL Editor** → **New query** → paste all of `supabase/schema.sql` → **Run**.
3. Add who may use the gallery (SQL Editor):
   ```sql
   insert into allowed_emails (email) values ('someone@gmail.com'), ('another@gmail.com');
   -- or everyone with a company address:
   insert into allowed_domains (domain) values ('yourcompany.com');
   ```
4. **Google sign-in.** In Google Cloud (same project as step 1):
   - **Google Auth Platform** (or "OAuth consent screen") → fill in app name "Pluck Library" and a support email. Audience: **External**, then **Publish app**. Only basic profile access is requested, so Google doesn't need to review it.
   - **Clients** → **Create client** → **Web application**. Under **Authorized redirect URIs** add `https://<your-project>.supabase.co/auth/v1/callback`. Copy the client ID and secret.
   - Back in Supabase: **Authentication** → **Sign In / Providers** → **Google** → enable, paste the client ID and secret, save.
5. **Project Settings** → **API**: note the **Project URL**, the **anon public** key and the **service_role** key. The service_role key is a secret.

### 4. GitHub: code and the hourly tagger
1. Put this code in a private repository.
2. **Settings** → **Secrets and variables** → **Actions** → **New repository secret**, one for each:

   | Secret | Value |
   |---|---|
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | the entire contents of the JSON key file from step 1 |
   | `DRIVE_FOLDER_IDS` | folder ID(s) from step 1, comma-separated |
   | `SUPABASE_URL` | Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role key |
   | `ANTHROPIC_API_KEY` | key from step 2 |

   Optional **Variables** (same page, Variables tab): `TAG_MODEL` (default `claude-sonnet-5-5`; `claude-haiku-5-5` is cheaper) and `MAX_IMAGES_PER_RUN` (default 400).
3. **Actions** → **Tag new Drive images** → **Run workflow** with mode **count**. This is free: it checks access and reports how many images there are.
4. Optional: run it with mode **compare** (needs only the Anthropic key, costs under US$1). It tags 50 random images with both Sonnet and Haiku and shows where they disagree, so you can choose a model. Set `TAG_MODEL` to `claude-haiku-5-5` if Haiku is good enough.
5. Run it again with mode **tag**. After that it runs by itself every hour. The first backlog is worked through 400 images per run.

### 5. Vercel: the gallery website
1. vercel.com → sign in with GitHub → **Add New** → **Project** → import the repository.
2. Under **Environment Variables** add `SUPABASE_URL` and `SUPABASE_ANON_KEY` (the anon public key). Deploy.
3. Copy the site address (e.g. `https://pluck-image-library.vercel.app`). In Supabase → **Authentication** → **URL Configuration**, set it as **Site URL** and add it under **Redirect URLs**.

---

## Day to day

- **New images** are picked up within the hour. Each person sees a "new since your last visit" strip; a visit ends after 30 minutes away.
- **Wrong tag?** Open the image, click × on the tag, or add the right one. Changes are saved for everyone.
- **Add a teammate:** add their email in step 3.3.
- **Change the tag list:** edit `tagger/config.yaml`. New images use the new list. To re-tag everything, run the workflow with **Re-tag every image** ticked. This costs the same as the first full run.
- **Better shaker recognition:** add clear photos to `tagger/reference/` and list them under `reference_images` in `config.yaml`.
- **Failures** are retried up to 3 times. The reason is saved in the `tag_error` column. Formats Pillow can't read (RAW, PSD) fall back to Drive's own preview.

## Local preview

Open `web/index.html` through any static server, without `config.js`, and it runs in demo mode if `web/demo-data.js` exists.
