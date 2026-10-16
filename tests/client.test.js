import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import { Board } from '../src/board.js';
import { encode, decode, signed, readVarint } from '../src/wire.js';
import { encode as frame, decodeOne, gatewayPayload, splitGateway } from '../src/framing.js';
import { Session, loginRequest } from '../src/session.js';
import * as game from '../src/game.js';

test('wire preserves nested, repeated and all 64-bit values; rejects malformed input', () => {
  const m = decode(encode({ 1: -1, 2: { 1: 1200, 2: 60, 3: 3 }, 3: [Buffer.from('a'), Buffer.from('b')], 4: 18446744073709551615n }));
  assert.equal(signed(m.one(1)), -1); assert.equal(m.sub(2).one(1), 1200);
  assert.deepEqual(m.get(3).map(b => b.toString()), ['a', 'b']); assert.equal(m.one(4), 18446744073709551615n);
  for (const bytes of ['00', '0a056869', '08ffffffffffffffffffff']) assert.throws(() => decode(Buffer.from(bytes, 'hex')));
  assert.throws(() => readVarint(Buffer.from([128])));
});
test('login contract', () => {
  const m = decode(loginRequest('test', 'password', '001122334455'));
  assert.equal(m.text(3), '5f4dcc3b5aa765d61d8327deb882cf99'); assert.equal(m.text(7), '001122334455'); assert.equal(m.one(5), 11509231);
});
test('framing matches reference bytes, fragmentation, extended headers and compression', () => {
  const fixture = Buffer.from('000707d00001b800d8', 'hex');
  assert.deepEqual(frame(2000, Buffer.alloc(0)), fixture);
  for (let i = 0; i < fixture.length; i++) assert.equal(decodeOne(fixture.subarray(0, i)), null);
  assert.equal(decodeOne(fixture)[0].command, 2000);
  assert.throws(() => decodeOne(Buffer.from('000707d00001b800d9', 'hex')), /Adler/);
  const small = frame(7000, Buffer.alloc(0x7ffe - 7, 120)), large = frame(7000, Buffer.alloc(0x7fff - 7, 120));
  assert.equal(small.readUInt16BE(0), 0x7ffe); assert.equal(large.subarray(0, 8).toString('hex'), '7fff000b00007fff');
  assert.equal(decodeOne(large)[0].payload.length, 0x7fff - 7);
  const packet = frame(26200, Buffer.alloc(5000, 97), true);
  assert.equal(packet[4], 2); assert.equal(decodeOne(Buffer.concat([packet, fixture]))[1], packet.length);
  assert.deepEqual(decodeOne(packet)[0].payload, Buffer.alloc(5000, 97)); assert.throws(() => decodeOne(packet, 100));
  const envelope = gatewayPayload(Buffer.from('0801', 'hex'), Buffer.from('1002', 'hex'));
  assert.equal(envelope.toString('hex'), '000208011002'); assert.deepEqual(splitGateway(envelope).map(b => b.toString('hex')), ['0801', '1002']);
});
test('capture, suicide, ko, passes, area scoring and SGF escaping', () => {
  const board = new Board();
  for (const [x,y] of [[1,0],[0,1],[2,1]]) board.play(x,y,1);
  board.play(1,1,2); board.play(1,2,1); assert.equal(board.stones[20],0); assert.equal(board.captures[1],1);
  assert.throws(() => board.play(1,1,2), /suicide/);
  const ko = new Board();
  for (const [x,y] of [[0,1],[1,0],[2,1]]) ko.play(x,y,1);
  for (const [x,y] of [[1,1],[0,2],[2,2],[1,3]]) ko.play(x,y,2);
  ko.play(1,2,1); assert.throws(() => ko.play(1,1,2), /ko/); ko.passTurn(2); ko.passTurn(1); ko.play(1,1,2); assert.equal(ko.stones[39],0);
  const s = new Session(); s.localGame(); s.play(3,3); s.passTurn(); s.passTurn(); assert.equal(s.phase,'scoring'); s.score([]);
  assert.equal(s.result,'B+353.5'); assert.throws(() => s.play(4,4));
  assert.match(s.board.sgf('', 'a]b'), /PB\[a\\\]b\]/); assert.match(s.board.sgf(), /;B\[dd\];W\[\];B\[\]/);
  assert.deepEqual(s.board.areaScore(7.5,[60]), [0,7.5]);
});
test('scoring requests, confirmations and result contract', () => {
  const s = new Session(), sent = [];
  s.gateway = { send: (command,payload) => sent.push([command,...game.unpack(payload)]), close(){} };
  s.uid = 42; s.color = 1; s.roomKey = {1:31000,2:63,3:23,4:202}; s.phase = 'playing';
  s.requestScore(); assert.equal(sent.at(-1)[1].one(1),301); assert.equal(sent.at(-1)[2].one(1),0);
  s.gameMessage(301,decode(encode({1:0})),new Map()); assert.equal(s.pending,false);
  for (const accept of [false,true]) {
    s.gameMessage(303,decode(encode({1:1})),new Map()); assert.equal(s.snapshot().confirmation,true); s.confirm(accept);
    assert.equal(sent.at(-1)[1].one(1),304); assert.equal(sent.at(-1)[2].one(1),Number(accept)); assert.equal(sent.at(-1)[2].one(2),1);
  }
  s.gameMessage(402,decode(encode({1:0,2:1,3:125,4:2})),new Map()); assert.equal(s.phase,'finished'); assert.equal(s.result,'B+'); s.close();
});

