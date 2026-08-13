import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const SP='/tmp/claude-0/-home-user-GradationCapture/e8211451-920c-5fba-b104-722d7d1142d9/scratchpad';
const SLAB1=['','','','139.4','273.9','','624.7','884.6','1041.4','1147.8','1267.6','1329.0','1352.6','1443.6','1447.0'];
const SLAB2=['','','','53.0','145.4','','555.1','874.8','1079.1','1200.6','1273.0','1315.0','1342.2','1475.5','1476.6'];
const TRUTHS={};
['slab1-rot90','slab1-tilted'].forEach(n=>TRUTHS[n]=SLAB1);
['slab2-02','slab2-03','slab2-04','slab2-05','slab2-06','slab2-07','slab2-08','slab2-09','slab2-10','slab2-11','slab2-12','slab2-13','slab2-flat1'].forEach(n=>TRUTHS[n]=SLAB2);
const TRUTH=SLAB2;
const TRY=(process.argv[2]||Object.keys(TRUTHS).join(',')).split(',');
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1500,height:1200}});
page.on('pageerror',e=>console.log('PAGEERROR:',e.message));
await page.goto('http://127.0.0.1:8412/index.html');
await page.waitForSelector('#sieveBody tr');
const res=await page.evaluate(async (args)=>{
  const {TRY,TRUTHS}=args;
  const model=decodeModel(MODEL_WEIGHTS_B64,MODEL_META);
  const out=[]; const panels=[];

  function comps(mask,w,h){
    const seen=new Uint8Array(w*h),q=new Int32Array(w*h),list=[];
    for(let s=0;s<w*h;s++){
      if(seen[s]||!mask[s])continue;
      let head=0,tail=0;q[tail++]=s;seen[s]=1;
      let minX=w,maxX=-1,minY=h,maxY=-1,n=0;
      while(head<tail){const p=q[head++];const x=p%w,y=(p/w)|0;n++;
        if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;
        if(x>0&&!seen[p-1]&&mask[p-1]){seen[p-1]=1;q[tail++]=p-1;}
        if(x<w-1&&!seen[p+1]&&mask[p+1]){seen[p+1]=1;q[tail++]=p+1;}
        if(y>0&&!seen[p-w]&&mask[p-w]){seen[p-w]=1;q[tail++]=p-w;}
        if(y<h-1&&!seen[p+w]&&mask[p+w]){seen[p+w]=1;q[tail++]=p+w;}
        // 8-connected helps broken strokes
        if(x>0&&y>0&&!seen[p-w-1]&&mask[p-w-1]){seen[p-w-1]=1;q[tail++]=p-w-1;}
        if(x<w-1&&y>0&&!seen[p-w+1]&&mask[p-w+1]){seen[p-w+1]=1;q[tail++]=p-w+1;}
        if(x>0&&y<h-1&&!seen[p+w-1]&&mask[p+w-1]){seen[p+w-1]=1;q[tail++]=p+w-1;}
        if(x<w-1&&y<h-1&&!seen[p+w+1]&&mask[p+w+1]){seen[p+w+1]=1;q[tail++]=p+w+1;}
      }
      list.push({minX,maxX,minY,maxY,n,w:maxX-minX+1,h:maxY-minY+1});
    }
    return list;
  }

  for(const name of TRY){ const TRUTH=TRUTHS[name]||[];
    const img=new Image();
    await new Promise((r,j)=>{img.onload=r;img.onerror=j;img.src=`test/fixtures/photos/${name}.jpg`;});
    const W=1600,H=Math.round(img.naturalHeight*W/img.naturalWidth);
    const c=document.createElement('canvas');c.width=W;c.height=H;
    const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0,W,H);
    const flat=rectifyPage(toGrayscale(ctx.getImageData(0,0,W,H).data,W,H),W,H,2400);
    if(!flat){out.push({name,err:'no page'});continue;}
    let g=flat.gray,gw=flat.w,gh=flat.h;
    if(gh>gw){const r=rotate90(g,gw,gh,1);g=r.gray;gw=r.w;gh=r.h;}
    // choose upright vs upside-down by which puts the printed sieve labels on the left
    let bestTurn=0,bestScore=-Infinity,snap=null;
    for(const t of [0,2]){
      const r=rotate90(g,gw,gh,t);
      const sn=snapTemplate(r.gray,r.w,r.h,0,CONFIG.sieves);
      const sc=uprightScore(sn,r.w,r.h);
      if(sc>bestScore){bestScore=sc;bestTurn=t;snap=sn;}
    }
    if(bestTurn){const r=rotate90(g,gw,gh,bestTurn);g=r.gray;gw=r.w;gh=r.h;}

    const reads=[];
    const cells=snappedCells(snap,CONFIG.sieves);
    const strip=document.createElement('canvas');strip.width=260;strip.height=cells.length*34+30;
    const so=strip.getContext('2d');so.fillStyle='#fff';so.fillRect(0,0,strip.width,strip.height);
    so.fillStyle='#000';so.font='bold 14px sans-serif';so.fillText(name,4,16);
    cells.forEach((cell,ci)=>{
      const cw=cell.w,ch=cell.h;
      const sub=new Float32Array(cw*ch);
      for(let y=0;y<ch;y++)for(let x=0;x<cw;x++){
        const sx=cell.x+x,sy=cell.y+y;
        sub[y*cw+x]=(sx>=0&&sy>=0&&sx<gw&&sy<gh)?g[sy*gw+sx]:1;
      }
      const m=inkMask(sub,cw,ch,0.12,Math.max(4,Math.round(ch/2)));
      // clear a margin: the printed rules are 2-3px thick and sit just inside
      const bx=Math.max(2,Math.round(cw*0.06)),by=Math.max(2,Math.round(ch*0.10));
      for(let y=0;y<ch;y++)for(let x=0;x<cw;x++)
        if(x<bx||x>=cw-bx||y<by||y>=ch-by) m[y*cw+x]=0;
      const cs=comps(m,cw,ch).filter(k=>
        k.n>=Math.max(4,cw*ch*0.004) &&
        k.h>=ch*0.22 &&
        k.h<=ch*0.95 &&            // spans the cell => it is a rule, not a digit
        !(k.w<=2&&k.h>ch*0.4) &&   // thin vertical line
        k.w<=cw*0.6);              // absurdly wide blob
      cs.sort((a,b)=>a.minX-b.minX);
      let text='';
      const probsList=[];
      cs.forEach(k=>{
        const kw=k.w,kh=k.h;const gl=new Float32Array(kw*kh);
        for(let y=0;y<kh;y++)for(let x=0;x<kw;x++)
          gl[y*kw+x]=m[(k.minY+y)*cw+(k.minX+x)]?1:0;
        const px=prepareGlyph(gl,kw,kh);
        const r=classifyGlyph(px,model);
        text+=r.digit; probsList.push(r.probs);
      });
      const val=text.length>1?text.slice(0,-1)+'.'+text.slice(-1):(text?'0.'+text:'');
      reads.push({key:cell.key,text:val,n:cs.length});
      // draw the cell strip
      const y0=24+ci*34;
      const tmp=document.createElement('canvas');tmp.width=cw;tmp.height=ch;
      const t=tmp.getContext('2d');const tid=t.createImageData(cw,ch);
      for(let i=0;i<cw*ch;i++){const v=m[i]?0:255;tid.data[i*4]=tid.data[i*4+1]=tid.data[i*4+2]=v;tid.data[i*4+3]=255;}
      t.putImageData(tid,0,0);
      so.drawImage(tmp,4,y0,120,30);
      so.fillStyle='#000';so.font='12px monospace';
      so.fillText(`${val||'-'} (${cs.length})`,132,y0+20);
      so.fillStyle='#888';so.fillText(TRUTH[ci]||'', 210, y0+20);
    });
    panels.push(strip);
    const hits=reads.filter((r,i)=>TRUTH[i]&&r.text===TRUTH[i]).length;
    let dOK=0,dTot=0;
    TRUTH.forEach((t,i)=>{ if(!t)return; const got=(reads[i]&&reads[i].text)||'';
      const a=t.replace('.',''),b=got.replace('.','');
      for(let k=0;k<a.length;k++){dTot++; if(b.length===a.length&&b[k]===a[k])dOK++;} });
    const expected=TRUTH.filter(Boolean).length;
    out.push({name,hits,expected,dOK,dTot,turn:bestTurn*180,snap:Object.values(snap.snapped).filter(Boolean).length,reads:reads.map(r=>r.text||'-').join(' ')});
  }
  document.body.innerHTML='';document.body.style.cssText='background:#fff;margin:0';
  panels.forEach(p=>{p.style.cssText='display:inline-block;border:1px solid #999;margin:2px;vertical-align:top';document.body.appendChild(p);});
  return out;
},{TRY,TRUTHS});
res.forEach(r=>console.log(r.err?`${r.name}: ${r.err}`:`${(r.name+'            ').slice(0,14)} ${r.hits}/${r.expected} cells  ${r.dOK}/${r.dTot} digits  snap=${r.snap}/4 | ${r.reads}`));
await page.screenshot({path:SP+'/read.png',fullPage:true});
await browser.close();
