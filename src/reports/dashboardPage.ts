/**
 * The dashboard page (PET-868), one self-contained document: no build step, no external asset.
 * Every value from the feed is placed with textContent or setAttribute, never as HTML, because
 * PR titles are other people's text. A link is used only when it starts with https://github.com/.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0a0a0c">
<title>Weekly PRs</title>
<style>
/* Dark-only Apple HIG with Liquid Glass: the PeteDio house style (apple-design skill). */
:root{--bg:#000;--surface:#1c1c1e;--surface-2:#2c2c2e;--hairline:rgba(255,255,255,.08);--separator:rgba(84,84,88,.65);
--label:#fff;--label-2:rgba(235,235,245,.6);--label-3:rgba(235,235,245,.3);
--green:#30d158;--red:#ff453a;--orange:#ff9f0a;--blue:#0a84ff;--btn:#0071e3;
--glass-line:rgba(255,255,255,.12);--glass-rim:rgba(255,255,255,.28);--glass-base:blur(20px) saturate(180%);--glass-thick:blur(40px) saturate(200%);
--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:20px;--s6:24px;--s8:32px;--r-hero:24px;--d-fast:200ms;--d-normal:300ms;--r-card:16px;--r-group:12px;--r-capsule:9999px;
--ease:cubic-bezier(.25,.1,.25,1);--spring:cubic-bezier(.175,.885,.32,1.275);--bar:rgba(10,132,255,.4);--accent:var(--blue)}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;min-height:100svh;background:var(--bg);color:var(--label);font:15px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
h1{font-size:22px;font-weight:700;letter-spacing:-.3px;margin:0}
.card{position:relative;isolation:isolate;overflow:hidden;background:rgba(28,28,30,.72);-webkit-backdrop-filter:var(--glass-base);backdrop-filter:var(--glass-base);border:1px solid var(--glass-line);border-radius:var(--r-card);box-shadow:0 8px 32px rgba(0,0,0,.45),inset 0 1px 1px var(--glass-rim),inset 0 -1px 1px rgba(255,255,255,.08);padding:var(--s4)}
.card::before{content:"";position:absolute;inset:0;z-index:-1;border-radius:inherit;pointer-events:none;background:linear-gradient(135deg,rgba(255,255,255,.07),rgba(255,255,255,.02) 30%,transparent 60%)}
@supports not (backdrop-filter:blur(1px)){.card{background:var(--surface)}}
@media (prefers-reduced-transparency:reduce){.card{background:var(--surface);-webkit-backdrop-filter:none;backdrop-filter:none}}
.row{display:flex;gap:var(--s3);flex-wrap:wrap;align-items:flex-end}
#view:not([hidden]),#kindview:not([hidden]){display:flex;flex-direction:column;gap:var(--s3)}
.mute{color:var(--label-2);font-size:13px}
.title{font-size:15px;font-weight:650;letter-spacing:-.2px;color:var(--label);margin:0 0 var(--s2)}
.warn{color:var(--orange);font-size:13px}
select,input{font:inherit;font-size:15px;color:var(--label);background:rgba(255,255,255,.07);border:1px solid var(--glass-line);border-radius:var(--r-group);padding:var(--s2) var(--s3);min-height:36px}
select{max-width:100%}
.btn,button.chip{font:inherit;color:var(--label);cursor:pointer;background:linear-gradient(160deg,rgba(255,255,255,.1),rgba(255,255,255,.04));border:1px solid var(--glass-line);box-shadow:inset 0 1px 0 rgba(255,255,255,.08);transition:transform 180ms var(--spring),border-color 200ms,box-shadow 200ms}
.btn{font-size:15px;font-weight:600;border-radius:var(--r-capsule);min-height:36px;padding:var(--s2) var(--s5)}
.btn.primary{background:var(--btn);border-color:var(--btn);color:#fff}
.btn:hover,button.chip:hover{transform:translateY(-2px);border-color:rgba(10,132,255,.55);box-shadow:0 10px 26px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.09)}
.btn:active,button.chip:active{transform:scale(.985)}
.btn:disabled{opacity:.5;cursor:default;transform:none}
button.chip{font-size:13px;border-radius:var(--r-capsule);min-height:32px;padding:var(--s1) var(--s3)}
button.chip[aria-pressed=true]{background:var(--btn);border-color:var(--btn);color:#fff}
:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{text-align:left;padding:var(--s2);border-top:1px solid var(--hairline);vertical-align:top;color:var(--label-2)}
th{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--label-2);border-top:0}
td:nth-child(2){color:var(--label);font-weight:550}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
#focus{margin:var(--s3) 0 0;font-size:17px;line-height:1.45}
#recBody{margin-top:var(--s3)}
header.top{display:flex;align-items:center;gap:var(--s3);position:sticky;top:0;z-index:5;padding:var(--s2) 0;background:linear-gradient(#000 70%,transparent)}
#menuBtn{flex:none;width:44px;height:44px;display:grid;place-items:center;color:var(--label);background:linear-gradient(160deg,rgba(255,255,255,.1),rgba(255,255,255,.04));border:1px solid var(--glass-line);border-radius:var(--r-group);cursor:pointer;padding:0;box-shadow:inset 0 1px 0 rgba(255,255,255,.08)}
#menuBtn[aria-expanded=true]{border-color:var(--blue)}
#menuBtn svg{width:20px;height:20px}
#tabs{position:absolute;left:0;top:56px;z-index:6;width:min(280px,100%);background:rgba(28,28,30,.86);-webkit-backdrop-filter:var(--glass-thick);backdrop-filter:var(--glass-thick);border:1px solid var(--glass-line);border-radius:var(--r-card);padding:var(--s2);box-shadow:0 24px 80px rgba(0,0,0,.6),inset 0 1px 1px var(--glass-rim)}
#tabs[hidden]{display:none}
#tabs button{display:block;width:100%;text-align:left;font:inherit;font-size:15px;color:var(--label);background:none;border:0;border-radius:var(--r-group);padding:var(--s3);min-height:44px;cursor:pointer}
#tabs button:hover{background:rgba(255,255,255,.08)}
#tabs button[aria-current=page]{background:var(--btn);color:#fff}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2px var(--s4);margin:var(--s2) 0 0;font-size:13px}dt{color:var(--label-2)}dd{margin:0;overflow-wrap:anywhere}

html{background:radial-gradient(80% 640px at 50% 0,rgba(255,255,255,.07),transparent),radial-gradient(circle at 1px 1px,rgba(255,255,255,.07) 1px,transparent 1.5px) 0 0/24px 24px,#000;color-scheme:dark}
body{background:none}
main{max-width:980px;margin:0 auto;padding:var(--s4);position:relative;display:flex;flex-direction:column;gap:var(--s8);overflow-x:clip}
.card{background:rgba(28,28,30,.55)}
.big{font-size:28px;font-weight:700;letter-spacing:-.6px;line-height:1.1}
h2{font-size:20px;font-weight:700;letter-spacing:-.3px;margin:0}
.section,#view:not([hidden]),#kindview:not([hidden]){display:flex;flex-direction:column;gap:var(--s3)}
#view:not([hidden]){gap:var(--s8)}
.card{display:flex;flex-direction:column;gap:var(--s3)}
.card.hero{border-radius:var(--r-hero);padding:var(--s6);gap:var(--s5)}
.hero-top{display:flex;justify-content:space-between;align-items:flex-start;gap:var(--s3);flex-wrap:wrap}
.stat{display:flex;flex-direction:column;gap:var(--s1);min-width:0}
.stat-label{font-size:13px;font-weight:600;color:var(--label-2)}
.stat-value{font-size:28px;font-weight:700;letter-spacing:-.6px;line-height:1}
.stat-value small{font-size:15px;font-weight:600;letter-spacing:0;color:var(--label-2);margin-left:var(--s1)}
.stat-foot{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2);margin-top:var(--s1)}
.cmp{font-size:13px;color:var(--label-2)}
.stats{display:grid;gap:var(--s4);grid-template-columns:repeat(auto-fit,minmax(min(100%,9rem),1fr))}
.stats .stat+.stat{border-left:1px solid var(--hairline);padding-left:var(--s4)}
.stats .stat-value{font-size:20px;letter-spacing:-.3px}
.delta{display:inline-flex;align-items:center;gap:2px;min-height:22px;padding:2px var(--s2);border-radius:var(--r-capsule);font-size:12px;font-weight:650;white-space:nowrap}
.delta svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
.delta.good{color:var(--green);background:color-mix(in srgb,var(--green) 16%,transparent)}
.delta.bad{color:#ff7a70;background:color-mix(in srgb,#ff7a70 16%,transparent)}
.delta.flat{color:var(--label-2);background:rgba(255,255,255,.08)}
.chart{--h:160px;display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:var(--s2)}
.y{position:relative;height:var(--h);min-width:2ch;font-size:11px;color:var(--label-2);text-align:right}
.y span{position:absolute;right:0;transform:translateY(-50%)}
.plot{position:relative;height:var(--h);display:flex;align-items:flex-end;gap:var(--s2);border-bottom:1px solid var(--separator);background:linear-gradient(var(--hairline),var(--hairline)) 0 0/100% 1px no-repeat,linear-gradient(var(--hairline),var(--hairline)) 0 50%/100% 1px no-repeat}
.col{position:relative;flex:1;min-width:0;height:100%;display:flex;align-items:flex-end;justify-content:center;padding:0;border:0;background:none;font:inherit;color:inherit}
button.col{cursor:pointer}
.col i{display:block;width:100%;max-width:40px;height:var(--v);min-height:2px;border-radius:6px 6px 2px 2px;background:rgba(235,235,245,.4);transform-origin:bottom;transition:background var(--d-fast) var(--ease);animation:grow 500ms var(--ease) backwards}
.col[aria-current=true] i{background:var(--blue)}
.col:hover i,.col:focus-visible i{background:rgba(235,235,245,.6)}
.col[aria-current=true]:hover i{background:var(--blue)}
.col .val{position:absolute;bottom:calc(var(--v) + var(--s1));font-size:12px;font-weight:650}
.tip{position:absolute;top:0;left:50%;z-index:2;transform:translate(-50%,4px);pointer-events:none;padding:var(--s1) var(--s2);border-radius:8px;white-space:nowrap;text-align:left;background:rgba(58,58,60,.96);border:1px solid var(--glass-line);box-shadow:0 8px 24px rgba(0,0,0,.5);font-size:12px;color:var(--label-2);opacity:0;transition:opacity var(--d-fast) var(--ease),transform var(--d-fast) var(--ease)}
.tip b{display:block;color:var(--label);font-size:13px}
.col:hover .tip,.col:focus-visible .tip{opacity:1;transform:translate(-50%,0)}
.col:first-child .tip{left:0;transform:translate(0,4px)}
.col:last-child .tip{left:auto;right:0;transform:translate(0,4px)}
.col:is(:first-child,:last-child):is(:hover,:focus-visible) .tip{transform:none}
.col:is(:hover,:focus-visible) .val{opacity:0}
.x{grid-column:2;display:flex;gap:var(--s2);margin-top:var(--s2);font-size:11px;color:var(--label-2)}
.x span{flex:1;min-width:0;text-align:center;white-space:nowrap}
.x span[aria-current=true]{color:var(--label);font-weight:650}
.col:focus-visible{outline-offset:-2px}
.rank{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--s3)}
.rank li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--s1) var(--s3);align-items:baseline}
.rank .name{min-width:0;font-size:13px;overflow-wrap:anywhere}
.rank .name b{font-weight:650}
.rank .sub{font-size:12px;color:var(--label-2);margin-top:2px}
.rank .num{display:inline-flex;align-items:center;gap:var(--s2);font-size:13px;font-weight:650}
.rank .track{grid-column:1/-1;height:6px;border-radius:var(--r-capsule);background:rgba(255,255,255,.06);overflow:hidden}
.rank .track i{display:block;height:100%;border-radius:inherit;background:rgba(235,235,245,.4);transform-origin:left;animation:growx 500ms var(--ease) backwards}
.rank li:first-child .track i{background:var(--blue)}
.empty{display:flex;flex-direction:column;align-items:flex-start;gap:var(--s2);padding:var(--s4);border:1px dashed var(--glass-line);border-radius:var(--r-group)}
.empty p{margin:0}.empty .what{font-size:15px;font-weight:600}.empty .why{font-size:13px;color:var(--label-2)}
.sk{display:block;border-radius:6px;background:linear-gradient(90deg,rgba(255,255,255,.06) 30%,rgba(255,255,255,.12) 50%,rgba(255,255,255,.06) 70%) 0 0/300% 100%;animation:shimmer 1.4s linear infinite}
.sk.line{height:13px;margin-top:var(--s2)}.sk.num{height:28px;width:40%}
@keyframes shimmer{from{background-position:100% 0}to{background-position:0 0}}
@keyframes rise{from{opacity:0;transform:translateY(8px)}}
@keyframes grow{from{transform:scaleY(0)}}
@keyframes growx{from{transform:scaleX(0)}}
#view>*{animation:rise var(--d-normal) var(--ease) backwards}
#view>*:nth-child(2){animation-delay:50ms}#view>*:nth-child(3){animation-delay:100ms}#view>*:nth-child(4){animation-delay:150ms}
@media (hover:hover){.btn:hover,button.chip:hover{transform:translateY(-1px)}}
.btn.primary{background:linear-gradient(#0a7bf0,#0071e3)}
details.card>summary{cursor:pointer;font-size:15px;font-weight:650;min-height:28px}
details.card[open]>summary{margin-bottom:var(--s3)}
.hint{font-size:13px;color:var(--label-2)}
.grid{display:grid;gap:var(--s3);grid-template-columns:repeat(auto-fit,minmax(min(100%,290px),1fr))}
.section{gap:var(--s4)!important}
#focus{margin:0}#focus[hidden],#emptySum[hidden]{display:none}
.gen{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center}
@media (pointer:coarse){button.chip,.btn,select,input{min-height:44px}details.card>summary{min-height:44px;display:flex;align-items:center}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}.btn:hover,button.chip:hover{transform:none}}
@media (max-width:640px){
.card.hero{padding:var(--s4)}
main{padding:var(--s3);gap:var(--s6)}
.chart{--h:132px}
.plot,.x{gap:0}
.col{padding:0 3px}
.stats{grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--s3)}
.stats .stat+.stat{padding-left:var(--s3)}
header.top{margin:0 calc(-1*var(--s3));padding:var(--s2) var(--s3)}
#tabs{left:var(--s3);width:calc(100% - 2*var(--s3))}
select,input{width:100%;font-size:17px}
label.mute{display:block;width:100%}
details.card>summary{min-height:44px;display:flex;align-items:center}
table.rt td a{display:inline-flex;align-items:center;min-height:44px}
table.rt thead{display:none}
table.rt,table.rt tbody{display:block}
table.rt tr{display:block;padding:var(--s2) 0;border-top:1px solid var(--hairline)}
table.rt td{display:flex;justify-content:space-between;gap:var(--s3);border:0;padding:2px 0;overflow-wrap:anywhere}
table.rt td::before{content:attr(data-label);flex:none;color:var(--label-2);font-size:12px;padding-top:2px}
table.rt td>a,table.rt td{text-align:right}
table.rt td:not([data-label]){display:block;text-align:left}
table.rt td[data-label=Title]{display:block;text-align:left;font-weight:600;color:var(--label);padding:3px 0}
table.rt td[data-label=Title]::before{display:none}
dl{grid-template-columns:1fr}
dd{margin-bottom:var(--s2)}
}
</style>
</head>
<body>
<main>
<header class="top">
  <button id="menuBtn" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="tabs"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
  <h1 id="h1">Reports</h1>
  <nav id="tabs" aria-label="Reports" hidden></nav>
