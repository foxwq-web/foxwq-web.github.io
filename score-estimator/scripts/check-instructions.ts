import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const dir=process.argv[2];
const { instance }=await WebAssembly.instantiate(await readFile(`${dir}/instructions.wasm`),
  {env:{service(){throw Error('Unexpected service');},trace(){}}});
interface InstructionExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  initialize(): void;
  guest_base(): number;
  register_base(): number;
  set_flags(flags: number): void;
  execute(address: number, fuel: number): number;
  get_flags(): number;
  get_pc(): number;
}
interface InstructionCase {
  name: string; sample: number; registers: number[]; memory: number[];
  flags: number; address: number; expected: number[]; flagmask: number;
  expected_flags: number; expected_memory: number[]; next_address: number;
}
const e=instance.exports as InstructionExports;e.initialize();
const guest=new Uint8Array(e.memory.buffer,e.guest_base(),64*1024*1024);
const view=new DataView(guest.buffer,guest.byteOffset,guest.byteLength);
const regs=new Uint32Array(e.memory.buffer,e.register_base(),8);
const cases: InstructionCase[]=JSON.parse(await readFile(`${dir}/cases.json`, 'utf8'));
for(const c of cases){
  regs.set(c.registers);guest.set(c.memory,0x401000);e.set_flags(c.flags);view.setUint32(0x4f0000,0x700000,true);
  const label=`${c.name} sample ${c.sample}`;
  assert.equal(e.execute(c.address,100),0,label);

  const expected=[...c.expected];expected[4]+=4;
  assert.deepEqual([...regs],expected,label+' registers');
  assert.equal((e.get_flags()&c.flagmask)>>>0,(c.expected_flags&c.flagmask)>>>0,label+' defined flags');
  assert.deepEqual([...guest.subarray(0x401000,0x401020)],c.expected_memory,label+' memory');


  regs.set(c.registers);guest.set(c.memory,0x401000);e.set_flags(c.flags);view.setUint32(0x4f0000,0x700000,true);
  assert.equal(e.execute(c.address,1),3,label+' fuel boundary');
  assert.equal(e.get_pc(),c.next_address,label+' next guarded PC');
  assert.deepEqual([...regs],c.expected,label+' registers before rejected RET');
  assert.equal((e.get_flags()&c.flagmask)>>>0,(c.expected_flags&c.flagmask)>>>0,label+' flags at fuel boundary');
  assert.deepEqual([...guest.subarray(0x401000,0x401020)],c.expected_memory,label+' memory at fuel boundary');
}
console.log(`${cases.length} instruction/state comparisons against Unicorn passed`);
