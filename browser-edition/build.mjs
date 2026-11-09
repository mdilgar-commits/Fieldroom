// Builds the Fieldroom browser edition: a single page that runs inside claude.ai
// with no server. Project data is kept in the browser (IndexedDB) and AI extraction
// is answered by Claude through the page's `sample` capability.
//
//   npm run build:browser   ->  browser-edition/dist/
//
// The app's own files in public/ and the extraction instructions in server.mjs are
// the source of truth; this script copies them and applies small, checked patches.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'public');
const OUT = path.join(HERE, 'dist');
const read = p => fs.readFileSync(p, 'utf8');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'vendor/pdfjs'), { recursive: true });
for (const f of ['pdf.min.mjs', 'LICENSE']) fs.copyFileSync(path.join(SRC, 'vendor/pdfjs', f), path.join(OUT, 'vendor/pdfjs', f));
// The PDF.js worker contains raw control bytes that claude.ai's publisher rejects,
// so it ships base64-encoded and is started from a blob: URL at runtime.
fs.writeFileSync(path.join(OUT, 'vendor/pdfjs/pdf.worker.b64.txt'), fs.readFileSync(path.join(SRC, 'vendor/pdfjs/pdf.worker.min.mjs')).toString('base64'));
for (const f of ['fieldroom-logo.svg', 'fieldroom-logo-reversed.svg', 'qr-code-icon.svg']) fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));

let app = read(path.join(SRC, 'app.js'));
function rep(a, b, count = 1) {
  const n = app.split(a).length - 1;
  if (n !== count) throw new Error(`Expected ${count} match(es) in app.js, found ${n}: ${a.slice(0, 80)}`);
  app = app.split(a).join(b);
}
// Asset paths become relative to the page.
rep("import('/vendor/pdfjs/pdf.min.mjs')", "import(new URL('vendor/pdfjs/pdf.min.mjs',document.baseURI).href)");
rep(".then(pdfjs=>{pdfjs.GlobalWorkerOptions.workerSrc='/vendor/pdfjs/pdf.worker.min.mjs';return pdfjs})", ".then(async pdfjs=>{pdfjs.GlobalWorkerOptions.workerSrc=await frWorkerUrl();return pdfjs})");
rep('"/fieldroom-logo.svg', '"fieldroom-logo.svg');
rep('"/qr-code-icon.svg', '"qr-code-icon.svg');
// Documents and photos are always loaded through fetch (served from browser storage).
rep('runtimeConfig.authRequired?await protectedBlobUrl(', 'true?await protectedBlobUrl(', 3);
rep('${runtimeConfig.authRequired?`data-protected-media', '${true?`data-protected-media');
rep('if(!runtimeConfig.authRequired)return;', '');
// Wording and error display.
rep("'Gemini is configured on this server.'", "'AI extraction uses Claude. Review every result against the source.'");
rep("}catch(e){notify(e.message);if(button){button.disabled=false;button.textContent=button.id==='read-plan'", "}catch(e){frProgress(null);frAlert('Extraction did not finish.\\n\\n'+e.message);if(button){button.disabled=false;button.textContent=button.id==='read-plan'");
rep("'Local project server'", "'Saved in this browser'");
rep("'Fieldroom is running locally. Project data and uploads are stored on this computer. AI extraction requires a Gemini API key on the server and always needs human review.'",
  "'This is the Fieldroom web version. Your projects, documents, and photos are saved only in this browser on this device, so other people who open this page see their own empty project. AI extraction is done by Claude and always needs human review. QR camera scanning needs the full Fieldroom app.'");
