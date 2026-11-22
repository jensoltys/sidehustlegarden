// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
// Particles, petals, the watering can, and synthesized sounds. Classic script; window.FX.
(function(){
  const REDUCED=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function soundOn(){try{return localStorage.getItem('garden_sound')==='1';}catch{return false;}}
  let ctx=null;
  function tone(freq,dur,type,gain,when){
    ctx=ctx||new (window.AudioContext||window.webkitAudioContext)();
    const o=ctx.createOscillator(),g=ctx.createGain();
    const t0=ctx.currentTime+(when||0);
    o.type=type||'sine';o.frequency.setValueAtTime(freq,t0);
    g.gain.setValueAtTime(0,t0);
    g.gain.linearRampToValueAtTime(gain||.08,t0+.01);
    g.gain.exponentialRampToValueAtTime(.0001,t0+dur);
    o.connect(g).connect(ctx.destination);o.start(t0);o.stop(t0+dur+.02);
  }
  function sound(name){
    if(!soundOn())return;
    try{
      if(name==='plink'){tone(880,.12,'sine',.07);tone(440,.18,'sine',.05,.06);}
      else if(name==='chime'){[523,659,784,1046].forEach((f,i)=>tone(f,.35,'triangle',.06,i*.09));}
      else if(name==='giggle'){tone(660,.08,'square',.03);tone(880,.1,'square',.03,.09);}
    }catch{}
  }
  function burst(x,y,colors,count){
    if(REDUCED)return;
    colors=colors||['#F2A93B','#7FB6D6','#78A862'];count=count||12;
    for(let i=0;i<count;i++){
      const d=document.createElement('i');d.className='fx-p';
      const a=(i/count)*Math.PI*2+Math.random()*.5,dist=50+Math.random()*70;
      d.style.cssText=`left:${x}px;top:${y}px;background:${colors[i%colors.length]};--tx:${Math.cos(a)*dist}px;--ty:${Math.sin(a)*dist}px;--rot:${Math.random()*360}deg;--dur:${.6+Math.random()*.5}s`;
      document.body.appendChild(d);setTimeout(()=>d.remove(),1200);
    }
  }
  function petals(el){
    if(REDUCED||!el)return;
    const r=el.getBoundingClientRect();
    const cols=['#F4A7A0','#F2A93B','#FBEBCB','#E879F9','#FFFFFF'];
    for(let i=0;i<14;i++){
      const d=document.createElement('i');d.className='fx-petal';
      d.style.cssText=`left:${r.left+r.width/2}px;top:${r.top+r.height*.4}px;background:${cols[i%cols.length]};--tx:${(Math.random()-.5)*180}px;--ty:${-60-Math.random()*120}px;--rot:${Math.random()*720}deg;--dur:${1.1+Math.random()*.7}s`;
      document.body.appendChild(d);setTimeout(()=>d.remove(),2000);
    }
  }
  function pour(targetEl){
    if(REDUCED||!targetEl)return;
    const r=targetEl.getBoundingClientRect();
    const can=document.createElement('div');can.className='fx-can';
    can.innerHTML='<svg viewBox="0 0 60 44" width="60" height="44" aria-hidden="true"><rect x="10" y="14" width="34" height="24" rx="7" fill="#7FB6D6"/><path d="M10 22 L0 12" stroke="#7FB6D6" stroke-width="7" stroke-linecap="round"/><path d="M26 14 Q30 2 42 4" stroke="#5E9BBE" stroke-width="5" fill="none" stroke-linecap="round"/></svg>';
    can.style.left=(r.left+r.width/2+10)+'px';can.style.top=(r.top-56)+'px';
    document.body.appendChild(can);
    for(let i=0;i<10;i++){const d=document.createElement('i');d.className='fx-drip';d.style.cssText=`left:${r.left+r.width/2-14+Math.random()*10}px;top:${r.top-30}px;--dy:${r.height*.8}px;animation-delay:${.25+i*.07}s`;document.body.appendChild(d);setTimeout(()=>d.remove(),1400);}
    setTimeout(()=>can.remove(),1300);
  }
  window.FX={burst,petals,pour,sound,soundOn};
})();
