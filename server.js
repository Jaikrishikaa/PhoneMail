require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const { randomUUID, randomInt, createHmac, timingSafeEqual } = require("crypto");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const multer = require("multer");
const schema = fs.readFileSync(path.join(__dirname, "db", "schema.sql"), "utf8");

const app = express();
const PORT = process.env.PORT || 3000;
const EMAIL_DOMAIN = String(process.env.EMAIL_DOMAIN || "demo.phonemail.test").trim().toLowerCase();
const OTP_MODE = process.env.OTP_MODE || "demo";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const uploadDirectory = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
fs.mkdirSync(uploadDirectory, { recursive: true });

const upload = multer({
  dest: uploadDirectory,
  limits: { fileSize: 10 * 1024 * 1024 }
});

async function saveAttachments(emailId, files = []) {
  for (const file of files) {
    await pool.query(
      `INSERT INTO attachments
       (id, email_id, filename, stored_name, mime_type, size_bytes, content)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), emailId, file.originalname, file.filename, file.mimetype, file.size, await fs.promises.readFile(file.path)]
    );
  }
}

function mailAttachments(files = []) {
  return files.map(file => ({ filename: file.originalname, path: file.path, contentType: file.mimetype }));
}

function isInternalAddress(address) {
  return Boolean(address && address.toLowerCase().endsWith(`@${EMAIL_DOMAIN}`));
}

function otpDigest(phone, code) {
  return createHmac("sha256", process.env.OTP_SECRET || process.env.JWT_SECRET || "phonemail-demo")
    .update(`${phone}:${code}`)
    .digest("hex");
}

function twilioAuth() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SERVICE_SID) {
    throw new Error("SMS OTP is not configured. Add the Twilio account SID, auth token, and Verify service SID.");
  }
  const credentials = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  return { credentials, url: `https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SERVICE_SID}` };
}

async function startPhoneVerification(phone) {
  if (OTP_MODE === "demo") return;
  if (OTP_MODE !== "twilio") throw new Error("Unknown OTP mode. Use demo or twilio.");
  const { credentials, url } = twilioAuth();
  const response = await fetch(`${url}/Verifications`, {
    method: "POST",
    headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: phone, Channel: "sms" })
  });
  if (!response.ok) throw new Error(`Twilio could not send the verification SMS (${response.status}).`);
}

async function checkPhoneVerification(phone, code) {
  const { credentials, url } = twilioAuth();
  const response = await fetch(`${url}/VerificationCheck`, {
    method: "POST",
    headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: phone, Code: code })
  });
  if (!response.ok) throw new Error(`Twilio could not verify the SMS code (${response.status}).`);
  const result = await response.json();
  return result.status === "approved";
}

async function sendExternalEmail({ name, to, subject, body, files = [] }) {
  if (process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL) {
    const attachments = await Promise.all(files.map(async file => ({
      name: file.originalname,
      content: (await fs.promises.readFile(file.path)).toString("base64")
    })));
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { name: `${name} via PhoneMail`, email: process.env.BREVO_SENDER_EMAIL },
        to: [{ email: to }], subject, textContent: body,
        ...(process.env.BREVO_REPLY_TO_EMAIL ? { replyTo: { email: process.env.BREVO_REPLY_TO_EMAIL } } : {}),
        ...(attachments.length ? { attachment: attachments } : {})
      })
    });
    if (!response.ok) throw new Error(`Brevo could not send this email (${response.status}).`);
    return;
  }

  if (process.env.SMTP_HOST) {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 1025),
      secure: process.env.SMTP_SECURE === "true",
      ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } } : {})
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.BREVO_SENDER_EMAIL,
      to, subject, text: body, attachments: mailAttachments(files)
    });
    return;
  }
  const error = new Error("External email is disabled. Configure Brevo with a verified sender; demo addresses only work inside PhoneMail.");
  error.status = 503;
  throw error;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "frontend")));

app.get("/api/config", (req, res) => {
  res.json({ emailDomain: EMAIL_DOMAIN, demoOtp: OTP_MODE === "demo", externalEmailEnabled: Boolean(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL) });
});

app.get("/api/health", async (req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});

function makeToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email_address },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function toUser(row) {
  return {
    id: row.id,
    phone: row.phone_number,
    name: row.name,
    email: row.email_address,
    language: row.language
  };
}

function toEmail(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    from: row.sender_address,
    to: row.recipient_address,
    subject: row.subject,
    body: row.body,
    folder: row.folder,
    read: row.is_read,
    favorite: row.is_favorite,
    createdAt: row.created_at
  };
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.replace("Bearer ", "");
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const result = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [payload.id]
    );

    if (!result.rows[0]) {
      return res.status(401).json({ error: "Please log in." });
    }

    req.user = result.rows[0];
    next();
  } catch {
    res.status(401).json({ error: "Please log in." });
  }
}

async function findOrCreateConversation(senderId, recipientId, subject) {
  if (!recipientId) {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO conversations (id, subject) VALUES ($1, $2)",
      [id, subject]
    );
    return id;
  }

  const existing = await pool.query(
    `SELECT c.id
     FROM conversations c
     JOIN emails e ON e.conversation_id = c.id
     WHERE e.subject = $1
       AND (
         (e.sender_id = $2 AND e.recipient_id = $3)
         OR
         (e.sender_id = $3 AND e.recipient_id = $2)
       )
     ORDER BY c.updated_at DESC
     LIMIT 1`,
    [subject.replace(/^Re:\s*/i, ""), senderId, recipientId]
  );

  if (existing.rows[0]) {
    return existing.rows[0].id;
  }

  const id = randomUUID();
  await pool.query(
    "INSERT INTO conversations (id, subject) VALUES ($1, $2)",
    [id, subject.replace(/^Re:\s*/i, "")]
  );
  return id;
}

app.post("/api/auth/register", async (req, res) => {
  try {
    const phoneE164 = String(req.body.phone || "").trim().replace(/[\s()-]/g, "");
    const phone = phoneE164.replace(/\D/g, "");
    const name = String(req.body.name || "PhoneMail user").trim();
    const password = String(req.body.password || "");

    if (!/^\+[1-9]\d{7,14}$/.test(phoneE164) || password.length < 8) {
      return res.status(400).json({
        error: "Enter a valid international phone number and a password of at least 8 characters."
      });
    }

    const verification = await pool.query(
      `SELECT id FROM otp_codes WHERE phone_number = $1 AND verified = TRUE
       AND expires_at > NOW() ORDER BY expires_at DESC LIMIT 1`, [phoneE164]
    );
    if (!verification.rows[0]) {
      return res.status(400).json({ error: "Verify your phone number with an OTP before creating an account." });
    }

    const email = `${phone}@${EMAIL_DOMAIN}`;
    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users
       (id, phone_number, email_address, password_hash, name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [randomUUID(), phone, email, passwordHash, name]
    );

    const user = result.rows[0];
    await pool.query("UPDATE otp_codes SET verified = FALSE WHERE id = $1", [verification.rows[0].id]);
    res.status(201).json({ token: makeToken(user), user: toUser(user) });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: "This phone number is already registered."
      });
    }

    console.error(error);
    res.status(500).json({ error: "Could not create account." });
  }
});

app.post("/api/auth/otp/request", async (req, res) => {
  try {
    const phone = String(req.body.phone || "").trim();
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
      return res.status(400).json({ error: "Enter the phone number in international format, for example +919876543210." });
    }
    const recent = await pool.query(
      "SELECT COUNT(*)::int AS count FROM otp_codes WHERE phone_number = $1 AND expires_at > NOW() - INTERVAL '15 minutes'",
      [phone]
    );
    if (recent.rows[0].count >= 3) return res.status(429).json({ error: "Too many codes requested. Wait 15 minutes and try again." });
    const code = OTP_MODE === "demo" ? String(randomInt(0, 1000000)).padStart(6, "0") : null;
    await startPhoneVerification(phone);
    await pool.query(
      `INSERT INTO otp_codes (id, phone_number, code, expires_at, verified)
       VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes', FALSE)`,
      [randomUUID(), phone, code ? otpDigest(phone, code) : "TWILIO_PENDING"]
    );
    res.json({ message: OTP_MODE === "demo" ? "Demo OTP generated. No SMS was sent." : "Verification code sent by SMS.", ...(OTP_MODE === "demo" ? { demoCode: code } : {}) });
  } catch (error) {
    console.error("OTP request failed:", error.message);
    res.status(error.status || 503).json({ error: error.status ? error.message : "Could not send a verification code. Check SMS setup and try again." });
  }
});

