import 'dotenv/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage } from 'telegram/events';
import input from 'input';
import { env } from '../env';
import { prisma } from '../db';
import { tradeForChannelSlug } from '../trade/pulsex';

function extractAddresses(text: string): string[] {
  const set = new Set<string>();
  const regex = /(0x[a-fA-F0-9]{40})/g;
  const m = text.matchAll(regex);
  for (const r of m) set.add(r[1]);
  return [...set];
}

function normalizeSlug(s?: string) {
  return (s || '').toLowerCase();
}

(async function main() {
  if (!env.TG_API_ID || !env.TG_API_HASH) {
    console.error('[USERBOT] Missing TG_API_ID / TG_API_HASH'); process.exit(1);
  }

  const client = new TelegramClient(new StringSession(env.TG_SESSION), env.TG_API_ID, env.TG_API_HASH, { connectionRetries: 5 });

  await client.start({
    phoneNumber: async () => await input.text('Phone number: '),
    password: async () => await input.text('2FA password (if any): '),
    phoneCode: async () => await input.text('Code you received: '),
    onError: (err) => console.error(err),
  });

  const saved = client.session.save();
  if (!env.TG_SESSION && saved) {
    console.log('\n[USERBOT] Save this TG_SESSION in your .env to skip login next time:\n' + saved + '\n');
  }

  console.log('[USERBOT] Logged in. Listening...');
  client.addEventHandler(async (event) => {
    try {
      const message: any = event.message;
      if (!message) return;
      const text: string = message.message || '';
      if (!text) return;

      const chat = await message.getChat();
      const slug = normalizeSlug((chat?.username || chat?.title || '').toString());
      if (!slug) return; // public channels by username in this build

      if (env.TARGET_CHATS.length && !env.TARGET_CHATS.includes(slug)) return;

      const channel = await prisma.channel.findFirst({ where: { slug, mode: 'MTPROTO', active: true } });
      if (!channel) return;

      const addrs = extractAddresses(text);
      if (addrs.length === 0) return;

      const token = addrs[0];
      const status = await tradeForChannelSlug(slug, token);
      console.log(`[USERBOT] ${slug}: ${status}`);
    } catch (e) {
      console.error('[USERBOT] Handler error:', e);
    }
  }, new NewMessage({}));
})();
