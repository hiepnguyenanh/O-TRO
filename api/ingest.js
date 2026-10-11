/* ============================================================
   Ở TRỌ — CỬA NHẬP LIỆU CHO BOT TELEGRAM
   POST /api/ingest
   Xác thực: header  Authorization: Bearer <INGEST_TOKEN>
             hoặc    x-token: <INGEST_TOKEN>

   Giữ ĐÚNG khuôn mà nhatro.js đang gửi:
     chi_so   : { loai_ban_ghi:"chi_so", ma_can, ma_phong, loai:"dien|nuoc", so, do_tin_cay }
     xac_nhan : { loai_ban_ghi:"xac_nhan", ma_can, ma_phong, loai }
     bo       : { loai_ban_ghi:"bo", ma_can, ma_phong, loai }
     chi_phi  : { loai_ban_ghi:"chi_phi", ma_can, loai:"<hạng mục>", so, ghi_chu }
     giam_tru : { loai_ban_ghi:"giam_tru", ma_can, ma_phong, so, ghi_chu, ky? }
     su_co    : { loai_ban_ghi:"su_co", ma_can, ma_phong, ghi_chu }

   Gửi một bản ghi lẻ, hoặc { ban_ghi:[...] } tối đa 60.
   Một bản hỏng không làm hỏng cả gói.
   ============================================================ */

const C = require('./_chung');

module.exports = async function (req, res) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const cua = C.kiemMa(req);
  if (!cua.ok) return C.loi(res, 401, cua.text);

  if (req.method === 'GET') {
    return C.oK(res, 'Cửa nhập liệu Ở TRỌ đang sống. Gửi POST kèm "ban_ghi" để ghi dữ liệu.', {
      loai_ban_ghi: ['chi_so', 'xac_nhan', 'bo', 'chi_phi', 'giam_tru', 'su_co'],
      toi_da: 60
    });
  }
  if (req.method !== 'POST') return C.loi(res, 405, 'Chỉ nhận POST.');

  let than;
  try { than = await C.docThan(req); }
  catch (e) { return C.loi(res, 400, e.message); }

  let ds = than.ban_ghi || than.banGhi || than.records || than;
  if (!Array.isArray(ds)) ds = [ds];
  ds = ds.filter(x => x && typeof x === 'object');
  if (!ds.length) return C.loi(res, 400, 'Không có bản ghi nào để ghi.');
  if (ds.length > 60) return C.loi(res, 400, 'Tối đa 60 bản ghi một lần. Gói này có ' + ds.length + '.');

  let phong, tcId;
  try { phong = await C.bangPhong(); tcId = await C.toChucId(); }
  catch (e) { return C.loi(res, 500, 'Không đọc được kho dữ liệu: ' + e.message); }

  const xong = [], hong = [];
  let coChiSo = false;

  for (let i = 0; i < ds.length; i++) {
    const r = ds[i];
    try {
      /* CHÚ Ý: chỉ đọc loai_ban_ghi. Trường "loai" mang nghĩa khác tuỳ lệnh
         — với chỉ số là dien/nuoc, với chi phí là mã hạng mục. */
      const l = String(r.loai_ban_ghi || 'chi_so').toLowerCase().replace(/[^a-z_]/g, '');
      if (l === 'chi_so' || l === 'chiso') { xong.push(await ghiChiSo(r, phong, tcId)); coChiSo = true; }
      else if (l === 'xac_nhan' || l === 'xacnhan' || l === 'duyet') xong.push(await doiTrangThai(r, phong, 'da_duyet'));
      else if (l === 'bo' || l === 'huy') xong.push(await doiTrangThai(r, phong, 'da_bo'));
      else if (l === 'chi_phi' || l === 'chiphi') xong.push(await ghiChiPhi(r, phong, tcId));
      else if (l === 'giam_tru' || l === 'giamtru') xong.push(await ghiGiamTru(r, phong));
      else if (l === 'su_co' || l === 'suco') xong.push(await ghiSuCo(r, phong, tcId));
      else throw new Error('Không hiểu loại bản ghi "' + r.loai_ban_ghi + '".');
    } catch (e) {
      hong.push({ vi_tri: i + 1, ban_ghi: r, ly_do: e.message });
    }
  }

  const dong = [];
  if (xong.length) dong.push('Đã ghi ' + xong.length + ' bản:');
  for (const d of xong) dong.push('  • ' + d.text);
  if (hong.length) {
    dong.push('Không ghi được ' + hong.length + ' bản:');
    for (const h of hong) dong.push('  ✗ bản thứ ' + h.vi_tri + ': ' + h.ly_do);
  }
  if (coChiSo && !hong.length) dong.push('Số vừa ghi đang CHỜ DUYỆT, chưa vào hóa đơn.');

  return C.tra(res, hong.length && !xong.length ? 422 : 200, {
    ok: xong.length > 0,
    text: dong.join('\n'),
    thong_bao: dong.join('\n'),
    so_ghi_duoc: xong.length,
    so_hong: hong.length,
    hong: hong
  });
};

