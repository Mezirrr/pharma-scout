import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

export const config = { api: { bodyParser: false } };

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verifySignature(message, signatureBase64, publicKeyPem) {
  try {
    const verifier = crypto.createVerify('SHA256');
    verifier.update(message);
    verifier.end();
    return verifier.verify(publicKeyPem, signatureBase64, 'base64');
  } catch (e) {
    console.error('Signature verification error:', e.message);
    return false;
  }
}

function currentPeriod() {
  return new Date().toISOString().slice(0, 7);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rawBody = await getRawBody(req);
  const timestamp = req.headers['x-boomfi-timestamp'];
  const signature = req.headers['x-boomfi-signature'];

  if (!timestamp || !signature) return res.status(400).json({ error: 'Missing signature headers' });

  const tsSeconds = parseInt(timestamp, 10);
  if (!Number.isFinite(tsSeconds) || Math.abs(Date.now() / 1000 - tsSeconds) > 300) {
    return res.status(400).json({ error: 'Stale or invalid timestamp' });
  }

  const publicKey = (process.env.BOOMFI_PUBLIC_KEY || '').replace(/\\n/g, '\n');
  const message = `${timestamp}.${rawBody}`;

  if (!publicKey || !verifySignature(message, signature, publicKey)) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  if (process.env.BOOMFI_ORG_ID && payload.org_id !== process.env.BOOMFI_ORG_ID) {
    return res.status(401).json({ error: 'Org ID mismatch' });
  }

  if (payload.event !== 'Payment.Updated' || payload.status !== 'Succeeded') {
    return res.status(200).json({ received: true, ignored: true });
  }

  const customerEmail = payload.customer?.email;
  const planReference = payload.plan?.reference;

  if (!customerEmail) return res.status(200).json({ received: true, ignored: true });

  // New tier mapping
  let tier = null;
  if (planReference === 'starter-sub') tier = 'Starter';
  else if (planReference === 'researcher-sub') tier = 'Researcher';
  else if (planReference === 'labrat-sub') tier = 'Lab Rat';

  if (!tier) {
    console.warn('Webhook plan reference did not match a known tier:', planReference);
    return res.status(200).json({ received: true, ignored: true });
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('email', customerEmail)
    .single();

  if (!profile) return res.status(200).json({ received: true, matched: false });

  await supabaseAdmin
    .from('profiles')
    .update({
      tier,
      assays_used_this_month: 0,
      usage_period: currentPeriod()
    })
    .eq('id', profile.id);

  return res.status(200).json({ received: true, matched: true, tier });
}
