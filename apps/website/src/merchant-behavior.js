export function initializeMerchant() {
const controller=new AbortController();
const previews={
 business:{label:'tab-business',caption:'A clear view of your day. Without the spreadsheet gymnastics.',html:`<div class="dash-heading"><h3>Good morning, Alex ☀</h3><span>This week ⌄</span></div><div class="dash-summary"><div><small>Today’s sales</small><strong>$1,284.00</strong><em>↗ Looking good</em></div><div><small>Processing fees</small><strong>$0.00</strong></div></div><div class="chart" aria-label="Illustrative weekly sales chart">${[39,58,48,73,66,89,78].map((h,i)=>`<div class="bar-col"><i style="height:${h}%"></i><span>${['M','T','W','T','F','S','S'][i]}</span></div>`).join('')}</div>`},
 sales:{label:'tab-sales',caption:'Your products, orders, and stock. All on the same page.',html:`<div class="dash-heading"><h3>Your best sellers.</h3><span>View catalog</span></div><table class="dash-table"><thead><tr><th>PRODUCT</th><th>SOLD TODAY</th><th>STOCK</th></tr></thead><tbody><tr><td>☕ House flat white</td><td>38</td><td><span class="table-status">In stock</span></td></tr><tr><td>🥐 Butter croissant</td><td>24</td><td><span class="table-status">12 left</span></td></tr><tr><td>🫘 Daily blend · 250g</td><td>9</td><td><span class="table-status">In stock</span></td></tr></tbody></table>`},
 team:{label:'tab-team',caption:'Manage weekly pay and your team. $0 per employee.',html:`<div class="dash-heading"><h3>Take care of your people.</h3><span>Manage team</span></div><div class="team-total"><span>Next weekly payroll<br><small>Friday · 3 employees</small></span><strong>$3,300.00</strong></div>${[['AJ','Alex Johnson','$1,250.00'],['MK','Morgan Kim','$1,100.00'],['SR','Sam Rivera','$950.00']].map(([a,n,pay])=>`<div class="team-row"><span><i class="team-avatar">${a}</i>${n}</span><strong class="team-pay">${pay}</strong><small>Scheduled</small></div>`).join('')}`}
};
const tabs=[...document.querySelectorAll('[data-tool]')];
function selectTab(name,focus=false){const item=previews[name];tabs.forEach(t=>{const selected=t.dataset.tool===name;t.setAttribute('aria-selected',String(selected));t.tabIndex=selected?0:-1;if(selected&&focus)t.focus()});document.querySelector('#dashboard-content').innerHTML=item.html;document.querySelector('#tool-caption').textContent=item.caption;document.querySelector('#tool-preview').setAttribute('aria-labelledby',item.label)}
tabs.forEach((tab,i)=>{tab.addEventListener('click',()=>selectTab(tab.dataset.tool));tab.addEventListener('keydown',e=>{let next;if(e.key==='ArrowRight')next=(i+1)%tabs.length;if(e.key==='ArrowLeft')next=(i-1+tabs.length)%tabs.length;if(e.key==='Home')next=0;if(e.key==='End')next=tabs.length-1;if(next!==undefined){e.preventDefault();selectTab(tabs[next].dataset.tool,true)}})});selectTab('business');
const dialog=document.querySelector('#enroll-dialog');let dialogOpener=null;
document.querySelectorAll('[data-enroll]').forEach(b=>b.addEventListener('click',()=>{dialogOpener=b;dialog.showModal()}));
function closeDialog(){dialog.close();dialogOpener?.focus()}
document.querySelector('.dialog-close').addEventListener('click',closeDialog);
dialog.addEventListener('click',e=>{if(e.target===dialog){const b=dialog.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)closeDialog()}});
dialog.addEventListener('close',()=>dialogOpener?.focus());
const menuButton=document.querySelector('.menu-button'),menu=document.querySelector('#mobile-menu');
function closeMenu(){menu.hidden=true;menuButton.setAttribute('aria-expanded','false');menuButton.setAttribute('aria-label','Open navigation')}
menuButton.addEventListener('click',()=>{const open=menuButton.getAttribute('aria-expanded')==='true';menu.hidden=open;menuButton.setAttribute('aria-expanded',String(!open));menuButton.setAttribute('aria-label',open?'Open navigation':'Close navigation')});
menu.querySelectorAll('a,button').forEach(e=>e.addEventListener('click',closeMenu));document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMenu()},{signal:controller.signal});
document.querySelectorAll('.faq-list details').forEach(d=>d.addEventListener('toggle',()=>{if(d.open)document.querySelectorAll('.faq-list details').forEach(other=>{if(other!==d)other.open=false})}));
const demo=document.querySelector('.demo-trigger'),art=document.querySelector('.hero-art');let demoTimer, announcementTimer;
demo.addEventListener('click',()=>{if(demo.disabled)return;demo.disabled=true;art.classList.remove('is-paid');art.classList.add('is-paying');demo.children[1].textContent='A little tap. A lot to love.';clearTimeout(demoTimer);demoTimer=setTimeout(()=>{art.classList.remove('is-paying');art.classList.add('is-paid');demo.disabled=false;demo.children[1].textContent='Try that zero-fee feeling again';const a=document.querySelector('.announcement');a.textContent='Demo approved. $100 sale. $0 processing fee. All yours.';a.classList.add('show');announcementTimer=setTimeout(()=>a.classList.remove('show'),3500)},1100)});
document.querySelector('#year').textContent=new Date().getFullYear();

return ()=>{controller.abort();clearTimeout(demoTimer);clearTimeout(announcementTimer);};
}
