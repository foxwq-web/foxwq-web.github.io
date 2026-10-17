#!/usr/bin/env python3
"""Recover an observational protobuf schema from exported virtual serializers.

Names/requiredness and nested message types are intentionally not invented.
All length-delimited fields remain bytes, including embedded messages.
"""
import json, pathlib, re

writers={'00d61570':'int32','00d615b0':'uint32','00d615e0':'uint64',
         '00d61680':'bool','00d616b0':'message_bytes','00d61870':'bytes','00d61610':'fixed32'}
root=pathlib.Path('decompiled')
messages=[]
proto=['// Observational wire schema; NOT recovered original source.',
       '// Optional labels are deliberate: original requiredness is not reconstructed.',
       '// uint64 denotes varint64 wire encoding; original signedness may differ.',
       '// bytes includes strings and opaque embedded messages. See wire-fields.json.',
       'syntax = "proto2";', 'package fox_recovered;', '']
for m in json.loads(pathlib.Path('analysis/message-vtables.json').read_text()):
    a=m['methods'][9][2:].zfill(8)
    src=next(root.rglob(a+'.c'))
    body=src.read_text().split(' */')[-1]
    # The serializer ABI consistently uses constant field numbers as argument 1.
    pattern=r'FUN_('+'|'.join(writers)+r')\((0x[0-9a-f]+|[0-9]+),'
    fields=[]
    for hit in re.finditer(pattern,body):
        n=int(hit[2],0)
        # Read balanced call arguments, including pointer expressions.
        start=hit.start(); end=body.find(';',start)
        call=body[start:end].replace('\n',' ')
        repeated=bool(re.search(r'[iu]Var\d+ \*',call))
        before=body[:start]
        # Loop bodies have an open do { preceding the call, with no intervening while.
        do=before.rfind('do {')
        repeated=repeated or do>before.rfind('} while') and do>=0
        fields.append(dict(number=n,kind=writers[hit[1]],repeated=repeated,writer='0x'+hit[1],expression=call))
    messages.append(dict(name=m['message'],serializer='0x'+a,fields=fields))
    proto.append('// '+m['message']+'; serializer '+a)
    proto.append('message '+m['message'].replace('.','_')+' {')
    for f in fields:
        t='bytes' if f['kind']=='message_bytes' else f['kind']
        label='repeated' if f['repeated'] else 'optional'
        comment=' // embedded message; type unresolved' if f['kind']=='message_bytes' else ''
        proto.append(f'  {label} {t} field_{f["number"]} = {f["number"]};{comment}')
    proto.extend(['}',''])
out=pathlib.Path('protocol');out.mkdir(exist_ok=True)
(out/'wire-fields.json').write_text(json.dumps(messages,indent=2)+'\n')
(out/'recovered.proto').write_text('\n'.join(proto))
print(f'Recovered {len(messages)} messages, {sum(len(m["fields"]) for m in messages)} fields')
