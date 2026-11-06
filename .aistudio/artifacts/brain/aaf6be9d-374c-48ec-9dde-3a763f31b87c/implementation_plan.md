# Immersive XR Media Studio: Gaussian Splats & 360 Photo/Video Viewer

A high-performance WebXR spatial viewer enabling users to view local 3D Gaussian Splats (.splat, .ply, .spz), 360° panoramic photos, and 360° immersive videos seamlessly across desktop browser viewports and standalone VR headsets with in-VR spatial controls and drag-and-drop file handling.

---

### User Review & Critical Decisions

> [!IMPORTANT]
> The following architectural and UX decisions were confirmed during requirements alignment:
> - **Exclusively Local File Uploads**: No preloaded sample media; the application focuses entirely on a streamlined drag-and-drop and local folder file picker workflow.
> - **Comprehensive Gaussian Splat Support**: Full native parsing and rendering for `.splat`, `.ply`, and compressed `.spz` formats via `@sparkjsdev/spark`.
> - **Persistent In-VR Spatial Card**: A persistent, ergonomic floating spatial UI card positioned comfortably in front of the user (at approximately 1.4m distance, centered at eye level) featuring options to select another file (triggering file load or quick-switching among queued files), toggle playback for 360 videos, recalibrate position, and cleanly exit VR mode via `UIExitButton`.

---

### 1. Overview & Core Concept

- **What It Does**: Provides a zero-friction, cross-platform spatial viewer for three distinct immersive media formats:
  1. **3D Gaussian Splats**: High-fidelity volumetric radiance fields parsed from `.splat`, `.ply`, or `.spz` files, rendered using `@sparkjsdev/spark` with camera orbit, point scaling, and spatial positioning.
  2. **360° Panoramic Photos**: Equirectangular JPG/PNG spherical environments inverted and mapped around the user in 8K texture resolution.
  3. **360° Panoramic Videos**: Equirectangular MP4/WebM spatial video playback mapped to a 360° inverted sphere with play/pause, scrub, volume/mute, and loop controls.
- **Target Audience / Persona**: 3D creators, spatial photographers, drone pilots, VFX artists, and VR headset owners (Meta Quest, Apple Vision Pro via WebXR, desktop WebXR emulators) seeking an instant local viewer without uploading proprietary media to third-party cloud servers.
- **Key Value**: 100% private client-side processing (zero server upload lag, no file size limits imposed by cloud storage, immediate rendering from local disk) combined with full WebXR immersion.

---

### 2. User Experience & Visual Design

#### Key User Flows
1. **Desktop Zero-State & File Drag-and-Drop**:
   - The user opens the app into a sleek, dark obsidian studio environment.
   - A prominent central drag-and-drop zone invites dropping any supported file (`.splat`, `.ply`, `.spz`, `.jpg`, `.png`, `.mp4`, `.webm`) or clicking "Browse Local Files".
   - The drag zone provides visual hover feedback (border glow, subtle elevation scaling).
2. **Desktop Interactive Viewing**:
   - Once a file is dropped or selected, the viewer seamlessly switches into active mode:
     - **Splat Mode**: Volumetric scene renders with smooth orbit controls, splat count readout, and focal framing.
     - **360 Photo Mode**: Full 360° spherical camera look-around with field-of-view zoom and horizontal rotation.
     - **360 Video Mode**: Smooth video projection with a collapsible playback control dock (play/pause, timeline scrubber, time elapsed/duration, audio toggle).
   - Bottom Dock provides file metadata (file name, format, file size), a "Replace / Select Another File" button, and the primary "Enter VR" action.
3. **VR Mode Initiation & In-Headset Experience**:
   - User clicks "Enter VR" (`XRButton`). The WebXR immersive-vr session launches.
   - The media immediately surrounds the user (for 360 photo/video) or rests in natural human scale in front of the viewer (for Gaussian Splats).
4. **Persistent In-VR Floating Spatial UI Card**:
   - A spatial UI card built with `UICard` floats steadily in front of the viewer (`z: -1.4m`, `y: 1.2m`).
   - The card displays:
     - Current media badge & filename.
     - **Select Another File** button (opens file chooser dialog or switches between locally loaded files).
     - **Video Controls** (when 360 video is active: Play/Pause, Replay, Mute).
     - **Recenter View** button to reposition the media or reset orientation.
     - **Exit VR** button (`UIExitButton`) that cleanly terminates the session and returns to desktop.

#### Visual Identity & Theme
- **Aesthetic Direction**: Minimalist Obsidian Spatial Studio. Dark cinematic surfaces (`#0a0d14`, `#121722`) with subtle blue/slate hairline borders (`rgba(255, 255, 255, 0.08)`), high-contrast white typographic hierarchy, and electric cyan / ice-blue accents (`#38bdf8`) for primary CTAs.
- **Typography**: Clean display font pairing using `Google Sans` / `Plus Jakarta Sans` for titles and controls, with `font-mono tabular-nums` for file sizes, timestamps, and splat metrics.
- **Zero-Pill Discipline**: Unboxed metadata text separated by middle dots (`·`) for file sizes and formats. Interactive buttons use defined surfaces with clear active/pressed states.

---

### 3. Key Product Decisions & Trade-Offs