// claude.ai blocks alert/confirm/prompt, so use on-page dialogs instead.
rep('if(!confirm(`Reset', 'if(!await frConfirm(`Reset');
rep('if(!doc||!confirm(', 'if(!doc||!await frConfirm(');
rep('addRoom.onclick=()=>{const number=prompt(', 'addRoom.onclick=async()=>{const number=await frAsk(');
rep("const name=prompt('Room name or use:')", "const name=await frAsk('Room name or use:')");
rep('b.onclick=()=>{const room=roomById(b.dataset.addDeliverable),title=prompt(', 'b.onclick=async()=>{const room=roomById(b.dataset.addDeliverable),title=await frAsk(');
rep('const trade=prompt(', 'const trade=await frAsk(');
rep("b.onclick=()=>{if(!confirm('Remove this deliverable", "b.onclick=async()=>{if(!await frConfirm('Remove this deliverable");
rep("prompt('Copy this room link:',url)", "frAsk('Copy this room link:',url)");
// Downloads go through claude.ai's download permission.
rep("const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='room-matrix.csv';a.click();URL.revokeObjectURL(a.href)}", "frSaveFile('room-matrix.csv',csv)}");
app = app.replace(/(?<![\w.$])alert\(/g, 'frAlert(');
const left = app.match(/(?<![\w.$])(prompt|confirm|alert)\(/g);
if (left) throw new Error('Unconverted browser dialogs remain: ' + left.join(', '));

// Extraction instructions are copied from server.mjs so both editions ask the same thing.
const server = read(path.join(ROOT, 'server.mjs'));
const between = (a, b, start = 0) => { const i = server.indexOf(a, start); const j = server.indexOf(b, i); if (i < 0 || j < 0) throw new Error('server.mjs changed; could not find: ' + a); return server.slice(i, j); };
const fn = server.indexOf('async function extractWithGemini');
let extract = read(path.join(HERE, 'extract-claude.js'));
for (const [key, value] of [
  ['/*__SERVER_HELPERS__*/', between('function singleRoomHintFromSetup', '\nasync function extractWithGemini')],
  ['/*__SERVER_PROMPT__*/', between('  const mapDoc = documents.find', '  for (const d of documents) {', fn)],
  ['/*__SERVER_POST__*/', between('  if(roomInventory.length===1){', '  return extracted;', fn)],
]) {
  if (extract.split(key).length !== 2) throw new Error('Missing placeholder ' + key);
  extract = extract.replace(key, () => value);
}
if (/process\.env|readStoredFile/.test(extract)) throw new Error('Server-only code leaked into the browser extraction.');
const backend = read(path.join(HERE, 'browser-backend.js')) + '\n' + extract;

const html = read(path.join(SRC, 'index.html'));
let body = html.match(/<body>([\s\S]*)<\/body>/)[1];
body = body.replace(/\s*<script[^>]*><\/script>/g, '').replaceAll('src="/', 'src="');
const css = read(path.join(SRC, 'styles.css')) + '\n' + read(path.join(SRC, 'project-review.css'));
const dialogCss = `
.fr-dialog-overlay{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:16px;background:rgba(15,25,20,.45)}
.fr-dialog{background:#fff;color:#1b2a22;border-radius:14px;padding:20px;width:min(420px,100%);display:grid;gap:14px;box-shadow:0 18px 50px rgba(0,0,0,.25)}
.fr-dialog-msg{margin:0;white-space:pre-wrap;line-height:1.45}
.fr-dialog-input{font:inherit;padding:10px 12px;border:1px solid #c9d3cc;border-radius:8px;width:100%;box-sizing:border-box}
.fr-dialog-actions{display:flex;gap:8px;justify-content:flex-end}
.fr-spinner{width:28px;height:28px;border:3px solid #dce9dc;border-top-color:#1d4030;border-radius:50%;animation:fr-spin 1s linear infinite;justify-self:center}
@keyframes fr-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.fr-spinner{animation:none}}
`;
if (/<\/script/i.test(app + backend)) throw new Error('Script text contains a closing script tag.');
const page = `<title>Fieldroom</title>
<meta name="theme-color" content="#152820">
<style>
${css}
${dialogCss}
</style>
${body}
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
${backend}
</script>
<script>
${app}
</script>
`;
fs.writeFileSync(path.join(OUT, 'fieldroom.html'), page);
console.log(`Built ${path.relative(ROOT, OUT)}/fieldroom.html (${page.length} bytes)`);
