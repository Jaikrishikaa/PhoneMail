# PhoneMail Buildathon MVP

PhoneMail gives each account an email-style identity based on its phone number. It provides a Gmail-like desktop mailbox and a conversation-style mobile interface from the same responsive website.

## Included features

- Phone-number registration with OTP-gated account creation; passwords are not collected
- Demo OTP mode: a fresh random six-digit code appears in the browser
- Inbox, Sent, Drafts, Spam, Trash, Favorites, search, replies, and attachments
- Mobile conversation list inspired by chat mail clients, with search and filter chips
- Multi-recipient compose for internal group delivery
- Terms screen plus account settings: display name, language, profile photo, notification preference, mobile-use preference, and aliases
- Optional SMS OTP and SMS notification integration through Twilio
- Optional external outbound mail through Brevo or SMTP
- Inbound webhook route for Resend or another inbound-email provider

## Run locally

```bash
docker compose up --build
```

Open `http://localhost:3000`. Create two accounts using international numbers. Click **Send SMS code**, enter the displayed demo code, then send to the other account's address, such as `919876543210@demo.phonemail.test`.

Mailpit is available at `http://localhost:8025` for local SMTP testing.

## Temporary preview mode

The checked-in `.env` is ignored by Git and may contain temporary values for a
local preview. Run this alongside an existing local service with:

```bash
npm run preview
```

Open `http://localhost:3001`. It uses the configured preview identity and
Twilio Verify mode. `NOTIFICATION_MODE=demo` writes a simulated arrival-SMS
message to the server log until a real `TWILIO_SMS_FROM` is available. Never
expose the temporary inbound webhook secret outside development. If Docker is
not running, set `DATABASE_URL_PREVIEW` to the direct connection string for
this project's PostgreSQL database.

## Deployment configuration

Set these private environment variables in the host:

```text
DATABASE_URL=postgresql://...
JWT_SECRET=long-random-secret
OTP_SECRET=another-long-random-secret
EMAIL_DOMAIN=mail.your-domain.example
APP_NAME=Your product name
OTP_MODE=twilio
```

For live Twilio verification, use `OTP_MODE=twilio` plus `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_VERIFY_SERVICE_SID`. The registration page supports SMS and Twilio Verify voice-call delivery. For email-arrival SMS notifications, also set `TWILIO_SMS_FROM` to a Twilio number. Trial accounts can send only to numbers verified in Twilio.

For an offline demo without a Twilio sender number, set `NOTIFICATION_MODE=demo`. Arrival notifications are then logged by the app rather than sent as an SMS.

For public inbound email, create an `INBOUND_WEBHOOK_SECRET`, then configure the mail provider to POST to:

```text
https://your-host/api/inbound/email?secret=YOUR_SECRET
```

The provider must send `to`, `from`, `subject`, and `text` fields. Configure an inbound domain with that provider. You must own or control `EMAIL_DOMAIN`: use a domain you register (for example `mail.your-domain.example`) and add the provider's MX/DKIM/SPF records. Do not use `phonemail.com` unless you control it; the application cannot create identities on a domain owned by someone else.

## Limits of demo mode

Demo OTP confirms that the screen flow works but does not prove ownership of a phone number. Real SMS/voice verification and public email delivery require a provider account, sender number, domain, and credentials. The Docker app starts fully with demo OTP and internal messaging without any paid service.
