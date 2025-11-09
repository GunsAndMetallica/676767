// Color Dash — game.js (patched to ensure "You crashed" is hidden on load)
//
// Replace your existing game.js with this file. It improves initialization to
// defensively hide the game-over UI on startup, pauses the game until a level
// is explicitly started, and prevents any accidental endRun() effect during load.

(function () {
  'use strict';

  // DOM-ready init
  document.addEventListener('DOMContentLoaded', init);

  // ---------- Globals ----------
  let canvas, ctx, DPR;
  let previewCanvas, previewCtx;
  const hudDistance = () => document.getElementById('hud-distance');
  const hudHigh = () => document.getElementById('hud-high');

  const LS_KEY_HIGHSCORE = 'cd_highscore_v1';
  const LS_KEY_LEVELS = 'cd_levels_v1';
  const LS_KEY_SKIN = 'cd_skin_v1';

  // game state
  const gameState = {
    running: false, // do not auto-run at load
    alive: false,
    speed: 360,
    distance: 0,
    cameraX: 0,
    obstacles: [],
    level: null,
    bgOffset: 0,
    particlePool: []
  };

  // audio
  let audioCtx = null;
  let musicInterval = null;
  let isMusicOn = true;

  // basic constants
  const GRAVITY = 1800;
  const JUMP_V = -620;
  const PLAYER_SIZE = 56;
  const BASE_SPEED = 360;

  // UI references filled in init()
  let ui = {};

  // skins
  const SKINS = [
    { id: 'sunny', name: 'Sunny', color: '#ffd166', faces: ['happy', 'wink', 'cool']},
    { id: 'rose', name: 'Rose', color: '#ff6b6b', faces: ['happy','determined','surprised']},
    { id: 'mint', name: 'Mint', color: '#7efc6a', faces: ['happy','cool']},
    { id: 'violet', name: 'Violet', color: '#9b8cff', faces: ['determined','wink']},
    { id: 'classic', name: 'Classic', color: '#4cc0ff', faces: ['happy','surprised','wink','cool']}
  ];
  let selectedSkin = (() => {
    try { const s = JSON.parse(localStorage.getItem(LS_KEY_SKIN)); if (s && s.id) return s; } catch(e) {}
    return SKINS[0];
  })();

  // small helpers
  function rand(min=0,max=1){return Math.random()*(max-min)+min;}
  function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
  function lightColor(hex, amt){
    const c = String(hex).replace('#','');
    const num = parseInt(c,16);
    let r = (num >> 16) + amt;
    let g = (num >> 8 & 0x00FF) + amt;
    let b = (num & 0x0000FF) + amt;
    r = clamp(r,0,255); g = clamp(g,0,255); b = clamp(b,0,255);
    return '#' + ((1<<24) + (r<<16) + (g<<8) + b).toString(16).slice(1);
  }

  // ---------- Classes ----------
  class Player {
    constructor(){
      this.x = 140;
      this.y = 0;
      this.vy = 0;
      this.size = PLAYER_SIZE;
      this.onGround = true;
      this.color = selectedSkin.color;
      this.face = this.randomFace();
    }
    randomFace(){ const faces = selectedSkin.faces || ['happy']; return faces[Math.floor(Math.random()*faces.length)]; }
    reset(){
      this.y = groundY() - this.size;
      this.vy = 0;
      this.onGround = true;
      this.color = selectedSkin.color;
      this.face = this.randomFace();
    }
    jump(){
      if (!gameState.alive) return;
      if (this.onGround) {
        this.vy = JUMP_V;
        this.onGround = false;
        spawnParticles(this.x + this.size/2, this.y + this.size);
        playSfx('jump');
      }
    }
    update(dt){
      this.vy += GRAVITY * dt;
      this.y += this.vy * dt;
      if (this.y + this.size >= groundY()){
        this.y = groundY() - this.size;
        this.vy = 0;
        this.onGround = true;
      }
    }
    draw(ctx){
      const s = this.size;
      const x = Math.round(this.x);
      const y = Math.round(this.y);
      ctx.fillStyle = 'rgba(0,0,0,0.08)';
      ctx.fillRect(x-2,y+s-6,s+4,6);
      const grad = ctx.createLinearGradient(x,y,x,y+s);
      grad.addColorStop(0, lightColor(this.color,12));
      grad.addColorStop(1, this.color);
      ctx.fillStyle = grad;
      roundRect(ctx, x, y, s, s, 8);
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,0.12)'; roundRectStroke(ctx,x,y,s,s,8);

      // face
      const eyeY = y + s*0.34;
      const eyeLx = x + s*0.24;
      const eyeRx = x + s*0.68;
      ctx.fillStyle = '#111';
      if (this.face === 'happy') { drawEyes(ctx, eyeLx, eyeY, eyeRx, eyeY, 'normal'); drawMouth(ctx,x+s/2,y+s*0.66,'smile'); }
      else if (this.face === 'wink') { drawEyes(ctx, eyeLx, eyeY, eyeRx, eyeY, 'wink'); drawMouth(ctx,x+s/2,y+s*0.66,'smile'); }
      else if (this.face === 'cool') { ctx.fillStyle = '#111'; ctx.fillRect(eyeLx-6,eyeY-8,16,10); ctx.fillRect(eyeRx-6,eyeY-8,16,10); drawMouth(ctx,x+s/2,y+s*0.68,'flat'); }
      else if (this.face === 'surprised') { drawEyes(ctx, eyeLx, eyeY, eyeRx, eyeY, 'round'); drawMouth(ctx,x+s/2,y+s*0.68,'o'); }
      else { drawEyes(ctx, eyeLx, eyeY-2, eyeRx, eyeY-2, 'narrow'); drawMouth(ctx,x+s/2,y+s*0.72,'flat'); }
    }
  }

  class Obstacle {
    constructor(spec){ this.type = spec.type; this.x = spec.x; this.w = spec.w || 120; this.h = spec.h || 80; this.color = spec.color || '#ff6b6b'; this.passed = false; }
    rect(){ return {x:this.x, y:groundY()-this.h, w:this.w, h:this.h}; }
    draw(ctx, camX){
      if (this.type === 'gap') return;
      const sx = Math.round(this.x - camX);
      const sy = Math.round(groundY() - this.h);
      if (this.type === 'block'){
        ctx.fillStyle = this.color; roundRect(ctx, sx, sy, this.w, this.h, 6); ctx.strokeStyle = 'rgba(0,0,0,0.06)'; ctx.lineWidth = 2; roundRectStroke(ctx,sx,sy,this.w,this.h,6);
      } else if (this.type === 'spike'){
        const spikeW = 26; ctx.fillStyle = this.color;
        for (let px = sx; px < sx + this.w; px += spikeW){
          ctx.beginPath(); ctx.moveTo(px, groundY()); ctx.lineTo(px + spikeW/2, groundY() - this.h); ctx.lineTo(px + spikeW, groundY()); ctx.closePath(); ctx.fill();
        }
      }
    }
    collidesWith(player){
      if (this.type === 'gap'){
        const left = this.x, right = this.x + this.w;
        if ((player.x + player.size > left) && (player.x < right)) {
          if (player.y + player.size >= groundY() - 1) return true;
        }
        return false;
      } else {
        const r = this.rect();
        const px = player.x, py = player.y, pw = player.size, ph = player.size;
        if (px < r.x + r.w && px + pw > r.x && py < r.y + r.h && py + ph > r.y) return true;
        return false;
      }
    }
  }

  // ---------- Drawing helpers ----------
  function roundRect(ctx, x, y, w, h, r=6){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); ctx.fill(); }
  function roundRectStroke(ctx, x, y, w, h, r=6){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); ctx.stroke(); }

  function drawEyes(ctx, lx, ly, rx, ry, style='normal'){
    ctx.fillStyle = '#111';
    if (style === 'normal') { ctx.beginPath(); ctx.ellipse(lx,ly,4,6,0,0,Math.PI*2); ctx.fill(); ctx.beginPath(); ctx.ellipse(rx,ry,4,6,0,0,Math.PI*2); ctx.fill(); ctx.fillStyle='#fff'; ctx.fillRect(lx+1,ly-1,2,2); ctx.fillRect(rx+1,ry-1,2,2); }
    else if (style === 'wink') { ctx.fillRect(lx-4,ly-1,8,2); ctx.beginPath(); ctx.ellipse(rx,ry,4,6,0,0,Math.PI*2); ctx.fill(); }
    else if (style === 'round') { ctx.beginPath(); ctx.ellipse(lx,ly,6,6,0,0,Math.PI*2); ctx.fill(); ctx.beginPath(); ctx.ellipse(rx,ry,6,6,0,0,Math.PI*2); ctx.fill(); }
    else { ctx.fillRect(lx-4,ly-2,8,3); ctx.fillRect(rx-4,ry-2,8,3); }
  }
  function drawMouth(ctx, cx, y, mood='smile'){ ctx.fillStyle = '#111'; if (mood === 'smile'){ ctx.beginPath(); ctx.arc(cx,y,10,0.1*Math.PI,0.9*Math.PI); ctx.lineWidth = 2; ctx.strokeStyle = '#111'; ctx.stroke(); } else if (mood === 'o'){ ctx.beginPath(); ctx.ellipse(cx,y,6,8,0,0,Math.PI*2); ctx.fill(); } else { ctx.fillRect(cx-10,y-4,20,6); } }

  // ---------- Game variables ----------
  let player = new Player();
  let lastTime = 0;
  const bgLayers = [{speed:0.08, items:[]},{speed:0.22, items:[]},{speed:0.44, items:[]}];

  function groundY(){ return Math.round(canvas.height / DPR * 0.78); }

  // populate background items
  function populateBG(){
    const w = Math.max(window.innerWidth, 800);
    for (let i=0;i<bgLayers.length;i++){
      bgLayers[i].items = [];
      const n = 8 + Math.floor(Math.random()*8);
      for (let j=0;j<n;j++){
        bgLayers[i].items.push({ x: Math.random()*w*3, y: Math.random()*(groundY()*0.6), size: 6 + Math.random()*40 });
      }
    }
  }

  // ---------- Particles ----------
  function spawnParticles(x,y){
    for (let i=0;i<12;i++){
      gameState.particlePool.push({ x, y, vx: rand(-200,200), vy: rand(-260,-40), life: rand(0.36,0.9), size: rand(2,6), color: lightColor(selectedSkin.color, 12) });
    }
  }
  function updateParticles(dt){
    for (let p of gameState.particlePool){ p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 1200 * dt; }
    gameState.particlePool = gameState.particlePool.filter(p => p.life>0);
  }
  function drawParticles(ctx, camX){
    for (let p of gameState.particlePool){ ctx.fillStyle = p.color; ctx.globalAlpha = Math.max(0, p.life / 0.9); ctx.fillRect(p.x - camX - p.size/2, p.y - p.size/2, p.size, p.size); ctx.globalAlpha = 1; }
  }

  // ---------- Audio helpers ----------
  function ensureAudio(){
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { audioCtx = null; console.warn('Audio not available:', e); }
    }
  }
  function startMusic(){
    if (!isMusicOn) return;
    ensureAudio(); if (!audioCtx) return;
    const ctxA = audioCtx;
    const master = ctxA.createGain(); master.gain.value = 0.06; master.connect(ctxA.destination);
    let t0 = ctxA.currentTime + 0.05, step = 0, bpm = 110, beat = 60/bpm;
    function schedule(){
      const now = ctxA.currentTime;
      while (t0 < now + 0.6){
        const k = step % 16;
        if (k % 4 === 0){
          const o = ctxA.createOscillator(); const g = ctxA.createGain();
          o.type = 'sawtooth'; o.frequency.value = 55 * Math.pow(2, (Math.floor((step/4)%4)/12)); g.gain.value = 0.08;
          o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + beat*0.9);
        }
        if (Math.random() > 0.6){
          const o2 = ctxA.createOscillator(); const g2 = ctxA.createGain();
          o2.type = 'triangle'; o2.frequency.value = 440 * Math.pow(2, (Math.floor(Math.random()*5)-2)/12); g2.gain.value = 0.04;
          o2.connect(g2); g2.connect(master); o2.start(t0); o2.stop(t0 + beat*0.5);
        }
        t0 += beat * 0.5; step++;
      }
    }
    schedule(); musicInterval = setInterval(schedule, 420);
  }
  function stopMusic(){ if (musicInterval) { clearInterval(musicInterval); musicInterval = null; } }
  function playSfx(name){
    ensureAudio(); if (!audioCtx) return;
    const ctxA = audioCtx, o = ctxA.createOscillator(), g = ctxA.createGain();
    if (name === 'jump'){ o.type='sine'; o.frequency.value = 520; g.gain.value = 0.08; }
    else { o.type='square'; o.frequency.value = 120; g.gain.value = 0.12; }
    o.connect(g); g.connect(ctxA.destination); o.start(); o.stop(ctxA.currentTime + 0.12);
  }

  // ---------- Level data ----------
  const SAMPLE_LEVELS = [
    { id:'level-1', name:'Sunny Start', length:3500, obstacles:[
      {type:'block', x:700, w:140, h:90, color:'#ff9f80'}, {type:'gap', x:980, w:120}, {type:'block', x:1160, w:80, h:70, color:'#ffcc66'},
      {type:'spike', x:1350, w:140, h:64, color:'#ffd166'}, {type:'gap', x:1620, w:140}, {type:'block', x:1820, w:220, h:110, color:'#ff6b6b'},
      {type:'spike', x:2200, w:160, h:72, color:'#9b8cff'}, {type:'gap', x:2460, w:200}
    ]},
    { id:'level-2', name:'Bouncy Blocks', length:4200, obstacles:[
      {type:'block', x:600, w:80, h:60, color:'#7efc6a'}, {type:'block', x:740, w:120, h:120, color:'#4cc0ff'},
      {type:'gap', x:900, w:160}, {type:'spike', x:1100, w:140, h:64, color:'#ff6b6b'}, {type:'block', x:1300, w:200, h:80, color:'#ffd166'},
      {type:'gap', x:1600, w:120}, {type:'block', x:1760, w:150, h:110, color:'#9b8cff'}, {type:'spike', x:2100, w:160, h:72, color:'#ff9f80'},
      {type:'block', x:2380, w:220, h:140, color:'#7efc6a'}
    ]},
    { id:'level-3', name:'Spiky Rush', length:2800, obstacles:[
      {type:'spike', x:700, w:180, h:80, color:'#ff6b6b'}, {type:'gap', x:920, w:120}, {type:'spike', x:1100, w:160, h:72, color:'#ff9f80'},
      {type:'block', x:1300, w:120, h:90, color:'#ffd166'}, {type:'gap', x:1540, w:160}, {type:'spike', x:1760, w:240, h:90, color:'#9b8cff'}
    ]}
  ];
  function loadSavedLevels(){ try { const v = JSON.parse(localStorage.getItem(LS_KEY_LEVELS)||'[]'); if (Array.isArray(v) && v.length) return v; } catch(e){} return SAMPLE_LEVELS; }
  let levels = loadSavedLevels();

  // ---------- Initialization ----------
  function init(){
    // element refs
    canvas = document.getElementById('game');
    ctx = canvas.getContext('2d', { alpha: false });
    previewCanvas = document.getElementById('previewCanvas');
    previewCtx = previewCanvas ? previewCanvas.getContext('2d') : null;

    DPR = Math.max(1, window.devicePixelRatio || 1);
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // UI refs
    ui.btnPlay = document.getElementById('btn-play');
    ui.btnEditor = document.getElementById('btn-editor');
    ui.btnSkins = document.getElementById('btn-skins');
    ui.btnSettings = document.getElementById('btn-settings');
    ui.menuOverlay = document.getElementById('overlay');
    ui.menuTitle = document.getElementById('menuTitle');
    ui.menuBody = document.getElementById('menuBody');
    ui.menuClose = document.getElementById('menuClose');
    ui.gameOver = document.getElementById('gameOver');
    ui.goRestart = document.getElementById('goRestart');
    ui.goMenu = document.getElementById('goMenu');
    ui.floatingEditor = document.getElementById('floatingEditor');
    ui.saveLevel = document.getElementById('saveLevel');
    ui.loadSample = document.getElementById('loadSample');
    ui.exportLevel = document.getElementById('exportLevel');
    ui.closeEditor = document.getElementById('closeEditor');
    ui.editorPanel = document.getElementById('editorPanel');
    ui.editorTimeline = document.getElementById('editorTimeline');
    ui.editTool = document.getElementById('editTool');
    ui.editWidth = document.getElementById('editWidth');
    ui.editHeight = document.getElementById('editHeight');
    ui.editColor = document.getElementById('editColor');
    ui.levelName = document.getElementById('levelName');
    ui.skinPreview = document.getElementById('skin-preview');
    ui.skinName = document.getElementById('skin-name');
    ui.btnMusic = document.getElementById('btn-music');
    ui.btnFull = document.getElementById('btn-full');

    // IMPORTANT: Defensive UI init to ensure "You crashed" is not visible on load
    try {
      if (ui.gameOver) {
        ui.gameOver.classList.add('hidden');
        ui.gameOver.setAttribute('aria-hidden', 'true');
        // also ensure pointer events / z-index not interfering
        ui.gameOver.style.pointerEvents = 'auto';
        ui.gameOver.style.zIndex = '9999';
      }
      if (ui.menuOverlay) {
        ui.menuOverlay.classList.add('hidden');
        ui.menuOverlay.setAttribute('aria-hidden', 'true');
      }
    } catch (e) {
      console.warn('init UI defensive hide failed', e);
    }

    // initial states: hide overlays, ensure game paused and no stale game-over
    gameState.running = false;
    gameState.alive = false;
    gameState.distance = 0;
    gameState.cameraX = 0;

    // show skin preview
    renderSkinPreview();

    populateBG();
    player.reset();

    // Events
    ui.btnPlay && ui.btnPlay.addEventListener('click', ()=> openMenu('play'));
    ui.btnSkins && ui.btnSkins.addEventListener('click', ()=> openMenu('skins'));
    ui.btnEditor && ui.btnEditor.addEventListener('click', ()=> openEditor());
    ui.menuClose && ui.menuClose.addEventListener('click', ()=> closeMenu());
    ui.goRestart && ui.goRestart.addEventListener('click', ()=> { restartRun(); hideGameOver(); });
    ui.goMenu && ui.goMenu.addEventListener('click', ()=> { hideGameOver(); openMenu('play'); });
    ui.floatingEditor && ui.floatingEditor.addEventListener('click', ()=> openEditor());
    ui.btnMusic && ui.btnMusic.addEventListener('click', ()=> { isMusicOn = !isMusicOn; ui.btnMusic.textContent = 'Music: ' + (isMusicOn ? 'On' : 'Off'); if (isMusicOn) startMusic(); else stopMusic(); });
    ui.btnFull && ui.btnFull.addEventListener('click', ()=> { if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(()=>{}); else document.exitFullscreen(); });

    // input: keyboard, mouse, touch
    window.addEventListener('keydown', (e)=> {
      if (e.code === 'Space' || e.code === 'ArrowUp') {
        e.preventDefault();
        if (!gameState.alive) { if (gameState.level) restartRun(); return; }
        player.jump();
      }
    });
    window.addEventListener('mousedown', ()=> { if (!gameState.alive) { if (gameState.level) restartRun(); return; } player.jump(); });
    window.addEventListener('touchstart', (e)=> { e.preventDefault(); if (!gameState.alive) { if (gameState.level) restartRun(); return; } player.jump(); }, { passive: false });

    // audio resume on first gesture to avoid autoplay warnings
    function resumeAudioOnce(){
      ensureAudio();
      if (audioCtx && audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') { audioCtx.resume().catch(()=>{}); }
      if (isMusicOn) startMusic();
      document.removeEventListener('pointerdown', resumeAudioOnce);
      document.removeEventListener('touchstart', resumeAudioOnce);
    }
    document.addEventListener('pointerdown', resumeAudioOnce, { once: true });
    document.addEventListener('touchstart', resumeAudioOnce, { once: true, passive: true });

    // Editor buttons
    ui.saveLevel && ui.saveLevel.addEventListener('click', onSaveLevel);
    ui.loadSample && ui.loadSample.addEventListener('click', onLoadSample);
    ui.exportLevel && ui.exportLevel.addEventListener('click', onExportLevel);
    ui.closeEditor && ui.closeEditor.addEventListener('click', closeEditor);

    // Start render loop
    requestAnimationFrame(loop);
  }

  // ---------- UI helpers ----------
  function renderSkinPreview(){
    if (!ui.skinPreview) return;
    ui.skinPreview.innerHTML = '';
    const box = document.createElement('div');
    box.style.width = '64px'; box.style.height = '64px'; box.style.borderRadius = '8px';
    box.style.background = `linear-gradient(180deg, ${lightColor(selectedSkin.color,12)}, ${selectedSkin.color})`;
    box.style.border = '2px solid rgba(0,0,0,0.08)';
    ui.skinPreview.appendChild(box);
    if (ui.skinName) ui.skinName.textContent = selectedSkin.name;
  }
  function saveSelectedSkin(skin){
    selectedSkin = skin; localStorage.setItem(LS_KEY_SKIN, JSON.stringify(skin)); renderSkinPreview();
  }

  // ---------- Menu ----------
  function openMenu(kind){
    if (!ui.menuOverlay) return;
    ui.menuOverlay.classList.remove('hidden');
    ui.menuOverlay.setAttribute('aria-hidden','false');
    ui.menuTitle.textContent = kind.charAt(0).toUpperCase() + kind.slice(1);
    ui.menuBody.innerHTML = '';
    removeCustomizeCorner();

    if (kind === 'play'){
      addCustomizeCorner();
      const list = document.createElement('div'); list.style.display='grid'; list.style.gap='8px';
      levels.forEach(lvl => {
        const b = document.createElement('button'); b.className='btn'; b.textContent = lvl.name + ' — ' + Math.floor((lvl.length||2000)/1000) + 's';
        b.onclick = ()=> { closeMenu(); startLevel(lvl); };
        list.appendChild(b);
      });
      ui.menuBody.appendChild(list);
    } else if (kind === 'skins'){
      const wrap = document.createElement('div'); wrap.className = 'skin-grid';
      SKINS.forEach(s => {
        const card = document.createElement('div'); card.className = 'skin-card'; card.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px;border-radius:8px;cursor:pointer;background:rgba(255,255,255,0.02);';
        const preview = document.createElement('div'); preview.style.width='48px'; preview.style.height='48px'; preview.style.borderRadius='8px'; preview.style.background = `linear-gradient(180deg, ${lightColor(s.color,12)}, ${s.color})`; preview.style.border='1px solid rgba(0,0,0,0.06)';
        const label = document.createElement('div'); label.textContent = s.name; label.style.fontWeight='700';
        card.appendChild(preview); card.appendChild(label);
        card.onclick = ()=> { saveSelectedSkin(s); card.style.boxShadow='0 8px 26px rgba(0,0,0,0.28)'; setTimeout(()=>{ closeMenu(); }, 180); };
        wrap.appendChild(card);
      });
      ui.menuBody.appendChild(wrap);
    } else if (kind === 'settings'){
      const div = document.createElement('div');
      div.innerHTML = `<div style="margin-bottom:8px">Highscore: ${loadHigh()}</div>`;
      const reset = document.createElement('button'); reset.className='btn'; reset.textContent='Reset Highscore'; reset.onclick = ()=> { if (confirm('Reset highscore?')) { localStorage.removeItem(LS_KEY_HIGHSCORE); hudHigh().textContent = 'High: 0'; } };
      div.appendChild(reset);
      ui.menuBody.appendChild(div);
    }
  }
  function closeMenu(){
    if (!ui.menuOverlay) return;
    ui.menuOverlay.classList.add('hidden');
    ui.menuOverlay.setAttribute('aria-hidden','true');
    removeCustomizeCorner();
  }

  function addCustomizeCorner(){
    const card = document.getElementById('menuCard'); if (!card) return;
    if (card.querySelector('.menu-customize')) return;
    const btn = document.createElement('button'); btn.className = 'menu-customize'; btn.textContent = 'Customize your cube';
    btn.onclick = (e)=> { e.stopPropagation(); openMenu('skins'); };
    card.appendChild(btn);
  }
  function removeCustomizeCorner(){ const card = document.getElementById('menuCard'); if (!card) return; const ex = card.querySelector('.menu-customize'); if (ex) ex.remove(); }

  // ---------- Editor (timeline + preview) ----------
  let editingLevel = null;
  let previewState = null;
  let previewRaf = null;

  function openEditor(level = null){
    editingLevel = level ? JSON.parse(JSON.stringify(level)) : { id:'custom-'+Date.now(), name:'New Level', length:2200, obstacles:[] };
    ui.levelName && (ui.levelName.value = editingLevel.name || '');
    ui.editorPanel.classList.remove('hidden'); ui.editorPanel.setAttribute('aria-hidden','false');
    renderEditorTimeline();
    initPreviewFor(editingLevel);
  }
  function closeEditor(){ ui.editorPanel.classList.add('hidden'); ui.editorPanel.setAttribute('aria-hidden','true'); stopPreview(); editingLevel = null; }

  function onSaveLevel(){
    if (!editingLevel) return;
    editingLevel.name = ui.levelName.value || editingLevel.name;
    const idx = levels.findIndex(l => l.id === editingLevel.id);
    if (idx >= 0) levels[idx] = editingLevel; else levels.push(editingLevel);
    localStorage.setItem(LS_KEY_LEVELS, JSON.stringify(levels));
    alert('Saved');
  }
  function onLoadSample(){ editingLevel = JSON.parse(JSON.stringify(SAMPLE_LEVELS[0])); ui.levelName.value = editingLevel.name; renderEditorTimeline(); initPreviewFor(editingLevel); }
  function onExportLevel(){ if (!editingLevel) return; const data = JSON.stringify(editingLevel, null, 2); const blob = new Blob([data], {type:'application/json'}); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = (editingLevel.name || 'level') + '.json'; a.click(); URL.revokeObjectURL(url); }

  function renderEditorTimeline(){
    if (!ui.editorTimeline) return;
    ui.editorTimeline.innerHTML = '';
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('width','100%'); svg.setAttribute('height','100%'); svg.style.display='block'; svg.style.cursor='crosshair';
    const rect = document.createElementNS(svg.namespaceURI,'rect'); rect.setAttribute('x','0'); rect.setAttribute('y','0'); rect.setAttribute('width','100%'); rect.setAttribute('height','100%'); rect.setAttribute('fill','transparent'); svg.appendChild(rect);
    const L = editingLevel.length || 2200;
    editingLevel.obstacles.forEach((o, idx) => {
      const x = (o.x / L) * 100; const wPct = ((o.w || 120) / L) * 100;
      const g = document.createElementNS(svg.namespaceURI,'g'); g.setAttribute('data-idx', String(idx));
      const r = document.createElementNS(svg.namespaceURI,'rect'); r.setAttribute('x', x+'%'); r.setAttribute('y','12%'); r.setAttribute('width', wPct+'%'); r.setAttribute('height','76%'); r.setAttribute('fill', o.color || '#ff6b6b');
      r.setAttribute('stroke','#000'); r.setAttribute('stroke-opacity','0.08');
      g.appendChild(r); svg.appendChild(g);
    });

    svg.addEventListener('click', (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ev.clientX - rect.left; const pct = px / rect.width; const pos = pct * editingLevel.length;
      const tool = ui.editTool.value; const wv = parseInt(ui.editWidth.value,10); const hv = parseInt(ui.editHeight.value,10); const col = ui.editColor.value;
      const spec = { type: tool, x: Math.max(80, Math.round(pos)), w: tool==='gap' ? Math.max(40,wv) : wv, h: hv, color: col };
      editingLevel.obstacles.push(spec); renderEditorTimeline(); initPreviewFor(editingLevel);
    });
    svg.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const rect = svg.getBoundingClientRect();
      const px = ev.clientX - rect.left; const pct = px / rect.width; const pos = pct * editingLevel.length;
      const idx = editingLevel.obstacles.findIndex(o => pos >= o.x && pos <= o.x + (o.w||0));
      if (idx >= 0){ if (confirm('Delete obstacle?')) { editingLevel.obstacles.splice(idx,1); renderEditorTimeline(); initPreviewFor(editingLevel); } }
    });
    ui.editorTimeline.appendChild(svg);
  }

  // Preview simulation in editor
  function initPreviewFor(level){
    if (!previewCanvas || !previewCtx) return;
    previewCanvas.width = Math.floor(previewCanvas.clientWidth * DPR);
    previewCanvas.height = Math.floor(previewCanvas.clientHeight * DPR);
    previewCtx.setTransform(DPR,0,0,DPR,0,0);

    previewState = {
      level: JSON.parse(JSON.stringify(level)),
      cameraX: 0,
      distance: 0,
      speed: Math.max(120, BASE_SPEED * 0.5),
      player: { x: 60, y: 0, vy: 0, size: 40, onGround: true }
    };
    // set player to ground
    previewState.player.y = (previewCanvas.height / DPR) * 0.78 - previewState.player.size;
    if (previewRaf) cancelAnimationFrame(previewRaf);
    previewLoop();
  }
  function stopPreview(){ if (previewRaf) cancelAnimationFrame(previewRaf); previewRaf = null; previewState = null; if (previewCtx && previewCanvas) previewCtx.clearRect(0,0,previewCanvas.width, previewCanvas.height); }

  function previewLoop(){
    if (!previewState || !previewCtx) return;
    const dt = 1/60;
    const dx = previewState.speed * dt;
    previewState.cameraX += dx; previewState.distance += dx;

    // simple gravity/jump AI
    previewState.player.vy += GRAVITY * dt * 0.5;
    previewState.player.y += previewState.player.vy * dt;
    const pGroundY = (previewCanvas.height / DPR) * 0.78;
    if (previewState.player.y + previewState.player.size >= pGroundY){ previewState.player.y = pGroundY - previewState.player.size; previewState.player.vy = 0; previewState.player.onGround = true; } else previewState.player.onGround = false;

    // if obstacle ahead, jump a bit early
    for (let obs of (previewState.level.obstacles || [])){
      if (obs.x - previewState.cameraX > previewState.player.x && obs.x - previewState.cameraX < previewState.player.x + 160){
        if (previewState.player.onGround){ previewState.player.vy = -380; previewState.player.onGround = false; break; }
      }
    }

    // loop preview
    if (previewState.distance > (previewState.level.length || 2200)){ previewState.cameraX = 0; previewState.distance = 0; previewState.player.y = pGroundY - previewState.player.size; previewState.player.vy = 0; previewState.player.onGround = true; }

    // draw preview
    drawPreview(previewCtx, previewState, previewCanvas.width / DPR, previewCanvas.height / DPR);

    previewRaf = requestAnimationFrame(previewLoop);
  }

  function drawPreview(pctx, state, w, h){
    pctx.clearRect(0,0,w,h);
    const g = pctx.createLinearGradient(0,0,0,h); g.addColorStop(0,'#0b2a4a'); g.addColorStop(1,'#071323'); pctx.fillStyle = g; pctx.fillRect(0,0,w,h);
    const baseY = Math.round(h * 0.78);
    pctx.fillStyle = '#07283e'; pctx.fillRect(0, baseY, w, h - baseY);

    for (let obs of (state.level.obstacles || [])){
      const sx = Math.round(obs.x - state.cameraX);
      const sy = Math.round(baseY - (obs.h || 80));
      if (obs.type === 'gap') continue;
      if (obs.type === 'block'){ pctx.fillStyle = obs.color || '#ff6b6b'; roundRect(pctx, sx, sy, obs.w, obs.h, 6); pctx.strokeStyle='rgba(0,0,0,0.06)'; pctx.lineWidth=1; roundRectStroke(pctx,sx,sy,obs.w,obs.h,6); }
      else if (obs.type === 'spike'){ const spikeW = 18; pctx.fillStyle = obs.color || '#ff6b6b'; for (let px = sx; px < sx + obs.w; px += spikeW){ pctx.beginPath(); pctx.moveTo(px,baseY); pctx.lineTo(px+spikeW/2, baseY - obs.h); pctx.lineTo(px+spikeW,baseY); pctx.closePath(); pctx.fill(); } }
    }

    // player
    const p = state.player; const px = Math.round(p.x), py = Math.round(p.y), s = p.size;
    const grad = pctx.createLinearGradient(px,py,px,py+s); grad.addColorStop(0, lightColor(selectedSkin.color, 12)); grad.addColorStop(1, selectedSkin.color);
    pctx.fillStyle = grad; roundRect(pctx, px, py, s, s, 6); pctx.strokeStyle = 'rgba(0,0,0,0.12)'; pctx.lineWidth=1; roundRectStroke(pctx,px,py,s,s,6);
  }

  // ---------- Game start/stop ----------
  function startLevel(level){
    if (!level) return;
    gameState.level = JSON.parse(JSON.stringify(level));
    gameState.obstacles = (gameState.level.obstacles || []).map(o => new Obstacle(o));
    gameState.cameraX = 0; gameState.distance = 0; gameState.bgOffset = 0; gameState.speed = BASE_SPEED;
    gameState.running = true; gameState.alive = true;
    player = new Player(); player.reset();
    lastTime = performance.now();
    hideGameOver();
    closeMenu();
  }

  function endRun(){
    // stop running and show game over
    gameState.running = false;
    gameState.alive = false;
    playSfx('hit');
    spawnParticles(player.x + player.size/2, player.y + player.size/2);
    const go = document.getElementById('gameOver'); if (go) { go.classList.remove('hidden'); go.setAttribute('aria-hidden','false'); }
    document.getElementById('goDist').textContent = Math.floor(gameState.distance);
    // update highscore
    const high = loadHigh(); if (gameState.distance > high) saveHigh(gameState.distance);
  }

  function hideGameOver(){ const go = document.getElementById('gameOver'); if (go) { go.classList.add('hidden'); go.setAttribute('aria-hidden','true'); } }

  function restartRun(){ if (!gameState.level) return; startLevel(gameState.level); }

  // ---------- Loop ----------
  function loop(ts){
    if (!lastTime) lastTime = ts;
    const dt = Math.min(0.032, (ts - lastTime) / 1000);
    lastTime = ts;

    if (gameState.running && gameState.alive){
      // progress
      const dx = gameState.speed * dt;
      gameState.cameraX += dx; gameState.distance += dx; hudDistance().textContent = 'Distance: ' + Math.floor(gameState.distance);
      gameState.bgOffset += dx;
      // update player
      player.update(dt);

      // collision
      for (let obs of gameState.obstacles){
        if (!obs.passed && obs.x + obs.w < player.x) obs.passed = true;
        if (obs.collidesWith(player)){
          endRun(); break;
        }
      }

      // cleanup
      gameState.obstacles = gameState.obstacles.filter(o => o.x + o.w > gameState.cameraX - 400);

      updateParticles(dt);
    }

    draw();
    requestAnimationFrame(loop);
  }

  // ---------- Drawing ----------
  function draw(){
    // clear
    ctx.fillStyle = '#061626'; ctx.fillRect(0,0,canvas.width/DPR,canvas.height/DPR);

    // sky
    const g = ctx.createLinearGradient(0,0,0,canvas.height/DPR); g.addColorStop(0,'#0b2a4a'); g.addColorStop(1,'#071323'); ctx.fillStyle = g; ctx.fillRect(0,0,canvas.width/DPR,canvas.height/DPR);

    // bg layers
    for (let i=0;i<bgLayers.length;i++){
      const layer = bgLayers[i];
      ctx.fillStyle = `rgba(255,255,255,${0.01 + i*0.02})`;
      for (let obj of layer.items){
        const sx = obj.x - gameState.bgOffset * layer.speed;
        const w = Math.max(window.innerWidth,800);
        const rx = ((sx % (w*2)) + (w*2)) % (w*2) - w;
        ctx.beginPath(); ctx.ellipse(rx, obj.y + i*20, obj.size, obj.size*0.5, 0, 0, Math.PI*2); ctx.fill();
      }
    }

    // horizon
    ctx.fillStyle = 'rgba(255,255,255,0.02)'; ctx.fillRect(0, groundY() + 2, canvas.width/DPR, 2);

    // obstacles
    for (let obs of gameState.obstacles) obs.draw(ctx, gameState.cameraX);

    // ground
    const tileW = 64; const baseY = groundY();
    ctx.fillStyle = '#07283e'; ctx.fillRect(0, baseY, canvas.width/DPR, canvas.height/DPR - baseY);
    for (let x = - (gameState.cameraX % tileW); x < canvas.width/DPR + tileW; x += tileW){
      ctx.strokeStyle = 'rgba(255,255,255,0.02)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, baseY); ctx.lineTo(x+tileW, baseY); ctx.stroke();
    }

    // particles
    drawParticles(ctx, gameState.cameraX);

    // player
    player.draw(ctx);
  }

  // ---------- Misc helpers ----------
  function resizeCanvas(){
    DPR = Math.max(1, window.devicePixelRatio || 1);
    if (canvas) {
      canvas.width = Math.floor(window.innerWidth * DPR);
      canvas.height = Math.floor((window.innerHeight - 64) * DPR);
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = (window.innerHeight - 64) + 'px';
      ctx && ctx.setTransform && ctx.setTransform(DPR,0,0,DPR,0,0);
    }
    if (previewCanvas) {
      previewCanvas.width = Math.floor(previewCanvas.clientWidth * DPR);
      previewCanvas.height = Math.floor(previewCanvas.clientHeight * DPR);
      previewCtx && previewCtx.setTransform && previewCtx.setTransform(DPR,0,0,DPR,0,0);
    }
  }

  function loadHigh(){ return parseInt(localStorage.getItem(LS_KEY_HIGHSCORE) || '0', 10); }
  function saveHigh(v){ localStorage.setItem(LS_KEY_HIGHSCORE, String(Math.floor(v))); hudHigh().textContent = 'High: ' + Math.floor(v); }
  (function(){ if (document.readyState === 'complete' || document.readyState === 'interactive') { try { hudHigh().textContent = 'High: ' + loadHigh(); } catch(e){} } })();

  // ---------- Expose some functions for debug ----------
  window.CD = {
    startLevelById: (id)=> { const lvl = levels.find(l => l.id === id); if (lvl) startLevel(lvl); },
    levels, saveLevels: ()=> localStorage.setItem(LS_KEY_LEVELS, JSON.stringify(levels)),
    setSkin: saveSelectedSkin, gameState
  };

})();
