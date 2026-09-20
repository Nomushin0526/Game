/**
 * Three.js scene construction and per-frame sync.
 *
 * Read-only with respect to the simulation: this module copies `EntityState`
 * into meshes and never writes back. Nothing under `src/sim/` may import it.
 */

import * as THREE from 'three';
import type { MapData, Solid, SolidTag } from '../maps/types.ts';
import type { EntityState, Team, Vec3 } from '../sim/types.ts';

const SOLID_COLORS: Record<SolidTag, number> = {
  ground: 0x2a3140,
  building: 0x596779,
  bridge: 0x6b7280,
  floater: 0x8fa3bf,
  terrain: 0x3d4a3a,
  prop: 0x39404d,
};

export const TEAM_COLORS: Record<Team, number> = {
  hunter: 0xff5a4a,
  runner: 0x3fd0ff,
};

const SKY_COLOR = 0x9fc4e8;

export class SceneRenderer {
  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;
  private readonly craft = new Map<number, THREE.Object3D>();

  constructor(canvas: HTMLCanvasElement, map: MapData) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(SKY_COLOR);
    // Split screen clears per viewport instead of per frame.
    this.renderer.autoClear = false;

    this.scene.background = new THREE.Color(SKY_COLOR);
    this.scene.fog = new THREE.Fog(SKY_COLOR, 180, 620);

    this.addLights();
    this.addGround(map);
    this.addSolids(map);
    this.addCeilingMarker(map);
  }

  private addLights(): void {
    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x2b3242, 1.15));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(120, 260, 80);
    this.scene.add(sun);
  }

  private addGround(map: MapData): void {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(map.size.x, map.size.z),
      new THREE.MeshLambertMaterial({ color: SOLID_COLORS.ground }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = map.floor;
    this.scene.add(ground);

    // A grid gives the eye a speed and altitude reference in open air.
    const grid = new THREE.GridHelper(map.size.x, map.size.x / 20, 0x5b6b82, 0x3a4456);
    grid.position.y = map.floor + 0.05;
    this.scene.add(grid);
  }

  private addSolids(map: MapData): void {
    // One merged material per tag keeps the draw call count low.
    const materials = new Map<SolidTag, THREE.Material>();
    const materialFor = (tag: SolidTag): THREE.Material => {
      let material = materials.get(tag);
      if (!material) {
        material = new THREE.MeshLambertMaterial({ color: SOLID_COLORS[tag] });
        materials.set(tag, material);
      }
      return material;
    };

    for (const solid of map.solids) {
      const tag: SolidTag = solid.tag ?? 'building';
      const mesh = new THREE.Mesh(geometryFor(solid), materialFor(tag));
      mesh.position.set(solid.pos.x, solid.pos.y, solid.pos.z);
      if (solid.shape === 'box' && solid.rotY) mesh.rotation.y = solid.rotY;
      this.scene.add(mesh);

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry),
        new THREE.LineBasicMaterial({ color: 0x1d2330 }),
      );
      edges.position.copy(mesh.position);
      edges.rotation.copy(mesh.rotation);
      this.scene.add(edges);
    }
  }

  /** A faint wireframe lid so the invisible ceiling is not a surprise. */
  private addCeilingMarker(map: MapData): void {
    const lid = new THREE.Mesh(
      new THREE.PlaneGeometry(map.size.x, map.size.z, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.08 }),
    );
    lid.rotation.x = Math.PI / 2;
    lid.position.y = map.ceiling;
    this.scene.add(lid);
  }

  /**
   * Copy simulation state into the scene.
   * `previous` and `alpha` interpolate between fixed ticks so motion stays
   * smooth at refresh rates that are not 60 Hz.
   */
  syncEntities(
    entities: readonly EntityState[],
    previous: ReadonlyMap<number, Vec3> | null,
    alpha: number,
  ): void {
    for (const entity of entities) {
      let mesh = this.craft.get(entity.id);
      if (!mesh) {
        mesh = makeCraft(entity.team);
        this.craft.set(entity.id, mesh);
        this.scene.add(mesh);
      }

      const from = previous?.get(entity.id) ?? entity.pos;
      mesh.position.set(
        lerp(from.x, entity.pos.x, alpha),
        lerp(from.y, entity.pos.y, alpha),
        lerp(from.z, entity.pos.z, alpha),
      );
      // The hull points where the pilot is aiming.
      mesh.rotation.set(0, 0, 0);
      mesh.rotateY(entity.aimYaw);
      mesh.rotateX(-entity.aimPitch);
      mesh.visible = entity.alive;
    }
  }

  craftObject(id: number): THREE.Object3D | undefined {
    return this.craft.get(id);
  }

  render(camera: THREE.Camera): void {
    const size = this.renderer.getSize(new THREE.Vector2());
    this.renderViewport(camera, 0, 0, size.x, size.y);
  }

  /**
   * Draw one split-screen pane. Coordinates are in CSS pixels with the origin
   * at the bottom-left, matching Three.js's viewport convention.
   */
  renderViewport(camera: THREE.Camera, x: number, y: number, width: number, height: number): void {
    this.renderer.setViewport(x, y, width, height);
    this.renderer.setScissor(x, y, width, height);
    this.renderer.setScissorTest(true);
    this.renderer.clear();
    this.renderer.render(this.scene, camera);
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
  }

  /** Hide a craft's own hull, e.g. so it does not fill its own chase view. */
  setCraftVisible(id: number, visible: boolean): void {
    const mesh = this.craft.get(id);
    if (mesh) mesh.visible = visible;
  }

  /** Forget the craft meshes so a new round rebuilds them. */
  resetCraft(): void {
    for (const mesh of this.craft.values()) this.scene.remove(mesh);
    this.craft.clear();
  }

  dispose(): void {
    this.renderer.dispose();
  }
}

function geometryFor(solid: Solid): THREE.BufferGeometry {
  return solid.shape === 'box'
    ? new THREE.BoxGeometry(solid.size.x, solid.size.y, solid.size.z)
    : new THREE.CylinderGeometry(solid.radius, solid.radius, solid.height, 20);
}

/** Placeholder craft: a cone hull with stubby wings. Art comes later. */
function makeCraft(team: Team): THREE.Object3D {
  const group = new THREE.Group();
  const color = TEAM_COLORS[team];

  const hull = new THREE.Mesh(
    new THREE.ConeGeometry(1.1, 4, 12),
    new THREE.MeshLambertMaterial({ color }),
  );
  // Cones point up by default; lay it down along -Z, the forward axis.
  hull.rotation.x = -Math.PI / 2;
  group.add(hull);

  const wings = new THREE.Mesh(
    new THREE.BoxGeometry(5, 0.25, 1.2),
    new THREE.MeshLambertMaterial({ color: 0xe8eef5 }),
  );
  wings.position.z = 0.6;
  group.add(wings);

  // Two thruster glows offset to the sides: a single central one would sit
  // straight down the chase camera's axis and hide the crosshair.
  const glowMaterial = new THREE.MeshBasicMaterial({ color });
  for (const offset of [-1.05, 1.05]) {
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), glowMaterial);
    glow.position.set(offset, 0, 1.6);
    group.add(glow);
  }

  return group;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
