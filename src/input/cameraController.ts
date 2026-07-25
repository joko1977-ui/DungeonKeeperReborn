import * as THREE from 'three';

/**
 * The keeper's-eye camera. Strictly isometric.
 *
 * The projection is orthographic and the pitch is welded to 30 degrees, so the
 * dungeon is drawn the way an isometric game draws it: no perspective
 * convergence, no tilting, a tile the same size at the top of the screen as at
 * the bottom. You push the focus around the map and you zoom; you do not tumble
 * the view.
 *
 * Rotation is quarter turns only, and it is not a free-look — it is the
 * isometric convention of turning the board so you can see behind a wall.
 * Snapping to the four diagonals is what keeps every tile edge landing on the
 * same screen angle, which is the entire point of the projection.
 *
 * Left and right mouse buttons are deliberately untouched — those belong to the
 * Hand of Evil. Rotation lives on the middle button and on Q/E.
 *
 * Touch splits the same way: **one finger belongs to the Hand of Evil, two
 * fingers drive the camera.** Tagging a slab of wall is a drag, and it is the
 * thing you do most, so it gets the single finger; panning and pinching live on
 * the two-finger gesture, which is where a pinch already had to be anyway.
 */

/** Isometric pitch: 30 degrees above the floor, fixed. */
export const ISO_PITCH = Math.PI / 6;

/**
 * How far back the eye is parked.
 *
 * Meaningless to the projection — an orthographic camera draws things the same
 * size however far away they are — but it fixes where the scene sits in view
 * depth, which is what the fog is measured against.
 */
export const ISO_STANDOFF = 80;

/** The four viewing corners. Rotation steps between them and nowhere else. */
const YAW_STEP = Math.PI / 2;
export class CameraController {
  /** Point on the floor the camera looks at. */
  readonly target = new THREE.Vector3(0, 0, 0);

  private readonly desiredTarget = new THREE.Vector3();
  private yaw = Math.PI * 0.25;
  private desiredYaw = Math.PI * 0.25;
  /** Fixed. Kept as a field only so the projection maths reads normally. */
  private readonly pitch = ISO_PITCH;
  private distance = 22;
  private desiredDistance = 22;
  /** Accumulated middle-drag, so a drag has to travel before the view turns. */
  private rotateAccum = 0;

  private readonly camera: THREE.OrthographicCamera;
  private readonly element: HTMLElement;
  private readonly bounds: { w: number; h: number };

  private readonly keys = new Set<string>();
  private rotating = false;
  private lastPointer = { x: 0, y: 0 };
  /** Where the pointer is, for edge scrolling. */
  private pointerScreen = { x: -1, y: -1 };
  private edgeScrollEnabled = true;

  /** Active touches, for pinch-zoom and twist. */
  private readonly touches = new Map<number, { x: number; y: number }>();
  private pinchDistance = 0;
  private pinchAngle = 0;
  private pinchCentre = { x: 0, y: 0 };

  static readonly MIN_DISTANCE = 8;
  static readonly MAX_DISTANCE = 46;