app.post("/api/auth/otp/verify", async (req, res) => {
  try {
    const phone = String(req.body.phone || "").trim();
    const code = String(req.body.code || "").trim();
    if (!/^\+[1-9]\d{7,14}$/.test(phone) || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "Enter your international phone number and the six-digit code." });
    }
    const result = await pool.query(
      `SELECT id, code FROM otp_codes WHERE phone_number = $1 AND verified = FALSE AND attempts < 5
       AND expires_at > NOW() ORDER BY expires_at DESC LIMIT 1`, [phone]
    );
    if (!result.rows[0]) return res.status(400).json({ error: "That code expired or was already used. Request a new one." });
    if (OTP_MODE === "twilio") {
      if (!await checkPhoneVerification(phone, code)) {
        return res.status(400).json({ error: "That code is incorrect or expired." });
      }
      await pool.query("UPDATE otp_codes SET code = 'TWILIO_VERIFIED', verified = TRUE WHERE id = $1", [result.rows[0].id]);
    } else {
      const expected = Buffer.from(result.rows[0].code, "hex");
      const supplied = Buffer.from(otpDigest(phone, code), "hex");
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
        await pool.query("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1", [result.rows[0].id]);
        return res.status(400).json({ error: "That code is incorrect." });
      }
      await pool.query("UPDATE otp_codes SET verified = TRUE WHERE id = $1", [result.rows[0].id]);
    }
    res.json({ verified: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not verify the code." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const phone = String(req.body.phone || "").replace(/\D/g, "");
    const result = await pool.query(
      "SELECT * FROM users WHERE regexp_replace(phone_number, '\\D', '', 'g') = $1",
      [phone]
    );

    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(req.body.password || "", user.password_hash))) {
      return res.status(401).json({
        error: "Incorrect phone number or password."
      });
    }

    res.json({ token: makeToken(user), user: toUser(user) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not log in." });
  }
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: toUser(req.user) });
});

