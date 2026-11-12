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
// ── Reading a licence plate (v101) ─────────────────────────────────────────
// A second, small model (PP-OCRv3 recognition, the one the desktop tracker
// uses through RapidOCR). The page cuts out the plate and sends it as a
// 160×48 RGBA strip; this answers with the letters and digits it read. It
// always runs on the processor: it is small, and one fixed shape on the
// processor is steadier than recompiling for the graphics card.
// PLATE_CHARS maps the model's 6,625 outputs to the 62 that can be on a plate.
const PLATE_CHARS = {"25":"2","26":"0","27":"8","29":"7","93":"1","94":"3","425":"H","631":"5","632":"4","933":"6","1033":"s","1034":"u","1109":"9","1217":"S","1218":"Y","1219":"F","1220":"D","1221":"A","1310":"P","1381":"T","1958":"r","2156":"q","2697":"J","2710":"l","2993":"x","3316":"z","3332":"e","3333":"t","3463":"b","3506":"L","3537":"w","3538":"i","3539":"h","3587":"I","3588":"B","3589":"N","3639":"M","4136":"Z","4244":"C","4245":"o","4381":"E","4389":"f","4497":"U","4544":"a","4545":"p","4546":"y","4547":"n","4548":"g","4731":"Q","4741":"O","4849":"k","4902":"c","4922":"v","5033":"W","5127":"R","5128":"G","5171":"d","5193":"K","5200":"X","5233":"m","5405":"V","5493":"j"};
const PW = 160, PH = 48;
let reader = null, readerFailed = false;
async function read(rgba, used) {
  if (readerFailed) return { text: '', conf: 0 };
  if (!reader) {
    try { reader = await ort.InferenceSession.create('/models/plate_reader.onnx', { executionProviders: ['wasm'] }); }
    catch (e) { readerFailed = true; return { text: '', conf: 0 }; }
  }
  const px = new Uint8ClampedArray(rgba), n = PW * PH, f = new Float32Array(3 * n);
  // Columns past the plate stay at zero, as the model was trained to expect.
  for (let y = 0; y < PH; y++) for (let x = 0; x < used; x++) {
    const i = y * PW + x, p = i * 4;
    f[i] = (px[p] / 255 - 0.5) / 0.5; f[n + i] = (px[p + 1] / 255 - 0.5) / 0.5; f[2 * n + i] = (px[p + 2] / 255 - 0.5) / 0.5;
  }
  const res = await reader.run({ [reader.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, PH, PW]) });
  const out = res[reader.outputNames[0]], T = out.dims[1], C = out.dims[2], d = out.data;
  let text = '', sum = 0, cnt = 0, last = 0;
  for (let t = 0; t < T; t++) {
    let bi = 0, bv = -1;
    for (let c = 0, o = t * C; c < C; c++) { const v = d[o + c]; if (v > bv) { bv = v; bi = c; } }
    if (bi !== 0 && bi !== last) { const ch = PLATE_CHARS[bi]; if (ch) { text += ch; sum += bv; cnt++; } }
    last = bi;
  }
  return { text, conf: cnt ? sum / cnt : 0 };
}
onmessage = async ev => {
  const { id, rgba } = ev.data;
  if (ev.data.plate) {
    try { await ready; const r = await read(rgba, ev.data.used || PW); postMessage({ id, text: r.text, conf: r.conf }); }
    catch (e) { postMessage({ id, text: '', conf: 0 }); }
    return;
  }
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
