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
main{max-width:980px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:8px 0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:14px}
.row{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end}
.big{font-size:40px;font-weight:700;line-height:1}
.mute{color:var(--mute);font-size:13px}
.warn{color:var(--warn);font-size:13px}
select,input{font:inherit;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 10px}
button.chip{font:inherit;font-size:13px;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:3px 10px;cursor:pointer}
button.chip[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:#fff}
#trend{display:flex;gap:4px;align-items:flex-end;height:80px;margin-top:8px}
#trend button{flex:1;min-width:6px;background:var(--bar);border:0;border-radius:4px 4px 0 0;cursor:pointer;padding:0}
#trend button[aria-current=true]{background:var(--accent)}
.bar{display:flex;align-items:center;gap:8px;margin:4px 0;font-size:13px}
.bar span:first-child{flex:none;width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar i{display:block;height:10px;background:var(--bar);border-radius:3px}
table{width:100%;border-collapse:collapse;font-size:14px}
td,th{text-align:left;padding:6px 8px;border-top:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--mute);border-top:0}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
#focus{margin:6px 0 0}
</style>
</head>
<body>
<main>
<h1>Weekly PRs</h1>
<div id="status" class="card mute">Loading…</div>
<div id="view" hidden>
  <div class="card">
    <div class="row">
      <label class="mute">Week <select id="weekSel"></select></label>
      <div><div class="big" id="total">0</div><div class="mute">merged</div></div>
      <div><div class="big" id="open">0</div><div class="mute">open when generated</div></div>
    </div>
    <p id="focus"></p>
    <div id="cover" class="warn"></div>
  </div>
  <div class="card"><div class="mute">Merged per week</div><div id="trend" role="group" aria-label="Merged PRs per week"></div></div>
  <div class="row" style="align-items:stretch">
    <div class="card" style="flex:1;min-width:260px"><div class="mute">By repo</div><div id="repos"></div></div>
    <div class="card" style="flex:1;min-width:260px"><div class="mute">By author</div><div id="authors"></div></div>
  </div>
  <div class="card">
    <div class="row" style="margin-bottom:8px"><input id="q" type="search" placeholder="Filter by title or PET key" aria-label="Filter PRs"><div id="chips" class="row" style="gap:6px"></div></div>
    <table><thead><tr><th>PR</th><th>Title</th><th>Author</th><th>Merged</th></tr></thead><tbody id="rows"></tbody></table>
  </div>
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
function render(){
 var w=cur;$('total').textContent=String(w.total);$('open').textContent=String(w.openNow);
 var f=$('focus');
 if(w.summary&&w.summary.text)f.textContent=w.summary.text+(w.summary.source==='ollama'?'':'');else f.textContent='Summary not generated'+(w.summary&&w.summary.reason?' ('+w.summary.reason+')':'')+'.';
 var c=w.coverage,notes=[];
 if(c.unread.length)notes.push('At least this many: '+c.unread.length+' repo(s) not read ('+c.unread.join(', ')+').');
 if(c.floorRepos.length)notes.push('At least this many: the read of '+c.floorRepos.join(', ')+' stopped inside the week.');
 $('cover').textContent=notes.join(' ')||('Read '+c.reposRead+' of '+c.reposTotal+' repos. Generated '+new Date(w.generatedAt).toLocaleString()+(w.summary.source==='ollama'?' · summary by '+w.summary.model:'')+'.');
 bars($('repos'),w.byRepo);bars($('authors'),w.byAuthor);
 var chips=$('chips');clear(chips);
 Object.keys(w.byRepo).sort().forEach(function(r){var b=el('button',r,{class:'chip','aria-pressed':String(repoFilter===r)});b.onclick=function(){repoFilter=repoFilter===r?null:r;render()};chips.appendChild(b)});
 var q=$('q').value.trim().toLowerCase(),tb=$('rows');clear(tb);var shown=0;
 w.merged.forEach(function(p){
  if(repoFilter&&p.repo!==repoFilter)return;
  var hay=(p.title+' '+p.repo+' '+p.author+' '+p.petKeys.map(function(k){return'pet-'+k}).join(' ')).toLowerCase();
  if(q&&hay.indexOf(q)<0)return;shown++;
  var tr=el('tr'),u=safeUrl(p.url),td=el('td');
  if(u){var a=el('a',p.repo+'#'+p.number,{href:u,rel:'noopener noreferrer'});td.appendChild(a)}else td.textContent=p.repo+'#'+p.number;
  tr.appendChild(td);tr.appendChild(el('td',p.title));tr.appendChild(el('td',p.author));
  tr.appendChild(el('td',new Date(p.mergedAt).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})));tb.appendChild(tr)});
 if(!shown){var r=el('tr'),t=el('td',w.merged.length?'No PR matches the filter.':'No merged PRs recorded for this week.',{colspan:'4',class:'mute'});r.appendChild(t);tb.appendChild(r)}
 var tr=$('trend');clear(tr);var rev=data.slice().reverse(),max=Math.max.apply(null,rev.map(function(x){return x.total}).concat([1]));
 rev.forEach(function(x){var b=el('button',null,{title:fmtWeek(x.week)+': '+x.total+' merged','aria-label':fmtWeek(x.week)+': '+x.total+' merged'});b.style.height=Math.max(4,Math.round(x.total/max*100))+'%';if(x.week===w.week)b.setAttribute('aria-current','true');b.onclick=function(){select(x.week)};tr.appendChild(b)})}
function select(week){cur=data.filter(function(x){return x.week===week})[0];repoFilter=null;$('weekSel').value=week;render()}
fetch('api/weeks',{credentials:'same-origin'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(j){
 data=j.weeks||[];var s=$('status');
 if(j.unreadable&&j.unreadable.length){s.textContent='Could not read: '+j.unreadable.join(', ')+'. ';s.className='card warn'}
 if(!data.length){s.textContent=(s.textContent||'')+'No weekly report has run yet. The first one is written on a Sunday evening.';return}
 if(!(j.unreadable&&j.unreadable.length))s.hidden=true;
 var sel=$('weekSel');data.forEach(function(x){var o=el('option',fmtWeek(x.week)+' · '+x.total);o.value=x.week;sel.appendChild(o)});
 sel.onchange=function(){select(sel.value)};$('q').oninput=function(){render()};
 $('view').hidden=false;select(data[0].week)
}).catch(function(e){var s=$('status');s.textContent='Could not load the reports: '+e.message;s.className='card warn'});
})();
</script>
</body>
</html>
`;
