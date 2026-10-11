/* ============================================================
   Ở TRỌ — phần dùng chung cho ba cửa API
   Không phụ thuộc thư viện ngoài. Chạy trên Node 18+ của Vercel.
   ============================================================ */

const KHO  = process.env.SUPABASE_URL;
const KHOA = process.env.SUPABASE_SERVICE_KEY;

/* ---------- Trả lời theo đúng khuôn hệ thống cũ ---------- */
function tra(res, ma, than) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(ma).send(JSON.stringify(than));
}
const oK  = (res, text, them) => tra(res, 200, Object.assign({ ok: true,  text }, them || {}));
const loi = (res, ma, text, them) => tra(res, ma, Object.assign({ ok: false, text }, them || {}));

/* ---------- Canh cửa ---------- */
function soSanhAnToan(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
function kiemMa(req) {
  const cho = process.env.INGEST_TOKEN;
  if (!cho) return { ok: false, text: 'Máy chủ chưa khai báo INGEST_TOKEN.' };
  /* Mã chỉ nhận qua header. KHÔNG nhận qua ?token= trên đường dẫn,
     vì đường dẫn bị ghi vào nhật ký máy chủ và lịch sử trình duyệt. */
  const h = req.headers || {};
  const bearer = String(h.authorization || '').replace(/^Bearer\s+/i, '');
  const dua = h['x-token'] || h['x-ingest-token'] || bearer || '';
  if (!soSanhAnToan(dua, cho)) return { ok: false, text: 'Sai mã truy cập.' };
  return { ok: true };
}

/* ---------- Gọi kho dữ liệu ---------- */
async function kho(duong, tuyChon) {
  tuyChon = tuyChon || {};
  if (!KHO || !KHOA) throw new Error('Máy chủ chưa khai báo SUPABASE_URL hoặc SUPABASE_SERVICE_KEY.');
  const r = await fetch(KHO + '/rest/v1/' + duong, {
    method: tuyChon.method || 'GET',
    headers: Object.assign({
      apikey: KHOA,
      Authorization: 'Bearer ' + KHOA,
      'Content-Type': 'application/json',
      Prefer: tuyChon.prefer || 'return=representation'
    }, tuyChon.headers || {}),
    body: tuyChon.body ? JSON.stringify(tuyChon.body) : undefined
  });
  const chu = await r.text();
  let j = null;
  try { j = chu ? JSON.parse(chu) : null; } catch (e) { j = chu; }
  if (!r.ok) {
    const m = (j && (j.message || j.hint || j.details)) || ('Lỗi kho dữ liệu ' + r.status);
    const e = new Error(m); e.ma = r.status; throw e;
  }
  return j;
}

/* ---------- Đọc thân yêu cầu ---------- */
async function docThan(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let chu = '';
  for await (const phan of req) chu += phan;
  if (!chu.trim()) return {};
  try { return JSON.parse(chu); } catch (e) { throw new Error('Thân yêu cầu không phải JSON hợp lệ.'); }
}

/* ---------- Chuẩn hoá mã: K-11, k 11, K11 là một ---------- */
function chuan(x) {
  return String(x == null ? '' : x)
    .normalize('NFC').trim().toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/^P(?=\d)/, '');          // P101 -> 101
}

/* ---------- Dịch vụ: nhận cả có dấu lẫn không dấu ---------- */
const DICH_VU = {
  DIEN: 'dien', ĐIEN: 'dien', ĐIỆN: 'dien', DIENNANG: 'dien', ELECTRIC: 'dien',
  NUOC: 'nuoc', NƯỚC: 'nuoc', WATER: 'nuoc',
  INTERNET: 'internet', WIFI: 'internet', MANG: 'internet',
  RAC: 'rac', ĐOURAC: 'rac', DOURAC: 'rac',
  GUIXE: 'gui_xe', XE: 'gui_xe',
  DICHVUKHAC: 'dich_vu_khac', KHAC: 'dich_vu_khac'
};
/* ---------- Mã hạng mục: giữ dấu gạch dưới, không bóc như mã phòng ---------- */
function maHangMuc(x) {
  return String(x == null ? '' : x).normalize('NFC').trim().toLowerCase()
    .replace(/[\s\-.]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

function dichVu(x) {
  const k = chuan(x).replace(/Ơ/g, 'O');
  return DICH_VU[k] || DICH_VU[k.replace(/[^A-Z_]/g, '')] || null;
}

/* ---------- Kỳ: luôn là ngày 01, theo giờ Việt Nam ---------- */
function kyVN(x) {
  if (x) {
    const s = String(x).trim();
    let m = s.match(/^(\d{4})[-/](\d{1,2})/);            // 2026-09
    if (m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-01';
    m = s.match(/^(\d{1,2})[-/](\d{4})$/);               // 09/2026
    if (m) return m[2] + '-' + String(m[1]).padStart(2, '0') + '-01';
  }
  const d = new Date(Date.now() + 7 * 3600 * 1000);      // bù múi giờ Việt Nam
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-01';
}
function ngayVN() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}
function tien(n) { return (Number(n) || 0).toLocaleString('vi-VN'); }

/* ---------- Danh mục phòng, dùng cho mọi lệnh ---------- */
async function bangPhong() {
  const ds = await kho('phong?select=id,ma_phong,loai,nha_tro_id,nha_tro!inner(id,ma_nha,ten_nha)&order=ma_phong');
  const theoMa = new Map();
  for (const p of ds) {
    theoMa.set(chuan(p.nha_tro.ma_nha) + '|' + chuan(p.ma_phong), p);
  }
  return { ds, theoMa };
}
async function toChucId() {
  const t = await kho('to_chuc?select=id&order=tao_luc&limit=1');
  if (!t || !t.length) throw new Error('Kho dữ liệu chưa có tổ chức nào.');
  return t[0].id;
}

module.exports = {
  kho, tra, oK, loi, kiemMa, docThan, chuan, dichVu, maHangMuc, kyVN, ngayVN, tien,
  bangPhong, toChucId
};
