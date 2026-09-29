CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  phone_number VARCHAR(20) UNIQUE NOT NULL,
  email_address VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name VARCHAR(120) NOT NULL,
  language VARCHAR(20) DEFAULT 'en',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY,
  subject TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS emails (
  id UUID PRIMARY KEY,
  conversation_id UUID REFERENCES conversations(id),
  sender_id UUID REFERENCES users(id),
  recipient_id UUID REFERENCES users(id),
  sender_address VARCHAR(255) NOT NULL,
  recipient_address VARCHAR(255) NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  folder VARCHAR(20) DEFAULT 'inbox',
  is_read BOOLEAN DEFAULT FALSE,
  is_favorite BOOLEAN DEFAULT FALSE,
  in_reply_to UUID REFERENCES emails(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY,
  email_id UUID REFERENCES emails(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  content BYTEA
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id UUID PRIMARY KEY,
  phone_number VARCHAR(20) NOT NULL,
  code VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  verified BOOLEAN DEFAULT FALSE,
  attempts INTEGER NOT NULL DEFAULT 0
);

-- Keep databases created from earlier MVP versions compatible with OTP hashes.
ALTER TABLE otp_codes ALTER COLUMN code TYPE VARCHAR(64);
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS content BYTEA;
CREATE INDEX IF NOT EXISTS otp_codes_phone_expiry_idx ON otp_codes (phone_number, expires_at DESC);
CREATE INDEX IF NOT EXISTS emails_recipient_folder_idx ON emails (recipient_id, folder, created_at DESC);
