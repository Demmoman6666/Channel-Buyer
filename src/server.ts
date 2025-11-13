// src/server.ts  — CORE (TG session via phone code + REST API)

import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { ethers } from 'ethers';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { prisma } from './db'; // your existing Prisma client

// ---------- ENV ----------
const PORT        = Number(process.env.API_PORT || process.env.PORT || 3000);
const API_KEY     = String(process.env.API_KEY || 'dev-key-123');

// Optional holder gate (leave empty to disable)
const EVM_RPC_URL          = String(process.env.EVM_RPC_URL || '');
const CHAIN_ID             = Number(process.env.CHAIN_ID || 369);
const HOLDER_TOKEN_ADDRESS = String(process.env.HOLDER_TOKEN_ADDRESS || '');
const HOLDER_MIN_UNITS     = BigInt(String(process.env.HOLDER_MIN_UNITS || '0'));

// Telegram app creds from https://my.telegram.org/apps
const TG_API_ID   = Number(process.env.TG_API_ID || 0);
const TG_API_HASH = String(process.env.TG_API_HASH || '');

// ---------- Holder gate helper (optional) ----------
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
async function holderGateByWallet(addressToCheck: string) {
  if (!HOLDER_TOKEN_ADDRESS) return true;
  const provider = new ethers.JsonRpcProvider(EVM_RPC_URL, { chainId: CHAIN_ID, name: `chain-${CHAIN_ID}` });
  const token = new ethers.Contract(HOLDER_TOKEN_ADDRESS, ERC20_ABI, provider);
  const bal: bigint = await token.balanceOf(addressToCheck);
  return bal >= HOLDER_MIN_UNITS;
}

// ---------- Express setup ----------
const app = express();
app.use(cors({ origin: '*', allowedHeaders: ['Content-Type', 'x-api-key'] }));
app.use(bodyParser.json());

