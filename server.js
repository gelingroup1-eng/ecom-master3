// E-Com Pulse DZ — سيرفر الربط مع Aranex (EcoTrack)
// بدون أي مكتبات خارجية. يتطلب Node.js 18 أو أحدث.
// التشغيل:  node server.js   ثم افتح http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // محلي فقط حتى لا يُكشف التوكن على الشبكة
const CFG_FILE = path.join(__dirname, 'config.json');
const MIN_GAP_MS = 1300; // EcoTrack يسمح بـ 50 طلب/دقيقة

function loadCfg() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch (_) {}
  return {
    token: (process.env.ARANEX_TOKEN || c.token || '').trim(),
    baseUrl: (process.env.ARANEX_URL || c.baseUrl || 'https://aranex.ecotrack.dz').trim().replace(/\/+$/, '')
  };
}
function saveCfg(patch) {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch (_) {}
  fs.writeFileSync(CFG_FILE, JSON.stringify({ ...c, ...patch }, null, 2), { mode: 0o600 });
}

// ---------- طابور بسيط يحترم حد الطلبات ----------
let chain = Promise.resolve();
let lastCall = 0;
function throttled(fn) {
  const run = chain.then(async () => {
    const wait = Math.max(0, lastCall + MIN_GAP_MS - Date.now());
    if (wait) await new Promise(r => setTimeout(r, wait));
    try { return await fn(); } finally { lastCall = Date.now(); }
  });
  chain = run.catch(() => {});
  return run;
}

// ---------- نداء EcoTrack ----------
async function eco(method, endpoint, params = {}, { raw = false, cfg = loadCfg() } = {}) {
  if (!cfg.token) throw new Error('لم يتم إدخال التوكن بعد. ضعه في صفحة إعدادات API أو في config.json');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach(x => qs.append(k + '[]', x));
    else if (v !== undefined && v !== null && v !== '') qs.append(k, String(v));
  }
  const url = `${cfg.baseUrl}/api/v1/${endpoint}${qs.toString() ? '?' + qs : ''}`;
  return throttled(async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(url, {
        method,
        headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/json' },
        signal: ctrl.signal
      });
      if (raw) return res;
      const text = await res.text();
      let body; try { body = JSON.parse(text); } catch (_) { body = { message: text.slice(0, 300) }; }
      return { status: res.status, body };
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'انتهت مهلة الاتصال بـ Aranex' : 'تعذر الوصول إلى Aranex: ' + e.message);
    } finally { clearTimeout(t); }
  });
}
const isOk = b => b && (b.success === true || b.success === 1 || b.success === '1' || b.success === 'true');
const errMsg = b => {
  if (!b) return 'رد فارغ';
  if (b.errors && typeof b.errors === 'object') return Object.values(b.errors).flat().join(' | ');
  return b.message || b.error || JSON.stringify(b).slice(0, 300);
};

