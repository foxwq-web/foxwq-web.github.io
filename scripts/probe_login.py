"""Single ordinary login attempt; credential/session bytes are never printed."""
import hashlib
import json
from pathlib import Path
import socket
import sys
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from foxclient.wire import encode, decode, signed
from protocol.framing import encode as frame, decode_one

def credentials(path='creds'):
    lines = [l.strip() for l in Path(path).read_text().splitlines() if l.strip()]
    if len(lines) != 2:
        raise ValueError('creds must contain username and password on separate lines')
    return lines

if __name__ == '__main__':
    username, password = credentials()
    mac = f'{uuid.getnode():012X}'
    data = encode({1:username,2:'foxwq',3:hashlib.md5(password.encode()).hexdigest(),4:8,5:0xaf9def,6:False,7:mac,9:False})
    del username,password
    with socket.create_connection((sys.argv[1] if len(sys.argv)>1 else '43.132.13.39',int(sys.argv[2]) if len(sys.argv)>2 else 10000), timeout=10) as s:
        s.settimeout(10)
        if len(sys.argv)>3:
            s.sendall(f'tgw_l7_forward\r\nHost: {sys.argv[3]}\r\n\r\n'.encode())
        s.sendall(frame(2000,data));del data
        buf=b''
        while True:
            part=s.recv(65536)
            if not part:print('Connection closed');break
            buf+=part
            while (parsed:=decode_one(buf)):
                packet,n=parsed;buf=buf[n:];msg=decode(packet.payload)
                print('command',packet.command,'size',len(packet.payload),'fields',list(msg))
                if packet.command in (2000,2001,2005):
                    print('Login status',signed(msg.one(1)))
                    p=Path('analysis/live/login.bin');p.write_bytes(packet.payload);p.chmod(0o600)
                    if signed(msg.one(1))==0:
                        # Local, ignored, private session for protocol investigation.
                        p=Path('analysis/live/login.bin');p.write_bytes(packet.payload);p.chmod(0o600)
                        s.sendall(frame(3000,encode({1:msg.one(2),2:False})))
                        s.sendall(frame(3010,encode({1:msg.one(2)})))
                    else:sys.exit(1)
                elif packet.command in (3005,3015):
                    p=Path(f'analysis/live/{packet.command}.bin')
                    if packet.command != 3005 or msg.get(3):
                        p.write_bytes(packet.payload);p.chmod(0o600)
                    print('Saved private bootstrap response')
                    if packet.command==3015:sys.exit(0)
