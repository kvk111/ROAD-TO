# Road to 80 v3: upgrade & deployment guide

v3 replaces the one-row-per-shift model with calendar days (00:00:00–23:59:59, Asia/Singapore) and timestamped entries. You log each item when it happens; the day totals and the cumulative deficit update themselves.

## 1. Google Sheet schema

You don't create anything by hand; `setup` builds it. For reference:

### `Entries` tab (new, append-only; the source of truth)

| Column | Meaning |
|---|---|
| Entry_ID | Unique id from the app (a retried upload is never stored twice) |
| Logged_At | Exact moment, ISO/UTC |
| Date | Calendar date in Singapore time, `YYYY-MM-DD` |
| Time | `HH:mm:ss`, Singapore time |
| Type | `food`, `steps`, `workout`, `weight`, `bp`, `water`, `tag`, `note` |
| Item | Food or workout name, or day tag (Normal / Rest / Sick) |
| Qty | Food quantity multiplier (0.25–20) |
| Kcal_Each | Food kcal per unit |
| Kcal | Food: Qty × Kcal_Each. Workout: kcal burned |
| Value | Steps added, weight kg, systolic, water litres, or workout minutes |
| Value2 | Diastolic |
| Note | Free text |
| Source | `app`, or empty for migrated rows |

### `Daily` tab (new, derived; never edit)

One row per date: Date, Weight_kg (latest entry that day), Weight_Used_kg (carried forward if none logged), Food_kcal, Steps, Step_kcal, Workout_kcal, BMR_kcal, Burned_kcal, Deficit_kcal, Counted (Y if food was logged), Cumulative_Deficit_kcal, Water_L, Systolic, Diastolic, Day_Tag, Entries, Updated_At.

It is rebuilt after every upload, and whenever you edit `Entries` by hand.

### `Logs` tab (v2): left as it is

Run `migrateLegacyLogs` once to copy it into `Entries` (see step 2.4).

## 2. Backend upgrade (Apps Script)

1. Before upgrading, open the v2 app on each device and make sure nothing says "Waiting to sync".
2. Open the Sheet → **Extensions → Apps Script**. Replace all of `Code.gs` with the v3 file.
3. Choose **setup** in the function dropdown → **Run**. Your existing `API_TOKEN` is kept.
4. Optional: choose **migrateLegacyLogs** → **Run**. Each old shift becomes entries at 12:00:00 on its shift date. Food arrives as one "Legacy shift total" item; the workout burn is reconstructed from the old Calories_Out. It is safe to run twice.
5. **Deploy → Manage deployments → pencil icon → Version: New version → Deploy.** The /exec URL stays the same, so devices keep working.

Profile constants (height, age, gender, start, goal) can be changed in the app under **Settings → Profile**. They are stored in Script properties as `PROFILE`, so every device uses the same numbers. The fallback defaults live in `CONFIG.PROFILE_DEFAULT` at the top of `Code.gs`. Changing the profile recalculates every past day.

## 3. Frontend upgrade (GitHub Pages)

1. In your `road-to-80` repository, upload and overwrite `index.html`, `sw.js` and `manifest.webmanifest` (icons are unchanged).
2. Open the app, then close and reopen it once. The service worker version is now `r80-v3`, so the new version loads.
3. Your PIN, fingerprint and connection carry over.

## 4. How the numbers work

- **Burned** = BMR + step burn + logged workouts
  - BMR (Mifflin-St Jeor) = 10 × kg + 6.25 × cm − 5 × age + 5 (male) or − 161 (female)
  - Step burn = steps × kg × 0.0004 → 10,000 steps ≈ 440 kcal at 110 kg, ≈ 320 kcal at 80 kg
  - kg = that day's latest weight, or the last logged weight before it, or the start weight
- **Daily deficit** = burned − eaten
- **Cumulative deficit** = sum of daily deficits over days with food logged. Days with no food logged are skipped, so an unlogged day can't count as a full-BMR deficit. Surplus days subtract.
- **Target** = (start − goal) × 7,700 = 231,000 kcal. Projected fat lost = cumulative ÷ 7,700.
- **Today** counts as soon as food is logged, with the full day's BMR, so it reads high until the evening; the card says so.
- **Days to 80 kg** = (current − goal) × 7,700 ÷ average deficit of the last 7 *completed* days with food.

## 5. Logging behaviour

- **Timestamps:** every tap is one entry stamped with the time you logged it (Singapore time), even if your phone is set to another time zone.
- **Undo window:** new entries wait 5 seconds before sending. Tap **Undo** in the toast or timeline to drop one. After that the entry is permanent in the app; correct it in the `Entries` tab.
- **Offline:** entries stay queued on the device with their original time and upload when you're back online (up to 7 days old).
- **Weight:** log any time; the latest entry of the day is that day's weight.
- **Steps:** **+ Add** logs extra steps. **Set day total** logs the difference to reach the total your phone shows.
- **Cheat meal:** it needs a second tap within 3 seconds, so it can't be logged by accident.
- **Past days:** use ‹ › on the timeline card, or tap a row in Daily history. They are read-only.

## 6. Correcting a mistake

Open the `Entries` tab, then edit or delete the row. `Daily` refreshes automatically (the sheet's `onEdit` trigger). If it ever looks stale, run `rebuildDailyNow`. The app shows the change on its next sync.
