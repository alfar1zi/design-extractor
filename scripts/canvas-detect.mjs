// canvas-detect.mjs - detect canvas elements and WebGL contexts in a page.
export async function detectCanvas(page) {
  return await page.evaluate(() => {
    const canvases = document.querySelectorAll('canvas');
    const result = Array.from(canvases).map(c => ({
      width: c.width,
      height: c.height,
      id: c.id || null,
      className: c.className || null,
      hasWebGL: false
    }));
    for (let i = 0; i < canvases.length; i++) {
      try {
        const gl = canvases[i].getContext('webgl') || canvases[i].getContext('webgl2');
        if (gl) result[i].hasWebGL = true;
      } catch {}
    }
    return result;
  });
}