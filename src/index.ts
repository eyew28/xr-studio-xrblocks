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

/** Splat rotation per meter the controller's ray travels across the splat. */
const SPLAT_ROTATE_RADIANS_PER_METER = 2;
/** Smallest side of the splat's hit box, so thin splats stay easy to point at. */
const SPLAT_HIT_BOX_MIN_SIZE_METERS = 0.2;
/** Added to hit box hit distances: farther than the VR card can be pushed. */
const SPLAT_HIT_BOX_SORT_OFFSET_METERS = 1000;
/** Rays nearly parallel to the drag plane hit it too far away to be useful. */
const SPLAT_DRAG_MIN_RAY_ANGLE_COSINE = 0.15;

/**
 * Must stay well inside the camera's far plane (500 m). Otherwise, whenever the
 * viewer's eye is off the sphere's center, the point being looked at gets
 * clipped, leaving a black hole in the middle of the view.
 */
const MEDIA_SPHERE_RADIUS_METERS = 400;

/** First controller rotates; a second controller's select scales. */
const SPLAT_VR_MANIPULATION = {
  actions: {
    rotate: true,
    scale: { minScale: 0.1, maxScale: 10 },
  },
};

/** Thumbstick deflection ignored so resting sticks and drift don't move anything. */
const THUMBSTICK_DEADZONE = 0.15;
/** Splat movement at full thumbstick deflection. */
const THUMBSTICK_MOVE_METERS_PER_SECOND = 1;
/** Splat rotation at full thumbstick deflection. */
const THUMBSTICK_ROTATE_RADIANS_PER_SECOND = Math.PI / 2;
/** Longest frame step applied, so a stall can't make the splat jump. */
const THUMBSTICK_MAX_FRAME_SECONDS = 0.1;

// SuperSplat's starting view, from src/scene-config.ts and src/camera.ts in
// playcanvas/supersplat: an orbit camera looking at (0, 0.5, 0) from azimuth
// -45 and elevation -10, at a distance of 1 / sin(fov / 2). It doesn't move to
// fit the splat, and the splat keeps its file scale and origin.
const SUPERSPLAT_FOCAL_POINT = new THREE.Vector3(0, 0.5, 0);
const SUPERSPLAT_AZIMUTH_DEGREES = -45;
const SUPERSPLAT_ELEVATION_DEGREES = -10;
/** Applies to the wider axis of the view. */
const SUPERSPLAT_FOV_DEGREES = 85;