app.get("/api/emails", requireAuth, async (req, res) => {
  try {
    const folder = req.query.folder || "inbox";
    const search = `%${req.query.q || ""}%`;

    let query;
    let values;

    if (folder === "sent") {
      query = `
        SELECT * FROM emails
        WHERE sender_id = $1
          AND folder <> 'drafts'
          AND (subject ILIKE $2 OR body ILIKE $2 OR recipient_address ILIKE $2)
        ORDER BY created_at DESC`;
      values = [req.user.id, search];
    } else if (folder === "favorites") {
      query = `
        SELECT * FROM emails
        WHERE (sender_id = $1 OR recipient_id = $1) AND is_favorite = TRUE AND folder NOT IN ('drafts', 'trash', 'spam')
          AND (subject ILIKE $2 OR body ILIKE $2 OR sender_address ILIKE $2 OR recipient_address ILIKE $2)
        ORDER BY created_at DESC`;
      values = [req.user.id, search];
    } else if (folder === "drafts") {
      query = `
        SELECT * FROM emails
        WHERE sender_id = $1 AND folder = 'drafts'
          AND (subject ILIKE $2 OR body ILIKE $2 OR recipient_address ILIKE $2)
        ORDER BY created_at DESC`;
      values = [req.user.id, search];
    } else {
      query = `
        SELECT * FROM emails
        WHERE recipient_id = $1
          AND folder = $2
          AND (subject ILIKE $3 OR body ILIKE $3 OR sender_address ILIKE $3)
        ORDER BY created_at DESC`;
      values = [req.user.id, folder, search];
    }

    const result = await pool.query(query, values);
    res.json({ emails: result.rows.map(toEmail) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load emails." });
  }
});

app.get("/api/emails/:id", requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM emails
     WHERE id = $1 AND (sender_id = $2 OR recipient_id = $2)`,
    [req.params.id, req.user.id]
  );

  const email = result.rows[0];
  if (!email) return res.status(404).json({ error: "Email not found." });

  if (email.recipient_id === req.user.id) {
    await pool.query("UPDATE emails SET is_read = true WHERE id = $1", [email.id]);
    email.is_read = true;
  }

  const attachmentResult = await pool.query(
    "SELECT id, filename, mime_type, size_bytes FROM attachments WHERE email_id = $1 ORDER BY filename",
    [email.id]
  );
  res.json({ email: { ...toEmail(email), attachments: attachmentResult.rows.map(file => ({ id: file.id, filename: file.filename, mimeType: file.mime_type, sizeBytes: file.size_bytes })) } });
});

app.get("/api/attachments/:id", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.stored_name, a.filename, a.mime_type, a.content
       FROM attachments a JOIN emails e ON e.id = a.email_id
       WHERE a.id = $1 AND (e.sender_id = $2 OR e.recipient_id = $2)`,
      [req.params.id, req.user.id]
    );
    const file = result.rows[0];
    if (!file) return res.status(404).json({ error: "Attachment not found." });
    if (file.content) {
      res.type(file.mime_type || "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
      return res.send(file.content);
    }
    res.download(path.join(uploadDirectory, file.stored_name), file.filename, error => {
      if (error && !res.headersSent) res.status(404).json({ error: "Attachment file is unavailable." });
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not download attachment." });
  }
});

app.post("/api/emails", requireAuth, upload.array("attachments", 5), async (req, res) => {
  try {
    const { to, subject, body, draft } = req.body;
    const recipientAddress = String(to || "").trim().toLowerCase();
    const cleanSubject = String(subject || "(no subject)").trim();
    const cleanBody = String(body || "");

    if (!draft && !recipientAddress) {
      return res.status(400).json({ error: "Recipient email is required." });
    }

    const recipientResult = recipientAddress
      ? await pool.query("SELECT * FROM users WHERE email_address = $1", [recipientAddress])
      : { rows: [] };

    const recipient = recipientResult.rows[0];
    if (!draft && isInternalAddress(recipientAddress) && !recipient) {
      return res.status(404).json({ error: `No PhoneMail account exists at ${recipientAddress}.` });
    }
    if (!draft && !recipient && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientAddress)) {
      return res.status(400).json({ error: "Enter a valid recipient email address." });
    }
    if (!draft && !recipient) await sendExternalEmail({ name: req.user.name, to: recipientAddress, subject: cleanSubject, body: cleanBody, files: req.files });
    const conversationId = await findOrCreateConversation(
      req.user.id,
      recipient?.id || null,
      cleanSubject
    );

    const emailId = randomUUID();
    const folder = draft ? "drafts" : "inbox";

    const inserted = await pool.query(
      `INSERT INTO emails
       (id, conversation_id, sender_id, recipient_id, sender_address,
        recipient_address, subject, body, folder)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        emailId,
        conversationId,
        req.user.id,
        recipient?.id || null,
        `${req.user.name} <${req.user.email_address}>`,
        draft ? recipientAddress : recipientAddress || req.user.email_address,
        cleanSubject,
        cleanBody,
        folder
      ]
    );

    await saveAttachments(emailId, req.files);

    res.status(201).json({ email: toEmail(inserted.rows[0]) });
  } catch (error) {
    console.error(error);
    res.status(error.status || 500).json({ error: error.message || "Could not send email." });
  }
});

app.put("/api/emails/:id/draft", requireAuth, upload.array("attachments", 5), async (req, res) => {
  try {
    const { to, subject, body } = req.body;
    const result = await pool.query(
      `UPDATE emails SET recipient_address = $3, subject = $4, body = $5
       WHERE id = $1 AND sender_id = $2 AND folder = 'drafts' RETURNING *`,
      [req.params.id, req.user.id, String(to || "").trim().toLowerCase(), String(subject || "(no subject)").trim(), String(body || "")]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Draft not found." });
    await saveAttachments(req.params.id, req.files);
    res.json({ email: toEmail(result.rows[0]) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not save draft." });
  }
});

app.post("/api/emails/:id/send-draft", requireAuth, upload.array("attachments", 5), async (req, res) => {
  try {
    const { to, subject, body } = req.body;
    const draftResult = await pool.query(
      `UPDATE emails SET recipient_address = $3, subject = $4, body = $5
       WHERE id = $1 AND sender_id = $2 AND folder = 'drafts' RETURNING *`,
      [req.params.id, req.user.id, String(to || "").trim().toLowerCase(), String(subject || "(no subject)").trim(), String(body || "")]
    );
    const draft = draftResult.rows[0];
    if (!draft) return res.status(404).json({ error: "Draft not found." });
    if (!draft.recipient_address) return res.status(400).json({ error: "Recipient email is required." });

    const recipientResult = await pool.query(
      "SELECT * FROM users WHERE email_address = $1",
      [draft.recipient_address]
    );
    const recipient = recipientResult.rows[0];
    if (isInternalAddress(draft.recipient_address) && !recipient) {
      return res.status(404).json({ error: `No PhoneMail account exists at ${draft.recipient_address}.` });
    }
    if (!recipient) await sendExternalEmail({ name: req.user.name, to: draft.recipient_address, subject: draft.subject, body: draft.body, files: req.files });
    await saveAttachments(draft.id, req.files);
    const result = await pool.query(
      `UPDATE emails SET folder = 'inbox', recipient_id = $2
       WHERE id = $1 RETURNING *`,
      [draft.id, recipient?.id || null]
    );
    res.json({ email: toEmail(result.rows[0]) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not send draft." });
  }
});

app.post("/api/emails/:id/reply", requireAuth, upload.array("attachments", 5), async (req, res) => {
  const originalResult = await pool.query(
    "SELECT * FROM emails WHERE id = $1",
    [req.params.id]
  );

  const original = originalResult.rows[0];
  if (!original) return res.status(404).json({ error: "Email not found." });

  const recipientResult = await pool.query(
    "SELECT * FROM users WHERE id = $1",
    [original.sender_id]
  );

  const recipient = recipientResult.rows[0];
  if (!recipient) return res.status(400).json({ error: "Reply recipient not found." });

  const body = String(req.body.body || "");
  const subject = original.subject.startsWith("Re:")
    ? original.subject
    : `Re: ${original.subject}`;

  const inserted = await pool.query(
    `INSERT INTO emails
     (id, conversation_id, sender_id, recipient_id, sender_address,
      recipient_address, subject, body, folder, in_reply_to)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'inbox', $9)
     RETURNING *`,
    [
      randomUUID(),
      original.conversation_id,
      req.user.id,
      recipient.id,
      `${req.user.name} <${req.user.email_address}>`,
      recipient.email_address,
      subject,
      body,
      original.id
    ]
  );

  await saveAttachments(inserted.rows[0].id, req.files);

  res.status(201).json({ email: toEmail(inserted.rows[0]) });
});

app.post("/api/emails/:id/:action", requireAuth, async (req, res) => {
  const { id, action } = req.params;

  if (!["trash", "spam", "favorite", "inbox"].includes(action)) {
    return res.status(400).json({ error: "Invalid action." });
  }

  const query = action === "favorite"
    ? `UPDATE emails SET is_favorite = NOT is_favorite
       WHERE id = $1 AND (recipient_id = $2 OR sender_id = $2) RETURNING *`
    : `UPDATE emails SET folder = $3
       WHERE id = $1 AND (recipient_id = $2 OR (sender_id = $2 AND $3 = 'trash')) RETURNING *`;

  const values = action === "favorite"
    ? [id, req.user.id]
    : [id, req.user.id, action === "inbox" ? "inbox" : action === "trash" ? "trash" : "spam"];

  const result = await pool.query(query, values);
  if (!result.rows[0]) return res.status(404).json({ error: "Email not found." });

  res.json({ email: toEmail(result.rows[0]) });
});

async function start() {
  await pool.query(schema);
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`PhoneMail running on port ${PORT}`);
  });
}

start().catch(error => {
  console.error("PhoneMail could not start. Check DATABASE_URL and the database schema.", error);
  process.exit(1);
});
