/**
 * Types and interfaces for XR Media Studio
 */

export type MediaType = 'splat' | 'photo360' | 'video360';

export interface MediaItem {
  id: string;
  name: string;
  size: number;
  sizeFormatted: string;
  type: MediaType;
  url: string;
  formatExtension: string;
  file?: File;
  splatPoints?: number;
  videoDuration?: number;
}

export interface ViewerState {
  playlist: MediaItem[];
  currentIndex: number;
  currentMedia: MediaItem | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  isMuted: boolean;
  volume: number;
  splatScale: number;
  isXrActive: boolean;
}

/**
 * Format bytes into human-readable string
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Format seconds into mm:ss
 */
export function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Identify media type from file extension and MIME type
 */
export function identifyMediaType(file: File): { type: MediaType; extension: string } | null {
  const name = file.name.toLowerCase();
  const ext = name.substring(name.lastIndexOf('.'));

  // Gaussian Splats
  if (ext === '.splat' || ext === '.ply' || ext === '.spz' || ext === '.ksplat') {
    return { type: 'splat', extension: ext.replace('.', '').toUpperCase() };
  }

  // 360 Videos
  if (
    ext === '.mp4' ||
    ext === '.webm' ||
    ext === '.mov' ||
    ext === '.mkv' ||
    file.type.startsWith('video/')
  ) {
    return { type: 'video360', extension: ext.replace('.', '').toUpperCase() || 'VIDEO' };
  }

  // 360 Photos
  if (
    ext === '.jpg' ||
    ext === '.jpeg' ||
    ext === '.png' ||
    ext === '.webp' ||
    ext === '.avif' ||
    file.type.startsWith('image/')
  ) {
    return { type: 'photo360', extension: ext.replace('.', '').toUpperCase() || 'IMAGE' };
  }

  return null;
}
