

export async function compileScoreWasm(url: string,
  loader: (url: string) => Promise<Uint8Array> = async url => {
    const response = await fetch(url);
    if (!response.ok) throw Error('Score engine asset unavailable');
    return new Uint8Array(await response.arrayBuffer());
  }, compiler: (bytes: Uint8Array) => Promise<WebAssembly.Module> = bytes =>
    WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>)) {
  return compiler(await loader(url));
}
