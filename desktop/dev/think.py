"""The vision-model plumbing against a stand-in for Ollama (no model can be downloaded here)."""
import json, sys, threading, base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, 'run')
import cv2, numpy as np, vex_trainer as T
seen = {'chat': [], 'pulled': False, 'mode': 'ok'}
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj, raw=None):
        b = raw if raw is not None else json.dumps(obj).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path == '/api/version': return self._send(200, {'version': '0.0-standin'})
        if self.path == '/api/tags': return self._send(200, {'models': [{'name': 'qwen3-vl:8b'}] if seen['pulled'] else []})
        self._send(404, {})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path == '/api/pull':
            seen['pulled'] = True
            return self._send(200, None, b'{"status":"pulling","total":1000,"completed":400}\n{"status":"pulling","total":1000,"completed":1000}\n{"status":"success"}\n')
        if self.path == '/api/chat':
            if seen['mode'] == 'nothink' and 'think' in body: return self._send(400, {'error': 'does not support thinking'})
            seen['chat'].append(body)
            n = body['format']['properties']['robots']['maxItems']
            teams = body['format']['properties']['robots']['items']['properties']['plate']['enum']
            if seen['mode'] == 'junk': return self._send(200, {'message': {'content': 'I think the robots are great'}})
            robots = [{'n': 1, 'plate': teams[1], 'doing': 'stacking pins on a goal'}, {'n': 2, 'plate': 'unreadable', 'doing': 'driving'}]
            if n >= 3: robots.append({'n': 3, 'plate': teams[1] if seen['mode'] == 'twice' else teams[2], 'doing': 'at a toggle'})
            if n >= 4: robots.append({'n': 4, 'plate': 'unreadable', 'doing': 'cannot tell'})
            return self._send(200, {'message': {'role': 'assistant', 'content': json.dumps({'robots': robots})}, 'done': True})
        self._send(404, {})
srv = ThreadingHTTPServer(('127.0.0.1', 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
T.OLLAMA = 'http://127.0.0.1:%d' % srv.server_address[1]
ok = fail = 0
def check(name, cond, detail=''):
    global ok, fail
    if cond: ok += 1
    else: fail += 1; print('  FAIL', name, detail)
cfg = {'think': True}
check('it answers', T.ollama_up())
check('no model yet', not T.have_think_model(cfg))
check('fetching it gets it', T.ensure_think(cfg) and seen['pulled'] and T.have_think_model(cfg))
img = cv2.imread(sys.argv[1])
boxes = [[341, 463, 301, 316, 0.9, 1, None, 0], [1943, 450, 286, 301, 0.9, 1, None, 0], [923, 551, 268, 331, 0.9, 2, None, 0], [527, 277, 252, 250, 0.9, 0, None, 0]]
jpeg, n = T.think_picture(img, boxes)
check('a numbered picture is made, 1280 wide', n == 4 and jpeg[:2] == b'\xff\xd8' and cv2.imdecode(np.frombuffer(jpeg, np.uint8), 1).shape[1] == 1280)
open('think_pic.jpg', 'wb').write(jpeg)
job = {'red': ['2499B', '66449A'], 'blue': ['6722A', '8838C']}
def frame():
    fr = [305, 4]
    for b in boxes: fr += [int(b[0] / 4), int(b[1] / 4), int(b[2] / 4), int(b[3] / 4), 90, b[5], 0, 0, 0, 0]
    return fr
fr = frame(); rec = {'f': [fr]}
got = T.think_match(rec, [(fr, jpeg, 4)], job, cfg)
vo = rec.get('vo', [])
check('one frame answered', got == 1)
check('robot 1: stacking, plate 66449A (who 2)', vo[0:5] == [305, fr[2], fr[3], 1, 2], str(vo[0:5]))
check('robot 2: driving, no plate', vo[5:10] == [305, fr[12], fr[13], 6, 0], str(vo[5:10]))
check('robot 3: at a toggle, blue plate on a blue robot kept', vo[10:15] == [305, fr[22], fr[23], 4, 3], str(vo[10:15]))
check('robot 4: cannot tell and unreadable leaves nothing', len(vo) == 15)
b = seen['chat'][-1]
check('the model is asked with the picture, a fixed form, no reasoning, no randomness', b['model'] == 'qwen3-vl:8b' and b['stream'] is False and b['think'] is False and b['options']['temperature'] == 0 and len(b['messages'][0]['images']) == 1 and base64.b64decode(b['messages'][0]['images'][0]) == jpeg)
check('the form only allows the four teams or unreadable', b['format']['properties']['robots']['items']['properties']['plate']['enum'] == ['2499B', '66449A', '6722A', '8838C', 'unreadable'])
check('the question names the alliances and says not to guess', 'Red alliance: 2499B, 66449A' in b['messages'][0]['content'] and 'Never guess' in b['messages'][0]['content'])
# a red team's number on a robot the tracker saw as blue is not believed
fr2 = frame(); fr2[2 + 5] = 2; rec2 = {'f': [fr2]}
T.think_match(rec2, [(fr2, jpeg, 4)], job, cfg)
check('a plate that contradicts the robot\'s colour is dropped, the action kept', rec2['vo'][0:5] == [305, fr2[2], fr2[3], 1, 0], str(rec2['vo'][0:5]))
# the same number on two robots
seen['mode'] = 'twice'; fr3 = frame(); fr3[2 + 20 + 5] = 1; rec3 = {'f': [fr3]}
T.think_match(rec3, [(fr3, jpeg, 4)], job, cfg)
check('one number given to two robots counts for neither', rec3['vo'][4] == 0 and rec3['vo'][14] == 0, str(rec3['vo']))
# a frame thinned out of the recording is not asked about
seen['mode'] = 'ok'; nchat = len(seen['chat']); rec4 = {'f': [frame()]}
check('a dropped frame is skipped', T.think_match(rec4, [(frame(), jpeg, 4)], job, cfg) == 0 and len(seen['chat']) == nchat and 'vo' not in rec4)
# a model without the reasoning switch
seen['mode'] = 'nothink'; fr5 = frame(); rec5 = {'f': [fr5]}
check('a model with no reasoning switch is asked again without it', T.think_match(rec5, [(fr5, jpeg, 4)], job, cfg) == 1 and 'think' not in seen['chat'][-1] and T._THINK['plain'])
# rubbish back
seen['mode'] = 'junk'; fr6 = frame(); rec6 = {'f': [fr6]}
check('an answer that is not the form is ignored', T.think_match(rec6, [(fr6, jpeg, 4)], job, cfg) == 0 and 'vo' not in rec6)
T._THINK['failed'] = 3; seen['mode'] = 'ok'; nchat = len(seen['chat']); fr7 = frame()
check('after three failures it stops asking', T.think_match({'f': [fr7]}, [(fr7, jpeg, 4)], job, cfg) == 0 and len(seen['chat']) == nchat)
print('%d passed, %d failed' % (ok, fail)); sys.exit(1 if fail else 0)