// Open endpoints (no API key)
const OPEN_PATHS = new Set<string>(['/health', '/tg-session', '/api/tg/sendCode', '/api/tg/signIn']);
app.use((req: Request, res: Response, next: NextFunction) => {
  if (OPEN_PATHS.has(req.path)) return next();
  const key = String((req.headers['x-api-key'] as string) || (req.query.api_key as string) || '');
  if (!key || key !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
  return next();
});

// ---------- Health ----------
app.get('/health', (_req, res) => res.json({ ok: true }));

// ===================================================================
//                    TG_SESSION via phone code (no QR)
//  Keeps the SAME TelegramClient alive between SendCode & SignIn
// ===================================================================
type LoginState = {
  client: TelegramClient;
  phone: string;
  phoneCodeHash?: string;
  createdAt: number;
  stage: 'codeSent' | 'done';
};

const STATES = new Map<string, LoginState>();
const STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function gcStates() {
  const now = Date.now();
  for (const [id, st] of STATES) {
    if (now - st.createdAt > STATE_TTL_MS || st.stage === 'done') {
      try { st.client.disconnect(); } catch {}
      STATES.delete(id);
    }
  }
}
const rid = () => Math.random().toString(36).slice(2, 10);

// TG web page
app.get('/tg-session', (_req: Request, res: Response) => {
  const warn = (!TG_API_ID || !TG_API_HASH)
    ? `<div style="padding:10px;background:#fff3cd;border:1px solid #ffeeba;border-radius:8px;margin-bottom:12px">
         <b>Missing TG_API_ID / TG_API_HASH</b> — set them in Railway → Variables, then reload this page.
       </div>` : '';
  res.type('html').send(`<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Generate TG_SESSION (Phone Code)</title>
<style>
  body{font-family:system-ui,Segoe UI,Arial;margin:20px;max-width:720px}
  input{width:100%;padding:.6rem;margin:.25rem 0 .6rem;border:1px solid #ddd;border-radius:8px}
  button{padding:.6rem 1rem;border:1px solid #222;border-radius:10px;background:#222;color:#fff;cursor:pointer}
  pre{white-space:pre-wrap;background:#f5f5f7;padding:10px;border-radius:8px;border:1px solid #eee}
  .row{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end}
</style>
<h2>Generate <code>TG_SESSION</code> via phone code</h2>
${warn}
<ol>
  <li>Enter your phone (e.g. <b>+447...</b>) → <b>Send Code</b>.</li>
  <li>Enter the code (and 2FA password if set) → <b>Sign In</b>.</li>
  <li>Copy the <b>TG_SESSION</b> and put it in the Userbot service env.</li>
</ol>
<div class=row>
  <div><label>Phone</label><input id=phone placeholder="+447..."/></div>
  <div><button id=send>Send Code</button></div>
</div>
<div id=codebox style="display:none">
  <label>Code (5-6 digits)</label><input id=code placeholder="12345"/>
  <label>2FA Password (if enabled)</label><input id=pw type=password placeholder="••••••"/>
  <button id=signin>Sign In</button>
</div>
<h3>Session</h3><pre id=out>(waiting…)</pre>
<script>
let id=''; const $=(i)=>document.getElementById(i);
$('send').onclick=async()=>{
  $('out').textContent='(requesting code…)';
  const r=await fetch('/api/tg/sendCode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:$('phone').value})});
  const d=await r.json(); if(d.error){$('out').textContent='Error: '+d.error;return;}
  id=d.id; $('codebox').style.display='block'; $('out').textContent='Code sent. Enter it then press Sign In.';
};
$('signin').onclick=async()=>{
  $('out').textContent='(signing in…)';
  const r=await fetch('/api/tg/signIn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,code:$('code').value,password:$('pw').value})});
  const d=await r.json(); if(d.error){$('out').textContent='Error: '+d.error;return;}
  $('out').textContent=d.session || '(no session returned)';
};
</script>`);
});

// Send code — creates & keeps client
app.post('/api/tg/sendCode', async (req: Request, res: Response) => {
  try {
    if (!TG_API_ID || !TG_API_HASH) return res.status(400).json({ error: 'TG_API_ID/HASH not set' });
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone required' });

    gcStates();

    const client = new TelegramClient(new StringSession(''), TG_API_ID, TG_API_HASH, { connectionRetries: 5 });
    await client.connect();

    const result: any = await client.invoke(new Api.auth.SendCode({
      phoneNumber: String(phone),
      apiId: TG_API_ID,
      apiHash: TG_API_HASH,
      settings: new Api.CodeSettings({})
    }));

    const id = rid();
    STATES.set(id, { client, phone: String(phone), phoneCodeHash: String(result.phoneCodeHash), createdAt: Date.now(), stage: 'codeSent' });
    res.json({ id, sent: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Sign in — reuses same client
app.post('/api/tg/signIn', async (req: Request, res: Response) => {
  try {
    const { id, code, password } = req.body || {};
    if (!id || !code) return res.status(400).json({ error: 'id and code required' });

    const state = STATES.get(String(id));
    if (!state) return res.status(410).json({ error: 'state expired; click Send Code again' });
    if (state.stage !== 'codeSent') return res.status(409).json({ error: 'invalid state' });

    const client = state.client;
    try {
      await client.invoke(new Api.auth.SignIn({
        phoneNumber: state.phone,
        phoneCodeHash: String(state.phoneCodeHash || ''),
        phoneCode: String(code)
      }));
    } catch (err: any) {
      const msg = String(err?.message || '');
      if (msg.includes('SESSION_PASSWORD_NEEDED')) {
        if (!password) return res.status(401).json({ error: '2FA enabled: supply password' });
        await (client as any).checkPassword(String(password));
      } else {
        throw err;
      }
    }

    const session = client.session.save();
    state.stage = 'done';
    try { await client.disconnect(); } catch {}
    STATES.delete(String(id));
    res.json({ session });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ===================================================================
//                           REST API
// ===================================================================

// make sure a user row exists for this API_KEY
async function ensureDefaultUser() {
  await prisma.user.upsert({
    where: { apiKey: API_KEY },
    update: {},
    create: { apiKey: API_KEY },
  });
}

// Wallets
app.post('/wallets', async (req: Request, res: Response) => {
  try {
    await ensureDefaultUser();
    const { address, chainId = CHAIN_ID, label } = req.body || {};
    if (!address) return res.status(400).json({ error: 'address required' });

    if (!(await holderGateByWallet(address))) {
      return res.status(402).json({ error: 'holder requirement not met' });
    }

    const user = await prisma.user.findUnique({ where: { apiKey: API_KEY } });
    const w = await prisma.wallet.create({ data: { userId: user!.id, address, chainId, label } });
    res.json(w);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Profiles
app.post('/profiles', async (req: Request, res: Response) => {
  try {
    const { walletId, amountNative, slippageBps, denyWords, keywords, router, wrappedNative, feeBps, treasury, dryRun } = req.body || {};
    if (!walletId || amountNative == null || !slippageBps || !router || !wrappedNative) {
      return res.status(400).json({ error: 'walletId, amountNative, slippageBps, router, wrappedNative required' });
    }
    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet) return res.status(404).json({ error: 'wallet not found' });
    if (!(await holderGateByWallet(wallet.address))) return res.status(402).json({ error: 'holder requirement not met' });

    const p = await prisma.buyProfile.create({
      data: {
        userId: wallet.userId,
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
        dryRun: !!dryRun
      }
    });
    res.json(p);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Channels
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

app.get('/channels/list', async (_req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { apiKey: API_KEY } });
    const list = await prisma.channel.findMany({ where: { userId: user?.id } });
    res.json(list);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

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

// ---------- Boot ----------
app.listen(PORT, () => console.log(`[core] API up on :${PORT}`));
