import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { ensureDefaultUser, prisma } from './db';
import { env } from './env';
import { ethers } from 'ethers';
import { tradeForChannelSlug } from './trade/pulsex';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

async function holderGateByWallet(addressToCheck: string) {
  if (!env.HOLDER_TOKEN_ADDRESS) return true;
  const provider = new ethers.JsonRpcProvider(env.EVM_RPC_URL, { chainId: env.CHAIN_ID, name: `chain-${env.CHAIN_ID}` });
  const token = new ethers.Contract(env.HOLDER_TOKEN_ADDRESS, ERC20_ABI, provider);
  const bal: bigint = await token.balanceOf(addressToCheck);
  return bal >= env.HOLDER_MIN_UNITS;
}

(async function main() {
  await ensureDefaultUser();

  const app = express();
  app.use(bodyParser.json());

  // Auth (accept header OR ?api_key= for browser friendliness)
  app.use(async (req, res, next) => {
    const key = String(req.headers['x-api-key'] || req.query.api_key || '');
    if (!key || key !== env.API_KEY) return res.status(401).json({ error: 'unauthorized' });
    const user = await prisma.user.findUnique({ where: { apiKey: env.API_KEY } });
    (req as any).user = user;
    next();
  });

  // Create wallet
  app.post('/wallets', async (req, res) => {
    const user = (req as any).user;
    const { address, chainId = env.CHAIN_ID, label } = req.body || {};
    if (!address) return res.status(400).json({ error: 'address required' });

    if (!(await holderGateByWallet(address))) return res.status(402).json({ error: 'holder requirement not met' });

    const w = await prisma.wallet.create({ data: { userId: user.id, address, chainId, label } });
    res.json(w);
  });

  // Create buy profile
  app.post('/profiles', async (req, res) => {
    const user = (req as any).user;
    const { walletId, amountNative, slippageBps, denyWords, keywords, router, wrappedNative, feeBps, treasury, dryRun } = req.body || {};

    if (!walletId || amountNative == null || !slippageBps || !router || !wrappedNative) {
      return res.status(400).json({ error: 'walletId, amountNative, slippageBps, router, wrappedNative required' });
    }

    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet || wallet.userId !== user.id) return res.status(404).json({ error: 'wallet not found' });

    if (!(await holderGateByWallet(wallet.address))) return res.status(402).json({ error: 'holder requirement not met' });

    const p = await prisma.buyProfile.create({
      data: {
        userId: user.id,
        walletId,
        amountNative: Number(amountNative),
        slippageBps: Number(slippageBps),
        minSecondsBetweenBuys: 900,
        denyWords: denyWords || 'presale,airdrop,testnet,faucet',
        keywords: keywords || 'buy,ca,contract,token,launch,shill,coin',
        router,
        wrappedNative,
        feeBps: feeBps ?? 100,
        treasury: treasury || process.env.TREASURY_ADDRESS || null,
        dryRun: dryRun ?? true
      }
    });
    res.json(p);
  });

  // Add channel (MTPROTO/listener-neutral)
  app.post('/channels', async (req, res) => {
    const user = (req as any).user;
    const { slug, mode, buyProfileId } = req.body || {};
    if (!slug || !buyProfileId) return res.status(400).json({ error: 'slug and buyProfileId required' });
    if (String(mode).toUpperCase() !== 'MTPROTO') return res.status(400).json({ error: 'only MTPROTO supported' });

    const p = await prisma.buyProfile.findUnique({ where: { id: buyProfileId }, include: { wallet: true } });
    if (!p || p.userId !== user.id) return res.status(404).json({ error: 'profile not found' });

    if (!(await holderGateByWallet(p.wallet.address))) return res.status(402).json({ error: 'holder requirement not met' });

    const existing = await prisma.channel.findFirst({ where: { userId: user.id, slug: slug.toLowerCase() } });
    let ch;
    if (existing) ch = await prisma.channel.update({ where: { id: existing.id }, data: { buyProfileId: p.id, active: true } });
    else ch = await prisma.channel.create({ data: { userId: user.id, slug: slug.toLowerCase(), mode: 'MTPROTO', buyProfileId: p.id } });
    res.json(ch);
  });

  // List channels
  app.get('/channels/list', async (req, res) => {
    const user = (req as any).user;
    const list = await prisma.channel.findMany({ where: { userId: user.id } });
    res.json(list);
  });

  // Toggle channel
  app.post('/channels/toggleBySlug', async (req, res) => {
    const user = (req as any).user;
    const { slug, active } = req.body || {};
    if (!slug) return res.status(400).json({ error: 'slug required' });
    const ch = await prisma.channel.findFirst({ where: { userId: user.id, slug: slug.toLowerCase() } });
    if (!ch) return res.status(404).json({ error: 'not found' });
    const updated = await prisma.channel.update({ where: { id: ch.id }, data: { active: !!active } });
    res.json(updated);
  });

  // Toggle dryRun
  app.post('/profiles/:id/dryrun', async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const { toggle, dryRun } = req.body || {};
    const p = await prisma.buyProfile.findUnique({ where: { id }, include: { wallet: true } });
    if (!p || p.userId !== user.id) return res.status(404).json({ error: 'profile not found' });

    const next = toggle ? !p.dryRun : !!dryRun;
    const up = await prisma.buyProfile.update({ where: { id }, data: { dryRun: next } });
    res.json({ dryRun: up.dryRun });
  });

  // Status
  app.get('/profiles/:id/status', async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const p = await prisma.buyProfile.findUnique({ where: { id }, include: { wallet: true } });
    if (!p || p.userId !== user.id) return res.status(404).json({ error: 'profile not found' });

    res.json({
      walletAddress: p.wallet.address,
      amountNative: p.amountNative,
      slippageBps: p.slippageBps,
      dryRun: p.dryRun,
      feeBps: p.feeBps,
      treasury: p.treasury
    });
  });

  // NEW: manual trade trigger (used by the bot when it sees a CA in a channel it’s in)
  app.post('/trade/execute', async (req, res) => {
    const user = (req as any).user;
    const { slug, token } = req.body || {};
    if (!slug || !token) return res.status(400).json({ error: 'slug and token required' });
    const ch = await prisma.channel.findFirst({ where: { userId: user.id, slug: slug.toLowerCase(), active: true } });
    if (!ch) return res.status(404).json({ error: 'channel not found or inactive' });
    const result = await tradeForChannelSlug(slug, token);
    res.json({ result });
  });

  app.listen(env.PORT, () => console.log(`API up on :${env.PORT}`));
})();
