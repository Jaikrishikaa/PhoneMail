require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;

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
       (id, email_id, filename, stored_name, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), emailId, file.originalname, file.filename, file.mimetype, file.size]
    );
  }
}

function mailAttachments(files = []) {
  return files.map(file => ({ filename: file.originalname, path: file.path, contentType: file.mimetype }));
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 1025),
  secure: process.env.SMTP_SECURE === "true"
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "frontend")));

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
    const phone = String(req.body.phone || "").replace(/\D/g, "");
    const name = String(req.body.name || "PhoneMail user").trim();
    const password = String(req.body.password || "");

    if (phone.length < 8 || password.length < 4) {
      return res.status(400).json({
        error: "Enter a valid phone number and a password of at least 4 characters."
      });
    }

    const email = `${phone}@phonemail.com`;
    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users
       (id, phone_number, email_address, password_hash, name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [randomUUID(), phone, email, passwordHash, name]
    );

    const user = result.rows[0];
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

app.post("/api/auth/login", async (req, res) => {
  try {
    const phone = String(req.body.phone || "").replace(/\D/g, "");
    const result = await pool.query(
      "SELECT * FROM users WHERE phone_number = $1",
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
      `SELECT a.stored_name, a.filename, a.mime_type
       FROM attachments a JOIN emails e ON e.id = a.email_id
       WHERE a.id = $1 AND (e.sender_id = $2 OR e.recipient_id = $2)`,
      [req.params.id, req.user.id]
    );
    const file = result.rows[0];
    if (!file) return res.status(404).json({ error: "Attachment not found." });
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

    if (!draft) {
      await transporter.sendMail({
        from: `"${req.user.name}" <${req.user.email_address}>`,
        to: recipientAddress,
        subject: cleanSubject,
        text: cleanBody,
        attachments: mailAttachments(req.files)
      });
    }

    res.status(201).json({ email: toEmail(inserted.rows[0]) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not send email." });
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
    await saveAttachments(draft.id, req.files);
    const attachmentResult = await pool.query(
      "SELECT filename, stored_name, mime_type FROM attachments WHERE email_id = $1",
      [draft.id]
    );
    await transporter.sendMail({
      from: `"${req.user.name}" <${req.user.email_address}>`,
      to: draft.recipient_address,
      subject: draft.subject,
      text: draft.body,
      attachments: attachmentResult.rows.map(file => ({ filename: file.filename, path: path.join(uploadDirectory, file.stored_name), contentType: file.mime_type }))
    });
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

  await transporter.sendMail({
    from: `"${req.user.name}" <${req.user.email_address}>`,
    to: recipient.email_address,
    subject,
    text: body,
    attachments: mailAttachments(req.files)
  });

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

app.listen(PORT, () => {
  console.log(`PhoneMail running on port ${PORT}`);
});
