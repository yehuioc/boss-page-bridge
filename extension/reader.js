function sameView(first, second) {
  return first.url === second.url && first.text === second.text &&
    JSON.stringify(first.viewport) === JSON.stringify(second.viewport) &&
    JSON.stringify(first.salary_regions) === JSON.stringify(second.salary_regions);
}
async function captureSalary(tab, page, job) {
  const regions = (page.salary_regions || []).filter(r => r.text.replace(/\s/g, '') === job.salary_raw.replace(/\s/g, '') && r.width <= 500 && r.height <= 100);
  regions.sort((a, b) => b.x - a.x || a.y - b.y);
  const region = regions[0];
  if (!region) throw Error('请手动把当前职位的薪资滚动到屏幕内，再读取');
  const active = async () => {
    if (chrome.windows?.get) {
      const window = await chrome.windows.get(tab.windowId);
      if (window.state === 'minimized' || !window.focused) throw Error('薪资截图需要此 Boss 页在前台可见；后台读取继续，不自动切换窗口');
    }
    const [current] = await chrome.tabs.query({active: true, windowId: tab.windowId});
    if (current?.id !== tab.id || current.url !== tab.url) throw Error('当前标签页或地址已改变，截图已丢弃');
  };
  await active();
  const imageData = await chrome.tabs.captureVisibleTab(tab.windowId, {format: 'png'});
  await active();
  const after = (await boundedRead(chrome.scripting.executeScript({target: {tabId: tab.id}, world: 'ISOLATED', func: readBossPage})))[0]?.result;
  if (!after || !sameView(page, after)) throw Error('截图期间页面内容或位置改变，截图已丢弃，请重新读取');
  let image;
  if (typeof Image === 'function') {
    image = new Image(); image.src = imageData; await image.decode();
  } else {
    const bytes = Uint8Array.from(atob(imageData.split(',')[1]), c => c.charCodeAt(0));
    image = await createImageBitmap(new Blob([bytes], {type: 'image/png'}));
  }
  const imageWidth = image.naturalWidth || image.width, imageHeight = image.naturalHeight || image.height;
  const sx = imageWidth / page.viewport.width, sy = imageHeight / page.viewport.height;
  const x = Math.max(0, Math.floor((region.x - 3) * sx)), y = Math.max(0, Math.floor((region.y - 3) * sy));
  const right = Math.min(imageWidth, Math.ceil((region.x + region.width + 3) * sx));
  const bottom = Math.min(imageHeight, Math.ceil((region.y + region.height + 3) * sy));
  if (right <= x || bottom <= y || right - x > 2400 || bottom - y > 500) throw Error('薪资截图范围无效');
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(right - x, bottom - y) : document.createElement('canvas');
  canvas.width = right - x; canvas.height = bottom - y;
  canvas.getContext('2d').drawImage(image, x, y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  image.close?.();
  let dataUrl;
  if (canvas.convertToBlob) {
    const bytes = new Uint8Array(await (await canvas.convertToBlob({type: 'image/png'})).arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    dataUrl = 'data:image/png;base64,' + btoa(binary);
  } else dataUrl = canvas.toDataURL('image/png');
  // The full viewport image is never stored or sent; only this crop leaves memory.
  return {data_url: dataUrl, width: canvas.width, height: canvas.height,
    source_url: job.url, captured_at: page.captured_at};
}
async function boundedRead(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('页面读取超过5秒；未自动重试，迟到结果不会显示')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
