#!/usr/bin/env python3
import json, pathlib

root=pathlib.Path('decompiled')
rows=['# Message index', '',
      'Recovered RTTI classes and their Ghidra pseudocode. Start with [the protocol notes](../docs/client-protocol.md).', '',
      'Parser and serializer addresses are the strongest wire-layout evidence. Shared addresses reflect compiler-folded identical methods.', '',
      '| Message | Type name | Parser | Serializer | Byte size |',
      '| --- | --- | --- | --- | --- |']
for m in json.loads(pathlib.Path('analysis/message-vtables.json').read_text()):
    links=[]
    for i in (1,7,9,8):
        address=m['methods'][i][2:].zfill(8)
        paths=sorted(root.rglob(address+'.c'),key=lambda p:len(p.parts))
        links.append(f'[{address}]({paths[0].relative_to(root)})' if paths else address+' (not exported)')
    rows.append('| `'+m['message']+'` | '+' | '.join(links)+' |')
(root/'messages.md').write_text('\n'.join(rows)+'\n')
