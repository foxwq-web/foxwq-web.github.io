import { setupFoxGame } from './fox-game.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import { Board } from '../src/board.ts';
import { encode, decode, signed, readVarint } from '../src/wire.ts';
import { encode as frame, decodeOne, gatewayPayload, splitGateway } from '../src/framing.ts';
import { Session, loginRequest } from '../src/session.ts';
import * as game from '../src/game.ts';

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
test('login profile is available before matchmaking and follows the current player', () => {
  const s = new Session();
  s.connection = { send() {}, close() {} };
  s.receive(s.generation, { command: 2005, payload: encode({
    1: 0, 2: 42, 3: { 1: 42, 2: 'account', 3: 'StoneRiver', 4: 20 }, 8: 'token',
  }) });
  try {
    assert.deepEqual(s.snapshot().account, { name: 'StoneRiver', rank: '3d' });
    assert.deepEqual(s.players, {});
    s.readPlayer(decode(encode({ 1: 43, 3: 'Opponent', 4: 18, 6: 1 })));
    assert.deepEqual(s.snapshot().account, { name: 'StoneRiver', rank: '3d' });
    s.readPlayer(decode(encode({ 1: 42, 3: 'StoneRiver', 4: 21, 6: 2 })));
    assert.deepEqual(s.snapshot().account, { name: 'StoneRiver', rank: '4d' });
  } finally {
    s.close();
  }
});
test('Fox credential rejection shows a login error and stops authentication', () => {
  const s = new Session();
  const sent = [];
  let closed = false;
  s.connection = { send: (...args) => sent.push(args), close: () => { closed = true; } };
  s.phase = 'authenticating';
  s.receive(s.generation, { command: 2005, payload: encode({ 1: 111231 }) });
  assert.equal(s.phase, 'error');
  assert.equal(s.status, 'incorrect credentials');
  assert.equal(s.uid, 0);
  assert.equal(s.token.length, 0);
  assert.equal(closed, true);
  assert.deepEqual(sent, []);
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
test('capture, suicide, ko, passes and SGF escaping', () => {
  const board = new Board();
  for (const [x,y] of [[1,0],[0,1],[2,1]]) board.play(x,y,1);
  board.play(1,1,2); board.play(1,2,1); assert.equal(board.stones[20],0); assert.equal(board.captures[1],1);
  assert.throws(() => board.play(1,1,2), /suicide/);
  const ko = new Board();
  for (const [x,y] of [[0,1],[1,0],[2,1]]) ko.play(x,y,1);
  for (const [x,y] of [[1,1],[0,2],[2,2],[1,3]]) ko.play(x,y,2);
  ko.play(1,2,1); assert.throws(() => ko.play(1,1,2), /ko/); ko.passTurn(2); ko.passTurn(1); ko.play(1,1,2); assert.equal(ko.stones[39],0);
  const recorded = new Board(); recorded.play(3,3); recorded.passTurn(); recorded.passTurn();
  assert.match(recorded.sgf('', 'a]b'), /PB\[a\\\]b\]/); assert.match(recorded.sgf(), /;B\[dd\];W\[\];B\[\]/);
});
function countingSession() {
  const s = new Session(), sent = [];
  s.gateway = { send: (command, payload) => sent.push([command, ...game.unpack(payload)]), close() {} };
  s.uid = 42; s.color = 1; s.roomKey = { 1: 31000, 2: 63, 3: 23, 4: 202 }; s.phase = 'playing';
  return { s, sent, notify: (op, fields) => s.gameMessage(op, decode(encode(fields)), new Map()) };
}
test('counting request uses the game node, blocks duplicate requests and recovers from rejection', () => {
  const { s, sent, notify } = countingSession();
  s.requestCounting();
  assert.equal(sent.at(-1)[0], 26200); assert.equal(sent.at(-1)[1].one(1), 301);
  assert.equal(sent.at(-1)[1].one(7), 31000); assert.equal(sent.at(-1)[1].one(8), 63);
  assert.equal(sent.at(-1)[2].one(1), 0);
  assert.throws(() => s.requestCounting(), /already active/);
  notify(301, { 1: 0 }); assert.equal(s.pending, false); assert.equal(s.counting, true);
  assert.throws(() => s.play(3, 3), /confirmation/); assert.throws(() => s.passTurn(), /confirmation/);
  notify(306, { 1: false, 2: 1 }); assert.equal(s.counting, false); assert.equal(s.phase, 'playing');
  s.requestCounting(); notify(301, { 1: -1 }); assert.equal(s.counting, false); assert.equal(s.pending, false);
  s.close(); assert.throws(() => s.requestCounting(), /No active/);
});
test('confirmed moves clear stale pass and rejection status', () => {
  for (const status of ['Opponent passed', 'Action 201 rejected: 1']) {
    const { s, notify } = countingSession();
    s.status = status;
    notify(203, { 1: 3, 2: 3, 3: 1 });
    assert.equal(s.status, '');
    assert.equal(s.board.turn, 2);
    s.close();
  }
});
test('counting outside your turn never sends a request', () => {
  const { s, sent } = countingSession();
  try {
    s.board.turn = 3 - s.color;
    const before = sent.length;
    assert.throws(() => s.requestCounting(), /Wait for your turn/);
    assert.equal(sent.length, before);
    assert.equal(s.pending, false);
    assert.equal(s.counting, false);
  } finally { s.close(); }
});
test('passing on your turn leaves an incoming counting request available to answer', () => {
  const { s, sent, notify } = countingSession();
  try {
    notify(303, { 1: 0, 2: 1 });
    const confirmation = structuredClone(s.pendingConfirmation);
    s.passTurn();
    assert.equal(sent.at(-1)[1].one(1), 204);
    assert.equal(s.pending, true);
    assert.deepEqual(s.pendingConfirmation, confirmation);
  } finally { s.close(); }
});
test('both counting confirmation stages reply with their own mode; only Fox ends the game', () => {
  const { s, sent, notify } = countingSession();
  for (const mode of [1, 2]) for (const accept of [false, true]) {
    notify(303, { 1: 0, 2: mode, 8: 2 });
    assert.equal(s.snapshot().confirmationKind, mode === 1 ? 'counting-request' : 'counting-result');
    s.confirm(accept);
    assert.equal(sent.at(-1)[1].one(1), 304); assert.equal(sent.at(-1)[1].one(8), 63);
    assert.equal(sent.at(-1)[2].one(1), Number(accept)); assert.equal(sent.at(-1)[2].one(2), mode);
    assert.equal(s.snapshot().confirmation, false); assert.equal(s.phase, 'playing');
    assert.throws(() => s.confirm(accept), /No pending/);
    notify(304, { 1: 0 }); assert.equal(s.counting, accept);
    notify(306, { 1: accept, 2: mode });
    assert.equal(s.counting, accept); assert.equal(s.phase, 'playing');
  }
  notify(303, { 1: 0, 2: 2 });
  notify(402, { 1: 0, 2: 1, 3: 125, 4: 2 });
  assert.equal(s.phase, 'finished'); assert.equal(s.result, 'B+2.5');
  assert.equal(s.snapshot().confirmation, false); assert.equal(s.counting, false);
  notify(303, { 1: 0, 2: 1 }); assert.equal(s.snapshot().confirmation, false);
  s.close();
});
test('final results decode Fox hundredths of zi to points for either winner', () => {
  for (const op of [402, 403, 405]) {
    for (const [winner, value, result] of [
      [1, 125, 'B+2.5'], [2, 1225, 'W+24.5'],
      [1, 50, 'B+1'], [2, 75, 'W+1.5'],
      [1, -1, 'B+'], [2, undefined, 'W+'],
    ]) {
      const { s, notify } = countingSession();
      try {
        notify(op, { 1: 0, 2: winner, ...(value === undefined ? {} : { 3: value }), 4: 2 });
        assert.equal(s.result, result);
        assert.equal(s.status, `Result: ${result}`);
        assert.equal(s.phase, 'finished');
        assert.ok(s.board.sgf(s.result).includes(`RE[${result}]`));
      } finally { s.close(); }
    }
  }
});
test('counting errors do not open a dialog, failed answers can be retried, disconnect clears dialogs', () => {
  const { s, notify } = countingSession();
  notify(303, { 1: -1, 2: 1 }); assert.equal(s.snapshot().confirmation, false);
  notify(303, { 1: 0, 2: 99 }); assert.equal(s.snapshot().confirmation, false);
  notify(303, { 1: 0, 2: 2 }); s.confirm(true); notify(304, { 1: -1 });
  assert.equal(s.snapshot().confirmationKind, 'counting-result');
  s.confirm(false); notify(306, { 1: false, 2: 2 });
  assert.equal(s.counting, false); assert.equal(s.pending, false);
  notify(303, { 1: 0, 2: 1 }); s.close();
  assert.equal(s.snapshot().confirmation, false); assert.equal(s.counting, false);
});
test('counting result decodes the float area and server winner without using final-result margin', () => {
  const count = Buffer.alloc(4); count.writeFloatLE(185.5);
  const m = decode(Buffer.concat([encode({ 1: 0, 2: 2, 8: 1 }), Buffer.from([0x35]), count]));
  assert.deepEqual(game.countingResult(m), { winner: 'Black wins', black: 185.5, white: 175.5, komi: 7.5 });
  assert.deepEqual(game.countingResult(decode(encode({ 8: 3 }))), { winner: 'Draw' });
  count.writeFloatLE(NaN);
  assert.deepEqual(game.countingResult(decode(Buffer.concat([Buffer.from([0x35]), count]))), { winner: null });
});


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
    s.passTurn();await wait(()=>s.board.moves.length===3);s.send(31000,501,{},63);await wait(()=>s.status==='Game synchronized');
    assert.deepEqual(s.board.moves,[[1,3,3],[2,15,15],[1,null,null]]);s.resign();await wait(()=>s.phase==='finished');assert.equal(s.result,'W+R');assert.match(s.board.sgf(s.result),/RE\[W\+R\]/);
  } finally {s.close();globalThis.WebSocket=Original;}
});
test('late asynchronous login cannot overwrite a disconnected session', async () => {
  let resolve;let closed=false;
  const s=new Session({proxyUrl:'wss://example.com',proxyToken:'a'.repeat(43),connectionFactory:()=>new Promise(r=>{resolve=r;})});
  s.login('test','password');s.close();resolve({close(){closed=true;},send(){assert.fail('stale send');}});
  await new Promise(r=>setTimeout(r,0));assert.equal(closed,true);assert.equal(s.phase,'disconnected');
});

