import 'dotenv/config';
import TelegramBot, { InlineKeyboardMarkup } from 'node-telegram-bot-api';
import axios from 'axios';
import { env } from '../env';

const TOKEN = env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN missing'); process.exit(1);
}
const API = `http://localhost:${env.PORT}`;

const bot = new TelegramBot(TOKEN, { polling: true });

function parseSlug(input: string) {
  return input.trim()
    .replace(/^https?:\/\//, '')
    .replace(/^t\.me\//i, '')
    .replace(/^@/, '')
    .toLowerCase();
}

async function apiPost(path: string, body: any) {
  const { data } = await axios.post(`${API}${path}`, body, { headers: { 'x-api-key': process.env.API_KEY || 'dev-key-123' } });
  return data;
}
async function apiGet(path: string) {
  const { data } = await axios.get(`${API}${path}`, { headers: { 'x-api-key': process.env.API_KEY || 'dev-key-123' } });
  return data;
}

bot.onText(/^\/start$/, (msg) => {
  bot.sendMessage(msg.chat.id,
`Welcome! Commands:
/add <t.me/slug|@slug> userbot <profileId>
/list
/remove <slug>
/status <profileId>`);
});

// Add channel
bot.onText(/^\/add\s+([^\s]+)\s+(userbot)\s+([\w-]+)/i, async (msg, m) => {
  const chatId = msg.chat.id;
  try {
    const slug = parseSlug(m[1]);
    const mode = 'MTPROTO';
    const buyProfileId = m[3];
    const ch = await apiPost('/channels', { slug, mode, buyProfileId });
    bot.sendMessage(chatId, `✅ Added ${slug} (mode=${mode}) with profile=${buyProfileId}`);
  } catch (e: any) {
    bot.sendMessage(chatId, `❌ /add failed: ${e.response?.data?.error || e.message}`);
  }
});

// List channels
bot.onText(/^\/list$/i, async (msg) => {
  try {
    const list = await apiGet('/channels/list');
    if (!Array.isArray(list) || list.length === 0) return bot.sendMessage(msg.chat.id, 'No channels configured.');
    const lines = list.map((c: any) => `${c.active ? '✅' : '⏸️'} ${c.slug} (${c.mode}) [profile:${c.buyProfileId || '-'}]`).join('\n');
    bot.sendMessage(msg.chat.id, lines);
  } catch (e: any) {
    bot.sendMessage(msg.chat.id, `❌ /list failed: ${e.response?.data?.error || e.message}`);
  }
});

// Remove (disable) channel
bot.onText(/^\/remove\s+([^\s]+)/i, async (msg, m) => {
  try {
    const slug = parseSlug(m[1]);
    await apiPost('/channels/toggleBySlug', { slug, active: false });
    bot.sendMessage(msg.chat.id, `🛑 Disabled ${slug}`);
  } catch (e: any) {
    bot.sendMessage(msg.chat.id, `❌ /remove failed: ${e.response?.data?.error || e.message}`);
  }
});

// Status with buttons
bot.onText(/^\/status\s+([\w-]+)/i, async (msg, m) => {
  const profileId = m[1];
  try {
    const st = await apiGet(`/profiles/${profileId}/status`);
    const kb: InlineKeyboardMarkup = {
      inline_keyboard: [[
        { text: `Auto-Buy: ${st.dryRun ? 'OFF (DRY)' : 'ON (LIVE)'}`, callback_data: `TOGGLE:${profileId}` },
        { text: 'Refresh', callback_data: `REFRESH:${profileId}` }
      ]]
    };
    const body =
`Profile: ${profileId}
Wallet: ${st.walletAddress}
Amount: ${st.amountNative} PLS
Slippage: ${st.slippageBps} bps
Fee: ${st.feeBps} bps
Treasury: ${st.treasury || '(not set)'}`;
    bot.sendMessage(msg.chat.id, body, { reply_markup: kb });
  } catch (e: any) {
    bot.sendMessage(msg.chat.id, `❌ /status failed: ${e.response?.data?.error || e.message}`);
  }
});

// Callbacks for toggle/refresh
bot.on('callback_query', async (q) => {
  try {
    const data = q.data || '';
    if (data.startsWith('TOGGLE:')) {
      const id = data.split(':')[1];
      const st = await apiPost(`/profiles/${id}/dryrun`, { toggle: true });
      bot.answerCallbackQuery(q.id, { text: `Auto-Buy is now ${st.dryRun ? 'OFF (DRY)' : 'ON (LIVE)'}` });
    } else if (data.startsWith('REFRESH:')) {
      const id = data.split(':')[1];
      const st = await apiGet(`/profiles/${id}/status`);
      bot.answerCallbackQuery(q.id, { text: `DRY=${st.dryRun} Amount=${st.amountNative} Slippage=${st.slippageBps}` });
    }
  } catch (e: any) {
    bot.answerCallbackQuery({ callback_query_id: q.id, text: `Error: ${e.response?.data?.error || e.message}`, show_alert: true } as any);
  }
});

console.log('Control bot ready. Use /add @slug userbot <profileId> and /status <profileId>.');
