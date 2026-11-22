// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
// The garden plot. Classic script; exposes window.Scene. Uses IC.* sprites from app.js.
(function(){
  const REDUCED=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const TIER_H={seed:70,weed:84,thorn:96,vine:118,tree:148,dead:70};
  let root=null,creatureTimers=[],rainbowShown=false,lastArgs=null,lastW=0,resizeT=null;
  // Pills depend on the slot width, so a resize (rotation, split view) re-renders once it settles.
  window.addEventListener('resize',()=>{clearTimeout(resizeT);resizeT=setTimeout(()=>{if(lastArgs&&root&&Math.abs(root.clientWidth-lastW)>40)render.apply(null,lastArgs);},250);});

  // Night Bloom: the garden is always at night. The old day/dusk/dawn skies stay
  // below in case this is ever reverted.
  function skyClass(){return'sky-night';
    const h=new Date().getHours();
    if(h<6||h>=20)return'sky-night';
    if(h<8)return'sky-dawn';
    if(h<17)return'sky-day';
    return'sky-dusk';
  }
  function sunPos(){
    const h=new Date().getHours()+new Date().getMinutes()/60;
    const t=Math.min(1,Math.max(0,(h-6)/14)); // 6am..8pm
    return {x:8+t*84,y:62-Math.sin(t*Math.PI)*50}; // percent of scene
  }
  const COARSE=window.matchMedia&&window.matchMedia('(pointer: coarse)').matches;
  // A garden wider than its frame: arrows page it sideways, edge fades say there is more,
  // and the frame remembers whether it is at the start or the end.
  function wireScroll(el){
    const vp=el.querySelector('.sc-viewport');if(!vp)return;
    const update=()=>{
      const max=vp.scrollWidth-vp.clientWidth;
      el.classList.toggle('at-start',vp.scrollLeft<=2);
      el.classList.toggle('at-end',vp.scrollLeft>=max-2);
    };
    update();
    vp.addEventListener('scroll',update,{passive:true});
    vp.setAttribute('tabindex','0');vp.setAttribute('role','region');vp.setAttribute('aria-label','Your garden, scrolls sideways');
    const page=(dir)=>vp.scrollBy({left:dir*vp.clientWidth*.8,behavior:REDUCED?'auto':'smooth'});
    const prev=el.querySelector('.sc-prev'),next=el.querySelector('.sc-next');
    if(prev)prev.addEventListener('click',()=>page(-1));
    if(next)next.addEventListener('click',()=>page(1));
    vp.addEventListener('keydown',(e)=>{if(e.key==='ArrowRight'){page(1);e.preventDefault();}else if(e.key==='ArrowLeft'){page(-1);e.preventDefault();}});
  }
  // Pause every scene animation while the frame is off screen (scrolling past it on a phone
  // used to keep 30+ sway loops alive and starve the compositor).
  let io=null;
  function watchVisibility(el){
    if(!('IntersectionObserver' in window))return;
    if(io)io.disconnect();
    io=new IntersectionObserver((entries)=>{for(const e of entries)e.target.classList.toggle('is-offscreen',!e.isIntersecting);},{threshold:0});
    io.observe(el);
  }
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function layer(cls){return root?root.querySelector('.'+cls):null}
  function clearCreatures(){creatureTimers.forEach(clearTimeout);creatureTimers=[];}

  function render(container,plants,opts){
    opts=opts||{};
    if(!container)return;
    root=container;lastArgs=[container,plants,opts];lastW=container.clientWidth;
    clearCreatures();
    const n=plants.length;
    const sun=sunPos(),night=skyClass()==='sky-night';
    // Each plant gets at least SLOT_MIN px. Past that the world grows wider than the frame and
    // the garden scrolls sideways (smallest bills, the ones you water first, sit at the left).
    const SLOT_MIN=54;
    const frameW=container.clientWidth||900;
    const worldW=Math.max(frameW,n*SLOT_MIN);
    const slot=worldW/Math.max(1,n);
    const scale=Math.max(.55,Math.min(1,slot/64));
    const dense=slot<64;
    const showPills=n<=8&&slot>=62;
    const tight=slot<100;
    const scrollable=worldW>frameW+2;
    const plantHtml=plants.map((p,i)=>{
      const pad=n>1?(scrollable?2:5):0;
      const x=n===1?50:pad+(i+0.5)/n*(100-2*pad);
      const h=Math.round((TIER_H[p.tierKey]||90)*scale);
      const band=dense?(i%3):0;
      const pct=p.notDue?'<span class="sc-pct">not due</span>':p.done?'<span class="sc-check" role="img" aria-label="bloomed">'+(window.IC&&IC.check?IC.check:'✓')+'</span>':`<span class="sc-pct">${Math.round(p.pct)}%</span>`;
      const pill=showPills?`<div class="sc-pill"><span class="sc-name">${esc(p.name)}</span>${pct}</div>`:'';
      return `<div class="sc-plant ${p.done?'is-done':''} ${dense?'is-dense':''} ${tight?'is-tight':''}" data-plant="${esc(p.id)}" style="left:${x}%;--h:${h}px;--band:${band}" title="${esc(p.name)}, ${Math.round(p.pct)}% watered">
        <div class="sc-art">${p.art}</div>${pill}
      </div>`;
    }).join('');
    const bloomedN=plants.filter(p=>p.done).length;
    container.className='garden-scene '+skyClass()+(scrollable?' is-scrollable':'');
    container.style.setProperty('--n',n||1);
    container.innerHTML=`
      <div class="sc-orb ${night?'moon':'sun'}" style="left:${sun.x}%;top:${sun.y}%"></div>
      <div class="sc-cloud c1"></div><div class="sc-cloud c2"></div>
      <div class="sc-badge" data-more="${COARSE?'swipe for more':'scroll for more'}">${esc(opts.month||'')} · ${n} plant${n===1?'':'s'}${n?` · ${bloomedN} bloomed`:''}</div>
      <div class="sc-viewport"><div class="sc-world" style="width:${Math.round(worldW)}px">
        <div class="sc-hills"></div>
        <div class="sc-grass"></div>
        <div class="sc-soil"></div>
        <div class="sc-plants">${n?plantHtml:'<div class="sc-empty">Bare soil. Plant a bill and it shows up here.</div>'}</div>
        <div class="sc-layer sc-fx"></div>
      </div></div>
      <div class="sc-layer sc-weather"></div>
      <div class="sc-layer sc-creatures"></div>
      <div class="sc-fade sc-fade-l" aria-hidden="true"></div><div class="sc-fade sc-fade-r" aria-hidden="true"></div>
      <button type="button" class="sc-nav sc-prev" aria-label="Earlier plants">${window.IC&&IC.chevL?IC.chevL:'‹'}</button>
      <button type="button" class="sc-nav sc-next" aria-label="More plants">${window.IC&&IC.chevR?IC.chevR:'›'}</button>`;
    watchVisibility(container);
    wireScroll(container);
    if(n)residents(opts.coverage);
    if(!REDUCED&&n){scheduleButterfly();scheduleLadybug();hoverBee(plants);scheduleBat();}
    if(opts.coverage>=50&&!rainbowShown&&!REDUCED){rainbow();}
  }

  // Night Bloom residents: more creatures move into the garden as the month fills.
  const RESIDENTS=[{k:'owl',min:0},{k:'snail',min:25},{k:'toad',min:50},{k:'bunny',min:75},{k:'wisp',min:100}];
  function residents(cov){
    const l=layer('sc-creatures');if(!l||!window.IC)return;
    RESIDENTS.forEach(r=>{if((cov||0)>=r.min&&IC[r.k]){const el=document.createElement('span');el.className='nb-res nb-'+r.k;el.innerHTML=IC[r.k];l.appendChild(el);}});
  }
  function scheduleBat(){
    const t=setTimeout(()=>{const l=layer('sc-creatures');if(l&&window.IC&&IC.bat){const el=document.createElement('div');el.className='sc-bat';el.innerHTML=IC.bat;el.style.top=(8+Math.random()*18)+'%';l.appendChild(el);setTimeout(()=>el.remove(),7500);}scheduleBat();},18000+Math.random()*22000);
    creatureTimers.push(t);
  }
  function scheduleButterfly(){
    const first=creatureTimers.length===0;
    const t=setTimeout(()=>{flyButterfly();scheduleButterfly();},25000+Math.random()*15000);
    creatureTimers.push(t);
    if(first)creatureTimers.push(setTimeout(flyButterfly,1200));
  }
  function flyButterfly(){
    const l=layer('sc-creatures');if(!l||!window.IC)return;
    const el=document.createElement('div');el.className='sc-butterfly';el.innerHTML=IC.butterfly;
    el.style.top=(20+Math.random()*35)+'%';
    l.appendChild(el);setTimeout(()=>el.remove(),6500);
  }
  function scheduleLadybug(){
    const t=setTimeout(()=>{
      const arts=root?root.querySelectorAll('.sc-art'):[];
      if(arts.length&&window.IC){const a=arts[Math.floor(Math.random()*arts.length)];const el=document.createElement('span');el.className='sc-ladybug';el.innerHTML=IC.ladybug;a.appendChild(el);setTimeout(()=>el.remove(),9000);}
      scheduleLadybug();
    },30000+Math.random()*30000);
    creatureTimers.push(t);
  }
  function hoverBee(plants){
    const done=plants.filter(p=>p.done);if(!done.length||!window.IC)return;
    const target=root.querySelector(`.sc-plant[data-plant="${done[done.length-1].id}"] .sc-art`);
    if(!target)return;
    const el=document.createElement('span');el.className='sc-bee';el.innerHTML=IC.bee;target.appendChild(el);
  }

  function rain(ms){
    const l=layer('sc-weather');if(!l||REDUCED)return;
    ms=ms||1800;
    root.classList.add('is-raining');
    for(let i=0;i<26;i++){const d=document.createElement('i');d.className='sc-drop';d.style.left=Math.random()*100+'%';d.style.animationDelay=(Math.random()*.9)+'s';l.appendChild(d);}
    setTimeout(()=>{l.innerHTML='';root.classList.remove('is-raining');},ms+900);
  }
  function popPlant(id){
    const p=root&&root.querySelector(`.sc-plant[data-plant="${id}"] .sc-art`);if(!p)return;
    p.classList.remove('pop');void p.offsetWidth;p.classList.add('pop');
  }
  function trickle(fromId,toId){
    if(REDUCED||!root)return;
    const a=root.querySelector(`.sc-plant[data-plant="${fromId}"]`),b=root.querySelector(`.sc-plant[data-plant="${toId}"]`);
    if(!a||!b)return;
    const l=layer('sc-fx')||layer('sc-weather');const world=layer('sc-world')||root;const r=world.getBoundingClientRect(),ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();
    const x1=ra.left+ra.width/2-r.left,x2=rb.left+rb.width/2-r.left;
    const s=document.createElement('div');s.className='sc-trickle';s.style.left=Math.min(x1,x2)+'px';s.style.width=Math.abs(x2-x1)+'px';
    l.appendChild(s);setTimeout(()=>s.remove(),1600);
  }
  function bloom(id){
    const p=root&&root.querySelector(`.sc-plant[data-plant="${id}"] .sc-art`);if(!p)return;
    if(window.FX)FX.petals(p);
    if(!REDUCED){flyButterfly();setTimeout(flyButterfly,500);}
  }
  function rainbow(){
    const l=layer('sc-weather');if(!l)return;
    rainbowShown=true;
    const el=document.createElement('div');el.className='sc-rainbow';l.appendChild(el);
    setTimeout(()=>el.remove(),9000);
  }

  window.Scene={render,rain,popPlant,trickle,bloom,rainbow};
})();