test('online placement is immediate, confirmation is silent, and rejection restores captures and clocks', () => {
  const sounds = [], s = new Session({ onSound: name => sounds.push(name) });
  s.gateway = { send() {}, close() {} }; s.phase = 'playing'; s.color = 1; s.uid = 42;
  s.roomKey = { 1: 31000, 2: 63 }; s.clocks = { 1: { main: 60, periods: 3, byoyomi: 60, at: Date.now() / 1000 } };
  for (const [x, y] of [[1, 0], [0, 1], [2, 1]]) s.board.play(x, y, 1);
  s.board.play(1, 1, 2);
  const before = s.board.clone(), clocks = structuredClone(s.clocks);
  s.play(1, 2);
  assert.equal(s.board.stones[20], 0); assert.equal(s.board.captures[1], 1);
  assert.equal(s.pending, true); assert.deepEqual(sounds, ['stone-capture-small']);
  assert.throws(() => s.play(5, 5));
  s.gameMessage(201, decode(encode({ 1: 7 })));
  assert.deepEqual(s.board, before); assert.deepEqual(s.clocks, clocks); assert.equal(s.pending, false);
  s.play(1, 2);
  s.gameMessage(201, decode(encode({ 1: 0 })));
  assert.equal(s.pending, true);
  s.gameMessage(203, decode(encode({ 1: 1, 2: 2, 3: 1, 5: { 1: 9 } })));
  assert.equal(s.board.moves.length, before.moves.length + 1); assert.equal(s.sync, 9);
  assert.equal(s.pending, false); assert.deepEqual(sounds, ['stone-capture-small', 'stone-capture-small']);
  s.gameMessage(203, decode(encode({ 1: 15, 2: 15, 3: 2 })));
  assert.deepEqual(sounds, ['stone-capture-small', 'stone-capture-small', 'stone']); s.close();
});