</header>
<div id="status" class="card mute" role="status"><span class="sk num"></span><span class="sk line"></span><span class="sk line" style="width:70%"></span></div>
<div id="view" hidden>
  <section class="card hero" aria-label="Merged PRs this week">
    <div class="hero-top">
      <div class="stat">
        <div class="stat-label">Merged PRs</div>
        <div class="stat-value"><span id="total">0</span><small>PRs</small></div>
        <div class="stat-foot"><span id="dTotal"></span><span class="cmp" id="cTotal"></span></div>
      </div>
      <label class="mute">Week <select id="weekSel"></select></label>
    </div>
    <div id="trend" class="chart" role="group" aria-label="Merged PRs per week. Select a bar to open that week."></div>
    <div class="stats">
      <div class="stat"><div class="stat-label">Open PRs</div><div class="stat-value" id="open">0</div><div class="stat-foot" id="dOpen"></div></div>
      <div class="stat"><div class="stat-label">Repos active</div><div class="stat-value" id="nrepos">0</div><div class="stat-foot" id="dRepos"></div></div>
      <div class="stat"><div class="stat-label">PET items</div><div class="stat-value" id="nthemes">0</div><div class="stat-foot" id="dThemes"></div></div>
    </div>
  </section>
  <section class="card" aria-label="Summary">
    <h2>Summary</h2>
    <p id="focus"></p>
    <div id="emptySum" class="empty" hidden><p class="what">No summary for this week yet</p><p class="why" id="emptyWhy"></p></div>
    <div id="cover" class="hint"></div>
    <div class="gen">
      <select id="genRepo" aria-label="What to summarize"></select>
      <button id="gen" type="button" class="btn primary">Generate summary</button>
    </div>
    <div id="genMsg" class="hint" role="status"></div>
    <div id="repoSumCard" hidden><div class="title">Repo summaries</div><div id="repoSums"></div></div>
  </section>
  <section class="section">
    <h2>Breakdown</h2>
    <div class="grid">
      <div class="card"><div class="title">By repo</div><div class="hint">Change from last week</div><div id="repos"></div></div>
      <div class="card"><div class="title">Merged by day</div><div class="hint">Eastern time</div><div id="days" class="chart" role="img" aria-label="Merged PRs by day of the week"></div></div>
      <div class="card"><div class="title">By author</div><div id="authors"></div></div>
    </div>
  </section>
  <section class="section">
    <h2>What shipped</h2>
    <div class="card"><div id="themes"></div></div>
  </section>
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
function icon(k){var s=document.createElementNS('http://www.w3.org/2000/svg','svg');s.setAttribute('viewBox','0 0 12 12');s.setAttribute('aria-hidden','true');var p=document.createElementNS('http://www.w3.org/2000/svg','path');p.setAttribute('d',k>0?'M6 10V2M2.5 5.5 6 2l3.5 3.5':k<0?'M6 2v8M2.5 6.5 6 10l3.5-3.5':'M2 6h8');s.appendChild(p);return s}
function chip(n,prev,badUp){if(prev==null||typeof prev!=='number')return null;var d=n-prev,c=el('span',null,{class:'delta '+(d===0?'flat':((d>0)!==!!badUp)?'good':'bad')});c.appendChild(icon(d));c.appendChild(document.createTextNode(d===0?'Same':(d>0?'+':'−')+Math.abs(d)));return c}
function setChip(box,n,prev,badUp){clear(box);var c=chip(n,prev,badUp);if(c)box.appendChild(c)}
function ceilTo(max){for(var k=1;k<=1e9;k*=10)for(var i=0;i<8;i++){var v=[1,2,2.5,4,5,6,8,10][i]*k;if(v>=max&&v>=2&&v%2===0&&v===Math.floor(v))return v}return 2}
function chart(box,items,onpick){clear(box);var max=Math.max.apply(null,items.map(function(x){return x.v}).concat([0])),top=ceilTo(max);
 var y=el('div',null,{class:'y','aria-hidden':'true'});[[top,0],[top/2,50],[0,100]].forEach(function(q){var s=el('span',String(q[0]));s.style.top=q[1]+'%';y.appendChild(s)});
 var plot=el('div',null,{class:'plot'}),x=el('div',null,{class:'x','aria-hidden':'true'});
 items.forEach(function(it,i){var c=el(onpick?'button':'div',null,{class:'col','aria-label':it.t});if(onpick)c.setAttribute('type','button');if(it.cur)c.setAttribute('aria-current','true');
  var b=el('i');c.style.setProperty('--v',(it.v/top*100)+'%');b.style.animationDelay=(i*30)+'ms';c.appendChild(b);
  if(it.cur)c.appendChild(el('span',String(it.v),{class:'val'}));
  var t=el('span',null,{class:'tip'});t.appendChild(el('b',String(it.v)));t.appendChild(document.createTextNode(it.tip||it.l));c.appendChild(t);
  if(onpick)c.onclick=function(){onpick(it.k)};plot.appendChild(c);
  var lab=el('span',it.l);if(it.cur)lab.setAttribute('aria-current','true');x.appendChild(lab)});
 box.appendChild(y);box.appendChild(plot);box.appendChild(x)}
