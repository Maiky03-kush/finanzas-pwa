// Run once: node gen-icons.js
// Generates minimal SVG-derived PNG icons without external deps
const fs = require('fs');
const zlib = require('zlib');

function makePNG(size) {
  // Create RGBA pixel data: blue gradient background + white "F" letter
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      // Gradient: top-left #007AFF → bottom-right #5AC8FA
      const t = (x + y) / (size * 2);
      pixels[idx]   = Math.round(0x00 + t * (0x5A - 0x00)); // R
      pixels[idx+1] = Math.round(0x7A + t * (0xC8 - 0x7A)); // G
      pixels[idx+2] = Math.round(0xFF + t * (0xFA - 0xFF)); // B
      pixels[idx+3] = 255; // A

      // Draw a simple rounded coin symbol in white
      const cx = x - size/2, cy = y - size/2;
      const r = size * 0.32;
      const ri = size * 0.22;
      if (Math.sqrt(cx*cx + cy*cy) <= r && Math.sqrt(cx*cx + cy*cy) >= ri) {
        pixels[idx] = pixels[idx+1] = pixels[idx+2] = 255;
        pixels[idx+3] = 220;
      }
      // Inner $ bar vertical
      if (Math.abs(cx) < size * 0.03 && Math.abs(cy) < size * 0.28) {
        pixels[idx] = pixels[idx+1] = pixels[idx+2] = 255;
        pixels[idx+3] = 255;
      }
      // $ horizontal bars
      if (Math.abs(cy) < size * 0.08 && Math.abs(cy) > size * 0.02 && Math.abs(cx) < size * 0.14) {
        pixels[idx] = pixels[idx+1] = pixels[idx+2] = 255;
        pixels[idx+3] = 255;
      }
    }
  }

  // Build PNG
  const chunks = [];

  // PNG signature
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB (we'll handle alpha separately as RGBA=6)
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // IDAT: filter + raw rows
  const rawRows = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    rawRows[y * (1 + size * 4)] = 0; // filter type None
    pixels.copy(rawRows, y * (1 + size * 4) + 1, y * size * 4, (y+1) * size * 4);
  }
  const compressed = zlib.deflateSync(rawRows);

  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    const table = crc32.table || (crc32.table = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[i] = c;
      }
      return t;
    })());
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function chunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

fs.writeFileSync('icon-192.png', makePNG(192));
fs.writeFileSync('icon-512.png', makePNG(512));
console.log('✅ icon-192.png and icon-512.png generated');
