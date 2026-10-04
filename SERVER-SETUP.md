# Dairy backend - setup guide (Railway)

This replaces the slow Apps Script backend with a fast always-on server.
Your Google Sheet stays the database. Nothing about your mum's sheet changes.

Order entry will go from ~1 minute to roughly 1-1.5 seconds.

There are 3 one-time jobs:
  A. Create a Google "service account" so the server can write to your sheet
  B. Put this code on GitHub and deploy it on Railway
  C. Point the app at the new server

Take them in order. Budget ~30-40 minutes the first time.

================================================================
A. GOOGLE SERVICE ACCOUNT (gives the server permission to the sheet)
================================================================

1. Go to https://console.cloud.google.com and sign in with the Google account
   that owns the dairy spreadsheet.

2. Top bar: click the project dropdown -> "New Project".
   Name it "Dairy Backend". Create. Wait a few seconds, then make sure that
   new project is selected in the top bar.

3. Enable the Sheets API:
   - Left menu (or search bar) -> "APIs & Services" -> "Library".
   - Search "Google Sheets API" -> click it -> "Enable".

4. Create the service account:
   - "APIs & Services" -> "Credentials".
   - "Create credentials" -> "Service account".
   - Name: "dairy-writer". Click "Create and continue".
   - Role: skip it (click "Continue"), then "Done".

5. Make a key for it:
   - On the Credentials page, under "Service Accounts", click the
     "dairy-writer@...iam.gserviceaccount.com" entry.
   - "Keys" tab -> "Add key" -> "Create new key" -> "JSON" -> "Create".
   - A .json file downloads. KEEP THIS SAFE. You will paste its contents into
     Railway in step B. Do not email it or commit it to GitHub.

6. Share the sheet with the service account:
   - Open that downloaded JSON in a text editor. Find the line
     "client_email": "dairy-writer@....iam.gserviceaccount.com".
     Copy that email address.
   - Open your dairy Google Sheet -> "Share" -> paste that email ->
     set it to "Editor" -> untick "Notify people" -> "Share".

7. Get the sheet id:
   - From the sheet's URL:
     https://docs.google.com/spreadsheets/d/THIS_LONG_PART/edit
     Copy THIS_LONG_PART. That's your SHEET_ID.

================================================================
B. GITHUB + RAILWAY (puts the server online)
================================================================

8. Put this folder on GitHub:
   - Create a new repo at https://github.com/new -> name "dairy-backend" ->
     Private is fine -> Create.
   - Upload server.js, package.json, and .gitignore to it
     (Add file -> Upload files -> drag them in -> Commit).
   - Do NOT upload the service-account JSON or node_modules.

9. Deploy on Railway:
   - Go to https://railway.app -> sign up / log in (use GitHub to make it easy).
   - "New Project" -> "Deploy from GitHub repo" -> pick "dairy-backend".
   - Railway starts building it. It will fail or idle until we add the
     settings below - that's expected.

10. Add the environment variables (Railway -> your project -> the service ->
    "Variables" tab -> "New Variable", add each):
    - SHEET_ID               = the long id from step 7
    - GOOGLE_SERVICE_ACCOUNT = the ENTIRE contents of the JSON file from step 5
                               (open it, select all, copy, paste as the value)
    - ALLOW_ORIGIN           = your site address, e.g.
                               https://YOURNAME.github.io
                               (you can use *  while testing, tighten later)

11. Make it publicly reachable:
    - Railway -> your service -> "Settings" -> "Networking" ->
      "Generate Domain". It gives you a URL like
      https://dairy-backend-production.up.railway.app
    - Copy that URL.

12. Test it: open that URL in a browser. You should see
    {"ok":true,"service":"dairy-backend",...}
    Then open  THAT_URL/bootstrap  - you should see your customers and
    products as JSON. If you see an error about client_email or permission,
    re-check steps 5-6 (the sheet must be shared with the service account).

================================================================
C. POINT THE APP AT THE NEW SERVER
================================================================

13. In dairy-index.html, near the top, there is now a line:
        const API_BASE = "PASTE_YOUR_RAILWAY_URL_HERE";
    Replace it with your Railway URL from step 11 (no trailing slash).
    Leave the old APPS_SCRIPT_URL line as it is - it is still used for the
    "Refresh summary" button only.

14. Re-upload dairy-index.html to your GitHub Pages repo. Done.

The app now saves orders through Railway (fast). The summary refresh button
still uses Apps Script, which is fine because it is only pressed occasionally.

================================================================
NOTES
================================================================
- Cost: Railway Hobby is ~5 USD/month and includes 5 USD of usage credit.
  This tiny server stays near that floor.
- The service account only has access to sheets you explicitly share with it.
- If you ever rotate the key (step 5), just paste the new JSON into the
  GOOGLE_SERVICE_ACCOUNT variable on Railway and redeploy.
- The summary rebuild stays in Apps Script on purpose: it does heavy
  formatting that is slow to do through the API and only runs occasionally.
