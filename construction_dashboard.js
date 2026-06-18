// Same-origin when served over HTTP(S) (the ACC backend serves this page in
// deployment, so /api/* hits it directly â€” no exposed :3001). A localStorage
// 'backend_url' override still wins; opening the file directly (file://) uses
// localhost:3001 for local dev.
const BACKEND = localStorage.getItem('backend_url') ??
  (location.protocol.startsWith('http') ? '' : 'http://localhost:3001');
/* HTML-escape â€” applied to all backend-supplied strings rendered via innerHTML */
function esc(v){const d=document.createElement('div');d.textContent=String(v??'');return d.innerHTML;}
const C=s=>getComputedStyle(document.documentElement).getPropertyValue(s).trim();

/* â”€â”€ Auth â€” per-user session token from POST /api/login â”€â”€ */
let TOKEN=sessionStorage.getItem('klim_token')||'';
function authHeaders(){return TOKEN?{Authorization:'Bearer '+TOKEN}:{}}
function showLogin(msg){
  const o=document.getElementById('login-overlay');
  o.style.display='flex';
  document.getElementById('login-error').textContent=msg||'';
}
async function doLogin(ev){
  ev.preventDefault();
  const username=document.getElementById('login-user').value.trim();
  const password=document.getElementById('login-pass').value;
  try{
    const r=await fetch(BACKEND+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
    const data=await r.json();
    if(!r.ok||!data.ok){showLogin(data.error||'Login failed');return}
    sessionStorage.setItem('klim_token',data.token);
    location.reload(); // restart with token â€” all fetches pick it up
  }catch{showLogin('Cannot reach backend at '+BACKEND)}
}
let authPrompted=false;
function onUnauthorized(){
  sessionStorage.removeItem('klim_token');TOKEN='';
  if(!authPrompted){authPrompted=true;showLogin('Session expired â€” please log in again')}
}
async function logout(){
  try{await fetch(BACKEND+'/api/logout',{method:'POST',headers:authHeaders()})}catch{}
  sessionStorage.removeItem('klim_token');TOKEN='';location.reload();
}
if(!TOKEN)showLogin();

async function tryFetch(p,fb){try{const r=await fetch(BACKEND+p,{headers:authHeaders()});if(r.status===401){onUnauthorized();return fb}if(!r.ok)throw 0;return await r.json()}catch{return fb}}
function setEl(id,v){const e=document.getElementById(id);if(e)e.textContent=v}
function mkChart(id,cfg){const c=document.getElementById(id);if(!c)return null;return new Chart(c,cfg)}

/* â”€â”€ Tab switcher â”€â”€ */
function T(name,el){
  document.querySelectorAll('.tab-section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const sec=document.getElementById('tab-'+name);
  if(sec)sec.classList.add('active');
  if(el)el.classList.add('active');
}

/* â”€â”€ Last-sync clock â”€â”€ */
function refreshTime(){setEl('lastSync',new Date().toLocaleTimeString('en-SG',{hour:'2-digit',minute:'2-digit'}))}
refreshTime();setInterval(refreshTime,60000);

/* â”€â”€ UniCon project cards â”€â”€ */
function renderProjects(results){
  const el=document.getElementById('uc-projects-grid');
  if(!el||!results)return;
  el.innerHTML=results.map(p=>{
    const barCls=p.progress>=70?'pb-green':p.progress>=40?'pb-blue':'pb-amber';
    const pillCls=p.status==='active'?'pill-green':'pill-amber';
    return'<div class=”mc mc-pad”><div class=”mc-hd”><span class=”mc-name”>'+esc(p.name)+'</span><span class=”pill '+pillCls+'”>'+esc(p.status)+'</span></div><div class=”pbw”><div class=”pb '+barCls+'” data-pb-w=”'+p.progress+'%”></div></div><div class=”mc-foot”>'+p.progress+'% \xb7 '+(p.tasks?p.tasks.done+'/'+p.tasks.total:0)+' tasks \xb7 Due '+(p.dueDate||'—')+'</div></div>';
  }).join('');
  el.querySelectorAll('.pb[data-pb-w]').forEach(b=>{b.style.width=b.dataset.pbW;});
}

/* â”€â”€ Connection status dots â”€â”€ */
function setConn(key,ok,label){
  const dot=document.getElementById('dot-'+key),txt=document.getElementById('txt-'+key);
  if(dot)dot.style.background=ok?'var(--green)':'var(--amber)';
  if(txt){txt.style.color=ok?'var(--green)':'var(--amber)';txt.textContent=label;}
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   CHARTS â€” all 26 initialised at startup with mock data;
   loadAll() will update datasets once backend responds.
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
const ACC='rgba(232,97,10',QSE='rgba(0,85,204',UC='rgba(109,40,217',IDD='rgba(13,148,136';
const _a=(c,o)=>c+','+o+')';

/* ACC â€” RFI status doughnut */
const chRFI=mkChart('c-rfi-status',{type:'doughnut',data:{labels:['Open','Overdue','Closed'],datasets:[{data:[12,3,28],backgroundColor:[_a(ACC,.85),_a('rgba(185,28,28',.85),_a(QSE,.6)],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{boxWidth:10,font:{size:10}}}}}});

/* ACC â€” RFI by discipline bar */
const chRFIDisc=mkChart('c-rfi-disc',{type:'bar',data:{labels:['Arch','Struct','M&E','Civil','FaÃ§ade'],datasets:[{label:'RFIs',data:[14,9,7,5,8],backgroundColor:_a(ACC,.75)}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,ticks:{font:{size:10}}},x:{ticks:{font:{size:10}}}}}});

/* ACC â€” Defect severity doughnut */
const chDefSev=mkChart('c-def-sev',{type:'doughnut',data:{labels:['Critical','Major','Minor'],datasets:[{data:[4,11,19],backgroundColor:['#b91c1c','#d97706','#2e7d32'],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{boxWidth:10,font:{size:10}}}}}});

/* ACC â€” Defect by location bar */
const chDefLoc=mkChart('c-def-loc',{type:'bar',data:{labels:['L1-3','L4-8','L9-14','Roof','Ext'],datasets:[{label:'Defects',data:[8,12,6,3,5],backgroundColor:_a(ACC,.7)}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,ticks:{font:{size:10}}},x:{ticks:{font:{size:10}}}}}});

/* ACC â€” Checklist type pie */
const chCL=mkChart('c-cl-type',{type:'pie',data:{labels:['Safety','Quality','MEP','Structural'],datasets:[{data:[18,22,14,8],backgroundColor:[_a(QSE,.8),_a(ACC,.8),'#7c3aed','#0d9488'],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{boxWidth:10,font:{size:10}}}}}});

/* ACC â€” Progress line */
const weeks=['Wk14','Wk15','Wk16','Wk17','Wk18','Wk19','Wk20','Wk21','Wk22','Wk23','Wk24'];
const chProg=mkChart('c-prog-line',{type:'line',data:{labels:weeks,datasets:[{label:'Planned %',data:[22,25,28,32,35,40,44,48,52,56,60],borderColor:_a(QSE,1),backgroundColor:_a(QSE,.08),tension:.3,fill:true},{label:'Actual %',data:[21,23,26,30,33,38,41,44,48,52,null],borderColor:_a(ACC,1),backgroundColor:_a(ACC,.08),tension:.3,fill:true}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{font:{size:10}}}},scales:{y:{min:0,max:70,ticks:{font:{size:10}}},x:{ticks:{font:{size:10}}}}}});

