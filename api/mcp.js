// api/mcp.js — Cổng MCP của Ở TRỌ
// ------------------------------------------------------------------
// Cho Claude (hoặc AI khác hỗ trợ MCP) đọc dữ liệu Ở TRỌ, và — khi
// được bật — ghi chỉ số điện nước / phiếu chi. Mọi luật tiền vẫn do
// trigger trong cơ sở dữ liệu giữ, cổng này không tự tính tiền.
//
// Biến môi trường trên Vercel:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY  (đã có sẵn, dùng chung với 3 cửa API cũ)
//   MCP_TOKEN        mã truy cập cổng MCP (bắt buộc, khác INGEST_TOKEN)
//   MCP_TO_CHUC_ID   id tổ chức trong bảng to_chuc (bỏ trống nếu kho chỉ có 1 tổ chức)
//   MCP_CHO_GHI      đặt 1 để cho phép ghi; bỏ trống = chỉ đọc
//
// Địa chỉ cổng: https://<tên-miền>/api/mcp?key=<MCP_TOKEN>
// Không cần thư viện ngoài, không cần package.json.
// ------------------------------------------------------------------

const PHIEN_BAN_GIAO_THUC = '2025-06-18';
const GIOI_HAN_DONG = 500;

// Bảng / view được phép ĐỌC. Bảng chứa thông tin cá nhân khách thuê
// (khach_thue, thanh_vien_o_cung) cố ý KHÔNG mở. Muốn mở: thêm vào đây.
const BANG_DOC = {
  nha_tro: 'Danh sách căn (nhà trọ)',
  nha_tro_tai_chinh: 'Tiền thuê sỉ, vốn đầu tư, cọc chủ nhà của từng căn',
  phong: 'Danh sách phòng',
  v_phong: 'Phòng kèm trạng thái tính từ hợp đồng',
  v_nha_tro: 'Căn kèm số liệu tổng hợp',
  hop_dong: 'Hợp đồng thuê phòng',
  v_can_gia_han: 'Hợp đồng sắp hết hạn cần gia hạn',
  bang_gia: 'Bảng giá',
  bang_gia_dong: 'Các dòng trong bảng giá',
  chi_so: 'Chỉ số điện nước (có trạng thái duyệt)',
  hoa_don: 'Hóa đơn (nháp / chờ thanh toán / đã thu / đã hủy)',
  hoa_don_dong: 'Các dòng trong hóa đơn',
  thanh_toan: 'Các lần thu tiền hóa đơn',
  v_cong_no: 'Công nợ — chỉ hóa đơn đã phát hành',
  thu_chi: 'Sổ thu chi (sổ quỹ)',
  hang_muc_thu_chi: 'Danh mục 13 mục chi, 7 mục thu',
  v_lai_lo_tung_can: 'Mô hình lãi lỗ CŨ — chỉ dùng cho vốn/cọc, không dùng tính lãi lỗ tháng',
};

// Bảng được phép GHI (chỉ thêm dòng mới, không sửa, không xóa).
// Cột nằm trong danh sách cấm sẽ bị bỏ đi trước khi ghi.
const BANG_GHI = {
  chi_so: {
    moTa: 'Thêm chỉ số điện nước. Luôn vào trạng thái chờ duyệt (mặc định của kho); người dùng duyệt trên web.',
    cotCam: ['id', 'to_chuc_id', 'trang_thai_duyet', 'da_xoa', 'nguoi_duyet', 'ngay_duyet'],
  },
  thu_chi: {
    moTa: 'Thêm phiếu chi / phiếu thu gõ tay vào sổ quỹ. Không dùng để ghi tiền khách trả hóa đơn (việc đó sinh tự động từ thanh_toan).',
    cotCam: ['id', 'to_chuc_id', 'thanh_toan_id', 'da_xoa', 'nguoi_xoa', 'ngay_xoa'],
  },
};

const TU_KHOA_CAM_LOC = new Set(['select', 'order', 'limit', 'offset', 'or', 'and', 'not', 'to_chuc_id', 'on_conflict', 'columns']);
const TEN_COT = /^[a-z_][a-z0-9_]*$/;

