// attrwin.js
// Παρέχει API: openAttrWindow(data, {title}), setAttrData(data)
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

const win = $('#attrwin');
const header = $('#attrwin-header');
const btnMin = $('#attrwin-min');
const btnMax = $('#attrwin-max');
const btnClose = $('#attrwin-close');
const titleEl = $('#attrwin-title');
const table = $('#attrwin-table');
const thead = $('#attrwin-table thead');
const tbody = $('#attrwin-table tbody');
const search = $('#attrwin-search');
const csvBtn = $('#attrwin-csv');
const countEl = $('#attrwin-count');
const resizeHandle = $('#attrwin-resize');

const STORE_KEY = 'attrwin:geom';
let state = {
  minimized: false,
  left: 60, top: 60, width: 720, height: 360,
};

let fullScreen = false;
let dataRows = []; // τρέχον dataset για φιλτράρισμα/εξαγωγή

// --------- helpers
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function saveGeom(){
  const rect = win.getBoundingClientRect();
  const payload = {
    left: rect.left, top: rect.top, width: rect.width, height: rect.height,
    minimized: win.classList.contains('minimized')
  };
  localStorage.setItem(STORE_KEY, JSON.stringify(payload));
}
function loadGeom(){
  const raw = localStorage.getItem(STORE_KEY);
  if(!raw) return;
  try{
    const g = JSON.parse(raw);
    state = {...state, ...g};
    applyGeom();
  }catch{}
}
function applyGeom(){
  win.style.left = state.left + 'px';
  win.style.top = state.top + 'px';
  win.style.width = state.width + 'px';
  win.style.height = state.height + 'px';
  if(state.minimized) win.classList.add('minimized'); else win.classList.remove('minimized');
}

// --------- dragging
let drag = null;
header.addEventListener('mousedown', (e)=>{
  if (e.target.closest('.win-actions')) return; // μην ξεκινάει drag πάνω στα κουμπιά
  const rect = win.getBoundingClientRect();
  drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
  document.addEventListener('mousemove', onDrag);
  document.addEventListener('mouseup', endDrag);
});
function onDrag(e){
  if(!drag) return;
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = clamp(e.clientX - drag.dx, 0, vw - 120);
  let y = clamp(e.clientY - drag.dy, 0, vh - 40);
  win.style.left = x + 'px';
  win.style.top = y + 'px';
}
function endDrag(){
  if(!drag) return;
  drag = null;
  saveGeom();
}

// --------- resize
let rs = null;
resizeHandle.addEventListener('mousedown', (e)=>{
  const rect = win.getBoundingClientRect();
  rs = { startX: e.clientX, startY: e.clientY, w: rect.width, h: rect.height };
  document.addEventListener('mousemove', onResize);
  document.addEventListener('mouseup', endResize);
});
function onResize(e){
  if(!rs) return;
  const minW = 420, minH = 200;
  const vw = window.innerWidth, vh = window.innerHeight;
  const nw = clamp(rs.w + (e.clientX - rs.startX), minW, vw - win.offsetLeft - 8);
  const nh = clamp(rs.h + (e.clientY - rs.startY), minH, vh - win.offsetTop - 8);
  win.style.width = nw + 'px';
  win.style.height = nh + 'px';
}
function endResize(){
  if(!rs) return;
  rs = null;
  saveGeom();
}

// --------- actions
btnClose.addEventListener('click', ()=> { win.classList.add('hidden'); });
btnMin.addEventListener('click', ()=>{
  win.classList.toggle('minimized');
  saveGeom();
});
btnMax.addEventListener('click', ()=>{
  fullScreen = !fullScreen;
  if(fullScreen){
    win.style.left = '12px';
    win.style.top = '12px';
    win.style.width = (window.innerWidth - 24) + 'px';
    win.style.height = (window.innerHeight - 24) + 'px';
  }else{
    applyGeom();
  }
  saveGeom();
});

// ESC για κλείσιμο, Alt+Enter για minimize/restore
document.addEventListener('keydown', (e)=>{
  if(win.classList.contains('hidden')) return;
  if(e.key === 'Escape') win.classList.add('hidden');
  if(e.key === 'Enter' && e.altKey) btnMin.click();
});

// --------- table rendering
function renderTable(rows){
  if(!rows || !rows.length){
    thead.innerHTML = '';
    tbody.innerHTML = '<tr><td style="padding:18px;color:#9aa3b2;">Καμία εγγραφή</td></tr>';
    countEl.textContent = '0 rows';
    return;
  }
  // columns = union όλων των keys
  const cols = Array.from(
    rows.reduce((set, r)=>{ Object.keys(r).forEach(k=>set.add(k)); return set; }, new Set())
  );
  thead.innerHTML = `<tr>${cols.map(c=>`<th>${escapeHtml(c)}</th>`).join('')}</tr>`;
  tbody.innerHTML = rows.map(r=>{
    return `<tr>${cols.map(c=>`<td>${escapeHtml(val(r[c]))}</td>`).join('')}</tr>`;
  }).join('');
  countEl.textContent = `${rows.length} rows • ${cols.length} columns`;
}
function val(v){
  if(v == null) return '';
  if(typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// --------- search filter
search.addEventListener('input', ()=>{
  const q = search.value.trim().toLowerCase();
  if(!q) { renderTable(dataRows); return; }
  const filtered = dataRows.filter(r => JSON.stringify(r).toLowerCase().includes(q));
  renderTable(filtered);
});

// --------- export CSV
csvBtn.addEventListener('click', ()=>{
  if(!dataRows.length) return;
  const cols = Array.from(
    dataRows.reduce((set, r)=>{ Object.keys(r).forEach(k=>set.add(k)); return set; }, new Set())
  );
  const esc = (s)=> `"${String(s??'').replace(/"/g,'""')}"`;
  const lines = [
    cols.join(','),
    ...dataRows.map(r => cols.map(c => esc(val(r[c]))).join(','))
  ];
  const blob = new Blob([lines.join('\n')], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'attributes.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

// --------- public API
export function openAttrWindow(rows, opts={}){
  dataRows = rows || [];
  titleEl.textContent = opts.title || 'Attribute Table';
  renderTable(dataRows);
  win.classList.remove('hidden');
  win.classList.remove('minimized');
  // μπροστά από άλλα floating panels
  win.style.zIndex = (parseInt(win.style.zIndex||'9999',10) + 1).toString();
}
export function setAttrData(rows){
  dataRows = rows || [];
  renderTable(dataRows);
}

// init
loadGeom();

// φέρε το παράθυρο μπροστά όταν πατιέται
win.addEventListener('mousedown', ()=> {
  win.style.zIndex = (parseInt(win.style.zIndex||'9999',10) + 1).toString();
});

// σύνδεση με κουμπί toolbar
$('#btn-attr')?.addEventListener('click', ()=>{
  if (dataRows.length === 0) {
    // placeholder αν δεν έχεις ακόμα feature selection
    openAttrWindow([], { title: 'Attribute Table' });
  } else {
    openAttrWindow(dataRows, { title: 'Attribute Table' });
  }
});
