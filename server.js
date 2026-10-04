/*
 * Ol-Chaketai Dairy - fast backend
 * ----------------------------------
 * Replaces the slow Google Apps Script web app. Talks directly to the same
 * Google Sheet via the Sheets API, so the sheet stays the database and your
 * mum keeps editing it normally. Responds in well under a second because it is
 * always running (no Apps Script spin-up).
 *
 * Endpoints (same shape the app already expects):
 *   GET  /            -> health check
 *   GET  /bootstrap   -> { ok, customers, products }
 *   POST /            -> { action: "createOrders" | "refreshSummary", ... }
 *
 * Config comes from environment variables (set in Railway):
 *   SHEET_ID                 the spreadsheet id (from its URL)
 *   GOOGLE_SERVICE_ACCOUNT   the service-account JSON, pasted whole
 *   ALLOW_ORIGIN             (optional) your site origin for CORS; default "*"
 */

const express = require('express');
const { google } = require('googleapis');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---- CORS (so the GitHub Pages site can call this) ----
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
app.use(function (req, res, next) {
  res.set('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ---- Google Sheets auth (service account) ----
const SHEET_ID = process.env.SHEET_ID;
let creds;
try {
  creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
} catch (e) {
  console.error('GOOGLE_SERVICE_ACCOUNT is not valid JSON');
}

const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

let sheetsApi;
async function sheets() {
  if (!sheetsApi) {
    const client = await auth.getClient();
    sheetsApi = google.sheets({ version: 'v4', auth: client });
  }
  return sheetsApi;
}

// ---- constants mirroring the Apps Script ----
const CUSTOMERS_TAB = 'Customers';
const PRODUCTS_TAB = 'Products';
const ORDER_HEADERS = [
  'orderId', 'date', 'customer', 'product', 'qty',
  'unitPrice', 'amount', 'payment', 'comments', 'enteredAt', 'isVerified',
];

// The dairy month runs 25th to 24th; period is named after the month it ends in.
function monthTabName(dateStr) {
  const p = String(dateStr).slice(0, 10).split('-');
  let y = Number(p[0]);
  let m = Number(p[1]);
  const day = Number(p[2]);
  if (day >= 25) { m += 1; if (m > 12) { m = 1; y += 1; } }
  return y + '-' + ('0' + m).slice(-2);
}

// ---- small helpers ----
async function getValues(range) {
  const api = await sheets();
  const res = await api.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range,
  });
  return res.data.values || [];
}

async function appendValues(tab, rows) {
  const api = await sheets();
  await api.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: tab + '!A1',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

async function listTabs() {
  const api = await sheets();
  const meta = await api.spreadsheets.get({ spreadsheetId: SHEET_ID });
  return meta.data.sheets.map(function (s) { return s.properties.title; });
}

async function ensureTab(title) {
  const tabs = await listTabs();
  if (tabs.indexOf(title) !== -1) return;
  const api = await sheets();
  await api.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  // add the header row
  await appendValues(title, [ORDER_HEADERS]);
}

// ---- routes ----

app.get('/', function (req, res) {
  res.json({ ok: true, service: 'dairy-backend', time: new Date().toISOString() });
});

app.get('/bootstrap', async function (req, res) {
  try {
    const cVals = await getValues(CUSTOMERS_TAB + '!A2:A');
    const customers = cVals
      .map(function (r) { return String(r[0] || '').trim(); })
      .filter(function (n) { return n !== ''; });

    const pVals = await getValues(PRODUCTS_TAB + '!A2:C');
    const products = pVals
      .filter(function (r) {
        return String(r[0] || '').trim() !== '' &&
               String(r[2] || '').trim().toLowerCase() !== 'no';
      })
      .map(function (r) {
        return { name: String(r[0]).trim(), price: Number(r[1]) || 0 };
      });

    res.json({ ok: true, customers: customers, products: products });
  } catch (err) {
    console.error('bootstrap', err);
    res.json({ ok: false, error: String(err.message || err) });
  }
});

app.post('/', async function (req, res) {
  const body = req.body || {};
  try {
    if (body.action === 'createOrder' || body.action === 'createOrders') {
      const lines = body.orders ? body.orders : [body.order];
      if (!lines || !lines.length) {
        return res.json({ ok: false, error: 'no order lines' });
      }

      const first = lines[0];

      // register a brand-new customer once
      if (first.isNewCustomer && first.customer) {
        const existing = (await getValues(CUSTOMERS_TAB + '!A2:A'))
          .map(function (r) { return String(r[0] || '').trim().toLowerCase(); });
        if (existing.indexOf(String(first.customer).trim().toLowerCase()) === -1) {
          await appendValues(CUSTOMERS_TAB, [[String(first.customer).trim()]]);
        }
      }

      // group by month tab
      const stamp = new Date().toISOString();
      const byTab = {};
      lines.forEach(function (o) {
        const name = monthTabName(o.date);
        if (!byTab[name]) byTab[name] = [];
        byTab[name].push([
          o.orderId, o.date, o.customer, o.product, o.qty,
          o.unitPrice, o.amount, o.payment, o.comments || '', stamp, false,
        ]);
      });

      let written = 0, skipped = 0;
      const tabNames = Object.keys(byTab);
      for (let t = 0; t < tabNames.length; t++) {
        const name = tabNames[t];
        await ensureTab(name);

        // idempotency: skip orderIds already present
        const existingIds = {};
        const idCol = await getValues(name + '!A2:A');
        idCol.forEach(function (r) {
          const id = String(r[0] || '').trim();
          if (id) existingIds[id] = true;
        });

        const fresh = byTab[name].filter(function (row) {
          if (existingIds[String(row[0]).trim()]) { skipped++; return false; }
          return true;
        });

        if (fresh.length) {
          await appendValues(name, fresh);
          written += fresh.length;
        }
      }

      return res.json({ ok: true, saved: written, skipped: skipped });
    }

    if (body.action === 'refreshSummary') {
      // The summary rebuild stays in Apps Script (it does rich formatting the
      // Sheets API would make slow and verbose). The app's refresh button can
      // still call Apps Script for this, OR trigger it from the sheet menu.
      return res.json({
        ok: false,
        error: 'Use the Dairy menu in the sheet to refresh the summary.',
      });
    }

    return res.json({ ok: false, error: 'unknown action' });
  } catch (err) {
    console.error('post', err);
    return res.json({ ok: false, error: String(err.message || err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log('dairy-backend listening on ' + PORT);
});
