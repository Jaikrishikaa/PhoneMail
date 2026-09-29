# PhoneMail

PhoneMail is a hackathon MVP for phone-number-based identities and an email-style inbox. In demo mode, messages between registered PhoneMail accounts are stored and delivered inside the app. Demo addresses use `EMAIL_DOMAIN` (default: `demo.phonemail.test`); that reserved demo domain cannot receive mail from Gmail or the public internet.

## Run locally

Docker Compose is the easiest option because it starts PostgreSQL and Mailpit as well as the app:

```bash
docker compose up --build
```

Open `http://localhost:3000`. Create two accounts with international-format phone numbers such as `+919876543210`. In the default demo OTP mode, no SMS is sent: the temporary code is shown in the signup page. Verify both accounts, then send a message to the other account's PhoneMail address.

To run the app directly with Node, start PostgreSQL separately, copy `.env.example` to `.env`, set `DATABASE_URL` and a long random `JWT_SECRET`, then run:

```bash
npm start
```

## Delivery modes

- **PhoneMail-to-PhoneMail:** works inside the app and does not need SMTP.
- **PhoneMail-to-Gmail or another external mailbox:** configure `BREVO_API_KEY` and a sender address verified in Brevo. The provider-verified sender is used for delivery. External replies do not arrive in PhoneMail because demo addresses have no public inbound-mail routing.
- **Phone verification:** `OTP_MODE=demo` displays a demo code in the app and does not verify ownership of the phone. For real SMS, set `OTP_MODE=twilio` and configure the Twilio account SID, auth token, and Verify Service SID. Trial accounts can text only recipient numbers verified in Twilio; the trial currently includes 40 free verifications, then requires an upgrade for continued use. [Twilio Verify trial limits](https://www.twilio.com/docs/usage/trials/try-out-verify)

Never commit `.env` or publish API keys. Render Free blocks SMTP ports, so configure Brevo's HTTPS API for external sending on Render.

## Render deployment settings

Deploy the merged `main` branch as a Node web service with build command `npm install` and start command `npm start`. Configure a PostgreSQL `DATABASE_URL` (for example from Neon), a long random `JWT_SECRET`, and:

```text
EMAIL_DOMAIN=demo.phonemail.test
OTP_MODE=demo
```

For actual SMS, set `OTP_MODE=twilio` and add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_VERIFY_SERVICE_SID` in Render's private environment settings. Create a Verify Service in Twilio first. The app applies the schema at startup. Add Brevo values only after sender verification. Attachments are stored in PostgreSQL so they survive app restarts. Render Free may sleep while idle; the first request can take time to wake the service.

## Current MVP features

Phone/password accounts with OTP-gated registration, internal inbox and sent mail, drafts, replies, search, favorites, spam, trash, and attachments. Public inbound email, account recovery, contact management, and production-grade SMS/email abuse protection are not implemented yet.
