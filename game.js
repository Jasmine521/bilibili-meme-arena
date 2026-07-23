const lanes=[['D','前方高能'],['F','名场面'],['J','下次一定'],['K','好耶！']];
const diffKeys=['easy','normal','hard'];
const DIFFICULTIES=[
  {name:'进阶',level:'LV.5',perfect:75,early:165,late:175,source:'normal'},
  {name:'高能',level:'LV.8',perfect:58,early:135,late:145,source:'hard'},
  {name:'鬼畜',level:'LV.11',perfect:45,early:105,late:115,source:'hard'}
];
const APPROACH_TIME=[2050,1680,1380];
const chartCache=new Map();

let difficulty=0;
let songIndex=0;
let phase='ready';
let notes=[];
let activeNotes=new Map();
let spawnCursor=0;
let score=0;
let combo=0;
let maxCombo=0;
let perfect=0;
let good=0;
let miss=0;
let muted=false;
let raf=0;
let countTimer=0;
let lastSecond=-1;
let audioContext=null;
let assetLoadPromise=null;
let assetAbort=null;
let assetToken=0;
let assetState='idle';
let assetReadyIndex=-1;
let assetBlobUrl='';
let warmedSongIndex=-1;
let openDrawerId='';
let drawerPausedGame=false;
let drawerReturnFocus=null;
const heldKeys=new Set();

const $=id=>document.getElementById(id);
const music=$('music');
const show=(id,on)=>$(id).classList.toggle('hidden',!on);
const song=()=>SONGS[songIndex];
const chart=()=>enhancedChart(song(),difficulty);
const now=()=>music.currentTime*1000+(+(localStorage.rhythmOffset||0));

function enhancedChart(targetSong,level){
  const key=`${targetSong.id}_${level}`;
  if(chartCache.has(key))return chartCache.get(key);
  const spec=DIFFICULTIES[level];
  const source=targetSong.charts[spec.source].map(note=>[note[0],note[1]]);
  if(level===0){
    chartCache.set(key,source);
    return source;
  }

  const additions=[];
  for(let i=0;i<source.length-1;i++){
    const current=source[i];
    const next=source[i+1];
    const gap=next[0]-current[0];
    const shouldSplit=level===1
      ? gap>=380&&gap<=610&&i%2===0
      : gap>=250&&gap<=620;
    if(shouldSplit){
      const time=Math.round((current[0]+next[0])/2);
      const lane=(current[1]+(i%2?1:3))%4;
      if(lane!==next[1])additions.push([time,lane]);
    }
    const chordEvery=level===1?13:7;
    if(i>5&&i%chordEvery===0){
      additions.push([current[0],(current[1]+2+(i%2))%4]);
    }
  }

  const seen=new Set();
  const result=[...source,...additions]
    .sort((a,b)=>a[0]-b[0]||a[1]-b[1])
    .filter(note=>{
      const noteKey=note[0]+'_'+note[1];
      if(seen.has(noteKey))return false;
      seen.add(noteKey);
      return true;
    });
  chartCache.set(key,result);
  return result;
}

function setupLanes(){
  const root=$('lanes');
  root.innerHTML='';
  lanes.forEach((lane,i)=>{
    const button=document.createElement('button');
    button.className='lane l'+i;
    button.innerHTML=`<small>${lane[1]}</small><b>${lane[0]}</b>`;
    button.setAttribute('aria-label',`${lane[0]}键轨道 ${lane[1]}`);
    button.addEventListener('pointerdown',event=>{
      event.preventDefault();
      button.setPointerCapture?.(event.pointerId);
      pressLane(i,true);
      hit(i);
    });
    ['pointerup','pointercancel','lostpointercapture'].forEach(type=>{
      button.addEventListener(type,()=>pressLane(i,false));
    });
    root.appendChild(button);
  });
  setupEnergy();
}

function setupEnergy(){
  if(!$('energy').children.length){
    $('energy').innerHTML=Array.from({length:12},()=>'<i></i>').join('');
  }
}

