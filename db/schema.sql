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