// Simulates two independent TCP byte streams, through the browser transport.
test('browser WebSocket transport: login, gateway, start before entry, play, pass, resume, resign', async () => {
  const Original = globalThis.WebSocket, requests = [];
  const room = {1:31000,2:63,3:23,4:202}, user = {1:42,6:1,7:1200,8:3,9:60}, rules = {1:19,6:1200,7:60,8:3};
  class FakeWebSocket extends EventTarget {
    static OPEN=1;
    constructor(url, protocols) {
      super(); this.url=new URL(url); this.readyState=0; this.bufferedAmount=0;
      assert.deepEqual(protocols,['tcp-proxy','a'.repeat(43)]);
      queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});
    }
    close(){this.readyState=3;queueMicrotask(()=>this.dispatchEvent(new Event('close')));}
    response(command, body) {
      const packet=frame(command,body,true);
      // Fragment a FOX packet independently of WebSocket message boundaries.
      for(const part of [packet.subarray(0,3),packet.subarray(3)]) queueMicrotask(()=>{
        if(this.readyState===1)this.dispatchEvent(new MessageEvent('message',{data:Uint8Array.from(part).buffer}));
      });
    }
    reply(service,op,body){this.response(26200,game.envelope(42,service,op,body,service===31000?63:1));}
    send(data){
      const [p]=decodeOne(Buffer.from(data));
      if(this.url.searchParams.get('port')==='10000') {
        const m=decode(p.payload);
        if(p.command===2000){assert.equal(m.text(7).length,12);this.response(2005,encode({1:0,2:42,8:Buffer.from('private-token')}));}
        else if(p.command===3000){const body=encode({1:0,3:[{1:1,21:'119.91.247.46',22:3001}]});this.response(3005,body);this.response(3005,body);}
        else if(p.command===3010)this.response(3015,encode({1:0}));
        return;
      }
      const [h,m]=game.unpack(p.payload), service=h.one(7), op=h.one(1); requests.push([service,op]);
      assert.equal(h.one(3),42);assert.equal(h.text(19),'11509231');
      if(service===20001&&op===1){assert.equal(m.text(1),'private-token');this.reply(service,op,{1:0});}
      else if(op===100008)this.reply(service,op,{1:0});
      else if(op===100150)this.reply(service,op,{1:[{1:101,2:19,3:1200,4:3,5:60,7:0,12:1}]});
      else if(op===100115)this.reply(service,op,{1:107004});
      else if(op===100130){assert.equal(m.one(1),101);this.reply(service,op,{1:0});this.reply(31000,107,{1:rules,6:23,7:202,9:[user]});this.reply(30006,100140,{1:0,2:31000,3:63,4:23,7:202});}
      else if(op===105)this.reply(service,op,{1:0});
      else if(op===201){assert.equal(m.sub(4).one(1),0);this.reply(service,op,{1:0});this.reply(service,203,{1:3,2:3,3:1,5:{1:1}});this.reply(service,203,{1:15,2:15,3:2,5:{1:2}});}
      else if(op===204){assert.equal(m.sub(1).one(1),2);this.reply(service,op,{1:0});this.reply(service,206,{2:{1:3}});}
      else if(op===501)this.reply(service,op,{1:0,2:rules,3:[user],4:[{1:1,2:3,3:3,4:1},{1:1,2:15,3:15,4:2},{1:2,4:1}],5:{1:3},6:3,7:23,10:202,12:31000,13:63});
      else if(op===311){assert.deepEqual(game.plain(m.sub(2)),room);this.reply(service,op,{1:0});this.reply(service,402,{1:0,2:2,3:-1,4:3});}
    }
  }
  globalThis.WebSocket=FakeWebSocket;
  const s=new Session({proxyUrl:'wss://example.com/proxy',proxyToken:'a'.repeat(43)});
  const wait=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}assert.fail(JSON.stringify(s.snapshot()));};
  try {
    s.login('test','password');await wait(()=>s.phase==='ready');assert.equal(s.servers.length,1);assert.ok(!JSON.stringify(s.snapshot()).includes('private-token'));
    s.match();await wait(()=>s.phase==='playing');assert.equal(s.color,1);
    s.play(3,3);await wait(()=>s.board.moves.length===2);assert.equal(s.sync,2);
    s.passTurn();await wait(()=>s.board.moves.length===3);s.send(31000,501,{},63);await wait(()=>s.status==='Fox game synchronized');
    assert.deepEqual(s.board.moves,[[1,3,3],[2,15,15],[1,null,null]]);s.resign();await wait(()=>s.phase==='finished');assert.equal(s.result,'W+R');assert.match(s.board.sgf(s.result),/RE\[W\+R\]/);
  } finally {s.close();globalThis.WebSocket=Original;}
});
test('late asynchronous login cannot overwrite a disconnected session', async () => {
  let resolve;let closed=false;
  const s=new Session({proxyUrl:'wss://example.com',proxyToken:'a'.repeat(43),connectionFactory:()=>new Promise(r=>{resolve=r;})});
  s.login('test','password');s.close();resolve({close(){closed=true;},send(){assert.fail('stale send');}});
  await new Promise(r=>setTimeout(r,0));assert.equal(closed,true);assert.equal(s.phase,'disconnected');
});