const HUONG_DAN = `Đây là cổng dữ liệu Ở TRỌ — web app quản lý chuỗi nhà trọ (thuê sỉ nguyên căn, chia phòng cho thuê lẻ).
Luật bắt buộc khi đọc số tiền:
1. Không cộng hai lần: tiền khách trả hóa đơn nằm trong thanh_toan, và mỗi lần thu có một dòng thu_chi mang thanh_toan_id. Khi cộng tiền thu từ thanh_toan thì bỏ mọi dòng thu_chi có thanh_toan_id.
2. Chỉ hóa đơn đã phát hành mới tính vào doanh thu và công nợ; bỏ hóa đơn nháp và đã hủy. Dòng có da_xoa = true là đã xóa mềm, bỏ qua.
3. Lợi nhuận tháng không trừ hai mục chi coc_chu_nha (Cọc) và cai_tao (Cải tạo). Cọc khách không phải doanh thu; cọc chủ nhà không cộng vào vốn đầu tư.
4. Chi phí tính theo ngày trên phiếu chi, gom theo căn; phiếu không gắn căn là "chi phí chung".
5. Con số chính thức là báo cáo trên web (menu Báo cáo). Khi tự cộng, nói rõ là số tự tính và cách tính.
Trước khi lọc một bảng lạ, gọi xem_cau_truc để biết tên cột. Ghi dữ liệu chỉ khi người dùng yêu cầu rõ ràng, và nhắc lại nội dung sẽ ghi trước khi ghi.`;

