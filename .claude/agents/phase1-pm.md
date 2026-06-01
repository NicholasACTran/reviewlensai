---
name: phase1-pm
description: "Playwright PM agent for Phase 1 scraper E2E validation. Drives the Amplify staging app through the full scrape flow — nominal, invalid-URL, and forced-failure — while tailing Scraper Lambda CloudWatch logs and polling the Job AppSync row in parallel so FE-render latency vs backend latency is always separable."
---

# Phase 1 PM Agent — Scraper E2E Validation

## Purpose

Validate the deployed Phase 1 scraper stack end-to-end against staging. This agent exercises three paths:
1. **Nominal path** — valid Steam URL → animated waiting screen → nominal screen with game name, review count, and % positive.
2. **Invalid-URL path** — non-Steam URL → inline form error (no navigation).
3. **Forced-failure path** — a Steam URL for a game that should trigger a scrape failure (or a synthetically throttled state) → Try-Again screen showing `errorMessage`.

Critically: the browser run is **always paired with live backend observation** — Scraper Lambda CloudWatch logs tailed + `Job` row polled via AppSync/AWS CLI — so if the browser hangs on a spinner, the cause is immediately diagnosable (FE subscription lag vs backend genuinely stalled).

---

## Prerequisites

Before running:
- The App domain is deployed to staging (Amplify hosting URL in SSM `/reviewlensai/amplify/url`).
- The Scraper domain is deployed (Validator Function URL written to `VITE_VALIDATOR_URL` on the Amplify branch; SSM `/reviewlensai/scraper/validatorUrl` exists).
- AWS credentials are active for the staging account (for CloudWatch + AppSync/DynamoDB polling).
- The `screenshots/` directory exists at repo root (it is gitignored; create with `mkdir -p screenshots` if needed).

---

## Step 0 — Resolve staging inputs

```bash
# Resolve the Amplify staging URL
BASE_URL=$(aws ssm get-parameter --name /reviewlensai/amplify/url --query Parameter.Value --output text)

# Resolve the Validator Function URL (for direct curl verification, not needed for the browser)
VALIDATOR_URL=$(aws ssm get-parameter --name /reviewlensai/scraper/validatorUrl --query Parameter.Value --output text)

# Resolve AppSync endpoint + API key (for Job row polling)
APPSYNC_URL=$(aws ssm get-parameter --name /reviewlensai/appsync/url --query Parameter.Value --output text)
APPSYNC_KEY=$(aws ssm get-parameter --name /reviewlensai/appsync/apiKey --query Parameter.Value --output text)

echo "Staging base: $BASE_URL"
echo "Validator URL: $VALIDATOR_URL"
```

---

## Step 1 — Parallel backend observation setup

**Start these before navigating the browser.** The goal is to capture the full lifecycle from the moment the user submits the URL.

### 1a — Tail Scraper Lambda CloudWatch logs

Find the Scraper Lambda log group (CDK names it `/aws/lambda/ReviewLensScraperStack-ScraperFn*`):

```bash
LOG_GROUP=$(aws logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda/ReviewLensScraperStack-ScraperFn" \
  --query 'logGroups[0].logGroupName' --output text)

# Tail in background — surfaces worker_start, worker_s3_written, worker_complete, worker_failed events
aws logs tail "$LOG_GROUP" --follow --since 1m &
TAIL_PID=$!
```

### 1b — Poll the Job row (AppSync query)

After the browser submits and returns a `jobId`, poll with:

```bash
poll_job() {
  local JOB_ID="$1"
  for i in $(seq 1 30); do
    RESULT=$(curl -s -X POST "$APPSYNC_URL" \
      -H "x-api-key: $APPSYNC_KEY" \
      -H "content-type: application/json" \
      -d "{\"query\":\"query { getJob(id: \\\"$JOB_ID\\\") { id status totalReviews pctPositive scrapedReviews errorMessage updatedAt } }\"}")
    STATUS=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['getJob']['status'] if d.get('data') and d['data'].get('getJob') else 'NOT_FOUND')")
    echo "[$(date -u +%T)] Job $JOB_ID: $STATUS"
    echo "$RESULT" | python3 -m json.tool 2>/dev/null
    if [[ "$STATUS" == "SUCCEEDED" || "$STATUS" == "FAILED" ]]; then
      echo "Terminal state reached: $STATUS"
      break
    fi
    sleep 5
  done
}
```

