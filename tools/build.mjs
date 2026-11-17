// Makes the index.html that is served from src/index.html, the one that is
// edited: comments out, script and styles packed. Asked for twice ("remove
// comments"). The source keeps every comment; visitors download about half
// as much.
//
//   node tools/build.mjs           write index.html
//   node tools/build.mjs --check   exit 1 if index.html is not what src builds
//
// Names are NOT shortened: the page's buttons call its functions by name.
// A block that will not pack is left as written rather than risk the page.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { transformSync } from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOTE = '<!-- Built from src/index.html by tools/build.mjs. Edit that file, not this one. -->';

export function build(html) {
  const warn = [];
  const pack = (code, loader) => {
    try {
      return transformSync(code, loader === 'js'
        ? { loader: 'js', minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false, legalComments: 'none', charset: 'utf8', lineLimit: 1000 }
        : { loader: 'css', minify: true, legalComments: 'none', charset: 'utf8', lineLimit: 1000 }).code.trim();
    } catch (e) { warn.push(loader + ': ' + String(e.message || e).split('\n')[0]); return code; }
  };
  // Script and style blocks packed; everything between them is markup, where
  // only comments and the blank lines they leave go.
  const out = [];
  const re = /<(script|style)>([\s\S]*?)<\/\1>/g;
  let at = 0, m;
  const markup = t => t.replace(/<!--[\s\S]*?-->/g, '').replace(/\n[ \t]*(?=\n)/g, '');
  while ((m = re.exec(html))) {
    out.push(markup(html.slice(at, m.index)));
    out.push(`<${m[1]}>${pack(m[2], m[1] === 'script' ? 'js' : 'css')}</${m[1]}>`);
    at = m.index + m[0].length;
  }
  out.push(markup(html.slice(at)));
  let page = out.join('');
  page = page.replace(/^(\s*<!doctype html>)/i, '$1\n' + NOTE);
  return { page, warn };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const src = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  const { page, warn } = build(src);
  for (const w of warn) console.error('left as written — ' + w);
  const dest = path.join(root, 'index.html');
  if (process.argv.includes('--check')) {
    const same = fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === page;
    console.log(same ? 'index.html is up to date' : 'index.html is NOT what src/index.html builds: run node tools/build.mjs');
    process.exit(same && !warn.length ? 0 : 1);
  }
  fs.writeFileSync(dest, page);
  console.log(`index.html: ${(src.length / 1024).toFixed(0)} KB → ${(page.length / 1024).toFixed(0)} KB`);
  if (warn.length) process.exit(1);
}