function renderSongs(){
  const list=$('songList');
  list.innerHTML='';
  SONGS.forEach((s,i)=>{
    const noteCount=enhancedChart(s,difficulty).length;
    const card=document.createElement('button');
    card.className='song-card'+(i===songIndex?' selected':'');
    card.style.setProperty('--a',s.colors[0]);
    card.style.setProperty('--b',s.colors[1]);
    card.innerHTML=`<span class="disc"><i>♫</i></span><span class="song-copy"><small>TRACK ${String(i+1).padStart(2,'0')}</small><strong>${s.title}</strong><em>${s.subtitle}</em><span class="tags"><i>${s.bpm} BPM</i><i>${Math.floor(s.duration/60)}:${String(Math.round(s.duration%60)).padStart(2,'0')}</i><i>${noteCount} NOTES</i></span></span><b class="pick">${i===songIndex?'已选择':'选择'}</b>`;
    card.onclick=()=>{
      selectSong(i);
      closeDrawers();
    };
    list.appendChild(card);
  });
}

function selectSong(i){
  if(['play','count','pause','loading'].includes(phase))return;
  if(i===songIndex&&assetState==='loading')return;
  if(i===songIndex&&assetReadyIndex===i){
    syncSelected();
    return;
  }
  music.pause();
  songIndex=i;
  document.documentElement.style.setProperty('--song-a',song().colors[0]);
  document.documentElement.style.setProperty('--song-b',song().colors[1]);
  renderSongs();
  syncSelected();
  updateHud(true);
  preloadSong(i);
}

function syncSelected(){
  const spec=DIFFICULTIES[difficulty];
  $('selectedTitle').innerHTML=`${song().title}<br><i>踩准节拍</i>`;
  $('selectedMeta').textContent=`♪ ${song().bpm} BPM · ${chart().length} NOTES · ${spec.name}`;
  $('playingTitle').textContent=`TRACK ${String(songIndex+1).padStart(2,'0')} · ${song().title}`;
  $('topSongTitle').textContent=song().title;
  $('topSongMeta').textContent=`${song().bpm} BPM · ${spec.name}`;
  $('stageSongTitle').textContent=song().title;
  $('difficultyLabel').textContent=`${spec.name} · ${spec.level}`;
  $('stageMeta').textContent=`${song().bpm} BPM · ${chart().length} NOTES`;
}

function setAssetUi(state,progress=0,label=''){
  assetState=state;
  const loader=$('assetLoader');
  const percent=Math.max(0,Math.min(100,Math.round(progress)));
  loader.className='asset-loader '+state;
  $('loadState').textContent=label||({loading:'正在缓存音频',ready:'资源准备完成',warming:'正在预热播放',error:'资源加载失败'}[state]||'正在准备资源');
  $('loadPercent').textContent=state==='ready'?'READY':state==='error'?'RETRY':percent+'%';
  $('loadBar').style.width=(state==='error'?100:percent)+'%';
  $('resourcePill').className='resource-pill '+state;
  $('resourcePill').textContent=state==='ready'?'资源 READY':state==='error'?'资源异常':state==='warming'?'引擎预热中':`加载 ${percent}%`;
  const button=$('startBtn');
  if(state==='ready'){
    button.disabled=false;
    button.textContent='开始演奏　▶';
  }else if(state==='error'){
    button.disabled=false;
    button.textContent='重新加载　↻';
  }else{
    button.disabled=true;
    button.textContent=state==='warming'?'启动节奏引擎…':`资源加载中　${percent}%`;
  }
}

