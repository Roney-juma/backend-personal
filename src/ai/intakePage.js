/**
 * Self-contained browser chat page for conversational claim filing.
 * Served by GET /ai/claim-intake/:token — open the link and chat.
 * All requests are same-origin (POST /ai/claim-intake/:token, /images/upload).
 */
function renderIntakePage(token) {
  const safeToken = String(token).replace(/[^a-zA-Z0-9_-]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>File a Claim — AVE Insurance</title>
<style>
  :root{--navy:#13294a;--blue:#2a6fc0;--bg:#eef2f7;--ai:#fff;--me:#2a6fc0}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:#1c2735;height:100vh;display:flex;flex-direction:column}
  header{background:var(--navy);color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px}
  header b{font-size:16px}
  header span{font-size:12px;opacity:.8;margin-left:auto}
  #log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
  .row{display:flex}
  .row.me{justify-content:flex-end}
  .bubble{max-width:80%;padding:10px 13px;border-radius:14px;line-height:1.45;font-size:14.5px;white-space:pre-wrap;word-wrap:break-word}
  .ai .bubble{background:var(--ai);border:1px solid #dde4ee;border-bottom-left-radius:4px}
  .me .bubble{background:var(--me);color:#fff;border-bottom-right-radius:4px}
  .bubble img{max-width:160px;border-radius:8px;display:block;margin-top:6px}
  .typing{font-size:13px;color:#7a889b;padding:0 4px}
  .ok{background:#e7f7ef;border:1px solid #b6e3cc;color:#155e3c;padding:12px;border-radius:10px;text-align:center;font-weight:600}
  .err{background:#fdecec;border:1px solid #f3b6b6;color:#9b2222;padding:12px;border-radius:10px;text-align:center}
  footer{padding:10px;background:#fff;border-top:1px solid #dde4ee;display:flex;gap:8px;align-items:flex-end}
  textarea{flex:1;resize:none;border:1px solid #cfd8e6;border-radius:12px;padding:10px 12px;font:inherit;font-size:14.5px;max-height:120px}
  button{border:0;border-radius:12px;padding:0 16px;height:42px;font:inherit;font-weight:600;cursor:pointer}
  #send{background:var(--blue);color:#fff}
  #attach{background:#eef2f7;color:var(--navy);width:42px;padding:0;font-size:18px}
  button:disabled{opacity:.5;cursor:default}
</style>
</head>
<body>
  <header><b>File a Claim</b><span>AVE Insurance · AI assistant</span></header>
  <div id="log"></div>
  <footer>
    <input id="file" type="file" accept="image/*" hidden>
    <button id="attach" title="Attach a photo">+</button>
    <textarea id="msg" rows="1" placeholder="Type your message…"></textarea>
    <button id="send">Send</button>
  </footer>

<script>
const TOKEN = ${JSON.stringify(safeToken)};
const KEY = 'claim:' + TOKEN;
const log = document.getElementById('log');
const input = document.getElementById('msg');
const sendBtn = document.getElementById('send');
const fileInput = document.getElementById('file');
let messages = [];
let busy = false, done = false;

// restore prior session if the page was refreshed
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
  if (saved && saved.messages) { messages = saved.messages; (saved.transcript||[]).forEach(t => addBubble(t.who, t.text, t.img)); }
} catch (e) {}

function addBubble(who, text, img) {
  const row = document.createElement('div'); row.className = 'row ' + who;
  const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text || '';
  if (img) { const im = document.createElement('img'); im.src = img; b.appendChild(im); }
  row.appendChild(b); log.appendChild(row); log.scrollTop = log.scrollHeight;
  return b;
}
function banner(cls, text){ const d=document.createElement('div'); d.className='row'; const i=document.createElement('div'); i.className=cls; i.textContent=text; i.style.margin='8px auto'; d.appendChild(i); log.appendChild(d); log.scrollTop=log.scrollHeight; }
function persist(){ const transcript=[...log.querySelectorAll('.row')].filter(r=>r.querySelector('.bubble')).map(r=>({who:r.classList.contains('me')?'me':'ai',text:r.querySelector('.bubble').firstChild?.textContent||'',img:r.querySelector('img')?.src})); localStorage.setItem(KEY, JSON.stringify({messages, transcript})); }

let typingEl = null;
function showTyping(on){ if(on){ typingEl=document.createElement('div'); typingEl.className='typing'; typingEl.textContent='assistant is typing…'; log.appendChild(typingEl); log.scrollTop=log.scrollHeight; } else if(typingEl){ typingEl.remove(); typingEl=null; } }

async function send(userMessage, opts = {}) {
  if (busy || done) return;
  busy = true; sendBtn.disabled = true;
  if (!opts.hidden) addBubble('me', userMessage, opts.img);
  showTyping(true);
  try {
    const res = await fetch('/ai/claim-intake/' + TOKEN, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, userMessage })
    });
    const data = await res.json();
    showTyping(false);
    if (!res.ok) { banner('err', data.message || ('Error ' + res.status)); if (res.status===401||res.status===410) done = true; return; }
    messages = data.messages || messages;
    addBubble('ai', data.reply);
    if (data.status === 'submitted') { banner('ok', '✅ Claim filed successfully. Reference: ' + data.claimId); done = true; input.disabled = true; }
    persist();
  } catch (e) { showTyping(false); banner('err', 'Network error — please try again.'); }
  finally { busy = false; sendBtn.disabled = done; }
}

sendBtn.onclick = () => { const t = input.value.trim(); if (t) { input.value=''; input.style.height='auto'; send(t); } };
input.addEventListener('keydown', e => { if (e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendBtn.onclick(); } });
input.addEventListener('input', () => { input.style.height='auto'; input.style.height=Math.min(input.scrollHeight,120)+'px'; });

document.getElementById('attach').onclick = () => fileInput.click();
fileInput.onchange = async () => {
  const f = fileInput.files[0]; if (!f) return;
  const fd = new FormData(); fd.append('image', f);
  banner('typing', 'uploading photo…');
  try {
    const r = await fetch('/images/upload', { method:'POST', body: fd });
    const d = await r.json();
    if (d.url) { addBubble('me', 'I have attached a photo of the damage.', d.url); persist(); send('Here is a photo of the damage: ' + d.url, { hidden: true }); }
    else banner('err', 'Photo upload failed.');
  } catch(e){ banner('err','Photo upload failed.'); }
  fileInput.value='';
};

// kick off the conversation (greeting) unless we're resuming
if (messages.length === 0) send("Hi, I'd like to report an accident and file a claim.", { hidden: true });
</script>
</body>
</html>`;
}

module.exports = { renderIntakePage };
