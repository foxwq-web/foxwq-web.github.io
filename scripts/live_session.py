"""Interactive diagnostic harness. No credential/session contents in stdout."""
import sys,time,threading,queue
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from foxclient.session import Session
s=Session();s.trace_dir='analysis/live/game';s.login()
commands=queue.Queue()
def reader():
 for line in sys.stdin:commands.put(line.strip())
threading.Thread(target=reader,daemon=True).start()
last=None;seen=0
try:
 while True:
    state=s.snapshot()
    key=(state['phase'],state['status'],state['moves'],state['pending'])
    if key!=last:print(key,'color',state['color'],'sync',s.sync,flush=True);last=key
    if len(s.events)>seen:
        print('Events',s.events[seen:],flush=True);seen=len(s.events)
    try:command=commands.get_nowait()
    except queue.Empty:command=''
    if command:
        words=command.split()
        try:
            if words[0]=='reload':
                import importlib,foxclient.session
                importlib.reload(foxclient.session);s.__class__=foxclient.session.Session
                print('Reloaded session implementation',flush=True)
            elif words[0]=='match':s.match()
            elif words[0]=='cancel':s.cancel_match()
            elif words[0]=='move':s.play(int(words[1]),int(words[2]))
            elif words[0]=='pass':s.pass_turn()
            elif words[0]=='resign':s.resign()
            elif words[0]=='quit':break
            elif words[0]=='confirm':s.confirm(True)
            elif words[0]=='score':s.request_score()
            else:print('Unknown command',flush=True)
        except Exception as e:print('Action error',type(e).__name__,str(e),flush=True)
    time.sleep(.2)
except KeyboardInterrupt:pass
finally:s.close()