/* ACC â€” Progress by category horizontal bar */
const chProgCat=mkChart('c-prog-cat',{type:'bar',data:{labels:['Substructure','Superstructure','FaÃ§ade','M&E Rough-in','Finishes'],datasets:[{label:'Planned',data:[100,68,45,30,10],backgroundColor:_a(QSE,.35)},{label:'Actual',data:[100,62,38,22,5],backgroundColor:_a(ACC,.75)}]},options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{labels:{font:{size:10}}}},scales:{x:{min:0,max:105,ticks:{font:{size:10}}},y:{ticks:{font:{size:10}}}}}});

/* ACC â€” S-curve */
const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const chSCurve=mkChart('c-scurve',{type:'line',data:{labels:months,datasets:[{label:'Planned ($M)',data:[0.8,1.9,3.2,4.8,6.5,8.4,10.5,12.9,15.2,17.1,18.6,19.2],borderColor:_a(QSE,1),backgroundColor:_a(QSE,.08),tension:.4,fill:true},{label:'Actual ($M)',data:[0.7,1.7,2.9,4.2,5.8,7.6,null,null,null,null,null,null],borderColor:_a(ACC,1),backgroundColor:_a(ACC,.1),tension:.4,fill:true}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{font:{size:10}}}},scales:{y:{ticks:{callback:v=>'$'+v+'M',font:{size:10}}},x:{ticks:{font:{size:10}}}}}});

