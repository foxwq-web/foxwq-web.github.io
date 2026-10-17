"""TCP simulator for the wire sequence observed during live Fox validation."""
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from foxclient.session import Session
from foxclient.wire import encode,decode
from protocol.framing import encode as frame,decode_one,gateway_payload,split_gateway


class LiveFlowTests(unittest.TestCase):
    def test_login_match_moves_pass_resume_and_resign(self):
        nav=socket.socket();nav.bind(('127.0.0.1',0));nav.listen()
        gw=socket.socket();gw.bind(('127.0.0.1',0));gw.listen()
        stopped=threading.Event();failures=[];requests=[]
        user={1:42,6:1,7:1200,8:3,9:60}
        rules={1:19,2:1,3:0,4:375,6:1200,7:60,8:3}
        room={1:31000,2:63,3:23,4:202}
        def send(sock,service,op,body):
            h=encode({1:op,3:42,7:service,8:63 if service==31000 else 1})
            sock.sendall(frame(26200,gateway_payload(h,encode(body))))
        def packets(sock):
            sock.settimeout(.1);buffer=b''
            while not stopped.is_set():
                try:part=sock.recv(65536)
                except socket.timeout:continue
                if not part:return
                buffer+=part
                while (parsed:=decode_one(buffer)) is not None:
                    packet,n=parsed;buffer=buffer[n:];yield packet
        def nav_worker():
            try:
                sock,_=nav.accept()
                with sock:
                    for p in packets(sock):
                        if p.command==2000:
                            m=decode(p.payload)
                            self.assertEqual(m.text(7).__len__(),12)
                            sock.sendall(frame(2005,encode({1:0,2:42,3:{1:42},8:b'private-session'})))
                        elif p.command==3000:
                            record={1:1,21:'127.0.0.1',22:gw.getsockname()[1]}
                            sock.sendall(frame(3005,encode({1:0,3:[record]})))
                            sock.sendall(frame(3005,encode({1:0})))
                        elif p.command==3010:sock.sendall(frame(3015,encode({1:0})))
            except Exception as exc:failures.append(exc)
        def gateway_worker():
            try:
                sock,_=gw.accept()
                with sock:
                    for p in packets(sock):
                        self.assertEqual(p.command,26200)
                        h,b=split_gateway(p.payload);h=decode(h);m=decode(b)
                        service,op=h.one(7),h.one(1);requests.append((service,op))
                        self.assertEqual(h.one(3),42);self.assertEqual(h.text(19),'11509231')
                        if (service,op)==(20001,1):
                            self.assertEqual(m.one(1),b'private-session');send(sock,service,op,{1:0})
                        elif op==100008:send(sock,service,op,{1:0})
                        elif op==100150:
                            cfg={1:101,2:19,3:1200,4:3,5:60,7:0,12:1}
                            send(sock,service,op,{1:[cfg]})
                        elif op==100115:send(sock,service,op,{1:107004})
                        elif op==100130:
                            self.assertEqual(m.one(1),101);self.assertEqual(m.one(2),0)
                            send(sock,service,op,{1:0})
                            # Fox sends the start notification BEFORE room entry.
                            send(sock,31000,107,{1:rules,3:101,6:23,7:202,9:[user]})
                            send(sock,30006,100140,{1:0,2:31000,3:63,4:23,7:202})
                        elif op==105:
                            send(sock,service,op,{1:0})
                            send(sock,service,501,{1:0,2:rules,3:[user],5:{1:0},6:3,7:23,9:101,10:202,12:31000,13:63})
                        elif op==201:
                            self.assertEqual(m.sub(4).one(1),0)
                            send(sock,service,op,{1:0})
                            send(sock,service,203,{1:3,2:3,3:1,4:{2:1199,3:3,4:60},5:{1:1}})
                            send(sock,service,203,{1:15,2:15,3:2,4:{2:1198,3:3,4:60},5:{1:2}})
                        elif op==204:
                            self.assertEqual(m.sub(1).one(1),2)
                            send(sock,service,op,{1:0});send(sock,service,206,{2:{1:3}})
                        elif op==501:
                            moves=[{1:1,2:3,3:3,4:1},{1:1,2:15,3:15,4:2},{1:2,4:1}]
                            send(sock,service,op,{1:0,2:rules,3:[user],4:moves,5:{1:3},6:3,7:23,9:101,10:202,12:31000,13:63})
                        elif op==311:
                            self.assertEqual(dict(m.sub(2)),dict(decode(encode(room))))
                            self.assertEqual(m.one(1),1)
                            send(sock,service,op,{1:0});send(sock,service,402,{1:0,2:2,3:-1,4:3})
            except Exception as exc:failures.append(exc)
        threads=[threading.Thread(target=f,daemon=True) for f in [nav_worker,gateway_worker]]
        for t in threads:t.start()
        def wait(s,predicate):
            deadline=time.monotonic()+5
            while time.monotonic()<deadline:
                if failures:raise failures[0]
                state=s.snapshot()
                if predicate(state):return state
                time.sleep(.01)
            self.fail('Protocol state did not advance: '+str(s.snapshot()))
        s=None
        try:
            with tempfile.TemporaryDirectory() as tmp:
                creds=Path(tmp)/'creds';creds.write_text('test\npassword\n')
                s=Session(creds,nav.getsockname());s.login()
                wait(s,lambda v:v['phase']=='ready')
                self.assertEqual(len(s.servers),1)
                self.assertNotIn('private-session',str(s.snapshot()))
                s.match();wait(s,lambda v:v['phase']=='playing' and v['color']==1)
                s.play(3,3);wait(s,lambda v:v['moves']==2)
                self.assertEqual(s.sync,2);self.assertEqual(s.board.turn,1)
                s.pass_turn();wait(s,lambda v:v['moves']==3)
                s.send(31000,501,node=63)
                wait(s,lambda v:v['status']=='Fox game synchronized')
                self.assertEqual(s.board.moves,[(1,3,3),(2,15,15),(1,None,None)])
                s.resign();wait(s,lambda v:v['phase']=='finished')
                self.assertEqual(s.result,'W+R')
                self.assertIn('RE[W+R]',s.board.sgf(s.result))
                self.assertIn((31000,311),requests)
        finally:
            if s:s.close()
            stopped.set();nav.close();gw.close()
            for t in threads:t.join(timeout=1)
        if failures:raise failures[0]

if __name__=='__main__':unittest.main()