test('send failure leaves board untouched; close undoes an unconfirmed move', () => {
  const s = new Session(); s.phase = 'playing'; s.color = 1; s.roomKey = { 1: 31000, 2: 63 };
  s.gateway = { send() { throw Error('closed'); }, close() {} };
  assert.throws(() => s.play(3, 3), /closed/); assert.equal(s.board.moves.length, 0); assert.equal(s.pending, false);
  s.gateway.send = () => {}; s.play(3, 3); s.close(); assert.equal(s.board.moves.length, 0);
});

test('countdown notifications populate the correct player clock', () => {
  const s = new Session(); s.uid = 42; s.color = 2; s.phase = 'playing';
  s.gameMessage(108, decode(encode({ 2: 0, 3: 2, 4: 10, 5: 42 })));
  assert.equal(s.clocks[2].main, 0); assert.equal(s.clocks[2].periods, 2); assert.equal(s.clocks[2].byoyomi, 10);
  s.gameMessage(108, decode(encode({ 2: 60, 3: 3, 4: 60, 5: 99 })));
  assert.equal(s.clocks[1].main, 60);
});

test('authoritative synchronization replaces an optimistic move without replaying sounds', () => {
  const sounds = [], s = new Session({ onSound: name => sounds.push(name) });
  s.uid = 42; s.color = 1; s.phase = 'playing'; s.roomKey = { 1: 31000, 2: 63 };
  s.gateway = { send() {}, close() {} }; s.play(3, 3);
  s.gameMessage(501, decode(encode({ 1: 0, 3: [{ 1: 42, 6: 1, 7: 1200, 8: 3, 9: 60 }],
    4: [{ 1: 1, 2: 3, 3: 3, 4: 1 }], 5: { 1: 4 }, 6: 3, 12: 31000, 13: 63 })));
  assert.equal(s.pendingMove, null); assert.equal(s.pending, false); assert.equal(s.sync, 4);
  assert.deepEqual(s.board.moves, [[1, 3, 3]]); assert.deepEqual(sounds, ['stone']); s.close();
});

