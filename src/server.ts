// src/server.ts  (CORE — minimal REST API)

import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { ethers } from 'ethers';
import { prisma } from './db';   // your existing Prisma client exports
import { env } from './env';     // your existing env loader (API_KEY, CHAIN_ID, etc.)

// --- CORS so Hoppscotch/ReqBin browser works ---
const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','x-api-key'],
}));
app.options('*', cors());
app.use(bodyParser.json());

// --- Simple auth: x-api-key header or ?api_key= ---
app.use((req: Request, res: Response, next: NextFunction) => {
  const key = String((req.headers['x-api-key'] as string) || (req.query.api_key as string) || '');
  if (!key || key !== env.API_KEY) return res.status(401).json({ error: 'unauthorized' });
  (req as any).userApiKey = key;
  next();
});

// --- Health check ---
app.get('/health', (_req, res) => res.json({ ok: true }));

// Holder gate (optional)
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
async function holderGateByWallet(addressToCheck: string) {
  if (!env.HOLDER_TOKEN_ADDRESS) return true;
  const provider = new ethers.JsonRpcProvider(env.EVM_RPC_URL, { chainId: env.CHAIN_ID, name: `chain-${env.CHAIN_ID}` });
  const token = new ethers.Contract(env.HOLDER_TOKEN_ADDRESS, ERC20_ABI, provider);
  const bal: bigint = await token.balanceOf(addressToCheck);
  return bal >= env.HOLDER_MIN_UNITS;
}

// --- Wallets ---
app.post('/wallets', async (req: Request, res: Response) => {
  try {
    const { address, chainId = env.CHAIN_ID, label } = req.body || {};
    if (!address) return res.status(400).json({ error: 'address required' });

    if (!(await holderGateByWallet(address))) {
      return res.status(402).json({ error: 'holder requirement not met' });
    }

    // tie wallets to the API key owner (simple model)
    const user = await prisma.user.upsert({
      where: { apiKey: env.API_KEY },
      update: {},
      create: { apiKey: env.API_KEY },
    });

    const w = await prisma.wallet.create({ data: { userId: user.id, address, chainId, label } });
    res.json(w);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// --- Profiles ---
app.post('/profiles', async (req: Request, res: Response) => {
  try {
    const { walletId, amountNative, slippageBps, denyWords, keywords, router, wrappedNative, feeBps, treasury, dryRun } = req.body || {};
    if (!walletId || amountNative == null || !slippageBps || !router || !wrappedNative) {
      return res.status(400).json({ error: 'walletId, amountNative, slippageBps, router, wrappedNative required' });
    }

    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet) return res.status(404).json({ error: 'wallet not found' });
    if (!(await holderGateByWallet(wallet.address))) return res.status(402).json({ error: 'holder requirement not met' });

    const user = await prisma.user.findUnique({ where: { id: wallet.userId } });
    if (!user) return res.status(404).json({ error: 'user not found' });

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
        feeBps: feeBps ?? 0,
        treasury: treasury || null,
        dryRun: dryRun ?? true
      }
    });
    res.json(p);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// --- Channels ---
app.post('/channels', async (req: Request, res: Response) => {
  try {
    const { slug, mode = 'MTPROTO', buyProfileId } = req.body || {};
    if (!slug || !buyProfileId) return res.status(400).json({ error: 'slug and buyProfileId required' });

    const p = await prisma.buyProfile.findUnique({ where: { id: buyProfileId } });
    if (!p) return res.status(404).json({ error: 'profile not found' });

    const existing = await prisma.channel.findFirst({ where: { userId: p.userId, slug: slug.toLowerCase() } });
    const ch = existing
      ? await prisma.channel.update({ where: { id: existing.id }, data: { buyProfileId: p.id, active: true, mode: 'MTPROTO' } })
      : await prisma.channel.create({ data: { userId: p.userId, slug: slug.toLowerCase(), mode: 'MTPROTO', buyProfileId: p.id, active: true } });

    res.json(ch);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get('/channels/list', async (req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { apiKey: env.API_KEY } });
    const list = await prisma.channel.findMany({ where: { userId: user?.id } });
    res.json(list);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// --- Profile helpers ---
app.post('/profiles/:id/dryrun', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { toggle, dryRun } = req.body || {};
    const p = await prisma.buyProfile.findUnique({ where: { id } });
    if (!p) return res.status(404).json({ error: 'profile not found' });

    const next = toggle ? !p.dryRun : !!dryRun;
    const up = await prisma.buyProfile.update({ where: { id }, data: { dryRun: next } });
    res.json({ dryRun: up.dryRun });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get('/profiles/:id/status', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const p = await prisma.buyProfile.findUnique({ where: { id }, include: { wallet: true } });
    if (!p) return res.status(404).json({ error: 'profile not found' });
    res.json({
      walletAddress: p.wallet.address,
      amountNative: p.amountNative,
      slippageBps: p.slippageBps,
      dryRun: p.dryRun,
      feeBps: p.feeBps,
      treasury: p.treasury
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(env.PORT, () => console.log(`CORE API up on :${env.PORT}`));