function rankList(box,ents,limit){clear(box);if(!ents.length){box.appendChild(el('div','Nothing recorded for this week.',{class:'hint'}));return}
 var max=ents[0].n||1,open=false,ul=el('ul',null,{class:'rank'}),btn=null;
 function paint(){clear(ul);(open?ents:ents.slice(0,limit)).forEach(function(e,i){var li=el('li'),nm=el('div',null,{class:'name'});
  if(e.bold){nm.appendChild(el('b',e.bold));nm.appendChild(document.createTextNode(' '+e.name))}else nm.appendChild(document.createTextNode(e.name));
  if(e.sub)nm.appendChild(el('div',e.sub,{class:'sub'}));li.appendChild(nm);
  var nu=el('div',null,{class:'num'});nu.appendChild(document.createTextNode(String(e.n)));if(e.chip)nu.appendChild(e.chip);li.appendChild(nu);
  var tr=el('div',null,{class:'track'}),f=el('i');f.style.width=Math.max(3,Math.round(e.n/max*100))+'%';f.style.animationDelay=(i*30)+'ms';tr.appendChild(f);li.appendChild(tr);ul.appendChild(li)});
  if(btn)btn.textContent=open?'Show fewer':'Show all '+ents.length}
 box.appendChild(ul);
 if(ents.length>limit){btn=el('button',null,{type:'button',class:'chip'});btn.style.marginTop='12px';btn.setAttribute('aria-expanded','false');btn.onclick=function(){open=!open;btn.setAttribute('aria-expanded',String(open));paint()};box.appendChild(btn)}
 paint()}
