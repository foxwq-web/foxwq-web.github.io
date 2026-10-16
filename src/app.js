import { Session } from './session.js';
const session = new Session();
const $ = id => document.getElementById(id);
const canvas=$('board'), ctx=canvas.getContext('2d');
let state=null, dead=new Set(), hover=null, busy=false, errorTimer;
const margin=48, step=(840-2*margin)/18;
function showError(message){$('error').textContent=message;$('error').hidden=false;clearTimeout(errorTimer);errorTimer=setTimeout(()=>$('error').hidden=true,5000);}
function command(action, body = {}) {
 if (busy) return; busy = true;
 try {
   const actions = {
     login: () => {
       session.proxyUrl = $('proxy-url').value.trim();
       session.proxyToken = $('proxy-token').value.trim();
       session.login($('username').value, $('password').value);
       $('password').value = '';
     },
     disconnect: () => session.close(), local: () => session.localGame(),
     match: () => session.match(), cancel: () => session.cancelMatch(),
     'request-score': () => session.requestScore(), confirm: () => session.confirm(body.accept),
     play: () => session.play(body.x, body.y), pass: () => session.passTurn(),
     resign: () => session.resign(), score: () => session.score(body.dead ?? [])
   };
   actions[action](); state = session.snapshot(); render();
 } catch (error) { showError(error.message); } finally { busy = false; }
}
function circle(x,y,color,alpha=1){ctx.save();ctx.globalAlpha=alpha;const px=margin+x*step,py=margin+y*step,r=step*.46;const g=ctx.createRadialGradient(px-r*.3,py-r*.35,r*.05,px,py,r);g.addColorStop(0,color===1?'#55564f':'#fff');g.addColorStop(1,color===1?'#131711':'#d8d9cf');ctx.shadowColor='#32280f55';ctx.shadowBlur=4;ctx.shadowOffsetY=2;ctx.fillStyle=g;ctx.beginPath();ctx.arc(px,py,r,0,Math.PI*2);ctx.fill();ctx.restore();}
function draw(){ctx.clearRect(0,0,840,840);ctx.fillStyle='#d6b77d';ctx.fillRect(0,0,840,840);ctx.strokeStyle='#655634';ctx.lineWidth=1.1;for(let i=0;i<19;i++){const p=margin+i*step;ctx.beginPath();ctx.moveTo(margin,p);ctx.lineTo(840-margin,p);ctx.moveTo(p,margin);ctx.lineTo(p,840-margin);ctx.stroke();}ctx.fillStyle='#655634';ctx.font='13px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';for(let i=0;i<19;i++){const p=margin+i*step;ctx.fillText('ABCDEFGHJKLMNOPQRST'[i],p,22);ctx.fillText('ABCDEFGHJKLMNOPQRST'[i],p,818);ctx.fillText(String(19-i),22,p);ctx.fillText(String(19-i),818,p);}for(const y of [3,9,15])for(const x of [3,9,15]){ctx.beginPath();ctx.arc(margin+x*step,margin+y*step,4,0,Math.PI*2);ctx.fill();}if(!state)return;state.stones.forEach((color,p)=>{if(color)circle(p%19,Math.floor(p/19),color,dead.has(p)?.25:1);});if(state.last_move&&state.last_move[1]!==null){const [color,x,y]=state.last_move;ctx.strokeStyle=color===1?'#ededde':'#45503a';ctx.lineWidth=2;ctx.strokeRect(margin+x*step-5,margin+y*step-5,10,10);}if(hover!==null&&state.phase==='playing'&&(state.mode==='local'||state.color===state.turn)&&!state.pending&&!state.stones[hover])circle(hover%19,Math.floor(hover/19),state.turn,.4);}
function clock(color){const c=state.clocks[String(color)];if(!c)return '—';const elapsed=state.phase==='playing'&&state.turn===color?Math.max(0,Date.now()/1000-c.at):0;const left=Math.max(0,Math.ceil(c.main-elapsed));return left>0?`${Math.floor(left/60)}:${String(left%60).padStart(2,'0')}`:`${c.periods} × ${c.byoyomi}s`; }
function render(){if(!state)return;const local=state.mode==='local',playing=state.phase==='playing';$('mode').textContent=local?'Local board':state.phase;$('status').textContent=state.status;$('turn').textContent=state.result||`${state.turn===1?'Black':'White'} to play · Move ${state.moves+1}`;$('captures').textContent=`Captures · Black ${state.captures[1]} / White ${state.captures[2]}`;$('pass').disabled=!(playing&&!state.pending&&(local||state.color===state.turn));$('resign').disabled=!(playing&&!state.pending);$('login').disabled=['connecting','authenticating','bootstrap','gateway'].includes(state.phase);$('match').disabled=!(state.mode==='fox'&&['ready','finished'].includes(state.phase));$('cancel').hidden=!['matching','confirming'].includes(state.phase);$('score').hidden=!(local&&state.phase==='scoring');$('local').disabled=state.mode==='fox'&&['playing','joining','resuming','matching','confirming'].includes(state.phase);$('request-score').hidden=!(state.mode==='fox'&&playing);$('request-score').disabled=state.pending;$('confirmation').hidden=!state.confirmation;$('clocks').textContent=state.mode==='fox'?`Black ${clock(1)} · White ${clock(2)}`:'';$('events').textContent=state.events.join('\n');$('hint').textContent=state.phase==='scoring'?'Click dead stones to mark their groups, then finish scoring.':local?'Local game · click an intersection to play.':(state.phase==='playing'?`You are ${state.color===1?'Black':'White'}. ${state.pending?'Waiting for Fox…':state.color===state.turn?'Click to play.':'Waiting for opponent.'}`:'Find a normal match when connected.');draw();}
function point(event){const r=canvas.getBoundingClientRect(),x=Math.round(((event.clientX-r.left)*840/r.width-margin)/step),y=Math.round(((event.clientY-r.top)*840/r.height-margin)/step);return x>=0&&x<19&&y>=0&&y<19?y*19+x:null;}
canvas.addEventListener('pointermove',e=>{hover=point(e);draw();});canvas.addEventListener('pointerleave',()=>{hover=null;draw();});
canvas.addEventListener('click',e=>{const p=point(e);if(p===null||!state)return;if(state.phase==='scoring'&&state.stones[p]){const color=state.stones[p],group=new Set(),pending=[p];while(pending.length){const q=pending.pop();if(group.has(q))continue;group.add(q);const x=q%19,y=Math.floor(q/19);for(const [nx,ny]of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]])if(nx>=0&&nx<19&&ny>=0&&ny<19&&state.stones[ny*19+nx]===color)pending.push(ny*19+nx);}const remove=dead.has(p);for(const q of group)remove?dead.delete(q):dead.add(q);draw();}else if(state.phase==='playing'&&!state.pending&&(state.mode==='local'||state.color===state.turn))command('play',{x:p%19,y:Math.floor(p/19)});});
$('login-form').onsubmit=e=>{e.preventDefault();command('login');};$('match').onclick=()=>command('match');$('cancel').onclick=()=>command('cancel');$('disconnect').onclick=()=>command('disconnect');$('local').onclick=()=>{if(state&&state.mode==='local'&&state.moves&&state.phase!=='finished'&&!confirm('Start a new local game?'))return;dead.clear();command('local');};$('pass').onclick=()=>command('pass');$('resign').onclick=()=>{if(confirm('Resign this game?'))command('resign');};$('request-score').onclick=()=>command('request-score');$('accept').onclick=()=>command('confirm',{accept:true});$('decline').onclick=()=>command('confirm',{accept:false});$('score').onclick=()=>command('score',{dead:[...dead]});

$('proxy-url').value = import.meta.env.VITE_FOX_PROXY_URL || 'wss://proxy.foxwq.workers.dev/proxy';
$('save-sgf').onclick = event => {
  event.preventDefault();
  const url = URL.createObjectURL(new Blob([session.board.sgf(session.result)], { type: 'application/x-go-sgf' }));
  const link = document.createElement('a'); link.href = url; link.download = 'game.sgf'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
window.addEventListener('pagehide', () => session.close());
setInterval(() => { state = session.snapshot(); render(); }, 250);
state = session.snapshot(); render();
