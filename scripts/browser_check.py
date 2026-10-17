"""Exercise the local UI using installed Chrome and its debugging protocol.

No dependencies installed, no Fox login, isolated temporary browser profile.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlparse

class CDP:
    def __init__(self,url):
        u=urlparse(url);self.s=socket.create_connection((u.hostname,u.port),timeout=10);self.serial=0
        key=base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(f'GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n'.encode())
        header=b''
        while not header.endswith(b'\r\n\r\n'):header+=self.s.recv(1)
        expected=base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
        if b' 101 ' not in header.split(b'\r\n',1)[0] or expected not in header:raise ValueError('WebSocket handshake failed')
    def exact(self,n):
        b=b''
        while len(b)<n:
            part=self.s.recv(n-len(b))
            if not part:raise ConnectionError('Chrome disconnected')
            b+=part
        return b
    def call(self,method,params):
        self.serial+=1;serial=self.serial
        data=json.dumps({'id':serial,'method':method,'params':params}).encode();mask=os.urandom(4)
        prefix=bytes([0x81,0x80|len(data)]) if len(data)<126 else b'\x81\xfe'+struct.pack('>H',len(data))
        self.s.sendall(prefix+mask+bytes(v^mask[i%4] for i,v in enumerate(data)))
        while True:
            a,b=self.exact(2);length=b&127
            if length==126:length=struct.unpack('>H',self.exact(2))[0]
            elif length==127:length=struct.unpack('>Q',self.exact(8))[0]
            if b&128:raise ValueError('Unexpected masked response')
            raw=self.exact(length)
            if a&15==8:raise ConnectionError('WebSocket closed')
            result=json.loads(raw)
            if result.get('id')==serial:
                if 'error' in result:raise ValueError(result['error'])
                return result['result']
    def js(self,expression):
        result=self.call('Runtime.evaluate',{'expression':expression,'awaitPromise':True,'returnByValue':True})
        if 'exceptionDetails' in result:raise ValueError(result['exceptionDetails']['text'])
        return result['result'].get('value')

with tempfile.TemporaryDirectory(prefix='foxwq-web-chrome-') as profile:
    log=Path('analysis/live/browser.log').open('wb')
    chrome=subprocess.Popen(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
        '--remote-debugging-port=0','--remote-allow-origins=http://localhost',
        f'--user-data-dir={profile}','http://127.0.0.1:8765'],stdout=log,stderr=log)
    try:
        portfile=Path(profile)/'DevToolsActivePort'
        for _ in range(100):
            if portfile.exists():break
            if chrome.poll() is not None:raise RuntimeError('Chrome failed to start')
            time.sleep(.1)
        port=int(portfile.read_text().splitlines()[0])
        tabs=json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list'))
        c=CDP(next(t['webSocketDebuggerUrl'] for t in tabs if t['type']=='page'))
        c.call('Emulation.setDeviceMetricsOverride',{'width':1200,'height':1000,'deviceScaleFactor':1,'mobile':False})
        for _ in range(100):
            if c.js("typeof state !== 'undefined' && state !== null"):break
            time.sleep(.1)
        assert c.js("document.title")=='Fox · Go client prototype'
        c.js("document.getElementById('local').click()")
        for _ in range(50):
            if c.js("state.mode==='local'"):break
            time.sleep(.1)
        # Real board DOM event: upper-left 4-4 point.
        c.js("(()=>{const b=document.getElementById('board'),r=b.getBoundingClientRect();b.dispatchEvent(new MouseEvent('click',{clientX:r.left+(48+3*(744/18))*r.width/840,clientY:r.top+(48+3*(744/18))*r.height/840,bubbles:true}));})()")
        for _ in range(50):
            if c.js("state.moves===1"):break
            time.sleep(.1)
        assert c.js('state.stones[60]')==1
        c.js("document.getElementById('pass').click()")
        for _ in range(50):
            if c.js('state.moves===2'):break
            time.sleep(.1)
        c.js("document.getElementById('pass').click()")
        for _ in range(50):
            if c.js("state.phase==='scoring'"):break
            time.sleep(.1)
        assert c.js("!document.getElementById('score').hidden")
        c.js("document.getElementById('score').click()")
        for _ in range(50):
            if c.js("state.phase==='finished'"):break
            time.sleep(.1)
        assert c.js('state.result')=='B+353.5'
        sgf=c.js("fetch('/game.sgf').then(r=>r.text())")
        assert ';B[dd];W[];B[]' in sgf and 'RE[B+353.5]' in sgf
        if '--live' in sys.argv:
            c.js("document.getElementById('login').click()")
            for _ in range(200):
                phase=c.js('state.phase')
                if phase=='ready':break
                if phase=='error':raise RuntimeError(c.js('state.status'))
                time.sleep(.1)
            assert c.js("state.phase==='ready' && !document.getElementById('match').disabled")
            print('Browser live login and normal-match availability verified')
        screenshot=c.call('Page.captureScreenshot',{'format':'png'})['data']
        Path('analysis/live/ui.png').write_bytes(base64.b64decode(screenshot))
        c.s.close()
        print('Browser checks passed: board click, passing, scoring, SGF download, screenshot')
    finally:
        chrome.terminate()
        try:chrome.wait(timeout=5)
        except subprocess.TimeoutExpired:chrome.kill();chrome.wait()
        log.close()