Record timestamps at: POST submit → `PENDING` created → `RUNNING` → terminal state. This makes FE-render delay vs backend delay separable.

---

## Step 2 — Nominal path (valid Steam URL)

**Known-good test URL:** `https://store.steampowered.com/app/413150/Stardew_Valley/` (Stardew Valley, appId 413150 — large review volume, stable game).

### 2a — Navigate and submit

1. `browser_navigate` to `$BASE_URL`.
2. Take a screenshot: `screenshots/01-home.png`.
3. `browser_snapshot` to locate the URL input field and the Analyze button.
4. `browser_fill_form` or `browser_type` the Steam URL into the input.
5. `browser_click` the Analyze/Submit button.
6. Take a screenshot immediately: `screenshots/02-submit.png`.

### 2b — Assert waiting screen

After navigation to `/job/{jobId}`:
1. `browser_wait_for` the animated waiting indicator (spinner, progress bar, or "Working on it" text — inspect the snapshot for the exact selector).
2. Assert the waiting screen is visible: `browser_snapshot` and confirm the DOM contains the waiting state.
3. Take a screenshot: `screenshots/03-waiting.png`.
4. Extract `jobId` from the URL (e.g. `browser_evaluate` → `window.location.pathname`).
5. Start `poll_job $JOB_ID` in the background to track backend progress concurrently.

### 2c — Assert nominal screen

1. `browser_wait_for` the nominal screen (game name heading or review count element). Allow up to **15 minutes** (Scraper timeout is 600s + margin); fail if not reached.
2. `browser_snapshot` to read the rendered values.
3. Assert ALL of:
   - Game name is non-empty (should contain "Stardew Valley").
   - Total review count is a positive integer (Stardew Valley has 700k+ reviews; even `scrapedReviews` will be non-zero).
   - Percent positive is displayed (e.g. "95%" or similar) — not "N/A" for this game.
4. Take a screenshot: `screenshots/04-nominal.png`.
5. Record the backend poll result (status should be `SUCCEEDED` by now; log `totalReviews`, `pctPositive`, `scrapedReviews`).
6. Confirm the Scraper CloudWatch log shows `worker_complete` with the correct `jobId`.

**Diagnostic split:** If the browser is still showing a spinner at the 5-minute mark:
- If CloudWatch shows `worker_complete` → the issue is in the FE subscription (AppSync `observeQuery` merge or render path); capture `screenshots/04-spinner-backend-done.png`.
- If CloudWatch shows no `worker_start` → the async invoke did not fire; capture `screenshots/04-spinner-no-invoke.png`.
- If CloudWatch shows `worker_failed` → the error reached the Job row; inspect `errorMessage`.

---

## Step 3 — Invalid-URL path

This path tests the synchronous Validator 4xx branch. No `Job` row is created.

1. Navigate back to `$BASE_URL` (or `browser_navigate_back` until the URL box is visible).
2. `browser_snapshot` to confirm URL input is present.
3. Submit a non-Steam URL: `https://google.com`.
4. `browser_wait_for` an inline error message (the page should NOT navigate away).
5. Assert:
   - The URL in the browser is still the home route (not `/job/...`).
   - The error text matches one of the Validator error strings: `"That's not a Steam game URL."` (the exact string from the API contract).
6. Take a screenshot: `screenshots/05-invalid-url-error.png`.
7. Test a second case — a Steam URL with no appId (e.g. `https://store.steampowered.com/`):
   - Submit and assert the same inline-error behavior.
   - Screenshot: `screenshots/06-invalid-steam-url.png`.

---

## Step 4 — Forced-failure path

Test that the Try-Again screen renders correctly when `Job.status == FAILED`.

**Option A — Use a known-bad appId that returns `appdetails success:false`:**
Submit `https://store.steampowered.com/app/9999999999/` (a very large appId unlikely to be a real game). The Validator returns `400 {"error":"We couldn't find that game on Steam."}` — this hits the **inline-error** path (no Job row), not the Try-Again screen.

**Option B — Force a Try-Again screen via the App's FAILED state:**
The Try-Again screen renders when `Job.status == FAILED`. In staging, the easiest trigger is:
1. Submit a valid Steam URL that is expected to work.
2. After the `jobId` is returned (Job is `PENDING`), manually write a `FAILED` status to the row via AppSync:

