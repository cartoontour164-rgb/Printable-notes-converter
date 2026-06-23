// server.js
// Minimal backend for force-subscribe checks on a Telegram Mini App.
// Deploy this on Render / Railway / Vercel (as a Node server) / Replit.

const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '25mb' })); // generated PDFs can be a few MB

// --- Config: set these as environment variables on your host ---
const BOT_TOKEN = process.env.BOT_TOKEN;           // from @BotFather
// Comma-separated list, e.g. "@channel1,@channel2,-1001234567890"
const CHANNEL_IDS = (process.env.CHANNEL_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// CORS so your Mini App (hosted elsewhere) can call this
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Validates Telegram's WebApp initData using the bot token.
// Docs: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return null;

  const userJson = params.get('user');
  return userJson ? JSON.parse(userJson) : null;
}

app.post('/check-subscription', async (req, res) => {
  try {
    const { initData } = req.body;
    if (!initData) return res.status(400).json({ error: 'missing initData' });

    const user = verifyInitData(initData);
    if (!user) return res.status(401).json({ error: 'invalid initData' });

    if (CHANNEL_IDS.length === 0) {
      return res.json({ subscribed: true, missing: [] }); // nothing configured, nothing to check
    }

    const results = await Promise.all(CHANNEL_IDS.map(async (chatId) => {
      const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${user.id}`;
      const tgRes = await fetch(apiUrl);
      const tgData = await tgRes.json();

      if (!tgData.ok) {
        // Common cause: bot is not an admin in that channel/group, so it can't check membership.
        return { chatId, ok: false, error: tgData.description };
      }
      const status = tgData.result.status; // "creator","administrator","member","restricted","left","kicked"
      const subscribed = ['creator', 'administrator', 'member'].includes(status);
      return { chatId, ok: true, subscribed, status };
    }));

    const missing = results.filter(r => !r.ok || !r.subscribed).map(r => r.chatId);
    const errors = results.filter(r => !r.ok);

    res.json({
      subscribed: missing.length === 0,
      missing,
      details: results,
      userId: user.id,
      ...(errors.length ? { warning: 'Some chats could not be checked — is the bot an admin there?' } : {})
    });
  } catch (err) {
    res.status(500).json({ error: 'server_error', details: String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));

// --- Temporary PDF hosting for Telegram WebView downloads ---
// Telegram's in-app browser often can't trigger a download from a blob: URL,
// but it CAN navigate to a normal https:// URL with a Content-Disposition
// header. So the client uploads the finished PDF here, gets back a short-lived
// link, and opens that link to trigger a real download.
const pdfStore = new Map(); // id -> { buffer, createdAt }
const PDF_TTL_MS = 10 * 60 * 1000; // 10 minutes is plenty for a download to start

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pdfStore) {
    if (now - entry.createdAt > PDF_TTL_MS) pdfStore.delete(id);
  }
}, 60 * 1000);

app.post('/store-pdf', (req, res) => {
  try {
    const { base64 } = req.body;
    if (!base64) return res.status(400).json({ error: 'missing base64' });

    const id = crypto.randomBytes(12).toString('hex');
    const buffer = Buffer.from(base64, 'base64');
    pdfStore.set(id, { buffer, createdAt: Date.now() });

    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: 'server_error', details: String(err) });
  }
});

app.get('/download/:id', (req, res) => {
  const entry = pdfStore.get(req.params.id);
  if (!entry) return res.status(404).send('Link expired — please regenerate the PDF.');

  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'attachment; filename="printable-notes.pdf"',
    'Content-Length': entry.buffer.length
  });
  res.send(entry.buffer);
});