function waitForMediaReady(token){
  if(music.readyState>=3)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{
      clearTimeout(timer);
      music.removeEventListener('canplaythrough',ready);
      music.removeEventListener('loadeddata',check);
      music.removeEventListener('error',failed);
    };
    const ready=()=>{cleanup();resolve()};
    const check=()=>{if(music.readyState>=3)ready()};
    const failed=()=>{cleanup();reject(new Error('音频解码失败'))};
    const timer=setTimeout(()=>{
      cleanup();
      if(token!==assetToken)return resolve();
      music.readyState>=2?resolve():reject(new Error('音频准备超时'));
    },12000);
    music.addEventListener('canplaythrough',ready,{once:true});
    music.addEventListener('loadeddata',check);
    music.addEventListener('error',failed,{once:true});
  });
}

async function readAudioResponse(response,token){
  const total=Number(response.headers.get('content-length'))||0;
  if(!response.body?.getReader){
    const blob=await response.blob();
    setAssetUi('loading',88,'正在校验音频');
    return blob;
  }
  const reader=response.body.getReader();
  const chunks=[];
  let received=0;
  while(true){
    const {done,value}=await reader.read();
    if(done)break;
    if(token!==assetToken)throw new DOMException('已切换曲目','AbortError');
    chunks.push(value);
    received+=value.byteLength;
    const progress=total?Math.min(88,received/total*88):Math.min(82,12+chunks.length*2);
    setAssetUi('loading',progress,'正在缓存完整音频');
  }
  return new Blob(chunks,{type:response.headers.get('content-type')||'audio/mpeg'});
}

async function preloadSong(index){
  const token=++assetToken;
  assetAbort?.abort();
  assetAbort=new AbortController();
  assetReadyIndex=-1;
  warmedSongIndex=-1;
  setAssetUi('loading',2,'正在连接音频资源');
  music.pause();
  music.removeAttribute('src');
  music.load();
  if(assetBlobUrl){
    URL.revokeObjectURL(assetBlobUrl);
    assetBlobUrl='';
  }
  assetLoadPromise=(async()=>{
    try{
      const response=await fetch(encodeURI(SONGS[index].file),{
        cache:'force-cache',
        signal:assetAbort.signal
      });
      if(!response.ok)throw new Error(`音频请求失败 (${response.status})`);
      const blob=await readAudioResponse(response,token);
      if(token!==assetToken)return false;
      setAssetUi('loading',92,'正在建立播放缓存');
      assetBlobUrl=URL.createObjectURL(blob);
      music.src=assetBlobUrl;
      music.load();
      await waitForMediaReady(token);
      if(token!==assetToken)return false;
      assetReadyIndex=index;
      setAssetUi('ready',100,'音频与乐谱已就绪');
      syncSelected();
      return true;
    }catch(error){
      if(error.name==='AbortError'||token!==assetToken)return false;
      console.error(error);
      setAssetUi('error',100,'加载失败，请检查网络后重试');
      $('selectedMeta').textContent='音频尚未准备完成，点击重新加载';
      return false;
    }
  })();
  return assetLoadPromise;
}

function clearNotes(){
  activeNotes.forEach(note=>note.el?.remove());
  activeNotes.clear();
  $('lanes').querySelectorAll('.note').forEach(node=>node.remove());
}

function reset(){
  clearNotes();
  notes=chart().map((entry,id)=>({id,t:entry[0],l:entry[1],hit:false,el:null}));
  spawnCursor=0;
  score=combo=maxCombo=perfect=good=miss=0;
  lastSecond=-1;
  music.currentTime=0;
  updateHud(true);
  $('progress').style.width='0';
  $('judge').textContent='';
  $('judge').className='judge';
  $('gamePanel').classList.remove('impact','miss-pulse');
  $('lanes').querySelectorAll('.lane').forEach(lane=>lane.classList.remove('pressed','armed','hit-perfect','hit-good'));
}

function primeAudio(){
  const AudioCtx=window.AudioContext||window.webkitAudioContext;
  if(AudioCtx&&!audioContext)audioContext=new AudioCtx();
  audioContext?.resume?.();
}

function nextPaint(){
  return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
}

