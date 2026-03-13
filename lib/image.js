'use strict';

const fs = require('fs');
const { encodePNG, decodePNG } = require('vnc-tool/lib/png');

// internal utilities -------------------------------------------------------
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

/**
 * Raw RGBA image buffer.
 *
 * This is the in-memory representation used for screenshot processing, scaling
 * and simple drawing operations.
 */
class ImageRaw {
  /**
   * @param {number} width
   * @param {number} height
   * @param {Buffer} rgba   Raw RGBA pixel data (4 bytes per pixel)
   */
  constructor(width,height,rgba){this.width=width;this.height=height;this.rgba=rgba;}

  /**
   * Create an ImageRaw from raw RGBA data.
   * @param {number} width
   * @param {number} height
   * @param {Buffer} rgba
   * @returns {ImageRaw}
   */
  static fromRaw(width,height,rgba){return new ImageRaw(width,height,rgba);}  

  /**
   * Decode a PNG buffer into an ImageRaw.
   * @param {Buffer} pngBuf
   * @returns {ImageRaw}
   */
  static fromPNG(pngBuf){const{width,height,rgba}=decodePNG(pngBuf);return new ImageRaw(width,height,rgba);}  

  /**
   * Resize the image to the given maximum width, preserving aspect ratio.
   * Returns the same instance if no resizing is required.
   * @param {number} maxWidth
   * @returns {ImageRaw}
   */
  resize(maxWidth){if(this.width<=maxWidth)return this;const dstW=maxWidth;const dstH=Math.round(this.height*maxWidth/this.width);const scaled=scaleRGBA(this.rgba,this.width,this.height,dstW,dstH);return new ImageRaw(dstW,dstH,scaled);}  

  /**
   * Draw a cursor icon at the given location.
   * @param {number} cx
   * @param {number} cy
   * @returns {ImageRaw}
   */
  drawCursor(cx,cy){drawCursor(this.rgba,this.width,this.height,cx,cy);return this;}  

  /**
   * Overlay a grid with numeric labels. Useful for debugging and visual aids.
   * @param {number} step
   * @returns {ImageRaw}
   */
  overlayGrid(step){overlayGrid(this.rgba,this.width,this.height,step);return this;}  

  /**
   * Crop a region from the image.
   * @param {number} x1
   * @param {number} y1
   * @param {number} x2
   * @param {number} y2
   * @returns {ImageRaw}
   */
  crop(x1,y1,x2,y2){
    // coordinates are inclusive for start, exclusive for end (like slice)
    x1 = Math.max(0, Math.min(this.width, x1));
    y1 = Math.max(0, Math.min(this.height, y1));
    x2 = Math.max(0, Math.min(this.width, x2));
    y2 = Math.max(0, Math.min(this.height, y2));
    const w = x2 - x1;
    const h = y2 - y1;
    if (w <= 0 || h <= 0) throw new Error('invalid zoom region');
    const rowSize = w * 4;
    const rows = [];
    for (let yy = 0; yy < h; yy++) {
      const srcStart = ((y1 + yy) * this.width + x1) * 4;
      rows.push(this.rgba.slice(srcStart, srcStart + rowSize));
    }
    const cropped = Buffer.concat(rows, w * h * 4);
    return new ImageRaw(w, h, cropped);
  }  

  /**
   * Encode the image as a PNG buffer.
   * @returns {ImagePNG}
   */
  encodePNG(){const buf=encodePNG(this.width,this.height,this.rgba);return new ImagePNG(buf,this.width,this.height);}
}

/**
 * PNG wrapper containing the encoded PNG buffer and dimensions.
 */
class ImagePNG {
  /**
   * @param {Buffer} buffer
   * @param {number} width
   * @param {number} height
   */
  constructor(buffer,width,height){this.buffer=buffer;this.width=width;this.height=height;}

  /**
   * Save the PNG buffer to disk.
   * @param {string} filename
   * @returns {Promise<void>}
   */
  save(filename){
    return fs.promises.writeFile(filename,this.buffer);
  }

  /**
   * Create a data URL suitable for sending to a model.
   * @returns {string}
   */
  encodeForModel(){return`data:image/png;base64,${this.buffer.toString('base64')}`;}
}

module.exports = {ImageRaw,ImagePNG};
