// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Side Hustle Garden authors. See LICENSE.
// Side Hustle Garden gnome art: the lantern gnome with a shepherd's crook.
// window.GNOME_ART(pct, pal) -> SVG string (viewBox 0 0 200 220). Keeps Dumpling's class hooks so gnome.js animations work.
// Source of truth: edit here, then rerun scripts/recolor-nightbloom.py.
(function(){
  const cl=(v,a,b)=>Math.max(a,Math.min(b,v));
  const L=(a,b,t)=>a+(b-a)*t;
  const f=n=>+n.toFixed(1);
  function hx(h){h=h.replace('#','');if(h.length===3)h=h.replace(/./g,'$&$&');return[0,2,4].map(i=>parseInt(h.substr(i,2),16));}
  function mix(a,b,t){const A=hx(a),B=hx(b);return'#'+A.map((v,i)=>Math.round(L(v,B[i],t)).toString(16).padStart(2,'0')).join('');}
  const uid=()=>'s'+Math.random().toString(36).slice(2,7);
  const PUP='#2B2452';
  const SKIN=u=>`<radialGradient id="${u}sk" cx=".4" cy=".35" r=".8"><stop offset="0" stop-color="#FBDCC2"/><stop offset="1" stop-color="#F2C29C"/></radialGradient>`;
  const HALO=(u,c)=>`<radialGradient id="${u}ha"><stop offset="0" stop-color="${c}" stop-opacity=".95"/><stop offset=".35" stop-color="${c}" stop-opacity=".45"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`;
  const star=(x,y,r,c,o)=>`<path d="M${x} ${f(y-r)}Q${x} ${y} ${f(x+r)} ${y}Q${x} ${y} ${x} ${f(y+r)}Q${x} ${y} ${f(x-r)} ${y}Q${x} ${y} ${x} ${f(y-r)}Z" fill="${c}" opacity="${f(o*100)/100}"/>`;
  const dot=(u,x,y,o,r)=>o<=0?'':`<g opacity="${o.toFixed(2)}"><circle cx="${x}" cy="${y}" r="${r||7}" fill="url(#${u}ha)"/><circle cx="${x}" cy="${y}" r="1.9" fill="#FFFDF2"/></g>`;
  // Eyes: same hooks and geometry as Dumpling so blink (origin 100px 85px) + pointer tracking just work.
  function eyes(u,y,droop,brow,browTilt){
    const E=(x)=>`<ellipse cx="${x}" cy="${y}" rx="7.5" ry="8.5" fill="#fff"/>`;
    const P=(x)=>`<circle cx="${x}" cy="${y+1.5}" r="5.1" fill="${PUP}"/><circle cx="${x+.5}" cy="${y+2}" r="2.7" fill="#140F2E"/><circle cx="${x-2.2}" cy="${y-2.2}" r="2.2" fill="#fff"/><circle cx="${x+2.6}" cy="${y+3.4}" r="1" fill="#fff" opacity=".9"/>`;
    const D=droop>.3?`<g><rect x="79" y="${y-10}" width="16" height="${f(droop+1)}" fill="url(#${u}sk)"/><rect x="105" y="${y-10}" width="16" height="${f(droop+1)}" fill="url(#${u}sk)"/><path d="M80 ${f(y-9+droop)}Q87 ${f(y-7+droop)} 94 ${f(y-9+droop)}M106 ${f(y-9+droop)}Q113 ${f(y-7+droop)} 120 ${f(y-9+droop)}" stroke="#B9776A" stroke-width="1.6" fill="none" stroke-linecap="round"/></g>`:'';
    const t=browTilt||0;
    return `<g class="g-eyes-open">${E(87)}${E(113)}<g class="g-pupils">${P(87)}${P(113)}</g>${D}<g class="g-lids"><rect x="79" y="${y-9}" width="16" height="18" rx="8" fill="url(#${u}sk)"/><rect x="105" y="${y-9}" width="16" height="18" rx="8" fill="url(#${u}sk)"/></g></g>`+
    `<g class="g-eyes-happy"><path d="M80 ${y+1}Q87 ${y+8} 94 ${y+1}M106 ${y+1}Q113 ${y+8} 120 ${y+1}" stroke="${PUP}" stroke-width="3.2" fill="none" stroke-linecap="round"/></g>`+
    `<g class="g-brows"><path d="M79 ${f(y-10-t)}Q87 ${f(y-15-t)} 95 ${f(y-12-t)}M105 ${f(y-12-t)}Q113 ${f(y-15-t)} 121 ${f(y-10-t)}" stroke="${brow}" stroke-width="2.6" fill="none" stroke-linecap="round"/></g>`;
  }
  // Mouth: gentle line at 0, wide grin by 70, open laugh at 100.
  function mouth(y,p){
    const w=L(4.5,9,p),c=L(1.5,9,p);
    const o=y===125?'':` style="transform-origin:100px ${y+1}px"`;
    const m=p<.72?`<path class="g-mouth"${o} d="M${f(100-w)} ${y}Q100 ${f(y+c)} ${f(100+w)} ${y}" stroke="#8C4E3E" stroke-width="2.5" fill="none" stroke-linecap="round"/>`
      :`<g class="g-mouth"${o}><path d="M${f(100-w)} ${y}Q100 ${f(y+c*1.35)} ${f(100+w)} ${y}Z" fill="#8C4E3E" stroke="#8C4E3E" stroke-width="2" stroke-linejoin="round"/><ellipse cx="100" cy="${f(y+c*.55)}" rx="${f(w*.45)}" ry="${f(c*.22)}" fill="#F08A96"/></g>`;
    return m+`<ellipse class="g-mouth-o" cx="100" cy="${y+2}" rx="5" ry="4" fill="#8C4E3E"/>`;
  }
  const sparks=c=>`<g class="g-sparks" opacity="0">${star(30,54,8,c,1)}${star(174,46,7,'#fff',1)}${star(166,98,5,c,1)}${star(22,110,5,'#fff',1)}</g>`;

  // 1. LANTERN: a jar of fireflies that fills and brightens with pct.
  // ---- Classic garden gnome parts, shared by lantern2 + lantern3 ----
  // Firefly spots inside a jar, normalized 0..1 (x across, y down).
  const JF=[[.4,.72],[.69,.38],[.25,.43],[.79,.74],[.5,.2],[.19,.66],[.81,.17],[.44,.52],[.6,.83],[.25,.19],[.88,.5],[.63,.6],[.33,.9],[.71,.28]];
  function jarDefs(u,g,p){return `<radialGradient id="${u}jr" cx=".5" cy=".6" r=".6"><stop offset="0" stop-color="${g}" stop-opacity="${f(.15+p*.8)}"/><stop offset="1" stop-color="${g}" stop-opacity="${f(p*.25)}"/></radialGradient>`;}
  // Mason jar body (no handle): x,y = top-left of glass, w,h glass size.
  function jarBody(u,x,y,w,h,p,ac){
    let flies='';const n=p*JF.length;
    JF.forEach(([a,b],i)=>{flies+=dot(u,f(x+4+a*(w-8)),f(y+4+b*(h-8)),cl(n-i,0,1),6.5);});
    const r=Math.min(12,w*.3);
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="#9FB4E6" opacity=".18"/>
<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="url(#${u}jr)"/>${flies}
<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="none" stroke="#DDE6FF" stroke-width="2" opacity=".8"/>
<path d="M${x+6} ${y+10} Q${x+3.5} ${f(y+h/2)} ${x+6} ${y+h-10}" stroke="#fff" stroke-width="2.6" stroke-linecap="round" fill="none" opacity=".45"/>
<rect x="${x+3}" y="${y-8}" width="${w-6}" height="10" rx="4" fill="${ac}" stroke="${mix(ac,'#fff',.45)}" stroke-width="1.2"/>
<path d="M${x+6} ${y-4.5}h${w-12}" stroke="${mix(ac,'#1a1030',.35)}" stroke-width="1" opacity=".6"/>`;
  }
  function escapees(u,g,e,pts){
    if(!e)return '';
    return pts.map(([x,y,k],i)=>dot(u,x,y,e*(k||1),7.5)).join('')+
      `<path d="${pts.map(([x,y],i)=>`M${pts[0][3]} ${pts[0][4]} Q${f((pts[0][3]+x)/2+(i%2?10:-10))} ${f((pts[0][4]+y)/2)} ${x} ${y}`).join('')}" stroke="${g}" stroke-width="1.2" stroke-dasharray="1 4" stroke-linecap="round" fill="none" opacity="${f(e*.7)}"/>`;
  }
  // Fluffy white beard: a scalloped bib from cheek to belt, tip at (100,tipY).
  function gBeard(u,tipY){
    const s=tipY-150; // shift for longer/shorter
    const outline=`M69 100 Q58 108 60 122 Q52 130 58 140 Q56 ${150+s*.4} 68 ${152+s*.6} Q72 ${162+s*.8} 84 ${f(158+s*.9)} Q90 ${f(tipY+10)} 100 ${f(tipY+4)} Q110 ${f(tipY+10)} 116 ${f(158+s*.9)} Q128 ${162+s*.8} 132 ${152+s*.6} Q144 ${150+s*.4} 142 140 Q148 130 140 122 Q142 108 131 100 Q100 116 69 100Z`;
    return `<path d="${outline}" transform="translate(0 3)" fill="#C9C3DA"/><path d="${outline}" fill="url(#${u}bd)" stroke="#FFFFFF" stroke-width="1.2"/>
<path d="M74 122 Q70 136 76 146M88 132 Q86 146 92 ${f(tipY-2)}M112 132 Q114 146 108 ${f(tipY-2)}M126 122 Q130 136 124 146M100 134 Q98 146 100 ${f(tipY-4)}" stroke="#D9D4E8" stroke-width="1.8" fill="none" stroke-linecap="round"/>`;
  }
  // Bulbous nose + curly mustache + cheeks, drawn after the eyes.
  function gFace(u){
    return `<path d="M100 115 Q92 111 84 114 Q76 116 74 110 Q72 120 82 122 Q93 123 100 118Z M100 115 Q108 111 116 114 Q124 116 126 110 Q128 120 118 122 Q107 123 100 118Z" fill="#FFFFFF" stroke="#C9C3DA" stroke-width="1.1" stroke-linejoin="round"/>
<circle cx="100" cy="108" r="9.5" fill="url(#${u}ns)"/><ellipse cx="96.5" cy="104.5" rx="3" ry="2.2" fill="#fff" opacity=".7"/>`;
  }
  function gDefs(u,pr,ac){
    return `<linearGradient id="${u}ht" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${mix(pr,'#fff',.18)}"/><stop offset="1" stop-color="${mix(pr,'#2a1030',.32)}"/></linearGradient>
<linearGradient id="${u}tu" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${mix(ac,'#fff',.08)}"/><stop offset="1" stop-color="${mix(ac,'#1a1440',.35)}"/></linearGradient>
<radialGradient id="${u}bd" gradientUnits="userSpaceOnUse" cx="100" cy="112" r="60"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E4E0F0"/></radialGradient>
<radialGradient id="${u}ns" cx=".38" cy=".32" r=".75"><stop offset="0" stop-color="#FFC2A6"/><stop offset="1" stop-color="#E58C73"/></radialGradient>`;
  }
  // Tall stiff cone hat. bend = +1 tip leans right, -1 left.
  function gHat(u,pr,bend){
    const b=bend;
    const tx=100+b*18;
    const X=x=>f(100+(x-100)*b);
    return `<path d="M${X(58)} 86 C${X(68)} 62 ${X(82)} 38 ${X(95)} 22 C${X(102)} 13 ${X(109)} 8 ${X(120)} 7 C${X(114)} 12 ${X(111)} 18 ${X(110)} 26 C${X(119)} 44 ${X(132)} 66 ${X(142)} 86 Q100 76 ${X(58)} 86Z" fill="url(#${u}ht)" stroke="${mix(pr,'#fff',.5)}" stroke-width="1.6" stroke-linejoin="round"/>
<path d="M${b>0?72:128} 72 Q${b>0?82:118} 46 ${b>0?96:104} 28" stroke="#fff" stroke-width="3.2" stroke-linecap="round" fill="none" opacity=".28"/>
<path d="M60 84 Q100 74 140 84" stroke="${mix(pr,'#1a1030',.45)}" stroke-width="2" fill="none" opacity=".5"/>`;
  }
  // Round-bellied tunic, stubby legs, boots, wide belt with buckle.
  function gBody(u,pr,ac,g,beltY){
    const bt=mix(ac,'#fff',.5);
    return `<rect x="80" y="186" width="14" height="14" rx="4" fill="#4A3C58" stroke="#8A7CA0" stroke-width="1.2"/><rect x="106" y="186" width="14" height="14" rx="4" fill="#4A3C58" stroke="#8A7CA0" stroke-width="1.2"/>
<path d="M70 206 Q64 206 64 200 Q66 192 80 192 Q94 192 95 200 Q95 206 88 206Z" fill="#7A5238" stroke="#D2A67C" stroke-width="1.6"/><path d="M130 206 Q136 206 136 200 Q134 192 120 192 Q106 192 105 200 Q105 206 112 206Z" fill="#7A5238" stroke="#D2A67C" stroke-width="1.6"/>
<clipPath id="${u}cb"><path d="M56 188 C42 150 62 120 100 117 C138 120 158 150 144 188 Q100 199 56 188Z"/></clipPath><path d="M56 188 C42 150 62 120 100 117 C138 120 158 150 144 188 Q100 199 56 188Z" fill="url(#${u}tu)" stroke="${bt}" stroke-width="1.6"/>
<path d="M60 186 Q100 196 140 186" stroke="${bt}" stroke-width="2" fill="none" opacity=".6"/>
<path clip-path="url(#${u}cb)" d="M50 ${beltY} Q100 ${beltY+8} 150 ${beltY} L150 ${beltY+13} Q100 ${beltY+21} 50 ${beltY+13}Z" fill="#3B2A2E" stroke="#8C6A5E" stroke-width="1.4"/>
<rect x="89" y="${beltY+1}" width="22" height="18" rx="3.5" fill="none" stroke="${mix(g,'#FFD76A',.5)}" stroke-width="3.4"/><rect x="99" y="${beltY+5}" width="2.6" height="10" rx="1" fill="${mix(g,'#FFD76A',.5)}"/>`;
  }
  function gHead(u,pr,p,browC){
    return `<circle cx="70" cy="100" r="7" fill="url(#${u}sk)"/><circle cx="130" cy="100" r="7" fill="url(#${u}sk)"/><circle cx="70" cy="100" r="3.5" fill="#EFA98C" opacity=".6"/><circle cx="130" cy="100" r="3.5" fill="#EFA98C" opacity=".6"/>
<circle cx="100" cy="98" r="30" fill="url(#${u}sk)"/>
${gBeard(u,150)}
<circle cx="78" cy="106" r="7" fill="#F4A7A0" opacity=".8"/><circle cx="122" cy="106" r="7" fill="#F4A7A0" opacity=".8"/>`;
  }
  const wrap=(cls,u,defs,inner)=>`<svg viewBox="0 0 200 220" xmlns="http://www.w3.org/2000/svg" class="dumpling ${cls}" aria-hidden="true"><defs>${defs}</defs>${inner}</svg>`;

  // 4. LANTERN 2: classic gnome holding the firefly jar in front of his belly with both hands.
  function lantern3(pct,pal){
    const p=cl(pct/100,0,1),u=uid(),g=pal.glow,pr=pal.primary,ac=pal.accent;
    const e=cl((p-.8)/.2,0,1);
    const tuD=mix(ac,'#1a1440',.2);
    const wood='#9A6A45',woodL='#D8AE84';
    const mw=mix(g,'#fff',.55);
    const moth=`<g transform="translate(74 56) rotate(-24)"><ellipse cx="-5" cy="-1" rx="7" ry="4.6" transform="rotate(-25 -5 -1)" fill="${mw}" stroke="#fff" stroke-width=".8"/><ellipse cx="5" cy="-1" rx="7" ry="4.6" transform="rotate(25 5 -1)" fill="${mw}" stroke="#fff" stroke-width=".8"/><ellipse cx="-4" cy="4" rx="4" ry="3" fill="${mix(mw,pr,.25)}"/><ellipse cx="4" cy="4" rx="4" ry="3" fill="${mix(mw,pr,.25)}"/><circle cx="-6" cy="-1.5" r="1.6" fill="${mix(pr,'#1a1030',.2)}" opacity=".6"/><circle cx="6" cy="-1.5" r="1.6" fill="${mix(pr,'#1a1030',.2)}" opacity=".6"/><ellipse cx="0" cy="1" rx="1.6" ry="5" fill="#6B5A7A"/><path d="M-.5 -3.5 Q-3 -9 -6 -9.5M.5 -3.5 Q3 -9 6 -9.5" stroke="#6B5A7A" stroke-width=".9" fill="none"/></g>`;
    return wrap('gnome-lantern3',u,SKIN(u)+HALO(u,g)+jarDefs(u,g,p)+gDefs(u,pr,ac),`
<ellipse class="g-shadow" cx="104" cy="209" rx="68" ry="8" fill="${mix(pr,'#fff',.6)}" opacity=".2"/>
<circle cx="174" cy="112" r="${f(20+p*16)}" fill="url(#${u}ha)" opacity="${f(p*.75)}"/>
<g class="g-body">
${gBody(u,pr,ac,g,150)}
<path d="M64 132 Q50 150 58 166" stroke="${mix(ac,'#fff',.5)}" stroke-width="18" stroke-linecap="round" fill="none"/><path d="M64 132 Q50 150 58 166" stroke="${tuD}" stroke-width="15" stroke-linecap="round" fill="none"/>
<circle cx="60" cy="168" r="8.5" fill="url(#${u}sk)"/>
<path d="M136 132 Q150 142 152 150" stroke="${mix(ac,'#fff',.5)}" stroke-width="18" stroke-linecap="round" fill="none"/><path d="M136 132 Q150 142 152 150" stroke="${tuD}" stroke-width="15" stroke-linecap="round" fill="none"/>
<g class="g-jar">
<path d="M156 206 L154 170 Q152 150 155 126 Q157 100 153 76 Q150 52 162 44 Q176 38 182 50 Q185 58 180 64" stroke="${woodL}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
<path d="M156 206 L154 170 Q152 150 155 126 Q157 100 153 76 Q150 52 162 44 Q176 38 182 50 Q185 58 180 64" stroke="${wood}" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
<path d="M156 118 l-4 -6" stroke="${wood}" stroke-width="3" stroke-linecap="round"/>
<path d="M180 64 L170 84M180 64 L188 84" stroke="#C9CCE0" stroke-width="1.6" fill="none"/>
${jarBody(u,162,90,32,36,p,ac)}
<circle cx="154" cy="150" r="8.5" fill="url(#${u}sk)"/>
<path d="M148 146 Q154 144 160 147" stroke="#E0A888" stroke-width="1.2" fill="none" opacity=".7"/>
</g>
<g class="g-head">
${gHead(u,pr,p)}
${gHat(u,pr,-1)}
${moth}
${eyes(u,94,0,'#A89FB8',0)}
${gFace(u)}
${mouth(125,p)}
</g></g>
${escapees(u,g,e,[[150,62,1,178,84],[192,58,1],[168,28,.9],[196,98,.8]])}${sparks(g)}`);
  }
  window.GNOME_ART=lantern3;
})();

// Dumpling, the garden gnome. Classic script; exposes window.Gnome.
// Blinks, sways, tracks the pointer, reacts to waterings and blooms, and talks
// in first person. Respects prefers-reduced-motion (no sway/blink/track).
(function(){
  const REDUCED=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const PAL={"primary": "#FFD24A", "glow": "#FFF3A0", "accent": "#FF9F6E", "dark": "#FFF4E8"};
  let PCT=0;
  const mounted=[];
  function SVG(p){return window.GNOME_ART?window.GNOME_ART(p==null?PCT:p,PAL):''}

  const SASS=[
    "I water the little ones first. It's not favoritism, it's math.",
    "Poke me again and I'll charge you a consultation fee.",
    "Your biggest bill is the tallest plant. I didn't plant it, I just live here.",
    "A bloom a month keeps the overdraft away. I made that up, but it's true.",
    "You know what's better than a big payment? The next small one.",
    "Rain is free water. Side hustles are not. Log the money.",
    "I don't do forecasts. That's the star tab. Very fancy.",
    "Every plant here is a bill. Think about that when you skip a week.",
    "I'm not short. The garden is just very tall.",
    "The hat's mandatory. Union rules.",
    "Yes, I sleep out here. No, I'm not cold. Wool beard.",
    "Water the big one first and I'll hide your trowel.",
    "One more sale and something blooms. I'm not saying it, the math is.",
    "I've named the ladybug. You don't get to know what.",
    "Every bill that blooms sends another firefly to my jar.",
    "The lantern's not for me. The moths just like the company.",
    "Night shift is the best shift. Everything blooms when nobody's looking.",
  ];
  const SULK=[
    "It's been a while. The soil's dry and so is my sense of humor.",
    "A week with no water. I've been talking to the ladybug.",
    "You came back. Good. The plants noticed you left.",
  ];

  let bubble=null,instance=null,stateText='',holdTimer=null,blinkTimer=null,tracking=false;

  function pick(a){return a[Math.floor(Math.random()*a.length)]}

  function setFace(el,face){
    el.classList.remove('face-happy','face-o','face-sulk');
    if(face)el.classList.add('face-'+face);
  }

  function blinkLoop(el){
    if(REDUCED)return;
    clearTimeout(blinkTimer);
    const delay=1800+Math.random()*3500;
    blinkTimer=setTimeout(()=>{const s=el.isConnected?el:(instance||el);s.classList.add('blink');setTimeout(()=>s.classList.remove('blink'),140);blinkLoop(s);},delay);
  }

  function track(el){
    if(REDUCED||tracking)return;
    tracking=true;
    window.addEventListener('pointermove',(e)=>{
      const cur=instance&&instance.isConnected?instance:el;if(!cur.isConnected)return;
      const pupils=cur.querySelector('.g-pupils');if(!pupils)return;
      const r=cur.getBoundingClientRect();
      const cx=r.left+r.width/2,cy=r.top+r.height*.43;
      const dx=e.clientX-cx,dy=e.clientY-cy;
      const d=Math.hypot(dx,dy)||1;
      const k=Math.min(1,d/300)*2.6;
      pupils.style.transform=`translate(${(dx/d*k).toFixed(2)}px, ${(dy/d*k).toFixed(2)}px)`;
    },{passive:true});
  }

  function mount(el,opts){
    opts=opts||{};
    if(!el)return null;
    // Gradient ids must be unique per instance: a second copy (the landing page gnome,
    // hidden once logged in) would otherwise own the ids and Safari paints the fills blank.
    el.innerHTML=SVG(opts.main===false?80:PCT);mounted.push({el,opts});
    const svg=el.querySelector('svg');
    if(!REDUCED)svg.classList.add('sway');
    if(opts.interactive!==false){
      blinkLoop(svg);track(svg);
      const poke=()=>{
        say(pick(SASS),{hold:4200});
        react('pleased');
        if(window.FX){const r=el.getBoundingClientRect();FX.burst(r.left+r.width/2,r.top+r.height*.3,['#FFD24A','#FFF3A0','#FF9F6E'],10);FX.sound('giggle');}
      };
      el.addEventListener('click',poke);
      el.addEventListener('keydown',(e)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();poke();}});
    }
    if(opts.main!==false)instance=svg;
    return svg;
  }

  function say(text,o){
    o=o||{};
    bubble=bubble||document.getElementById('gnome-bubble');
    if(!bubble)return;
    bubble.textContent=text;
    bubble.classList.remove('pop');void bubble.offsetWidth;bubble.classList.add('pop');
    clearTimeout(holdTimer);
    if(o.hold&&stateText)holdTimer=setTimeout(()=>{if(bubble)bubble.textContent=stateText;},o.hold);
  }

  function react(state){
    if(!instance)return;
    const el=instance;
    el.classList.remove('pleased','celebrate','sulk');
    if(state==='pleased'){setFace(el,'happy');el.classList.add('pleased');setTimeout(()=>{setFace(el,null);el.classList.remove('pleased');},1600);}
    else if(state==='celebrate'){setFace(el,'o');el.classList.add('celebrate');setTimeout(()=>{setFace(el,null);el.classList.remove('celebrate');},3200);}
    else if(state==='sulk'){setFace(el,'sulk');el.classList.add('sulk');}
    else{setFace(el,null);}
  }


  // The jar fills with the month's coverage. Re-renders each mounted gnome, keeping its state classes.
  function progress(pct){
    const next=Math.max(0,Math.min(100,Math.round(+pct||0)));
    if(next===PCT)return;PCT=next;
    mounted.forEach(({el,opts})=>{
      if(opts.main===false)return; // the sign-in page gnome keeps a full-looking jar
      const old=el.querySelector('svg');if(!old)return;
      const keep=[...old.classList].filter(c=>c!=='dumpling'&&!c.startsWith('gnome-'));
      el.innerHTML=SVG();const svg=el.querySelector('svg');
      keep.forEach(c=>svg.classList.add(c));
      if(opts.main!==false)instance=svg;
    });
  }
  // Progress-aware line. All inputs optional.
  function stateLine(s){
    s=s||{};
    let t;
    if(!s.bills){t="Nothing planted yet. Plant your first three bills and I'll show you the trick.";}
    else if(s.daysSince>=7){t=pick(SULK);react('sulk');}
    else if(s.allBloomed){t="Everything's blooming. Go plant something bigger, I'm bored.";}
    else if(s.next){
      const lead=s.bloomedNames&&s.bloomedNames.length?`${s.bloomedNames.slice(0,2).join(' and ')} bloomed. `:'';
      t=`${lead}${s.next} is next, ${s.remaining} to go. Every dollar you water lands there first.`;
    }
    else{t=`Coverage is ${s.coverage}%. Keep watering, the little ones bloom first.`;}
    stateText=t;
    say(t);
    return t;
  }

  window.Gnome={mount,say,react,stateLine,progress,SVG};
  // The landing-page gnome mounts itself (app.js runs before this file).
  const pg=document.getElementById('promo-gnome'); if(pg)mount(pg,{interactive:false,main:false});
})();