function noteHitY(root){
  const mobile=innerWidth<=760;
  const lineBottom=mobile?60:67;
  const noteHeight=mobile?40:44;
  return Math.max(120,root.clientHeight-lineBottom-noteHeight/2-2);
}

function waitForPlaybackAdvance(){
  const startedAt=performance.now();
  return new Promise((resolve,reject)=>{
    const check=()=>{
      if(music.currentTime>=.055)return resolve();
      if(performance.now()-startedAt>1500)return reject(new Error('音频管线未能完成预热'));
      requestAnimationFrame(check);
    };
    check();
  });
}

function prepareFirstChartFrame(){
  const approach=APPROACH_TIME[difficulty];
  while(spawnCursor<notes.length&&notes[spawnCursor].t<=approach){
    const note=notes[spawnCursor++];
    if(!note.hit)createNote(note);
  }
  const root=$('lanes');
  const startY=-58;
  const hitY=noteHitY(root);
  activeNotes.forEach(note=>{
    const progress=1-note.t/approach;
    const y=startY+(hitY-startY)*progress;
    note.el.style.transform=`translate3d(0,${y.toFixed(2)}px,0)`;
  });
}

async function warmupPlayback(){
  setAssetUi('warming',94,'正在预热音频解码');
  music.currentTime=0;
  music.volume=0;
  const playPromise=music.play();
  await playPromise;
  await waitForPlaybackAdvance();
  music.pause();
  music.currentTime=0;
  music.volume=muted?0:1;

  setAssetUi('warming',98,'正在渲染首批音符');
  reset();
  show('gamePanel',true);
  $('gamePanel').classList.add('prewarming');
  prepareFirstChartFrame();
  await nextPaint();
  $('gamePanel').classList.remove('prewarming');
  show('gamePanel',false);
  warmedSongIndex=songIndex;
}

async function begin(){
  if(['play','count','pause','loading'].includes(phase))return;
  if(openDrawerId){
    closeDrawers();
    return;
  }
  if(assetReadyIndex!==songIndex){
    if(assetState!=='loading')preloadSong(songIndex);
    return;
  }
  clearInterval(countTimer);
  cancelAnimationFrame(raf);
  primeAudio();
  phase='loading';
  show('startPanel',true);
  show('resultPanel',false);
  show('countPanel',false);
  show('gamePanel',false);
  lock(true);
  try{
    if(warmedSongIndex!==songIndex)await warmupPlayback();
    else reset();
  }catch(error){
    console.error(error);
    music.pause();
    music.volume=muted?0:1;
    phase='ready';
    lock(false);
    setAssetUi('error',100,'播放预热失败，请点击重试');
    $('selectedMeta').textContent='浏览器未能启动音频，请再次点击';
    return;
  }
  phase='count';
  setAssetUi('ready',100,'音频与乐谱已就绪');
  show('startPanel',false);
  show('countPanel',true);
  let count=3;
  pulseCount(String(count));
  countTimer=setInterval(()=>{
    count--;
    if(count>0){
      pulseCount(String(count));
    }else{
      clearInterval(countTimer);
      pulseCount('GO!');
      setTimeout(startMusic,280);
    }
  },620);
}

function pulseCount(value){
  const node=$('countText');
  node.textContent=value;
  node.animate([
    {opacity:0,transform:'scale(1.65)'},
    {opacity:1,transform:'scale(.92)',offset:.72},
    {transform:'scale(1)'}
  ],{duration:520,easing:'cubic-bezier(.2,.8,.2,1)'});
}

function startMusic(){
  show('countPanel',false);
  show('gamePanel',true);
  phase='play';
  music.currentTime=0;
  music.volume=muted?0:1;
  music.play().then(()=>{
    raf=requestAnimationFrame(loop);
  }).catch(()=>{
    phase='ready';
    show('gamePanel',false);
    show('startPanel',true);
    lock(false);
    setAssetUi('error',100,'播放启动失败，请再次尝试');
    $('selectedMeta').textContent='音频播放被浏览器拦截，请再次点击开始';
  });
}