/* ACC â€” Cost by package bar */
const chCostBar=mkChart('c-cost-bar',{type:'bar',data:{labels:['Conc','Steel','FaÃ§ade','M&E','Fnsh','Prelim'],datasets:[{label:'Budget',data:[4.2,2.8,3.1,3.5,2.1,1.5],backgroundColor:_a(QSE,.35)},{label:'Committed',data:[3.9,2.7,2.4,2.0,0.6,1.2],backgroundColor:_a(ACC,.75)}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{font:{size:10}}}},scales:{y:{ticks:{callback:v=>'$'+v+'M',font:{size:10}}},x:{ticks:{font:{size:10}}}}}});

/* ACC â€” Cost by package horizontal */
const chCostPkg=mkChart('c-cost-pkg',{type:'bar',data:{labels:['M&E','Struct Steel','FaÃ§ade','Concrete','Prelims','Finishes'],datasets:[{label:'Utilisation %',data:[57,96,77,93,80,29],backgroundColor:[57,96,77,93,80,29].map(v=>v>=90?'#b91c1c':v>=70?'#d97706':'#2e7d32')}]},options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{min:0,max:105,ticks:{callback:v=>v+'%',font:{size:10}}},y:{ticks:{font:{size:10}}}}}});

/* QSE â€” Inspection type doughnut */
const chQI=mkChart('c-qi-type',{type:'doughnut',data:{labels:['Workplace Safety','Quality Insp','Environmental','Fire Safety'],datasets:[{data:[24,31,8,12],backgroundColor:[_a(QSE,.8),_a(ACC,.8),'#0d9488','#d97706'],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{boxWidth:10,font:{size:10}}}}}});

/* QSE â€” Inspection by stage bar */
const chQIStage=mkChart('c-qi-stage',{type:'bar',data:{labels:['Found','Substr','Superstr','FaÃ§ade','M&E','Fnsh'],datasets:[{label:'Pass',data:[12,18,22,14,9,4],backgroundColor:'#2e7d32'},{label:'Fail',data:[1,2,3,2,1,0],backgroundColor:'#b91c1c'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{font:{size:10}}}},scales:{y:{beginAtZero:true,stacked:true,ticks:{font:{size:10}}},x:{stacked:true,ticks:{font:{size:10}}}}}});

/* QSE â€” Safety incident trend line */
const chSITrend=mkChart('c-si-trend',{type:'line',data:{labels:weeks.slice(0,8),datasets:[{label:'Incidents',data:[2,1,3,0,1,2,1,0],borderColor:'#b91c1c',backgroundColor:'rgba(185,28,28,.08)',tension:.3,fill:true},{label:'Near Misses',data:[4,3,5,2,3,4,2,1],borderColor:'#d97706',backgroundColor:'rgba(217,119,6,.08)',tension:.3,fill:true}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{font:{size:10}}}},scales:{y:{beginAtZero:true,ticks:{font:{size:10}}},x:{ticks:{font:{size:10}}}}}});

/* QSE â€” NC by category doughnut */
const chNCCat=mkChart('c-nc-cat',{type:'doughnut',data:{labels:['Workmanship','Materials','Dimensions','Documentation','Safety'],datasets:[{data:[18,9,7,12,5],backgroundColor:[_a(ACC,.8),_a(QSE,.7),'#7c3aed','#0d9488','#d97706'],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{boxWidth:10,font:{size:10}}}}}});

/* QSE â€” NC trend line */
const chNCTrend=mkChart('c-nc-trend',{type:'line',data:{labels:weeks.slice(0,8),datasets:[{label:'Raised',data:[6,4,8,5,7,3,6,4],borderColor:_a(ACC,1),backgroundColor:_a(ACC,.1),tension:.3,fill:true},{label:'Closed',data:[4,5,6,4,5,6,4,5],borderColor:'#2e7d32',backgroundColor:'rgba(46,125,50,.08)',tension:.3,fill:true}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{font:{size:10}}}},scales:{y:{beginAtZero:true,ticks:{font:{size:10}}},x:{ticks:{font:{size:10}}}}}});

/* QSE â€” Attendance by trade bar */
const chAttTrade=mkChart('c-att-trade',{type:'bar',data:{labels:['Concretor','Steel Fixer','Form','M&E','Carp','Tiler','Painter'],datasets:[{label:'Headcount',data:[28,22,18,31,14,9,11],backgroundColor:_a(QSE,.75)}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,ticks:{font:{size:10}}},x:{ticks:{font:{size:10}}}}}});

