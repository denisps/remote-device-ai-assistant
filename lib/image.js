'use strict';

const fs = require('fs');
const zlib = require('zlib');
const { encodePNG } = require('vnc-tool/lib/png');

// internal utilities -------------------------------------------------------
function decodePNG(buf) {
  let pos = 8;
  let width = 0, height = 0;
  const idats = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString('ascii');
    const data = buf.slice(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    else if (type === 'IDAT') { idats.push(data); }
    else if (type === 'IEND') { break; }
  }
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const rgba = Buffer.alloc(width * height * 4);
  const row = 1 + width * 4;
  for (let y = 0; y < height; y++) {
    raw.copy(rgba, y * width * 4, y * row + 1, (y + 1) * row);
  }
  return { width, height, rgba };
}

function scaleRGBA(rgba, srcW, srcH, dstW, dstH) {
  const out = Buffer.alloc(dstW * dstH * 4);
  const xR = srcW / dstW;
  const yR = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const sy = Math.floor(y * yR);
    for (let x = 0; x < dstW; x++) {
      const sx = Math.floor(x * xR);
      const src = (sy * srcW + sx) * 4;
      const dst = (y * dstW + x) * 4;
      out[dst] = rgba[src];
      out[dst + 1] = rgba[src + 1];
      out[dst + 2] = rgba[src + 2];
      out[dst + 3] = rgba[src + 3];
    }
  }
  return out;
}

// drawing helpers ---------------------------------------------------------
const DIGIT_GLYPHS = [
  [0b1110,0b1010,0b1010,0b1010,0b1010,0b1110],
  [0b0100,0b1100,0b0100,0b0100,0b0100,0b1110],
  [0b1110,0b0010,0b0110,0b1100,0b1000,0b1110],
  [0b1110,0b0010,0b0110,0b0010,0b0010,0b1110],
  [0b1010,0b1010,0b1110,0b0010,0b0010,0b0010],
  [0b1110,0b1000,0b1110,0b0010,0b0010,0b1110],
  [0b1110,0b1000,0b1110,0b1010,0b1010,0b1110],
  [0b1110,0b0010,0b0100,0b0100,0b0100,0b0100],
  [0b1110,0b1010,0b1110,0b1010,0b1010,0b1110],
  [0b1110,0b1010,0b1110,0b0010,0b0010,0b1110],
];
const GLYPH_W = 4, GLYPH_H = 6;

function drawPixel(rgba,w,h,x,y,r,g,b){
  if(x<0||x>=w||y<0||y>=h) return;
  const i=(y*w+x)*4;
  rgba[i]=r;rgba[i+1]=g;rgba[i+2]=b;rgba[i+3]=255;
}

function drawLabel(rgba,w,h,x,y,label,r,g,b){
  let cx=x;
  for(const ch of String(label)){
    const d=parseInt(ch,10);
    if(isNaN(d)){cx+=GLYPH_W+1;continue;}
    const glyph=DIGIT_GLYPHS[d];
    for(let row=0;row<GLYPH_H;row++){
      for(let col=0;col<GLYPH_W;col++){
        if(glyph[row]&(0b1000>>col)){
          drawPixel(rgba,w,h,cx+col,y+row,r,g,b);
        }
      }
    }
    cx+=GLYPH_W+1;
  }
}

function overlayGrid(rgba,w,h,step=100){
  const LR=0,LG=230,LB=0;
  const TR=255,TG=255,TB=0;
  const xPositions=[];
  const yPositions=[];
  for(let u=0;u<=1000;u+=step){
    xPositions.push({px:Math.round(u/1000*(w-1)),label:u});
    yPositions.push({px:Math.round(u/1000*(h-1)),label:u});
  }
  for(const{x}of xPositions){for(let y=0;y<h;y++)drawPixel(rgba,w,h,x,y,LR,LG,LB);}
  for(const{px:y}of yPositions){for(let x=0;x<w;x++)drawPixel(rgba,w,h,x,y,LR,LG,LB);}
  for(const{px:gx,label:lx}of xPositions){
    for(const{px:gy,label:ly}of yPositions){
      const label=`${lx},${ly}`;
      const lw=label.length*(GLYPH_W+1);
      for(let bx=gx+1;bx<gx+1+lw&&bx<w;bx++){
        for(let by=gy+1;by<gy+1+GLYPH_H+2&&by<h;by++){
          drawPixel(rgba,w,h,bx,by,0,0,0);
        }
      }
      drawLabel(rgba,w,h,gx+2,gy+2,label,TR,TG,TB);
    }
  }
}

function drawCursor(rgba,w,h,cx,cy){
  const shape=[
    [1,0,0,0,0,0,0,0,0,0,0],
    [1,1,0,0,0,0,0,0,0,0,0],
    [1,2,1,0,0,0,0,0,0,0,0],
    [1,2,2,1,0,0,0,0,0,0,0],
    [1,2,2,2,1,0,0,0,0,0,0],
    [1,2,2,2,2,1,0,0,0,0,0],
    [1,2,2,2,2,2,1,0,0,0,0],
    [1,2,2,2,2,2,2,1,0,0,0],
    [1,2,2,2,1,1,1,1,1,0,0],
    [1,2,1,1,0,0,0,0,0,0,0],
    [1,1,0,1,1,0,0,0,0,0,0],
  ];
  for(let dy=0;dy<shape.length;dy++){
    for(let dx=0;dx<shape[dy].length;dx++){
      const px=cx+dx;
      const py=cy+dy;
      if(px<0||px>=w||py<0||py>=h)continue;
      const val=shape[dy][dx];
      if(val===0)continue;
      const idx=(py*w+px)*4;
      if(val===1){rgba[idx]=0;rgba[idx+1]=0;rgba[idx+2]=0;rgba[idx+3]=255;}else if(val===2){rgba[idx]=255;rgba[idx+1]=255;rgba[idx+2]=255;rgba[idx+3]=255;}
    }
  }
}

// ── Classes ---------------------------------------------------------------

class ImageRaw {
  constructor(width,height,rgba){this.width=width;this.height=height;this.rgba=rgba;}
  static fromRaw(width,height,rgba){return new ImageRaw(width,height,rgba);}  
  static fromPNG(pngBuf){const{width,height,rgba}=decodePNG(pngBuf);return new ImageRaw(width,height,rgba);}  
  resize(maxWidth){if(this.width<=maxWidth)return this;const dstW=maxWidth;const dstH=Math.round(this.height*maxWidth/this.width);const scaled=scaleRGBA(this.rgba,this.width,this.height,dstW,dstH);return new ImageRaw(dstW,dstH,scaled);}  
  drawCursor(cx,cy){drawCursor(this.rgba,this.width,this.height,cx,cy);return this;}  
  overlayGrid(step){overlayGrid(this.rgba,this.width,this.height,step);return this;}  
  encodePNG(){const buf=encodePNG(this.width,this.height,this.rgba);return new ImagePNG(buf,this.width,this.height);}  
}

class ImagePNG {
  constructor(buffer,width,height){this.buffer=buffer;this.width=width;this.height=height;}
  // previously synchronous (fs.writeFileSync); saving large screenshots could
  // block the event loop. Return a promise so callers can fire-and-forget and
  // await later if desired.
  save(filename){
    return fs.promises.writeFile(filename,this.buffer);
  }
  encodeForModel(){return`data:image/png;base64,${this.buffer.toString('base64')}`;}  
}

module.exports = {ImageRaw,ImagePNG};