function createNote(note){
  const node=document.createElement('div');
  node.className=`note n${note.l}`;
  node.style.left=(note.l*25+2.5)+'%';
  node.innerHTML=`<span>${lanes[note.l][1]}</span>`;
  node.setAttribute('aria-hidden','true');
  note.el=node;
  activeNotes.set(note.id,note);
  $('lanes').appendChild(node);
}

function retireNote(note,state){
  note.hit=true;
  activeNotes.delete(note.id);
  if(!note.el)return;
  const node=note.el;
  const transform=node.style.transform;
  node.classList.add(state);
  const frames=state==='hit'
    ?[{opacity:1,transform:`${transform} scale(1)`},{opacity:.9,transform:`${transform} scale(1.3)`,offset:.38},{opacity:0,transform:`${transform} scale(.35)`}]
    :[{opacity:1,transform},{opacity:.45,transform:`${transform} translateY(34px) rotate(8deg)`},{opacity:0,transform:`${transform} translateY(70px) rotate(-8deg)`}];
  const animation=node.animate(frames,{duration:state==='hit'?230:360,easing:'cubic-bezier(.2,.75,.25,1)'});
  animation.onfinish=()=>node.remove();
}

function hit(laneIndex){
  if(phase!=='play')return;
  const windows=DIFFICULTIES[difficulty];
  const time=now();
  let candidate=null;
  let closest=Infinity;
  activeNotes.forEach(note=>{
    if(note.hit||note.l!==laneIndex)return;
    const distance=Math.abs(note.t-time);
    if(distance<closest){candidate=note;closest=distance}
  });

  if(!candidate)return emptyTap(laneIndex);
  const delta=time-candidate.t;
  if(delta < -windows.early || delta > windows.late)return emptyTap(laneIndex);

  const isPerfect=Math.abs(delta)<=windows.perfect;
  retireNote(candidate,'hit');
  if(isPerfect)perfect++;else good++;
  combo++;
  maxCombo=Math.max(maxCombo,combo);
  score+=(isPerfect?1000:640)+Math.min(combo,80)*16;
  judge(isPerfect?'PERFECT':'GOOD',delta);
  feedback(laneIndex,isPerfect?'perfect':'good');
  playTick(isPerfect,laneIndex);
  updateHud();
  if(combo===10||combo===25||combo%50===0)milestone(combo);
}

function emptyTap(laneIndex){
  const lane=$('lanes').children[laneIndex];
  if(!lane)return;
  lane.classList.remove('empty-tap');
  void lane.offsetWidth;
  lane.classList.add('empty-tap');
  setTimeout(()=>lane.classList.remove('empty-tap'),120);
}

function pressLane(laneIndex,on){
  const lane=$('lanes').children[laneIndex];
  lane?.classList.toggle('pressed',on);
}

function judge(type,delta=0){
  const node=$('judge');
  const timing=type==='MISS'?'节拍溜走了':`${delta<-8?'EARLY':delta>8?'LATE':'SYNC'} ${Math.abs(Math.round(delta))}ms`;
  node.className='judge '+type;
  node.innerHTML=`<span>${type}</span><small>${timing}${type==='MISS'?'':' · '+combo+' COMBO'}</small>`;
  node.getAnimations().forEach(animation=>animation.cancel());
  node.animate([
    {opacity:0,transform:'translateX(-50%) translateY(15px) scale(.55)'},
    {opacity:1,transform:'translateX(-50%) translateY(-3px) scale(1.16)',offset:.55},
    {opacity:1,transform:'translateX(-50%) translateY(0) scale(1)'}
  ],{duration:310,easing:'cubic-bezier(.16,1,.3,1)'});
}

