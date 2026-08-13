import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const SP='/tmp/claude-0/-home-user-GradationCapture/e8211451-920c-5fba-b104-722d7d1142d9/scratchpad';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport:{width:1300,height:1100}, deviceScaleFactor:2 });
page.on('pageerror',e=>console.log('PAGEERROR:',e.message));
await page.goto('http://127.0.0.1:8412/index.html');
await page.waitForSelector('#sieveBody tr');
await page.evaluate(async () => {
  const img=new Image();
  await new Promise((r,j)=>{img.onload=r;img.onerror=j;img.src='test/fixtures/photos/slab2-flat1.jpg';});
  const W=1000,H=Math.round(img.naturalHeight*W/img.naturalWidth);
  const c=document.createElement('canvas');c.width=W;c.height=H;
  const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0,W,H);
  const flat=rectifyPage(toGrayscale(ctx.getImageData(0,0,W,H).data,W,H),W,H,1000);
  let g=flat.gray,gw=flat.w,gh=flat.h;
  if(gh>gw){const r=rotate90(g,gw,gh,1);g=r.gray;gw=r.w;gh=r.h;}
  const cv=document.createElement('canvas');cv.width=gw;cv.height=gh;
  const o=cv.getContext('2d');const id=o.createImageData(gw,gh);
  for(let i=0;i<gw*gh;i++){const v=Math.max(0,Math.min(255,g[i]*255));id.data[i*4]=id.data[i*4+1]=id.data[i*4+2]=v;id.data[i*4+3]=255;}
  o.putImageData(id,0,0);
  o.font='11px sans-serif';
  for(let p=0;p<=100;p+=5){
    const x=gw*p/100,y=gh*p/100;
    o.strokeStyle=(p%25===0)?'rgba(255,0,0,.85)':'rgba(0,120,255,.45)';
    o.lineWidth=(p%25===0)?1.5:0.7;
    o.beginPath();o.moveTo(x,0);o.lineTo(x,gh);o.stroke();
    o.beginPath();o.moveTo(0,y);o.lineTo(gw,y);o.stroke();
    o.fillStyle='#c00';o.fillText(p, x+2, 11); o.fillText(p, 2, y-2);
  }
  document.body.innerHTML='';document.body.style.cssText='margin:0;background:#fff';
  cv.style.cssText='width:1240px;display:block';
  document.body.appendChild(cv);
});
await page.screenshot({path:SP+'/measure.png',fullPage:true});
await browser.close();
