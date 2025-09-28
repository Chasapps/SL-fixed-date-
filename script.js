// SpendLite v6.6.28 — header-aware CSV loader + strict DD/MM/YYYY parsing + bugfixes
// - Auto-detects headers (Debit amount/Credit amount/Effective date/Long description, etc.)
// - Works with 10+ columns; no strict length requirement
// - Amount = Debit - Credit (debits positive, credits negative)
// - Forces D/M/Y for slash/dash dates (01/12/2024 -> 1 Dec 2024)
// - Keeps previous UI, category picker, paging, exports

/* ---------------- Core State ---------------- */
let CURRENT_TXNS = [];         // {date, amount, description, category?}
let CURRENT_RULES = [];        // [{keyword, category}]
let CURRENT_FILTER = null;     // active category filter (UPPERCASE) or null
let MONTH_FILTER = "";         // 'YYYY-MM' or ''
let CURRENT_PAGE = 1;
const PAGE_SIZE = 10;

const LS_KEYS = {
  RULES:'spendlite_rules_v6628',
  FILTER:'spendlite_filter_v6628',
  MONTH:'spendlite_month_v6628',
  TXNS_COLLAPSED:'spendlite_txns_collapsed_v7',
  TXNS_JSON:'spendlite_txns_json_v7_pack'
};

/* ---------------- Utils ---------------- */
function toTitleCase(str){ if(!str)return''; return String(str).toLowerCase().replace(/[_-]+/g,' ').replace(/\s+/g,' ').trim().replace(/\b([a-z])/g,(m,p1)=>p1.toUpperCase()); }
function parseAmount(s){ if(s==null)return 0; s=String(s).replace(/[^\d\-,.]/g,'').replace(/,/g,''); return Number(s)||0; }

function escapeHtml(s){
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#039;');
}

function formatMonthLabel(ym){ if(!ym) return 'All months'; const [y,m]=ym.split('-').map(Number); const d=new Date(y,m-1,1); return d.toLocaleString(undefined,{month:'long',year:'numeric'}); }
function friendlyMonthOrAll(label){ if(!label) return 'All months'; if(/^\d{4}-\d{2}$/.test(label)) return formatMonthLabel(label); return String(label); }
function forFilename(label){ return String(label).replace(/\s+/g,'_'); }

