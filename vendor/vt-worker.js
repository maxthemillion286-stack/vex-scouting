// The robot finder, on its own thread.
//
// One of these runs per match being watched, so several matches are examined
// at once. Each holds its own copy of the model. The page sends the 640×640
// picture the model wants as RGBA bytes; the raw answer goes back, and the
// page turns it into boxes.
//
// v98: the graphics card first. On the processor one look takes 150–350 ms,
// which with four matches at 2× was about three looks a second in total —
// reported as "watching in very very low fps". WebGPU does the same sum in a
// fraction of that. It is TRIED, timed on a real picture, and kept only if it
// loads, runs and answers; anything else falls back to the processor build,
// which is the one that has been checked against the original Python.
const N = 640 * 640;
let session = null, backend = 'processor';
async function make(script, providers) {
  importScripts(script);
  ort.env.wasm.wasmPaths = '/vendor/ort/';
  ort.env.wasm.numThreads = 1;
  const s = await ort.InferenceSession.create('/models/robot_detector.onnx', { executionProviders: providers });
  // One real run before it is trusted: a session can be created and still fail.
  const res = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * N).fill(0.4), [1, 3, 640, 640]) });
  const out = res[s.outputNames[0]];
  const data = out.getData ? await out.getData() : out.data;
  if (!data || data.length !== 5 * 8400 || !Number.isFinite(data[4 * 8400])) throw new Error('unexpected answer');
  return s;
}
const ready = (async () => {
  const want = !(self.location.search || '').includes('cpu');
  if (want && self.navigator && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) { session = await make('/vendor/ort/ort.webgpu.min.js', ['webgpu']); backend = 'graphics card'; }
    } catch (e) { session = null; }
  }
  if (!session) { session = await make('/vendor/ort/ort.wasm.min.js', ['wasm']); backend = 'processor'; }
  postMessage({ ready: true, backend });
})().catch(e => postMessage({ ready: false, error: String((e && e.message) || e) }));
onmessage = async ev => {
  const { id, rgba } = ev.data;
  try {
    await ready;
    const px = new Uint8ClampedArray(rgba), f = new Float32Array(3 * N);
    for (let i = 0, p = 0; i < N; i++, p += 4) { f[i] = px[p] / 255; f[N + i] = px[p + 1] / 255; f[2 * N + i] = px[p + 2] / 255; }
    const res = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, 640, 640]) });
    const out = res[session.outputNames[0]];
    const data = new Float32Array(out.getData ? await out.getData() : out.data);
    postMessage({ id, n: out.dims[out.dims.length - 1], out: data.buffer, rgba }, [data.buffer, rgba]);
  } catch (e) {
    postMessage({ id, error: String((e && e.message) || e), rgba }, [rgba]);
  }
};