function sortEnt(obj){return Object.keys(obj).map(function(k){return[k,obj[k]]}).sort(function(a,b){return b[1]-a[1]||a[0].localeCompare(b[0])})}
function prevWeek(w){var t=Date.parse(w.week+'T00:00:00Z')-7*864e5,p=new Date(t).toISOString().slice(0,10);return data.filter(function(x){return x.week===p})[0]||null}
var DAYS=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
function dayOf(iso){var d=new Date(iso).toLocaleDateString('en-US',{weekday:'short',timeZone:'America/New_York'});return DAYS.indexOf(d)}
function themes(box,w){var g={};
 w.merged.forEach(function(p){var ks=p.petKeys&&p.petKeys.length?p.petKeys.map(function(k){return'PET-'+k}):['No PET key'];ks.forEach(function(k){var e=g[k]||(g[k]={n:0,repos:{},title:p.title});e.n++;e.repos[p.repo]=1})});
 var ent=Object.keys(g).map(function(k){return[k,g[k]]}).sort(function(a,b){return b[1].n-a[1].n||a[0].localeCompare(b[0])});
 rankList(box,ent.map(function(p){return{bold:p[0],name:p[1].title,sub:Object.keys(p[1].repos).join(', '),n:p[1].n}}),8)}
function petCount(w){var tk={};(w.merged||[]).forEach(function(p){(p.petKeys||[]).forEach(function(k){tk[k]=1})});return Object.keys(tk).length}
function genOpts(w){var s=$('genRepo'),keep=s.value;clear(s);var o=el('option','Whole week');o.value='';s.appendChild(o);Object.keys(w.byRepo).sort().forEach(function(r){var x=el('option','Repo: '+r);x.value=r;s.appendChild(x)});s.value=keep&&w.byRepo[keep]?keep:''}
function repoSums(w){var box=$('repoSums'),m=w.repoSummaries||{},ks=Object.keys(m).sort();clear(box);$('repoSumCard').hidden=!ks.length;
 ks.forEach(function(k){var d=el('div');d.style.marginTop='12px';d.appendChild(el('b',k));d.appendChild(el('div',m[k].text));d.appendChild(el('div','Written '+new Date(m[k].at).toLocaleString()+' · '+m[k].model+' · '+m[k].prs+' PR(s)',{class:'hint'}));box.appendChild(d)})}