  constructor(camera: THREE.OrthographicCamera, element: HTMLElement, mapW: number, mapH: number) {
    this.camera = camera;
    this.element = element;
    this.bounds = { w: mapW, h: mapH };

    element.addEventListener('wheel', this.onWheel, { passive: false });
    element.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    element.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Jump the focus somewhere immediately, with no glide. */
  snapTo(x: number, y: number): void {
    this.target.set(x, 0, y);
    this.desiredTarget.set(x, 0, y);
    this.applyToCamera();
  }

  /** Glide the focus somewhere — used by the minimap and message links. */
  panTo(x: number, y: number): void {
    this.desiredTarget.set(x, 0, y);
  }

  setEdgeScroll(enabled: boolean): void {
    this.edgeScrollEnabled = enabled;
  }

  isRotating(): boolean {
    return this.rotating;
  }

  /* ------------------------------------------------------------ input --- */

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const factor = Math.exp(e.deltaY * 0.0016);
    this.desiredDistance = THREE.MathUtils.clamp(
      this.desiredDistance * factor,
      CameraController.MIN_DISTANCE,
      CameraController.MAX_DISTANCE,
    );
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size >= 2) this.beginPinch();
      return;
    }
    // Middle button rotates; the other two are the Hand of Evil's.
    if (e.button === 1) {
      e.preventDefault();
      this.rotating = true;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.element.setPointerCapture?.(e.pointerId);
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    // Edge scrolling follows the mouse only — a fingertip near the screen edge
    // is just where someone is holding the tablet.
    if (e.pointerType !== 'touch') this.pointerScreen = { x: e.clientX, y: e.clientY };

    if (e.pointerType === 'touch') {
      const prev = this.touches.get(e.pointerId);
      if (!prev) return;
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // A single finger is the Hand of Evil's; the camera ignores it.
      if (this.touches.size >= 2) this.updatePinch();
      return;
    }

    if (!this.rotating) return;
    const dx = e.clientX - this.lastPointer.x;
    this.lastPointer = { x: e.clientX, y: e.clientY };
    // A drag accumulates until it has earned a quarter turn. Free rotation is
    // deliberately not available: an isometric projection only stays isometric
    // while the view sits on one of its four corners.
    this.rotateAccum -= dx;
    while (this.rotateAccum > 120) { this.rotateAccum -= 120; this.turn(1); }
    while (this.rotateAccum < -120) { this.rotateAccum += 120; this.turn(-1); }
  };

  /** Turn the board a quarter, the only rotation there is. */
  turn(steps: number): void {
    this.desiredYaw += steps * YAW_STEP;
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) this.pinchDistance = 0;
      else this.beginPinch();
      return;
    }
    if (e.button === 1) this.rotating = false;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    // Don't steal keys while the player is typing somewhere.
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.repeat) return;
    if (e.code === 'KeyQ') { this.turn(1); return; }
    if (e.code === 'KeyE') { this.turn(-1); return; }
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onBlur = (): void => {
    this.keys.clear();
    this.rotating = false;
    this.touches.clear();
  };

  private beginPinch(): void {
    const [a, b] = [...this.touches.values()];
    this.pinchDistance = Math.hypot(b.x - a.x, b.y - a.y);
    this.pinchAngle = Math.atan2(b.y - a.y, b.x - a.x);
    this.pinchCentre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  private updatePinch(): void {
    const [a, b] = [...this.touches.values()];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

    // Moving both fingers together pans — the two-finger gesture carries
    // position, scale and rotation at once, the way a map does.
    if (this.pinchDistance > 0) {
      this.dragTarget(centre.x - this.pinchCentre.x, centre.y - this.pinchCentre.y);
    }
    this.pinchCentre = centre;

    if (this.pinchDistance > 0 && d > 0) {
      this.desiredDistance = THREE.MathUtils.clamp(
        this.desiredDistance * (this.pinchDistance / d),
        CameraController.MIN_DISTANCE,
        CameraController.MAX_DISTANCE,
      );
      // Twist accumulates toward a quarter turn rather than rotating freely.
      let dAngle = angle - this.pinchAngle;
      while (dAngle > Math.PI) dAngle -= Math.PI * 2;
      while (dAngle < -Math.PI) dAngle += Math.PI * 2;
      this.rotateAccum -= dAngle * 260;
      while (this.rotateAccum > 120) { this.rotateAccum -= 120; this.turn(1); }
      while (this.rotateAccum < -120) { this.rotateAccum += 120; this.turn(-1); }
    }
    this.pinchDistance = d;
    this.pinchAngle = angle;
  }

  /** Move the focus by a screen-space drag, in camera-relative directions. */
  private dragTarget(dxScreen: number, dyScreen: number): void {
    const scale = this.desiredDistance * 0.0022;
    const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const right = new THREE.Vector3(forward.z, 0, -forward.x);
    this.desiredTarget
      .addScaledVector(right, dxScreen * scale)
      .addScaledVector(forward, dyScreen * scale);
    this.clampTarget();
  }

  private clampTarget(): void {
    this.desiredTarget.x = THREE.MathUtils.clamp(this.desiredTarget.x, 0, this.bounds.w);
    this.desiredTarget.z = THREE.MathUtils.clamp(this.desiredTarget.z, 0, this.bounds.h);
  }

  /* ----------------------------------------------------------- update --- */

  update(dt: number): void {
    this.applyKeyboard(dt);
    this.applyEdgeScroll(dt);

    // Critically-damped-ish smoothing: snappy but never twitchy.
    const k = 1 - Math.exp(-dt * 11);
    this.target.lerp(this.desiredTarget, k);
    this.yaw += (this.desiredYaw - this.yaw) * k;
    this.distance += (this.desiredDistance - this.distance) * k;

    this.applyToCamera();
  }

  private applyKeyboard(dt: number): void {
    const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const speed = this.distance * (fast ? 1.5 : 0.75) * dt;

    let fwd = 0, strafe = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) fwd += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) fwd -= 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) strafe -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) strafe += 1;

    if (fwd !== 0 || strafe !== 0) {
      const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(-forward.z, 0, forward.x);
      this.desiredTarget
        .addScaledVector(forward, fwd * speed)
        .addScaledVector(right, strafe * speed);
      this.clampTarget();
    }

    // Q/E spin the view, as Ctrl+arrows did in the original.
    // Q and E step the board a quarter turn on the press, not while held.
    if (this.keys.has('PageUp')) {
      this.desiredDistance = Math.max(CameraController.MIN_DISTANCE, this.desiredDistance - dt * 22);
    }
    if (this.keys.has('PageDown')) {
      this.desiredDistance = Math.min(CameraController.MAX_DISTANCE, this.desiredDistance + dt * 22);
    }
  }

  /** Nudge the view when the pointer rests against a screen edge. */
  private applyEdgeScroll(dt: number): void {
    if (!this.edgeScrollEnabled || this.rotating) return;
    const { x, y } = this.pointerScreen;
    if (x < 0 || y < 0) return;
    const margin = 18;
    const w = window.innerWidth, h = window.innerHeight;

    let dx = 0, dy = 0;
    if (x < margin) dx = -(1 - x / margin);
    else if (x > w - margin) dx = 1 - (w - x) / margin;
    if (y < margin) dy = -(1 - y / margin);
    else if (y > h - margin) dy = 1 - (h - y) / margin;
    if (dx === 0 && dy === 0) return;

    const speed = this.distance * 1.1 * dt;
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    this.desiredTarget
      .addScaledVector(right, dx * speed)
      .addScaledVector(forward, -dy * speed);
    this.clampTarget();
  }

  private applyToCamera(): void {
    // The eye is parked well back and the frustum is sized by `zoom`. With an
    // orthographic camera the distance to the subject does not change how big it
    // looks, so the standoff exists only to keep the whole dungeon in front of
    // the near plane; zoom is what "getting closer" means here.
    const cosPitch = Math.cos(this.pitch);
    const standoff = ISO_STANDOFF;
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * cosPitch * standoff,
      this.target.y + Math.sin(this.pitch) * standoff,
      this.target.z + Math.cos(this.yaw) * cosPitch * standoff,
    );
    this.camera.lookAt(this.target);
    // Frustum half-height in world units, from the same distance the rest of
    // the game reasons about.
    this.camera.zoom = 1 / Math.max(1, this.distance * 0.5);
    this.camera.updateProjectionMatrix();
  }

  /** Current yaw, so the minimap can rotate its view cone to match. */
  getYaw(): number {
    return this.yaw;
  }

  getDistance(): number {
    return this.distance;
  }

  dispose(): void {
    this.element.removeEventListener('wheel', this.onWheel);
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }
}
