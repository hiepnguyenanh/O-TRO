/* ============================================================
   Ở TRỌ — BÁO CÁO NHANH CHO BOT TELEGRAM
   GET /api/bao-cao?loai=<...>
   Xác thực: Authorization: Bearer <INGEST_TOKEN> hoặc x-token

   Đúng năm loại mà nhatro.js đang gọi:
     lailo       lãi lỗ từng căn
     trong       phòng trống, phòng sắp hết hạn
     chiso       chỉ số kỳ này: đã có bao nhiêu, còn thiếu phòng nào
     canxacnhan  chỉ số Trợ Lý AI đọc, đang chờ người duyệt
     thutien     ai còn nợ, nợ bao nhiêu, quá hạn mấy ngày

   Trả về đoạn chữ tiếng Việt, bot đọc nguyên văn cho người dùng.
   ============================================================ */

const C = require('./_chung');

module.exports = async function (req, res) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  const cua = C.kiemMa(req);
  if (!cua.ok) return C.loi(res, 401, cua.text);
  if (req.method !== 'GET') return C.loi(res, 405, 'Chỉ nhận GET.');

  try {
    const url = new URL(req.url, 'http://x');
    const loai = String(url.searchParams.get('loai') || 'lailo').toLowerCase().replace(/[^a-z]/g, '');
    const ky = C.kyVN(url.searchParams.get('ky'));

    if (loai === 'lailo') return await lailo(res);
    if (loai === 'trong' || loai === 'phong' || loai === 'nha') return await trong(res);
    if (loai === 'chiso') return await chiso(res, ky);
    if (loai === 'canxacnhan' || loai === 'choduyet') return await canXacNhan(res, ky);
    if (loai === 'thutien' || loai === 'congno' || loai === 'no') return await thuTien(res);
    if (loai === 'tomtat') return await tomTat(res);

    return C.loi(res, 400, 'Không biết loại báo cáo "' + loai + '". Dùng một trong: ' +
      'lailo, trong, chiso, canxacnhan, thutien, tomtat.');
  } catch (e) {
    return C.loi(res, 500, 'Không đọc được kho dữ liệu: ' + e.message);
  }
};

/* ---------------- lãi lỗ ---------------- */
async function lailo(res) {
  const ll = await C.kho('v_lai_lo_tung_can?select=*&order=ma_nha');
  const d = ['Lãi lỗ từng căn:'];
  let tong = 0;
  for (const r of ll) {
    const lai = Number(r.lai_lo_thang) || 0; tong += lai;
    const duoi = r.ty_le_lap_day != null && r.nguong_hoa_von != null &&
                 Number(r.ty_le_lap_day) < Number(r.nguong_hoa_von);
    d.push('  ' + r.ma_nha + ': ' + dau(lai) + C.tien(Math.abs(lai)) + ' đ' +
      ' · lấp đầy ' + pt(r.ty_le_lap_day) + ' · hòa vốn ' + pt(r.nguong_hoa_von) +
      (duoi ? '  ⚠ DƯỚI HÒA VỐN' : ''));
  }
  d.push('Tổng: ' + dau(tong) + C.tien(Math.abs(tong)) + ' đ mỗi tháng.');
  return C.oK(res, d.join('\n'), { chi_tiet: ll });
}