// ---------- أدوات ----------
function localPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('00213')) d = '0' + d.slice(5);
  else if (d.startsWith('213')) d = '0' + d.slice(3);
  else if (d.length === 9) d = '0' + d;
  return d;
}
function norm(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function mapStatus(raw) {
  const s = norm(raw);
  if (/retour|return|retourn/.test(s)) return 'RETOUR';
  if (/\blivre\b|delivered|encaisse/.test(s)) return 'LIVRE';
  return 'DISPATCHED';
}
function rowsOf(body) {
  const rows = {};
  const add = (k, m) => { if (m && typeof m === 'object') rows[k || m.tracking] = m; };
  let v = body;
  if (v && !Array.isArray(v) && v.data) v = v.data;
  if (Array.isArray(v)) v.forEach(m => m && m.tracking && add(m.tracking, m));
  else if (v && typeof v === 'object') Object.entries(v).forEach(([k, m]) => add(k, m));
  return rows;
}

// ---------- المسارات ----------
async function handleApi(req, res, url, body) {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const p = url.pathname;

  if (p === '/api/aranex/status') {
    const c = loadCfg();
    return send(200, { configured: !!c.token, baseUrl: c.baseUrl });
  }

  if (p === '/api/aranex/test') {
    try {
      const c = loadCfg();
      const r = await eco('GET', 'validate/token', { api_token: c.token }, { cfg: c });
      const b = r.body || {};
      if (r.status === 200 && isOk(b) && String(b.message).toUpperCase() === 'VALID_TOKEN')
        return send(200, { success: true, baseUrl: c.baseUrl });
      if (b.message === 'TOKEN_NOT_ALLOWED') return send(400, { success: false, error: 'الوصول عبر API غير مفعّل في حسابك — اطلب تفعيله من Aranex' });
      return send(401, { success: false, error: 'التوكن غير صحيح أو منتهي (' + errMsg(b) + ')' });
    } catch (e) { return send(502, { success: false, error: e.message }); }
  }

  if (p === '/api/aranex/config' && req.method === 'POST') {
    const token = String(body.token || '').trim();
    if (token.length < 10) return send(400, { success: false, error: 'توكن غير صالح' });
    const c = { ...loadCfg(), token };
    try {
      const r = await eco('GET', 'validate/token', { api_token: token }, { cfg: c });
      if (!(r.status === 200 && isOk(r.body))) return send(401, { success: false, error: 'التوكن مرفوض من Aranex: ' + errMsg(r.body) });
      saveCfg({ token });
      return send(200, { success: true });
    } catch (e) { return send(502, { success: false, error: e.message }); }
  }

  if (p === '/api/aranex/communes') {
    try {
      const r = await eco('GET', 'get/communes', { wilaya_id: parseInt(url.searchParams.get('wilaya_id')) || '' });
      let list = Array.isArray(r.body) ? r.body : Object.values(r.body || {});
      list = list.filter(x => x && typeof x === 'object' && x.nom)
        .map(x => ({ nom: x.nom, wilaya_id: x.wilaya_id, has_stop_desk: x.has_stop_desk, code_postal: x.code_postal }));
      return send(200, { success: true, communes: list });
    } catch (e) { return send(502, { success: false, error: e.message }); }
  }

  if (p === '/api/aranex/orders/bulk' && req.method === 'POST') {
    const orders = Array.isArray(body.orders) ? body.orders : [];
    if (!orders.length) return send(400, { success: false, error: 'لا توجد طلبات' });
    if (orders.length > 100) return send(400, { success: false, error: 'الحد الأقصى 100 طلب في الدفعة' });
    const cfg = loadCfg();
    const results = [];
    for (const o of orders) {
      const r = { orderId: o.id, success: false, tracking: '', message: '' };
      try {
        const code = parseInt(String(o.wilaya || '').trim(), 10);
        const phone = localPhone(o.phone);
        const commune = String(o.commune || '').trim();
        const problems = [];
        if (!(code >= 1 && code <= 58)) problems.push('رمز الولاية غير صحيح');
        if (!commune) problems.push('البلدية (commune) ناقصة');
        if (!/^0[5-7]\d{8}$/.test(phone) && !/^0\d{8,9}$/.test(phone)) problems.push('رقم الهاتف غير صحيح');
        if (!String(o.clientName || '').trim()) problems.push('اسم الزبون ناقص');
        if (!(Number(o.totalAmount) >= 0)) problems.push('المبلغ غير صحيح');
        if (o.trackingCode) problems.push('مرسلة مسبقاً برقم ' + o.trackingCode);
        if (problems.length) { r.message = problems.join(' — '); results.push(r); continue; }

        const create = await eco('POST', 'create/order', {
          reference: o.id,
          nom_client: String(o.clientName).trim(),
          telephone: phone,
          adresse: String(o.address || commune).trim(),
          code_wilaya: code,
          commune,
          montant: Math.round(Number(o.totalAmount)),
          produit: `${o.product || ''} x${o.quantity || 1}`.trim(),
          type: 1,
          stop_desk: o.stopDesk ? 1 : 0,
          remarque: o.notes || ''
        }, { cfg });
        const cb = create.body || {};
        const tracking = cb.tracking || (cb.data && cb.data.tracking) || '';
        if (!(isOk(cb) && tracking)) { r.message = 'رفضتها Aranex: ' + errMsg(cb); results.push(r); continue; }
        r.success = true; r.tracking = tracking; r.message = 'تم الإنشاء';

        const val = await eco('POST', 'valid/order', { tracking, ask_collection: 1 }, { cfg });
        const vb = val.body || {};
        if (vb && vb.success !== undefined && !isOk(vb)) r.message = 'أُنشئت (' + tracking + ') لكن لم تُعتمد: ' + errMsg(vb);
        else r.message = 'تم الإرسال والاعتماد';
      } catch (e) { r.message = e.message; }
      results.push(r);
    }
    return send(200, { success: true, results });
  }

  if (p === '/api/aranex/track' && req.method === 'POST') {
    const trackings = (Array.isArray(body.trackings) ? body.trackings : []).filter(Boolean);
    if (!trackings.length) return send(200, { success: true, statuses: {} });
    try {
      const statuses = {};
      for (let i = 0; i < trackings.length; i += 100) {
        const chunk = trackings.slice(i, i + 100);
        const r = await eco('GET', 'get/trackings/info', { trackings: chunk });
        const rows = rowsOf(r.body);
        for (const t of chunk) {
          const row = rows[t]; if (!row) continue;
          const acts = Array.isArray(row.activity) ? row.activity : [];
          const last = acts.length ? acts[acts.length - 1] : null;
          const raw = (last && last.status) || row.status || '';
          statuses[t] = { raw, status: mapStatus(raw), date: last ? `${last.date || ''} ${last.time || ''}`.trim() : '' };
        }
      }
      return send(200, { success: true, statuses });
    } catch (e) { return send(502, { success: false, error: e.message }); }
  }

  if (p === '/api/aranex/label') {
    const tracking = url.searchParams.get('tracking');
    if (!tracking) return send(400, { success: false, error: 'tracking مطلوب' });
    try {
      const r = await eco('GET', 'get/order/label', { tracking }, { raw: true });
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.slice(0, 4).toString() !== '%PDF') return send(502, { success: false, error: 'لم تُرجع Aranex ملف PDF: ' + buf.toString('utf8', 0, 200) });
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${tracking}.pdf"` });
      return res.end(buf);
    } catch (e) { return send(502, { success: false, error: e.message }); }
  }

  if (p === '/api/aranex/cancel' && req.method === 'POST') {
    try {
      const r = await eco('DELETE', 'delete/order', { tracking: body.tracking });
      const b = r.body || {};
      if (b.delete === 'fail' || b.success === false) return send(400, { success: false, error: 'لا يمكن إلغاء الطلب في حالته الحالية' });
      return send(200, { success: true });
    } catch (e) { return send(502, { success: false, error: e.message }); }
  }

  return send(404, { success: false, error: 'مسار غير موجود' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on('end', () => {
      let body = {}; try { body = data ? JSON.parse(data) : {}; } catch (_) {}
      handleApi(req, res, url, body).catch(e => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: e.message })); });
    });
    return;
  }
  // الصفحة الرئيسية فقط (لا يُقدَّم config.json أبداً)
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  res.writeHead(404); res.end('Not found');
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const c = loadCfg();
    console.log(`E-Com Pulse DZ  →  http://localhost:${PORT}`);
    console.log(`Aranex: ${c.baseUrl}  |  التوكن: ${c.token ? 'موجود' : 'غير موجود'}`);
  });
}
module.exports = { server, mapStatus, localPhone };
