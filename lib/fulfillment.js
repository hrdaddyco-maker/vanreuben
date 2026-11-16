'use strict';

const SKU = 'VR-001';
const PRODUCT_NAME = 'VR-001 Officer Leather Jacket — Olive';
const SUPPLIER_NAME = 'Alibaba leather trench coat';
const SUPPLIER_PRODUCT = "Men's Genuine Leather Trench Coat";
const SUPPLIER_URL = 'https://www.alibaba.com/product-detail/Men-s-Genuine-Leather-Trench-Coat_10000046145828.html';
const SUPPLIER_NOTES = 'About US$26 per jacket. Minimum order 10 pieces.';
const DEFAULT_FULFILLMENT_TO = 'gillesolivieroffice@gmail.com';

function formatAddress(addr) {
  if (!addr) return '';
  if (typeof addr === 'string') return addr;
  return [addr.line1, addr.line2, [addr.city, addr.state, addr.postal_code].filter(Boolean).join(' '), addr.country]
    .filter(Boolean)
    .join('\n');
}

function formatOrderDate(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
  return formatted;
}

function formatAmount(amountCents, currency) {
  const dollars = ((Number(amountCents) || 0) / 100).toFixed(2);
  return `$${dollars} ${(currency || 'usd').toUpperCase()}`;
}

function fulfillmentTo() {
  return (process.env.FULFILLMENT_EMAIL || DEFAULT_FULFILLMENT_TO).trim();
}

function buildFulfillmentEmail(order) {
  const sample = !!order.sample;
  const size = order.size || '—';
  const orderId = order.orderId || '—';
  const date = formatOrderDate(order.date);
  const amount = formatAmount(order.amountCents, order.currency);
  const addr = formatAddress(order.shippingAddress) || '—';
  const adminBase = (order.adminBaseUrl || process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
  const lines = [];
  if (sample) {
    lines.push('SAMPLE FULFILLMENT EMAIL — NOT A REAL ORDER.');
    lines.push('This is a one-time sample so you can see the notice you will get when a customer pays. No customer was charged and no order was saved.');
    lines.push('');
  } else {
    lines.push('Internal fulfillment notice. Do not forward this to the customer.');
    lines.push('');
  }
  lines.push(`Order ID: ${orderId}`);
  lines.push(`Date: ${date}`);
  lines.push(`Product: ${PRODUCT_NAME}`);
  lines.push(`SKU: ${order.sku || SKU}`);
  lines.push(`Size: ${size}`);
  lines.push(`Customer name: ${order.customerName || '—'}`);
  lines.push(`Customer email: ${order.customerEmail || '—'}`);
  lines.push('Shipping address:');
  lines.push(addr);
  lines.push(`Amount paid: ${amount}`);
  lines.push('');
  lines.push(`Olive supplier: ${SUPPLIER_NAME}`);
  lines.push(SUPPLIER_PRODUCT);
  lines.push(SUPPLIER_URL);
  lines.push(SUPPLIER_NOTES);
  lines.push('');
  lines.push('Checklist:');
  lines.push(`1. Order from this listing in the customer's size (${size}) (minimum 10 pcs, unless stock is already on hand).`);
  lines.push('2. Ship it to the customer address above.');
  lines.push('3. Mark the order fulfilled on the admin orders page.');
  if (adminBase) {
    lines.push('');
    lines.push(`Admin: ${adminBase}/admin/orders?token=YOUR_ADMIN_TOKEN`);
  }
  const subject = sample
    ? 'SAMPLE — Van Reuben fulfillment (not a real order)'
    : `Van Reuben fulfillment — ${orderId} — size ${size}`;
  return {
    to: fulfillmentTo(),
    subject,
    text: lines.join('\n'),
    sample,
  };
}

async function sendResendEmail({ to, subject, text }) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  const from = (process.env.RESEND_FROM || '').trim();
  if (!apiKey || !from || !to) return false;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error('resend failed', resp.status, body.slice(0, 300));
    return false;
  }
  return true;
}

async function sendFulfillmentEmail(order) {
  const msg = buildFulfillmentEmail(order);
  return sendResendEmail(msg);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


function supplierAdminHtml() {
  return (
    '<section class="supplier">' +
    '<h2>Olive supplier</h2>' +
    `<p>${escapeHtml(SUPPLIER_NAME)}<br>` +
    `${escapeHtml(SUPPLIER_PRODUCT)}<br>` +
    `<a href="${escapeHtml(SUPPLIER_URL)}">${escapeHtml(SUPPLIER_URL)}</a><br>` +
    `${escapeHtml(SUPPLIER_NOTES)}</p>` +
    "<p>To fulfill an order: order from this listing in the customer's size (minimum 10 pcs, unless stock is already on hand), ship to the customer, then mark the order fulfilled.</p>" +
    '</section>'
  );
}

module.exports = {
  SKU,
  PRODUCT_NAME,
  SUPPLIER_NAME,
  SUPPLIER_PRODUCT,
  SUPPLIER_URL,
  SUPPLIER_NOTES,
  formatAddress,
  formatOrderDate,
  formatAmount,
  fulfillmentTo,
  buildFulfillmentEmail,
  sendResendEmail,
  sendFulfillmentEmail,
  escapeHtml,
  supplierAdminHtml,
};
