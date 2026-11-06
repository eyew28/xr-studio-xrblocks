import express, { Request, Response } from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT) || 3000;

// Middleware for parsing JSON with a generous limit
app.use(express.json({ limit: '50mb' }));

// Ensure uploads directory exists
const uploadsDir = path.resolve(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Ensure dist directory exists for static serving
const distDir = path.resolve(process.cwd(), 'dist');

interface MediaItemData {
  id: string;
  name: string;
  size: number;
  sizeFormatted: string;
  type: 'splat' | 'photo360' | 'video360';
  formatExtension: string;
  url: string;
}

interface SessionState {
  playlist: MediaItemData[];
  currentIndex: number;
  playbackState?: {
    isPlaying: boolean;
    currentTime: number;
    duration: number;
  };
}

const session: SessionState = {
  playlist: [],
  currentIndex: -1,
};

function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// SSE Subscribers
const sseClients = new Set<Response>();

function broadcast(event: string, payload: unknown) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(message);
    } catch {
      sseClients.delete(client);
    }
  }
}

// WebRTC Signaling Store (in-memory relay)
interface SignalMessage {
  from: string;
  to?: string;
  data: unknown;
  timestamp: number;
}
const signalQueues = new Map<string, SignalMessage[]>();

// 1. Session State API
app.get('/api/session', (_req: Request, res: Response) => {
  res.json({
    playlist: session.playlist,
    currentIndex: session.currentIndex,
    currentMedia: session.currentIndex >= 0 ? session.playlist[session.currentIndex] : null,
    connectedViewers: sseClients.size,
  });
});

app.post('/api/session', (req: Request, res: Response) => {
  const data = req.body;
  if (typeof data.currentIndex === 'number') {
    session.currentIndex = Math.max(-1, Math.min(session.playlist.length - 1, data.currentIndex));
  }
  if (data.playbackState) {
    session.playbackState = data.playbackState;
  }
  broadcast('sync', {
    playlist: session.playlist,
    currentIndex: session.currentIndex,
    currentMedia: session.currentIndex >= 0 ? session.playlist[session.currentIndex] : null,
    playbackState: session.playbackState,
  });
  res.json({ success: true, session });
});

app.delete('/api/session', (_req: Request, res: Response) => {
  session.playlist = [];
  session.currentIndex = -1;
  broadcast('sync', { playlist: [], currentIndex: -1, currentMedia: null });
  res.json({ success: true });
});

// 2. File Upload API (Chunked or single stream)
app.post('/api/upload', (req: Request, res: Response) => {
  const rawFilename = (req.headers['x-filename'] as string) || 'unnamed_file';
  const filename = decodeURIComponent(rawFilename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const fileType = ((req.headers['x-filetype'] as string) || 'splat') as MediaItemData['type'];
  const fileExt = ((req.headers['x-fileext'] as string) || path.extname(filename).replace('.', '')).toUpperCase();

  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const storedFilename = `${id}_${filename}`;
  const targetPath = path.join(uploadsDir, storedFilename);

  const writeStream = fs.createWriteStream(targetPath);
  let receivedBytes = 0;

  req.on('data', (chunk) => {
    receivedBytes += chunk.length;
  });

  req.pipe(writeStream);

  writeStream.on('finish', () => {
    const newItem: MediaItemData = {
      id,
      name: filename,
      size: receivedBytes,
      sizeFormatted: formatBytes(receivedBytes),
      type: fileType,
      formatExtension: fileExt,
      url: `/api/files/${storedFilename}`,
    };

    session.playlist.push(newItem);
    if (session.currentIndex === -1) {
      session.currentIndex = 0;
    } else {
      session.currentIndex = session.playlist.length - 1;
    }

    broadcast('sync', {
      playlist: session.playlist,
      currentIndex: session.currentIndex,
      currentMedia: session.playlist[session.currentIndex],
    });

    res.json({ success: true, item: newItem, session });
  });

  writeStream.on('error', (err) => {
    console.error('File write error:', err);
    res.status(500).json({ error: err.message });
  });
});

// 3. Serve Uploaded Files with HTTP 206 Partial Content (critical for 360 video and large splats)
app.get('/api/files/:filename', (req: Request, res: Response) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
  const filePath = path.join(uploadsDir, filename);

  if (!fs.existsSync(filePath)) {
    res.status(404).send('File Not Found');
    return;
  }

  const stat = fs.statSync(filePath);
  const ext = path.extname(filename).toLowerCase();
  let contentType = 'application/octet-stream';
  if (ext === '.mp4') contentType = 'video/mp4';
  else if (ext === '.webm') contentType = 'video/webm';
  else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
  else if (ext === '.png') contentType = 'image/png';
  else if (ext === '.webp') contentType = 'image/webp';
  else if (ext === '.ply' || ext === '.splat' || ext === '.spz') contentType = 'application/octet-stream';

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;

    if (start >= stat.size) {
      res.status(416).header('Content-Range', `bytes */${stat.size}`).send();
      return;
    }

    const chunksize = end - start + 1;
    const fileStream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
    });
    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// 4. Server-Sent Events (SSE) Stream
app.get('/api/events', (_req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  sseClients.add(res);

  // Send initial state immediately
  res.write(
    `event: sync\ndata: ${JSON.stringify({
      playlist: session.playlist,
      currentIndex: session.currentIndex,
      currentMedia: session.currentIndex >= 0 ? session.playlist[session.currentIndex] : null,
    })}\n\n`
  );

  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);

  res.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

// 5. Lightweight WebRTC Signaling API
app.post('/api/signal', (req: Request, res: Response) => {
  const { from, to, data } = req.body;
  if (!from || !data) {
    res.status(400).json({ error: 'Missing parameters' });
    return;
  }

  const target = to || 'broadcast';
  if (!signalQueues.has(target)) {
    signalQueues.set(target, []);
  }

  signalQueues.get(target)!.push({
    from,
    to: target,
    data,
    timestamp: Date.now(),
  });

  // Also notify via SSE if listening
  broadcast('signal', { from, to: target, data });
  res.json({ success: true });
});

app.get('/api/signal/:clientId', (req: Request, res: Response) => {
  const clientId = req.params.clientId;
  const messages: SignalMessage[] = [];

  // Messages addressed specifically to this client
  if (signalQueues.has(clientId)) {
    messages.push(...signalQueues.get(clientId)!);
    signalQueues.set(clientId, []);
  }

  // Broadcast messages
  if (signalQueues.has('broadcast')) {
    const broadcasts = signalQueues.get('broadcast')!;
    for (const msg of broadcasts) {
      if (msg.from !== clientId) {
        messages.push(msg);
      }
    }
  }

  res.json({ messages });
});

// 6. Network Info API
app.get('/api/network-info', (req: Request, res: Response) => {
  const nets = os.networkInterfaces();
  const localIps: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        localIps.push(net.address);
      }
    }
  }

  res.json({
    localIps,
    port: PORT,
    host: req.headers.host,
  });
});

// 7. Static Frontend File Serving
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req: Request, res: Response) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  console.log('Dist directory not built yet. Run npm run build.');
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`XR Media Studio Server running on port ${PORT}`);
});
