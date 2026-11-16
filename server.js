'use strict';

const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const { migrate } = require('./db/migrate');
const { sendFulfillmentEmail, formatAddress, formatOrderDate, formatAmount, escapeHtml } = require('./lib/fulfillment');

const PORT = Number(process.env.PORT) || 10000;
const SKU = 'VR-001';
const PRODUCT_NAME = 'VR-001 Officer Leather Jacket — Olive';
const AMOUNT_CENTS = 42000;
const CURRENCY = 'usd';
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const SHIP_COUNTRIES = [
  'US','CA','GB','IE','AU','NZ','FR','DE','IT','ES','NL','BE','AT','CH','SE','NO',
  'DK','FI','PT','PL','CZ','HU','RO','GR','LU','MX','JP','KR','SG','HK','TW','AE'
];

function publicBaseUrl(req) {
  const env = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (env) return env;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
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

function checkoutReady() {
  return Boolean(liveStripeKey());
}

function stripeClient() {
  const key = liveStripeKey();
  if (!key) return null;
  const Stripe = require('stripe');
  return new Stripe(key);
}

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: true } })
  : null;

const app = express();
app.set('trust proxy', 1);

app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  const key = liveStripeKey();
  if (!key || !secret) {
    return res.status(503).send('Webhook is not configured');
  }
  const stripe = stripeClient();
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('webhook signature failed', err.message);
    return res.status(400).send('Invalid signature');
  }
  if (!event.livemode) {
    console.error('ignored non-live Stripe event', event.type, event.id);
    return res.status(400).send('Live events only');
  }
  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      await fulfillCheckoutSession(stripe, event.data.object);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('webhook handler failed', err);
    res.status(500).send('Webhook handler failed');
  }
});

app.use(express.json({ limit: '32kb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/checkout-status', (_req, res) => {
  res.json({
    available: checkoutReady(),
    currency: CURRENCY.toUpperCase(),
    amountCents: AMOUNT_CENTS,
    sku: SKU,
    name: PRODUCT_NAME,
  });
});

app.post('/checkout', async (req, res) => {
  const stripe = stripeClient();
  if (!stripe) {
    return res.status(503).json({ error: 'Ordering is not yet available' });
  }
  const size = String((req.body && req.body.size) || '').trim().toUpperCase();
  if (!SIZES.includes(size)) {
    return res.status(400).json({ error: 'Select a size first' });
  }
  const base = publicBaseUrl(req);
  const priceId = (process.env.STRIPE_PRICE_ID || '').trim();
  const lineItem = priceId
    ? {
        price: priceId,
        quantity: 1,
      }
    : {
        price_data: {
          currency: CURRENCY,
          unit_amount: AMOUNT_CENTS,
          product_data: {
            name: PRODUCT_NAME,
            description: `Size ${size}`,
          },
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
      return res.status(503).json({ error: 'Ordering is not yet available' });
    }
    res.json({ url: session.url });
  } catch (err) {
    console.error('checkout session failed', err.message);
    res.status(500).json({ error: 'Could not start checkout' });
  }
});

async function fulfillCheckoutSession(stripe, session) {
  if (!session || session.payment_status !== 'paid') return;
  const full = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ['payment_intent'],
  });
  if (!full.livemode || full.payment_status !== 'paid') return;

  const size = (full.metadata && full.metadata.size) || null;
  const sku = (full.metadata && full.metadata.sku) || SKU;
  const email = (full.customer_details && full.customer_details.email) || full.customer_email || null;
  const shipping = full.collected_information && full.collected_information.shipping_details
    ? full.collected_information.shipping_details
    : full.shipping_details || null;
  const paymentIntentId = typeof full.payment_intent === 'string'
    ? full.payment_intent
    : full.payment_intent && full.payment_intent.id;
  const amount = full.amount_total != null ? full.amount_total : AMOUNT_CENTS;
  const currency = (full.currency || CURRENCY).toLowerCase();
  const shippingName = shipping && shipping.name ? shipping.name : (full.customer_details && full.customer_details.name) || null;
  const shippingAddress = shipping && shipping.address ? shipping.address : null;

  if (pool) {
    await pool.query(
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
        full.id,
        paymentIntentId || null,
        email,
        size,
        sku,
        amount,
        currency,
        'paid',
        shippingName,
        shippingAddress ? JSON.stringify(shippingAddress) : null,
        full.customer_details ? JSON.stringify(full.customer_details) : null,
      ]
    );
  }

  let existing = { email_sent_at: null, fulfillment_email_sent_at: null, id: null, created_at: new Date() };
  if (pool) {
    const already = await pool.query(
      'SELECT id, email_sent_at, fulfillment_email_sent_at, created_at FROM orders WHERE stripe_session_id = $1',
      [full.id]
    );
    if (already.rows[0]) existing = already.rows[0];
  }
  if (!existing.email_sent_at) {
    const sent = await sendConfirmation({ email, size, sku, amount, currency, shippingName, shippingAddress, sessionId: full.id });
    if (sent && pool) {
      await pool.query(
        'UPDATE orders SET email_sent_at = now(), updated_at = now() WHERE stripe_session_id = $1 AND email_sent_at IS NULL',
        [full.id]
      );
    }
  }
  if (!existing.fulfillment_email_sent_at) {
    const sentFulfillment = await sendFulfillmentEmail({
      orderId: existing.id || full.id,
      date: existing.created_at || new Date(),
      size,
      sku,
      customerName: shippingName,
      customerEmail: email,
      shippingAddress,
      amountCents: amount,
      currency,
      adminBaseUrl: process.env.PUBLIC_API_URL || '',
    });
    if (sentFulfillment && pool) {
      await pool.query(
        'UPDATE orders SET fulfillment_email_sent_at = now(), updated_at = now() WHERE stripe_session_id = $1 AND fulfillment_email_sent_at IS NULL',
        [full.id]
      );
    }
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
    `${PRODUCT_NAME}`,
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
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: `Order confirmed — ${SKU}`,
      text,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error('resend failed', resp.status, body.slice(0, 300));
    return false;
  }
  return true;
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get(['/success.html', '/success'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'success.html'));
});