/** Where SuperSplat's camera starts, in the splat's coordinates after loading. */
function superSplatCameraPosition(): THREE.Vector3 {
  const elevation = THREE.MathUtils.degToRad(-SUPERSPLAT_ELEVATION_DEGREES);
  const azimuth = THREE.MathUtils.degToRad(-SUPERSPLAT_AZIMUTH_DEGREES);
  const distance = 1 / Math.sin(THREE.MathUtils.degToRad(SUPERSPLAT_FOV_DEGREES / 2));
  return new THREE.Vector3(
    -Math.cos(elevation) * Math.sin(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.cos(azimuth)
  )
    .multiplyScalar(distance)
    .add(SUPERSPLAT_FOCAL_POINT);
}

/** Heading of a direction around the vertical axis, where -Z is 0. */
function yawOf(direction: THREE.Vector3): number {
  return Math.atan2(-direction.x, -direction.z);
}

/** xr-standard gamepad buttons that toggle the VR card: thumbstick click, A/X and B/Y. */
const CARD_TOGGLE_BUTTON_INDICES = [3, 4, 5];
/** A card shown again within this angle of the viewer's gaze stays where it was. */
const VR_CARD_IN_VIEW_RADIANS = THREE.MathUtils.degToRad(40);
const VR_CARD_SUMMON_DISTANCE_METERS = 0.9;
const VR_CARD_SUMMON_HEIGHT_OFFSET_METERS = -0.15;
/** Sorts the VR card after the splat and everything else in the scene. */
const VR_CARD_RENDER_ORDER = 1_000_000;
/**
 * xrblocks draws each card through a private copy named after it, so a unique
 * name lets the app find this card's drawn parts.
 */
const VR_CARD_NAME = 'XR Studio VR Card';

/** Share of splats trimmed from each end of each axis when measuring the subject. */
const SPLAT_CORE_TRIM = 0.01;
/** Enough positions to measure the subject without pausing on very large files. */
const SPLAT_CORE_MAX_SAMPLES = 100_000;

/**
 * Measures the splat's main subject, ignoring far-off stray splats. Captures
 * often contain a few "floaters" that are many times farther away than the
 * subject, which makes a full bounding box far too big and pulls its center
 * away from the subject.
 */
function measureSplatCore(splatMesh: SplatMesh): { center: THREE.Vector3; size: THREE.Vector3 } | undefined {
  const numSplats = splatMesh.packedSplats?.numSplats ?? 0;
  const step = Math.max(1, Math.floor(numSplats / SPLAT_CORE_MAX_SAMPLES));
  const axes: number[][] = [[], [], []];
  splatMesh.forEachSplat((index, center) => {
    if (index % step !== 0) return;
    axes[0].push(center.x);
    axes[1].push(center.y);
    axes[2].push(center.z);
  });
  if (axes[0].length === 0) return undefined;

  const box = new THREE.Box3();
  axes.forEach((values, axis) => {
    const sorted = Float64Array.from(values).sort();
    const trim = Math.floor(sorted.length * SPLAT_CORE_TRIM);
    box.min.setComponent(axis, sorted[trim]);
    box.max.setComponent(axis, sorted[sorted.length - 1 - trim]);
  });
  return { center: box.getCenter(new THREE.Vector3()), size: box.getSize(new THREE.Vector3()) };
}

interface SplatDrag {
  baseQuaternion: THREE.Quaternion;
  plane: THREE.Plane;
  right: THREE.Vector3;
  startPoint?: THREE.Vector3;
}

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
  private defaultCameraFov?: number;
  private desktopSplatViewActive = false;

  // VR splat interaction. Spark's splat raycast is too slow to run every frame,
  // so an invisible box around the splat is what controller rays hit.
  private splatHitBox = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
  );
  private splatBounds?: { center: THREE.Vector3; size: THREE.Vector3 };
  private splatDrag?: SplatDrag;
  private isDraggingVrCard = false;
  private vrCardDrawn?: THREE.Object3D;
  private vrCardMaterialDefaults = new Map<
    THREE.Material,
    { transparent: boolean; depthTest: boolean; depthWrite: boolean }
  >();
  private cardToggleButtonsDown = new WeakMap<XRInputSource, boolean[]>();
  private lastThumbstickUpdateMs = 0;

  // Sync state
  private eventSource?: EventSource;
  private isSyncingFromRemote = false;

  constructor() {
    super();
    this.name = 'XRMediaStudio';
  }

  init() {
    this.add(this.mediaGroup);
    this.splatHitBox.visible = false;
    // Sort hit box hits behind the VR card, so its buttons stay clickable even
    // when the box is between the card and the viewer. Rays still land on the
    // real hit point, which is what the reticle and manipulation use.
    this.splatHitBox.raycast = (raycaster, intersects) => {
      const firstNewHit = intersects.length;
      THREE.Mesh.prototype.raycast.call(this.splatHitBox, raycaster, intersects);
      for (let i = firstNewHit; i < intersects.length; i++) {
        intersects[i].distance += SPLAT_HIT_BOX_SORT_OFFSET_METERS;
      }
    };
    this.mediaGroup.add(this.splatHitBox);

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
      label: 'Exit',
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
      manipulation: {
        actions: {
          translate: { faceCamera: true, pushPull: true },
          scale: true,
        },
      },
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
    this.vrCard.name = VR_CARD_NAME;
    this.add(this.vrCard);

    // Runs just before three.js sorts the scene for drawing, after any UI
    // updates, so the card's on-top settings are always in place.
    const scene = xb.core.scene;
    const previousOnBeforeRender = scene.onBeforeRender;
    scene.onBeforeRender = (...args) => {
      this.updateVrCardDrawOrder();
      previousOnBeforeRender.apply(scene, args);
    };
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
      this.eventSource.addEventListener('cleared', () => this.clearLocalMedia());

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

  /** Deletes all uploaded media from the server, which clears every connected device. */
  private async clearUploadedMedia() {
    try {
      const res = await fetch('/api/session', { method: 'DELETE' });
      if (!res.ok) throw new Error(`Server responded with ${res.status}`);
      const { deleted, failed } = (await res.json()) as { deleted: number; failed: string[] };
      this.clearLocalMedia();
      if (failed.length > 0) {
        this.showToast(`Cleared ${deleted} file(s), but could not delete ${failed.length}`, 'error');
      } else {
        this.showToast(`Cleared ${deleted} uploaded file(s)`, 'success');
      }
    } catch (err) {
      console.error('Clear media error:', err);
      this.showToast('Could not clear media: ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  }

  private clearLocalMedia() {
    for (const item of this.state.playlist) {
      if (item.url.startsWith('blob:')) URL.revokeObjectURL(item.url);
    }
    this.state.playlist = [];
    this.state.currentIndex = -1;
    this.state.currentMedia = null;
    this.state.isPlaying = false;
    this.cleanupCurrentMedia();

    document.getElementById('bottomDock')?.classList.add('hidden');
    document.getElementById('welcomeCard')?.classList.remove('hidden');
    this.renderPlaylistStrip();
    this.updateVrCard();
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
    splatMesh.xb = { pointerEvents: 'none' };
    // These formats usually store Y pointing down, so they would load upside down.
    if (['PLY', 'SPZ', 'SPLAT'].includes(item.formatExtension)) splatMesh.rotation.z = Math.PI;
    this.currentSplatMesh = splatMesh;
    this.mediaGroup.add(splatMesh);

    await splatMesh.initialized;
    // Another file may have been selected while this one was loading.
    if (this.currentSplatMesh !== splatMesh) return;

    // The main subject is the rotation pivot and the VR hit box; the splat
    // itself keeps its file scale, as in SuperSplat.
    const core = measureSplatCore(splatMesh);
    if (core && Math.max(core.size.x, core.size.y, core.size.z) > 0) this.splatBounds = core;
    this.applySplatScale(1);
    this.frameSplatLikeSuperSplat();
    this.syncVrInteraction();

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
          // The media may have been cleared or changed while this was loading.
          if (this.state.currentMedia !== item) {
            texture.dispose();
            resolve();
            return;
          }
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;

          const geometry = new THREE.SphereGeometry(MEDIA_SPHERE_RADIUS_METERS, 60, 40);
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
    // The media may have been cleared or changed while this was starting.
    if (this.state.currentMedia !== item) return;

    const videoTexture = new THREE.VideoTexture(video);
    videoTexture.colorSpace = THREE.SRGBColorSpace;
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;
    this.currentVideoTexture = videoTexture;

    const geometry = new THREE.SphereGeometry(MEDIA_SPHERE_RADIUS_METERS, 60, 40);
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
    this.splatBounds = undefined;
    this.resetSplatTransform();
    this.restoreDesktopCamera();
    this.syncVrInteraction();

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
    this.applySplatScale(Math.max(0.1, Math.min(5.0, this.state.splatScale + delta)));
    const display = document.getElementById('splatScaleDisplay');
    if (display) display.textContent = `${this.state.splatScale.toFixed(1)}x`;
  }

  /** Scales the splat while keeping it centered in mediaGroup, its rotation pivot. */
  private applySplatScale(scale: number) {
    this.state.splatScale = scale;
    if (!this.currentSplatMesh) return;
    this.currentSplatMesh.scale.setScalar(scale);
    if (!this.splatBounds) return;
    const { center, size } = this.splatBounds;
    this.currentSplatMesh.position
      .copy(center)
      .applyQuaternion(this.currentSplatMesh.quaternion)
      .multiplyScalar(-scale);
    this.splatHitBox.scale.set(
      Math.max(size.x * scale, SPLAT_HIT_BOX_MIN_SIZE_METERS),
      Math.max(size.y * scale, SPLAT_HIT_BOX_MIN_SIZE_METERS),
      Math.max(size.z * scale, SPLAT_HIT_BOX_MIN_SIZE_METERS)
    );
  }

  recenterSplat() {
    this.resetSplatTransform();
    this.frameSplatLikeSuperSplat();
  }

  /**
   * Places the splat so the viewer sees it the way SuperSplat first shows it:
   * their head (or the desktop camera) takes the place of SuperSplat's camera.
   * The world can't tilt in VR, so its 10 degree downward look comes from the
   * splat sitting below eye level instead.
   */
  private frameSplatLikeSuperSplat() {
    const mesh = this.currentSplatMesh;
    if (!mesh) return;
    const viewer = this.getViewerPose();

    // The camera's position and gaze in mediaGroup's coordinates.
    const camera = superSplatCameraPosition();
    const cameraLocal = camera.clone().multiplyScalar(this.state.splatScale).add(mesh.position);
    const gaze = SUPERSPLAT_FOCAL_POINT.clone().sub(camera);

    this.mediaGroup.scale.setScalar(1);
    this.mediaGroup.rotation.set(0, viewer.yaw - yawOf(gaze), 0);
    this.mediaGroup.position.copy(viewer.position).sub(cameraLocal.applyQuaternion(this.mediaGroup.quaternion));
    this.splatRotation.copy(this.mediaGroup.rotation);
    this.applyDesktopSplatView(viewer.yaw);
  }

  /** The viewer's eye position and the direction they face, ignoring tilt. */
  private getViewerPose(): { position: THREE.Vector3; yaw: number } {
    const xr = xb.core.renderer.xr;
    const camera = xr.isPresenting ? xr.getCamera() : xb.core.camera;
    const forward = camera.getWorldDirection(new THREE.Vector3());
    forward.y = 0;
    return {
      position: camera.getWorldPosition(new THREE.Vector3()),
      yaw: forward.lengthSq() > 1e-6 ? yawOf(forward) : 0,
    };
  }

  /**
   * On desktop, also matches SuperSplat's camera tilt and field of view. In VR
   * the headset sets both. The desktop simulator keeps both until the viewer
   * moves the camera.
   */
  private applyDesktopSplatView(yaw: number) {
    if (xb.core.renderer.xr.isPresenting) return;
    const camera = xb.core.camera;
    this.defaultCameraFov ??= camera.fov;
    camera.quaternion.setFromEuler(
      new THREE.Euler(THREE.MathUtils.degToRad(SUPERSPLAT_ELEVATION_DEGREES), yaw, 0, 'YXZ')
    );
    this.desktopSplatViewActive = true;
    this.updateDesktopSplatFov();
  }

  private updateDesktopSplatFov() {
    if (!this.desktopSplatViewActive) return;
    const camera = xb.core.camera;
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    const halfFov = THREE.MathUtils.degToRad(SUPERSPLAT_FOV_DEGREES / 2);
    // three.js measures fov vertically; SuperSplat applies it to the wider axis.
    const verticalHalfFov = aspect > 1 ? Math.atan(Math.tan(halfFov) / aspect) : halfFov;
    camera.fov = THREE.MathUtils.radToDeg(2 * verticalHalfFov);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }

  private restoreDesktopCamera() {
    if (!this.desktopSplatViewActive) return;
    this.desktopSplatViewActive = false;
    if (this.defaultCameraFov !== undefined) {
      xb.core.camera.fov = this.defaultCameraFov;
      xb.core.camera.updateProjectionMatrix();
    }
  }

  private resetSplatTransform() {
    this.splatRotation.set(0, 0, 0);
    this.mediaGroup.rotation.set(0, 0, 0);
    this.mediaGroup.scale.setScalar(1);
  }

  // ==========================================
  // VR Splat & UI Interaction
  // ==========================================

  /**
   * Enables controller interaction only inside a VR session. On desktop the
   * mouse also drives xrblocks interaction, which would fight the desktop
   * pointer handlers.
   */
  private syncVrInteraction() {
    const canManipulateSplat =
      this.state.isXrActive && !!this.currentSplatMesh && !!this.splatBounds;
    this.splatHitBox.visible = canManipulateSplat;
    this.mediaGroup.xb = canManipulateSplat
      ? { manipulation: SPLAT_VR_MANIPULATION }
      : undefined;
    if (this.vrCard) {
      this.vrCard.edge = { translateFromSurface: this.state.isXrActive };
    }
  }

  /**
   * Left stick: moves the splat up/down, and left/right as the viewer sees it.
   * Right stick: left/right rotates the splat, up/down moves the viewer
   * forward or back the way they're facing. Only the axis pushed further
   * applies, so pushing forward slightly off-center doesn't also spin the splat.
   */
  private updateThumbstickControls() {
    const now = performance.now();
    const seconds = Math.min((now - this.lastThumbstickUpdateMs) / 1000, THUMBSTICK_MAX_FRAME_SECONDS);
    this.lastThumbstickUpdateMs = now;

    // While dragging the card, xrblocks uses the stick to push and pull it.
    if (!this.state.isXrActive || !this.splatBounds || this.isDraggingVrCard) return;
    const session = xb.core.renderer.xr.getSession?.();
    if (!session) return;

    for (const source of session.inputSources) {
      // xr-standard mapping: axes 2 and 3 are the thumbstick, with forward negative.
      const axes = source.gamepad?.axes;
      if (!axes || axes.length < 4) continue;
      const stickX = Math.abs(axes[2]) > THUMBSTICK_DEADZONE ? axes[2] : 0;
      const stickY = Math.abs(axes[3]) > THUMBSTICK_DEADZONE ? axes[3] : 0;

      const distance = THUMBSTICK_MOVE_METERS_PER_SECOND * seconds;
      if (source.handedness === 'left') {
        this.mediaGroup.position.y -= stickY * distance;
        if (stickX !== 0) {
          const right = this.getLevelViewDirection()?.cross(THREE.Object3D.DEFAULT_UP);
          if (right) this.mediaGroup.position.addScaledVector(right, stickX * distance);
        }
      } else if (source.handedness === 'right') {
        if (Math.abs(stickY) > Math.abs(stickX)) {
          // The viewer can't move, so the splat moves the opposite way. Forward
          // is negative, so pushing up brings the splat toward the viewer.
          const forward = this.getLevelViewDirection();
          if (forward) this.mediaGroup.position.addScaledVector(forward, stickY * distance);
        } else if (stickX !== 0 && !this.splatDrag) {
          const angle = stickX * THUMBSTICK_ROTATE_RADIANS_PER_SECOND * seconds;
          this.mediaGroup.quaternion.premultiply(
            new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, angle)
          );
          this.splatRotation.copy(this.mediaGroup.rotation);
        }
      }
    }
  }

  /**
   * A, B, X, Y and thumbstick clicks show or hide the VR card. Triggers and
   * grips are left alone, as they select, grab, rotate and scale.
   */
  private updateCardToggleButtons() {
    if (!this.state.isXrActive || !this.vrCard) return;
    const session = xb.core.renderer.xr.getSession?.();
    if (!session) return;

    let toggle = false;
    for (const source of session.inputSources) {
      const buttons = source.gamepad?.buttons;
      if (!buttons) continue;
      const wasPressed = this.cardToggleButtonsDown.get(source) ?? [];
      const pressed = CARD_TOGGLE_BUTTON_INDICES.map((index) => buttons[index]?.pressed ?? false);
      if (pressed.some((down, i) => down && !wasPressed[i])) toggle = true;
      this.cardToggleButtonsDown.set(source, pressed);
    }
    if (!toggle) return;

    this.vrCard.visible = !this.vrCard.visible;
    if (this.vrCard.visible) this.bringVrCardIntoView();
  }

  /** Moves the card in front of the viewer if they've turned away from it. */
  private bringVrCardIntoView() {
    const card = this.vrCard;
    if (!card) return;
    const camera = xb.core.renderer.xr.getCamera();
    const head = camera.getWorldPosition(new THREE.Vector3());
    const gaze = camera.getWorldDirection(new THREE.Vector3());
    const toCard = card.getWorldPosition(new THREE.Vector3()).sub(head);
    if (toCard.lengthSq() > 1e-6 && toCard.angleTo(gaze) <= VR_CARD_IN_VIEW_RADIANS) return;

    const forward = this.getLevelViewDirection() ?? new THREE.Vector3(0, 0, -1);
    card.position
      .copy(head)
      .addScaledVector(forward, VR_CARD_SUMMON_DISTANCE_METERS)
      .add(new THREE.Vector3(0, VR_CARD_SUMMON_HEIGHT_OFFSET_METERS, 0));
    card.lookAt(head.x, card.position.y, head.z);
  }

  /**
   * In VR and AR, draws the card over the splat so nearer parts of the splat
   * can't hide it. three.js draws opaque objects before transparent ones like
   * splats, so the card's parts move into the transparent pass, sorted last,
   * with depth testing off. uikit's sort keeps the card's own layers in order.
   * Desktop keeps normal drawing, and the original settings come back.
   */
  private updateVrCardDrawOrder() {
    if (!this.vrCardDrawn?.parent) {
      this.vrCardDrawn = xb.core.scene.getObjectByName(`Private ${VR_CARD_NAME}`);
      if (!this.vrCardDrawn) return;
    }
    const onTop = this.state.isXrActive;
    // A Group's renderOrder sorts everything inside it together.
    this.vrCardDrawn.renderOrder = onTop ? VR_CARD_RENDER_ORDER : 0;
    this.vrCardDrawn.traverse((object) => {
      const material = (object as THREE.Mesh).material;
      if (!material) return;
      for (const m of Array.isArray(material) ? material : [material]) {
        if (onTop) {
          if (!this.vrCardMaterialDefaults.has(m)) {
            this.vrCardMaterialDefaults.set(m, {
              transparent: m.transparent,
              depthTest: m.depthTest,
              depthWrite: m.depthWrite,
            });
          }
          m.transparent = true;
          m.depthTest = false;
          m.depthWrite = false;
        } else {
          const defaults = this.vrCardMaterialDefaults.get(m);
          if (defaults) Object.assign(m, defaults);
        }
      }
    });
    if (!onTop) this.vrCardMaterialDefaults.clear();
  }

  /** The viewer's facing direction, ignoring up/down tilt. Undefined when looking straight up or down. */
  private getLevelViewDirection(): THREE.Vector3 | undefined {
    const direction = xb.core.renderer.xr.getCamera().getWorldDirection(new THREE.Vector3());
    direction.y = 0;
    return direction.lengthSq() > 1e-6 ? direction.normalize() : undefined;
  }

  override onObjectManipulate(event: xb.ManipulationEvent) {
    if (event.owner === this.vrCard && event.action === 'translate') {
      this.isDraggingVrCard = event.phase === 'start' || event.phase === 'update';
      return;
    }
    if (event.owner !== this.mediaGroup || event.action !== 'rotate') return;
    const controller = event.source.controller;
    if (event.phase === 'start') {
      // xrblocks' rotate only turns around one axis. Keep its session handling,
      // which hands over to two-controller scale, but rotate freely here.
      event.preventDefault();
      this.startSplatDrag(controller);
    } else if (event.phase === 'update') {
      this.updateSplatDrag(controller);
    } else {
      this.splatDrag = undefined;
      this.splatRotation.copy(this.mediaGroup.rotation);
    }
  }

  private startSplatDrag(controller: THREE.Object3D) {
    const center = this.mediaGroup.getWorldPosition(new THREE.Vector3());
    const toSplat = center.clone().sub(controller.getWorldPosition(new THREE.Vector3()));
    toSplat.y = 0;
    if (toSplat.lengthSq() < 1e-6) {
      controller.getWorldDirection(toSplat).negate();
      toSplat.y = 0;
    }
    toSplat.normalize();
    this.splatDrag = {
      baseQuaternion: this.mediaGroup.quaternion.clone(),
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(toSplat, center),
      right: new THREE.Vector3().crossVectors(toSplat, THREE.Object3D.DEFAULT_UP),
    };
    this.updateSplatDrag(controller);
  }

  /** Turns the splat like a ball: the side facing the viewer follows the ray. */
  private updateSplatDrag(controller: THREE.Object3D) {
    const drag = this.splatDrag;
    if (!drag) return;
    const origin = controller.getWorldPosition(new THREE.Vector3());
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(
      controller.getWorldQuaternion(new THREE.Quaternion())
    );
    if (Math.abs(direction.dot(drag.plane.normal)) < SPLAT_DRAG_MIN_RAY_ANGLE_COSINE) return;
    const point = new THREE.Ray(origin, direction).intersectPlane(drag.plane, new THREE.Vector3());
    if (!point) return;
    if (!drag.startPoint) {
      drag.startPoint = point;
      return;
    }
    const moved = point.sub(drag.startPoint);
    const yaw = moved.dot(drag.right) * SPLAT_ROTATE_RADIANS_PER_METER;
    const pitch = -moved.y * SPLAT_ROTATE_RADIANS_PER_METER;
    this.mediaGroup.quaternion
      .setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw)
      .multiply(new THREE.Quaternion().setFromAxisAngle(drag.right, pitch))
      .multiply(drag.baseQuaternion);
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
    document.getElementById('btnClearMedia')?.addEventListener('click', () => this.clearUploadedMedia());

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
    document.getElementById('btnEnterAR')?.addEventListener('click', () => this.requestARSession());
    document.getElementById('btnDockEnterAR')?.addEventListener('click', () => this.requestARSession());

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
        this.mediaGroup.position.z += e.deltaY * 0.002;
      }
    });

    window.addEventListener('resize', () => this.updateDesktopSplatFov());
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
              displayUrl = `${window.location.protocol}//${info.localIps[0]}:${info.port}/`;
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
    this.updateThumbstickControls();
    this.updateCardToggleButtons();

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

  onXRSessionStarted(session?: XRSession) {
    this.state.isXrActive = true;
    if (this.vrCard) this.vrCard.visible = true;
    this.syncVrInteraction();
    document.getElementById('desktopHud')?.classList.add('hidden');
    this.updateVrCard();
    const isAr = session?.environmentBlendMode !== undefined && session.environmentBlendMode !== 'opaque';
    this.showToast(`Entered WebXR ${isAr ? 'AR' : 'VR'} Session`, 'success');
  }

  onXRSessionEnded() {
    this.state.isXrActive = false;
    this.syncVrInteraction();
    document.getElementById('desktopHud')?.classList.remove('hidden');
    this.updateHUD();
    this.showToast('Exited XR Session', 'success');
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

  /**
   * Starts an AR session: splats appear over passthrough, while the opaque 360
   * sphere hides it, so 360 media looks the same as in VR. One session mode
   * handles both, as the file can change without leaving the session.
   */
  async requestARSession() {
    try {
      if (!(await navigator.xr?.isSessionSupported('immersive-ar'))) {
        this.showToast('AR needs a passthrough headset. Open on Meta Quest Browser instead!', 'error');
        document.getElementById('questSyncModal')?.classList.remove('hidden');
        return;
      }
      const sessionManager = xb.core.registry.get(xb.WebXRSessionManager);
      if (!sessionManager) throw new Error('WebXR is still starting up');
      // xrblocks fixes its session mode at startup and has no API to change it.
      // startSession reads the mode synchronously, so VR stays the default for
      // every other way of starting a session.
      const modeHolder = sessionManager as unknown as { mode: XRSessionMode };
      const defaultMode = modeHolder.mode;
      modeHolder.mode = 'immersive-ar';
      try {
        sessionManager.startSession();
      } finally {
        modeHolder.mode = defaultMode;
      }
    } catch (err) {
      console.error('Enter AR error:', err);
      this.showToast('Could not start AR: ' + (err instanceof Error ? err.message : String(err)), 'error');
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
      navigator.xr.isSessionSupported('immersive-ar').then((supported) => {
        if (supported) {
          document.getElementById('btnEnterAR')?.classList.add('hud-btn-vr-ready');
          document.getElementById('btnDockEnterAR')?.classList.add('hud-btn-vr-ready');
        }
      }).catch(() => {});
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
  // xrblocks also requests 'unbounded' by default. Quest Browser rejects any
  // immersive-vr request that includes it, even as an optional feature, with
  // NotSupportedError, so leave it out.
  options.webxrOptionalFeatures = ['local-floor', 'bounded-floor'];
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
