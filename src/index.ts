import * as THREE from 'three';
import * as xb from 'xrblocks';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import {
  MediaItem,
  MediaType,
  ViewerState,
  formatBytes,
  formatTime,
  identifyMediaType,
} from './types.ts';

/**
 * XRMediaStudio
 *
 * Immersive WebXR & Desktop viewer for:
 * 1. 3D Gaussian Splats (.splat, .ply, .spz)
 * 2. 360° Panoramic Equirectangular Photos (.jpg, .png, .webp)
 * 3. 360° Spatial Equirectangular Videos (.mp4, .webm, .mov)
 *
 * Features:
 * - Drag-and-drop local file & folder uploads
 * - Full client-side & LAN server synchronization with Meta Quest Browser
 * - In-VR 3D spatial UI card with file switching, video playback, and splat manipulation
 * - 6DOF WebXR VR session support
 */
export class XRMediaStudio extends xb.Script {
  state: ViewerState = {
    playlist: [],
    currentIndex: -1,
    currentMedia: null,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    isMuted: false,
    volume: 1.0,
    splatScale: 1.0,
    isXrActive: false,
  };

  // Three.js Scene Nodes
  private mediaGroup: THREE.Group = new THREE.Group();
  private sparkRenderer?: SparkRenderer;
  private currentSplatMesh?: SplatMesh;
  private currentSphereMesh?: THREE.Mesh;
  private currentVideoTexture?: THREE.VideoTexture;
  private currentVideo?: HTMLVideoElement;

  // Spatial in-VR UI Card
  private vrCard?: xb.UICard;
  private vrFormatText?: xb.UIText;
  private vrFileNameText?: xb.UIText;
  private vrMetaText?: xb.UIText;
  private vrVideoRow?: xb.UIPanel;
  private vrSplatRow?: xb.UIPanel;
  private vrPlayButton?: xb.UIButton;
  private vrMuteButton?: xb.UIButton;

  // Desktop Camera Pan / Look Controls for 360 media
  private isUserInteracting = false;
  private onPointerDownPointerX = 0;
  private onPointerDownPointerY = 0;
  private lon = 0;
  private onPointerDownLon = 0;
  private lat = 0;
  private onPointerDownLat = 0;
  private cameraTarget = new THREE.Vector3();

  // Splat interactive rotation & zoom
  private splatRotation = new THREE.Euler(0, 0, 0);
  private splatDistance = -1.5;

  // Sync state
  private eventSource?: EventSource;
  private isSyncingFromRemote = false;

  constructor() {
    super();
    this.name = 'XRMediaStudio';
  }

  init() {
    this.add(this.mediaGroup);

    // Setup ambient and directional lighting for splats and spatial UI
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x333333, 2.5);
    const dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
    dirLight.position.set(0, 10, 5);
    this.add(hemiLight, dirLight);

    // Initialize in-VR floating spatial UI card
    this.createVrControlCard();

    // Wire up desktop DOM controls & drag-and-drop
    this.setupDesktopInteractions();

    // Initialize real-time cross-device sync with Meta Quest Browser
    this.initSessionSync();

