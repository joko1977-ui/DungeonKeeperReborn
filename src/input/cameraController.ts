import * as THREE from 'three';

/**
 * The keeper's-eye camera.
 *
 * Orbits a point on the dungeon floor, the way the original's view does: you
 * push the focus around the map, spin it, and drop closer to the ground. All
 * values are smoothed toward a target so a keypress produces a glide rather
 * than a jolt.
 *
 * Left and right mouse buttons are deliberately untouched — those belong to the
 * Hand of Evil. Rotation lives on the middle button (or two fingers).
 */
export class CameraController {
  /** Point on the floor the camera looks at. */
  readonly target = new THREE.Vector3(0, 0, 0);

  private readonly desiredTarget = new THREE.Vector3();
  private yaw = Math.PI * 0.25;
  private desiredYaw = Math.PI * 0.25;
  private pitch = 0.95;
  private desiredPitch = 0.95;
  private distance = 22;
  private desiredDistance = 22;

  private readonly camera: THREE.PerspectiveCamera;
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

  static readonly MIN_DISTANCE = 6;
  static readonly MAX_DISTANCE = 46;
  static readonly MIN_PITCH = 0.42;
  static readonly MAX_PITCH = 1.42;

  constructor(camera: THREE.PerspectiveCamera, element: HTMLElement, mapW: number, mapH: number) {
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
      if (this.touches.size === 2) this.beginPinch();
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
    this.pointerScreen = { x: e.clientX, y: e.clientY };

    if (e.pointerType === 'touch') {
      const prev = this.touches.get(e.pointerId);
      if (!prev) return;
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 1) {
        // One finger drags the dungeon under your thumb.
        this.dragTarget(e.clientX - prev.x, e.clientY - prev.y);
      } else if (this.touches.size === 2) {
        this.updatePinch();
      }
      return;
    }

    if (!this.rotating) return;
    const dx = e.clientX - this.lastPointer.x;
    const dy = e.clientY - this.lastPointer.y;
    this.lastPointer = { x: e.clientX, y: e.clientY };
    this.desiredYaw -= dx * 0.006;
    this.desiredPitch = THREE.MathUtils.clamp(
      this.desiredPitch - dy * 0.005,
      CameraController.MIN_PITCH,
      CameraController.MAX_PITCH,
    );
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) this.pinchDistance = 0;
      return;
    }
    if (e.button === 1) this.rotating = false;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    // Don't steal keys while the player is typing somewhere.
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
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
  }

  private updatePinch(): void {
    const [a, b] = [...this.touches.values()];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    if (this.pinchDistance > 0 && d > 0) {
      this.desiredDistance = THREE.MathUtils.clamp(
        this.desiredDistance * (this.pinchDistance / d),
        CameraController.MIN_DISTANCE,
        CameraController.MAX_DISTANCE,
      );
      let dAngle = angle - this.pinchAngle;
      while (dAngle > Math.PI) dAngle -= Math.PI * 2;
      while (dAngle < -Math.PI) dAngle += Math.PI * 2;
      this.desiredYaw -= dAngle;
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
    this.pitch += (this.desiredPitch - this.pitch) * k;
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
    if (this.keys.has('KeyQ')) this.desiredYaw += dt * 1.6;
    if (this.keys.has('KeyE')) this.desiredYaw -= dt * 1.6;
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
    const cosPitch = Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * cosPitch * this.distance,
      this.target.y + Math.sin(this.pitch) * this.distance,
      this.target.z + Math.cos(this.yaw) * cosPitch * this.distance,
    );
    this.camera.lookAt(this.target);
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