/* ---------- đọc mã căn / mã phòng, nhận cả tên cũ lẫn tên mới ---------- */
function layNha(r)   { return r.ma_can || r.ma_nha || r.maNha || r.can || r.nha; }
function layPhong(r) { return r.ma_phong || r.maPhong || r.phong; }
function timPhong(r, phong) {
  const maNha = layNha(r), maPhong = layPhong(r);
  if (!maNha) throw new Error('Thiếu mã căn.');
  if (!maPhong) throw new Error('Thiếu mã phòng.');
  const p = phong.theoMa.get(C.chuan(maNha) + '|' + C.chuan(maPhong));
  if (!p) throw new Error('Không có phòng ' + maNha + ' ' + maPhong + ' trong hệ thống.');
  return p;
}
function laySo(r, ...ten) {
  for (const t of ten) {
    if (r[t] != null && r[t] !== '') {
      const n = Number(String(r[t]).replace(/[^\d.]/g, ''));
      if (isFinite(n)) return n;
    }
  }
  return null;
}

/* ---------------- ghi chỉ số đồng hồ ---------------- */
async function ghiChiSo(r, phong, tcId) {
  const p = timPhong(r, phong);

  /* "loai" ở đây là dịch vụ: dien / nuoc */
  const dv = C.dichVu(r.loai_dich_vu || r.dich_vu || r.loai || 'dien');
  if (!dv) throw new Error('Không hiểu dịch vụ "' + (r.loai_dich_vu || r.loai) + '".');

  const so = laySo(r, 'chi_so_moi', 'so', 'chi_so');
  if (so == null) throw new Error('Chỉ số mới không phải là số.');
  if (so < 0) throw new Error('Chỉ số mới không được âm.');

  const ky = C.kyVN(r.ky);

  const truoc = await C.kho('chi_so?select=chi_so_moi,ky&phong_id=eq.' + p.id +
    '&loai_dich_vu=eq.' + dv + '&ky=lt.' + ky + '&trang_thai_duyet=neq.da_bo&order=ky.desc&limit=1');
  const cu = truoc && truoc.length ? Number(truoc[0].chi_so_moi)
           : (r.chi_so_cu != null ? Number(r.chi_so_cu) : null);

  if (cu != null && so < cu)
    throw new Error('Chỉ số mới ' + so + ' nhỏ hơn kỳ trước ' + cu +
      '. Đồng hồ không quay ngược — kiểm tra lại ảnh.');

  /* độ tin cậy thấp thì ghi rõ vào ghi chú để người duyệt biết mà soi kỹ */
  const ghiChu = [r.ghi_chu || r.ghiChu || null,
                  r.do_tin_cay === 'thap' ? 'AI đọc với độ tin cậy THẤP — soi lại ảnh' : null]
                 .filter(Boolean).join(' · ') || null;

  await C.kho('chi_so?on_conflict=phong_id,ky,loai_dich_vu', {
    method: 'POST',
    body: [{
      to_chuc_id: tcId, phong_id: p.id, ky: ky, loai_dich_vu: dv,
      chi_so_cu: cu, chi_so_moi: so,
      nguon: 'tro_ly_ai', trang_thai_duyet: 'cho_duyet',
      anh_cong_to: r.anh_cong_to || r.anh || null,
      ghi_chu: ghiChu
    }],
    prefer: 'resolution=merge-duplicates,return=representation'
  });

  const tieuThu = cu != null ? (so - cu) : null;
  return { text: C.chuan(layNha(r)) + ' ' + p.ma_phong + ' ' + ten(dv) + ': ' + so +
    (tieuThu != null ? ' (kỳ trước ' + cu + ', dùng ' + tieuThu + ')' : ' (chưa có số kỳ trước)') +
    (r.do_tin_cay === 'thap' ? ' ⚠ tin cậy thấp' : '') + ' — chờ duyệt' };
}