- **Decision 1: Client-Side Blob URL & ArrayBuffer Streaming**:
  - *Chosen Approach*: Files selected via `<input type="file">` or Drag-and-Drop are converted directly into Object URLs (`URL.createObjectURL(file)`) or loaded as `ArrayBuffer` directly into memory.
  - *Why*: Instant loading with zero cloud upload latency, zero bandwidth costs, and complete privacy for user captures.
  - *Alternatives Considered*: Uploading files to a backend server. Rejected because large splat files (50MB - 500MB) would create immense wait times and fail without storage quotas.
- **Decision 2: Spark Engine (`@sparkjsdev/spark`) Integration for Splats**:
  - *Chosen Approach*: Utilize the installed `@sparkjsdev/spark` library (`SparkRenderer` + `SplatMesh`).
  - *Why*: Native support for `.splat`, standard `.ply`, and modern compressed `.spz` formats, built-in WebGL/WebXR shader pipeline, and high performance sorting.
  - *Alternatives Considered*: Custom WebGL Gaussian splat rasterizer. Rejected because Spark is already battle-tested, installed in the project, and optimized for WebXR.
- **Decision 3: Dual-Mode UI (Desktop HUD + WebXR `UICard`)**:
  - *Chosen Approach*: An HTML/Tailwind overlay for desktop browsing with file drag-and-drop, paired with an `xrblocks` spatial `UICard` in 3D world space when in VR.
  - *Why*: HTML file inputs cannot be directly clicked inside WebXR on standalone headsets without special browser file dialog handoff; by providing both the spatial in-VR card (with file trigger, quick queue switching, playback controls, and exit VR) and a clean desktop HUD, both contexts are supported.

---

### 4. Technical Architecture & Data Strategy

#### Architecture & Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Desktop Browser Viewport                         │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ HTML5 Drag-and-Drop Dropzone & File Input (<input type="file">)        │  │
│  └──────────────────────────────────┬────────────────────────────────────┘  │
│                                     │ Files (.splat, .ply, .spz, 360 img/vid)
│                                     ▼                                       │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                      App Controller & Media Engine                    │  │
│  │  - File Type Detection (Splats vs 360 Photo vs 360 Video)             │  │
│  │  - Object URL & ArrayBuffer Memory Management                         │  │
│  └──────────┬───────────────────────┬───────────────────────┬────────────┘  │
│             │                       │                       │               │
│             ▼                       ▼                       ▼               │
│  ┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐    │
│  │ Gaussian Splat Mode │ │ 360° Photo Sphere   │ │ 360° Video Sphere   │    │
│  │ - SparkRenderer     │ │ - Inverted Sphere   │ │ - Inverted Sphere   │    │
│  │ - SplatMesh (ply/   │ │ - SRGB Texture      │ │ - VideoTexture      │    │
│  │   splat/spz)        │ │ - Spherical Panning │ │ - Playback Controls │    │
│  └──────────┬──────────┘ └──────────┬──────────┘ └──────────┬──────────┘    │
│             │                       │                       │               │
│             └───────────────────────┼───────────────────────┘               │
│                                     ▼                                       │
│                       Three.js Scene Graph & XR Blocks                      │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                       WebXR Session Pipeline                          │  │
│  │  - Renderer: WebGLRenderer with xr.enabled = true                     │  │
│  │  - XRButton: Launches immersive-vr session                            │  │
│  │  - In-VR Spatial UI (UICard):                                         │  │
│  │    * Current File Info Banner                                         │  │
│  │    * "Select Another File" Trigger                                    │  │
│  │    * Video Play / Pause / Seek / Mute buttons (for 360 video)         │  │
│  │    * Recenter Camera / Reset Orbit                                    │  │
│  │    * UIExitButton (exits WebXR session)                               │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### State Model & Entity Definitions
- `MediaItem`:
  - `id: string`
  - `name: string`
  - `sizeFormatted: string`
  - `type: 'splat' | 'photo360' | 'video360'`
  - `url: string` (blob URL)
  - `file: File`
  - `splatFormat?: 'splat' | 'ply' | 'spz'`
- `ViewerState`:
  - `currentMedia: MediaItem | null`
  - `queuedFiles: MediaItem[]`
  - `isPlaying: boolean` (for video)
  - `currentTime: number`
  - `duration: number`
  - `isMuted: boolean`
  - `isXrActive: boolean`

#### Interactive Component & State Transitions
1. **Drag-and-Drop Event Handling**:
   - `dragover` / `dragenter`: Highlights drop zone with dashed cyan glow.
   - `drop`: Inspects files, filters extensions (`.splat`, `.ply`, `.spz`, `.jpg`, `.jpeg`, `.png`, `.webp`, `.mp4`, `.webm`), formats metadata, releases prior blob URLs, and transitions `ViewerState.currentMedia`.
2. **Media Switching**:
   - Disposes previous `SplatMesh`, video texture, or photo texture to prevent GPU memory leaks.
   - Cleans up Three.js materials, geometries, and video DOM elements.
   - Instantiates matching visual primitive (Spark `SplatMesh` or inverted sphere `THREE.Mesh`).
3. **In-VR Spatial UI Interaction**:
   - Hand rays or controller rays intersect with `UICard` buttons (`UIButton`).
   - "Select Another File": Iterates through loaded file playlist or triggers system file upload dialog.
   - "Play/Pause": Directly controls HTML5 `<video>` element feeding the `THREE.VideoTexture`.
   - "Exit VR": Calls `UIExitButton.handleExit()` or `session.end()` cleanly.
