'use strict';

const { Pool, Client } = require('pg');
const Stripe = require('stripe');

const SKU = 'VR-001';
const PRODUCT_NAME = 'VR-001 Officer Leather Jacket — Olive';
const AMOUNT_CENTS = 42000;
const CURRENCY = 'usd';
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const SHIP_COUNTRIES = [
  'US','CA','GB','IE','AU','NZ','FR','DE','IT','ES','NL','BE','AT','CH','SE','NO',
  'DK','FI','PT','PL','CZ','HU','RO','GR','LU','MX','JP','KR','SG','HK','TW','AE'
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_session_id text UNIQUE NOT NULL,
  stripe_payment_intent_id text,
  email text,
  size text,
  sku text,
  amount_cents integer,
  currency text,
  status text NOT NULL,
  shipping_name text,
  shipping_address jsonb,
  customer_details jsonb,
  email_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_email_idx ON orders (email);
`;

const allowedOrigin = (process.env.ALLOWED_ORIGIN || process.env.PUBLIC_BASE_URL || 'https://vanreuben.onrender.com').replace(/\/$/, '');

function corsHeaders(request) {
  const origin = request.headers.get('origin') || '';
  const allow = origin === allowedOrigin || origin === 'https://vanreuben.onrender.com' ? origin : allowedOrigin;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

function liveStripeKey() {
  const key = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) return null;
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_') || key.startsWith('pk_')) {
    console.error('checkout disabled: STRIPE_SECRET_KEY is not a live secret key');
    return null;
  }
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return key;
  console.error('checkout disabled: STRIPE_SECRET_KEY is not a recognized live key');
  return null;
}

function stripeClient() {
  const key = liveStripeKey();
  return key ? new Stripe(key) : null;
}

function publicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || 'https://vanreuben.onrender.com').replace(/\/$/, '');
}

let pool = null;
let migrated = false;

function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  pool = new Pool({ connectionString: url, max: 5, ssl: { rejectUnauthorized: true } });
  pool.on('error', (err) => console.error('pg pool', err.message));
  return pool;
}

async function migrate() {
  if (migrated) return;
  const url = process.env.DATABASE_URL_UNPOOLED || (process.env.DATABASE_URL || '').replace('-pooler.', '.');
  if (!url) return;
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: true } });
  await client.connect();
  try {
    await client.query(SCHEMA);
    migrated = true;
  } finally {
    await client.end();
  }
}

async function handleCheckout(request) {
  const stripe = stripeClient();
  if (!stripe) return json(request, { error: 'Ordering is not yet available' }, 503);
  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const size = String(body.size || '').trim().toUpperCase();
  if (!SIZES.includes(size)) return json(request, { error: 'Select a size first' }, 400);
  const base = publicBaseUrl();
  const priceId = (process.env.STRIPE_PRICE_ID || '').trim();
  const lineItem = priceId
    ? { price: priceId, quantity: 1 }
    : {
        price_data: {
          currency: CURRENCY,
          unit_amount: AMOUNT_CENTS,
          product_data: { name: PRODUCT_NAME, description: `Size ${size}` },
        },
        quantity: 1,
      };
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [lineItem],
      success_url: `${base}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/cancel.html`,
      shipping_address_collection: { allowed_countries: SHIP_COUNTRIES },
      billing_address_collection: 'required',
      metadata: { sku: SKU, size, product: PRODUCT_NAME },
      payment_intent_data: {
        metadata: { sku: SKU, size },
        description: `${PRODUCT_NAME}, size ${size}`,
      },
    });
    if (!session.livemode || !session.url) {
      console.error('refusing a non-live or URL-less checkout session');
      return json(request, { error: 'Ordering is not yet available' }, 503);
    }
    return json(request, { url: session.url });
  } catch (err) {
    console.error('checkout session failed', err.message);
    return json(request, { error: 'Could not start checkout' }, 500);
  }
}

function formatAddress(addr) {
  if (!addr) return '';
  return [addr.line1, addr.line2, [addr.city, addr.state, addr.postal_code].filter(Boolean).join(' '), addr.country]
    .filter(Boolean)
    .join('\n');
}

async function sendConfirmation({ email, size, sku, amount, currency, shippingName, shippingAddress }) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  const from = (process.env.RESEND_FROM || '').trim();
  if (!apiKey || !from || !email) return false;
  const dollars = ((amount || AMOUNT_CENTS) / 100).toFixed(2);
  const cur = (currency || CURRENCY).toUpperCase();
  const addr = formatAddress(shippingAddress);
  const text = [
    'Thank you for your Van Reuben order.',
    '',
    PRODUCT_NAME,
    `Size: ${size || '—'}`,
    `SKU: ${sku || SKU}`,
    `Amount: $${dollars} ${cur}`,
    shippingName ? `Ship to: ${shippingName}` : '',
    addr,
    '',
    'We will be in touch when your jacket ships.',
  ].filter(Boolean).join('\n');
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [email], subject: `Order confirmed — ${SKU}`, text }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error('resend failed', resp.status, body.slice(0, 300));
    return false;
  }
  return true;
}

async function fulfillCheckoutSession(stripe, session) {
  if (!session || session.payment_status !== 'paid') return;
  const full = await stripe.checkout.sessions.retrieve(session.id, { expand: ['payment_intent'] });
  if (!full.livemode || full.payment_status !== 'paid') return;
  const size = (full.metadata && full.metadata.size) || null;
  const sku = (full.metadata && full.metadata.sku) || SKU;
  const email = (full.customer_details && full.customer_details.email) || full.customer_email || null;
  const shipping = (full.collected_information && full.collected_information.shipping_details)
    ? full.collected_information.shipping_details
    : full.shipping_details || null;
  const paymentIntentId = typeof full.payment_intent === 'string'
    ? full.payment_intent
    : full.payment_intent && full.payment_intent.id;
  const amount = full.amount_total != null ? full.amount_total : AMOUNT_CENTS;
  const currency = (full.currency || CURRENCY).toLowerCase();
  const shippingName = shipping && shipping.name ? shipping.name : (full.customer_details && full.customer_details.name) || null;
  const shippingAddress = shipping && shipping.address ? shipping.address : null;
  const db = getPool();
  if (db) {
    await db.query(
      `INSERT INTO orders (
         stripe_session_id, stripe_payment_intent_id, email, size, sku,
         amount_cents, currency, status, shipping_name, shipping_address,
         customer_details
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (stripe_session_id) DO UPDATE SET
         stripe_payment_intent_id = COALESCE(EXCLUDED.stripe_payment_intent_id, orders.stripe_payment_intent_id),
         email = COALESCE(EXCLUDED.email, orders.email),
         status = EXCLUDED.status,
         updated_at = now()`,
      [
        full.id, paymentIntentId || null, email, size, sku, amount, currency, 'paid',
        shippingName, shippingAddress ? JSON.stringify(shippingAddress) : null,
        full.customer_details ? JSON.stringify(full.customer_details) : null,
      ]
    );
    const already = await db.query('SELECT email_sent_at FROM orders WHERE stripe_session_id = $1', [full.id]);
    if (already.rows[0] && already.rows[0].email_sent_at) return;
  }
  const sent = await sendConfirmation({ email, size, sku, amount, currency, shippingName, shippingAddress, sessionId: full.id });
  if (sent && db) {
    await db.query(
      'UPDATE orders SET email_sent_at = now(), updated_at = now() WHERE stripe_session_id = $1 AND email_sent_at IS NULL',
      [full.id]
    );
  }
}

async function handleWebhook(request) {
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  const stripe = stripeClient();
  if (!stripe || !secret) return new Response('Webhook is not configured', { status: 503 });
  const sig = request.headers.get('stripe-signature');
  const raw = await request.text();
  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    console.error('webhook signature failed', err.message);
    return new Response('Invalid signature', { status: 400 });
  }
  if (!event.livemode) {
    console.error('ignored non-live Stripe event', event.type, event.id);
    return new Response('Live events only', { status: 400 });
  }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    await fulfillCheckoutSession(stripe, event.data.object);
  }
  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function handle(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  try { await migrate(); } catch (err) { console.error('migrate failed', err.message); }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';

  if (request.method === 'GET' && (path === '/health' || path === '/')) {
    if (path === '/health') return json(request, { ok: true });
  }
  if (request.method === 'GET' && path === '/api/checkout-status') {
    return json(request, {
      available: Boolean(liveStripeKey()),
      currency: CURRENCY.toUpperCase(),
      amountCents: AMOUNT_CENTS,
      sku: SKU,
      name: PRODUCT_NAME,
    });
  }
  if (request.method === 'POST' && path === '/checkout') return handleCheckout(request);
  if (request.method === 'POST' && path === '/webhook/stripe') return handleWebhook(request);

  return new Response('Not found', { status: 404, headers: corsHeaders(request) });
}

module.exports = {
  fetch: handle,
};
