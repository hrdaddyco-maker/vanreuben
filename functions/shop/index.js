'use strict';

const { Pool, Client } = require('pg');
const Stripe = require('stripe');
const {
  SKU,
  PRODUCT_NAME,
  formatAddress,
  formatOrderDate,
  formatAmount,
  sendFulfillmentEmail,
  escapeHtml,
  supplierAdminHtml,
} = require('../../lib/fulfillment');

const AMOUNT_CENTS = 42000;
const CURRENCY = 'usd';
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const SHIP_COUNTRIES = [
  'US','CA','GB','IE','AU','NZ','FR','DE','IT','ES','NL','BE','AT','CH','SE','NO',
  'DK','FI','PT','PL','CZ','HU','RO','GR','LU','MX','JP','KR','SG','HK','TW','AE'
];
const STATUSES = ['to_order', 'ordered', 'shipped'];

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
  fulfillment_status text NOT NULL DEFAULT 'to_order',
  fulfillment_email_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_email_idx ON orders (email);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_status text NOT NULL DEFAULT 'to_order';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_email_sent_at timestamptz;
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

function apiBaseUrl(request) {
  const env = (process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
  if (env) return env;
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) {
    const dummy = Buffer.alloc(left.length);
    require('crypto').timingSafeEqual(left, dummy);
    return false;
  }
  return require('crypto').timingSafeEqual(left, right);
}

function readAdminToken(request) {
  const url = new URL(request.url);
  const q = url.searchParams.get('token') || '';
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  return q || bearer;
}