    // Setup Quest sync modal & WebXR detection
    this.setupQuestModal();
    this.checkWebXRSupport();
  }

  // ==========================================
  // In-VR Spatial UI Card (XR Blocks)
  // ==========================================

  private createVrControlCard() {
    this.vrFormatText = new xb.UIText({
      text: 'NO MEDIA LOADED',
      style: {
        fontSize: 14,
        fontWeight: 'bold',
        color: '#49c5b6',
        textAlign: 'center',
      },
    });

    this.vrFileNameText = new xb.UIText({
      text: 'Drop media files on desktop to start',
      style: {
        fontSize: 22,
        fontWeight: 'bold',
        color: '#ffffff',
        textAlign: 'center',
        marginTop: 4,
        marginBottom: 4,
      },
    });

    this.vrMetaText = new xb.UIText({
      text: 'Supports .splat, .ply, .spz, 360° Photos & Videos',
      style: {
        fontSize: 14,
        color: 'rgba(255, 255, 255, 0.7)',
        textAlign: 'center',
      },
    });

    // Video Controls in VR
    this.vrPlayButton = new xb.UIButton({
      label: 'Play',
      icon: 'play_arrow',
      style: { flexGrow: 1 },
      onClick: () => this.toggleVideoPlayback(),
    });

    this.vrMuteButton = new xb.UIButton({
      label: 'Mute',
      icon: 'volume_up',
      style: { flexGrow: 1 },
      onClick: () => this.toggleVideoMute(),
    });

    const vrReplayButton = new xb.UIButton({
      label: 'Replay',
      icon: 'replay',
      style: { flexGrow: 1 },
      onClick: () => this.restartVideo(),
    });

    this.vrVideoRow = new xb.UIPanel({
      style: {
        width: '100%',
        flexDirection: 'row',
        gap: 8,
        marginTop: 6,
      },
      children: [this.vrPlayButton, vrReplayButton, this.vrMuteButton],
    });
    this.vrVideoRow.visible = false;

    // Splat Controls in VR
    const vrScaleDown = new xb.UIButton({
      label: 'Smaller',
      icon: 'remove',
      style: { flexGrow: 1 },
      onClick: () => this.adjustSplatScale(-0.2),
    });

    const vrRecenter = new xb.UIButton({
      label: 'Recenter',
      icon: 'restart_alt',
      style: { flexGrow: 1 },
      onClick: () => this.recenterSplat(),
    });

    const vrScaleUp = new xb.UIButton({
      label: 'Larger',
      icon: 'add',
      style: { flexGrow: 1 },
      onClick: () => this.adjustSplatScale(0.2),
    });

    this.vrSplatRow = new xb.UIPanel({
      style: {
        width: '100%',
        flexDirection: 'row',
        gap: 8,
        marginTop: 6,
      },
      children: [vrScaleDown, vrRecenter, vrScaleUp],
    });
    this.vrSplatRow.visible = false;

    // Navigation and Action Row in VR
    const vrPrevBtn = new xb.UIButton({
      label: 'Prev',
      icon: 'skip_previous',
      style: { flexGrow: 1 },
      onClick: () => this.selectPreviousMedia(),
    });

    const vrNextBtn = new xb.UIButton({
      label: 'Next',
      icon: 'skip_next',
      style: { flexGrow: 1 },
      onClick: () => this.selectNextMedia(),
    });

    const vrUploadBtn = new xb.UIButton({
      label: 'Load File',
      icon: 'file_open',
      style: { flexGrow: 1 },
      onClick: () => {
        const input = document.getElementById('fileInput') as HTMLInputElement | null;
        input?.click();
      },
    });

    const vrExitBtn = new xb.UIButton({
      label: 'Exit VR',
      icon: 'close',
      style: {
        flexGrow: 1,
        backgroundColor: 'rgba(239, 68, 68, 0.25)',
      },
      onClick: () => {
        const xr = xb.core.renderer.xr as unknown as { getSession?: () => XRSession | null };
        xr.getSession?.()?.end();
      },
    });

    const vrNavRow = new xb.UIPanel({
      style: {
        width: '100%',
        flexDirection: 'row',
        gap: 8,
        marginTop: 6,
      },
      children: [vrPrevBtn, vrNextBtn, vrUploadBtn, vrExitBtn],
    });

    // Main In-VR Card Assembly
    this.vrCard = new xb.UICard({
      size: { width: 0.68, height: 'auto' },
      manipulation: true,
      edge: true,
      style: {
        flexDirection: 'column',
        gap: 10,
        padding: 16,
        backgroundColor: 'rgba(15, 23, 42, 0.92)',
        borderRadius: 20,
      },
      children: [
        this.vrFormatText,
        this.vrFileNameText,
        this.vrMetaText,
        this.vrVideoRow,
        this.vrSplatRow,
        vrNavRow,
      ],
    });

    // Anchor card 1.15m in front of user at comfortable chest/eye level
    this.vrCard.position.set(0, 1.25, -1.15);
    this.add(this.vrCard);
  }

  // ==========================================
  // Cross-Device Server Synchronization (PC <-> Quest)
  // ==========================================

  private async initSessionSync() {
    try {
      // 1. Initial State Fetch from Vite server
      const res = await fetch('/api/session');
      if (res.ok) {
        const data = await res.json();
        if (data.playlist && data.playlist.length > 0) {
          this.applyRemotePlaylist(data.playlist, data.currentIndex);
        }
      }
    } catch (e) {
      console.warn('Initial session sync notice:', e);
    }

    // 2. Real-time Server-Sent Events (SSE)
    try {
      this.eventSource = new EventSource('/api/events');
      this.eventSource.addEventListener('sync', (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleRemoteSync(data);
        } catch (err) {
          console.warn('Sync decode error:', err);
        }
      });

      this.eventSource.onopen = () => {
        const dot = document.getElementById('questStatusDot');
        const text = document.getElementById('questConnectionText');
        const statusSpan = document.getElementById('questStatusText');
        if (dot) dot.classList.add('connected');
        if (text) text.textContent = 'Active cloud sync connection established.';
        if (statusSpan) statusSpan.textContent = 'Quest Connected';
      };

      this.eventSource.onerror = () => {
        // SSE disconnected, polling fallback handles it
      };
    } catch (e) {
      console.warn('SSE subscription notice:', e);
    }

    // 3. Fallback Heartbeat Polling every 3.5 seconds
    setInterval(async () => {
      try {
        const res = await fetch('/api/session');
        if (res.ok) {
          const data = await res.json();
          if (data.playlist && data.playlist.length > 0) {
            const currentListIds = this.state.playlist.map((i) => i.id).join(',');
            const remoteListIds = data.playlist.map((i: MediaItem) => i.id).join(',');
            if (currentListIds !== remoteListIds || data.currentIndex !== this.state.currentIndex) {
              this.handleRemoteSync(data);
            }
          }
        }
      } catch {
        // Network quiet
      }
    }, 3500);
  }

  private handleRemoteSync(data: {
    playlist: MediaItem[];
    currentIndex: number;
    playbackState?: { isPlaying: boolean; currentTime: number };
  }) {
    if (this.isSyncingFromRemote) return;

    if (data.playlist && data.playlist.length > 0) {
      const currentListIds = this.state.playlist.map((i) => i.id).join(',');
      const remoteListIds = data.playlist.map((i) => i.id).join(',');

      if (currentListIds !== remoteListIds) {
        this.applyRemotePlaylist(data.playlist, data.currentIndex);
      } else if (data.currentIndex !== this.state.currentIndex && data.currentIndex >= 0) {
        this.loadMediaItem(data.currentIndex, false);
      }
    }
  }

  private applyRemotePlaylist(playlist: MediaItem[], targetIndex: number) {
    this.state.playlist = playlist;
    this.renderPlaylistStrip();

    if (targetIndex >= 0 && targetIndex < playlist.length) {
      this.loadMediaItem(targetIndex, false);
    } else if (playlist.length > 0 && this.state.currentIndex === -1) {
      this.loadMediaItem(0, false);
    }
  }

  private async notifyServerSelection(index: number) {
    try {
      await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentIndex: index }),
      });
    } catch (e) {
      console.warn('Could not notify server of selection:', e);
    }
  }

  // ==========================================
  // File Uploading & Ingestion
  // ==========================================

  private async handleFiles(files: FileList | File[]) {
    const validFiles: { file: File; type: MediaType; extension: string }[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const identified = identifyMediaType(file);
      if (identified) {
        validFiles.push({ file, type: identified.type, extension: identified.extension });
      }
    }

    if (validFiles.length === 0) {
      this.showToast('No supported media found (.splat, .ply, .spz, 360° photo/video)', 'error');
      return;
    }

    this.showToast(`Loading ${validFiles.length} file(s)...`, 'success');

    for (const item of validFiles) {
      // 1. Create instant local object URL for immediate responsiveness
      const localUrl = URL.createObjectURL(item.file);
      const mediaItem: MediaItem = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: item.file.name,
        size: item.file.size,
        sizeFormatted: formatBytes(item.file.size),
        type: item.type,
        formatExtension: item.extension,
        url: localUrl,
        file: item.file,
      };

      this.state.playlist.push(mediaItem);

      // If this is the first item or currently idle, display immediately
      if (this.state.currentIndex === -1) {
        this.loadMediaItem(0, true);
      } else {
        this.renderPlaylistStrip();
        this.updateHUD();
        this.updateVrCard();
      }

      // 2. Stream to server in the background so Meta Quest Browser receives it
      this.uploadFileToServer(item.file, mediaItem);
    }
  }

  private async uploadFileToServer(file: File, localItem: MediaItem) {
    this.showToast(`Syncing ${file.name} to Quest headset...`, 'success');

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: {
          'x-filename': encodeURIComponent(file.name),
          'x-filetype': localItem.type,
          'x-fileext': localItem.formatExtension,
        },
        body: file,
      });

      if (res.ok) {
        const data = await res.json();
        if (data.item?.url) {
          localItem.url = data.item.url;
          this.showToast(`Synced! ${file.name} is now ready on Quest.`, 'success');
        }
      } else if (res.status === 413) {
        this.showToast(
          `"${file.name}" is over 32MB (Cloud limit). You can load it directly via Quest file browser!`,
          'error'
        );
      } else {
        console.warn('Sync server response:', res.status, res.statusText);
      }
    } catch (err) {
      console.warn('Background sync upload note:', err);
    }
  }

  // ==========================================
  // Media Loading Core
  // ==========================================

  async loadMediaItem(index: number, notifyServer = true) {
    if (index < 0 || index >= this.state.playlist.length) return;

    this.state.currentIndex = index;
    const item = this.state.playlist[index];
    this.state.currentMedia = item;

    // Hide welcome card and reveal bottom dock
    document.getElementById('welcomeCard')?.classList.add('hidden');
    document.getElementById('bottomDock')?.classList.remove('hidden');

    this.updateHUD();
    this.updateVrCard();
    this.renderPlaylistStrip();

    if (notifyServer) {
      this.notifyServerSelection(index);
    }

    // Clean up previously active media
    this.cleanupCurrentMedia();

    try {
      if (item.type === 'splat') {
        await this.loadGaussianSplat(item);
      } else if (item.type === 'photo360') {
        await this.load360Photo(item);
      } else if (item.type === 'video360') {
        await this.load360Video(item);
      }
    } catch (err) {
      console.error('Error loading media item:', err);
      this.showToast(`Error loading ${item.name}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  /**
   * Loads a Gaussian Splat (.splat, .ply, .spz) using Spark
   */
  private async loadGaussianSplat(item: MediaItem): Promise<void> {
    this.showToast(`Loading 3D Splat: ${item.name}...`, 'success');

    // Initialize SparkRenderer if needed
    if (!this.sparkRenderer) {
      this.sparkRenderer = new SparkRenderer({
        renderer: xb.core.renderer as unknown as THREE.WebGLRenderer,
      });
      this.add(this.sparkRenderer);
    }

    const splatMesh = new SplatMesh({ url: item.url });
    this.currentSplatMesh = splatMesh;
    this.mediaGroup.add(splatMesh);

    // Position in front of the viewer
    this.mediaGroup.position.set(0, 1.2, this.splatDistance);

    await splatMesh.initialized;

    // Auto-normalize bounding box to a comfortable viewing scale
    const bbox = splatMesh.getBoundingBox();
    if (!bbox.isEmpty()) {
      const center = bbox.getCenter(new THREE.Vector3());
      const size = bbox.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);

      if (maxDim > 0) {
        const targetScale = Math.min(2.5, 1.6 / maxDim);
        this.state.splatScale = targetScale;
        splatMesh.scale.setScalar(targetScale);
        splatMesh.position.set(
          -center.x * targetScale,
          -center.y * targetScale,
          -center.z * targetScale
        );
      }
    }

    this.showToast(`Splat ready: ${item.name}`, 'success');
  }

  /**
   * Loads an equirectangular 360 photo onto an inverted sphere
   */
  private async load360Photo(item: MediaItem): Promise<void> {
    return new Promise((resolve, reject) => {
      this.showToast(`Loading 360° Photo: ${item.name}...`, 'success');

      const loader = new THREE.TextureLoader();
      loader.load(
        item.url,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;

          const geometry = new THREE.SphereGeometry(500, 60, 40);
          geometry.scale(-1, 1, 1); // Invert faces inward

          const material = new THREE.MeshBasicMaterial({ map: texture });
          const sphere = new THREE.Mesh(geometry, material);
          sphere.position.set(0, 0, 0);

          this.currentSphereMesh = sphere;
          this.mediaGroup.add(sphere);

          this.showToast(`360° Photo ready: ${item.name}`, 'success');
          resolve();
        },
        undefined,
        (err) => reject(err)
      );
    });
  }

  /**
   * Loads an equirectangular 360 video with HTML5 VideoTexture
   */
  private async load360Video(item: MediaItem): Promise<void> {
    this.showToast(`Loading 360° Video: ${item.name}...`, 'success');

    const video = document.createElement('video');
    video.src = item.url;
    video.crossOrigin = 'anonymous';
    video.playsInline = true;
    video.loop = true;
    video.muted = this.state.isMuted;
    video.volume = this.state.volume;
    video.autoplay = true;

    this.currentVideo = video;

    video.addEventListener('loadedmetadata', () => {
      this.state.duration = video.duration || 0;
      this.updateHUD();
      this.updateVrCard();
    });

    video.addEventListener('timeupdate', () => {
      this.state.currentTime = video.currentTime;
      this.updateVideoProgress();
    });

    video.addEventListener('play', () => {
      this.state.isPlaying = true;
      this.syncPlayButtons();
    });

    video.addEventListener('pause', () => {
      this.state.isPlaying = false;
      this.syncPlayButtons();
    });

    try {
      await video.play();
      this.state.isPlaying = true;
    } catch {
      // Autoplay with sound might be blocked initially; mute and retry
      video.muted = true;
      this.state.isMuted = true;
      await video.play().catch((e) => console.warn('Video play catch:', e));
    }

    const videoTexture = new THREE.VideoTexture(video);
    videoTexture.colorSpace = THREE.SRGBColorSpace;
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;
    this.currentVideoTexture = videoTexture;

    const geometry = new THREE.SphereGeometry(500, 60, 40);
    geometry.scale(-1, 1, 1);

    const material = new THREE.MeshBasicMaterial({ map: videoTexture });
    const sphere = new THREE.Mesh(geometry, material);
    sphere.position.set(0, 0, 0);

    this.currentSphereMesh = sphere;
    this.mediaGroup.add(sphere);

    this.showToast(`360° Video playing: ${item.name}`, 'success');
  }

  /**
   * Cleanup active media
   */
  private cleanupCurrentMedia() {
    if (this.currentSplatMesh) {
      this.mediaGroup.remove(this.currentSplatMesh);
      this.currentSplatMesh.dispose();
      this.currentSplatMesh = undefined;
    }

    if (this.currentSphereMesh) {
      this.mediaGroup.remove(this.currentSphereMesh);
      this.currentSphereMesh.geometry.dispose();
      if (Array.isArray(this.currentSphereMesh.material)) {
        this.currentSphereMesh.material.forEach((m) => m.dispose());
      } else {
        this.currentSphereMesh.material.dispose();
      }
      this.currentSphereMesh = undefined;
    }

    if (this.currentVideoTexture) {
      this.currentVideoTexture.dispose();
      this.currentVideoTexture = undefined;
    }

    if (this.currentVideo) {
      this.currentVideo.pause();
      this.currentVideo.removeAttribute('src');
      this.currentVideo.load();
      this.currentVideo = undefined;
    }
  }

  // ==========================================
  // Playback & Splat Controls
  // ==========================================

  selectPreviousMedia() {
    if (this.state.playlist.length === 0) return;
    const prev = (this.state.currentIndex - 1 + this.state.playlist.length) % this.state.playlist.length;
    this.loadMediaItem(prev, true);
  }

  selectNextMedia() {
    if (this.state.playlist.length === 0) return;
    const next = (this.state.currentIndex + 1) % this.state.playlist.length;
    this.loadMediaItem(next, true);
  }

  toggleVideoPlayback() {
    if (!this.currentVideo) return;
    if (this.currentVideo.paused) {
      this.currentVideo.play().catch((e) => console.warn(e));
    } else {
      this.currentVideo.pause();
    }
  }

  restartVideo() {
    if (!this.currentVideo) return;
    this.currentVideo.currentTime = 0;
    this.currentVideo.play().catch((e) => console.warn(e));
  }

  toggleVideoMute() {
    if (!this.currentVideo) return;
    this.state.isMuted = !this.state.isMuted;
    this.currentVideo.muted = this.state.isMuted;
    this.syncMuteButtons();
  }

  adjustSplatScale(delta: number) {
    if (!this.currentSplatMesh) return;
    this.state.splatScale = Math.max(0.1, Math.min(5.0, this.state.splatScale + delta));
    this.currentSplatMesh.scale.setScalar(this.state.splatScale);
    const display = document.getElementById('splatScaleDisplay');
    if (display) display.textContent = `${this.state.splatScale.toFixed(1)}x`;
  }

  recenterSplat() {
    this.splatRotation.set(0, 0, 0);
    this.splatDistance = -1.5;
    this.mediaGroup.position.set(0, 1.2, this.splatDistance);
    this.mediaGroup.rotation.set(0, 0, 0);
  }

  // ==========================================
  // Desktop HUD & Pan Interactivity
  // ==========================================

  private setupDesktopInteractions() {
    const fileInput = document.getElementById('fileInput') as HTMLInputElement | null;
    const folderInput = document.getElementById('folderInput') as HTMLInputElement | null;
    const dropOverlay = document.getElementById('dropOverlay');

    // File Browser Triggers
    const triggerFilePick = () => fileInput?.click();
    const triggerFolderPick = () => folderInput?.click();

    document.getElementById('btnBrowseFiles')?.addEventListener('click', triggerFilePick);
    document.getElementById('btnBrowseFolder')?.addEventListener('click', triggerFolderPick);
    document.getElementById('btnWelcomeFiles')?.addEventListener('click', triggerFilePick);
    document.getElementById('btnWelcomeFolder')?.addEventListener('click', triggerFolderPick);
    document.getElementById('btnDockAdd')?.addEventListener('click', triggerFilePick);

    fileInput?.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length > 0) {
        this.handleFiles(fileInput.files);
        fileInput.value = '';
      }
    });

    folderInput?.addEventListener('change', () => {
      if (folderInput.files && folderInput.files.length > 0) {
        this.handleFiles(folderInput.files);
        folderInput.value = '';
      }
    });

    // Window Drag and Drop
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dropOverlay?.classList.remove('hidden');
    });

    window.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    window.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) {
        dropOverlay?.classList.add('hidden');
      }
    });

    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dropOverlay?.classList.add('hidden');
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        this.handleFiles(e.dataTransfer.files);
      }
    });

    // Dock Buttons
    document.getElementById('btnPrevMedia')?.addEventListener('click', () => this.selectPreviousMedia());
    document.getElementById('btnNextMedia')?.addEventListener('click', () => this.selectNextMedia());
    document.getElementById('btnVideoPlayPause')?.addEventListener('click', () => this.toggleVideoPlayback());
    document.getElementById('btnVideoReplay')?.addEventListener('click', () => this.restartVideo());
    document.getElementById('btnVideoMute')?.addEventListener('click', () => this.toggleVideoMute());
    document.getElementById('btnSplatScaleDown')?.addEventListener('click', () => this.adjustSplatScale(-0.2));
    document.getElementById('btnSplatScaleUp')?.addEventListener('click', () => this.adjustSplatScale(0.2));
    document.getElementById('btnSplatRecenter')?.addEventListener('click', () => this.recenterSplat());

    // Scrubber
    const scrubber = document.getElementById('videoScrubber') as HTMLInputElement | null;
    scrubber?.addEventListener('input', () => {
      if (this.currentVideo && this.state.duration > 0) {
        const percent = parseFloat(scrubber.value);
        this.currentVideo.currentTime = (percent / 100) * this.state.duration;
      }
    });

    // Enter VR Buttons
    document.getElementById('btnEnterVR')?.addEventListener('click', () => this.requestVRSession());
    document.getElementById('btnDockEnterVR')?.addEventListener('click', () => this.requestVRSession());

    // Desktop Mouse Drag to Look Around 360 photos/videos or rotate splats
    window.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.desktop-hud') || (e.target as HTMLElement).closest('.help-modal')) {
        return;
      }
      this.isUserInteracting = true;
      this.onPointerDownPointerX = e.clientX;
      this.onPointerDownPointerY = e.clientY;
      this.onPointerDownLon = this.lon;
      this.onPointerDownLat = this.lat;
    });

    window.addEventListener('pointermove', (e) => {
      if (!this.isUserInteracting) return;
      this.lon = (this.onPointerDownPointerX - e.clientX) * 0.15 + this.onPointerDownLon;
      this.lat = (e.clientY - this.onPointerDownPointerY) * 0.15 + this.onPointerDownLat;
      this.lat = Math.max(-85, Math.min(85, this.lat));

      if (this.currentSplatMesh) {
        this.splatRotation.y += (e.clientX - this.onPointerDownPointerX) * 0.0003;
        this.splatRotation.x += (e.clientY - this.onPointerDownPointerY) * 0.0003;
        this.mediaGroup.rotation.copy(this.splatRotation);
      }
    });

    window.addEventListener('pointerup', () => {
      this.isUserInteracting = false;
    });

    window.addEventListener('wheel', (e) => {
      if (this.currentSplatMesh) {
        this.splatDistance = Math.max(-5.0, Math.min(-0.4, this.splatDistance + e.deltaY * 0.002));
        this.mediaGroup.position.z = this.splatDistance;
      }
    });
  }

  // ==========================================
  // Meta Quest Sync Modal
  // ==========================================

  private setupQuestModal() {
    const btnQuestSync = document.getElementById('btnQuestSync');
    const modal = document.getElementById('questSyncModal');
    const btnClose = document.getElementById('btnCloseQuestModal');
    const btnDismiss = document.getElementById('btnDismissQuestModal');
    const urlInput = document.getElementById('questUrlInput') as HTMLInputElement | null;
    const btnCopy = document.getElementById('btnCopyQuestUrl');

    const updateQuestUrl = async () => {
      if (!urlInput) return;
      // Default to current browser URL
      let displayUrl = window.location.href;

      try {
        const res = await fetch('/api/network-info');
        if (res.ok) {
          const info = await res.json();
          // If on localhost, use the actual LAN IPv4 so the Quest on the same Wi-Fi can connect
          if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            if (info.localIps && info.localIps.length > 0) {
              displayUrl = `http://${info.localIps[0]}:3000/`;
            }
          }
        }
      } catch {
        // Fallback to window.location.href
      }

      urlInput.value = displayUrl;
    };

    btnQuestSync?.addEventListener('click', () => {
      updateQuestUrl();
      modal?.classList.remove('hidden');
    });

    btnClose?.addEventListener('click', () => modal?.classList.add('hidden'));
    btnDismiss?.addEventListener('click', () => modal?.classList.add('hidden'));

    btnCopy?.addEventListener('click', async () => {
      if (urlInput) {
        await navigator.clipboard.writeText(urlInput.value);
        if (btnCopy) btnCopy.textContent = 'Copied!';
        setTimeout(() => {
          if (btnCopy) btnCopy.textContent = 'Copy';
        }, 2000);
      }
    });

    // Also close help modal buttons
    document.getElementById('btnCloseHelpModal')?.addEventListener('click', () => {
      document.getElementById('webxrHelpModal')?.classList.add('hidden');
    });
    document.getElementById('btnDismissHelpModal')?.addEventListener('click', () => {
      document.getElementById('webxrHelpModal')?.classList.add('hidden');
    });
    document.getElementById('btnTryEnterVRAnyway')?.addEventListener('click', () => {
      document.getElementById('webxrHelpModal')?.classList.add('hidden');
      this.forceRequestVRSession();
    });
  }

  // ==========================================
  // UI Synchronizers & Renderers
  // ==========================================

  private updateHUD() {
    const item = this.state.currentMedia;
    if (!item) return;

    const badge = document.getElementById('dockMediaTypeBadge');
    const title = document.getElementById('dockMediaTitle');
    const meta = document.getElementById('dockMediaMeta');

    if (badge) {
      badge.textContent =
        item.type === 'splat'
          ? `3D SPLAT (${item.formatExtension})`
          : item.type === 'photo360'
            ? '360° PHOTO'
            : '360° VIDEO';
    }
    if (title) title.textContent = item.name;
    if (meta) {
      meta.textContent = `${item.sizeFormatted} · File ${this.state.currentIndex + 1} of ${this.state.playlist.length}`;
    }

    const videoControls = document.getElementById('videoControls');
    const splatControls = document.getElementById('splatControls');

    if (item.type === 'video360') {
      videoControls?.classList.remove('hidden');
      splatControls?.classList.add('hidden');
    } else if (item.type === 'splat') {
      videoControls?.classList.add('hidden');
      splatControls?.classList.remove('hidden');
      const display = document.getElementById('splatScaleDisplay');
      if (display) display.textContent = `${this.state.splatScale.toFixed(1)}x`;
    } else {
      videoControls?.classList.add('hidden');
      splatControls?.classList.add('hidden');
    }

    this.syncPlayButtons();
    this.syncMuteButtons();
  }

  private updateVrCard() {
    if (!this.vrFormatText || !this.vrFileNameText || !this.vrMetaText) return;
    const item = this.state.currentMedia;

    if (!item) {
      this.vrFormatText.text = 'NO MEDIA LOADED';
      this.vrFileNameText.text = 'Select or drop files on desktop';
      this.vrMetaText.text = 'Click Load File to open local files';
      if (this.vrVideoRow) this.vrVideoRow.visible = false;
      if (this.vrSplatRow) this.vrSplatRow.visible = false;
      return;
    }

    this.vrFormatText.text =
      item.type === 'splat'
        ? `3D GAUSSIAN SPLAT (${item.formatExtension})`
        : item.type === 'photo360'
          ? `360° PANORAMA (${item.formatExtension})`
          : `360° SPATIAL VIDEO (${item.formatExtension})`;

    this.vrFileNameText.text = item.name;
    this.vrMetaText.text = `${item.sizeFormatted} · File ${this.state.currentIndex + 1} of ${this.state.playlist.length}`;

    if (this.vrVideoRow) this.vrVideoRow.visible = item.type === 'video360';
    if (this.vrSplatRow) this.vrSplatRow.visible = item.type === 'splat';

    if (this.vrPlayButton) {
      this.vrPlayButton.label = this.state.isPlaying ? 'Pause' : 'Play';
      this.vrPlayButton.icon = this.state.isPlaying ? 'pause' : 'play_arrow';
    }

    if (this.vrMuteButton) {
      this.vrMuteButton.label = this.state.isMuted ? 'Unmute' : 'Mute';
      this.vrMuteButton.icon = this.state.isMuted ? 'volume_off' : 'volume_up';
    }
  }

  private updateVideoProgress() {
    const timeDisplay = document.getElementById('videoTimeDisplay');
    const scrubber = document.getElementById('videoScrubber') as HTMLInputElement | null;

    if (timeDisplay) {
      timeDisplay.textContent = `${formatTime(this.state.currentTime)} / ${formatTime(this.state.duration)}`;
    }
    if (scrubber && this.state.duration > 0) {
      scrubber.value = ((this.state.currentTime / this.state.duration) * 100).toFixed(1);
    }
  }

  private syncPlayButtons() {
    const iconPlay = document.getElementById('iconPlay');
    const iconPause = document.getElementById('iconPause');

    if (this.state.isPlaying) {
      iconPlay?.classList.add('hidden');
      iconPause?.classList.remove('hidden');
    } else {
      iconPlay?.classList.remove('hidden');
      iconPause?.classList.add('hidden');
    }

    if (this.vrPlayButton) {
      this.vrPlayButton.label = this.state.isPlaying ? 'Pause' : 'Play';
      this.vrPlayButton.icon = this.state.isPlaying ? 'pause' : 'play_arrow';
    }
  }

  private syncMuteButtons() {
    const iconHigh = document.getElementById('iconVolumeHigh');
    const iconMuted = document.getElementById('iconVolumeMuted');

    if (this.state.isMuted) {
      iconHigh?.classList.add('hidden');
      iconMuted?.classList.remove('hidden');
    } else {
      iconHigh?.classList.remove('hidden');
      iconMuted?.classList.add('hidden');
    }

    if (this.vrMuteButton) {
      this.vrMuteButton.label = this.state.isMuted ? 'Unmute' : 'Mute';
      this.vrMuteButton.icon = this.state.isMuted ? 'volume_off' : 'volume_up';
    }
  }

  private renderPlaylistStrip() {
    const strip = document.getElementById('playlistStrip');
    if (!strip) return;

    if (this.state.playlist.length <= 1) {
      strip.classList.add('hidden');
      return;
    }

    strip.classList.remove('hidden');
    strip.innerHTML = '';

    this.state.playlist.forEach((item, index) => {
      const btn = document.createElement('button');
      btn.className = `playlist-item ${index === this.state.currentIndex ? 'active' : ''}`;
      btn.innerHTML = `
        <span>${item.type === 'splat' ? '🔷' : item.type === 'photo360' ? '🌐' : '🎬'}</span>
        <span>${item.name}</span>
      `;
      btn.addEventListener('click', () => this.loadMediaItem(index, true));
      strip.appendChild(btn);
    });
  }

  private showToast(message: string, type: 'success' | 'error' = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  // ==========================================
  // WebXR Session Management
  // ==========================================

  update() {
    // Desktop Camera Pan (when not presenting WebXR)
    if (!xb.core.renderer.xr.isPresenting) {
      const type = this.state.currentMedia?.type;
      if (type === 'photo360' || type === 'video360') {
        const phi = THREE.MathUtils.degToRad(90 - this.lat);
        const theta = THREE.MathUtils.degToRad(this.lon);

        this.cameraTarget.set(
          500 * Math.sin(phi) * Math.cos(theta),
          500 * Math.cos(phi),
          500 * Math.sin(phi) * Math.sin(theta)
        );
        xb.core.camera.lookAt(this.cameraTarget);
      }
    }
  }

  onXRSessionStarted() {
    this.state.isXrActive = true;
    document.getElementById('desktopHud')?.classList.add('hidden');
    this.updateVrCard();
    this.showToast('Entered WebXR VR Session', 'success');
  }

  onXRSessionEnded() {
    this.state.isXrActive = false;
    document.getElementById('desktopHud')?.classList.remove('hidden');
    this.updateHUD();
    this.showToast('Exited VR Session', 'success');
  }

  async requestVRSession() {
    try {
      const sessionManager = xb.core.registry.get(xb.WebXRSessionManager);
      if (sessionManager && sessionManager.isXRSupported()) {
        sessionManager.startSession();
        return;
      }

      if ('xr' in navigator && navigator.xr) {
        const isVR = await navigator.xr.isSessionSupported('immersive-vr');
        if (isVR) {
          const session = await navigator.xr.requestSession('immersive-vr', {
            optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
          });
          const xr = xb.core.renderer.xr as unknown as { setSession: (s: XRSession) => Promise<void> };
          await xr.setSession(session);
          return;
        }
      }

      // If not supported on desktop, open the Quest sync modal
      this.showToast('No VR headset connected to PC. Open on Meta Quest Browser instead!', 'error');
      document.getElementById('questSyncModal')?.classList.remove('hidden');
    } catch (err) {
      console.error('Enter VR error:', err);
      this.showToast('Could not start VR: ' + (err instanceof Error ? err.message : String(err)), 'error');
      document.getElementById('webxrHelpModal')?.classList.remove('hidden');
    }
  }

  async forceRequestVRSession() {
    if ('xr' in navigator && navigator.xr) {
      try {
        const session = await navigator.xr.requestSession('immersive-vr', {
          optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
        });
        const xr = xb.core.renderer.xr as unknown as { setSession: (s: XRSession) => Promise<void> };
        await xr.setSession(session);
        return;
      } catch (err) {
        this.showToast('Force start failed: ' + (err instanceof Error ? err.message : String(err)), 'error');
      }
    } else {
      this.showToast('WebXR navigator.xr is not available in this browser window.', 'error');
    }
  }

  private checkWebXRSupport() {
    if ('xr' in navigator && navigator.xr) {
      navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
        const btn = document.getElementById('btnEnterVR');
        const dockBtn = document.getElementById('btnDockEnterVR');
        const btnText = document.getElementById('btnEnterVRText');
        if (supported) {
          btn?.classList.add('hud-btn-vr-ready');
          dockBtn?.classList.add('hud-btn-vr-ready');
          if (btnText) btnText.textContent = 'Enter VR (Ready)';
        }
      }).catch(() => {});
    }
  }

  dispose() {
    this.cleanupCurrentMedia();
    if (this.sparkRenderer) {
      this.sparkRenderer.dispose();
    }
    if (this.eventSource) {
      this.eventSource.close();
    }
    for (const item of this.state.playlist) {
      if (item.url.startsWith('blob:')) {
        URL.revokeObjectURL(item.url);
      }
    }
  }
}

// XR Blocks Entry Point
document.addEventListener('DOMContentLoaded', async () => {
  const options = new xb.Options();

  // Configure WebXR session specifically for VR (supports Meta Quest, SteamVR, PCVR)
  options.enableVR();
  options.enableHands();
  options.hands.visualization = true;

  // Configure XR Button to display clean 'ENTER VR'
  options.xrButton.enabled = true;
  options.xrButton.startText = 'ENTER VR';
  options.xrButton.endText = 'EXIT VR';
  options.xrButton.invalidText = 'VR NOT DETECTED';
  options.xrButton.showEnterSimulatorButton = false;
  options.xrButton.alwaysAutostartSimulator = false;

  xb.add(new XRMediaStudio());
  await xb.init(options);
});
