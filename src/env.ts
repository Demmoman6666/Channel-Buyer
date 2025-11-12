import 'dotenv/config';

export const env = {
  PORT: Number(process.env.API_PORT || 3000),
  API_KEY: process.env.API_KEY || 'dev-key-123',

  // Telegram
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',

  // MTProto
  TG_API_ID: Number(process.env.TG_API_ID || 0),
  TG_API_HASH: process.env.TG_API_HASH || '',
  TG_SESSION: process.env.TG_SESSION || '',
  TARGET_CHATS: (process.env.TARGET_CHATS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),

  // Chain
  CHAIN_ID: Number(process.env.CHAIN_ID || 369),
  EVM_RPC_URL: process.env.EVM_RPC_URL || 'https://rpc.pulsechain.com',

  // Holder gate
  HOLDER_TOKEN_ADDRESS: process.env.HOLDER_TOKEN_ADDRESS || '',
  HOLDER_MIN_UNITS: BigInt(process.env.HOLDER_MIN_UNITS || '1'),

  // Treasury (fallback)
  TREASURY_ADDRESS: process.env.TREASURY_ADDRESS || ''
};
