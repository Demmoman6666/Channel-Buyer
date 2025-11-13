import 'dotenv/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage } from 'telegram/events';

// -------- ENV --------
const TG_API_ID = Number(process.env.TG_API_ID || 0);
const TG_API_HASH = String(process.env.TG_API_HASH || '');
const TG_SESSION = String(process.env.TG_SESSION || '');

const TARGET_CHATS = (process.env.TARGET_CHATS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// Optional: call Core’s trade API
const CORE_BASE_URL = process.env.CORE_BASE_URL || ''; // e.g. https://channel-buyer-production.up.railway.app
const API_KEY = process.env.API_KEY || '';

if (!TG_API_ID || !TG_API_HASH) {
  throw new Error('[USERBOT] Missing TG_API_ID/TG_API_HASH env vars');
}
if (!TG_SESSION) {
  throw new Error('[USERBOT] Missing TG_SESSION. Generate it on your Core page (/tg-session) and set it on this service.');
}

// -------- Helpers --------
const addressRegex = /(0x[a-fA-F0-9]{40})/g;
const inScope = (name: string) =>
  TARGET_CHATS.length === 0 ? true : TARGET_CHATS.includes(name.toLowerCase());

async function fireTrade(slug: string, token: string) {
  if (!CORE_BASE_URL || !API_KEY) {
    console.log(`[USERBOT] (no CORE_BASE_URL/API_KEY) would trade for slug=${slug}, token=${token}`);
    return;
  }
  try {
    const res = await fetch(`${CORE_BASE_URL}/trade/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ slug, token })
    });
    const body = await res.json().catch(() => ({}));
    console.log('[USERBOT] trade/execute ->', res.status, JSON.stringify(body));
  } catch (e) {
    console.error('[USERBOT] trade/execute failed:', e);
  }
}

// -------- Main --------
async function main() {
  const client = new TelegramClient(
    new StringSession(TG_SESSION),
    TG_API_ID,
    TG_API_HASH,
    { connectionRetries: 5 }
  );

  await client.connect();

  // Validate session
  try {
    await client.getMe();
  } catch (e: any) {
    throw new Error(`[USERBOT] TG_SESSION invalid or expired: ${e?.message || e}`);
  }

  console.log('[USERBOT] Logged in. Listening for messages...');

  client.addEventHandler(async (event) => {
    try {
      const msg: any = event.message;
      if (!msg) return;

      const text: string = msg.message || '';
      if (!text) return;

      const chat = await msg.getChat();
      const name = (chat?.username || chat?.title || '').toString();
      const slug = (chat?.username || chat?.title || 'unknown').toString().toLowerCase();

      if (!inScope(slug)) return;

      const match = text.match(addressRegex);
      if (!match || match.length === 0) return;

      const token = match[0];
      console.log(`[USERBOT] Found CA in ${name}: ${token}`);

      await fireTrade(slug, token);
    } catch (e) {
      console.error('[USERBOT] handler error:', e);
    }
  }, new NewMessage({}));

  // graceful shutdown
  process.on('SIGINT', async () => {
    try { await client.disconnect(); } finally { process.exit(0); }
  });
}

main().catch((e) => {
  console.error('[USERBOT] Fatal:', e);
  process.exit(1);
});
