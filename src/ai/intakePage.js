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
<!-- EXIF reader for the client-side photo age pre-check (fails open if it can't load). -->
<script src="https://cdn.jsdelivr.net/npm/exifr/dist/full.umd.js"></script>
<!-- In-browser object detection for the client-side "is it a vehicle" check. -->
<script src="https://cdn.jsdelivr.net/npm/@tensorflow/tfjs"></script>
<script src="https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd"></script>
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

// Client-side photo pre-check limits (the server re-checks all of these).
const ALLOWED_TYPES = ['image/jpeg','image/png','image/webp','image/gif'];
const MAX_PHOTO_BYTES = 15 * 1024 * 1024; // 15 MB — matches the server ceiling.
const MAX_PHOTO_AGE_DAYS = 7;

// COCO-SSD classes we treat as a "vehicle" for the basic frontend check.
const VEHICLE_CLASSES = ['car','truck','bus','motorcycle'];
const VEHICLE_MIN_SCORE = 0.5;

// Lazy-load the object-detection model once, then cache it. Returns null if the
// CDN failed to load, so the check degrades gracefully (photo is allowed).
let _cocoModel = null;
async function loadVehicleModel() {
  if (_cocoModel) return _cocoModel;
  if (!window.cocoSsd) return null;
  _cocoModel = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
  return _cocoModel;
}

// Run in-browser detection on a File.
//  -> { ok:true }      a vehicle was found
//  -> { ok:false }     ran successfully, no vehicle found
//  -> { skip:true }    could not run (model/CDN unavailable) — caller should allow
async function detectVehicle(file) {
  let model;
  try { model = await loadVehicleModel(); } catch (e) { return { skip: true }; }
  if (!model) return { skip: true };
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = url;
    });
    const preds = await model.detect(img);
    const hit = preds.some(p => VEHICLE_CLASSES.includes(p.class) && p.score >= VEHICLE_MIN_SCORE);
    return { ok: hit };
  } catch (e) {
    return { skip: true };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Best-effort device location. Captured once on load; may stay null if the
// claimant denies permission or the browser can't get a fix. Sent with each
// turn so the assistant can OFFER it as the incident location (never assumed).
let geo = null;
if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition(
    p => { geo = { latitude: p.coords.latitude, longitude: p.coords.longitude }; },
    () => { geo = null; },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
  );
}

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
      body: JSON.stringify({ messages, userMessage, images: opts.images || [], coordinates: geo })
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
  if (busy || done) { fileInput.value=''; return; }

  // 0) Instant client-side pre-checks — reject wrong type, oversized, or stale
  //    photos before spending an upload or a server vision call. The server
  //    still re-checks all of this, so these are UX only, not the source of truth.
  if (!ALLOWED_TYPES.includes(f.type)) {
    banner('err', 'Please upload a JPG, PNG, WebP or GIF image.'); fileInput.value=''; return;
  }
  if (f.size > MAX_PHOTO_BYTES) {
    banner('err', 'That image is too large — please upload one under 15 MB.'); fileInput.value=''; return;
  }
  try {
    if (window.exifr) {
      const meta = await exifr.parse(f).catch(() => null);
      const taken = meta && (meta.DateTimeOriginal || meta.CreateDate);
      if (taken) {
        const ageDays = Math.floor((Date.now() - new Date(taken).getTime()) / 86400000);
        if (ageDays > MAX_PHOTO_AGE_DAYS) {
          banner('err', 'This photo was taken ' + ageDays + ' days ago — please upload a photo taken within the last ' + MAX_PHOTO_AGE_DAYS + ' days.');
          fileInput.value=''; return;
        }
      }
      // No capture date (EXIF stripped) → allow; the server makes the final call.
    }
  } catch (e) { /* EXIF unreadable — allow; server still validates. */ }

  // 1) Validate the photo BEFORE uploading.
  banner('typing', 'checking photo…');
  try {
    // 1a) In-browser vehicle check. Rejects photos where no car/truck/bus/
    //     motorcycle is detected. Skips (allows) if the model couldn't load.
    const veh = await detectVehicle(f);
    if (veh.ok === false) {
      banner('err', "That photo doesn't look like a vehicle. Please upload a clear photo of the car, the damage, or the accident scene.");
      fileInput.value=''; return;
    }
    // 1b) Server relevance check (also accepts documents like a licence/sticker).
    const vfd = new FormData(); vfd.append('image', f);
    const vr = await fetch('/ai/claim-intake/' + TOKEN + '/validate-photo', { method:'POST', body: vfd });
    const v = await vr.json();
    if (!vr.ok) { banner('err', v.message || 'Could not check the photo.'); fileInput.value=''; return; }
    if (!v.valid) {
      banner('err', (v.reason || "That photo doesn't look claim-related.") + ' Please upload a photo of the vehicle, the damage, the accident scene, or a document.');
      fileInput.value=''; return;
    }
    // 2) Upload the accepted photo to storage.
    banner('typing', 'uploading photo…');
    const fd = new FormData(); fd.append('image', f);
    const r = await fetch('/images/upload', { method:'POST', body: fd });
    const d = await r.json();
    if (d.url) {
      addBubble('me', 'I have attached a photo.', d.url);
      persist();
      // 3) Send the URL as a real image so the assistant can SEE it.
      send('I have attached a photo.', { hidden: true, images: [d.url] });
    } else banner('err', 'Photo upload failed.');
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