const CONG_CU = [
  {
    name: 'danh_sach_bang',
    description: 'Liệt kê các bảng Ở TRỌ được phép đọc và ghi qua cổng này.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'xem_cau_truc',
    description: 'Xem tên các cột của một bảng (lấy từ 1 dòng mẫu). Gọi trước khi lọc hoặc ghi.',
    inputSchema: {
      type: 'object',
      properties: { bang: { type: 'string', description: 'Tên bảng, ví dụ hoa_don' } },
      required: ['bang'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'doc_du_lieu',
    description: 'Đọc dữ liệu một bảng Ở TRỌ, tự giới hạn trong tổ chức của bạn. Bộ lọc theo cú pháp PostgREST, ví dụ {"trang_thai":"eq.cho_thanh_toan","ky":"eq.2026-09"} hoặc {"ngay":"gte.2026-09-01"}.',
    inputSchema: {
      type: 'object',
      properties: {
        bang: { type: 'string', description: 'Tên bảng hoặc view' },
        loc: { type: 'object', description: 'Bộ lọc: { tên_cột: "toán_tử.giá_trị" }. Toán tử: eq, neq, gt, gte, lt, lte, like, ilike, is, in.(a,b)', additionalProperties: { type: 'string' } },
        chon: { type: 'string', description: 'Các cột cần lấy, cách nhau dấu phẩy. Bỏ trống = lấy hết' },
        sap_xep: { type: 'string', description: 'Ví dụ: ngay.desc hoặc ten.asc' },
        gioi_han: { type: 'integer', description: `Số dòng tối đa (mặc định 100, tối đa ${GIOI_HAN_DONG})` },
      },
      required: ['bang'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'them_dong',
    description: 'Thêm MỘT dòng mới vào chi_so (chỉ số điện nước, vào trạng thái chờ duyệt) hoặc thu_chi (phiếu chi / phiếu thu gõ tay). Không sửa, không xóa được. Chỉ dùng khi người dùng yêu cầu rõ. Gọi xem_cau_truc trước để biết tên cột.',
    inputSchema: {
      type: 'object',
      properties: {
        bang: { type: 'string', enum: Object.keys(BANG_GHI) },
        du_lieu: { type: 'object', description: 'Các cột và giá trị của dòng mới' },
      },
      required: ['bang', 'du_lieu'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

// ---------------- Supabase ----------------

function goc() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY || '';
  if (!url || !key) throw new Error('Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_KEY trên Vercel.');
  return { url, key };
}

async function goiKho(duongDan, tuyChon = {}) {
  const { url, key } = goc();
  const r = await fetch(`${url}/rest/v1/${duongDan}`, {
    ...tuyChon,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(tuyChon.headers || {}),
    },
  });
  const chu = await r.text();
  let du = null;
  try { du = chu ? JSON.parse(chu) : null; } catch { du = chu; }
  if (!r.ok) {
    const loi = (du && (du.message || du.hint || du.details)) || chu || `HTTP ${r.status}`;
    if (/to_chuc_id/.test(loi)) throw new Error('Bảng này không có cột to_chuc_id nên cổng không mở được (để tránh lẫn dữ liệu tổ chức khác).');
    throw new Error(`Kho dữ liệu báo lỗi: ${loi}`);
  }
  return du;
}

let toChucDem = null;
async function layToChuc() {
  if (process.env.MCP_TO_CHUC_ID) return process.env.MCP_TO_CHUC_ID.trim();
  if (toChucDem) return toChucDem;
  const ds = await goiKho('to_chuc?select=id&limit=2');
  if (!Array.isArray(ds) || ds.length !== 1) {
    throw new Error('Kho có nhiều hơn 1 tổ chức: phải đặt MCP_TO_CHUC_ID trên Vercel.');
  }
  toChucDem = ds[0].id;
  return toChucDem;
}

// ---------------- Công cụ ----------------

function kiemBangDoc(bang) {
  if (!Object.prototype.hasOwnProperty.call(BANG_DOC, bang)) {
    throw new Error(`Không mở bảng "${bang}". Gọi danh_sach_bang để xem các bảng được phép.`);
  }
}

async function chayCongCu(ten, thamSo = {}) {
  if (ten === 'danh_sach_bang') {
    return {
      duoc_doc: BANG_DOC,
      duoc_ghi: process.env.MCP_CHO_GHI === '1'
        ? Object.fromEntries(Object.entries(BANG_GHI).map(([k, v]) => [k, v.moTa]))
        : 'Đang tắt (chỉ đọc). Chủ trọ bật bằng biến MCP_CHO_GHI=1 trên Vercel.',
    };
  }

  const toChuc = await layToChuc();

  if (ten === 'xem_cau_truc') {
    const bang = String(thamSo.bang || '');
    if (!BANG_DOC[bang] && !BANG_GHI[bang]) kiemBangDoc(bang);
    const q = new URLSearchParams({ select: '*', to_chuc_id: `eq.${toChuc}`, limit: '1' });
    const ds = await goiKho(`${bang}?${q}`);
    const mau = Array.isArray(ds) && ds[0] ? ds[0] : null;
    return {
      bang,
      cot: mau ? Object.keys(mau) : [],
      dong_mau: mau,
      ghi_chu: mau ? undefined : 'Bảng chưa có dòng nào nên không đọc được tên cột.',
    };
  }

  if (ten === 'doc_du_lieu') {
    const bang = String(thamSo.bang || '');
    kiemBangDoc(bang);
    const q = new URLSearchParams();
    const chon = String(thamSo.chon || '*').replace(/\s+/g, '');
    if (chon !== '*' && !chon.split(',').every((c) => TEN_COT.test(c))) {
      throw new Error('Tham số chon chỉ được chứa tên cột, cách nhau dấu phẩy.');
    }
    q.set('select', chon);
    for (const [cot, giaTri] of Object.entries(thamSo.loc || {})) {
      if (!TEN_COT.test(cot) || TU_KHOA_CAM_LOC.has(cot)) throw new Error(`Không lọc được theo "${cot}".`);
      q.append(cot, String(giaTri));
    }
    q.append('to_chuc_id', `eq.${toChuc}`); // luôn khóa trong tổ chức
    if (thamSo.sap_xep) {
      const s = String(thamSo.sap_xep).replace(/\s+/g, '');
      if (!/^[a-z_][a-z0-9_]*(\.(asc|desc))?(,[a-z_][a-z0-9_]*(\.(asc|desc))?)*$/.test(s)) throw new Error('sap_xep sai dạng, ví dụ: ngay.desc');
      q.set('order', s);
    }
    const n = Math.min(Math.max(parseInt(thamSo.gioi_han, 10) || 100, 1), GIOI_HAN_DONG);
    q.set('limit', String(n));
    const ds = await goiKho(`${bang}?${q}`);
    return { bang, so_dong: Array.isArray(ds) ? ds.length : 0, du_lieu: ds, het_gioi_han: Array.isArray(ds) && ds.length === n };
  }

  if (ten === 'them_dong') {
    if (process.env.MCP_CHO_GHI !== '1') throw new Error('Cổng đang ở chế độ chỉ đọc. Chủ trọ bật bằng biến MCP_CHO_GHI=1 trên Vercel.');
    const bang = String(thamSo.bang || '');
    const cauHinh = BANG_GHI[bang];
    if (!cauHinh) throw new Error(`Chỉ được thêm dòng vào: ${Object.keys(BANG_GHI).join(', ')}.`);
    const vao = thamSo.du_lieu;
    if (!vao || typeof vao !== 'object' || Array.isArray(vao)) throw new Error('du_lieu phải là một đối tượng { cột: giá trị }.');
    const dong = {};
    const boQua = [];
    for (const [cot, giaTri] of Object.entries(vao)) {
      if (!TEN_COT.test(cot)) throw new Error(`Tên cột không hợp lệ: ${cot}`);
      if (cauHinh.cotCam.includes(cot)) { boQua.push(cot); continue; }
      dong[cot] = giaTri;
    }
    dong.to_chuc_id = toChuc;
    const kq = await goiKho(bang, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(dong),
    });
    return { da_ghi: Array.isArray(kq) ? kq[0] : kq, cot_bi_bo_qua: boQua.length ? boQua : undefined };
  }

  throw new Error(`Không có công cụ "${ten}".`);
}

// ---------------- Giao thức MCP (JSON-RPC qua HTTP) ----------------

async function xuLyThongDiep(m) {
  const { id, method, params = {} } = m || {};
  const traLoi = (result) => ({ jsonrpc: '2.0', id, result });
  const baoLoi = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  if (!m || m.jsonrpc !== '2.0' || typeof method !== 'string') return baoLoi(-32600, 'Yêu cầu không hợp lệ');
  if (id === undefined || id === null) return null; // thông báo (notification): không trả lời

  switch (method) {
    case 'initialize':
      return traLoi({
        protocolVersion: params.protocolVersion || PHIEN_BAN_GIAO_THUC,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'o-tro', title: 'Ở TRỌ — AI Quản Lý Nhà Trọ', version: '1.0.0' },
        instructions: HUONG_DAN,
      });
    case 'ping':
      return traLoi({});
    case 'tools/list':
      return traLoi({ tools: CONG_CU });
    case 'tools/call': {
      try {
        const kq = await chayCongCu(params.name, params.arguments || {});
        return traLoi({ content: [{ type: 'text', text: JSON.stringify(kq, null, 2) }] });
      } catch (e) {
        return traLoi({ content: [{ type: 'text', text: String(e.message || e) }], isError: true });
      }
    }
    default:
      return baoLoi(-32601, `Không hỗ trợ ${method}`);
  }
}

function layMa(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  try {
    return new URL(req.url, 'http://x').searchParams.get('key') || '';
  } catch { return ''; }
}

function bangNhau(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let khac = 0;
  for (let i = 0; i < a.length; i++) khac |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return khac === 0;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const maDung = process.env.MCP_TOKEN || '';
  if (!maDung) return res.status(500).json({ loi: 'Chưa đặt MCP_TOKEN trên Vercel.' });
  if (!bangNhau(layMa(req), maDung)) return res.status(403).json({ loi: 'Sai mã truy cập cổng MCP.' });

  if (req.method === 'GET') {
    // Trình duyệt mở thử → báo cổng đang chạy. Máy khách MCP xin luồng SSE → không hỗ trợ.
    if ((req.headers.accept || '').includes('text/event-stream')) return res.status(405).end();
    return res.status(200).json({ trang_thai: 'Cổng MCP Ở TRỌ đang chạy', che_do: process.env.MCP_CHO_GHI === '1' ? 'đọc + ghi' : 'chỉ đọc' });
  }
  if (req.method === 'DELETE') return res.status(405).end();
  if (req.method !== 'POST') return res.status(405).json({ loi: 'Chỉ nhận POST' });

  let than = req.body;
  if (typeof than === 'string') {
    try { than = JSON.parse(than); } catch { return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON sai' } }); }
  }

  if (Array.isArray(than)) {
    const ds = (await Promise.all(than.map(xuLyThongDiep))).filter(Boolean);
    return ds.length ? res.status(200).json(ds) : res.status(202).end();
  }
  const kq = await xuLyThongDiep(than);
  return kq ? res.status(200).json(kq) : res.status(202).end();
}
