import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';
import { ethers } from 'ethers';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';

// =============== BASIC ENV (only what we need here) ===============
const PORT = Number(process.env.API_PORT || process.env.PORT || 3000);
const API_KEY = String(process.env.API_KEY || 'dev-key-123');

// Optional holder gate bits (noop for now, kept for compatibility)
const EVM_RPC_URL = String(process.env.EVM_RPC_URL || '');
const CHAIN_ID = Number(process.env.CHAIN_ID || 369);
const HOLDER_TOKEN_ADDRESS = String(process.env.HOLDER_TOKEN_ADDRESS || '');
const HOLDER_MIN_UNITS = BigInt(String(process.env.HOLDER_MIN_UNITS || '0'));

// Required for Telegram App (from https://my.telegram.org/apps)
const TG_API_ID = Number(process.env.TG_API_ID || 0);
const TG_API_HASH = String(process.env.TG_API_HASH || '');
if (!TG_API_ID || !TG_API_HASH) {
  // We keep it non-fatal; the /tg-session page will warn if missing.
  console.warn('[server] Missing TG_API_ID / TG_API_HASH (set them in Railway → Variables).');
}

// =============== OPTIONAL ERC20 GATE (not used in login flow) ===============
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
async function holderGateByWallet(addressToCheck: string) {
  if (!HOLDER_TOKEN_ADDRESS) return true;
  const provider = new ethers.JsonRpcProvider(EVM_RPC_URL, { chainId: CHAIN_ID, name: `chain-${CHAIN_ID}` });
  const token = new ethers.Contract(HOLDER_TOKEN_ADDRESS, ERC20_ABI, provider);
  const bal: bigint = await token.balanceOf(addressToCheck);
  return bal >= HOLDER_MIN_UNITS;
}

// ===================================================================
//                              APP
// ===================================================================
const app = express();
app.use(bodyParser.json());

// Public endpoints (no API key) — only the TG session helpers & page
const OPEN_PATHS = new Set<string>([
  '/tg-session',
  '/api/tg/start',
  '/api/tg/sendCode',
  '/api/tg/signIn'
]);

