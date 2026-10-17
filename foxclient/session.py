"""Explicit login state machine reconstructed from 0072edd0 / 008719c0.

Gateway routing, normal-field discovery, moves, passing and resumption were
verified with a live Fox session. Protocol evidence is documented in docs/.
"""
import hashlib
from pathlib import Path
import threading
import uuid
import time
from . import game
from .board import Board
from .transport import Connection
from .wire import encode, decode, signed


def read_credentials(path):
    lines = Path(path).read_text(encoding='utf-8-sig').splitlines()
    if len(lines) != 2 or not all(lines):
        raise ValueError('Credential file must contain username and password on two lines')
    return lines


def login_request(username, password, mac=None):
    return encode({1: username, 2: 'foxwq',
                   3: hashlib.md5(password.encode('utf-8')).hexdigest(),
                   4: 8, 5: 11509231, 6: False,
                   7: mac or f'{uuid.getnode():012X}', 9: False})


class Session:
    def __init__(self, credential_path='creds', endpoint=('43.132.13.39', 10000)):
        self.credential_path, self.endpoint = credential_path, endpoint
        self.lock = threading.RLock()
        self.connection = None
        self.timer = None
        self.status = 'Disconnected'
        self.phase = 'disconnected'
        self.board = Board()
        self.mode = 'fox'
        self.result = ''
        self.uid = 0
        self.token = b''
        self.generation = 0
        self.servers = []
        self.gateway = None
        self.field_id = None
        self.room_key = {}
        self.color = 0
        self.sync = 0
        self.pending = False
        self.clocks = {}
        self.trace_dir = None
        self.pending_confirmation = None
        self.events = []

    def event(self, message):
        self.events.append(message)
        self.events = self.events[-30:]

    def snapshot(self):
        with self.lock:
            return dict(phase=self.phase, status=self.status, mode=self.mode,
                        stones=self.board.stones.copy(), turn=self.board.turn,
                        captures=self.board.captures.copy(), passes=self.board.passes,
                        moves=len(self.board.moves), result=self.result,
                        events=self.events.copy(), time='20 min + 3 × 60 s',
                        color=self.color, pending=self.pending, clocks=self.clocks.copy(),
                        last_move=list(self.board.moves[-1]) if self.board.moves else None,
                        confirmation=self.pending_confirmation is not None)

    def close(self):
        with self.lock:
            self.generation += 1
            if self.timer:
                self.timer.cancel()
                self.timer = None
            if self.gateway:
                self.gateway.close()
                self.gateway = None
            if self.connection:
                self.connection.close()
                self.connection = None
            self.token = b''
            self.uid = 0
            self.phase, self.status = 'disconnected', 'Disconnected'
            self.pending = False
            self.pending_confirmation = None

    def login(self):
        self.close()
        with self.lock:
            self.mode = 'fox'
            self.board=Board();self.clocks={};self.result='';self.room_key={};self.color=0
            self.phase, self.status = 'connecting', 'Connecting to Fox…'
            generation = self.generation
        threading.Thread(target=self._connect, args=(generation,), daemon=True).start()

    def _connect(self, generation):
        connection = None
        try:
            username, password = read_credentials(self.credential_path)
            request = login_request(username, password)
            del username, password
            connection = Connection(*self.endpoint,
                lambda packet: self._receive(generation, packet),
                lambda reason: self._nav_failed(generation, reason))
            with self.lock:
                if generation != self.generation:
                    connection.close()
                    return
                self.connection = connection
                self.phase, self.status = 'authenticating', 'Waiting for Fox login response…'
                connection.send(2000, request)
                del request
                self.timer = threading.Timer(15, lambda: self._failed(generation, 'Login timed out'))
                self.timer.daemon = True
                self.timer.start()
                connection.start()
        except Exception as exc:
            if connection:
                connection.close()
            # Never propagate arbitrary exception contents that could contain credentials.
            self._failed(generation, f'Connection failed ({type(exc).__name__})')

    def _nav_failed(self,generation,reason):
        with self.lock:
            if generation!=self.generation:return
            if self.gateway and not self.gateway.closed.is_set():
                self.connection=None
                self.event('Navigation connection closed; game gateway remains connected')
            else:self._failed(generation,reason)

    def _failed(self, generation, reason):
        with self.lock:
            if generation != self.generation:
                return
            self.close()
            self.phase, self.status = 'error', reason
            self.event(reason)

    def _receive(self, generation, packet):
        with self.lock:
            if generation != self.generation:
                return
            if packet.command == 26200:
                self._gateway_message(generation,packet)
                return
            message = decode(packet.payload)
            if packet.command == 2005:
                if self.timer:
                    self.timer.cancel()
                code = signed(message.one(1))
                uid = message.one(2) or message.sub(3).one(1)
                token = message.one(8, b'')
                if code or not uid or not token:
                    self._failed(generation, f'Fox login status {code}; no authenticated session. Reference-client verification needed.')
                    return
                self.uid, self.token = uid, token
                self.phase, self.status = 'bootstrap', 'Authenticated; fetching server list…'
                self.connection.send(3000, encode({1: uid, 2: False}))
                self.connection.send(3010, encode({1: uid}))
                self.timer = threading.Timer(15, lambda: self._failed(generation, 'Server discovery timed out'))
                self.timer.daemon = True
                self.timer.start()
            elif packet.command == 3005 and message.get(3):
                self.servers = [decode(item) for item in message[3]]
                record = next((r for r in self.servers if r.one(1) == 1), self.servers[0])
                host, port = record.text(21), record.one(22)
                if not host or not 0 < port < 65536:
                    raise ValueError('Server list has no usable gateway')
                self.event('Authenticated; server discovery complete')
                self.phase, self.status = 'gateway', 'Connecting to Fox game gateway…'
                threading.Thread(target=self._connect_gateway, args=(generation,host,port), daemon=True).start()
            elif packet.command == 3015:
                self.event('Received navigation settings')
            elif packet.command == 26200:
                self._gateway_message(generation, packet)
            else:
                self.event(f'Fox response {packet.command} ({len(packet.payload)} bytes)')

    def _connect_gateway(self, generation, host, port):
        connection = None
        try:
            connection = Connection(host, port,
                lambda packet: self._receive(generation, packet),
                lambda reason: self._failed(generation, reason))
            with self.lock:
                if generation != self.generation:
                    connection.close()
                    return
                self.gateway = connection
                self.send(game.GATEWAY, 1, {1:self.token})
                connection.start()
        except Exception as exc:
            if connection: connection.close()
            self._failed(generation, f'Gateway connection failed ({type(exc).__name__})')

    def send(self, service, op, fields=None, node=0):
        if not self.gateway:
            raise ConnectionError('Game gateway is disconnected')
        self.gateway.send(26200, game.envelope(self.uid, service, op, fields, node))

    def _heartbeat(self, generation):
        try:
            with self.lock:
                if generation != self.generation or not self.gateway:
                    return
                ticks = int(time.monotonic()*1000)
                self.send(game.GATEWAY, 5, {1:ticks})
                self.send(game.ROOM, 100010, {1:ticks})
                if self.room_key:
                    if self.pending and time.time()-getattr(self,'pending_since',0)>8:
                        self.send(game.GAME,501,node=self.room_key[2])
                        self.pending_since=time.time()
                    self.send(game.GAME, 200, {1:ticks,3:self.room_key}, self.room_key[2])
                self.timer = threading.Timer(5, lambda:self._heartbeat(generation))
                self.timer.daemon = True
                self.timer.start()
        except Exception as exc:
            self._failed(generation, f'Heartbeat failed ({type(exc).__name__})')

    def _gateway_message(self, generation, packet):
        header, m = game.unpack(packet.payload)
        service, op = header.one(7), header.one(1)
        if self.trace_dir:
            directory=Path(self.trace_dir);directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            path=directory/f'{time.time_ns()}-{service}-{op}.bin'
            path.write_bytes(packet.payload);path.chmod(0o600)
        if op not in (5,200,100010):
            self.event(f'Fox {service}/{op}')
        if service == game.GATEWAY:
            if op == 1:
                code=signed(m.one(1))
                if code:
                    self._failed(generation, f'Gateway login status {code}')
                    return
                if self.timer:self.timer.cancel()
                self.status='Gateway authenticated; discovering game settings…'
                self.send(game.ROOM,100008,{1:True})
                self._heartbeat(generation)
            elif op == 100:
                self._failed(generation,'Fox ended this session (another client may have logged in)')
        elif service == game.ROOM:
            self._room_message(op,m)
        elif service == game.GAME:
            self._game_message(op,m,header)

    def _room_message(self,op,m):
        if op == 100008:
            if signed(m.one(1)):
                raise ValueError(f'Room manager login status {signed(m.one(1))}')
            for operation in (100145,100115,100150):self.send(game.ROOM,operation)
        elif op == 100115 and m.one(1)==0 and m.one(2)==game.GAME:
            self.phase,self.status='resuming','Reconnecting to your existing game…'
            self.send(game.GAME,501,node=m.one(3))
        elif op == 100150:
            self.field_id=game.normal_field([decode(b) for b in m.get(1,[])])
            if self.phase not in ('playing','resuming','joining'):
                self.phase,self.status='ready','Connected to Fox. Normal 20 min + 3 × 60 s match available.'
        elif op == 100130:
            if signed(m.one(1)):
                self.phase,self.status='ready',f'Matchmaking rejected: {signed(m.one(1))}'
            else:
                self.phase,self.status='matching','Searching for a normal game…'
        elif op in (100132,100139,100141):
            self.pending_confirmation=None
            self.phase,self.status='ready','Matchmaking ended'
        elif op == 100135:
            self.pending_confirmation=('invite',game.plain(m))
            self.phase,self.status='confirming','Fox found an opponent. Match confirmation needs inspection.'
        elif op == 100143:
            self.pending_confirmation=('rule',game.plain(m))
            self.phase,self.status='confirming','Opponent proposed game settings'
        elif op == 100146:
            self.pending_confirmation=('make-rule',game.plain(m))
            self.phase,self.status='confirming','Fox requested game-rule negotiation'
        elif op == 100140:
            if signed(m.one(1)):
                raise ValueError(f'Room entry status {signed(m.one(1))}')
            self.room_key={1:m.one(2),2:m.one(3),3:m.one(4),4:m.one(7)}
            if self.phase!='playing':self.phase,self.status='joining','Joining the matched game…'
            self.send(game.GAME,105,node=m.one(3))

    def _game_message(self,op,m,header):
        if op == 105:
            if signed(m.one(1)):
                raise ValueError(f'Game room status {signed(m.one(1))}')
        elif op == 107:
            self.room_key={1:game.GAME,2:header.one(8),3:m.one(6),4:m.one(7)}
            self.board=Board()
            self.color=0
            for data in m.get(9,[]):
                user=decode(data)
                if user.one(1)==self.uid:self.color=user.one(6)
            self.phase,self.status='playing','Fox game started'
            self.pending=False
            self.sync=0
        elif op == 203:
            x,y,color=m.one(1),m.one(2),m.one(3)
            self.board.play(x,y,color,authoritative=True)
            self.sync=m.sub(5).one(1,self.sync)
            self._clock(color,m.sub(4))
            self.pending=False
            self.status='Your turn' if self.board.turn==self.color else 'Opponent’s turn'
        elif op == 206:
            color=self.board.turn
            self.board.pass_turn()
            self._clock(color,m.sub(1))
            self.sync=m.sub(2).one(1,self.sync)
            self.pending=False
            self.status='Opponent passed' if self.board.turn==self.color else 'You passed'
        elif op in (201,204,301,304,311):
            if signed(m.one(1)):
                self.pending=False
                self.status=f'Fox rejected action {op}: {signed(m.one(1))}'
            elif op in (301,304):
                self.pending=False
        elif op == 306:
            self.pending=False
            self.status='Scoring accepted; waiting for Fox result' if m.one(1) else 'Scoring declined; continue playing'
        elif op == 108:
            self.clocks['countdown']={str(k):v[-1] for k,v in m.items() if isinstance(v[-1],int)}
        elif op == 303:
            self.pending_confirmation=('score',game.plain(m))
            self.status='Opponent requested scoring'
        elif op == 402:
            self.pending=False
            self.phase,self.status='finished','Fox game ended'
            self._result(m)
        elif op in (403,405):
            self.phase,self.status='finished','Fox supplied the game result'
            self.pending=False
            self._result(m)
        elif op in (218,219):
            self.sync=m.sub(1).one(1,self.sync)
        elif op == 501:
            if signed(m.one(1)):raise ValueError(f'Game synchronization status {signed(m.one(1))}')
            self.room_key={1:m.one(12),2:m.one(13),3:m.one(7),4:m.one(10)}
            self.sync=m.sub(5).one(1)
            self.board=Board()
            for data in m.get(4,[]):
                move=decode(data)
                if move.one(1)==1:self.board.play(move.one(2),move.one(3),move.one(4),authoritative=True)
                elif move.one(1)==2:self.board.pass_turn(move.one(4))
            for data in m.get(3,[]):
                user=decode(data)
                if user.one(1)==self.uid:self.color=user.one(6)
                self.clocks[str(user.one(6))]={'main':user.one(7),'periods':user.one(8),'byoyomi':user.one(9),'at':time.time()}
            self.phase,self.status='playing','Fox game synchronized'
            self.pending=False
            if m.one(6)==5:
                self.phase,self.status='finished','Fox game ended'

    def _clock(self,color,m):
        if 2 in m:
            self.clocks[str(color)]={'main':m.one(2),'periods':m.one(3),
                                     'byoyomi':m.one(4),'at':time.time()}
        next_color=3-color
        if str(next_color) in self.clocks:self.clocks[str(next_color)]['at']=time.time()

    def _result(self,m):
        # Result tuple is passed directly to 0080b910 by both end/result handlers.
        winner,margin,reason=m.one(2),signed(m.one(3)),m.one(4)
        self.pending_confirmation=None
        self.result_details={'winner':winner,'margin':margin,'reason':reason}
        self.result = ('B' if winner==1 else 'W') + '+R' if winner in (1,2) and reason==3 else ''
        if self.result:self.status=f'Fox result: {self.result}'
        elif reason==8:self.result='Void';self.status='Fox cancelled the game'
        elif winner in (1,2):
            self.result=('B' if winner==1 else 'W')+'+'
            self.status=f'{"Black" if winner==1 else "White"} wins'
        else:self.status='Fox game ended'
        self.event(f'Final result: winner {winner}, value {margin}, reason {reason}')

    def request_score(self):
        with self.lock:
            if self.mode!='fox':raise ValueError('This action requires a Fox game')
            self._online_action(301,{1:0})
            self.status='Scoring requested; waiting for Fox'

    def confirm(self,accept):
        with self.lock:
            if not self.pending_confirmation:raise ValueError('No pending confirmation')
            kind,fields=self.pending_confirmation
            if kind=='score':
                self.send(game.GAME,304,{1:bool(accept),2:1},self.room_key[2])
            elif kind=='rule':
                rule=decode(fields.get(2,b''))
                if accept and tuple(rule.one(f) for f in (1,6,8,7))!=game.NORMAL:
                    raise ValueError('Proposed rules do not match your normal time settings')
                self.send(game.ROOM,100144,{1:fields[1],2:bool(accept)})
            else:raise ValueError('This negotiation path has not yet been verified')
            self.pending_confirmation=None

    def match(self):
        with self.lock:
            if self.mode!='fox' or self.phase not in ('ready','finished') or self.field_id is None:
                raise ValueError('Log in and wait for server discovery first')
            self.board=Board();self.room_key={};self.result='';self.color=0
            self.pending_confirmation=None
            self.phase,self.status='matching','Requesting a normal match…'
            self.send(game.ROOM,100130,{1:self.field_id,2:False})

    def cancel_match(self):
        with self.lock:
            if self.phase not in ('matching','confirming'):
                raise ValueError('No matchmaking request is active')
            self.send(game.ROOM,100139)

    def _online_action(self,op,fields):
        if self.phase!='playing' or not self.room_key or self.color not in (1,2):
            raise ValueError('No active Fox game')
        if self.pending:raise ValueError('Waiting for Fox to confirm the previous action')
        self.send(game.GAME,op,fields,self.room_key[2])
        self.pending=True
        self.pending_since=time.time()


    def local_game(self):
        self.close()
        with self.lock:
            self.board = Board()
            self.mode, self.phase = 'local', 'playing'
            self.status, self.result = 'Local board — both players on this computer', ''

    def play(self, x, y):
        with self.lock:
            if self.mode=='fox':
                if self.board.turn!=self.color:raise ValueError('Wait for your turn')
                import copy
                copy.deepcopy(self.board).play(x,y,self.color)
                self._online_action(201,{1:x,2:y,3:self.color,4:{1:self.sync}})
                return
            if self.phase!='playing':raise ValueError('No active game')
            self.board.play(x,y)

    def pass_turn(self):
        with self.lock:
            if self.mode=='fox':
                if self.board.turn!=self.color:raise ValueError('Wait for your turn')
                self._online_action(204,{1:{1:self.sync}})
                return
            if self.phase!='playing':raise ValueError('No active local game')
            self.board.pass_turn()
            if self.board.passes >= 2:
                self.phase = 'scoring'
                self.status = 'Both players passed. Mark dead groups, then finish scoring.'

    def score(self, dead):
        with self.lock:
            if self.mode != 'local' or self.phase != 'scoring':
                raise ValueError('Game is not being scored')
            points = set()
            for p in dead:
                if not isinstance(p, int) or not 0 <= p < 361:
                    raise ValueError('Invalid dead-stone position')
                if self.board.stones[p]:
                    points.update(self.board.group(p)[0])
            black, white = self.board.area_score(dead=points)
            self.result = '0' if black == white else f'{"B" if black > white else "W"}+{abs(black-white):g}'
            self.phase, self.status = 'finished', f'Local result: {self.result}'

    def resign(self):
        with self.lock:
            if self.mode=='fox':
                self._online_action(311,{1:self.color,2:self.room_key})
                return
            if self.phase!='playing':raise ValueError('No active local game')
            self.result = f'{"W" if self.board.turn == 1 else "B"}+R'
            self.phase, self.status = 'finished', f'Local result: {self.result}'