/* ---------------- duyệt hoặc bỏ ---------------- */
async function doiTrangThai(r, phong, trangThai) {
  const p = timPhong(r, phong);
  const dv = C.dichVu(r.loai_dich_vu || r.dich_vu || r.loai || 'dien');
  if (!dv) throw new Error('Không hiểu dịch vụ cần ' + (trangThai === 'da_duyet' ? 'duyệt' : 'bỏ') + '.');
  const ky = C.kyVN(r.ky);

  const kq = await C.kho('chi_so?phong_id=eq.' + p.id + '&ky=eq.' + ky + '&loai_dich_vu=eq.' + dv, {
    method: 'PATCH', body: { trang_thai_duyet: trangThai }
  });
  if (!kq || !kq.length)
    throw new Error('Không tìm thấy chỉ số ' + ten(dv) + ' kỳ ' + ky.slice(5, 7) + '/' + ky.slice(0, 4) + ' của phòng này.');

  return { text: C.chuan(layNha(r)) + ' ' + p.ma_phong + ' ' + ten(dv) + ' — đã ' +
    (trangThai === 'da_duyet' ? 'DUYỆT, số ' + kq[0].chi_so_moi + ' vào được hóa đơn' : 'BỎ') };
}

/* ---------------- ghi một khoản chi ---------------- */
async function ghiChiPhi(r, phong, tcId) {
  const soTien = laySo(r, 'so_tien', 'so', 'tien');
  if (soTien == null || soTien <= 0) throw new Error('Số tiền không hợp lệ.');

  /* "loai" ở đây là MÃ HẠNG MỤC, không phải dịch vụ */
  const hangMuc = C.maHangMuc(r.hang_muc || r.hangMuc || r.loai || 'khac');
  const co = await C.kho('hang_muc_thu_chi?select=ma,ten,loai&ma=eq.' + encodeURIComponent(hangMuc));
  if (!co || !co.length || co[0].loai !== 'chi') {
    const tatCa = await C.kho('hang_muc_thu_chi?select=ma&loai=eq.chi&order=ma');
    throw new Error('Không có hạng mục chi "' + hangMuc + '". Hạng mục hợp lệ: ' +
      tatCa.map(x => x.ma).join(', '));
  }

  let nhaId = null, maNhaHien = 'chung';
  const maNha = layNha(r);
  if (maNha) {
    const p = [...phong.theoMa.values()].find(x => C.chuan(x.nha_tro.ma_nha) === C.chuan(maNha));
    if (!p) throw new Error('Không có căn ' + maNha + '.');
    nhaId = p.nha_tro.id; maNhaHien = C.chuan(maNha);
  }

  await C.kho('thu_chi', {
    method: 'POST',
    body: [{
      to_chuc_id: tcId, nha_tro_id: nhaId, loai: 'chi', hang_muc: hangMuc,
      so_tien: soTien, ngay: r.ngay || C.ngayVN(),
      hinh_thuc: r.hinh_thuc || 'tien_mat',
      dien_giai: r.dien_giai || r.ghi_chu || r.mo_ta || co[0].ten
    }]
  });

  return { text: 'Chi ' + maNhaHien + ' — ' + co[0].ten + ' ' + C.tien(soTien) + ' đ đã vào sổ quỹ' };
}

