import type { EstimateResponse } from './score-estimation.ts';
import bindings from '../artifacts/fox-score-bindings.json';

export interface FoxEngineDiagnostics {
  initialGroups: Record<string, number[]>;
  preliminaryOwnership: string;
  nativeOwnership: string;
  groups: Record<string, number[]>;
}
interface LiftedEngine extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  initialize(): void;
  guest_base(): number;
  register_base(): number;
  execute(address: number, budget: number): number;
  get_pc(): number;
  set_pc(address: number): void;
}
const SE_BASE = 0x100000, GO_BASE = 0x200000;
const STACK = 0x4f0000, RETURN = 0x700000;
const BOARD = 0x401000, PENALTIES = 0x402000;
const MEMORY_SIZE = 64 * 1024 * 1024;


export async function runFoxEstimate(status: string, wasm: WebAssembly.Module,
  diagnostics?: (value: FoxEngineDiagnostics) => void): Promise<EstimateResponse> {
  if (!/^[012]{361}$/.test(status)) throw Error('Invalid board');
  let engine: LiftedEngine, guest: Uint8Array, memory: DataView, registers: Uint32Array;
  const read = (address: number) => memory.getUint32(address, true);
  const write = (address: number, value: number) => memory.setUint32(address, value >>> 0, true);
  const services = bindings.services as Record<string, string>;
  let heap = 0x1000000;
  const tls = new Map<number, number>();
  const allocate = (size: number) => {
    const allocated = Math.ceil(size / 16) * 16;
    if (size > 16 * 1024 * 1024 || heap + allocated > MEMORY_SIZE)
      throw Error('Estimator memory limit');
    const pointer = heap; heap += Math.max(16, allocated); return pointer;
  };
  let preliminaryOwnership = '';
  let initialGroups: Record<string, number[]> = {};
  let groups: Record<string, number[]> = {};
  const snapshotGroups = () => Object.fromEntries([
    ['groupGridWithBorder', 0xe64bc, 420], ['groupLiberties', 0xe601c, 128],
    ['groupSizes', 0xe609c, 128], ['groupLife', 0xe611c, 128], ['cachedGroupLife', 0xfcc63, 128],
  ].map(([field, offset, size]) => [field,
    Array.from(guest.subarray(GO_BASE + Number(offset), GO_BASE + Number(offset) + Number(size)))]));
  const deadline = Date.now() + 20000;
  function dispatch(address: number) {
    if (Date.now() > deadline) throw Error('Estimator timed out');
    const name = services[address], stack = registers[4] >>> 0;
    const arg = (i: number) => read(stack + 4 + i * 4);
    let result = 1, count = 0;
    switch (name) {
      case 'CRT!time64': {
        const seconds = Math.floor(Date.now() / 1000);
        result = seconds; registers[2] = 0;
        if (arg(0)) { write(arg(0), seconds); write(arg(0) + 4, 0); }
        break;
      }
      case 'CRT!localtime64': {
        const time = new Date(read(arg(0)) * 1000);
        result = 0x403000;
        [time.getUTCSeconds(), time.getUTCMinutes(), time.getUTCHours(), time.getUTCDate(),
          time.getUTCMonth(), time.getUTCFullYear() - 1900, time.getUTCDay(), 0, 0]
          .forEach((value, i) => write(result + i * 4, value));
        break;
      }
      case 'CRT!ftime64': {
        const now = Date.now();
        write(arg(0), Math.floor(now / 1000)); write(arg(0) + 4, 0);
        write(arg(0) + 8, now % 1000); write(arg(0) + 12, 0);
        result = 0; break;
      }
      case 'CRT!malloc': {
        result = allocate(arg(0)); break;
      }
      case 'CRT!free': result = 0; break;
      case 'CRT!atexit': result = 0; break;

      case 'KERNEL32.dll!WaitForSingleObject': result = 0; count = 2; break;
      case 'KERNEL32.dll!SetEvent': case 'KERNEL32.dll!ResetEvent': count = 1; break;
      case 'KERNEL32.dll!CreateEventA': count = 4; break;
      case 'KERNEL32.dll!GlobalAlloc': case 'KERNEL32.dll!LocalAlloc':
        result = allocate(arg(1)); count = 2; break;
      case 'KERNEL32.dll!GlobalLock': result = arg(0); count = 1; break;
      case 'KERNEL32.dll!GlobalUnlock': count = 1; break;
      case 'KERNEL32.dll!GlobalFree': case 'KERNEL32.dll!LocalFree':
        result = 0; count = 1; break;
      case 'KERNEL32.dll!TlsAlloc': result = tls.size; tls.set(result, 0); break;
      case 'KERNEL32.dll!TlsSetValue': tls.set(arg(0), arg(1)); count = 2; break;
      case 'KERNEL32.dll!TlsGetValue': result = tls.get(arg(0)) ?? 0; count = 1; break;
      case 'KERNEL32.dll!InitializeCriticalSection':
      case 'KERNEL32.dll!EnterCriticalSection': case 'KERNEL32.dll!LeaveCriticalSection':
        count = 1; break;
      case 'KERNEL32.dll!InterlockedIncrement': case 'KERNEL32.dll!InterlockedDecrement': {
        const address = arg(0);
        result = read(address) + (name.endsWith('Increment') ? 1 : -1);
        write(address, result); count = 1; break;
      }
      default: throw Error(`Unexpected estimator import: ${name}`);
    }
    registers[0] = result; registers[4] = stack + 4 + count * 4;
    const target = read(stack);
    if (!(target >= SE_BASE && target < SE_BASE + 0x10000) &&
        !(target >= GO_BASE && target < GO_BASE + 0x148000) && target !== RETURN)
      throw Error('Invalid estimator return address');
    engine.set_pc(target);
  }
  const instance = await WebAssembly.instantiate(wasm, { env: {
    service: dispatch,
    trace(stage: number, output: number) {
      if (!diagnostics) return;
      if (stage === 0) initialGroups = snapshotGroups();
      else {
        preliminaryOwnership = Array.from({ length: 361 }, (_, p) => read(output + p * 4)).join('');
        groups = snapshotGroups();
      }
    },
  } });
  engine = instance.exports as LiftedEngine;
  engine.initialize();
  guest = new Uint8Array(engine.memory.buffer, engine.guest_base(), MEMORY_SIZE);
  memory = new DataView(guest.buffer, guest.byteOffset, guest.byteLength);
  registers = new Uint32Array(engine.memory.buffer, engine.register_base(), 8);
  function call(address: number, args: number[]) {
    if (Date.now() > deadline) throw Error('Estimator timed out');
    write(STACK, RETURN);
    args.forEach((value, i) => write(STACK + 4 + i * 4, value));
    registers[4] = STACK;

    const fault = engine.execute(address, 2000000000);
    if (fault) throw Error(`Estimator translation fault ${fault} at ${engine.get_pc().toString(16)}`);
  }
  const score = bindings.exports['SE.dll'], go = bindings.exports['GoStar5M.dll'];
  for (const address of [0xcbac0, 0xcbae0, 0xcbb40, 0xcbbb0, 0xcbbd0, 0xcbbf0])
    call(GO_BASE + address, []);
  for (const [offset, name] of [[0xd780, 'FirstInitial'], [0xd784, 'NewEvent'],
    [0xd788, 'CalcTerritory'], [0xd77c, 'CanGo'], [0xd78c, 'SetMove'],
    [0xd778, 'UnMove'], [0xd790, 'DeleteStone']] as const) write(SE_BASE + offset, go[name]);
  write(SE_BASE + 0xd794, GO_BASE);
  guest.set(new TextEncoder().encode('YeHuWeiQi\0'), 0x400000);
  call(go.FirstInitial, [0x400000]);
  if (registers[0] !== 1) throw Error('Estimator initialization failed');
  guest.set(Uint8Array.from(status, Number), BOARD);
  call(score.ScoreEstimate, [19, BOARD, PENALTIES]);
  const nativeOwnership = Array.from(guest.subarray(BOARD, BOARD + 361)).join('');
  diagnostics?.({ preliminaryOwnership, initialGroups, groups, nativeOwnership });
  return { ret: 0, board_size: 19, judge_status: Array.from(guest.subarray(BOARD, BOARD + 361), n => n === 1 || n === 2 ? n : 0).join(''),
    black_penalty: guest[PENALTIES], white_penalty: guest[PENALTIES + 1] };
}