/* QSE â€” Attendance weekly line */
const chAttWk=mkChart('c-att-week',{type:'line',data:{labels:weeks.slice(0,8),datasets:[{label:'Workers on site',data:[145,138,152,149,155,141,158,162],borderColor:_a(QSE,1),backgroundColor:_a(QSE,.08),tension:.3,fill:true}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:false,ticks:{font:{size:10}}},x:{ticks:{font:{size:10}}}}}});

/* UniCon â€” Task status doughnut */
const chTaskSt=mkChart('c-task-status',{type:'doughnut',data:{labels:['Completed','In Progress','Overdue','Not Started'],datasets:[{data:[34,18,7,22],backgroundColor:['#2e7d32',_a(QSE,.8),'#b91c1c','#9ca3af'],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{boxWidth:10,font:{size:10}}}}}});

/* UniCon â€” Task by project bar */
const chTaskProj=mkChart('c-task-proj',{type:'bar',data:{labels:['KLIM-BLK1','KLIM-BLK2','Punggol HDB','Industrial Pk'],datasets:[{label:'Done',data:[22,12,14,8],backgroundColor:'#2e7d32'},{label:'Active',data:[10,8,7,3],backgroundColor:_a(QSE,.7)},{label:'Overdue',data:[3,4,2,1],backgroundColor:'#b91c1c'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{font:{size:10}}}},scales:{y:{beginAtZero:true,stacked:true,ticks:{font:{size:10}}},x:{stacked:true,ticks:{font:{size:10}}}}}});

/* UniCon â€” Budget utilisation horizontal bar */
const chBudUtil=mkChart('c-bud-util',{type:'bar',data:{labels:['KLIM-BLK1','KLIM-BLK2','Punggol HDB','Industrial Pk'],datasets:[{label:'Utilised %',data:[78,62,45,88],backgroundColor:[78,62,45,88].map(v=>v>=85?'#b91c1c':v>=60?'#d97706':'#2e7d32')}]},options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{min:0,max:105,ticks:{callback:v=>v+'%',font:{size:10}}},y:{ticks:{font:{size:10}}}}}});

/* â”€â”€ IDD Digital Production charts â”€â”€ */
const chDPStatus=mkChart('c-dp-status',{type:'doughnut',data:{labels:['QC Passed','In Production','NCR / Rework','Not Started'],datasets:[{data:[79,28,4,4],backgroundColor:['#2e7d32',_a(IDD,.85),'#b91c1c','#9ca3af'],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{boxWidth:10,font:{size:10}}}}}});

const chDPWeekly=mkChart('c-dp-weekly',{type:'bar',data:{labels:['Wk20','Wk21','Wk22','Wk23','Wk24'],datasets:[{label:'Planned',data:[12,14,14,16,14],backgroundColor:_a(IDD,.3)},{label:'Actual',data:[11,13,15,14,12],backgroundColor:_a(IDD,.8)}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{font:{size:10}}}},scales:{y:{beginAtZero:true,ticks:{font:{size:10}}},x:{ticks:{font:{size:10}}}}}});

const chDPQC=mkChart('c-dp-qc',{type:'bar',data:{labels:['PPVC Mod','Wall Panel','Staircase','Beam','Column'],datasets:[{label:'Pass Rate %',data:[92,100,100,75,95],backgroundColor:[92,100,100,75,95].map(v=>v>=90?_a(IDD,.8):v>=80?'#d97706':'#b91c1c')}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{min:0,max:105,ticks:{callback:v=>v+'%',font:{size:10}}},x:{ticks:{font:{size:10}}}}}});

const chDPCumul=mkChart('c-dp-cumul',{type:'line',data:{labels:['Wk16','Wk18','Wk20','Wk22','Wk24','Wk26','Wk28'],datasets:[{label:'Planned',data:[10,22,38,55,75,98,115],borderColor:_a(QSE,1),backgroundColor:_a(QSE,.08),tension:.3,fill:true,borderDash:[5,3]},{label:'Actual',data:[9,20,36,53,71,null,null],borderColor:_a(IDD,1),backgroundColor:_a(IDD,.1),tension:.3,fill:true}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{font:{size:10}}}},scales:{y:{beginAtZero:true,ticks:{font:{size:10}}},x:{ticks:{font:{size:10}}}}}});

