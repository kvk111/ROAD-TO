# Road to 80: deployment guide

About 20 minutes, once. You need a Google account and a free GitHub account.

## What goes where

| File | Where it lives |
|---|---|
| `Code.gs` | Apps Script inside your `Road_To_80_Logs` Google Sheet (the private backend) |
| `index.html`, `manifest.webmanifest`, `sw.js`, `icons/` | A GitHub repository published with GitHub Pages (the app) |

The GitHub files contain no secrets. Your API token is typed into the app on each device and stays in that device's storage.

---

## Part 1: Backend (Google Apps Script)

1. Open your Google Sheet **Road_To_80_Logs** (create it if needed).
2. Click **Extensions → Apps Script**.
3. Replace everything in `Code.gs` with the new `Code.gs`. If an **Index** HTML file exists from the previous version, delete it.
4. Click the gear icon (**Project Settings**) and set **Time zone** to `(GMT+08:00) Singapore`.
5. Back in the editor, choose the function **setup** in the toolbar dropdown and click **Run**. Approve the permission prompt (Advanced → Go to project → Allow).
6. Open **Execution log**. Copy the long **API token** it prints. (It is also under Project Settings → Script properties → `API_TOKEN`.)
   - Existing rows are kept. A `Day_Type` column is added at the end; older rows count as "Shift".
7. Click **Deploy → New deployment**. Gear icon → **Web app**.
   - Description: `Road to 80 API`
   - Execute as: **Me**
   - Who has access: **Anyone**
8. Click **Deploy** and copy the **Web app URL** (ends in `/exec`).

"Anyone" is needed because the app runs on github.io, where your Google login cookie is not sent. Every request is refused without the token.

**After changing `Code.gs` later:** Deploy → Manage deployments → pencil icon → Version: **New version** → Deploy. The URL stays the same. (Creating a *new deployment* would give you a new URL.)

**If the token leaks:** run `rotateToken` once, then enter the new token on each device.

---

## Part 2: Frontend (GitHub Pages)

1. Sign in at github.com and click **New repository**.
   - Name: `road-to-80`
   - Visibility: **Public** (free GitHub Pages needs a public repo; the code has no secrets)
   - Create repository.
2. Click **uploading an existing file**. Drag in `index.html`, `manifest.webmanifest`, `sw.js` and the whole `icons` folder. Click **Commit changes**.
   Check the repo shows `icons/icon-192.png` and so on inside an `icons` folder.
3. Go to **Settings → Pages**. Under *Build and deployment*: Source **Deploy from a branch**, Branch **main**, folder **/ (root)** → **Save**.
4. Wait 1–2 minutes. The page shows your site address, e.g.
   `https://YOUR-USERNAME.github.io/road-to-80/`

---

## Part 3: Install on Android

1. Open the site address in **Chrome** on your phone.
2. **Choose a PIN** (4–6 digits), then enter it again.
3. When asked, tap **Use fingerprint to unlock** and touch the sensor.
4. Settings opens. Paste the **Web app URL** and **API token**, then tap **Save & test connection**. The status dot turns green.
5. Chrome menu **⋮ → Install app** (or **Add to Home screen → Install**). The app gets its own icon and opens full screen.

From then on: open the app → fingerprint → log your shift.

## Part 4: Laptop

1. Open the same site address in Chrome or Edge.
2. Set a PIN for this computer. If it has Windows Hello or Touch ID, you can turn that on too.
3. Enter the same URL and token.
4. Optional: the install icon in the address bar makes it a desktop app.

---

## How sync works

- **Saving a shift** sends it straight to the Sheet. Every device sees it on its next sync.
- **The app syncs** when it opens, when you return to it, every 60 seconds while it is open, and when you tap the refresh button.
- **Offline save**: the shift is kept on the phone marked "Waiting to sync" and uploads by itself when you are back online.
- **Drafts are per device.** Unsaved entries during a shift stay on the device you typed them on, so log a whole shift on one device. The Sheet only receives final, locked rows.
- **One row per shift.** A second save for the same shift date is refused by the server, even from another device.
- **Corrections** can only be made in the Sheet.

## Updating the app later

Upload the changed files to the repo. In `sw.js`, change `VERSION = 'r80-v1'` to `'r80-v2'` (and so on) with every update so phones drop the old cached copy. The update shows on the second launch after upload.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Wrong API token" | Re-copy the token from Script properties. No spaces. |
| "Could not reach the URL" | URL must end in `/exec`; deployment access must be **Anyone**. |
| Changes to `Code.gs` not taking effect | Manage deployments → edit → **New version**. |
| No "Install app" option | Open the github.io address in Chrome (not an in-app browser); wait for the page to finish loading once. |
| No fingerprint option | The phone needs a fingerprint or screen lock set up in Android settings. The PIN always works. |
| Forgot PIN | Tap **Forgot PIN? → Reset device**. It clears only this device; re-enter URL and token. The Sheet is not touched. |

## Security, briefly

- **Your data** is protected by the API token (checked by Apps Script on every request) and by your Google account, which owns the Sheet.
- **The fingerprint/PIN lock** protects the app on your device against someone picking up your unlocked phone. It runs in the browser, so it is not a server-side check.
