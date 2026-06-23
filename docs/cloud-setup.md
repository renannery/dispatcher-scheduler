# Cloud sync setup — GitHub Gist backend

The Save/Load cloud feature uses a single private GitHub Gist with one
JSON file per team. Setup takes ~3 minutes:

## 1. Create a private gist

1. Sign in to GitHub → https://gist.github.com
2. Create a new gist with **any** starter content (e.g. filename
   `placeholder.txt`, content `setup`) and choose **"Create secret gist"**
   (private — only visible to people with the URL).
3. After it's created, copy the gist id from the URL:
   `https://gist.github.com/<your-user>/<GIST_ID>` — the part after the
   slash is what you want.

The placeholder file gets overwritten by `dispatchers.json` /
`drivers.json` the first time you click Save in the app.

## 2. Create a personal access token

1. Open https://github.com/settings/tokens?type=beta (Fine-grained tokens).
2. Click **Generate new token**.
3. Settings:
   - Token name: `dispatcher-scheduler-cloud`
   - Expiration: pick something long (1 year) — you'll have to rotate when it expires
   - Resource owner: you
   - Repository access: **Public Repositories (read-only)** (the smallest checkbox — it doesn't matter what you pick here since you only need a Gists scope)
   - Account permissions → **Gists**: **Read and write**
4. Click **Generate token** and copy it. It starts with `github_pat_…`.

(If your account doesn't support fine-grained tokens, use a classic
token with just the `gist` scope.)

## 3. Set the env vars

Locally — copy `.env.example` to `.env.local` and fill in:

```
VITE_GIST_ID=<the gist id from step 1>
VITE_GIST_TOKEN=<the token from step 2>
```

In Vercel — Project Settings → Environment Variables, add both. Mark
them as exposed to the browser (they end up in the bundle).

Redeploy. The `☁ Save` button and `Saved: …` pill will appear at the
top of the schedule toolbar for admins.

## Security notes

- The token sits in the client bundle — anyone who loads the app can
  use it to read or overwrite the gist. The fine-grained PAT scoped
  to **just** Gists Read/Write limits the blast radius to "this one
  gist." Nothing else on your GitHub account is reachable.
- If the bundle ever gets shared publicly, **revoke the token** and
  generate a new one. You don't lose any data (the gist stays); only
  the credentials need to rotate.
- For real access control (multi-tenant / public app), don't use this
  setup — move the data behind an authenticated API.
- Last-write-wins on save. Two admins clicking Save at the same time
  → the last one wins. Fine for one schedule manager.
