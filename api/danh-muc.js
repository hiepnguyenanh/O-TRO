/* ============================================================
   Ở TRỌ — DANH MỤC CHO BOT ĐỐI CHIẾU TRƯỚC KHI GHI
   GET /api/danh-muc        header: x-token: <INGEST_TOKEN>
   GET /api/danh-muc?ky=2026-09

   Trả về: danh sách mã căn, mã phòng CÓ THẬT, danh sách hạng mục chi,
   và danh sách phòng CÒN THIẾU chỉ số kỳ này.
   Bot dùng để chống đọc nhầm chữ O với số 0.
   ============================================================ */

const C = require('./_chung');

module.exports = async function (req, res) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  const cua = C.kiemMa(req);
  if (!cua.ok) return C.loi(res, 401, cua.text);
  if (req.method !== 'GET') return C.loi(res, 405, 'Chỉ nhận GET.');

  try {
    const url = new URL(req.url, 'http://x');
    const ky = C.kyVN(url.searchParams.get('ky'));

    const [ds, chiSo, hangMuc] = await Promise.all([
      C.kho('phong?select=id,ma_phong,loai,nha_tro!inner(ma_nha,ten_nha)&order=ma_phong'),
      C.kho('chi_so?select=phong_id,loai_dich_vu,trang_thai_duyet&ky=eq.' + ky + '&trang_thai_duyet=neq.da_bo'),
      C.kho('hang_muc_thu_chi?select=ma,ten,loai&order=ma')
    ]);

    const daCo = new Set(chiSo.map(c => c.phong_id + '|' + c.loai_dich_vu));
    const choDuyet = chiSo.filter(c => c.trang_thai_duyet === 'cho_duyet').length;

    const theoNha = {};
    const thieu = [];
    for (const p of ds) {
      const ma = p.nha_tro.ma_nha;
      (theoNha[ma] = theoNha[ma] || { ten_nha: p.nha_tro.ten_nha, phong: [] }).phong.push(p.ma_phong);
      if (!daCo.has(p.id + '|dien')) thieu.push(ma + ' ' + p.ma_phong);
    }

    const dong = [];
    dong.push('Kỳ ' + ky.slice(5, 7) + '/' + ky.slice(0, 4) + ' · ' +
      Object.keys(theoNha).length + ' căn · ' + ds.length + ' phòng.');
    for (const ma of Object.keys(theoNha).sort()) {
      dong.push(ma + ': ' + theoNha[ma].phong.join(', '));
    }
    dong.push(thieu.length
      ? 'Còn thiếu chỉ số điện ' + thieu.length + ' phòng: ' + thieu.join(', ')
      : 'Đã đủ chỉ số điện cả ' + ds.length + ' phòng.');
    if (choDuyet) dong.push(choDuyet + ' chỉ số đang chờ duyệt.');

    return C.oK(res, dong.join('\n'), {
      ky: ky,
      nha: theoNha,
      thieu_chi_so_dien: thieu,
      cho_duyet: choDuyet,
      hang_muc_chi: hangMuc.filter(h => h.loai === 'chi').map(h => h.ma),
      hang_muc_thu: hangMuc.filter(h => h.loai === 'thu').map(h => h.ma),
      dich_vu: ['dien', 'nuoc', 'internet', 'rac', 'gui_xe', 'dich_vu_khac']
    });
  } catch (e) {
    return C.loi(res, 500, 'Không đọc được kho dữ liệu: ' + e.message);
  }
};