function isAdmin(request) {
  const expected = (process.env.ADMIN_TOKEN || '').trim();
  if (!expected) return false;
  return timingSafeEqual(readAdminToken(request), expected);
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

async function fulfillCheckoutSession(stripe, session, request) {
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
  let orderId = null;
  let emailsAlreadySent = false;
  if (db) {
    const inserted = await db.query(
      `INSERT INTO orders (
         stripe_session_id, stripe_payment_intent_id, email, size, sku,
         amount_cents, currency, status, shipping_name, shipping_address,
         customer_details, fulfillment_status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'to_order')
       ON CONFLICT (stripe_session_id) DO UPDATE SET
         stripe_payment_intent_id = COALESCE(EXCLUDED.stripe_payment_intent_id, orders.stripe_payment_intent_id),
         email = COALESCE(EXCLUDED.email, orders.email),
         status = EXCLUDED.status,
         updated_at = now()
       RETURNING id, email_sent_at, fulfillment_email_sent_at, created_at`,
      [
        full.id, paymentIntentId || null, email, size, sku, amount, currency, 'paid',
        shippingName, shippingAddress ? JSON.stringify(shippingAddress) : null,
        full.customer_details ? JSON.stringify(full.customer_details) : null,
      ]
    );
    const row = inserted.rows[0] || {};
    orderId = row.id;
    emailsAlreadySent = !!(row.email_sent_at && row.fulfillment_email_sent_at);
    if (emailsAlreadySent) return;

    if (!row.email_sent_at) {
      const sent = await sendConfirmation({ email, size, sku, amount, currency, shippingName, shippingAddress });
      if (sent) {
        await db.query(
          'UPDATE orders SET email_sent_at = now(), updated_at = now() WHERE stripe_session_id = $1 AND email_sent_at IS NULL',
          [full.id]
        );
      }
    }
    if (!row.fulfillment_email_sent_at) {
      const sentFulfillment = await sendFulfillmentEmail({
        orderId,
        date: row.created_at || new Date(),
        size,
        sku,
        customerName: shippingName,
        customerEmail: email,
        shippingAddress,
        amountCents: amount,
        currency,
        adminBaseUrl: request ? apiBaseUrl(request) : '',
      });
      if (sentFulfillment) {
        await db.query(
          'UPDATE orders SET fulfillment_email_sent_at = now(), updated_at = now() WHERE stripe_session_id = $1 AND fulfillment_email_sent_at IS NULL',
          [full.id]
        );
      }
    }
    return;
  }

  await sendConfirmation({ email, size, sku, amount, currency, shippingName, shippingAddress });
  await sendFulfillmentEmail({
    orderId: full.id,
    date: new Date(),
    size,
    sku,
    customerName: shippingName,
    customerEmail: email,
    shippingAddress,
    amountCents: amount,
    currency,
    adminBaseUrl: request ? apiBaseUrl(request) : '',
  });
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
    await fulfillCheckoutSession(stripe, event.data.object, request);
  }
  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function adminPage(orders, token) {
  const q = `?token=${encodeURIComponent(token)}`;
  const rows = (orders || []).map((o) => {
    const addr = formatAddress(o.shipping_address) || '—';
    const next = o.fulfillment_status === 'to_order'
      ? [['ordered', 'Mark ordered'], ['shipped', 'Mark shipped']]
      : o.fulfillment_status === 'ordered'
        ? [['shipped', 'Mark shipped']]
        : [];
    const buttons = next.map(([status, label]) => (
      `<form method="post" action="/admin/orders/${escapeHtml(o.id)}/status${q}" style="display:inline">` +
      `<input type="hidden" name="status" value="${escapeHtml(status)}">` +
      `<button type="submit">${escapeHtml(label)}</button></form>`
    )).join(' ');
    return `<tr>
      <td>${escapeHtml(o.id)}</td>
      <td>${escapeHtml(formatOrderDate(o.created_at))}</td>
      <td>${escapeHtml(o.size || '—')}</td>
      <td>${escapeHtml(o.shipping_name || '—')}<br><span class="mut">${escapeHtml(o.email || '—')}</span></td>
      <td class="addr">${escapeHtml(addr)}</td>
      <td>${escapeHtml(formatAmount(o.amount_cents, o.currency))}</td>
      <td>${escapeHtml(o.fulfillment_status || 'to_order')}</td>
      <td>${buttons || '—'}</td>
    </tr>`;
  }).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Van Reuben orders</title>
<style>
  body{font-family:ui-monospace,Menlo,Consolas,monospace;background:#fff;color:#111;margin:24px;font-size:13px;}
  h1{font-size:16px;font-weight:600;margin:0 0 16px;}
  table{border-collapse:collapse;width:100%;}
  th,td{border-bottom:1px solid #e5e5e5;text-align:left;vertical-align:top;padding:10px 8px;}
  th{color:#666;font-weight:500;}
  .addr,.mut{white-space:pre-wrap;}
  .mut{color:#666;}
  button{font:inherit;background:#111;color:#fff;border:0;padding:6px 10px;cursor:pointer;}
  .empty{padding:24px 0;color:#666;}
  .supplier{margin:0 0 24px;padding:0 0 16px;border-bottom:1px solid #e5e5e5;}
  .supplier h2{font-size:13px;font-weight:600;margin:0 0 8px;}
  .supplier p{margin:0 0 8px;}
  .supplier a{color:#111;}
</style>
</head>
<body>
  <h1>Van Reuben orders</h1>
  ${supplierAdminHtml()}
  ${orders && orders.length ? `<table>
    <thead><tr>
      <th>Order</th><th>Date</th><th>Size</th><th>Customer</th>
      <th>Ship to</th><th>Paid</th><th>Fulfillment</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>` : '<p class="empty">No paid orders yet.</p>'}
</body>
</html>`;
}

async function handleAdminList(request) {
  if (!isAdmin(request)) return new Response('Unauthorized', { status: 401 });
  const db = getPool();
  const orders = db
    ? (await db.query(
      `SELECT id, email, size, sku, amount_cents, currency, shipping_name, shipping_address,
              fulfillment_status, created_at
       FROM orders
       ORDER BY created_at DESC
       LIMIT 200`
    )).rows
    : [];
  const html = adminPage(orders, readAdminToken(request));
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function readStatusFromRequest(request) {
  const ctype = (request.headers.get('content-type') || '').toLowerCase();
  if (ctype.includes('application/json')) {
    const body = await request.json().catch(() => ({}));
    return String(body.status || '').trim();
  }
  const text = await request.text();
  const params = new URLSearchParams(text);
  return String(params.get('status') || '').trim();
}

async function handleAdminStatus(request, id) {
  if (!isAdmin(request)) return new Response('Unauthorized', { status: 401 });
  const status = await readStatusFromRequest(request);
  if (!STATUSES.includes(status) || status === 'to_order') {
    return new Response('Invalid status', { status: 400 });
  }
  const db = getPool();
  if (!db) return new Response('Database is not configured', { status: 503 });
  const result = await db.query(
    `UPDATE orders SET fulfillment_status = $1, updated_at = now() WHERE id = $2
     RETURNING id`,
    [status, id]
  );
  if (!result.rowCount) return new Response('Order not found', { status: 404 });
  const token = readAdminToken(request);
  const loc = `/admin/orders?token=${encodeURIComponent(token)}`;
  return new Response(null, { status: 303, headers: { Location: loc } });
}

async function handle(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  try { await migrate(); } catch (err) { console.error('migrate failed', err.message); }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';

  if (request.method === 'GET' && path === '/health') {
    return json(request, { ok: true });
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
  if (request.method === 'GET' && path === '/admin/orders') return handleAdminList(request);
  const statusMatch = path.match(/^\/admin\/orders\/([0-9a-f-]{36})\/status$/i);
  if (request.method === 'POST' && statusMatch) return handleAdminStatus(request, statusMatch[1]);

  return new Response('Not found', { status: 404, headers: corsHeaders(request) });
}

module.exports = {
  fetch: handle,
};