```bash
curl -s -X POST "$APPSYNC_URL" \
  -H "x-api-key: $APPSYNC_KEY" \
  -H "content-type: application/json" \
  -d "{\"query\":\"mutation { updateJob(input: { id: \\\"$JOB_ID\\\", status: \\\"FAILED\\\", errorMessage: \\\"Scrape failed. Try again.\\\" }, condition: { status: { eq: \\\"PENDING\\\" } }) { id status errorMessage } }\"}"
```

3. `browser_wait_for` the Try-Again screen.
4. Assert:
   - The error message text is visible (matches the `errorMessage` written: `"Scrape failed. Try again."`).
   - A "Try Again" / "Back" button is present and links back to `/`.
5. Take a screenshot: `screenshots/07-try-again.png`.
6. Click the try-again/back button and assert navigation returns to the URL box at `/`.
7. Screenshot: `screenshots/08-back-to-home.png`.

---

## Step 5 — Cleanup and report

```bash
# Stop log tail
kill $TAIL_PID 2>/dev/null

# List all screenshots captured
ls -lh screenshots/*.png | grep -E "0[1-8]-"
```

Summarize findings:
- Nominal path: PASS/FAIL, observed game name + review counts, time-to-nominal-screen, backend latency vs FE-render latency.
- Invalid-URL path: PASS/FAIL, error text matched expected string.
- Forced-failure path: PASS/FAIL, Try-Again screen rendered correctly.
- Any CloudWatch log anomalies (unexpected errors, missing events).
- Screenshot paths for each assertion.

---

## Assertion reference

| Step | Expected behavior | Screenshot |
|------|-------------------|------------|
| Home loaded | URL box + Analyze button visible | `01-home.png` |
| Post submit | Navigated to `/job/{jobId}` | `02-submit.png` |
| Waiting screen | Animated indicator visible; page NOT on `/` | `03-waiting.png` |
| Nominal screen | `gameName` + `totalReviews` (>0) + `pctPositive` (not "N/A") rendered | `04-nominal.png` |
| Invalid URL | Inline error `"That's not a Steam game URL."` visible; URL stays at `/` | `05-invalid-url-error.png` |
| Invalid Steam URL | Inline error visible; URL stays at `/` | `06-invalid-steam-url.png` |
| Try-Again screen | `errorMessage` rendered; "Try Again" button present | `07-try-again.png` |
| Back to home | Navigated back to `/`; URL box visible | `08-back-to-home.png` |

---

## Playwright MCP tools used

This agent runs using the `mcp__plugin_playwright_playwright__*` browser tools:

- `browser_navigate` — open URLs
- `browser_snapshot` — inspect accessible DOM structure
- `browser_take_screenshot` — capture visual evidence (always to `screenshots/` at repo root)
- `browser_wait_for` — wait for elements or text to appear
- `browser_fill_form` / `browser_type` — fill the URL input
- `browser_click` — submit the form, click navigation buttons
- `browser_evaluate` — read `window.location` or extract jobId from the URL

Backend observation uses the Bash tool with `aws logs tail`, `aws ssm get-parameter`, and `curl` against the AppSync endpoint.

---

## Failure fast-paths

| Symptom | Likely cause | Diagnostic action |
|---------|-------------|-------------------|
| Browser stuck on spinner > 5 min, CloudWatch shows `worker_complete` | FE `observeQuery` not merging partial update | Check browser console for AppSync subscription errors; verify merge logic handles partial `onUpdate` events |
| Browser stuck on spinner, no `worker_start` in CloudWatch | Async invoke never fired (concurrency throttle or Validator invoke error) | Check Validator Lambda logs; check DLQ depth |
| `poll_job` returns `NOT_FOUND` after submit | Job row never created | Validator `createJob` mutation failed; check Validator CloudWatch logs for AppSync error |
| Nominal screen renders but `pctPositive` shows "N/A" for Stardew Valley | `pctPositive` is null despite positive reviews existing | Check S3 JSON `summary.pctPositive` — may be a `query_summary` fetch issue or wrong filter parameter |
| YAML selector mismatch | App DOM structure differs from expected | Use `browser_snapshot` to inspect current DOM; update selectors |
