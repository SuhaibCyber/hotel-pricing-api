const express = require('express');
const { Pool } = require('pg');
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── LOGIN ──────────────────────────────────────────
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  if (!r.rows.length) return res.status(401).json({ error: 'User not found' });
  const user = r.rows[0];
  if (user.password_hash !== password) return res.status(401).json({ error: 'Wrong password' });
  res.json({ id: user.id, email: user.email, role: user.role, name: user.name });
});

// ── GET ALL HOTELS ─────────────────────────────────
app.get('/hotels', async (req, res) => {
  const r = await pool.query('SELECT * FROM hotels ORDER BY name ASC');
  res.json(r.rows);
});

// ── ADD HOTEL WITH AI ──────────────────────────────
app.post('/hotels/add-with-ai', async (req, res) => {
  const { raw_contract } = req.body;
  // Step 1: Ask Claude to parse the contract into structured JSON
  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `You are a hotel contract data extraction specialist.
Read the following hotel contract and extract ALL information into a precise JSON object.
Respond ONLY with valid JSON, no markdown, no explanation.

Required JSON structure:
{
  "hotel_name": "...",
  "location": "...",
  "stars": 5,
  "currency": "OMR",
  "validity": "...",
  "seasons": {
    "low":  [{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}],
    "high": [{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}],
    "peak": [{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}]
  },
  "rooms": [
    {"name":"...","size":"...","low":0,"high":0,"peak":0,"villa":false,"added_values":false,"on_request":false}
  ],
  "boards": [
    {"name":"...","code":"...","adult_ppn":0,"child6_11_ppn":0,"child0_5_ppn":0,"note":"..."}
  ],
  "extra_bed": {"adult":0,"adult_peak":0,"child6_11":0,"child6_11_peak":0},
  "children_policy": {"under6_free":true,"age6_11_breakfast_ppn":0,"age6_11_meal_discount":0.5},
  "transfers": [{"name":"...","price":0,"type":"one_way_or_return"}],
  "extras": [{"name":"...","price":0,"per":"person_or_stay","note":"..."}],
  "festive": {
    "christmas_eve": {"adult_full":0,"child_full":0,"adult_hb":0,"child_hb":0,"compulsory":true},
    "new_year_eve":  {"adult_full":0,"child_full":0,"compulsory":true}
  },
  "promotions": [{"name":"...","discount":0,"conditions":"..."}],
  "cancellation": {"low":"...","high":"...","peak":"..."},
  "payment_terms": {"low":"...","high":"...","peak":"..."},
  "no_show": "...",
  "min_stay": "...",
  "third_adult_supplement": 0,
  "group_policy": "...",
  "special_notes": "..."
}

Extract every number, date, and policy exactly as stated.
If a field is not in the contract, use null.

CONTRACT:
${raw_contract}`
      }]
    })
  });
  const claudeData = await claudeRes.json();
  const rawJson = claudeData.content[0].text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(rawJson);

  // Step 2: Save to Supabase
  const insertRes = await pool.query(
    `INSERT INTO hotels (name, location, stars, currency, validity, contract_data)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [parsed.hotel_name, parsed.location, parsed.stars, parsed.currency, parsed.validity, parsed]
  );
  res.json({ success: true, hotel: insertRes.rows[0], extracted: parsed });
});

// ── UPDATE HOTEL ───────────────────────────────────
app.put('/hotels/:id', async (req, res) => {
  const { contract_data } = req.body;
  const r = await pool.query(
    'UPDATE hotels SET contract_data=$1, updated_at=now() WHERE id=$2 RETURNING *',
    [contract_data, req.params.id]
  );
  res.json(r.rows[0]);
});

// ── DELETE HOTEL ───────────────────────────────────
app.delete('/hotels/:id', async (req, res) => {
  await pool.query('DELETE FROM hotels WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// ── GET PRICING NOTES (AI) ─────────────────────────
app.post('/price', async (req, res) => {
  const { prompt } = req.body;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }] })
  });
  const d = await r.json();
  res.json({ result: d.content[0].text });
});

// ── SAVE QUOTE ─────────────────────────────────────
app.post('/quotes', async (req, res) => {
  const q = req.body;
  const r = await pool.query(
    `INSERT INTO quotes (hotel_id,hotel_name,client_name,checkin,nights,adults,children,room_type,board_plan,extras,total_net,ai_notes,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [q.hotel_id,q.hotel_name,q.client_name,q.checkin,q.nights,q.adults,q.children,q.room_type,q.board_plan,q.extras,q.total_net,q.ai_notes,q.created_by]
  );
  res.json(r.rows[0]);
});

// ── GET QUOTES HISTORY ─────────────────────────────
app.get('/quotes', async (req, res) => {
  const r = await pool.query('SELECT * FROM quotes ORDER BY created_at DESC LIMIT 100');
  res.json(r.rows);
});

app.listen(3000, () => console.log('Hotel API running on port 3000'));