test('discovery waits for the game-lock check in either response order', () => {
  const fields = decode(encode({1:[{1:101,2:19,3:1200,4:3,5:60,7:0,12:1}]}));
  for (const order of [[100150,100115],[100115,100150]]) {
    const s = new Session(); s.phase = 'gateway';
    s.roomMessage(order[0], order[0] === 100150 ? fields : decode(encode({1:107004})));
    assert.equal(s.phase, 'gateway');
    assert.throws(() => s.match(), /wait for server discovery/);
    s.roomMessage(order[1], order[1] === 100150 ? fields : decode(encode({1:107004})));
    assert.equal(s.phase, 'ready'); s.close();
  }
});

test('existing game skips ready and matchmaking, even when field discovery arrives first', () => {
  const fields = decode(encode({1:[{1:101,2:19,3:1200,4:3,5:60,7:0,12:1}]}));
  for (const order of [[100150,100115],[100115,100150]]) {
    const s = new Session(), sent = [];
    s.phase = 'gateway'; s.uid = 42;
    s.gateway = {send(command, payload) { sent.push(game.unpack(payload)); }, close() {}};
    for (const op of order) {
      s.roomMessage(op, op === 100150 ? fields : decode(encode({1:0,2:game.GAME,3:63})));
      assert.notEqual(s.phase, 'ready');
    }
    assert.equal(s.phase, 'resuming');
    assert.equal(sent[0][0].one(1), 501);
    s.gameMessage(501, decode(encode({1:0,3:[{1:42,6:1}],4:[{1:1,2:3,3:3,4:1}],5:{1:1},6:3,7:23,10:202,12:31000,13:63})), new Map());
    assert.equal(s.phase, 'playing'); assert.equal(s.color, 1); assert.equal(s.board.stones[60], 1);
    assert.ok(!sent.some(([h]) => h.one(1) === 100130)); s.close();
  }
});


test('finished synchronization clears counting and a new match starts without stale confirmations', () => {
  const { s, notify } = countingSession();
  notify(303, { 1: 0, 2: 2 });
  s.confirm(true);
  notify(501, { 1: 0, 3: [{ 1: 42, 6: 1 }], 6: 5 });
  assert.equal(s.phase, 'finished');
  assert.equal(s.snapshot().confirmation, false);
  assert.equal(s.counting, false);
  assert.equal(s.countingAnswer, null);

  s.counting = true; s.countingAnswer = { accept: true }; s.pendingConfirmation = ['counting-result'];
  s.fieldId = 101;
  s.match();
  assert.equal(s.phase, 'matching');
  assert.equal(s.snapshot().confirmation, false);
  assert.equal(s.counting, false);
  assert.equal(s.countingAnswer, null);
  s.close();
});

test('Fox time controls are discovered dynamically and the selected field is sent for matchmaking', () => {
  const s = new Session(), sent = [];
  s.phase = 'gateway'; s.gameLockChecked = true;
  s.gateway = { send: (command, payload) => sent.push(game.unpack(payload)), close() {} };
  const field = (id, main, periods = 3, byoyomi = 30, extra = {}) => ({1:id,2:19,3:main,4:periods,5:byoyomi,7:0,12:1,...extra});
  s.roomMessage(100150, decode(encode({1:[field(101,1200,3,60),field(102,300),field(103,0,5),field(104,600,3,30,{2:9}),field(105,600,3,30,{7:1}),field(106,600,3,30,{12:2}),field(107,-1),field(102,300)]})));
  assert.equal(s.phase, 'ready');
  assert.deepEqual(s.snapshot().matchFields.map(f => f.id), [103,102,101]);
  assert.equal(s.fieldId, 101);
  s.selectMatchField(102); assert.equal(s.snapshot().time, '5m30s');
  assert.throws(() => s.selectMatchField(999), /No time control available/);
  s.match();
  assert.equal(sent.at(-1)[0].one(1), 100130);
  assert.equal(sent.at(-1)[1].one(1), 102); assert.equal(sent.at(-1)[1].one(2), 0);
  assert.throws(() => s.selectMatchField(101), /cannot change/);
  const before = s.snapshot(), sentBefore = sent.length;
  for (const op of [100135, 100143, 100146]) {
    s.roomMessage(op, decode(encode({1:7,2:{1:19,6:1200,8:3,7:60}})));
    assert.deepEqual(s.snapshot(), before);
    assert.equal(sent.length, sentBefore);
    assert.throws(() => s.confirm(true), /No pending confirmation/);
  }
  s.roomMessage(100139, decode(encode({})));
  s.selectMatchField(103); assert.equal(s.snapshot().time, '30s');
  s.close(); assert.deepEqual(s.snapshot().matchFields, []);
});

