const express = require('express');
const { Pool } = require('pg');
const app = express();

app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// HEALTH CHECK
app.get('/', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'Hotel Pricing API is running', database: 'connected' });
  } catch (e) {
    res.status(500).json({ status: 'API running', database: 'ERROR - ' + e.message });
  }
});

// LOGIN
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (!r.rows.length) return res.status(401).json({ error: 'User not found' });
    const user = r.rows[0];
    if (user.password_hash !== password) return res.status(401).json({ error: 'Wrong password' });
    res.json({ id: user.id, email: user.email, role: user.role, name: user.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET ALL HOTELS
app.get('/hotels', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM hotels ORDER BY name ASC');
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ADD HOTEL WITH AI
app.post('/hotels/add-with-ai', async (req, res) => {
  try {
    const { raw_contract } = req.body;
    if (!raw_contract) return res.status(400).json({ error: 'raw_contract is required' });

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: `You are a hotel contract data extraction specialist.
Read the hotel contract below and extract ALL information into a precise JSON object.
Respond ONLY with valid JSON — no markdown, no backticks, no explanation, just raw JSON.

Required JSON structure:
{
  "hotel_name": "full hotel name",
  "location": "city, country",
  "stars": 5,
  "currency": "OMR",
  "validity": "date range as written in contract",
  "seasons": {
    "low":  [{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}],
    "high": [{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}],
    "peak": [{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}]
  },
  "rooms": [
    {
      "name": "room type name",
      "size": "60sqm",
      "low": 0,
      "high": 0,
      "peak": 0,
      "villa": false,
      "added_values": false,
      "on_request": false
    }
  ],
  "boards": [
    {
      "name": "Bed & Breakfast",
      "code": "BB",
      "adult_ppn": 0,
      "child6_11_ppn": 0,
      "note": ""
    }
  ],
  "extra_bed": {
    "adult": 0,
    "adult_peak": 0,
    "child6_11": 0,
    "child6_11_peak": 0
  },
  "children_policy": {
    "under6_free": true,
    "age6_11_breakfast_ppn": 0,
    "age6_11_meal_discount": 0.5
  },
  "third_adult_supplement": 0,
  "transfers": [
    {"name": "transfer name", "price": 0, "type": "one_way"}
  ],
  "extras": [
    {"name": "extra name", "price": 0, "per": "stay", "note": ""}
  ],
  "festive": {
    "christmas_eve": {
      "compulsory": true,
      "adult_full": 0,
      "child_full": 0,
      "adult_hb": 0,
      "child_hb": 0
    },
    "new_year_eve": {
      "compulsory": true,
      "adult_full": 0,
      "child_full": 0
    }
  },
  "promotions": [
    {"name": "promo name", "discount_pct": 0, "conditions": ""}
  ],
  "cancellation": {
    "low": "policy text",
    "high": "policy text",
    "peak": "policy text"
  },
  "payment_terms": {
    "low": "X days prior",
    "high": "X days prior",
    "peak": "X days prior"
  },
  "no_show": "policy text",
  "min_stay": "policy text",
  "group_policy": "policy text",
  "special_notes": "any other important notes"
}

Extract every number, date range, and policy exactly as stated.
Use null for any field not in the contract.

CONTRACT:
${raw_contract}`
        }]
      })
    });

    const claudeData = await claudeRes.json();
    if (!claudeData.content || !claudeData.content[0]) {
      return res.status(500).json({ error: 'Claude API error', details: claudeData });
    }

    const rawJson = claudeData.content[0].text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(rawJson);

    const insertRes = await pool.query(
      `INSERT INTO hotels (name, location, stars, currency, validity, contract_data)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [parsed.hotel_name, parsed.location, parsed.stars, parsed.currency, parsed.validity, parsed]
    );

    res.json({ success: true, hotel: insertRes.rows[0], extracted: parsed });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// UPDATE HOTEL
app.put('/hotels/:id', async (req, res) => {
  try {
    const { contract_data } = req.body;
    const r = await pool.query(
      'UPDATE hotels SET contract_data=$1, updated_at=now() WHERE id=$2 RETURNING *',
      [contract_data, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE HOTEL
app.delete('/hotels/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM hotels WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET AI PRICING NOTES
app.post('/price', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const d = await r.json();
    if (!d.content || !d.content[0]) {
      return res.status(500).json({ error: 'Claude API error', details: d });
    }
    res.json({ result: d.content[0].text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SAVE QUOTE
app.post('/quotes', async (req, res) => {
  try {
    const q = req.body;
    const r = await pool.query(
      `INSERT INTO quotes
        (hotel_id, hotel_name, client_name, checkin, nights, adults,
         children_6_11, children_u6, room_type, board_plan,
         extras, transfers, total_net, ai_notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        q.hotel_id, q.hotel_name, q.client_name, q.checkin,
        q.nights, q.adults, q.children_6_11 || 0, q.children_u6 || 0,
        q.room_type, q.board_plan, q.extras, q.transfers,
        q.total_net, q.ai_notes, q.created_by
      ]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET QUOTE HISTORY
app.get('/quotes', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM quotes ORDER BY created_at DESC LIMIT 200');
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(3000, () => console.log('Hotel Pricing API running on port 3000'));
