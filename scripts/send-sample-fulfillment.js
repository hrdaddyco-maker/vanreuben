'use strict';

/**
 * Local dry-run: send one clearly labeled sample fulfillment email
 * to gillesolivieroffice@gmail.com. Does not write to the database
 * and is not a customer order.
 */
const fs = require('fs');
const path = require('path');
const { buildFulfillmentEmail, sendResendEmail, fulfillmentTo } = require('../lib/fulfillment');

function loadLocalEnv() {
  const keyFile = '/workspace/resend-api-key.txt';
  if (!process.env.RESEND_API_KEY && fs.existsSync(keyFile)) {
    process.env.RESEND_API_KEY = fs.readFileSync(keyFile, 'utf8').trim();
  }
  if (!process.env.RESEND_FROM) {
    process.env.RESEND_FROM = 'Van Reuben <orders@frontkiosk.net>';
  }
}

async function main() {
  loadLocalEnv();
  const msg = buildFulfillmentEmail({
    sample: true,
    orderId: 'SAMPLE-ONLY',
    date: new Date(),
    size: 'M',
    sku: 'VR-001',
    customerName: 'Sample Customer',
    customerEmail: 'sample@example.com',
    shippingAddress: {
      line1: '123 Sample Street',
      city: 'Toronto',
      state: 'ON',
      postal_code: 'M5V 2T6',
      country: 'CA',
    },
    amountCents: 42000,
    currency: 'usd',
    adminBaseUrl: 'https://br-wispy-resonance-betlszuj-orders.compute.c-9.us-east-2.aws.neon.tech',
  });
  if (msg.to !== 'gillesolivieroffice@gmail.com' && fulfillmentTo() !== 'gillesolivieroffice@gmail.com') {
    throw new Error('refusing to send sample to any address other than the office inbox');
  }
  if (!msg.sample || !/^SAMPLE/.test(msg.subject) || !/NOT A REAL ORDER/.test(msg.text)) {
    throw new Error('sample email is not clearly labeled');
  }
  const ok = await sendResendEmail(msg);
  if (!ok) {
    console.error('sample fulfillment email failed');
    process.exit(1);
  }
  console.log('sent sample fulfillment email to office inbox only');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
