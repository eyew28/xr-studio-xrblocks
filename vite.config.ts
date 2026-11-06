import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadTlsOptions } from './tls-options.ts';

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

function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Custom Vite plugin that provides a lightweight backend for
 * cross-device media synchronization between PC and Meta Quest Browser.
 */
function xrMediaSyncPlugin(): Plugin {
  const uploadsDir = path.resolve(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const session: SessionState = {
    playlist: [],
    currentIndex: -1,
  };

  const sseClients = new Set<(data: string) => void>();

  /** Deletes every file in the uploads folder, reporting any that could not be removed. */
  async function deleteUploadedFiles(): Promise<{ deleted: number; failed: string[] }> {
    const entries = await fs.promises.readdir(uploadsDir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    const results = await Promise.allSettled(
      files.map((name) => fs.promises.unlink(path.join(uploadsDir, name)))
    );
    const failed = files.filter((_, i) => results[i].status === 'rejected');
    return { deleted: files.length - failed.length, failed };
  }

  function broadcast(event: string, payload: unknown) {
    const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const send of sseClients) {
      try {
        send(message);
      } catch {
        sseClients.delete(send);
      }
    }
  }

  return {
    name: 'xr-media-sync',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const pathname = url.pathname;

        // 1. Upload API (Stream file body to disk)
        if (pathname === '/api/upload' && req.method === 'POST') {
          const rawFilename = req.headers['x-filename'] as string || 'unnamed_file';
          const filename = decodeURIComponent(rawFilename).replace(/[^a-zA-Z0-9._-]/g, '_');
          const fileType = (req.headers['x-filetype'] as string || 'splat') as MediaItemData['type'];
          const fileExt = (req.headers['x-fileext'] as string || path.extname(filename).replace('.', '')).toUpperCase();

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

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, item: newItem, session }));
          });

          writeStream.on('error', (err) => {
            console.error('File write error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          });
          return;
        }

        // 2. Serve Uploaded Files with Range Support (Critical for 360 Video)
        if (pathname.startsWith('/api/files/') && req.method === 'GET') {
          const filename = pathname.replace('/api/files/', '').replace(/[^a-zA-Z0-9._-]/g, '');
          const filePath = path.join(uploadsDir, filename);

          if (!fs.existsSync(filePath)) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('File Not Found');
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
              res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
              res.end();
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
          return;
        }

        // 3. Get / Update Session State
        if (pathname === '/api/session') {
          if (req.method === 'GET') {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(
              JSON.stringify({
                playlist: session.playlist,
                currentIndex: session.currentIndex,
                currentMedia: session.currentIndex >= 0 ? session.playlist[session.currentIndex] : null,
                connectedViewers: sseClients.size,
              })
            );
            return;
          }

          if (req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => (body += chunk));
            req.on('end', () => {
              try {
                const data = JSON.parse(body);
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
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, session }));
              } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
              }
            });
            return;
          }

          if (req.method === 'DELETE') {
            session.playlist = [];
            session.currentIndex = -1;
            const result = await deleteUploadedFiles();
            // Clients ignore empty 'sync' playlists, as a restarted server also sends them.
            broadcast('cleared', {});
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: result.failed.length === 0, ...result }));
            return;
          }
        }

        // 4. Server-Sent Events (SSE) for Real-time Cross-Device Synchronization
        if (pathname === '/api/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
          });

          const send = (msg: string) => res.write(msg);
          sseClients.add(send);

          // Send immediate current state
          send(
            `event: sync\ndata: ${JSON.stringify({
              playlist: session.playlist,
              currentIndex: session.currentIndex,
              currentMedia: session.currentIndex >= 0 ? session.playlist[session.currentIndex] : null,
            })}\n\n`
          );

          // Keep-alive ping every 15s
          const keepAlive = setInterval(() => {
            res.write(': ping\n\n');
          }, 15000);

          req.on('close', () => {
            clearInterval(keepAlive);
            sseClients.delete(send);
          });
          return;
        }

        // 5. Network info helper (returns local LAN IP and external address)
        if (pathname === '/api/network-info') {
          const nets = os.networkInterfaces();
          const localIps: string[] = [];
          for (const name of Object.keys(nets)) {
            for (const net of nets[name] || []) {
              if (net.family === 'IPv4' && !net.internal) {
                localIps.push(net.address);
              }
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(
            JSON.stringify({
              localIps,
              port: 3000,
              host: req.headers.host,
            })
          );
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 3000,
    https: loadTlsOptions(),
    fs: {
      // Vite's default list plus the certs folder, because setting this replaces
      // the defaults. The server is reachable on the network, and the defaults
      // alone would miss a private key with any other file name.
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem,key,p12,pfx,cer,der}',
        '.npmrc',
        '.yarnrc.yml',
        '**/.git/**',
        '**/certs/**',
      ],
    },
  },
  plugins: [xrMediaSyncPlugin()],
});
