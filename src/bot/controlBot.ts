import 'dotenv/config';
import TelegramBot, { InlineKeyboardMarkup, Message, CallbackQuery } from 'node-telegram-bot-api';
import axios from 'axios';
import { env } from '../env';

const TOKEN = env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN missing'); process.exit(1); }
const API = `http://localhost:${env.PORT}`;
const DEFAULT_ROUTER = process.env.DEFAULT_ROUTER || '';
const DEFAULT_WPLS   = process.env.DEFAULT_WPLS || '';

const bot = new TelegramBot(TOKEN, { polling: true });

function parseSlug(input: string) {
  return input.trim().replace(/^https?:\/\//, '').replace(/^t\.me\//i, '').replace(/^@/, '').toLowerCase();
}
function slugFromChat(c: Message['chat']) {
  return ((c as any).username || c.title || '').toLowerCase();
}
function extractAddrs(text = ''): string[] {
  const set = new Set<string>();
  const re = /(0x[a-fA-F0-9]{40})/g;
  for (const m of text.matchAll(re)) set.add(m[1]);
  return [...set];
}

async function apiPost(path: string, body: any) {
  const { data } = await axios.post(`${API}${path}`, body, { headers: { 'x-api-key': process.env.API_KEY || 'dev-key-123' } });
  return data;
}
async function apiGet(path: string) {
  const { data } = await axios.get(`${API}${path}`, { headers: { 'x-api-key': process.env.API_KEY || 'dev-key-123' } });
  return data;
}

bot.onText(/^\/start$/, (msg: Message) => {
  bot.sendMessage(msg.chat.id,
`Welcome! Commands:
/wallet <0xaddress>
/profile <walletId> <amountPLS> <slippageBps>
/add <t.me/slug|@slug> userbot <profileId>
/list
/remove <slug>
/status <profileId>

If you add this bot to a channel/group, it will auto-read posts there.
`);
});

// Create wallet (returns walletId)
bot.onText(/^\/wallet\s+(0x[a-fA-F0-9]{40})$/, async (msg: Message, m) => {
  try {
    const w = await apiPost('/wallets', { address: m[1], chainId: env.CHAIN_ID, label: 'bot' });
    bot.sendMessage(msg.chat.id, `✅ Wallet saved.\nID: ${w.id}\nAddr: ${w.address}`);
  } catch (e: any) {
    bot.sendMessage(msg.chat.id, `❌ /wallet failed: ${e.response?.data?.error || e.message}`);
  }
});

// Create profile (uses DEFAULT_ROUTER/DEFAULT_WPLS if set)
bot.onText(/^\/profile\s+([\w-]+)\s+([\d.]+)\s+(\d{2,5})$/, async (msg: Message, m) => {
  try {
    const walletId = m[1];
    const amountNative = Number(m[2]);
    const slippageBps = Number(m[3]);
    const router = DEFAULT_ROUTER;
    const wrappedNative = DEFAULT_WPLS;
    if (!router || !wrappedNative) return bot.sendMessage(msg.chat.id, '❌ DEFAULT_ROUTER/DEFAULT_WPLS not set in env.');
    const p = await apiPost('/profiles', { walletId, amountNative, slippageBps, router, wrappedNative, treasury: process.env.TREASURY_ADDRESS });
    bot.sendMessage(msg.chat.id, `✅ Profile created.\nID: ${p.id}\nAmount: ${p.amountNative} PLS\nSlip: ${p.slippageBps} bps`);
  } catch (e: any) {
    bot.sendMessage(msg.chat.id, `❌ /profile failed: ${e.response?.data?.error || e.message}`);
  }
});

// Existing commands
bot.onText(/^\/add\s+([^\s]+)\s+(userbot)\s+([\w-]+)/i, async (msg: Message, m) => {
  const chatId = msg.chat.id;
  try {
    const slug = parseSlug(m[1]);
    const mode = 'MTPROTO';
    const buyProfileId = m[3];
    await apiPost('/channels', { slug, mode, buyProfileId });
    bot.sendMessage(chatId, `✅ Added ${slug} (mode=${mode}) with profile=${buyProfileId}`);
  } catch (e: any) {
    bot.sendMessage(chatId, `❌ /add failed: ${e.response?.data?.error || e.message}`);
  }
});

bot.onText(/^\/list$/i, async (msg: Message) => {
  try {
    const list = await apiGet('/channels/list');
    if (!Array.isArray(list) || list.length === 0) return bot.sendMessage(msg.chat.id, 'No channels configured.');
    const lines = list.map((c: any) => `${c.active ? '✅' : '⏸️'} ${c.slug} (${c.mode}) [profile:${c.buyProfileId || '-'}]`).join('\n');
    bot.sendMessage(msg.chat.id, lines);
  } catch (e: any) {
    bot.sendMessage(msg.chat.id, `❌ /list failed: ${e.response?.data?.error || e.message}`);
  }
});

bot.onText(/^\/remove\s+([^\s]+)/i, async (msg: Message, m) => {
  try {
    const slug = parseSlug(m[1]);
    await apiPost('/channels/toggleBySlug', { slug, active: false });
    bot.sendMessage(msg.chat.id, `🛑 Disabled ${slug}`);
  } catch (e: any) {
    bot.sendMessage(msg.chat.id, `❌ /remove failed: ${e.response?.data?.error || e.message}`);
  }
});

// Status with buttons
bot.onText(/^\/status\s+([\w-]+)/i, async (msg: Message, m) => {
  const profileId = m?.[1];
  if (!profileId) return bot.sendMessage(msg.chat.id, 'Usage: /status <profileId>');
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
bot.on('callback_query', async (q: CallbackQuery) => {
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

// NEW: auto-listen to posts in channels/groups where this bot is added
bot.on('channel_post', async (msg: Message) => {
  try {
    const slug = slugFromChat(msg.chat);
    const text = (msg.text || msg.caption || '').toString();
    const [token] = extractAddrs(text);
    if (!slug || !token) return;
    await apiPost('/trade/execute', { slug, token });
  } catch (e) {
    console.error('[channel_post] error', e);
  }
});
bot.on('message', async (msg: Message) => {
  // groups/supergroups
  if (!['group', 'supergroup'].includes(msg.chat.type)) return;
  try {
    const slug = slugFromChat(msg.chat);
    const text = (msg.text || msg.caption || '').toString();
    const [token] = extractAddrs(text);
    if (!slug || !token) return;
    await apiPost('/trade/execute', { slug, token });
  } catch (e) {
    console.error('[message] error', e);
  }
});

console.log('Control bot ready. Add it to your channel/group to auto-buy; DM /wallet, /profile, /add, /status to manage.');
