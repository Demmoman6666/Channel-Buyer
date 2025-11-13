import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';
import { ensureDefaultUser, prisma } from './db';
import { env } from './env';
import { ethers } from 'ethers';
import { tradeForChannelSlug } from './trade/pulsex';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Buffer } from 'buffer';

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

  // -----------------------------
  // Auth (header OR ?api_key=),
  // with allowlist for TG session helper routes (code + QR)
  // -----------------------------
  const OPEN_PATHS = new Set<string>([
    '/tg-session',
    '/api/tg/sendCode',
    '/api/tg/signIn',
    '/tg-session-qr',
    '/api/tg/qr/start',
    '/api/tg/qr/poll',
  ]);

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (OPEN_PATHS.has(req.path)) return next();

    const key = String((req.headers['x-api-key'] as string) || (req.query.api_key as string) || '');
    if (!key || key !== env.API_KEY) return res.status(401).json({ error: 'unauthorized' });

    const user = await prisma.user.findUnique({ where: { apiKey: env.API_KEY } });
    (req as any).user = user;
    next();
  });

  // -----------------------------
  // Wallet & Profiles
  // -----------------------------
  app.post('/wallets', async (req: Request, res: Response) => {
    const user = (req as any).user;
    const { address, chainId = env.CHAIN_ID, label } = req.body || {};
    if (!address) return res.status(400).json({ error: 'address required' });
    if (!(await holderGateByWallet(address))) return res.status(402).json({ error: 'holder requirement not met' });
    const w = await prisma.wallet.create({ data: { userId: user.id, address, chainId, label } });
    res.json(w);
  });

  app.post('/profiles', async (req: Request, res: Response) => {
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
        feeBps: feeBps ?? 100, // 1% fee default
        treasury: treasury || process.env.TREASURY_ADDRESS || null,
        dryRun: dryRun ?? true
      }
    });
    res.json(p);
  });

  // -----------------------------
  // Channels
  // -----------------------------
  app.post('/channels', async (req: Request, res: Response) => {
    const user = (req as any).user;
    const { slug, mode, buyProfileId } = req.body || {};
    if (!slug || !buyProfileId) return res.status(400).json({ error: 'slug and buyProfileId required' });
    if (String(mode).toUpperCase() !== 'MTPROTO') return res.status(400).json({ error: 'only MTPROTO supported' });

    const p = await prisma.buyProfile.findUnique({ where: { id: buyProfileId }, include: { wallet: true } });
    if (!p || p.userId !== user.id) return res.status(404).json({ error: 'profile not found' });
    if (!(await holderGateByWallet(p.wallet.address))) return res.status(402).json({ error: 'holder requirement not met' });

    const existing = await prisma.channel.findFirst({ where: { userId: user.id, slug: slug.toLowerCase() } });
    const ch = existing
      ? await prisma.channel.update({ where: { id: existing.id }, data: { buyProfileId: p.id, active: true } })
      : await prisma.channel.create({ data: { userId: user.id, slug: slug.toLowerCase(), mode: 'MTPROTO', buyProfileId: p.id } });
    res.json(ch);
  });

  app.get('/channels/list', async (req: Request, res: Response) => {
    const user = (req as any).user;
    const list = await prisma.channel.findMany({ where: { userId: user.id } });
    res.json(list);
  });

  app.post('/channels/toggleBySlug', async (req: Request, res: Response) => {
    const user = (req as any).user;
    const { slug, active } = req.body || {};
    if (!slug) return res.status(400).json({ error: 'slug required' });
    const ch = await prisma.channel.findFirst({ where: { userId: user.id, slug: slug.toLowerCase() } });
    if (!ch) return res.status(404).json({ error: 'not found' });
    const updated = await prisma.channel.update({ where: { id: ch.id }, data: { active: !!active } });
    res.json(updated);
  });

  // -----------------------------
  // Profile dry-run toggle & status
  // -----------------------------
  app.post('/profiles/:id/dryrun', async (req: Request, res: Response) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const { toggle, dryRun } = req.body || {};
    const p = await prisma.buyProfile.findUnique({ where: { id }, include: { wallet: true } });
    if (!p || p.userId !== user.id) return res.status(404).json({ error: 'profile not found' });
    const next = toggle ? !p.dryRun : !!dryRun;
    const up = await prisma.buyProfile.update({ where: { id }, data: { dryRun: next } });
    res.json({ dryRun: up.dryRun });
  });

  app.get('/profiles/:id/status', async (req: Request, res: Response) => {
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

  // -----------------------------
  // Manual trade trigger (used by userbot/control when a CA is seen)
  // -----------------------------
  app.post('/trade/execute', async (req: Request, res: Response) => {
    const user = (req as any).user;
    const { slug, token } = req.body || {};
    if (!slug || !token) return res.status(400).json({ error: 'slug and token required' });
    const ch = await prisma.channel.findFirst({ where: { userId: user.id, slug: slug.toLowerCase(), active: true } });
    if (!ch) return res.status(404).json({ error: 'channel not found or inactive' });
    const result = await tradeForChannelSlug(slug, token);
    res.json({ result });
  });

  // ======================================================
  // TG SESSION WEB FLOW — CODE (kept for completeness)
  // ======================================================
  app.get('/tg-session', (_req: Request, res: Response) => {
    res.type('html').send(`
<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>TG Session</title>
<style>body{font-family:system-ui,Arial;margin:20px;max-width:760px}label{display:block;margin:.6rem 0 .2rem}input{width:100%;padding:.5rem}button{margin-top:.8rem;padding:.6rem 1rem}pre{white-space:pre-wrap;background:#f5f5f7;padding:10px;border-radius:8px}</style>
<h2>Generate Telegram TG_SESSION</h2>
<label>Phone (e.g. +447...)</label><input id=phone placeholder="+447..." />
<button id=send>Send Code</button>
<div id=codeArea style="display:none">
  <label>Code (5 digits)</label><input id=code placeholder="12345" />
  <label>2FA Password (if enabled)</label><input id=pw placeholder="••••••" type=password />
  <button id=signin>Sign In</button>
</div>
<h3>Session</h3>
<pre id=out>(will appear here)</pre>
<script>
let phoneCodeHash = '';
const get = (id)=>document.getElementById(id);
get('send').onclick = async ()=>{
  const r = await fetch('/api/tg/sendCode?api_key=${env.API_KEY}', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:get('phone').value})});
  const d = await r.json();
  if(d.error){get('out').textContent='Error: '+d.error; return;}
  phoneCodeHash = d.phoneCodeHash;
  get('codeArea').style.display='block';
  get('out').textContent='Code sent. Check Telegram.';
};
get('signin').onclick = async ()=>{
  const r = await fetch('/api/tg/signIn?api_key=${env.API_KEY}', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    phone:get('phone').value, code:get('code').value, phoneCodeHash, password:get('pw').value
  })});
  const d = await r.json();
  if(d.error){get('out').textContent='Error: '+d.error; return;}
  get('out').textContent=d.session || '(no session returned)';
};
</script>`);
  });

  app.post('/api/tg/sendCode', async (req: Request, res: Response) => {
    try {
      const { phone } = req.body || {};
      if (!phone) return res.status(400).json({ error: 'phone required' });
      const apiId = Number(process.env.TG_API_ID || 0);
      const apiHash = String(process.env.TG_API_HASH || '');
      if (!apiId || !apiHash) return res.status(500).json({ error: 'TG_API_ID/HASH not set on Core' });

      const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
      await client.connect();
      const result = await client.invoke(new Api.auth.SendCode({
        phoneNumber: phone,
        apiId,
        apiHash,
        settings: new Api.CodeSettings({})
      }));
      await client.disconnect();
      res.json({ phoneCodeHash: (result as any).phoneCodeHash });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.post('/api/tg/signIn', async (req: Request, res: Response) => {
    try {
      const { phone, code, phoneCodeHash, password } = req.body || {};
      const apiId = Number(process.env.TG_API_ID || 0);
      const apiHash = String(process.env.TG_API_HASH || '');
      if (!apiId || !apiHash) return res.status(500).json({ error: 'TG_API_ID/HASH not set on Core' });

      const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
      await client.connect();
      try {
        await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }));
      } catch (err: any) {
        if (String(err?.message || '').includes('SESSION_PASSWORD_NEEDED')) {
          if (!password) throw new Error('2FA enabled: supply password');
          await (client as any).checkPassword(password); // helper exists; types don’t declare it
        } else {
          throw err;
        }
      }
      const session = client.session.save();
      await client.disconnect();
      res.json({ session });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ======================================================
  // TG SESSION via QR (no codes)
  // ======================================================

  type QrState = {
    client: TelegramClient;
    token: Uint8Array;
    createdAt: number;
  };
  const QR_STORE = new Map<string, QrState>();
  const QR_TTL_MS = 2 * 60 * 1000; // 2 minutes

  function b64url(u8: Uint8Array) {
    return Buffer.from(u8).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // HTML page for QR login
  app.get('/tg-session-qr', (_req: Request, res: Response) => {
    res.type('html').send(`
<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>TG Session (QR)</title>
<style>
  body{font-family:system-ui,Arial;margin:20px;max-width:740px}
  button{padding:.6rem 1rem}
  #qrbox{margin-top:12px;display:none}
  #qrbox img{width:240px;height:240px;border:1px solid #ddd;border-radius:8px}
  pre{white-space:pre-wrap;background:#f5f5f7;padding:10px;border-radius:8px}
</style>
<h2>Generate Telegram TG_SESSION (QR login)</h2>
<ol>
  <li>Click <b>Start QR</b>. A QR appears.</li>
  <li>In Telegram: <b>Settings → Devices → Link Desktop Device</b> and scan.</li>
  <li>When linked, your <b>TG_SESSION</b> appears below — copy it into Railway (Userbot).</li>
</ol>
<button id=start>Start QR</button>
<div id=qrbox><p>Scan with Telegram → Devices:</p><img id=qr src=""><p><a id=deeplink href="#" target="_blank">Open in Telegram</a></p></div>
<h3>Session</h3>
<pre id=out>(waiting…)</pre>
<script>
let id='';
const get=(x)=>document.getElementById(x);
get('start').onclick = async ()=>{
  get('out').textContent='(waiting…)';
  const r = await fetch('/api/tg/qr/start');
  const d = await r.json();
  if(d.error){ get('out').textContent='Error: '+d.error; return; }
  id = d.id;
  const url = d.deeplink; // tg://login?token=...
  get('qr').src = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data='+encodeURIComponent(url);
  get('deeplink').href = url;
  get('qrbox').style.display='block';
  poll();
};

async function poll(){
  const r = await fetch('/api/tg/qr/poll', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id }) });
  const d = await r.json();
  if(d.error){ get('out').textContent='Error: '+d.error; return; }
  if(d.session){
    get('out').textContent = d.session;
    return;
  }
  if(d.status==='EXPIRED'){ get('out').textContent='QR expired. Click "Start QR" again.'; return; }
  setTimeout(poll, 2000);
}
</script>`);
  });

  // Start QR login — returns a deep link token
  app.get('/api/tg/qr/start', async (_req: Request, res: Response) => {
    try {
      const apiId = Number(process.env.TG_API_ID || 0);
      const apiHash = String(process.env.TG_API_HASH || '');
      if (!apiId || !apiHash) return res.status(500).json({ error: 'TG_API_ID/HASH not set' });

      const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
      await client.connect();

      const exported: any = await client.invoke(new Api.auth.ExportLoginToken({ apiId, apiHash, exceptIds: [] }));
      if (!exported || !exported.token) { await client.disconnect(); return res.status(500).json({ error: 'Failed to export login token' }); }

      const id = Math.random().toString(36).slice(2);
      QR_STORE.set(id, { client, token: exported.token as Uint8Array, createdAt: Date.now() });

      const deeplink = 'tg://login?token=' + b64url(exported.token);
      res.json({ id, deeplink, expiresInSec: 120 });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Poll QR — once scanned/confirmed, returns TG_SESSION
  app.post('/api/tg/qr/poll', async (req: Request, res: Response) => {
    try {
      const { id } = req.body || {};
      const state = QR_STORE.get(String(id));
      if (!state) return res.json({ status: 'EXPIRED' });

      if (Date.now() - state.createdAt > QR_TTL_MS) {
        try { await state.client.disconnect(); } catch {}
        QR_STORE.delete(String(id));
        return res.json({ status: 'EXPIRED' });
      }

      const result: any = await state.client.invoke(new Api.auth.ImportLoginToken({ token: state.token }));

      if (result && result.className === 'auth.loginTokenMigrateTo') {
        try { await state.client.disconnect(); } catch {}
        QR_STORE.delete(String(id));
        return res.json({ status: 'EXPIRED', note: 'DC migrate; start QR again' });
      }

      if (result && result.className === 'auth.loginTokenSuccess') {
        const session = state.client.session.save();
        try { await state.client.disconnect(); } catch {}
        QR_STORE.delete(String(id));
        return res.json({ session });
      }

      return res.json({ status: 'WAITING' });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // -----------------------------
  // Boot
  // -----------------------------
  app.listen(env.PORT, () => console.log(`API up on :${env.PORT}`));
})();
