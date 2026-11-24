"""Dev check (app 2.58): the Update button's fetch_update.
Run: python3 desktop/dev/update.py"""
import importlib.util, os, sys, tempfile, threading, http.server, functools, re
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('vt', os.path.join(here, '..', 'vex_trainer.py'))
vt = importlib.util.module_from_spec(spec); spec.loader.exec_module(vt)
src = open(os.path.join(here, '..', 'vex_trainer.py')).read()
site = tempfile.mkdtemp(); os.makedirs(os.path.join(site, 'desktop'))
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(http.server.SimpleHTTPRequestHandler, directory=site))
srv.RequestHandlerClass.log_message = lambda *a: None
threading.Thread(target=srv.serve_forever, daemon=True).start()
cfg = {'site': 'http://127.0.0.1:%d' % srv.server_address[1]}
os.environ.pop('HTTP_PROXY', None); os.environ.pop('HTTPS_PROXY', None); os.environ.pop('http_proxy', None); os.environ.pop('https_proxy', None)
os.environ['NO_PROXY'] = '127.0.0.1'
target = os.path.join(tempfile.mkdtemp(), 'vex_trainer.py'); open(target, 'w').write('old')
ok = n = 0
def check(name, cond):
    global ok, n
    n += 1; ok += bool(cond); print(('  ok   ' if cond else '  FAIL ') + name)
def serve(text):
    open(os.path.join(site, 'desktop', 'vex_trainer.py'), 'w').write(text)
serve(src)
r = vt.fetch_update(cfg, target); check('the same version: up to date, nothing replaced', r.get('newest') and open(target).read() == 'old')
newer = re.sub(r"^VERSION = '[0-9.]+'", "VERSION = '9.99'", src, flags=re.M)
serve(newer[:len(newer) // 2])
r = vt.fetch_update(cfg, target); check('half a download: refused, nothing replaced', r.get('error') and open(target).read() == 'old')
serve('<html>not found</html>')
r = vt.fetch_update(cfg, target); check('not the program: refused', r.get('error') and open(target).read() == 'old')
serve(newer)
r = vt.fetch_update(cfg, target); check('a newer version: put in place', r.get('to') == '9.99' and open(target).read() == newer and not os.path.exists(target + '.new'))
check('versions compare as numbers', vt.version_key('2.10') > vt.version_key('2.9'))
srv.shutdown()
print('%d of %d ok' % (ok, n)); sys.exit(0 if ok == n else 1)
