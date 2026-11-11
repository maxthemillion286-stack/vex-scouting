// The robot finder, on its own thread (v92).
//
// One of these runs per match being watched, so several matches are examined
// at once on separate processor cores. Each holds its own copy of the model.
// The page sends the 640×640 picture the model wants as RGBA bytes; the raw
// answer goes back, and the page turns it into boxes.
importScripts('/vendor/ort/ort.wasm.min.js');
ort.env.wasm.wasmPaths = '/vendor/ort/';
ort.env.wasm.numThreads = 1;
let session = null;
const ready = ort.InferenceSession.create('/models/robot_detector.onnx', { executionProviders: ['wasm'] })
  .then(s => { session = s; postMessage({ ready: true }); })
  .catch(e => postMessage({ ready: false, error: String((e && e.message) || e) }));
const N = 640 * 640;
onmessage = async ev => {
  const { id, rgba } = ev.data;
  try {
    await ready;
    const px = new Uint8ClampedArray(rgba), f = new Float32Array(3 * N);
    for (let i = 0, p = 0; i < N; i++, p += 4) { f[i] = px[p] / 255; f[N + i] = px[p + 1] / 255; f[2 * N + i] = px[p + 2] / 255; }
    const res = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, 640, 640]) });
    const out = res[session.outputNames[0]];
    const data = new Float32Array(out.data);
    postMessage({ id, n: out.dims[out.dims.length - 1], out: data.buffer, rgba }, [data.buffer, rgba]);
  } catch (e) {
    postMessage({ id, error: String((e && e.message) || e), rgba }, [rgba]);
  }
};
