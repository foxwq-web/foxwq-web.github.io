import socket
import tempfile
import threading
import unittest
from pathlib import Path
from foxclient.board import Board
from foxclient.wire import encode, decode, read_varint, signed
from foxclient.session import Session, login_request
from foxclient.transport import Connection
from protocol.framing import encode as frame, decode_one


class BoardTests(unittest.TestCase):
    def test_capture_and_suicide(self):
        board = Board()
        for x,y in [(1,0),(0,1),(2,1)]: board.play(x,y,1)
        board.play(1,1,2)
        board.play(1,2,1)
        self.assertEqual(board.stones[20],0)
        self.assertEqual(board.captures[1],1)
        with self.assertRaisesRegex(ValueError,'suicide'):board.play(1,1,2)

    def test_ko_and_pass(self):
        board=Board()
        for x,y in [(0,1),(1,0),(2,1)]:board.play(x,y,1)
        for x,y in [(1,1),(0,2),(2,2),(1,3)]:board.play(x,y,2)
        board.play(1,2,1)
        with self.assertRaisesRegex(ValueError,'ko'):board.play(1,1,2)
        board.pass_turn(2)
        board.pass_turn(1)
        board.play(1,1,2)
        self.assertEqual(board.stones[39],0)

    def test_scoring_and_export(self):
        board=Board()
        board.play(3,3)
        board.pass_turn()
        self.assertIn(';B[dd];W[]',board.sgf(black='a]b'))
        self.assertIn('PB[a\\]b]',board.sgf(black='a]b'))
        self.assertEqual(board.area_score(),[361,7.5])
        self.assertEqual(board.area_score(dead=[60]),[0,7.5])


class WireTests(unittest.TestCase):
    def test_nested_repeated_and_signed(self):
        message=decode(encode({1:-1,2:{1:1200,2:60,3:3},3:[b'a',b'b']}))
        self.assertEqual(signed(message.one(1)),-1)
        self.assertEqual(message.sub(2).one(1),1200)
        self.assertEqual(message[3],[b'a',b'b'])
        for invalid in [b'\x00',b'\x0a\x05hi',b'\x08'+b'\xff'*10]:
            with self.assertRaises(ValueError):decode(invalid)

    def test_login_contract(self):
        m=decode(login_request('test','password','001122334455'))
        self.assertEqual(m.text(3),'5f4dcc3b5aa765d61d8327deb882cf99')
        self.assertEqual(m.text(7),'001122334455')
        self.assertEqual(m.one(5),11509231)


class SessionTests(unittest.TestCase):
    def test_real_tcp_login_failure_is_safe_and_closes(self):
        listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen()
        complete=threading.Event();seen=[]
        def serve():
            with listener:
                sock,_=listener.accept()
                with sock:
                    buf=b''
                    while decode_one(buf) is None:buf+=sock.recv(1024)
                    packet,_=decode_one(buf);seen.append(packet.command)
                    response=frame(2005,encode({1:-1,2:0,8:b''}))
                    sock.sendall(response[:3]);sock.sendall(response[3:])
                    sock.settimeout(3)
                    self.assertEqual(sock.recv(1),b'')
                    complete.set()
        worker=threading.Thread(target=serve,daemon=True);worker.start()
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'creds';path.write_text('test\nprivate-password\n')
            s=Session(path,listener.getsockname());s.login()
            self.assertTrue(complete.wait(5))
            self.assertEqual(s.snapshot()['phase'],'error')
            self.assertNotIn('private-password',str(s.snapshot()))
            self.assertEqual(seen,[2000]);s.close()

    def test_local_game_finish(self):
        s=Session();s.local_game();s.play(3,3);s.pass_turn();s.pass_turn()
        self.assertEqual(s.snapshot()['phase'],'scoring')
        s.score([])
        self.assertEqual(s.snapshot()['result'],'B+353.5')
        with self.assertRaises(ValueError):s.play(4,4)


class ScoringContractTests(unittest.TestCase):
    def test_ordinary_scoring_confirmation_and_result(self):
        from foxclient.game import unpack
        class Gateway:
            def __init__(self):self.sent=[]
            def send(self,command,payload):self.sent.append((command,unpack(payload)))
        s=Session();s.gateway=Gateway();s.uid=42;s.color=1
        s.room_key={1:31000,2:63,3:23,4:202};s.phase='playing'
        s.request_score()
        command,(h,m)=s.gateway.sent[-1]
        self.assertEqual((command,h.one(1),m.one(1)),(26200,301,0))
        s._game_message(301,decode(encode({1:0})),{})
        self.assertFalse(s.pending)
        s._game_message(303,decode(encode({1:1})),{})
        self.assertTrue(s.snapshot()['confirmation'])
        s.confirm(False)
        _,(h,m)=s.gateway.sent[-1]
        self.assertEqual((h.one(1),m.one(1),m.one(2)),(304,0,1))
        self.assertFalse(s.snapshot()['confirmation'])
        s._game_message(303,decode(encode({1:1})),{})
        s.confirm(True)
        _,(h,m)=s.gateway.sent[-1]
        self.assertEqual((h.one(1),m.one(1),m.one(2)),(304,1,1))
        s._game_message(402,decode(encode({1:0,2:1,3:125,4:2})),{})
        self.assertEqual(s.phase,'finished')
        self.assertEqual(s.status,'Black wins')
        self.assertEqual(s.result,'B+')

if __name__=='__main__':unittest.main()
