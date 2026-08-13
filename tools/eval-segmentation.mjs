import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { readdirSync } from 'node:fs';
const SP = '/tmp/claude-0/-home-user-GradationCapture/e8211451-920c-5fba-b104-722d7d1142d9/scratchpad';
const PHOTOS = readdirSync('/home/user/GradationCapture/test/fixtures/photos')
  .filter(f => f.endsWith('.jpg')).map(f => f.replace('.jpg',''));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1400 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:8412/index.html');
await page.waitForSelector('#sieveBody tr');

const out = await page.evaluate(async (photos) => {
  const results = []; const panels = [];
  for (const name of photos) {
    const img = new Image();
    await new Promise((r,j)=>{img.onload=r;img.onerror=j;img.src=`test/fixtures/photos/${name}.jpg`;});
    const W = 1100, H = Math.round(img.naturalHeight * W / img.naturalWidth);
    const c = document.createElement('canvas'); c.width=W; c.height=H;
    const ctx = c.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(img,0,0,W,H);
    const t0 = performance.now();
    let seg;
    try { seg = segmentSheet(ctx.getImageData(0,0,W,H).data, W, H, 0); }
    catch (e) { results.push({name, ok:false, reason:'THREW '+e.message}); continue; }
    const ms = Math.round(performance.now()-t0);
    const g = seg.grid;
    const cv = document.createElement('canvas'); cv.width=g.w; cv.height=g.h;
    const o = cv.getContext('2d'); const id = o.createImageData(g.w,g.h);
    for (let i=0;i<g.w*g.h;i++){ const v=Math.max(0,Math.min(255,g.gray[i]*255));
      id.data[i*4]=id.data[i*4+1]=id.data[i*4+2]=v; id.data[i*4+3]=255; }
    o.putImageData(id,0,0);
    o.lineWidth=1; o.strokeStyle='rgba(255,40,0,.8)';
    g.rows.forEach(y=>{o.beginPath();o.moveTo(0,y);o.lineTo(g.w,y);o.stroke();});
    o.strokeStyle='rgba(255,0,255,.7)';
    g.cols.forEach(x=>{o.beginPath();o.moveTo(x,0);o.lineTo(x,g.h);o.stroke();});
    o.strokeStyle='#00e676'; o.lineWidth=3;
    seg.cells.forEach(cell=>o.strokeRect(cell.x,cell.y,cell.w,cell.h));
    o.fillStyle = seg.ok ? '#0a0' : '#d00'; o.font='bold 26px sans-serif';
    o.fillText(`${name} ${seg.ok?'OK':'FAIL'} t=${seg.turn*90} r=${g.rows.length} c=${g.cols.length}`, 8, 30);
    panels.push(cv);
    results.push({ name, ok: seg.ok, turn: seg.turn*90, reason: seg.reason, ms,
      rows: g.rows.length, cols: g.cols.length, cells: seg.cells.length, rp: g.rowPeaks.length, cp: g.colPeaks.length });
  }
  document.body.innerHTML=''; document.body.style.cssText='background:#fff;margin:0';
  panels.forEach(p=>{p.style.cssText='width:400px;display:inline-block;border:1px solid #666;margin:1px';document.body.appendChild(p);});
  return results;
}, PHOTOS);

const ok = out.filter(r=>r.ok).length;
out.forEach(r => console.log(`${r.ok?'PASS':'fail'} ${r.name.padEnd(22)} turn=${String(r.turn).padStart(3)} rows=${String(r.rows).padStart(2)}/${String(r.rp).padStart(2)} cols=${String(r.cols).padStart(2)}/${String(r.cp).padStart(2)} ${r.ms}ms ${r.ok?'':r.reason}`));
console.log(`\n==> ${ok}/${out.length} photos segmented`);
await page.screenshot({ path: SP + '/eval.png', fullPage: true });
await browser.close();