app.use(async (req: Request, res: Response, next: NextFunction) => {
  if (OPEN_PATHS.has(req.path)) return next();
  const key = String((req.headers['x-api-key'] as string) || (req.query.api_key as string) || '');
  if (!key || key !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
  return next();
});

// ===================================================================
//                  MTProto PHONE-CODE LOGIN (NO QR)
//   **Keeps the SAME TelegramClient alive between steps**
//   Fixes the PHONE_CODE_EXPIRED issue you were seeing.
// ===================================================================
type LoginState = {
  client: TelegramClient;
  phone: string;
  phoneCodeHash?: string;
  createdAt: number;
  stage: 'codeSent' | 'done';
};

const STATES = new Map<string, LoginState>();
const STATE_TTL_MS = 5 * 60 * 1000; // keep for 5 minutes

function gcStates() {
  const now = Date.now();
  for (const [id, st] of STATES) {
    if (now - st.createdAt > STATE_TTL_MS || st.stage === 'done') {
      try { st.client.disconnect(); } catch {}
      STATES.delete(id);
    }
  }
}

// Small helper to make random IDs
function rid() {
  return Math.random().toString(36).slice(2, 10);
}

// ---- HTML page (no auth) ----
app.get('/tg-session', (_req: Request, res: Response) => {
  const warn = (!TG_API_ID || !TG_API_HASH)
    ? `<div style="padding:10px;background:#fff3cd;border:1px solid #ffeeba;border-radius:8px;margin-bottom:12px">
         <b>Missing TG_API_ID / TG_API_HASH</b> — set them in Railway → Variables, then reload this page.
       </div>`
    : '';

  res.type('html').send(`
<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Generate TG_SESSION (Phone Code)</title>
<style>
  body{font-family:system-ui,Segoe UI,Arial;margin:20px;max-width:720px}
  input{width:100%;padding:.6rem;margin:.25rem 0 .6rem;border:1px solid #ddd;border-radius:8px}
  button{padding:.6rem 1rem;border:1px solid #222;border-radius:10px;background:#222;color:#fff;cursor:pointer}
  button:disabled{opacity:.6;cursor:not-allowed}
  pre{white-space:pre-wrap;background:#f5f5f7;padding:10px;border-radius:8px;border:1px solid #eee}
  .row{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end}
</style>
<h2>Generate <code>TG_SESSION</code> via phone code</h2>
${warn}
<ol>
  <li>Enter your phone (international format, e.g. <b>+447...</b>), press <b>Send Code</b>.</li>
  <li>When the code arrives (SMS/Telegram), enter it (and 2FA password if set), press <b>Sign In</b>.</li>
  <li>Copy the <b>TG_SESSION</b> shown below into your Userbot service's <code>TG_SESSION</code> env var.</li>
</ol>

<div class=row>
  <div>
    <label>Phone</label>
    <input id=phone placeholder="+447..." />
  </div>
  <div><button id=send>Send Code</button></div>
</div>

<div id=codebox style="display:none">
  <label>Code (5-6 digits)</label>
  <input id=code placeholder="12345" />
  <label>2FA Password (if enabled)</label>
  <input id=pw type=password placeholder="••••••" />
  <button id=signin>Sign In</button>
</div>

<h3>Session</h3>
<pre id=out>(waiting…)</pre>

<script>
let id = '';
const $ = (i)=>document.getElementById(i);
$('send').onclick = async ()=>{
  $('out').textContent = '(requesting code…)';
  const r = await fetch('/api/tg/sendCode', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:$('phone').value})});
  const d = await r.json();
  if(d.error){ $('out').textContent = 'Error: '+d.error; return; }
  id = d.id;
  $('codebox').style.display = 'block';
  $('out').textContent = 'Code sent. Check your phone, then enter it and press Sign In.';
};

$('signin').onclick = async ()=>{
  $('out').textContent = '(signing in…)';
  const r = await fetch('/api/tg/signIn', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    id, code:$('code').value, password:$('pw').value
  })});
  const d = await r.json();
  if(d.error){ $('out').textContent = 'Error: '+d.error; return; }
  $('out').textContent = d.session || '(no session returned)';
};
</script>
`);
});

// ---- Send Code (creates & keeps the SAME client) ----
app.post('/api/tg/sendCode', async (req: Request, res: Response) => {
  try {
    if (!TG_API_ID || !TG_API_HASH) return res.status(400).json({ error: 'TG_API_ID/HASH not set' });
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone required' });

    gcStates();

    // NEW client (kept alive in memory for this id)
    const client = new TelegramClient(new StringSession(''), TG_API_ID, TG_API_HASH, { connectionRetries: 5 });
    await client.connect();

    const result: any = await client.invoke(new Api.auth.SendCode({
      phoneNumber: String(phone),
      apiId: TG_API_ID,
      apiHash: TG_API_HASH,
      settings: new Api.CodeSettings({})
    }));

    const id = rid();
    STATES.set(id, {
      client,
      phone: String(phone),
      phoneCodeHash: String(result.phoneCodeHash),
      createdAt: Date.now(),
      stage: 'codeSent'
    });

    res.json({ id, sent: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---- Sign In (uses the SAME client we stored) ----
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
        if (!password) {
          return res.status(401).json({ error: '2FA enabled: supply password' });
        }
        // TS types don’t declare helper; call via any
        await (client as any).checkPassword(String(password));
      } else {
        throw err;
      }
    }

    // Success → save session
    const session = client.session.save();

    // mark done & cleanup
    state.stage = 'done';
    try { await client.disconnect(); } catch {}
    STATES.delete(String(id));

    res.json({ session });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ===================================================================
//                           BOOT
// ===================================================================
app.listen(PORT, () => console.log(`[core] API up on :${PORT}`));