/* ---------------- phòng trống ---------------- */
async function trong(res) {
  const [ps, gh] = await Promise.all([
    C.kho('v_phong?select=ma_nha,ma_phong,gia_thue,trang_thai,sap_het_han,hop_dong_het_han,khach_thue&order=ma_nha,ma_phong'),
    C.kho('v_can_gia_han?select=ma_nha,ma_phong,khach_thue,ngay_ket_thuc,so_ngay_qua_han&order=so_ngay_qua_han.desc')
  ]);
  const trongDs = ps.filter(p => p.trang_thai === 'dang_trong');
  const sap = ps.filter(p => p.sap_het_han);
  const d = [];
  d.push(trongDs.length
    ? 'Đang trống ' + trongDs.length + '/' + ps.length + ' phòng, mất ' +
      C.tien(trongDs.reduce((a, p) => a + (+p.gia_thue || 0), 0)) + ' đ mỗi tháng:'
    : 'Không có phòng nào trống. Đủ khách cả ' + ps.length + ' phòng.');
  for (const p of trongDs) d.push('  ' + p.ma_nha + ' ' + p.ma_phong + ' · ' + C.tien(p.gia_thue) + ' đ');
  if (sap.length) {
    d.push('Sắp hết hạn hợp đồng ' + sap.length + ' phòng:');
    for (const p of sap.slice(0, 10)) d.push('  ' + p.ma_nha + ' ' + p.ma_phong + ' · ' + (p.khach_thue || '—'));
  }
  if (gh.length) {
    d.push('Hợp đồng ĐÃ hết hạn mà khách vẫn ở: ' + gh.length + ' phòng.');
    for (const g of gh.slice(0, 8))
      d.push('  ' + g.ma_nha + ' ' + g.ma_phong + ' · ' + (g.khach_thue || '—') + ' · quá ' + g.so_ngay_qua_han + ' ngày');
    if (gh.length > 8) d.push('  … và ' + (gh.length - 8) + ' phòng nữa.');
  }
  return C.oK(res, d.join('\n'), { trong: trongDs, sap_het_han: sap, het_han: gh });
}

/* ---------------- chỉ số kỳ này ---------------- */
async function chiso(res, ky) {
  const [ps, cs] = await Promise.all([
    C.kho('phong?select=id,ma_phong,nha_tro!inner(ma_nha)&order=ma_phong'),
    C.kho('chi_so?select=phong_id,loai_dich_vu,chi_so_cu,chi_so_moi,trang_thai_duyet,nguon&ky=eq.' + ky + '&trang_thai_duyet=neq.da_bo')
  ]);
  const ten = {}; ps.forEach(p => ten[p.id] = p.nha_tro.ma_nha + ' ' + p.ma_phong);
  const coDien = new Set(cs.filter(c => c.loai_dich_vu === 'dien').map(c => c.phong_id));
  const thieu = ps.filter(p => !coDien.has(p.id)).map(p => ten[p.id]);
  const cho = cs.filter(c => c.trang_thai_duyet === 'cho_duyet');

  const d = ['Chỉ số kỳ ' + ky.slice(5, 7) + '/' + ky.slice(0, 4) + ':'];
  d.push('  Đã có ' + coDien.size + '/' + ps.length + ' phòng có chỉ số điện.');
  if (thieu.length) {
    d.push('  Còn thiếu ' + thieu.length + ' phòng: ' + thieu.join(', '));
  } else {
    d.push('  Đủ cả ' + ps.length + ' phòng.');
  }
  d.push(cho.length ? '  Chờ duyệt: ' + cho.length + ' chỉ số.' : '  Không có gì chờ duyệt.');
  return C.oK(res, d.join('\n'), { ky: ky, thieu: thieu, cho_duyet: cho.length });
}

/* ---------------- chỉ số chờ duyệt ---------------- */
async function canXacNhan(res, ky) {
  const cs = await C.kho('chi_so?select=ky,loai_dich_vu,chi_so_cu,chi_so_moi,nguon,ghi_chu,tao_luc,' +
    'phong!inner(ma_phong,nha_tro!inner(ma_nha))&trang_thai_duyet=eq.cho_duyet&order=tao_luc.desc');
  if (!cs.length) return C.oK(res, 'Không có chỉ số nào chờ duyệt. Sạch.', { chi_tiet: [] });

  const noi = c => (c.phong && c.phong.nha_tro ? c.phong.nha_tro.ma_nha + ' ' : '') +
                   (c.phong ? c.phong.ma_phong : '(không rõ phòng)');
  const d = ['Có ' + cs.length + ' chỉ số chờ duyệt:'];
  for (const c of cs) {
    const dung = (c.chi_so_cu != null && c.chi_so_moi != null)
      ? ' · dùng ' + (Number(c.chi_so_moi) - Number(c.chi_so_cu)) : '';
    d.push('  ' + noi(c) + ' ' + tenDv(c.loai_dich_vu) +
      ': ' + c.chi_so_moi + (c.chi_so_cu != null ? ' (kỳ trước ' + c.chi_so_cu + ')' : '') + dung +
      (c.ghi_chu ? ' · ' + c.ghi_chu : ''));
  }
  d.push('Duyệt bằng câu: duyệt <căn> <phòng> <dịch vụ>. Ví dụ: duyệt ' +
    noi(cs[0]) + ' ' + tenDv(cs[0].loai_dich_vu));
  return C.oK(res, d.join('\n'), { chi_tiet: cs });
}