test('match discovery supports missing default and empty configuration without starting a search', () => {
  const s = new Session(); s.phase = 'gateway'; s.gameLockChecked = true;
  s.roomMessage(100150, decode(encode({1:[{1:207,2:19,3:600,4:3,5:30,7:0,12:1}]})));
  assert.equal(s.fieldId, 207); assert.equal(s.phase, 'ready');
  s.close(); s.phase = 'gateway'; s.gameLockChecked = true;
  s.roomMessage(100150, decode(encode({})));
  assert.equal(s.phase, 'ready'); assert.equal(s.fieldId, null);
  assert.equal(s.status, 'No time controls available');
  assert.throws(() => s.match(), /discovery/); s.close();
});

test('remembered time controls survive changed field IDs and fall back when unavailable', () => {
  const preferredTimeControl = { size: 19, main: 300, periods: 3, byoyomi: 30 };
  const s = new Session({ preferredTimeControl });
  s.phase = 'gateway'; s.gameLockChecked = true;
  const discover = fields => s.roomMessage(100150, decode(encode({ 1: fields.map(([id, main, byoyomi]) => ({ 1:id, 2:19, 3:main, 4:3, 5:byoyomi, 7:0, 12:1 })) })));
  discover([[201,1200,60],[202,300,30]]);
  assert.equal(s.fieldId, 202);
  s.selectMatchField(201);

  s.fieldId = null;
  discover([[301,1200,60],[302,300,30]]);
  assert.equal(s.fieldId, 301);
  s.fieldId = null;
  s.preferredTimeControl = preferredTimeControl;
  discover([[401,1200,60],[402,600,30]]);
  assert.equal(s.fieldId, 401);
  s.fieldId = null;
  discover([]);
  assert.equal(s.fieldId, null);
  assert.deepEqual(s.preferredTimeControl, preferredTimeControl);
  s.close();
});

test('field populations follow field IDs in either discovery order and reset on disconnect', () => {
  const population = decode(encode({1:0,2:[{1:102,2:27},{1:101,2:0},{1:999,2:8},{1:103,2:-1}]}));
  const config = decode(encode({1:[{1:101,2:19,3:1200,4:3,5:60,7:0,12:1},{1:102,2:19,3:300,4:3,5:30,7:0,12:1}]}));
  for (const order of [[100145,100150],[100150,100145]]) {
    const s = new Session(); s.phase = 'gateway'; s.gameLockChecked = true;
    for (const op of order) s.roomMessage(op, op === 100145 ? population : config);
    assert.deepEqual(s.snapshot().fieldPlayers, {101:0,102:27,999:8});
    assert.equal(s.phase, 'ready'); assert.equal(s.fieldId, 101);
    s.selectMatchField(102);
    s.roomMessage(100145, decode(encode({1:0,2:[{1:102,2:1}]})));
    assert.deepEqual(s.snapshot().fieldPlayers, {102:1}); assert.equal(s.fieldId, 102);
    s.roomMessage(100145, decode(encode({1:-1})));
    assert.deepEqual(s.snapshot().fieldPlayers, {102:1});
    s.close(); assert.deepEqual(s.snapshot().fieldPlayers, {});
  }
});

test('field populations refresh every 25 seconds in matchmaking and stop during a game', () => {
  const s = new Session(), sent = [];
  s.gateway = {send: (command,payload) => sent.push(game.unpack(payload)),close(){}};
  s.phase = 'ready'; s.fieldPlayersRequestedAt = 1000;
  s.refreshFieldPlayers(25999); assert.equal(sent.length, 0);
  s.refreshFieldPlayers(26000); assert.equal(sent.length, 1);
  assert.equal(sent[0][0].one(7), game.ROOM); assert.equal(sent[0][0].one(1), 100145);
  assert.equal(sent[0][1].size, 0);
  s.refreshFieldPlayers(26001); assert.equal(sent.length, 1);
  s.phase = 'matching'; s.refreshFieldPlayers(51000); assert.equal(sent.length, 2);
  s.phase = 'playing'; s.refreshFieldPlayers(76000); assert.equal(sent.length, 2);
  s.close(); s.refreshFieldPlayers(101000); assert.equal(sent.length, 2);
});

