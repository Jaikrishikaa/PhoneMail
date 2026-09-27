const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname, DATA = path.join(ROOT, 'data', 'phonemail.json');
const seed = { users: [], emails: [] };
function db() { try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { return structuredClone(seed); } }
function save(data) { fs.mkdirSync(path.dirname(DATA), { recursive: true }); fs.writeFileSync(DATA, JSON.stringify(data, null, 2)); }
function id() { return crypto.randomUUID(); }
function publicUser(u) { return { id: u.id, phone: u.phone, name: u.name, email: u.email }; }
function token(user) { return Buffer.from(JSON.stringify({ id: user.id })).toString('base64url'); }
function current(req, data) { const h = req.headers.authorization || ''; try { const p = JSON.parse(Buffer.from(h.replace('Bearer ', ''), 'base64url')); return data.users.find(u => u.id === p.id); } catch { return null; } }
function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }
function body(req) { return new Promise((resolve, reject) => { let raw=''; req.on('data', c => raw += c); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(); } }); }); }
function serve(res, file) { const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' }; const p = path.join(ROOT, 'frontend', file); fs.readFile(p, (e, b) => { if(e) return json(res,404,{error:'Not found'}); res.writeHead(200, {'content-type': types[path.extname(p)] || 'text/plain'}); res.end(b); }); }

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return serve(res, 'index.html');
  if (req.method === 'GET' && url.pathname === '/app.js') return serve(res, 'app.js');
  if (req.method === 'GET' && url.pathname === '/style.css') return serve(res, 'style.css');
  if (!url.pathname.startsWith('/api/')) return json(res,404,{error:'Not found'});
  const data = db();
  try {
    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      const { phone, name, password } = await body(req); const digits = String(phone || '').replace(/\D/g,'');
      if (digits.length < 8 || !password) return json(res,400,{error:'Enter a valid phone number and password.'});
      if (data.users.some(u => u.phone === digits)) return json(res,409,{error:'This phone number is already registered.'});
      const user = { id:id(), phone:digits, name:name || 'PhoneMail user', password, email:`${digits}@phonemail.com`, createdAt:new Date().toISOString() };
      data.users.push(user); save(data); return json(res,201,{token:token(user), user:publicUser(user)});
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const { phone, password } = await body(req); const digits = String(phone || '').replace(/\D/g,''); const user = data.users.find(u => u.phone === digits && u.password === password);
      return user ? json(res,200,{token:token(user), user:publicUser(user)}) : json(res,401,{error:'Incorrect phone number or password.'});
    }
    const user = current(req, data); if (!user) return json(res,401,{error:'Please log in.'});
    if (req.method === 'GET' && url.pathname === '/api/auth/me') return json(res,200,{user:publicUser(user)});
    if (req.method === 'GET' && url.pathname === '/api/emails') {
      const folder = url.searchParams.get('folder') || 'inbox'; const q = (url.searchParams.get('q') || '').toLowerCase();
      let list = data.emails.filter(e => (folder === 'sent' ? e.senderId === user.id : e.recipientId === user.id && e.folder === folder));
      if (q) list = list.filter(e => [e.subject,e.body,e.from,e.to].join(' ').toLowerCase().includes(q));
      return json(res,200,{emails:list.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});
    }
    if (req.method === 'GET' && /^\/api\/emails\//.test(url.pathname)) { const e=data.emails.find(x=>x.id===url.pathname.split('/').pop() && (x.senderId===user.id||x.recipientId===user.id)); if (!e) return json(res,404,{error:'Email not found'}); if(e.recipientId===user.id)e.read=true; save(data); return json(res,200,{email:e}); }
    if (req.method === 'POST' && url.pathname === '/api/emails') {
      const { to, subject, body: text, draft } = await body(req); const recipient=data.users.find(u=>u.email.toLowerCase()===String(to||'').toLowerCase());
      if (!draft && !recipient) return json(res,400,{error:'For this demo, send to a registered @phonemail.com address.'});
      const e={id:id(),senderId:user.id,recipientId:recipient?.id||user.id,from:`${user.name} <${user.email}>`,to:to||user.email,subject:subject||'(no subject)',body:text||'',folder:draft?'drafts':'inbox',read:false,favorite:false,conversationId: `${[user.id, recipient?.id||user.id].sort().join(':')}|${subject||''}`,createdAt:new Date().toISOString()}; data.emails.push(e); save(data); return json(res,201,{email:e});
    }
    if (req.method === 'POST' && /^\/api\/emails\/[^/]+\/reply$/.test(url.pathname)) { const original=data.emails.find(e=>e.id===url.pathname.split('/')[3]); if(!original)return json(res,404,{error:'Email not found'}); const recipient=data.users.find(u=>u.id===original.senderId); const payload=await body(req); const e={id:id(),senderId:user.id,recipientId:recipient.id,from:`${user.name} <${user.email}>`,to:recipient.email,subject:original.subject.startsWith('Re:')?original.subject:`Re: ${original.subject}`,body:payload.body||'',folder:'inbox',read:false,favorite:false,conversationId:original.conversationId,createdAt:new Date().toISOString()};data.emails.push(e);save(data);return json(res,201,{email:e}); }
    if (req.method === 'POST' && /^\/api\/emails\/[^/]+\/(trash|spam|favorite)$/.test(url.pathname)) { const [, , , eid, action]=url.pathname.split('/'); const e=data.emails.find(x=>x.id===eid && x.recipientId===user.id);if(!e)return json(res,404,{error:'Email not found'});if(action==='favorite')e.favorite=!e.favorite;else e.folder=action==='trash'?'trash':'spam';save(data);return json(res,200,{email:e}); }
    return json(res,404,{error:'Not found'});
  } catch (e) { console.error(e); return json(res,500,{error:'Something went wrong.'}); }
}).listen(process.env.PORT || 3000, () => console.log('PhoneMail running on port 3000'));