/* ---------------- Date Parsing (force D/M/Y for slashes) ---------------- */
function parseDateSmart(s){
  if(!s) return null;
  const str = String(s).trim();
  let m;

  // ISO-like YYYY-MM-DD or YYYY/MM/DD (safe & unambiguous)
  m = str.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if(m) return new Date(+m[1], +m[2]-1, +m[3]);

  // Force D/M/Y for slash or dash formats (e.g. 01/12/2024 = 1 Dec 2024)
  m = str.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if(m) return new Date(+m[3], +m[2]-1, +m[1]);

  // Remove leading time like "10:14 am "
  const s2 = str.replace(/^\d{1,2}:\d{2}\s*(am|pm)\s*/i,'');

  // 1 December 2024 (optional weekday)
  m = s2.match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(\d{4})/i);
  if(m){
    const day = +m[1];
    const monthName = m[2].toLowerCase();
    const mm = {january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11};
    const mi = mm[monthName];
    if(mi!=null) return new Date(+m[3], mi, day);
  }
  return null; // avoid native Date(string) (US-biased)
}
function yyyymm(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function getFirstTxnMonth(txns=CURRENT_TXNS){ if(!txns.length) return null; const d=parseDateSmart(txns[0].date); if(!d||isNaN(d)) return null; return yyyymm(d); }

/* ---------------- Header-aware CSV Loader ---------------- */
function basicCsvParse(text){
  const out=[]; const lines=String(text||'').split(/\r?\n/);
  for(const raw of lines){
    if(!raw.trim()) continue;
    const row=[]; let cur=''; let inQ=false;
    for(let i=0;i<raw.length;i++){
      const ch=raw[i];
      if(ch === '"'){
        if(inQ && raw[i+1] === '"'){ cur += '"'; i++; }
        else inQ = !inQ;
      } else if(ch === ',' && !inQ){
        row.push(cur); cur='';
      } else {
        cur += ch;
      }
    }
    row.push(cur);
    out.push(row);
  }
  return out;
}

function mapHeaders(headerRow){
  const map = {};
  headerRow.forEach((h, i) => {
    const key = String(h||'').trim().toLowerCase();
    if(!key) return;
    map[key] = i;
  });
  function pick(...aliases){
    for(const a of aliases){
      const k = String(a).toLowerCase();
      if(map[k] != null) return map[k];
    }
    return -1;
  }
  const idx = {
    effectiveDate: pick('effective date','eff date','date','value date','posted date'),
    debit:         pick('debit amount','debit'),
    credit:        pick('credit amount','credit'),
    longdesc:      pick('long description','long desc','description','details','narrative')
  };
  return idx;
}

function loadCsvText(csvText){
  const rows = (typeof Papa !== 'undefined' && Papa && Papa.parse)
    ? Papa.parse(csvText.trim(), { skipEmptyLines:true }).data
    : basicCsvParse(csvText.trim());

  if(!rows.length) return [];

  const headerLike = rows[0].some(c => /date|debit|credit|description|long/i.test(String(c||'')));
  const startIdx = headerLike ? 1 : 0;
  const headerRow = headerLike ? rows[0] : [];

  let H = headerLike ? mapHeaders(headerRow) : { effectiveDate:2, debit:5, credit:-1, longdesc:9 };

  const txns = [];
  for(let i=startIdx; i<rows.length; i++){
    const r = rows[i];
    if(!r) continue;

    const dateRaw = H.effectiveDate>=0 ? (r[H.effectiveDate]||'') : (r[2]||'');
    const debitRaw = H.debit>=0 ? (r[H.debit]||'') : (r[5]||'');
    const creditRaw = H.credit>=0 ? (r[H.credit]||'') : '';
    const descRaw = H.longdesc>=0 ? (r[H.longdesc]||'') : (r[9]||r[r.length-1]||'');

    const debit = parseAmount(debitRaw);
    const credit = parseAmount(creditRaw);
    const amount = (debit || 0) - (credit || 0); // debits positive, credits negative

    const longDesc = String(descRaw||'').trim();
    if((dateRaw || longDesc) && Number.isFinite(amount) && amount !== 0){
      txns.push({ date: String(dateRaw||''), amount, description: longDesc });
    }
  }

  CURRENT_TXNS = txns;
  saveTxnsToLocalStorage();
  try{ updateMonthBanner(); }catch{}
  rebuildMonthDropdown();
  applyRulesAndRender();
  return txns;
}

/* ---------------- Rules & Categorisation ---------------- */
function parseRules(text){
  const lines=String(text||"").split(/\r?\n/); const rules=[];
  for(const line of lines){
    const trimmed=line.trim(); if(!trimmed||trimmed.startsWith('#')) continue;
    const parts=trimmed.split(/=>/i);
    if(parts.length>=2){ const keyword=parts[0].trim().toLowerCase(); const category=parts[1].trim().toUpperCase();
      if(keyword&&category) rules.push({keyword,category});
    }
  }
  return rules;
}
function matchesKeyword(descLower, keywordLower){
  if(!keywordLower) return false;
  const parts=String(keywordLower).split(/\s+/).filter(Boolean);
  let pos=0; for(const p of parts){ const i=descLower.indexOf(p,pos); if(i===-1) return false; pos=i+p.length; }
  return true;
}
function categorise(txns, rules){
  for(const t of txns){
    const descLower=String(t.desc||t.description||"").toLowerCase();
    const amount=Math.abs(Number(t.amount||t.debit||0)); let matched=null;
    for(const r of rules){ if(matchesKeyword(descLower,r.keyword)){ matched=r.category; break; } }
    if(matched && String(matched).toUpperCase()==="PETROL" && amount<=2){ matched="COFFEE"; }
    t.category=matched||"UNCATEGORISED";
  }
}

/* ---------------- Totals & Rendering ---------------- */
function computeCategoryTotals(txns){
  const byCat=new Map();
  for(const t of txns){ const cat=(t.category||'UNCATEGORISED').toUpperCase(); byCat.set(cat,(byCat.get(cat)||0)+t.amount); }
  const rows=[...byCat.entries()].sort((a,b)=>b[1]-a[1]); const grand=rows.reduce((acc,[,v])=>acc+v,0); return {rows,grand};
}
function renderCategoryTotals(txns){
  const {rows,grand}=computeCategoryTotals(txns);
  const totalsDiv=document.getElementById('categoryTotals'); if(!totalsDiv) return;
  let html='<table class="cats"><thead><tr><th>Category</th><th class="num">Total</th><th class="num">%</th></tr></thead><tbody>';
  for(const [cat,total] of rows){
    html+=`<tr><td><a class="catlink" data-cat="${escapeHtml(cat)}"><span class="category-name">${escapeHtml(toTitleCase(cat))}</span></a></td><td class="num">${total.toFixed(2)}</td><td class="num">${(grand?(total/grand*100):0).toFixed(1)}%</td></tr>`;
  }
  html+=`</tbody><tfoot><tr><td>Total</td><td class="num">${grand.toFixed(2)}</td><td class="num">100%</td></tr></tfoot></table>`;
  totalsDiv.innerHTML=html;
  totalsDiv.querySelectorAll('a.catlink').forEach(a=>{
    a.addEventListener('click',()=>{
      CURRENT_FILTER=a.getAttribute('data-cat');
      try{localStorage.setItem(LS_KEYS.FILTER,CURRENT_FILTER||'');}catch{}
      updateFilterUI(); CURRENT_PAGE=1; renderTransactionsTable();
    });
  });
}
function renderMonthTotals(){
  const txns=getFilteredTxns(monthFilteredTxns()); let debit=0,credit=0,count=0;
  for(const t of txns){ const amt=Number(t.amount)||0; if(amt>0) debit+=amt; else credit+=Math.abs(amt); count++; }
  const net=debit-credit; const el=document.getElementById('monthTotals'); if(!el) return;
  const cat=CURRENT_FILTER?` + category "${CURRENT_FILTER}"`:'';
  el.innerHTML=`Showing <span class="badge">${count}</span> transactions for <strong>${friendlyMonthOrAll(MONTH_FILTER)}${cat}</strong> · Debit: <strong>$${debit.toFixed(2)}</strong> · Credit: <strong>$${credit.toFixed(2)}</strong> · Net: <strong>$${net.toFixed(2)}</strong>`;
}
function applyRulesAndRender({keepPage=false}={}){
  if(!keepPage) CURRENT_PAGE=1;
  const box=document.getElementById('rulesBox');
  CURRENT_RULES=parseRules(box ? box.value : "");
  try{localStorage.setItem(LS_KEYS.RULES, box ? box.value : "");}catch{}
  const txns=monthFilteredTxns(); categorise(txns,CURRENT_RULES);
  renderMonthTotals(); renderCategoryTotals(txns); renderTransactionsTable(txns);
  saveTxnsToLocalStorage(); try{updateMonthBanner();}catch{}
}
function computeDebitCredit(txns){ let sumDebit=0,sumCredit=0; for(const t of txns){ if(t.amount>0) sumDebit+=t.amount; else sumCredit+=Math.abs(t.amount);} return {sumDebit,sumCredit,net:sumDebit-sumCredit}; }
function renderTotalsBar(txns){
  const {sumDebit,sumCredit,net}=computeDebitCredit(txns); const el=document.getElementById('totalsBar'); if(!el) return;
  const monthLabel=friendlyMonthOrAll(MONTH_FILTER);
  el.innerHTML=`Rows: <strong>${txns.length}</strong> · Debit: <strong>$${sumDebit.toFixed(2)}</strong> · Credit: <strong>$${sumCredit.toFixed(2)}</strong> · Net: <strong>$${net.toFixed(2)}</strong> (${monthLabel})`;
}

/* ---------------- Export helpers ---------------- */
function exportTotals(){
  const txns=monthFilteredTxns(); const {rows,grand}=computeCategoryTotals(txns);
  const label=friendlyMonthOrAll(MONTH_FILTER||getFirstTxnMonth(txns)||new Date());
  const header=`SpendLite Category Totals (${label})`;
  const catWidth=Math.max(8, ...rows.map(([cat])=>toTitleCase(cat).length), 'Category'.length);
  const amtWidth=12; const pctWidth=6;
  const lines=[header,'='.repeat(header.length),'Category'.padEnd(catWidth)+' '+'Amount'.padStart(amtWidth)+' '+'%'.padStart(pctWidth)];
  for(const [cat,total] of rows){
    const pct=grand?(total/grand*100):0;
    lines.push(toTitleCase(cat).padEnd(catWidth)+' '+total.toFixed(2).padStart(amtWidth)+' '+(pct.toFixed(1)+'%').padStart(pctWidth));
  }
  lines.push('','TOTAL'.padEnd(catWidth)+' '+grand.toFixed(2).padStart(amtWidth)+' '+'100%'.padStart(pctWidth));
  const blob=new Blob([lines.join('\n')],{type:'text/plain'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`category_totals_${forFilename(label)}.txt`; document.body.appendChild(a); a.click(); a.remove();
}

/* ---------------- Filtering & Paging ---------------- */
function getFilteredTxns(txns){ if(!CURRENT_FILTER) return txns; return txns.filter(t=>(t.category||'UNCATEGORISED').toUpperCase()===CURRENT_FILTER); }
function updateFilterUI(){ const label=document.getElementById('activeFilter'); const btn=document.getElementById('clearFilterBtn'); if(!label||!btn) return; if(CURRENT_FILTER){ label.textContent=`— filtered by "${CURRENT_FILTER}"`; btn.style.display=''; } else { label.textContent=''; btn.style.display='none'; } }
function updateMonthBanner(){ const banner=document.getElementById('monthBanner'); const label=friendlyMonthOrAll(MONTH_FILTER); if(banner) banner.textContent=`— ${label}`; }

function monthFilteredTxns(){ if(!MONTH_FILTER) return CURRENT_TXNS; return CURRENT_TXNS.filter(t=>{ const d=parseDateSmart(t.date); return d&&yyyymm(d)===MONTH_FILTER; }); }

function rebuildMonthDropdown(){
  const sel=document.getElementById('monthFilter'); if(!sel) return;
  const months=new Set(); for(const t of CURRENT_TXNS){ const d=parseDateSmart(t.date); if(d) months.add(yyyymm(d)); }
  const list=Array.from(months).sort(); const current=MONTH_FILTER;
  sel.innerHTML=`<option value="">All months</option>` + list.map(m=>`<option value="${m}">${formatMonthLabel(m)}</option>`).join('');
  sel.value=current && list.includes(current) ? current : ""; updateMonthBanner();
}

function renderTransactionsTable(txns=monthFilteredTxns()){
  const filtered=getFilteredTxns(txns);
  const totalPages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE));
  if(CURRENT_PAGE>totalPages) CURRENT_PAGE=totalPages; if(CURRENT_PAGE<1) CURRENT_PAGE=1;
  const start=(CURRENT_PAGE-1)*PAGE_SIZE; const pageItems=filtered.slice(start,start+PAGE_SIZE);
  const table=document.getElementById('transactionsTable'); if(!table) return;
  let html='<tr><th>Date</th><th>Amount</th><th>Category</th><th>Description</th><th></th></tr>';
  pageItems.forEach((t)=>{
    const idx=CURRENT_TXNS.indexOf(t);
    const cat=(t.category||'UNCATEGORISED').toUpperCase(); const displayCat=toTitleCase(cat);
    html+=`<tr><td>${escapeHtml(t.date)}</td><td>${Number(t.amount||0).toFixed(2)}</td><td><span class="category-name" data-idx="${idx}" title="Click to assign/edit">${escapeHtml(displayCat)}</span></td><td>${escapeHtml(t.description)}</td><td><button class="rule-btn" onclick="assignCategory(${idx})">+</button></td></tr>`;
  });
  table.innerHTML=html;
  table.querySelectorAll('.category-name').forEach(el=>{
    el.addEventListener('click',(e)=>{
      const i=Number(e.currentTarget.getAttribute('data-idx'));
      if(!Number.isNaN(i)) assignCategory(i);
    }, {passive:true});
  });
  renderPager(totalPages);
}

function renderPager(totalPages){
  const pager=document.getElementById('pager'); if(!pager) return;
  const pages=totalPages||1; const cur=CURRENT_PAGE;
  function pageButton(label,page,disabled=false,isActive=false){ const disAttr=disabled?' disabled':''; const activeClass=isActive?' active':''; return `<button class="page-btn${activeClass}" data-page="${page}"${disAttr}>${label}</button>`; }
  const windowSize=5; let start=Math.max(1, cur-Math.floor(windowSize/2)); let end=Math.min(pages, start+windowSize-1); start=Math.max(1, Math.min(start, end-windowSize+1));
  let html=''; html += pageButton('First',1,cur===1); html += pageButton('Prev',Math.max(1,cur-1),cur===1);
  for(let p=start;p<=end;p++){ html += pageButton(String(p),p,false,p===cur); }
  html += pageButton('Next',Math.min(pages,cur+1),cur===pages); html += pageButton('Last',pages,cur===pages); html += `<span style="margin-left:8px">Page ${cur} / ${pages}</span>`;
  pager.innerHTML=html;
  pager.querySelectorAll('button.page-btn').forEach(btn=>{
    btn.addEventListener('click',(e)=>{
      const page=Number(e.currentTarget.getAttribute('data-page')); if(!page||page===CURRENT_PAGE) return;
      CURRENT_PAGE=page; renderTransactionsTable();
    });
  });
  const table=document.getElementById('transactionsTable');
  if(table && !table._wheelBound){
    table.addEventListener('wheel',(e)=>{
      const pagesNow=Math.max(1,Math.ceil(getFilteredTxns(monthFilteredTxns()).length/PAGE_SIZE));
      if(pagesNow<=1) return;
      if(e.deltaY>0 && CURRENT_PAGE<pagesNow){ CURRENT_PAGE++; renderTransactionsTable(); }
      else if(e.deltaY<0 && CURRENT_PAGE>1){ CURRENT_PAGE--; renderTransactionsTable(); }
    }, {passive:true});
    table._wheelBound=true;
  }
}

/* ---------------- Category Picker ---------------- */
function nextWordAfter(marker,desc){
  const lower=(desc||'').toLowerCase();
  const i=lower.indexOf(String(marker).toLowerCase());
  if(i===-1) return '';
  let after=(desc||'').slice(i+String(marker).length).replace(/^[\s\-:\/*]+/,'');
  const m=after.match(/^([A-Za-z0-9&._]+)/); return m?m[1]:'';
}
function collectCategories(){
  const set = new Set();
  (CURRENT_RULES || []).forEach(r => { const c=(r.category||r.cat||"").trim(); if(c) set.add(c.toUpperCase()); });
  (CURRENT_TXNS || []).forEach(t => { const c=(t.category||t.cat||"").trim(); if(c) set.add(c.toUpperCase()); });
  const box=document.getElementById('rulesBox');
  if(box&&box.value){
    String(box.value).split(/\r?\n/).forEach(line=>{
      const trimmed=line.trim(); if(!trimmed||trimmed.startsWith('#')) return;
      const parts=trimmed.split(/=>/i); if(parts.length>=2){ const c=parts[1].trim().toUpperCase(); if(c) set.add(c); }
    });
  }
  set.add('UNCATEGORISED');
  return Array.from(set).sort((a,b)=>toTitleCase(a).localeCompare(toTitleCase(b)));
}
function ensureCategoryModal(){
  if(document.getElementById("catPickerModal")) return;
  const el=document.createElement("div");
  el.id="catPickerModal";
  el.innerHTML=`
    <div class="catpicker-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.35);display:none;z-index:9998"></div>
    <div class="catpicker-sheet" style="position:fixed;left:0;right:0;bottom:0;max-height:80vh;background:#fff;border-radius:16px 16px 0 0;box-shadow:0 -8px 24px rgba(0,0,0,.2);padding:16px;display:none;z-index:9999">
      <h3 style="margin:0 0 8px">Choose a category</h3>
      <input id="catSearchInput" type="text" inputmode="search" placeholder="Search categories…"
             style="width:100%;font-size:16px;padding:12px;border:2px solid #eee;border-radius:10px;outline:none;margin-bottom:10px" />
      <div id="catList" style="overflow:auto;max-height:42vh;border:1px solid #eee;border-radius:10px"></div>
      <div style="margin:12px 0 6px;color:#666;font-size:13px">Or type a category name:</div>
      <input id="catNewInput" type="text" placeholder="UNCATEGORISED"
             style="width:100%;font-size:16px;padding:12px;border:2px solid #eee;border-radius:10px;outline:none;margin-bottom:12px" />
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="catCancelBtn" class="secondary" style="padding:10px 14px;border-radius:10px;border:2px solid #eee;background:#fff">Cancel</button>
        <button id="catUseBtn" class="primary" style="padding:10px 14px;border:0;background:#ff4fb3;color:#fff">Use this</button>
      </div>
    </div>`;
  document.body.appendChild(el);
}
function renderCatList(list, query = ""){
  const box=document.getElementById("catList");
  const q=(query||"").trim().toLowerCase();
  const filtered=q ? list.filter(c=>c.toLowerCase().includes(q)) : list.slice();
  if(!filtered.length){
    box.innerHTML = `<div style="padding:12px 14px;color:#666">No matches — create <b>${(query||"").toUpperCase()}</b> below.</div>`;
    return;
  }
  box.innerHTML = filtered.map(c => `
    <button class="cat-item" data-cat="${c}"
      style="display:block;width:100%;text-align:left;padding:12px 14px;border:0;border-bottom:1px solid #f1f1f1;background:#fff;font-size:16px">
      ${c}
    </button>`).join("");
  box.querySelectorAll(".cat-item").forEach(btn=>{
    btn.addEventListener("click",()=>{
      document.getElementById("catNewInput").value = btn.dataset.cat;
    },{once:true});
  });
}
function openCategoryPicker(initialText = ""){
  ensureCategoryModal();
  const backdrop=document.querySelector("#catPickerModal .catpicker-backdrop");
  const sheet   =document.querySelector("#catPickerModal .catpicker-sheet");
  const searchEl=document.getElementById("catSearchInput");
  const newEl   =document.getElementById("catNewInput");
  const cancelBt=document.getElementById("catCancelBtn");
  const useBt   =document.getElementById("catUseBtn");
  const CATS=collectCategories();
  return new Promise(resolve=>{
    const close=(val)=>{ sheet.style.display="none"; backdrop.style.display="none"; resolve(val); };
    backdrop.onclick = ()=>close(null);
    cancelBt.onclick = ()=>close(null);
    useBt.onclick    = ()=>{ const val=(newEl.value||searchEl.value||"UNCATEGORISED").trim().toUpperCase(); close(val||"UNCATEGORISED"); };
    searchEl.oninput = ()=>renderCatList(CATS, searchEl.value);
    newEl.onkeydown  = (e)=>{ if(e.key==="Enter") useBt.click(); };
    backdrop.style.display="block"; sheet.style.display="block";
    searchEl.value=initialText||""; newEl.value=(initialText||"").toUpperCase();
    renderCatList(CATS, initialText);
    setTimeout(()=>searchEl.focus(),50);
  });
}
async function assignCategory(idx){
  try{ CURRENT_RULES=parseRules(document.getElementById('rulesBox').value);}catch{}
  const txn=CURRENT_TXNS[idx]; if(!txn) return;
  const desc=txn.description||""; const up=desc.toUpperCase(); let suggestedKeyword="";
  if(/\bPAYPAL\b/.test(up)){ const nxt=nextWordAfter('paypal',desc); suggestedKeyword=('PAYPAL'+(nxt?' '+nxt:'')); }
  else { const visaPos=up.indexOf("VISA-"); if(visaPos!==-1){ const after=desc.substring(visaPos+5).trim(); suggestedKeyword=(after.split(/\s+/)[0]||""); } else { suggestedKeyword=(desc.split(/\s+/)[0]||""); } }
  const keywordInput=prompt("Enter keyword to match:", suggestedKeyword.toUpperCase()); if(!keywordInput) return;
  const keyword=keywordInput.trim().toUpperCase();
  const defaultCat=(txn.category||"UNCATEGORISED").toUpperCase();
  const chosen=await openCategoryPicker(defaultCat);
  if(!chosen) return;
  const category=chosen.trim().toUpperCase();
  const box=document.getElementById('rulesBox');
  const lines=String(box.value||"").split(/\r?\n/); let updated=false;
  for(let i=0;i<lines.length;i++){
    const line=(lines[i]||"").trim(); if(!line||line.startsWith('#')) continue;
    const parts=line.split(/=>/i);
    if(parts.length>=2){ const k=parts[0].trim().toUpperCase(); if(k===keyword){ lines[i]=`${keyword} => ${category}`; updated=true; break; } }
  }
  if(!updated) lines.push(`${keyword} => ${category}`);
  box.value=lines.join("\n");
  try{localStorage.setItem(LS_KEYS.RULES, box.value);}catch{}
  if(typeof applyRulesAndRender==='function') applyRulesAndRender({keepPage:true});
}

/* ---------------- Persistence ---------------- */
function saveTxnsToLocalStorage(){
  try{
    const data=JSON.stringify(CURRENT_TXNS||[]);
    localStorage.setItem(LS_KEYS.TXNS_JSON, data);
    localStorage.setItem('spendlite_txns_json_v7', data);
    localStorage.setItem('spendlite_txns_json', data);
  }catch{}
}

/* ---------------- Event wiring ---------------- */
window.addEventListener('DOMContentLoaded', ()=>{
  const csvEl = document.getElementById('csvFile');
  if(csvEl){
    csvEl.addEventListener('change',(e)=>{
      const file=e.target.files&&e.target.files[0]; if(!file) return;
      const reader=new FileReader(); reader.onload=()=>{ loadCsvText(reader.result); };
      reader.readAsText(file);
    });
  }
  const recalc=document.getElementById('recalculateBtn'); if(recalc) recalc.addEventListener('click', applyRulesAndRender);
  const exportRulesBtn=document.getElementById('exportRulesBtn'); if(exportRulesBtn) exportRulesBtn.addEventListener('click', exportTotals);
  const exportTotalsBtn=document.getElementById('exportTotalsBtn'); if(exportTotalsBtn) exportTotalsBtn.addEventListener('click', exportTotals);
  const importRulesBtn=document.getElementById('importRulesBtn'); if(importRulesBtn) importRulesBtn.addEventListener('click', ()=>document.getElementById('importRulesInput').click());
  const importRulesInput=document.getElementById('importRulesInput'); if(importRulesInput) importRulesInput.addEventListener('change',(e)=>{ const f=e.target.files && e.target.files[0]; if(f){ const reader=new FileReader(); reader.onload=()=>{ const text=reader.result||''; const box=document.getElementById('rulesBox'); if(box) box.value=text; applyRulesAndRender(); }; reader.readAsText(f); }});
  const clearFilterBtn=document.getElementById('clearFilterBtn'); if(clearFilterBtn) clearFilterBtn.addEventListener('click', ()=>{
    CURRENT_FILTER=null; try{localStorage.removeItem(LS_KEYS.FILTER);}catch{} updateFilterUI();
    CURRENT_PAGE=1; renderTransactionsTable(); renderMonthTotals(monthFilteredTxns());
  });
  const clearMonthBtn=document.getElementById('clearMonthBtn'); if(clearMonthBtn) clearMonthBtn.addEventListener('click', ()=>{
    MONTH_FILTER=""; try{localStorage.removeItem(LS_KEYS.MONTH);}catch{} const msel=document.getElementById('monthFilter'); if(msel) msel.value="";
    updateMonthBanner(); CURRENT_PAGE=1; applyRulesAndRender();
  });
  const monthSel=document.getElementById('monthFilter'); if(monthSel) monthSel.addEventListener('change',(e)=>{
    MONTH_FILTER=e.target.value||""; try{localStorage.setItem(LS_KEYS.MONTH, MONTH_FILTER);}catch{}
    updateMonthBanner(); CURRENT_PAGE=1; applyRulesAndRender();
  });

  // Restore rules + state
  (async ()=>{
    let restored=false;
    try{ const saved=localStorage.getItem(LS_KEYS.RULES); if(saved && saved.trim()){ const box=document.getElementById('rulesBox'); if(box) box.value=saved; restored=true; } }catch{}
    if(!restored){ try{ const res=await fetch('rules.txt'); const text=await res.text(); const box=document.getElementById('rulesBox'); if(box) box.value=text; restored=true; }catch{} }
    if(!restored){ const box=document.getElementById('rulesBox'); if(box) box.value = `# Rules format: KEYWORD => CATEGORY\n`; }
    try{ const savedFilter=localStorage.getItem(LS_KEYS.FILTER); CURRENT_FILTER=savedFilter && savedFilter.trim() ? savedFilter.toUpperCase() : null; }catch{}
    try{ const savedMonth=localStorage.getItem(LS_KEYS.MONTH); MONTH_FILTER=savedMonth||""; }catch{}
    updateFilterUI(); CURRENT_PAGE=1; updateMonthBanner();
  })();

  applyTxnsCollapsedUI();
});

function isTxnsCollapsed(){ try{ return localStorage.getItem(LS_KEYS.TXNS_COLLAPSED) !== 'false'; }catch{ return true; } }
function setTxnsCollapsed(v){ try{ localStorage.setItem(LS_KEYS.TXNS_COLLAPSED, v?'true':'false'); }catch{} }
function applyTxnsCollapsedUI(){ const body=document.getElementById('transactionsBody'); const toggle=document.getElementById('txnsToggleBtn'); const collapsed=isTxnsCollapsed(); if(body) body.style.display=collapsed?'none':''; if(toggle) toggle.textContent=collapsed?'Show transactions':'Hide transactions'; }
function toggleTransactions(){ const collapsed=isTxnsCollapsed(); setTxnsCollapsed(!collapsed); applyTxnsCollapsedUI(); }