/* ---------------- ai còn nợ ---------------- */
async function thuTien(res) {
  const no = await C.kho('v_cong_no?select=*&order=so_ngay_qua_han.desc');
  if (!no.length) return C.oK(res, 'Không còn hóa đơn nào chưa thu. Sạch nợ.', { chi_tiet: [] });
  const tong = no.reduce((a, x) => a + (Number(x.con_no) || 0), 0);
  const d = ['Còn ' + no.length + ' hóa đơn chưa thu, tổng ' + C.tien(tong) + ' đ:'];
  for (const r of no.slice(0, 20)) {
    d.push('  ' + r.ma_nha + ' ' + r.ma_phong + ' · ' + (r.khach_thue || '—') +
      ' · ' + C.tien(r.con_no) + ' đ' +
      (r.so_ngay_qua_han > 0 ? ' · QUÁ HẠN ' + r.so_ngay_qua_han + ' ngày' : '') +
      (r.sdt ? ' · ' + r.sdt : ''));
  }
  if (no.length > 20) d.push('  … và ' + (no.length - 20) + ' hóa đơn nữa.');
  return C.oK(res, d.join('\n'), { chi_tiet: no });
}

/* ---------------- tóm tắt ---------------- */
async function tomTat(res) {
  const [nha, ll, hd, gh, cho] = await Promise.all([
    C.kho('v_nha_tro?select=*&order=ma_nha'),
    C.kho('v_lai_lo_tung_can?select=ma_nha,lai_lo_thang'),
    C.kho('hoa_don?select=con_no'),
    C.kho('v_can_gia_han?select=ma_nha,ma_phong'),
    C.kho('chi_so?select=phong_id&trang_thai_duyet=eq.cho_duyet')
  ]);
  let tp = 0, tt = 0, tr = 0, tn = 0;
  for (const n of nha) { tp += +n.tong_phong; tt += +n.phong_dang_thue; tr += +n.phong_dang_trong; tn += +n.phong_dang_no; }
  const lai = ll.reduce((a, x) => a + (Number(x.lai_lo_thang) || 0), 0);
  const conNo = hd.reduce((a, x) => a + (Number(x.con_no) || 0), 0);
  return C.oK(res, [
    nha.length + ' căn · ' + tp + ' phòng · ' + tt + ' đang thuê · ' + tr + ' trống · ' + tn + ' nợ tiền.',
    'Lãi lỗ tháng: ' + dau(lai) + C.tien(Math.abs(lai)) + ' đ.',
    'Còn phải thu: ' + C.tien(conNo) + ' đ.',
    gh.length ? 'Hợp đồng cần gia hạn: ' + gh.length + ' phòng.' : 'Không có hợp đồng nào cần gia hạn.',
    cho.length ? 'Chỉ số chờ duyệt: ' + cho.length + '.' : 'Không có chỉ số nào chờ duyệt.'
  ].join('\n'));
}

function pt(v) { return v == null ? '—' : String(v).replace('.', ',') + '%'; }
function dau(n) { return n < 0 ? '−' : '+'; }
function tenDv(dv) {
  return { dien: 'điện', nuoc: 'nước', internet: 'internet', rac: 'đổ rác',
           gui_xe: 'gửi xe', dich_vu_khac: 'dịch vụ khác' }[dv] || dv;
}
