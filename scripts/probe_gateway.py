"""Read-only authenticated discovery. Never print user IDs or session data."""
import sys
from pathlib import Path
import socket
import time
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from foxclient.session import read_credentials, login_request
from foxclient.wire import encode, decode, signed
from protocol.framing import encode as frame,decode_one,gateway_payload,split_gateway

def receive(s):
    buf=b''
    while True:
        part=s.recv(65536)
        if not part:return
        buf+=part
        while (parsed:=decode_one(buf)):
            packet,n=parsed;buf=buf[n:]
            yield packet

def send(s,uid,service,op,fields=None,node=0):
    header=encode({1:op,3:uid,5:32,6:6,7:service,8:node,19:'11509231',20:4})
    s.sendall(frame(26200,gateway_payload(header,encode(fields or {}))))

if __name__=='__main__':
 with socket.create_connection(('43.132.13.39',10000),timeout=10) as nav:
    nav.settimeout(15)
    nav.sendall(frame(2000,login_request(*read_credentials('creds'))))
    uid=0;token=b''
    for packet in receive(nav):
        m=decode(packet.payload)
        if packet.command==2005:
            print('Login status',signed(m.one(1)),flush=True)
            if signed(m.one(1))!=0:sys.exit(1)
            uid=m.one(2);token=m.one(8,b'')
            nav.sendall(frame(3000,encode({1:uid,2:False})))
        elif packet.command==3005 and m.get(3):
            records=[decode(b) for b in m[3]]
            record=records[0]
            endpoint=(record.text(21),record.one(22))
            print('Gateway endpoint',endpoint,flush=True)
            break
    with socket.create_connection(endpoint,timeout=10) as gw:
        gw.settimeout(15)
        send(gw,uid,20001,1,{1:token})
        deadline=time.monotonic()+30
        for packet in receive(gw):
            if packet.command!=26200:
                print('Classic gateway response',packet.command,flush=True);continue
            h,b=split_gateway(packet.payload);h=decode(h);m=decode(b)
            service,op=h.one(7),h.one(1)
            print('Gateway message',service,op,'bytes',len(b),'fields',list(m),flush=True)
            if service==20001 and op==1:
                print('Gateway login status',signed(m.one(1)),flush=True)
                if signed(m.one(1))!=0:sys.exit(1)
                send(gw,uid,30006,100008,{1:True})
            elif service==30006 and op==100008:
                print('Room manager login status',signed(m.one(1)),flush=True)
                for op in [100145,100115,100150]:send(gw,uid,30006,op)
            elif service==30006 and op in [100145,100115,100150]:
                p=Path(f'analysis/live/{op}.bin');p.write_bytes(b);p.chmod(0o600)
                if op==100150:break
            if time.monotonic()>deadline:break