/* â”€â”€ IDD Digital Logistics charts â”€â”€ */
const chDLWeekly=mkChart('c-dl-weekly',{type:'bar',data:{labels:['Wk20','Wk21','Wk22','Wk23','Wk24'],datasets:[{label:'Scheduled',data:[18,21,19,22,20],backgroundColor:_a(IDD,.3)},{label:'Received',data:[17,20,19,21,18],backgroundColor:_a(IDD,.8)}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{font:{size:10}}}},scales:{y:{beginAtZero:true,ticks:{font:{size:10}}},x:{ticks:{font:{size:10}}}}}});

const chDLCat=mkChart('c-dl-cat',{type:'doughnut',data:{labels:['PPVC Module','Precast Panel','Structural Steel','M&E Equipment','Architectural','Materials'],datasets:[{data:[18,24,15,22,9,12],backgroundColor:[_a(IDD,.9),_a(IDD,.7),'#7c3aed',_a(QSE,.7),_a(ACC,.7),'#d97706'],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{boxWidth:10,font:{size:10}}}}}});

const chDLOntime=mkChart('c-dl-ontime',{type:'line',data:{labels:['Feb','Mar','Apr','May','Jun'],datasets:[{label:'On-Time %',data:[84,88,85,91,89],borderColor:_a(IDD,1),backgroundColor:_a(IDD,.08),tension:.3,fill:true,pointRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{min:60,max:100,ticks:{callback:v=>v+'%',font:{size:10}}},x:{ticks:{font:{size:10}}}}}});

const chDLLead=mkChart('c-dl-lead',{type:'bar',data:{labels:['YTL Precast','Straits Precast','Compact Metal','Uni-Air Eng','Sika SG'],datasets:[{label:'Avg Lead Time (days)',data:[14,8,5,21,7],backgroundColor:[14,8,5,21,7].map(v=>v>=18?'#b91c1c':v>=10?'#d97706':_a(IDD,.8))}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,ticks:{font:{size:10}}},x:{ticks:{font:{size:10}}}}}});

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   LOAD ALL â€” fetch backend, update KPIs and charts
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
async function loadAll(){
  const health=await tryFetch('/api/health',null);
  const backendOk=health&&health.status==='ok';

  /* connection status */
  const intStatus=await tryFetch('/api/integrations/status',null);
  /* Provenance: backend health alone does NOT mean the data is live, and
     "configured" (credentials present) is NOT proof of a working connection.
     Per-source live/failed state is carried by each response's _source /
     _integrationError fields. */
  if(!backendOk){
    setEl('srcLabel','Mock data (backend offline)');
  }else{
    const configured=intStatus?['acc','qse','unicon','pbi'].filter(k=>intStatus[k]&&intStatus[k].configured):[];
    setEl('srcLabel',configured.length
      ? 'Configured: '+configured.map(k=>k.toUpperCase()).join(', ')+' Â· other sources demo'
      : 'Demo data â€” no live integrations configured');
  }
  if(intStatus){
    ['acc','qse','unicon','pbi'].forEach(k=>{
      const cfg=intStatus[k]&&intStatus[k].configured;
      setConn(k,cfg,cfg?'Connected â€” live data':'Set credentials in .env');
    });
    /* IDD dot mirrors UniCon (same data source) */
    const iddOk=intStatus.unicon&&intStatus.unicon.configured;
    setConn('idd',iddOk,iddOk?'Connected via UniCon':'Configure UniCon / CBOSS');
  } else {
    ['acc','qse','unicon','pbi','idd'].forEach(k=>setConn(k,false,'Backend offline'));
  }

  /* â”€â”€ ACC RFIs â”€â”€ */
  const rfi=await tryFetch('/api/rfis',null);
  if(rfi&&rfi.results){
    const open=rfi.results.filter(r=>r.status==='open').length;
    const closed=rfi.results.filter(r=>r.status==='closed').length;
    const overdue=rfi.results.filter(r=>r.status==='overdue').length;
    setEl('ov-rfi-open',open);setEl('ov-rfi-od',overdue+' overdue');
    setEl('rfi-open',open);setEl('rfi-closed',closed);setEl('rfi-overdue',overdue);setEl('rfi-total',rfi.results.length);
    if(chRFI){chRFI.data.datasets[0].data=[open,overdue,closed];chRFI.update()}
    const tbody=document.querySelector('#rfi-table tbody');
    if(tbody)tbody.innerHTML=rfi.results.slice(0,8).map(r=>{
      const sc=r.status==='closed'?'pill-green':r.status==='overdue'?'pill-red':'pill-amber';
            return'<tr><td class=”mono”>'+esc(r.id||'—')+'</td><td>'+esc(r.subject||r.title||'—')+'</td><td>'+esc(r.discipline||'—')+'</td><td>—</td><td>'+esc(r.assignedTo||'—')+'</td><td><span class=”pill '+sc+'”>'+esc(r.status)+'</span></td><td>'+esc(r.dueDate||'—')+'</td><td>'+esc(r.agedays!=null?r.agedays+'d':'—')+'</td></tr>';
    }).join('');
  }

  /* â”€â”€ ACC Defects â”€â”€ */
  const def=await tryFetch('/api/defects',null);
  if(def&&def.results){
    const open=def.results.filter(d=>d.status==='open').length;
    setEl('ov-def-open',open);setEl('def-open',open);
    if(chDefSev){
      const crit=def.results.filter(d=>d.severity==='critical').length;
      const maj=def.results.filter(d=>d.severity==='major').length;
      const min=def.results.filter(d=>d.severity==='minor').length;
      chDefSev.data.datasets[0].data=[crit,maj,min];chDefSev.update();
    }
  }

  /* â”€â”€ QSE Safety â”€â”€ */
  const qseSaf=await tryFetch('/api/qse/safety',null);
  if(qseSaf){
    setEl('ov-nc',qseSaf.open);setEl('ov-nc-wk',(qseSaf.thisWeek||0)+' raised this week');
    setEl('safety-closed',qseSaf.closed);setEl('si-found',qseSaf.open);
    setEl('nc-open',qseSaf.open);setEl('nc-closed',qseSaf.closed);
  }

  /* â”€â”€ QSE PTW â”€â”€ */
  const ptw=await tryFetch('/api/qse/ptw',null);
  if(ptw&&ptw.results){
    const active=ptw.results.filter(p=>p.status==='active').length;
    const expiring=ptw.results.filter(p=>p.status==='expiring').length;
    setEl('ov-ptw',active);setEl('ov-ptw-exp',expiring+' expiring soon');
    setEl('ptw-active',active);setEl('ptw-expiring',expiring);
    setEl('ptw-expired',ptw.results.filter(p=>p.status==='expired').length);
    const tbody=document.querySelector('#ptw-table tbody');
    if(tbody)tbody.innerHTML=ptw.results.slice(0,8).map(p=>{
      const sc=p.status==='active'?'pill-green':p.status==='expiring'?'pill-amber':'pill-red';
      return'<tr><td class=”mono”>'+esc(p.id||'—')+'</td><td>—</td><td>'+esc(p.work||'—')+'</td><td>'+esc(p.location||'—')+'</td><td>—</td><td>'+esc(p.issuer||'—')+'</td><td>—</td><td>'+esc(p.expiry||'—')+'</td><td><span class=”pill '+sc+'”>'+esc(p.status)+'</span></td></tr>';
    }).join('');
  }

  /* â”€â”€ QSE Inspections â”€â”€ */
  const insp=await tryFetch('/api/qse/inspections',null);
  if(insp&&insp.results){
    const pass=insp.results.filter(i=>(i.defects||0)===0).length;
    const fail=insp.results.filter(i=>(i.defects||0)>0).length;
    setEl('qi-pass',pass);setEl('qi-fail',fail);setEl('qi-total',insp.results.length);
  }

  /* â”€â”€ QSE Attendance â”€â”€ */
  const att=await tryFetch('/api/qse/attendance',null);
  if(att){
    setEl('ov-workers',att.todayTotal??att.today);setEl('ov-workers-sub','Peak: '+(att.peakThisWeek||att.today)+' this week');
    setEl('att-today',att.todayTotal??att.today);setEl('att-peak',att.peakThisWeek||att.todayTotal||att.today);
  }

  /* â”€â”€ UniCon Projects â”€â”€ */
  const ucProj=await tryFetch('/api/unicon/projects',null);
  if(ucProj&&ucProj.results){
    renderProjects(ucProj.results);
    setEl('ov-proj',ucProj.results.filter(p=>p.status==='active').length);
    if(chTaskProj){
      const done=ucProj.results.map(p=>p.tasks?p.tasks.done:0);
      chTaskProj.data.datasets[0].data=done;chTaskProj.update();
    }
  }

  /* â”€â”€ UniCon Tasks â”€â”€ */
  const ucTask=await tryFetch('/api/unicon/tasks',null);
  if(ucTask&&(ucTask.results||ucTask.tasks)){const _t=ucTask.results||ucTask.tasks;
    const comp=_t.filter(t=>t.status==='completed').length;
    const active=_t.filter(t=>t.status==='inProgress'||t.status==='in-progress').length;
    const ovrd=_t.filter(t=>t.status==='overdue').length;
    if(chTaskSt){chTaskSt.data.datasets[0].data=[comp,active,ovrd,Math.max(0,_t.length-comp-active-ovrd)];chTaskSt.update()}
  }

  /* â”€â”€ UniCon Budget â”€â”€ */
  const ucBud=await tryFetch('/api/unicon/budget',null);
  if(ucBud&&ucBud.projects){
    if(chBudUtil){chBudUtil.data.datasets[0].data=ucBud.projects.map(p=>p.utilPct??p.utilisation??0);chBudUtil.update()}
  }

  /* â”€â”€ IDD Digital Production â”€â”€ */
  const idProd=await tryFetch('/api/idd/production',null);
  if(idProd){
    setEl('dp-total',idProd.totalElements||'â€”');
    setEl('dp-passed',idProd.qcPassed||'â€”');
    setEl('dp-inprod',idProd.inProduction||'â€”');
    setEl('dp-ncr',idProd.openNCRs||'â€”');
    setEl('dp-total-sub','across '+(idProd.batches||'â€”')+' batches');
    if(idProd.statusBreakdown&&chDPStatus){chDPStatus.data.datasets[0].data=[idProd.statusBreakdown.passed,idProd.statusBreakdown.inProduction,idProd.statusBreakdown.ncr,idProd.statusBreakdown.notStarted];chDPStatus.update()}
    if(idProd.weeklyRate&&chDPWeekly){chDPWeekly.data.datasets[0].data=idProd.weeklyRate.planned;chDPWeekly.data.datasets[1].data=idProd.weeklyRate.actual;chDPWeekly.update()}
    if(idProd.cumulPlan&&chDPCumul){chDPCumul.data.datasets[0].data=idProd.cumulPlan;chDPCumul.data.datasets[1].data=idProd.cumulActual;chDPCumul.update()}
  }

  /* â”€â”€ IDD Digital Logistics â”€â”€ */
  const idLog=await tryFetch('/api/idd/logistics',null);
  if(idLog){
    setEl('dl-today',idLog.deliveriesToday||'â€”');
    setEl('dl-week',idLog.completedThisWeek||'â€”');
    setEl('dl-ontime',(idLog.onTimeRate||'â€”')+(typeof idLog.onTimeRate==='number'?'%':''));
    setEl('dl-pending',idLog.pending||'â€”');
    if(idLog.weeklyPerf&&chDLWeekly){chDLWeekly.data.datasets[0].data=idLog.weeklyPerf.scheduled;chDLWeekly.data.datasets[1].data=idLog.weeklyPerf.received;chDLWeekly.update()}
    if(idLog.onTimeTrend&&chDLOntime){chDLOntime.data.datasets[0].data=idLog.onTimeTrend;chDLOntime.update()}
  }

  /* â”€â”€ Power BI reports list â”€â”€ */
  const pbiRep=await tryFetch('/api/powerbi-reports',null);
  if(pbiRep&&(pbiRep.reports||pbiRep.value)){const _r=pbiRep.reports||pbiRep.value;
    const listEl=document.getElementById('pbi-report-list');
    const guideEl=document.getElementById('pbi-setup-guide');
    const embedEl=document.getElementById('pbi-embed-container');
    const pbiLive=intStatus&&intStatus.pbi&&intStatus.pbi.configured;
    if(listEl){
      listEl.innerHTML='';
      /* Build via DOM + addEventListener: the report id is bound as a JS value,
         never concatenated into a markup/handler string, so a malicious or
         compromised report id cannot inject script (DOM XSS). */
      let firstId=null;
      _r.forEach((r,i)=>{
        if(i===0) firstId=r.id;
        const div=document.createElement('div');
        div.dataset.reportId=r.id;
        div.style.cssText='padding:.6rem .9rem;cursor:pointer;border-radius:6px;margin-bottom:.3rem;background:#fff;border:1px solid var(--border);font-size:.84rem;transition:background .12s';
        div.textContent=(r.name==null?'':String(r.name));
        div.addEventListener('click',()=>{
          listEl.querySelectorAll('[data-report-id]').forEach(d=>d.style.background='#fff');
          div.style.background='#e8f0fe';
          loadPbiReport(r.id);
        });
        div.addEventListener('mouseover',()=>{if(div.style.background!=='#e8f0fe')div.style.background='#f0f4ff'});
        div.addEventListener('mouseout',()=>{if(div.style.background!=='#e8f0fe')div.style.background='#fff'});
        listEl.appendChild(div);
      });
      listEl.style.display='block';
      if(pbiLive){
        if(guideEl) guideEl.style.display='none';
        if(embedEl) embedEl.style.display='block';
        if(firstId) loadPbiReport(firstId);  // auto-load first report when credentials are live
      }
    }
  }
}
loadAll();