function feedback(laneIndex,type){
  const lane=$('lanes').children[laneIndex];
  const className='hit-'+type;
  lane.classList.remove(className);
  void lane.offsetWidth;
  lane.classList.add(className);
  setTimeout(()=>lane.classList.remove(className),260);

  const burst=document.createElement('div');
  burst.className='hit-flash '+type;
  burst.style.left=(laneIndex*25+12.5)+'%';
  burst.innerHTML=Array.from({length:8},(_,i)=>`<i style="--i:${i}"></i>`).join('');
  $('gamePanel').appendChild(burst);
  burst.addEventListener('animationend',()=>burst.remove(),{once:true});

  const panel=$('gamePanel');
  if(type==='perfect'&&(combo%10===0||combo>=30)){
    panel.classList.remove('impact');
    void panel.offsetWidth;
    panel.classList.add('impact');
    setTimeout(()=>panel.classList.remove('impact'),180);
  }
  if(navigator.vibrate&&type==='perfect')navigator.vibrate(7);
}

function playTick(isPerfect,laneIndex){
  if(muted||!audioContext)return;
  const oscillator=audioContext.createOscillator();
  const gain=audioContext.createGain();
  const time=audioContext.currentTime;
  oscillator.type='sine';
  oscillator.frequency.setValueAtTime((isPerfect?760:520)+laneIndex*45,time);
  oscillator.frequency.exponentialRampToValueAtTime(isPerfect?1080:650,time+.035);
  gain.gain.setValueAtTime(isPerfect?.027:.018,time);
  gain.gain.exponentialRampToValueAtTime(.0001,time+.045);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start(time);
  oscillator.stop(time+.05);
}

function milestone(value){
  const old=$('comboMilestone');
  old?.remove();
  const node=document.createElement('div');
  node.id='comboMilestone';
  node.className='milestone';
  node.innerHTML=`<small>梗能连锁</small><b>${value} COMBO</b>`;
  $('gamePanel').appendChild(node);
  node.addEventListener('animationend',()=>node.remove(),{once:true});
}

function markMisses(time){
  const lateWindow=DIFFICULTIES[difficulty].late;
  const missed=[];
  activeNotes.forEach(note=>{
    if(!note.hit&&time-note.t>lateWindow)missed.push(note);
  });
  if(!missed.length)return;
  missed.forEach(note=>{
    retireNote(note,'missed');
    miss++;
  });
  combo=0;
  judge('MISS');
  const panel=$('gamePanel');
  panel.classList.remove('miss-pulse');
  void panel.offsetWidth;
  panel.classList.add('miss-pulse');
  setTimeout(()=>panel.classList.remove('miss-pulse'),260);
  updateHud();
}

function loop(){
  if(phase!=='play')return;
  const time=now();
  const approach=APPROACH_TIME[difficulty];
  while(spawnCursor<notes.length&&notes[spawnCursor].t<=time+approach){
    const note=notes[spawnCursor++];
    if(!note.hit)createNote(note);
  }

  markMisses(time);
  const root=$('lanes');
  const startY=-58;
  const hitY=noteHitY(root);
  const armed=new Set();
  activeNotes.forEach(note=>{
    if(note.hit||!note.el)return;
    const progress=1-(note.t-time)/approach;
    const y=startY+(hitY-startY)*progress;
    note.el.style.transform=`translate3d(0,${y.toFixed(2)}px,0)`;
    const distance=Math.abs(note.t-time);
    note.el.classList.toggle('near',distance<260);
    if(note.t>=time&&note.t-time<310)armed.add(note.l);
  });
  root.querySelectorAll('.lane').forEach((lane,i)=>lane.classList.toggle('armed',armed.has(i)));

  $('progress').style.width=Math.min(100,time/(song().duration*1000)*100)+'%';
  const second=Math.ceil(Math.max(0,song().duration-music.currentTime));
  if(second!==lastSecond){
    lastSecond=second;
    $('time').textContent=second+'s';
  }
  if(music.ended||music.currentTime>=song().duration-.06)finish();
  else raf=requestAnimationFrame(loop);
}

function energyValue(){
  return Math.min(100,Math.round((perfect+good*.55)/Math.max(1,chart().length)*115));
}