function generate(){var w=cur,repo=$('genRepo').value,b=$('gen'),msg=$('genMsg');b.disabled=true;msg.textContent='Writing the summary. This takes up to a minute.';msg.className='mute';
 fetch('api/weeks/'+encodeURIComponent(w.week)+'/summary',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(repo?{repo:repo}:{})})
 .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j})})
 .then(function(j){var cached=j.cached;delete j.cached;for(var i=0;i<data.length;i++)if(data[i].week===j.week)data[i]=j;if(cur.week===j.week)cur=j;render();msg.textContent=cached?'Already written, so nothing was generated again.':'Summary written '+new Date().toLocaleTimeString()+'.';msg.className='mute'})
 .catch(function(e){msg.textContent='Not written: '+e.message;msg.className='warn'}).then(function(){b.disabled=false})}
function render(){
 var w=cur,pw=prevWeek(w),pbr=pw&&pw.byRepo?pw.byRepo:null;genOpts(w);repoSums(w);$('total').textContent=String(w.total);$('open').textContent=String(w.openNow);
 $('cTotal').textContent=pw&&typeof pw.total==='number'?'vs last week ('+pw.total+')':'No earlier week recorded';setChip($('dTotal'),w.total,pw?pw.total:null,false);
 setChip($('dOpen'),w.openNow,pw?pw.openNow:null,true);
 var nr=Object.keys(w.byRepo).length,nt=petCount(w);$('nrepos').textContent=String(nr);$('nthemes').textContent=String(nt);
 setChip($('dRepos'),nr,pbr?Object.keys(pbr).length:null,false);setChip($('dThemes'),nt,pw&&pw.merged?petCount(pw):null,false);
 var has=!!(w.summary&&w.summary.text);$('focus').hidden=!has;$('emptySum').hidden=has;
 if(has)$('focus').textContent=w.summary.text;else $('emptyWhy').textContent=w.summary&&w.summary.reason?'Reason: '+w.summary.reason+'.':'Choose Generate summary to write one.';
 var c=w.coverage,notes=[];
 if(c.unread.length)notes.push('At least this many: '+c.unread.length+' repo(s) not read ('+c.unread.join(', ')+').');
 if(c.floorRepos.length)notes.push('At least this many: the read of '+c.floorRepos.join(', ')+' stopped inside the week.');
 var cv=$('cover');cv.textContent=notes.join(' ')||('Read '+c.reposRead+' of '+c.reposTotal+' repos. Generated '+new Date(w.generatedAt).toLocaleString()+(w.summary&&w.summary.source==='ollama'?' · summary by '+w.summary.model:'')+'.');cv.className=notes.length?'warn':'hint';
 rankList($('repos'),sortEnt(w.byRepo).map(function(p){return{name:p[0],n:p[1],chip:pbr?chip(p[1],pbr[p[0]]||0,false):null}}),5);
 rankList($('authors'),sortEnt(w.byAuthor).map(function(p){return{name:p[0],n:p[1]}}),5);themes($('themes'),w);
 var dc=[0,0,0,0,0,0,0];w.merged.forEach(function(p){var i=dayOf(p.mergedAt);if(i>=0)dc[i]++});var best=Math.max.apply(null,dc);
 chart($('days'),DAYS.map(function(d,i){return{k:i,l:d,v:dc[i],cur:best>0&&dc[i]===best&&dc.indexOf(best)===i,t:d+': '+dc[i]+' merged',tip:d}}));
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
 var n=window.innerWidth<=640?6:8,ci=data.indexOf(w),s0=ci<n?0:ci-n+1,rev=data.slice(s0,s0+n).reverse();
 chart($('trend'),rev.map(function(x){var d=new Date(x.week+'T00:00:00Z');return{k:x.week,l:d.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'}),v:x.total,cur:x.week===w.week,t:fmtWeek(x.week)+': '+x.total+' merged',tip:fmtWeek(x.week)}}),select)}
function select(week){cur=data.filter(function(x){return x.week===week})[0];repoFilter=null;$('weekSel').value=week;render()}

var kinds=[],tab='weekly',kindData={},seq=0;
var TITLES={cve:'Daily CVE',cycle:'Plane cycle',plane:'Plane board'};
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
RENDER.plane=function(box,r){
 [['PET','pet'],['MED','med']].forEach(function(p){var b=r[p[1]];box.appendChild(el('h3',p[0]+' board'));
  if(!b||!b.ok){box.appendChild(el('p','Not read: '+((b&&b.unread)||'no data')+'.',{class:'warn'}));return}
  box.appendChild(el('div',String(b.open),{class:'big'}));
  box.appendChild(el('div','open of '+b.items+' items read · '+b.inReview+' in review, '+b.stuckTotal+' waiting '+r.stuckAfterDays+'+ days',{class:'mute'}));
  box.appendChild(el('div','Done per week (by last update): '+b.doneByWeek.map(function(w){return w.week.slice(5)+' '+w.done}).join(' · '),{class:'mute'}));
  box.appendChild(el('p','Open by label: '+b.labelMix.map(function(l){return l.label+' '+l.open}).join(' · '),{class:'mute'}));
  if(b.stuck.length)box.appendChild(rtable(['Item','Title','State','Days'],b.stuck.map(function(i){return[i.key,i.name,i.state,String(i.days)]})))})};
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