app.get(['/cancel.html', '/cancel'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'cancel.html'));
});

app.use('/img', express.static(path.join(__dirname, 'img'), { maxAge: '7d' }));
app.use('/fonts', express.static(path.join(__dirname, 'fonts'), { maxAge: '30d' }));


const crypto = require('crypto');
function readAdminToken(req) {
  const q = (req.query && req.query.token) || '';
  const auth = req.headers.authorization || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  return q || bearer;
}
function isAdmin(req) {
  const expected = (process.env.ADMIN_TOKEN || '').trim();
  if (!expected) return false;
  const got = readAdminToken(req);
  const a = Buffer.from(String(got), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

app.get('/admin/orders', express.urlencoded({ extended: false }), async (req, res) => {
  if (!isAdmin(req)) return res.status(401).type('text/plain').send('Unauthorized');
  const orders = pool
    ? (await pool.query(
      `SELECT id, email, size, sku, amount_cents, currency, shipping_name, shipping_address,
              fulfillment_status, created_at
       FROM orders ORDER BY created_at DESC LIMIT 200`
    )).rows
    : [];
  const token = readAdminToken(req);
  const q = `?token=${encodeURIComponent(token)}`;
  const rows = orders.map((o) => {
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
      <td>${escapeHtml(o.shipping_name || '—')}<br>${escapeHtml(o.email || '—')}</td>
      <td style="white-space:pre-wrap">${escapeHtml(addr)}</td>
      <td>${escapeHtml(formatAmount(o.amount_cents, o.currency))}</td>
      <td>${escapeHtml(o.fulfillment_status || 'to_order')}</td>
      <td>${buttons || '—'}</td>
    </tr>`;
  }).join('\n');
  res.type('html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Van Reuben orders</title>
  <style>body{font-family:ui-monospace,Menlo,monospace;margin:24px;font-size:13px}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e5e5e5;padding:8px;text-align:left;vertical-align:top}button{font:inherit;background:#111;color:#fff;border:0;padding:6px 10px}</style>
  </head><body><h1>Van Reuben orders</h1>
  ${orders.length ? `<table><thead><tr><th>Order</th><th>Date</th><th>Size</th><th>Customer</th><th>Ship to</th><th>Paid</th><th>Fulfillment</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p>No paid orders yet.</p>'}
  </body></html>`);
});

app.post('/admin/orders/:id/status', express.urlencoded({ extended: false }), async (req, res) => {
  if (!isAdmin(req)) return res.status(401).type('text/plain').send('Unauthorized');
  const status = String((req.body && req.body.status) || '').trim();
  if (!['ordered', 'shipped'].includes(status)) return res.status(400).send('Invalid status');
  if (!pool) return res.status(503).send('Database is not configured');
  const result = await pool.query(
    'UPDATE orders SET fulfillment_status = $1, updated_at = now() WHERE id = $2 RETURNING id',
    [status, req.params.id]
  );
  if (!result.rowCount) return res.status(404).send('Order not found');
  res.redirect(303, `/admin/orders?token=${encodeURIComponent(readAdminToken(req))}`);
});

app.use((_req, res) => {
  res.status(404).type('text/plain').send('Not found');
});


async function start() {
  try {
    await migrate();
  } catch (err) {
    console.error('startup migrate failed', err.message);
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`vanreuben listening on ${PORT}; checkout ${checkoutReady() ? 'available' : 'not yet available'}`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