function bestKey(){return `best_v2_${song().id}_${diffKeys[difficulty]}`}

function bump(node,className){
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
  setTimeout(()=>node.classList.remove(className),220);
}

function updateHud(force=false){
  const energy=energyValue();
  $('score').textContent=String(score).padStart(6,'0');
  $('combo').textContent=combo;
  $('perfect').textContent=perfect;
  $('good').textContent=good;
  $('miss').textContent=miss;
  [...$('energy').children].forEach((bar,i)=>bar.classList.toggle('on',energy>=(i+1)*8));
  $('energyText').textContent=`⚡ ${Math.round(energy*.24)} / 24`;
  $('energyHint').textContent=energy>=100?'梗能量满载，研究增益已激活！':`完成度 ${energy}% · 继续保持节奏`;
  $('best').textContent=(+(localStorage[bestKey()]||0)).toLocaleString();
  $('combo').parentElement?.classList.toggle('combo-hot',combo>=25);
  if(!force){
    bump($('score'),'score-bump');
    if(combo)bump($('combo'),'combo-bump');
  }
  return energy;
}

function finish(){
  if(phase==='result')return;
  cancelAnimationFrame(raf);
  music.pause();
  const remaining=notes.filter(note=>!note.hit);
  if(remaining.length){
    remaining.forEach(note=>{note.hit=true;note.el?.remove()});
    miss+=remaining.length;
    combo=0;
  }
  clearNotes();
  phase='result';
  show('gamePanel',false);
  show('resultPanel',true);
  lock(false);
  const total=Math.max(1,perfect+good+miss);
  const accuracy=Math.round((perfect+good*.65)/total*100);
  localStorage[bestKey()]=Math.max(score,+(localStorage[bestKey()]||0));
  updateHud(true);
  $('rank').textContent=miss===0?'全 连':accuracy>=95?'梗 王':accuracy>=80?'高 能':accuracy>=60?'入 坑':'再 练';
  $('finalScore').textContent=score.toLocaleString();
  $('accuracy').textContent=accuracy+'%';
  $('maxCombo').textContent=maxCombo;
  renderRecords();
  $('resultPanel').animate([
    {opacity:0,transform:'translateY(22px) scale(.94)'},
    {opacity:1,transform:'translateY(0) scale(1)'}
  ],{duration:480,easing:'cubic-bezier(.16,1,.3,1)'});
}

function togglePause(){
  if(phase==='play'){
    music.pause();
    phase='pause';
    cancelAnimationFrame(raf);
    show('pauseLayer',true);
    $('pauseBtn').textContent='▶';
    $('lanes').querySelectorAll('.lane').forEach(lane=>lane.classList.remove('pressed','armed'));
  }else if(phase==='pause'){
    phase='play';
    show('pauseLayer',false);
    $('pauseBtn').textContent='Ⅱ';
    music.play().then(()=>raf=requestAnimationFrame(loop)).catch(()=>{});
  }
}

function renderRecords(){
  const root=$('recordsList');
  if(!root)return;
  root.innerHTML=SONGS.map((item,index)=>{
    const scores=diffKeys.map(key=>(+(localStorage[`best_v2_${item.id}_${key}`]||0)).toLocaleString());
    return `<article class="record-row"><div><small>TRACK ${String(index+1).padStart(2,'0')}</small><b>${item.title}</b></div>${scores.map((value,i)=>`<span><b>${value}</b>${DIFFICULTIES[i].name}</span>`).join('')}</article>`;
  }).join('');
}

function setDrawerButtons(id){
  document.querySelectorAll('[data-open]').forEach(button=>{
    button.classList.toggle('active',button.dataset.open===id);
  });
}