/* ---------------- giảm trừ trên hóa đơn một phòng ---------------- */
async function ghiGiamTru(r, phong) {
  const p = timPhong(r, phong);
  const soTien = laySo(r, 'so_tien', 'so', 'tien');
  if (soTien == null || soTien <= 0) throw new Error('Số tiền giảm trừ phải là số dương.');

  const lyDo = String(r.ghi_chu || r.ly_do || r.dien_giai || '').trim();
  if (!lyDo) throw new Error('Thiếu lý do giảm trừ. Một khoản trừ không lý do là thứ không giải thích được với khách.');

  const ky = C.kyVN(r.ky);
  const hd = await C.kho('hoa_don?select=id,so_hoa_don,tien_phong,tien_dich_vu,no_ky_truoc,khau_tru,ly_do_khau_tru,tong_tien,da_thanh_toan' +
    '&phong_id=eq.' + p.id + '&ky=eq.' + ky + '&limit=1');
  if (!hd || !hd.length)
    throw new Error('Chưa có hóa đơn kỳ ' + ky.slice(5, 7) + '/' + ky.slice(0, 4) +
      ' cho phòng này. Phát hành hóa đơn trước rồi ghi giảm trừ.');

  const h = hd[0];
  const khauTruMoi = Number(h.khau_tru || 0) + soTien;
  const tongMoi = Number(h.tien_phong || 0) + Number(h.tien_dich_vu || 0) +
                  Number(h.no_ky_truoc || 0) - khauTruMoi;
  if (tongMoi < Number(h.da_thanh_toan || 0))
    throw new Error('Giảm trừ ' + C.tien(soTien) + ' đ làm hóa đơn nhỏ hơn số khách đã trả. Kiểm tra lại.');

  const ly = [h.ly_do_khau_tru || null, lyDo].filter(Boolean).join(' · ');
  await C.kho('hoa_don?id=eq.' + h.id, {
    method: 'PATCH',
    body: { khau_tru: khauTruMoi, ly_do_khau_tru: ly, tong_tien: tongMoi }
  });

  return { text: 'Giảm trừ ' + C.tien(soTien) + ' đ cho ' + C.chuan(layNha(r)) + ' ' + p.ma_phong +
    ' (' + lyDo + '). Hóa đơn ' + h.so_hoa_don + ' còn ' + C.tien(tongMoi) + ' đ.' };
}

/* ---------------- ghi một sự cố ---------------- */
async function ghiSuCo(r, phong, tcId) {
  const noiDung = r.noi_dung || r.ghi_chu || r.noiDung || r.mo_ta || r.dien_giai;
  if (!noiDung) throw new Error('Thiếu nội dung sự cố.');

  const maNha = layNha(r), maPhong = layPhong(r);
  const p = maPhong ? timPhong(r, phong) : null;

  await C.kho('nhat_ky', {
    method: 'POST',
    body: [{
      to_chuc_id: tcId, hanh_dong: 'su_co',
      bang: 'phong', ban_ghi_id: p ? String(p.id) : null,
      noi_dung: {
        nguon: 'tro_ly_ai',
        ma_nha: maNha ? C.chuan(maNha) : null,
        ma_phong: p ? p.ma_phong : null,
        mo_ta: String(noiDung),
        ngay: C.ngayVN()
      }
    }]
  });

  return { text: 'Sự cố đã ghi nhật ký: ' + (maNha ? C.chuan(maNha) + ' ' : '') +
    (p ? p.ma_phong + ' ' : '') + noiDung };
}

function ten(dv) {
  return { dien: 'điện', nuoc: 'nước', internet: 'internet', rac: 'đổ rác',
           gui_xe: 'gửi xe', dich_vu_khac: 'dịch vụ khác' }[dv] || dv;
}