/* â”€â”€ Table search â”€â”€ */
function filterTable(tableId, inputId) {
  const q = document.getElementById(inputId).value.toLowerCase();
  const rows = document.querySelectorAll('#' + tableId + ' tbody tr');
  rows.forEach(tr => {
    tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

/* â”€â”€ Mobile sidebar toggle â”€â”€ */
function toggleSidebar(){
  const sb=document.getElementById('main-sidebar');
  const ov=document.getElementById('sidebar-overlay');
  sb.classList.toggle('open');
  ov.classList.toggle('open');
}
/* Close sidebar when a nav item is clicked on mobile */
document.querySelectorAll('.nav-item').forEach(el=>{
  el.addEventListener('click',()=>{
    if(window.innerWidth<=768){
      document.getElementById('main-sidebar').classList.remove('open');
      document.getElementById('sidebar-overlay').classList.remove('open');
    }
  });
});

/* â”€â”€ Power BI Embedded â”€â”€ */
async function initPBI(){
  return new Promise(resolve=>{
    if(window.powerbi){resolve();return}
    const s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/powerbi-client@2.22.3/dist/powerbi.min.js';
    s.onload=()=>resolve();document.head.appendChild(s);
  });
}

window.loadPbiReport=async function(reportId){
  await initPBI();
  const container=document.getElementById('pbi-embed-container');
  const guide=document.getElementById('pbi-setup-guide');
  if(!container)return;
  container.style.display='block';
  container.innerHTML='<div class="pbi-msg">Loading report…</div>';
  const data=await tryFetch('/api/powerbi-embed?reportId='+encodeURIComponent(reportId),null);
  if(!data||data.error){
    container.innerHTML='<div class="pbi-msg pbi-msg-err">&#x26A0; '+esc(data&&data.error?data.error:'Unable to load report. Check Power BI credentials in .env')+'</div>';
    return;
  }
  if(data._source==='mock'||!data.embedToken){
    container.innerHTML='<div class="pbi-msg">Power BI Embedded requires Azure AD credentials in .env<br><br><a href="https://learn.microsoft.com/en-us/power-bi/developer/embedded/embed-service-principal" target="_blank" class="pbi-lnk">Setup guide &#x2192;</a></div>';
    return;
  }
  if(guide) guide.style.display='none';
  const cfg={type:'report',id:data.reportId,embedUrl:data.embedUrl,accessToken:data.embedToken,
    tokenType:window.models.TokenType.Embed,
    settings:{navContentPaneEnabled:true,filterPaneEnabled:true}};
  container.innerHTML='';
  const report=window.powerbi.embed(container,cfg);
  // Refresh the embed token before it expires (Power BI tokens default to 60 min).
  report.on('tokenExpired',async()=>{
    const fresh=await tryFetch('/api/powerbi-embed?reportId='+encodeURIComponent(reportId),null);
    if(fresh&&fresh.embedToken) report.setAccessToken(fresh.embedToken).catch(()=>{});
  });
};

/* ── Static delegated click handler ── */
document.body.addEventListener('click', e => {
  const t = e.target.closest('[data-action],[data-section]');
  if (!t) return;
  const action = t.dataset.action, section = t.dataset.section;
  if (section)                        { e.preventDefault(); T(section, t); }
  else if (action === 'toggle-sidebar') toggleSidebar();
  else if (action === 'logout')         { e.preventDefault(); logout(); }
});

/* ── Static event listeners (replaced inline onsubmit / oninput / onchange) ── */
document.querySelector('.login-card').addEventListener('submit', doLogin);
const _el = id => document.getElementById(id);
const _on = (id, ev, fn) => { const e = _el(id); if (e) e.addEventListener(ev, fn); };
_on('rfi-search',       'input',  () => filterTable('rfi-table', 'rfi-search'));
_on('def-search',       'input',  () => filterTable('def-table', 'def-search'));
_on('sub-search',       'input',  () => filterTable('sub-table', 'sub-search'));
_on('pbi-report-select','change', function() { loadPbiReport(this.value); });