function openDrawer(id,opener=null){
  if(['count','loading'].includes(phase))return;
  if(openDrawerId===id){
    closeDrawers();
    return;
  }
  if(phase==='play'){
    togglePause();
    drawerPausedGame=true;
  }
  document.querySelectorAll('.drawer').forEach(drawer=>{
    const isTarget=drawer.id===id;
    drawer.classList.toggle('open',isTarget);
    drawer.setAttribute('aria-hidden',String(!isTarget));
    drawer.inert=!isTarget;
  });
  $('drawerBackdrop').classList.add('open');
  openDrawerId=id;
  drawerReturnFocus=opener||document.activeElement;
  setDrawerButtons(id);
  if(id==='recordsDrawer')renderRecords();
  requestAnimationFrame(()=>$(`${id}`)?.querySelector('[data-close]')?.focus({preventScroll:true}));
}

function closeDrawers(){
  if(!openDrawerId)return;
  document.querySelectorAll('.drawer').forEach(drawer=>{
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden','true');
    drawer.inert=true;
  });
  $('drawerBackdrop').classList.remove('open');
  openDrawerId='';
  setDrawerButtons('');
  drawerReturnFocus?.focus?.({preventScroll:true});
  drawerReturnFocus=null;
  if(drawerPausedGame&&phase==='pause'){
    drawerPausedGame=false;
    setTimeout(()=>{if(phase==='pause'&&!openDrawerId)togglePause()},180);
  }else{
    drawerPausedGame=false;
  }
}

function setupDrawers(){
  document.querySelectorAll('.drawer').forEach(drawer=>drawer.inert=true);
  document.querySelectorAll('[data-open]').forEach(button=>{
    button.addEventListener('click',()=>openDrawer(button.dataset.open,button));
  });
  document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',closeDrawers));
  $('drawerBackdrop').addEventListener('click',closeDrawers);
}

function lock(on){
  document.querySelectorAll('[data-diff],.song-card').forEach(button=>button.disabled=on);
}

document.querySelectorAll('[data-diff]').forEach(button=>{
  button.onclick=()=>{
    difficulty=+button.dataset.diff;
    document.querySelectorAll('[data-diff]').forEach(item=>item.classList.toggle('on',item===button));
    warmedSongIndex=-1;
    renderSongs();
    syncSelected();
    updateHud(true);
    closeDrawers();
  };
});

$('startBtn').onclick=$('replayBtn').onclick=begin;
$('pauseBtn').onclick=togglePause;
$('pauseLayer').onclick=togglePause;
$('mute').onclick=()=>{
  muted=!muted;
  music.volume=muted?0:1;
  $('mute').textContent=muted?'🔇':'♫';
};

addEventListener('keydown',event=>{
  const key=event.key.toUpperCase();
  if(event.key==='Escape'&&openDrawerId){
    event.preventDefault();
    closeDrawers();
    return;
  }
  const laneIndex=lanes.findIndex(item=>item[0]===key);
  if(laneIndex>=0){
    event.preventDefault();
    if(event.repeat||heldKeys.has(key))return;
    heldKeys.add(key);
    pressLane(laneIndex,true);
    hit(laneIndex);
  }
  if(event.key===' '&&!openDrawerId&&(phase==='ready'||phase==='result')){
    event.preventDefault();
    begin();
  }
  if(key==='P'&&(phase==='play'||phase==='pause'))togglePause();
});

addEventListener('keyup',event=>{
  const key=event.key.toUpperCase();
  const laneIndex=lanes.findIndex(item=>item[0]===key);
  if(laneIndex>=0){
    heldKeys.delete(key);
    pressLane(laneIndex,false);
  }
});

document.addEventListener('visibilitychange',()=>{
  if(document.hidden&&phase==='play')togglePause();
});

music.addEventListener('error',()=>{
  if(assetState!=='loading')$('selectedMeta').textContent='音频加载失败，请点击重新加载';
});

addEventListener('pagehide',()=>{
  assetAbort?.abort();
  if(assetBlobUrl)URL.revokeObjectURL(assetBlobUrl);
});

setupLanes();
setupDrawers();
renderRecords();
renderSongs();
selectSong(0);