test('quitting an active room waits for Fox resignation, then returns to matchmaking without disconnecting', () => {
  const {s, sent, notify} = countingSession();
  s.fieldId = 101; s.fieldsLoaded = true; s.gameLockChecked = true;
  s.matchFields = [{id:101,size:19,main:1200,periods:3,byoyomi:60}];
  s.token = Buffer.from('session'); const gateway = s.gateway, generation = s.generation;
  s.quitRoom();
  assert.equal(sent.at(-1)[1].one(1), 311); assert.equal(sent.at(-1)[1].one(8), 63);
  assert.deepEqual(game.plain(sent.at(-1)[2].sub(2)), {1:31000,2:63,3:23,4:202});
  assert.equal(s.phase, 'playing'); assert.equal(s.snapshot().quitRequested, true);
  assert.throws(() => s.quitRoom(), /Waiting to confirm/);
  notify(311, {1:0}); assert.equal(s.phase, 'playing');
  notify(402, {1:0,2:2,3:-1,4:3});
  assert.equal(s.phase, 'ready'); assert.equal(s.result, 'W+R'); assert.equal(s.gameOver, true);
  assert.equal(s.gateway, gateway); assert.equal(s.generation, generation); assert.equal(s.token.toString(), 'session');
  assert.deepEqual(s.roomKey, {}); assert.equal(s.color, 0); assert.equal(s.quitRequested, false);

  notify(501, {1:0,3:[{1:42,6:1}],6:3,12:31000,13:63});
  notify(403, {1:0,2:2,4:3});
  s.roomMessage(100140, decode(encode({1:0,2:31000,3:63,4:23,7:202})));
  assert.equal(s.phase, 'ready'); assert.deepEqual(s.roomKey, {});
  s.match(); assert.equal(s.phase, 'matching'); assert.equal(sent.at(-1)[1].one(1), 100130);
  s.gameMessage(107, decode(encode({6:24,7:203,9:[{1:42,6:1}]})), decode(encode({8:63}))); assert.equal(s.phase, 'playing');
  s.roomMessage(100130, decode(encode({1:0}))); assert.equal(s.phase, 'playing');
  s.roomMessage(100139, decode(encode({1:0}))); assert.equal(s.phase, 'playing');
  s.close(); assert.equal(s.phase, 'disconnected'); assert.deepEqual(s.roomKey, {}); assert.equal(s.color, 0);
});

test('finished rooms quit immediately; rejected or failed resignation stays in the game', () => {
  const {s, notify} = countingSession();
  s.gateway.send = () => {throw Error('Send failed');};
  assert.throws(() => s.quitRoom(), /Send failed/); assert.equal(s.phase, 'playing'); assert.equal(s.quitRequested, false);
  s.gateway.send = () => {};
  s.quitRoom(); notify(311, {1:-1});
  assert.equal(s.phase, 'playing'); assert.equal(s.quitRequested, false); assert.equal(s.pending, false);
  s.quitRoom(); notify(501, {1:0,3:[{1:42,6:1}],6:3,7:23,10:202,12:31000,13:63});
  assert.equal(s.phase, 'playing'); assert.equal(s.quitRequested, false);
  s.quitRoom(); notify(501, {1:0,3:[{1:42,6:1}],6:5,7:23,10:202,12:31000,13:63});
  assert.equal(s.phase, 'ready'); assert.equal(s.gameOver, true);
  s.phase = 'finished'; s.roomKey = {1:31000,2:63}; s.color = 1;
  s.quitRoom(); assert.equal(s.phase, 'ready'); assert.deepEqual(s.roomKey, {});
  assert.throws(() => s.quitRoom(), /No room to quit/); s.close();
});

test('a failed matchmaking send preserves the finished game screen and result', () => {
  const {s, notify} = countingSession();
  notify(402, {1:0,2:2,4:3}); s.fieldId = 101;
  s.gateway.send = () => {throw Error('Send failed');};
  assert.throws(() => s.match(), /Send failed/);
  assert.equal(s.phase, 'finished'); assert.equal(s.result, 'W+R');
  assert.equal(s.color, 1); assert.equal(s.gameOver, true); assert.notDeepEqual(s.roomKey, {});
  s.close();
});

