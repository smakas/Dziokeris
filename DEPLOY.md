# Deploy Džiokeris to the cloud — step by step

Everything here is **free** and needs **no credit card**. Run every command
inside the project folder:

```
C:\Simas\OneDrive\Docs\Claude\Projects\Džiokeris
```

Do the parts in order. Part A puts the code on GitHub; Part B puts the live
game + database on Cloudflare.

---

## Part A — GitHub (source code + version history)

1. **Create a free GitHub account** at <https://github.com> (skip if you have one).

2. **Get a private commit email** (so your real email isn't published):
   GitHub → *Settings → Emails* → tick **"Keep my email addresses private"**.
   Copy the address it shows — it looks like
   `12345678+yourname@users.noreply.github.com`.

3. **Set your identity and make the first commit.** Replace the two values, then
   run each line:

   ```bash
   git config user.name "Simas"
   git config user.email "12345678+yourname@users.noreply.github.com"
   git add .
   git commit -m "Džiokeris v2: engine, browser app, cloud API"
   ```

4. **Create the repository on GitHub:** click **New repository**, name it
   `dziokeris`, choose **Public**, and do **not** add a README or .gitignore
   (we already have them). Click *Create repository*.

5. **Push your code** (replace `YOURNAME`):

   ```bash
   git remote add origin https://github.com/YOURNAME/dziokeris.git
   git branch -M main
   git push -u origin main
   ```

Your code is now on GitHub.

---

## Part B — Cloudflare (live game + database)

1. **Create a free Cloudflare account** at <https://dash.cloudflare.com/sign-up>
   (no credit card needed).

2. **Log Wrangler in to your account** (opens a browser window to approve):

   ```bash
   npx wrangler login
   ```

3. **Create the database:**

   ```bash
   npx wrangler d1 create dziokeris
   ```

   It prints a `database_id`. Open **wrangler.toml**, find the line
   `database_id = "REPLACE_AFTER_d1_create"`, and paste your real id in place of
   `REPLACE_AFTER_d1_create`. Save the file. (Then commit + push it:
   `git add wrangler.toml && git commit -m "Add D1 id" && git push`.)

4. **Create the tables** in the real database:

   ```bash
   npx wrangler d1 execute dziokeris --remote --file worker/schema.sql
   ```

5. **Create the Pages site connected to GitHub:**
   Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**
   → pick your `dziokeris` repo. Build settings:
   - Framework preset: **None**
   - Build command: **(leave empty)**
   - Build output directory: **/** (a single slash)

   Click **Save and Deploy**.

6. **Bind the database to the site:**
   Pages project → **Settings → Functions → D1 database bindings → Add binding**
   - Variable name: **DB**
   - D1 database: **dziokeris**

   Save, then go to **Deployments → Retry deployment** so the binding takes effect.

7. **Open your live URL** (looks like `https://dziokeris.pages.dev`). Play a game
   to the end — the result is saved, and the 📊 button shows the leaderboard.

---

## Updating later

Any time you change the code, just:

```bash
git add .
git commit -m "what changed"
git push
```

Cloudflare Pages redeploys automatically within a minute. That's the whole loop.
