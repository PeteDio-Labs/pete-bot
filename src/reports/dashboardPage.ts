/**
 * The dashboard page (PET-868), one self-contained document: no build step, no external asset.
 * Every value from the feed is placed with textContent or setAttribute, never as HTML, because
 * PR titles are other people's text. A link is used only when it starts with https://github.com/.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Weekly PRs</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1b1f24;--mute:#5d6672;--line:#dde1e6;--accent:#2f6fed;--bar:#8fb0f5;--warn:#9a5b00}
@media (prefers-color-scheme:dark){:root{--bg:#0f1318;--card:#171c23;--ink:#e6e9ee;--mute:#98a2b0;--line:#2a323d;--accent:#6b9bff;--bar:#35527f;--warn:#e3a54a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:980px;margin:0 auto;padding:16px;position:relative}
h1{font-size:20px;margin:8px 0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:14px}
.row{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end}
.big{font-size:40px;font-weight:700;line-height:1}
.mute{color:var(--mute);font-size:13px}
.warn{color:var(--warn);font-size:13px}
select,input{font:inherit;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 10px}
button.chip{font:inherit;font-size:13px;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:3px 10px;cursor:pointer}
button.chip[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:#fff}
.bar{display:flex;align-items:center;gap:8px;margin:4px 0;font-size:13px}
.bar span:last-child{white-space:nowrap}
.bar span:first-child{flex:none;width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar i{display:block;height:10px;background:var(--bar);border-radius:3px}
table{width:100%;border-collapse:collapse;font-size:14px}
td,th{text-align:left;padding:6px 8px;border-top:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--mute);border-top:0}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
#focus{margin:6px 0 0}
#recBody{margin-top:12px}
header.top{display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:5;background:var(--bg);padding:8px 0;margin-bottom:8px}
header.top h1{margin:0}
#menuBtn{flex:none;width:44px;height:44px;display:grid;place-items:center;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:10px;cursor:pointer;padding:0}
#menuBtn[aria-expanded=true]{border-color:var(--accent)}
#menuBtn svg{width:22px;height:22px}
#tabs{position:absolute;left:0;top:56px;width:min(280px,100%);background:var(--card);border:1px solid var(--line);border-radius:10px;padding:6px;box-shadow:0 8px 24px rgba(0,0,0,.18)}
#tabs[hidden]{display:none}
#tabs button{display:block;width:100%;text-align:left;font:inherit;color:var(--ink);background:none;border:0;border-radius:8px;padding:10px 12px;min-height:44px;cursor:pointer}
#tabs button:hover{background:var(--bg)}
#tabs button[aria-current=page]{background:var(--accent);color:#fff}
.tiles{display:flex;gap:22px;flex-wrap:wrap;align-items:flex-end;margin-top:10px}
.delta{font-size:13px;color:var(--mute)}
.cols{display:flex;gap:6px;align-items:flex-end;height:150px;margin-top:10px}
.cols .c{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;gap:3px;background:none;border:0;padding:0;font:inherit;color:var(--ink)}
.cols .c b{font-size:12px;font-weight:600}
.cols .c i{display:block;width:100%;max-width:44px;background:var(--bar);border-radius:4px 4px 0 0;min-height:3px}
.cols .c[aria-current=true] i{background:var(--accent)}
.cols .c span{font-size:11px;color:var(--mute);white-space:nowrap}
.cols button.c{cursor:pointer}
.theme{margin:8px 0}
.theme .t1{display:flex;align-items:center;gap:8px;font-size:14px}
.theme .t1 strong{flex:none;width:76px}
.theme .t1 i{display:block;height:10px;background:var(--bar);border-radius:3px}
.theme .t1 em{font-style:normal;font-size:13px;color:var(--ink)}
.theme .t2{font-size:12px;color:var(--mute);margin-left:84px;overflow-wrap:anywhere}
details.card>summary{cursor:pointer;font-weight:600;min-height:28px}
details.card[open]>summary{margin-bottom:10px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 14px;margin:6px 0 0;font-size:14px}dt{color:var(--mute)}dd{margin:0;overflow-wrap:anywhere}
@media (max-width:640px){
main{padding:12px}
h1{font-size:18px;margin:4px 0 10px}
.card{padding:12px;margin-bottom:10px}
.big{font-size:32px}
header.top{margin:0 -12px 6px;padding:8px 12px}
#tabs{left:12px;width:calc(100% - 24px)}
.cols{gap:4px;height:130px}
.theme .t1 strong{width:64px}.theme .t2{margin-left:72px}
select,input{width:100%;min-height:40px;font-size:16px}
label.mute{display:block;width:100%}
button.chip{min-height:34px;padding:5px 12px}
.bar span:first-child{width:96px}
table.rt thead{display:none}
table.rt,table.rt tbody{display:block}
table.rt tr{display:block;padding:8px 0;border-top:1px solid var(--line)}
table.rt td{display:flex;justify-content:space-between;gap:12px;border:0;padding:2px 0;overflow-wrap:anywhere}
table.rt td::before{content:attr(data-label);flex:none;color:var(--mute);font-size:12px;padding-top:2px}
table.rt td>a,table.rt td{text-align:right}
table.rt td:not([data-label]){display:block;text-align:left}
table.rt td[data-label=Title]{display:block;text-align:left;font-weight:600;padding:3px 0}
table.rt td[data-label=Title]::before{display:none}
dl{grid-template-columns:1fr}
dd{margin-bottom:6px}
}
</style>
</head>
<body>
<main>
<header class="top">
  <button id="menuBtn" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="tabs"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
  <h1 id="h1">Reports</h1>
</header>
<nav id="tabs" aria-label="Reports" hidden></nav>
<div id="status" class="card mute">Loading…</div>
<div id="view" hidden>
  <div class="card">
    <label class="mute">Week <select id="weekSel"></select></label>
    <div class="tiles">
      <div><div class="big" id="total">0</div><div class="mute">merged</div><div class="delta" id="dTotal"></div></div>
      <div><div class="big" id="open">0</div><div class="mute">open when generated</div></div>
      <div><div class="big" id="nrepos">0</div><div class="mute">repos active</div><div class="delta" id="dRepos"></div></div>
      <div><div class="big" id="nthemes">0</div><div class="mute">PET items touched</div></div>
    </div>
    <p id="focus"></p>
    <div id="cover" class="warn"></div>
    <div class="row" style="margin-top:10px;align-items:center">
      <select id="genRepo" aria-label="What to summarize"></select>
      <button id="gen" type="button" class="chip" style="min-height:40px;padding:6px 16px">Generate summary</button>
    </div>
    <div id="genMsg" class="mute" role="status"></div>
  </div>
  <div class="card" id="repoSumCard" hidden><div class="mute">Repo summaries</div><div id="repoSums"></div></div>
  <div class="card"><div class="mute">Merged per week (select a bar)</div><div id="trend" class="cols" role="group" aria-label="Merged PRs per week"></div></div>
  <div class="row" style="align-items:stretch">
    <div class="card" style="flex:1;min-width:260px"><div class="mute">Merged by day, Eastern time</div><div id="days" class="cols" role="img" aria-label="Merged PRs by day of the week"></div></div>
    <div class="card" style="flex:1;min-width:260px"><div class="mute">By repo, with change from last week</div><div id="repos"></div></div>
  </div>
  <div class="card"><div class="mute">What shipped, by PET item</div><div id="themes"></div></div>
  <div class="card"><div class="mute">By author</div><div id="authors"></div></div>
  <details class="card">
    <summary id="listSum">All merged PRs</summary>
    <div class="row" style="margin-bottom:8px"><input id="q" type="search" placeholder="Filter by title or PET key" aria-label="Filter PRs"><div id="chips" class="row" style="gap:6px"></div></div>
    <table class="rt"><thead><tr><th>PR</th><th>Title</th><th>Author</th><th>Merged</th></tr></thead><tbody id="rows"></tbody></table>
  </details>
</div>
<div id="kindview" hidden>
  <div class="card"><div class="row"><label class="mute">Report <select id="recSel"></select></label></div><div id="recBody"></div></div>
</div>
</main>
<script>
(function(){
var $=function(id){return document.getElementById(id)};
var data=[],cur=null,repoFilter=null;
function el(tag,text,attrs){var e=document.createElement(tag);if(text!=null)e.textContent=text;for(var k in(attrs||{}))e.setAttribute(k,attrs[k]);return e}
function clear(n){while(n.firstChild)n.removeChild(n.firstChild)}
function safeUrl(u){return typeof u==='string'&&u.indexOf('https://github.com/')===0?u:null}
function fmtWeek(w){var d=new Date(w+'T00:00:00Z'),e=new Date(d.getTime()+6*864e5),o={month:'short',day:'numeric',timeZone:'UTC'};return d.toLocaleDateString('en-US',o)+' – '+e.toLocaleDateString('en-US',o)+', '+e.getUTCFullYear()}
function bars(box,obj){clear(box);var ent=Object.keys(obj).map(function(k){return[k,obj[k]]}).sort(function(a,b){return b[1]-a[1]||a[0].localeCompare(b[0])});var max=ent.length?ent[0][1]:1;
 if(!ent.length)box.appendChild(el('div','none',{class:'mute'}));
 ent.forEach(function(p){var r=el('div',null,{class:'bar'});r.appendChild(el('span',p[0]));var b=el('i');b.style.width=Math.max(4,Math.round(p[1]/max*100))+'%';r.appendChild(b);r.appendChild(el('span',String(p[1])));box.appendChild(r)})}
function delta(n,prev,label){if(prev==null)return'no earlier week recorded';var d=n-prev;return(d>0?'▲ +'+d:d<0?'▼ −'+(-d):'= same')+' vs '+label+' ('+prev+')'}
function columns(box,items,onpick){clear(box);var max=Math.max.apply(null,items.map(function(x){return x.v}).concat([1]));
 items.forEach(function(x){var c=el(onpick?'button':'div',null,{class:'c',title:x.t,'aria-label':x.t});if(x.cur)c.setAttribute('aria-current','true');
  c.appendChild(el('b',String(x.v)));var b=el('i');b.style.height=Math.max(3,Math.round(x.v/max*100))+'px';b.style.height=(x.v/max*100)+'%';b.style.minHeight='3px';c.appendChild(b);c.appendChild(el('span',x.l));
  if(onpick)c.onclick=function(){onpick(x.k)};box.appendChild(c)})}
function prevWeek(w){var t=Date.parse(w.week+'T00:00:00Z')-7*864e5,p=new Date(t).toISOString().slice(0,10);return data.filter(function(x){return x.week===p})[0]||null}
var DAYS=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
function dayOf(iso){var d=new Date(iso).toLocaleDateString('en-US',{weekday:'short',timeZone:'America/New_York'});return DAYS.indexOf(d)}
function themes(box,w){clear(box);var g={};
 w.merged.forEach(function(p){var ks=p.petKeys&&p.petKeys.length?p.petKeys.map(function(k){return'PET-'+k}):['No PET key'];ks.forEach(function(k){var e=g[k]||(g[k]={n:0,repos:{},title:p.title});e.n++;e.repos[p.repo]=1})});
 var ent=Object.keys(g).map(function(k){return[k,g[k]]}).sort(function(a,b){return b[1].n-a[1].n||a[0].localeCompare(b[0])});
 if(!ent.length){box.appendChild(el('div','No merged PRs recorded for this week.',{class:'mute'}));return}
 var max=ent[0][1].n;
 ent.slice(0,10).forEach(function(p){var t=el('div',null,{class:'theme'}),r=el('div',null,{class:'t1'});r.appendChild(el('strong',p[0]));var b=el('i');b.style.width=Math.max(4,Math.round(p[1].n/max*60))+'%';r.appendChild(b);r.appendChild(el('em',p[1].n+(p[1].n===1?' PR':' PRs')));t.appendChild(r);
  t.appendChild(el('div',p[1].title+' · '+Object.keys(p[1].repos).join(', '),{class:'t2'}));box.appendChild(t)});
 if(ent.length>10)box.appendChild(el('div','and '+(ent.length-10)+' more in the list below',{class:'mute'}))}
function repoBars(box,w,pw){clear(box);var ent=Object.keys(w.byRepo).map(function(k){return[k,w.byRepo[k]]}).sort(function(a,b){return b[1]-a[1]||a[0].localeCompare(b[0])});var max=ent.length?ent[0][1]:1;
 if(!ent.length)box.appendChild(el('div','none',{class:'mute'}));
 ent.forEach(function(p){var r=el('div',null,{class:'bar'});r.appendChild(el('span',p[0]));var b=el('i');b.style.width=Math.max(4,Math.round(p[1]/max*100))+'%';r.appendChild(b);
  var d=pw?p[1]-(pw.byRepo[p[0]]||0):null;r.appendChild(el('span',p[1]+(d==null?'':d>0?'  ▲'+d:d<0?'  ▼'+(-d):'  =')));box.appendChild(r)})}
function genOpts(w){var s=$('genRepo'),keep=s.value;clear(s);var o=el('option','Whole week');o.value='';s.appendChild(o);Object.keys(w.byRepo).sort().forEach(function(r){var x=el('option','Repo: '+r);x.value=r;s.appendChild(x)});s.value=keep&&w.byRepo[keep]?keep:''}
function repoSums(w){var box=$('repoSums'),m=w.repoSummaries||{},ks=Object.keys(m).sort();clear(box);$('repoSumCard').hidden=!ks.length;
 ks.forEach(function(k){var d=el('div',null,{class:'theme'});d.appendChild(el('strong',k));d.appendChild(el('div',m[k].text));d.appendChild(el('div','Written '+new Date(m[k].at).toLocaleString()+' · '+m[k].model+' · '+m[k].prs+' PR(s)',{class:'mute'}));box.appendChild(d)})}
function generate(){var w=cur,repo=$('genRepo').value,b=$('gen'),msg=$('genMsg');b.disabled=true;msg.textContent='Writing the summary. This takes up to a minute.';msg.className='mute';
 fetch('api/weeks/'+encodeURIComponent(w.week)+'/summary',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(repo?{repo:repo}:{})})
 .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j})})
 .then(function(j){var cached=j.cached;delete j.cached;for(var i=0;i<data.length;i++)if(data[i].week===j.week)data[i]=j;if(cur.week===j.week)cur=j;render();msg.textContent=cached?'Already written, so nothing was generated again.':'Summary written '+new Date().toLocaleTimeString()+'.';msg.className='mute'})
 .catch(function(e){msg.textContent='Not written: '+e.message;msg.className='warn'}).then(function(){b.disabled=false})}
function render(){
 var w=cur;genOpts(w);repoSums(w);$('total').textContent=String(w.total);$('open').textContent=String(w.openNow);
 var f=$('focus');
 if(w.summary&&w.summary.text)f.textContent=w.summary.text+(w.summary.source==='ollama'?'':'');else f.textContent='Summary not generated'+(w.summary&&w.summary.reason?' ('+w.summary.reason+')':'')+'.';
 var c=w.coverage,notes=[];
 if(c.unread.length)notes.push('At least this many: '+c.unread.length+' repo(s) not read ('+c.unread.join(', ')+').');
 if(c.floorRepos.length)notes.push('At least this many: the read of '+c.floorRepos.join(', ')+' stopped inside the week.');
 $('cover').textContent=notes.join(' ')||('Read '+c.reposRead+' of '+c.reposTotal+' repos. Generated '+new Date(w.generatedAt).toLocaleString()+(w.summary.source==='ollama'?' · summary by '+w.summary.model:'')+'.');
 var pw=prevWeek(w);
 $('dTotal').textContent=delta(w.total,pw?pw.total:null,'last week');
 var nr=Object.keys(w.byRepo).length;$('nrepos').textContent=String(nr);$('dRepos').textContent=pw?delta(nr,Object.keys(pw.byRepo).length,'last week'):'';
 var tk={};w.merged.forEach(function(p){(p.petKeys||[]).forEach(function(k){tk[k]=1})});$('nthemes').textContent=String(Object.keys(tk).length);
 repoBars($('repos'),w,pw);bars($('authors'),w.byAuthor);themes($('themes'),w);
 var dc=[0,0,0,0,0,0,0];w.merged.forEach(function(p){var i=dayOf(p.mergedAt);if(i>=0)dc[i]++});
 columns($('days'),DAYS.map(function(d,i){return{k:i,l:d,v:dc[i],t:d+': '+dc[i]+' merged'}}));
 $('listSum').textContent='All merged PRs ('+w.merged.length+')';
 var chips=$('chips');clear(chips);
 Object.keys(w.byRepo).sort().forEach(function(r){var b=el('button',r,{class:'chip','aria-pressed':String(repoFilter===r)});b.onclick=function(){repoFilter=repoFilter===r?null:r;render()};chips.appendChild(b)});
 var q=$('q').value.trim().toLowerCase(),tb=$('rows');clear(tb);var shown=0;
 w.merged.forEach(function(p){
  if(repoFilter&&p.repo!==repoFilter)return;
  var hay=(p.title+' '+p.repo+' '+p.author+' '+p.petKeys.map(function(k){return'pet-'+k}).join(' ')).toLowerCase();
  if(q&&hay.indexOf(q)<0)return;shown++;
  var tr=el('tr'),u=safeUrl(p.url),td=el('td',null,{'data-label':'PR'});
  if(u){var a=el('a',p.repo+'#'+p.number,{href:u,rel:'noopener noreferrer'});td.appendChild(a)}else td.textContent=p.repo+'#'+p.number;
  tr.appendChild(td);tr.appendChild(el('td',p.title,{'data-label':'Title'}));tr.appendChild(el('td',p.author,{'data-label':'Author'}));
  tr.appendChild(el('td',new Date(p.mergedAt).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}),{'data-label':'Merged'}));tb.appendChild(tr)});
 if(!shown){var r=el('tr'),t=el('td',w.merged.length?'No PR matches the filter.':'No merged PRs recorded for this week.',{colspan:'4',class:'mute'});r.appendChild(t);tb.appendChild(r)}
 var rev=data.slice(0,12).reverse();
 columns($('trend'),rev.map(function(x){var d=new Date(x.week+'T00:00:00Z');return{k:x.week,l:d.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'}),v:x.total,cur:x.week===w.week,t:fmtWeek(x.week)+': '+x.total+' merged'}}),select)}
function select(week){cur=data.filter(function(x){return x.week===week})[0];repoFilter=null;$('weekSel').value=week;render()}

var kinds=[],tab='weekly',kindData={},seq=0;
var TITLES={cve:'Daily CVE',cycle:'Plane cycle'};
var title=function(k){return k==='weekly'?'Weekly PRs':(TITLES[k]||k)};
function plain(v){if(v==null)return'none';if(typeof v==='object')return JSON.stringify(v);return String(v)}
function recDefault(box,rec){var dl=el('dl');Object.keys(rec).forEach(function(k){dl.appendChild(el('dt',k));dl.appendChild(el('dd',plain(rec[k])))});box.appendChild(dl)}
var RENDER={};
function rtable(heads,rows){var t=el('table',null,{class:'rt'}),th=el('thead'),h=el('tr'),tb=el('tbody');heads.forEach(function(x){h.appendChild(el('th',x))});th.appendChild(h);t.appendChild(th);
 rows.forEach(function(r){var tr=el('tr');r.forEach(function(x,i){tr.appendChild(el('td',x,{'data-label':heads[i]}))});tb.appendChild(tr)});t.appendChild(tb);return t}
RENDER.cve=function(box,r){var e=r.examined||{},un=e.hostsUnread||[],gaps=r.gaps||[];
 box.appendChild(el('div',String(r.findings),{class:'big'}));
 box.appendChild(el('div','findings: '+r.actionable+' actionable, '+r.exploited+' exploited, by severity '+Object.keys(r.bySeverity||{}).map(function(k){return k+' '+r.bySeverity[k]}).join(', '),{class:'mute'}));
 box.appendChild(el('p','Examined '+e.hostsRead+' host(s)'+(un.length?'; not read: '+un.join(', '):'')+', '+e.queries+' package queries, '+e.advisoriesFetched+' of '+e.advisories+' advisories, '+(e.kevEntries==null?'CISA list not read':e.kevEntries+' CISA entries')+', inventory '+e.snapshotAgeHours+' h old, '+e.images+' container image(s) listed, not matched.',{class:'mute'}));
 if(!r.complete||gaps.length)box.appendChild(el('p',(r.complete?'Notes: ':'Incomplete: ')+gaps.join(' '),{class:'warn'}));
 if((r.top||[]).length)box.appendChild(rtable(['Package','Installed','Fixed','Severity','Hosts','CVE'],r.top.map(function(f){return[f.package,f.installed,f.fixed||'no fix',f.severity+(f.kev?' · exploited':''),(f.hosts||[]).join(', '),f.cve||'']})))};
RENDER.cycle=function(box,r){var c=r.cycle;
 if(!c){box.appendChild(el('p','No cycle: '+(r.reason||'none found')+'.',{class:'warn'}));return}
 box.appendChild(el('div',c.name,{class:'mute'}));box.appendChild(el('div',r.done+' / '+r.total,{class:'big'}));
 box.appendChild(el('div','done · '+r.open+' open, '+r.inProgress+' in progress, '+r.needsPedro+' need Pedro · '+c.start+' to '+c.end,{class:'mute'}));
 var br=r.byRoute||{};box.appendChild(el('p',['pedro','ai','other'].map(function(k){var t=br[k]||{total:0,done:0};return k+' '+t.done+'/'+t.total}).join(' · ')+(r.lost?' · '+r.lost+' cycle item(s) not on the board read':''),{class:'mute'}));
 if((r.openItems||[]).length)box.appendChild(rtable(['Item','Title','State','Labels'],r.openItems.map(function(i){return['PET-'+i.seq,i.name,i.state,(i.labels||[]).join(', ')]})))};
function showRec(kind,id){var box=$('recBody');clear(box);var rec=(kindData[kind]||[]).filter(function(r){return r.id===id})[0];if(!rec){box.appendChild(el('p','No record.',{class:'mute'}));return}
 (RENDER[kind]||recDefault)(box,rec)}
function showKind(kind,bad){var sel=$('recSel');clear(sel);var rs=kindData[kind]||[];
 if(!rs.length){clear($('recBody'));$('recBody').appendChild(el('p','No report of this kind has been stored yet.',{class:'mute'}))}
 if(bad.length)$('recBody').appendChild(el('p','Could not read: '+bad.join(', ')+'.',{class:'warn'}));
 if(!rs.length)return
 rs.forEach(function(r){var o=el('option',r.id);o.value=r.id;sel.appendChild(o)});
 sel.onchange=function(){showRec(kind,sel.value);if(bad.length)$('recBody').appendChild(el('p','Could not read: '+bad.join(', ')+'.',{class:'warn'}))};showRec(kind,rs[0].id);if(bad.length)$('recBody').appendChild(el('p','Could not read: '+bad.join(', ')+'.',{class:'warn'}))}
function pick(k){tab=k;
 Array.prototype.forEach.call($('tabs').children,function(b){if(b.getAttribute('data-kind')===k)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
 $('h1').textContent=title(k);menu(false);
 $('view').hidden=(k!=='weekly'||!data.length);$('kindview').hidden=(k==='weekly');$('status').style.display=(k==='weekly'?'':'none');
 if(k==='weekly')return;
 var mine=++seq;
 fetch('api/reports/'+encodeURIComponent(k),{credentials:'same-origin'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(j){if(mine!==seq)return;kindData[k]=(j.records||[]).filter(function(r){return r&&typeof r.id==='string'});showKind(k,j.unreadable||[])})
 .catch(function(e){if(mine!==seq)return;var b=$('recBody');clear(b);b.appendChild(el('p','Could not load this report: '+e.message,{class:'warn'}))})}
function tabs(){var n=$('tabs');clear(n);
 ['weekly'].concat(kinds.map(function(x){return x.kind})).forEach(function(k){var b=el('button',title(k),{type:'button','data-kind':k});if(k===tab)b.setAttribute('aria-current','page');b.onclick=function(){pick(k)};n.appendChild(b)})}
function menu(open){var n=$('tabs'),b=$('menuBtn');n.hidden=!open;b.setAttribute('aria-expanded',String(open));b.setAttribute('aria-label',open?'Close menu':'Open menu')}
$('menuBtn').onclick=function(e){e.stopPropagation();menu($('tabs').hidden)};
document.addEventListener('click',function(e){if(!$('tabs').hidden&&!$('tabs').contains(e.target))menu(false)});
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!$('tabs').hidden){menu(false);$('menuBtn').focus()}});
function loadKinds(){fetch('api/reports',{credentials:'same-origin'}).then(function(r){return r.ok?r.json():{kinds:[]}}).then(function(j){kinds=j.kinds||[];tabs()}).catch(function(){})}
fetch('api/weeks',{credentials:'same-origin'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(j){
 data=j.weeks||[];var s=$('status');
 if(j.unreadable&&j.unreadable.length){s.textContent='Could not read: '+j.unreadable.join(', ')+'. ';s.className='card warn'}
 tabs();loadKinds();
 if(!data.length){s.textContent=((j.unreadable&&j.unreadable.length)?s.textContent:'')+'No weekly report has run yet. The first one is written on a Sunday evening.';return}
 if(!(j.unreadable&&j.unreadable.length))s.hidden=true;
 var sel=$('weekSel');data.forEach(function(x){var o=el('option',fmtWeek(x.week)+' · '+x.total);o.value=x.week;sel.appendChild(o)});
 sel.onchange=function(){select(sel.value)};$('gen').onclick=generate;$('q').oninput=function(){render()};
 $('view').hidden=false;select(data[0].week)
}).catch(function(e){var s=$('status');s.textContent='Could not load the reports: '+e.message;s.className='card warn'});
})();
</script>
</body>
</html>
`;
