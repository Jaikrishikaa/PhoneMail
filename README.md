# PhoneMail

PhoneMail is a responsive MVP where a phone number becomes an email identity (for example, `9876543210@phonemail.com`).

## Run locally

```bash
npm start
```

Open `http://localhost:3000`.

## Run with Docker

```bash
docker compose up -d --build
```

Register two users, then send mail to the other user's PhoneMail address. Data persists in `data/phonemail.json`.

## MVP scope

Phone/password authentication, generated PhoneMail IDs, inbox/sent/drafts/spam/trash, search, compose, reading, replying, and a responsive chat-like mobile or Gmail-like desktop experience.