test('game start announces once, including starting as White, while synchronization and restoration stay silent', () => {
  const sounds = [], s = new Session({onSound:name=>sounds.push(name)});
  s.uid = 42; s.phase = 'matching';
  const header = decode(encode({8:63}));
  const start = decode(encode({1:{7:30},6:23,7:202,9:[{1:42,6:2,7:300,8:3,9:30}]}));
  s.gameMessage(107, start, header); s.gameMessage(107, start, header);
  assert.deepEqual(sounds, ['start-play']); assert.equal(s.color, 2); assert.equal(s.clocks[2].periodLength, 30);
  const env = decode(encode({1:0,2:{7:30},3:[{1:42,6:2,7:300,8:3,9:10}],6:3,7:23,10:202,12:31000,13:63}));
  s.gameMessage(501, env, header); assert.deepEqual(sounds, ['start-play']);
  s.gameMessage(108, decode(encode({2:0,3:2,4:10,5:42})), header); assert.equal(s.clocks[2].periodLength, 30);
  s.close(); s.uid = 42; s.phase = 'resuming';
  s.gameMessage(501, env, header); s.gameMessage(107, start, header);
  assert.deepEqual(sounds, ['start-play']);
  s.close(); s.uid = 42; s.phase = 'joining';
  s.gameMessage(501, env, header); s.gameMessage(107, start, header);
  assert.deepEqual(sounds, ['start-play','start-play']); s.close();
});

const koSequence = [[0,1],[1,1],[1,0],[0,2],[2,1],[2,2],[10,10],[1,3],[1,2]];
const suicideSequence = [[1,0],[10,10],[0,1],[11,10],[2,1],[12,10],[1,2]];
function position(sequence) {
  const board = new Board();
  for (const [x,y] of sequence) board.play(x,y);
  return board;
}

test('ko and suicide validation are immutable, including the former authoritative bypass', () => {
  for (const [sequence, point, reason] of [[koSequence,[1,1],/ko/],[suicideSequence,[1,1],/suicide/]]) {
    const board = position(sequence), before = structuredClone(board);
    assert.throws(()=>board.checkMove(...point),reason);
    assert.throws(()=>board.play(...point),reason);
    assert.throws(()=>board.play(...point,board.turn,true),reason);
    assert.deepEqual(structuredClone(board),before);
  }
});

test('illegal online moves cannot change stones, history, clocks, play audio, or send a packet', () => {
  for (const [sequence, reason] of [[koSequence,/ko/],[suicideSequence,/suicide/]]) {
    const sent = [], sounds = [], s = new Session({onSound:name=>sounds.push(name)});
    s.board = position(sequence); s.phase = 'playing'; s.color = s.board.turn;
    s.roomKey = {1:31000,2:63,3:23,4:202};
    s.clocks = {2:{main:120,periods:3,byoyomi:60,at:Date.now()/1000}};
    s.gateway = {send:(...args)=>sent.push(args),close(){}};
    const before = structuredClone(s.board), clocks = structuredClone(s.clocks);
    assert.throws(()=>s.play(1,1),reason);
    assert.deepEqual(structuredClone(s.board),before); assert.deepEqual(s.clocks,clocks);
    assert.equal(s.pending,false); assert.equal(s.pendingMove,null);
    assert.deepEqual(sent,[]); assert.deepEqual(sounds,[]); s.close();
  }
});

test('ko remains illegal after confirmed captures and reconnecting, but recapture after a ko threat is legal', () => {
  const sent = [], s = new Session(); s.phase = 'playing'; s.uid = 42; s.color = 2;
  s.board = position(koSequence.slice(0,-1)); s.roomKey = {1:31000,2:63,3:23,4:202};
  s.gateway = {send:(...args)=>sent.push(args),close(){}};
  s.gameMessage(203,decode(encode({1:1,2:2,3:1,5:{1:1}})),new Map());
  assert.throws(()=>s.play(1,1),/ko/); assert.equal(sent.length,0);
  const env = decode(encode({1:0,3:[{1:42,6:2}],4:koSequence.map(([x,y],i)=>({1:1,2:x,3:y,4:i%2+1})),6:3,7:23,10:202,12:31000,13:63}));
  s.phase = 'resuming'; s.gameMessage(501,env,new Map());
  assert.throws(()=>s.play(1,1),/ko/); assert.equal(sent.length,0);

  s.board.play(15,15); s.board.play(16,15); s.play(1,1);
  assert.equal(sent.length,1); assert.equal(s.board.stones[20],2); assert.equal(s.board.stones[39],0); s.close();
});

test('capturing to gain a liberty is legal even when the intersection starts surrounded', () => {
  const board = new Board(5);
  for (const [x,y] of [[2,0],[1,1],[3,1],[0,2],[4,2],[1,3],[3,3],[2,4]]) board.play(x,y,1);
  for (const [x,y] of [[2,1],[1,2],[3,2],[2,3]]) board.play(x,y,2);
  const before = structuredClone(board), candidate = board.checkMove(2,2,1);
  assert.deepEqual(structuredClone(board),before); assert.equal(candidate.captures,4);
  board.play(2,2,1); assert.equal(board.stones[12],1); assert.equal(board.captures[1],4);
});


