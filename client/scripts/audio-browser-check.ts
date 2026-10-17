import assert from 'node:assert/strict';
import type { CDPSession } from 'playwright';

export interface BrowserCheckHarness {
  call: CDPSession['send'];
  // CDP evaluates JavaScript strings; result types must be supplied by the caller.
  js<T = any>(expression: string): Promise<T>;
  wait(expression: string): Promise<void>;
  pause(ms: number): Promise<void>;
  url: string;
  waitForEvent(method: 'Tracing.tracingComplete'): Promise<{ stream?: string }>;
}



export async function checkAudio({ call, js, wait, pause, url, waitForEvent }: BrowserCheckHarness) {
  await call('Tracing.start', { categories: 'webaudio,audio', transferMode: 'ReturnAsStream' });
  await call('Page.navigate', { url: `${url}/scripts/sound-preview.html` });
  await wait('window.foxSoundDemo != null');
  await call('Runtime.evaluate', {
    expression: `(async()=>{
      const audio=foxSoundDemo.sounds;
      audio.unlock(); await audio.context.resume(); await audio.loading;
      window.audioStarts=[];
      const create=audio.context.createBufferSource.bind(audio.context);
      audio.context.createBufferSource=function(){
        const source=create(), start=source.start.bind(source);
        source.start=function(...args){audioStarts.push({at:performance.now(),state:audio.context.state,gain:audio.output.gain.value});return start(...args);};
        return source;
      };
      audio.play('stone');
    })()`, awaitPromise: true, userGesture: true,
  });
  assert.equal(await js('foxSoundDemo.sounds.buffers.size'), 17);
  assert.equal(await js('foxSoundDemo.sounds.output.gain.value'), 0);
  assert.equal(await js('foxSoundDemo.sounds.idleAnalyser.fftSize'), 32);

  await pause(35000);
  const idle = await js<{ state: string; time: number; starts: { at: number; state: string; gain: number }[] }>(`(()=>{
    const audio=foxSoundDemo.sounds;
    const before=audio.context.currentTime;
    audio.play('stone'); audio.play('stone-capture-small');
    return {state:audio.context.state,time:before,starts:audioStarts};
  })()`);
  assert.equal(idle.state, 'running');
  assert.ok(idle.time > 30);
  assert.equal(idle.starts.length, 3);
  assert.ok(idle.starts.every(s => s.state === 'running' && s.gain === 0));
  assert.ok(idle.starts[1].at - idle.starts[0].at >= 34000);


  await js('(async()=>{await foxSoundDemo.sounds.context.suspend();foxSoundDemo.sounds.play("stone");})()');
  await wait('audioStarts.length === 4');
  assert.equal(await js('audioStarts[3].state'), 'running');

  const traceComplete = waitForEvent('Tracing.tracingComplete');
  await call('Tracing.end');
  const { stream } = await traceComplete;
  assert.ok(stream, 'Chromium must return an audio trace stream');
  let traceText = '';
  for (;;) {
    const part = await call('IO.read', { handle: stream });
    traceText += part.base64Encoded ? Buffer.from(part.data, 'base64').toString() : part.data;
    if (part.eof) break;
  }
  await call('IO.close', { handle: stream });
  const events: { name: string; args?: { detect_silence?: boolean } }[] = JSON.parse(traceText).traceEvents;
  assert.ok(events.some(e => e.name === 'AudioDestination::SetDetectSilence' &&
    e.args?.detect_silence === false),
    'Chromium must disable its silent-sink switch for the automatic pull node');



  const renders = await js<{ muted: boolean; name: string | null; unchanged: boolean; hasSignal: boolean }[]>(`(async()=>{
    const {FoxSounds}=await import('/src/sound.ts');
    const results=[];
    for(const muted of [true,false]) for(const name of [null,'stone','stone-capture-small','start-play']){
      const samples=[];
      for(const keepActive of [false,true]){
        const Native=window.AudioContext; let audio;
        try{
          window.AudioContext=class extends OfflineAudioContext{constructor(){super(1,57600,48000)}};
          audio=new FoxSounds({muted});
        }finally{window.AudioContext=Native}
        await audio.loading;
        if(!keepActive) audio.output.disconnect(audio.idleAnalyser);
        Object.defineProperty(audio.context,'state',{get:()=> 'running'});
        if(name) audio.play(name);
        samples.push((await audio.context.startRendering()).getChannelData(0));
      }
      results.push({muted,name,unchanged:samples[0].every((v,i)=>v===samples[1][i]),
        hasSignal:samples[1].some(v=>v!==0)});
    }
    return results;
  })()`);
  for (const render of renders) {
    assert.equal(render.unchanged, true, JSON.stringify(render));
    assert.equal(render.hasSignal, !render.muted && render.name !== null);
  }
  console.log('Audio checks passed: Chromium idle suspension disabled, playback after 35s idle, first effect survives resume, all 17 buffers decode, offline output unchanged and no keepalive signal');
}
