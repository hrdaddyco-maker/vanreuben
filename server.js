'use strict';

const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const { migrate } = require('./db/migrate');

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

  if (email && pool) {
    const already = await pool.query(
      'SELECT email_sent_at FROM orders WHERE stripe_session_id = $1',
      [full.id]
    );
    if (already.rows[0] && already.rows[0].email_sent_at) return;
  }
  const sent = await sendConfirmation({ email, size, sku, amount, currency, shippingName, shippingAddress, sessionId: full.id });
  if (sent && pool) {
    await pool.query(
      'UPDATE orders SET email_sent_at = now(), updated_at = now() WHERE stripe_session_id = $1 AND email_sent_at IS NULL',
      [full.id]
    );
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