test('session updates are coalesced and expose the completed command and packet state', async () => {
  const updates = [];
  const s = new Session({ onChange: state => updates.push(state) });
  setupFoxGame(s);
  s.play(3, 3);
  assert.equal(updates.length, 0);
  await Promise.resolve();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].moves, 1);
  s.changed();
  await Promise.resolve();
  assert.equal(updates.length, 1);
  s.phase = 'playing'; s.color = 1;
  s.gameMessage(108, decode(encode({1:2,2:45,3:3,4:20,5:true})), new Map());
  await Promise.resolve();
  assert.equal(updates.length, 2);
  assert.equal(updates[1].clocks[2].main, 45);
  s.close();
  await Promise.resolve();
  assert.equal(updates.at(-1).phase, 'disconnected');
});


test('player names and ranks follow their colors through game start and restoration', () => {
  const s = new Session();
  s.phase = 'joining'; s.uid = 42;
  const users = [
    {1:42,2:'account-one',3:'棋手一',4:20,6:1,7:300,8:3,9:30},
    {1:43,2:'BambooMoon',4:17,6:2,7:300,8:3,9:30}
  ];
  s.gameMessage(107, decode(encode({6:23,7:202,9:users})), decode(encode({8:63})));
  assert.deepEqual(s.snapshot().players, {
    1:{id:42,name:'棋手一',rank:'3d'}, 2:{id:43,name:'BambooMoon',rank:'1k'}
  });
  s.gameMessage(501, decode(encode({1:0,3:[{...users[1],6:1,4:18},{...users[0],6:2,4:21}],6:3,7:23,10:202,12:31000,13:63})), new Map());
  assert.equal(s.color, 2);
  assert.deepEqual(s.snapshot().players, {
    1:{id:43,name:'BambooMoon',rank:'1d'}, 2:{id:42,name:'棋手一',rank:'4d'}
  });
  s.gameMessage(501, decode(encode({1:0,3:[{1:43,6:1},{1:42,6:2}],6:5,7:23,10:202,12:31000,13:63})), new Map());
  assert.equal(s.snapshot().players[2].name, '棋手一');
  s.gateway = {send(){},close(){}}; s.fieldId = 101; s.match();
  assert.deepEqual(s.snapshot().players, {});
  s.close();
});

test('rank labels cover kyu, dan, professional and unavailable ranks', () => {
  for (const [rank, label] of [[0,'18k'],[17,'1k'],[18,'1d'],[26,'9d'],[27,'1p'],[35,'9p'],[-1,''],[100,''],[null,'']]) {
    assert.equal(game.rankLabel(rank), label);
  }
});

test('time controls use compact minute and byoyomi notation', () => {
  assert.equal(game.timeLabel({main:60,periods:3,byoyomi:20}), '1m20s');
  assert.equal(game.timeLabel({main:45,periods:0,byoyomi:0}), '45s');
  assert.equal(game.timeLabel({main:0,periods:5,byoyomi:30}), '30s');
});


test('resignation can follow an unconfirmed placement and remains pending after its reply', () => {
  for (const rejected of [false, true]) {
    const s = new Session(), sent = [];
    try {
      s.gateway = {send(service, payload) { sent.push(game.unpack(payload)[0].number(1)); }, close() {}};
      s.phase = 'playing'; s.color = 1; s.roomKey = {1: 31000, 2: 63};
      s.play(3, 3); s.resign();
      assert.deepEqual(sent, [201, 311]);
      assert.equal(s.snapshot().pendingMove, false);
      assert.throws(() => s.resign(), /Waiting to confirm/);
      s.gameMessage(rejected ? 201 : 203, decode(encode(rejected ? {1: 7} : {1: 3, 2: 3, 3: 1})));
      assert.equal(s.pending, true);
      assert.throws(() => s.resign(), /Waiting to confirm/);
      s.gameMessage(311, decode(encode({1: 7})));
      assert.equal(s.pending, false);
    } finally { s.close(); }
  }
});


test('a rejected resignation preserves a placement still awaiting confirmation', () => {
  const s = new Session();
  try {
    s.gateway = {send() {}, close() {}};
    s.phase = 'playing'; s.color = 1; s.roomKey = {1: 31000, 2: 63};
    s.play(3, 3); s.resign();
    s.gameMessage(311, decode(encode({1: 7})));
    assert.equal(s.pending, true);
    assert.equal(s.snapshot().pendingMove, true);
    assert.equal(s.board.stones[3 * 19 + 3], 1);
    s.gameMessage(203, decode(encode({1: 3, 2: 3, 3: 1})));
    assert.equal(s.pending, false);
    assert.equal(s.board.moves.length, 1);
  } finally { s.close(); }
});
