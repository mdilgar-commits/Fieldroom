// AI extraction in the browser: same instructions as the server's Gemini extraction,
// but answered by Claude through the claude.ai page's `sample` capability.
(() => {
  /*__SERVER_HELPERS__*/
  function buildPrompt(documents, options) {
    /*__SERVER_PROMPT__*/
    return { text: parts[0].text, roomInventory };
  }
  function applyRoomInventory(extracted, roomInventory) {
    /*__SERVER_POST__*/
    return extracted;
  }

  async function docxText(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer()), dv = new DataView(buf.buffer);
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('This DOCX file could not be opened.');
    const count = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true), xml = '';
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), packed = dv.getUint32(p + 20, true), nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true), local = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
      if (name === 'word/document.xml') {
        const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true), raw = buf.subarray(start, start + packed);
        const data = method === 8 ? await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer() : raw;
        xml = new TextDecoder().decode(data); break;
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    if (!xml) throw new Error('No readable text was found in this DOCX file.');
    const t = document.createElement('textarea');
    t.innerHTML = xml.replace(/<w:tab[^>]*\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, ' ');
    return t.value.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
  }
  const canvasBlob = (canvas, type = 'image/jpeg', q = 0.85) => new Promise(r => canvas.toBlob(r, type, q));
  async function fitImage(blob, lim) {
    if (lim.mediaTypes.includes(blob.type) && blob.size <= (lim.maxInputBytes || 4e6)) return blob;
    const bmp = await createImageBitmap(blob), s = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return canvasBlob(c);
  }
  async function renderPdfPage(pdf, n) {
    const page = await pdf.getPage(n), v1 = page.getViewport({ scale: 1 }), scale = Math.min(3, 1800 / Math.max(v1.width, v1.height));
    const vp = page.getViewport({ scale }), c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return canvasBlob(c);
  }

  // documents: [{doc, blob}], options: {mapDocumentId, mapPage, knownRooms, projectProfile}
  window.frExtractWithClaude = async (documents, options) => {
    const progress = window.frProgress;
    progress('Connecting to Claude…');
    const sample = await window.claude?.use?.('sample');
    if (!sample) throw new Error('This page can only ask Claude when it is open inside claude.ai while you are signed in. If you opened it in its own browser tab or from a saved copy, go to claude.ai, open Fieldroom from your artifacts, and try again.');
    const limits = await sample.limits().catch(() => ({ maxPromptBytes: 262144 }));
    const imgLim = limits.images || null, maxImages = imgLim ? imgLim.maxCount : 0;
    const notes = [];
    if (!imgLim) notes.push('This view cannot send pictures to Claude, so only the typed text inside your documents was read. Drawings that are pictures were not seen. Try again in a web browser on claude.ai.');
    const { text: instructions, roomInventory } = buildPrompt(documents.map(d => d.doc), options);
    const textParts = [], images = [], imageNotes = [];
    const addImage = (blob, label) => { if (images.length < maxImages) { images.push(blob); imageNotes.push(`Image ${images.length}: ${label}`); return true; } return false; };
    // The designated floor plan page goes first so it always fits.
    const ordered = [...documents].sort((a, b) => (b.doc.id === options.mapDocumentId) - (a.doc.id === options.mapDocumentId));
    for (const { doc, blob } of ordered) {
      const ext = doc.name.toLowerCase().split('.').pop();
      progress(`Preparing ${doc.name}…`);
      if (ext === 'docx') textParts.push(`DOCUMENT ${doc.name}\n${(await docxText(blob)).slice(0, 90000)}`);
      else if (['txt', 'md', 'csv'].includes(ext)) textParts.push(`DOCUMENT ${doc.name}\n${(await blob.text()).slice(0, 90000)}`);
      else if (doc.mimeType?.startsWith('image/')) { if (imgLim) addImage(await fitImage(blob, imgLim), `${doc.name} (page 1)`); }
      else if (ext === 'pdf') {
        const pdfjs = await window.loadPdfjs(), pdf = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
        let text = '';
        for (let n = 1; n <= pdf.numPages && text.length < 90000; n++) {
          const content = await (await pdf.getPage(n)).getTextContent();
          text += `\n--- ${doc.name}, page ${n} ---\n` + content.items.map(i => i.str + (i.hasEOL ? '\n' : ' ')).join('');
        }
        textParts.push(`DOCUMENT ${doc.name} (${pdf.numPages} pages; text layer)\n${text.slice(0, 90000)}`);
        if (imgLim) {
          const pages = doc.id === options.mapDocumentId ? [Number(options.mapPage || 1), ...Array.from({ length: pdf.numPages }, (_, i) => i + 1)] : Array.from({ length: pdf.numPages }, (_, i) => i + 1);
          for (const n of [...new Set(pages)].filter(n => n >= 1 && n <= pdf.numPages)) {
            if (images.length >= maxImages) { notes.push(`Claude can look at ${maxImages} page images at a time, so some pages of ${doc.name} were sent as text only.`); break; }
            progress(`Preparing ${doc.name}, page ${n} of ${pdf.numPages}…`);
            addImage(await fitImage(await renderPdfPage(pdf, n), imgLim), `${doc.name}, page ${n}`);
          }
        }
      }
    }
    const enc = new TextEncoder(), budget = (limits.maxPromptBytes || 262144) - 4000;
    const closing = (imageNotes.length ? `\n\nATTACHED IMAGES (in order):\n${imageNotes.join('\n')}` : '') + '\n\nReply with only the JSON object, no other text.';
    let prompt = instructions;
    for (const part of textParts) {
      const next = prompt + '\n\n' + part;
      if (enc.encode(next + closing).length > budget) { prompt += `\n\n[Some document text was left out to fit the size limit.]`; break; }
      prompt = next;
    }
    prompt += closing;
    progress(`Asking Claude to read ${images.length} drawing image${images.length === 1 ? '' : 's'} and ${textParts.length} document${textParts.length === 1 ? '' : 's'}. This usually takes one to three minutes. Keep this page open.`);
    let extracted;
    try { extracted = await sample.json(prompt, { images: images.length ? images : undefined, modelTier: 'complex', cache: false }); }
    catch (e) {
      if (e?.code === 'not_granted' || e?.code === 'not_declared') throw new Error('Fieldroom does not have permission to ask Claude. Allow it when claude.ai asks (or turn it on in the page\'s Permissions menu), then try again.');
      if (e?.code === 'sampling_disabled') throw new Error('Asking Claude from pages is turned off for your account or organization, so extraction cannot run here.');
      if (e?.code === 'prompt_too_large') throw new Error('These documents are too large to send to Claude at once. Try extracting with fewer documents selected.');
      if (e?.code === 'rate_limited') throw new Error('Claude is busy right now. Wait a minute, then try again.');
      throw new Error('Claude could not read these documents: ' + (e?.message || e?.code || 'unknown error'));
    }
    if (!extracted || !Array.isArray(extracted.rooms)) throw new Error('Extraction response did not contain a room list.');
    const result = applyRoomInventory(extracted, roomInventory);
    result.warnings = [...notes, ...(Array.isArray(result.warnings) ? result.warnings : [])];
    const found = (result.rooms || []).length + (result.generalDeliverables || []).length + (result.rooms || []).reduce((n, r) => n + (r.deliverables || []).length, 0);
    if (!found) throw new Error('Claude read the documents but did not find any rooms or deliverables in them.' + (result.warnings.length ? '\n\nNotes:\n• ' + result.warnings.join('\n• ') : ''));
    return result;
  };
})();
