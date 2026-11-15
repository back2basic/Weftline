import { createClientAuth } from './client-auth.js';

// Standalone candidate; deliberately not installed on the application's server.
export function createNodeAuthAdapter(config, handle = createClientAuth(config)) {
  return async (req, res) => {
    let abandoned = false, reader, stream, cleanupInput, inputController;
    const controller = new AbortController();
    const socket = req.socket;
    const abandon = () => { abandoned = true; req.pause(); };
    const closeAfterResponse = () => {
      if (!req.complete || abandoned) {
        // Do not destroy the request before the response has been flushed.
        const timer = setTimeout(() => socket.destroy(), 250);
        timer.unref();
        socket.once('close', () => clearTimeout(timer));
        socket.end();
      }
    };
    req.on('error', () => {});
    res.on('error', () => {});
    res.once('close', () => { if (!res.writableFinished) controller.abort(); if (reader) void reader.cancel().catch(() => {}); });
    try {
      const hosts = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i].toLowerCase() === 'host') hosts.push(req.rawHeaders[i + 1]);
      }
      if (hosts.length !== 1 || hosts[0] !== new URL(config.origin).host ||
          !req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) {
        abandon(); res.writeHead(403, {'connection':'close','cache-control':'no-store'}); res.end('Forbidden', closeAfterResponse); return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') &&
          (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) > 0)) {
        abandon(); res.writeHead(400, {'connection':'close','cache-control':'no-store'}); res.end('Bad request', closeAfterResponse); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        stream = new ReadableStream({
          start(controller) {
            const onData = chunk => { req.pause(); controller.enqueue(chunk); };
            const onEnd = () => { cleanup(); controller.close(); };
            const onError = error => { cleanup(); controller.error(error); };
            const cleanup = () => { req.off('data',onData); req.off('end',onEnd); req.off('error',onError); cleanupInput = undefined; inputController = undefined; };
            cleanupInput = cleanup; inputController = controller;
            this.cleanup = cleanup;
            req.on('data', onData); req.once('end', onEnd); req.once('error', onError);
            req.pause();
          },
          pull() { req.resume(); },
          cancel() { this.cleanup(); abandon(); }
        }, {highWaterMark:0});
      }
      const request = new Request(config.origin + req.url, {method:req.method, headers:req.headers, signal:controller.signal,
        ...(stream ? {body:stream, duplex:'half'} : {})});
      const response = await handle(request);
      if (res.destroyed) { if (response.body) void response.body.cancel().catch(() => {}); return; }
      if (abandoned || !req.complete) res.setHeader('connection','close');
      for (const [name, value] of response.headers) res.setHeader(name, value);
      res.writeHead(response.status);
      if (response.body) {
        const outputTimer = setTimeout(() => res.destroy(), 1000);
        outputTimer.unref();
        res.once('close', () => clearTimeout(outputTimer));
        reader = response.body.getReader();
        while (!res.destroyed) {
          const {value,done} = await reader.read();
          if (done) break;
          if (!res.write(value)) await new Promise(resolve => {
            const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
            res.once('drain', done); res.once('close', done);
            if (res.destroyed) done();
          });
        }
      }
      if (!res.destroyed) res.end(closeAfterResponse);
    } catch {
      if (stream && !stream.locked) void stream.cancel().catch(() => {});
      if (cleanupInput) { const input = inputController; cleanupInput(); input.error(new Error('Request abandoned')); }
      abandon();
      if (!res.destroyed) {
        if (!res.headersSent) { res.writeHead(502, {'connection':'close','cache-control':'no-store'}); res.end('Authentication unavailable', closeAfterResponse); }
        else res.destroy();
      }
    }
  };
}
