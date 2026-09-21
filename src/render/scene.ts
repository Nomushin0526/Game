/**
 * Three.js scene construction and per-frame sync.
 *
 * Read-only with respect to the simulation: this module copies `EntityState`
 * into meshes and never writes back. Nothing under `src/sim/` may import it.
 */

import * as THREE from 'three';
import type { MapData, Solid, SolidTag } from '../maps/types.ts';
import type { DecoyState, EntityState, Team, Vec3 } from '../sim/types.ts';

const SOLID_COLORS: Record<SolidTag, number> = {
  ground: 0x2a3140,
  building: 0x596779,
  bridge: 0x6b7280,
  floater: 0x8fa3bf,
  terrain: 0x3d4a3a,
  tunnel: 0x4a5261,
  tree: 0x3f6b43,
  crane: 0xb8863f,
  prop: 0x39404d,
};

export const TEAM_COLORS: Record<Team, number> = {
  hunter: 0xff5a4a,
  runner: 0x3fd0ff,
};

const SKY_COLOR = 0x9fc4e8;
/** Above this the ground marker fades out entirely, metres. */
const SHADOW_MAX_ALTITUDE = 90;
/** Hard limit on the visual lean into a turn, radians. */
const MAX_BANK = 0.55;

export class SceneRenderer {
  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;
  private readonly craft = new Map<number, THREE.Object3D>();
  /**
   * A disc on the ground under each craft, and the line down to it.
   *
   * Playtesting reported that height was hard to judge and that this made
   * craft catch on obstacles. That is the classic weakness of a chase view:
   * with nothing connecting a flying object to the ground, the eye has no
   * reference for how high it is. A shadow and a drop line give it one, and
   * they cost nothing because the terrain height is already sampled here.
   */
  private readonly shadows = new Map<number, THREE.Object3D>();
  /** Sampled for the shadow's height. Null on a map with a flat floor. */
  private groundHeight: ((x: number, z: number) => number) | null = null;
  private floor = 0;
  /** Smoothed roll per craft, for the visual bank into a turn. */
  private readonly bank = new Map<number, { roll: number; yaw: number }>();
  private readonly decoys = new Map<number, THREE.Object3D>();
  private readonly shields = new Map<number, THREE.Mesh>();

  constructor(canvas: HTMLCanvasElement, map: MapData) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(SKY_COLOR);
    // Split screen clears per viewport instead of per frame.
    this.renderer.autoClear = false;

    this.scene.background = new THREE.Color(SKY_COLOR);
    this.scene.fog = new THREE.Fog(SKY_COLOR, 180, 620);

    this.addLights();
    this.groundHeight = map.terrain ? (x, z) => map.terrain!.heightAt(x, z) : null;
    this.floor = map.floor;
    this.addGround(map);
    this.addSolids(map);
    this.addClouds(map);
    this.addCeilingMarker(map);
  }

  private addLights(): void {
    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x2b3242, 1.15));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(120, 260, 80);
    this.scene.add(sun);
  }

  private addGround(map: MapData): void {
    const ground = map.terrain
      ? this.makeTerrainMesh(map)
      : new THREE.Mesh(
          new THREE.PlaneGeometry(map.size.x, map.size.z),
          new THREE.MeshLambertMaterial({ color: SOLID_COLORS.ground }),
        );
    if (!map.terrain) ground.rotation.x = -Math.PI / 2;
    ground.position.y = map.floor;
    this.scene.add(ground);

    // A grid gives the eye a speed and altitude reference in open air. With
    // relief it would poke through the hills, so it sits just under the floor.
    const grid = new THREE.GridHelper(map.size.x, map.size.x / 20, 0x5b6b82, 0x3a4456);
    grid.position.y = map.floor + (map.terrain ? -0.2 : 0.05);
    this.scene.add(grid);
  }

  /**
   * Ground relief as a displaced plane.
   *
   * Vertices are pulled straight from the same `Terrain` the physics height
   * field uses, so what you fly into is exactly what you see. Vertex colours
   * shade valleys darker than ridges, which gives the eye something to read
   * altitude against.
   */
  private makeTerrainMesh(map: MapData): THREE.Mesh {
    const terrain = map.terrain!;
    const cells = terrain.resolution;
    const geometry = new THREE.PlaneGeometry(map.size.x, map.size.z, cells, cells);
    geometry.rotateX(-Math.PI / 2);

    const position = geometry.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(position.count * 3);
    const low = new THREE.Color(0x2f3a33);
    const high = new THREE.Color(0x5d7055);
    const shade = new THREE.Color();

    for (let i = 0; i < position.count; i++) {
      const height = terrain.heightAt(position.getX(i), position.getZ(i));
      position.setY(i, height);
      shade.copy(low).lerp(high, terrain.maxHeight > 0 ? height / terrain.maxHeight : 0);
      colors[i * 3] = shade.r;
      colors[i * 3 + 1] = shade.g;
      colors[i * 3 + 2] = shade.b;
    }
    position.needsUpdate = true;
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();

    return new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
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

      // Outlines help the eye separate overlapping slabs. Foliage reads better
      // without them, and there is a lot of it.
      if (tag !== 'tree') {
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(mesh.geometry),
          new THREE.LineBasicMaterial({ color: 0x1d2330 }),
        );
        edges.position.copy(mesh.position);
        edges.rotation.copy(mesh.rotation);
        this.scene.add(edges);
      }
    }
  }

  /**
   * Draw the banks of cloud.
   *
   * They have to read as something you fly *into*, not something you steer
   * around, or a player will treat them like every other obstacle on the map.
   * So they are drawn back-face-first and translucent: the surface is barely
   * there from outside, and once inside you are looking at the far wall of the
   * sphere, which whites out the view the way being in cloud should.
   */
  private addClouds(map: MapData): void {
    const material = new THREE.MeshLambertMaterial({
      color: 0xf2f6ff,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    for (const cloud of map.clouds ?? []) {
      // Low segment counts on purpose: these are big and soft, and there are
      // dozens of them overlapping.
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(cloud.radius, 12, 8), material);
      mesh.position.set(cloud.pos.x, cloud.pos.y, cloud.pos.z);
      // Flattened the same way the data is, so a bank reads as weather.
      mesh.scale.y = 0.55;
      mesh.renderOrder = 1;
      this.scene.add(mesh);
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
      // The hull points where the pilot is aiming, and leans into the turn.
      // Rolling the camera alone looks like the world tilting around a rigid
      // craft; rolling the hull too is what reads as the craft doing it.
      mesh.rotation.set(0, 0, 0);
      mesh.rotateY(entity.aimYaw);
      mesh.rotateX(-entity.aimPitch);
      mesh.rotateZ(this.trackBank(entity));
      mesh.visible = entity.alive && mesh.userData.hidden !== true;

      this.syncShield(entity, mesh.position);
      this.syncShadow(entity, mesh.position);
    }
  }

  /**
   * How far this craft is leaning, from how fast its heading is changing.
   *
   * Rendering-only, and kept here rather than in the simulation because a
   * roll that fed back into flight would change the hit box and the physics
   * for something that is purely a cue. Smoothed so it leans in and settles
   * rather than snapping with every twitch of the mouse.
   */
  private trackBank(entity: EntityState): number {
    const previous = this.bank.get(entity.id);
    if (!previous) {
      this.bank.set(entity.id, { roll: 0, yaw: entity.aimYaw });
      return 0;
    }

    let delta = entity.aimYaw - previous.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    previous.yaw = entity.aimYaw;

    // Smoothed per rendered frame rather than by elapsed time: bank is a cue,
    // not a simulated quantity, and being exactly frame-rate independent here
    // would buy nothing anyone could see.
    const wanted = Math.max(-1, Math.min(1, delta * 12)) * MAX_BANK;
    previous.roll += (wanted - previous.roll) * 0.12;
    return previous.roll;
  }

  /** Put the ground marker under a craft, sized by how far up it is. */
  private syncShadow(entity: EntityState, at: THREE.Vector3): void {
    let marker = this.shadows.get(entity.id);
    if (!marker) {
      marker = makeShadow(TEAM_COLORS[entity.team]);
      this.shadows.set(entity.id, marker);
      this.scene.add(marker);
    }

    const ground = this.groundHeight?.(at.x, at.z) ?? this.floor;
    const altitude = Math.max(0, at.y - ground);
    marker.position.set(at.x, ground + 0.4, at.z);
    marker.visible = entity.alive && altitude < SHADOW_MAX_ALTITUDE;

    // Higher up means a wider, fainter mark, which is the cue itself: the
    // rate it shrinks as you descend is what reads as closing on the ground.
    const spread = 1 + (altitude / SHADOW_MAX_ALTITUDE) * 2.4;
    marker.scale.set(spread, 1, spread);
    const [disc, line] = marker.children as [THREE.Mesh, THREE.Mesh];
    (disc.material as THREE.MeshBasicMaterial).opacity =
      0.42 * (1 - altitude / SHADOW_MAX_ALTITUDE);

    // The drop line is what makes the height readable as a distance rather
    // than just a blob that happens to be under you. The disc is scaled with
    // the group, so the line is un-scaled to keep it thin.
    line.scale.set(1 / spread, Math.max(0.001, altitude), 1 / spread);
    line.position.y = altitude / 2;
  }

  /**
   * Draw the decoys.
   *
   * Deliberately the same model and colour as the craft that threw them: the
   * point is that you cannot tell at a glance. Only the faint shimmer as one
   * fades gives it away.
   */
  syncDecoys(decoys: readonly DecoyState[], config: { duration: number }): void {
    const seen = new Set<number>();

    for (const decoy of decoys) {
      seen.add(decoy.id);
      let mesh = this.decoys.get(decoy.id);
      if (!mesh) {
        mesh = makeCraft(decoy.team);
        this.decoys.set(decoy.id, mesh);
        this.scene.add(mesh);
      }
      mesh.position.set(decoy.pos.x, decoy.pos.y, decoy.pos.z);
      const heading = new THREE.Vector3(decoy.vel.x, decoy.vel.y, decoy.vel.z);
      if (heading.lengthSq() > 1e-6) {
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), heading.normalize());
      }
      // Fades over its last second, which is the only tell.
      setOpacity(mesh, Math.min(1, decoy.life / Math.min(1, config.duration)));
    }

    for (const [id, mesh] of this.decoys) {
      if (seen.has(id)) continue;
      this.scene.remove(mesh);
      this.decoys.delete(id);
    }
  }

  /** A bubble around a craft whose shield is up. */
  private syncShield(entity: EntityState, at: THREE.Vector3): void {
    const active = entity.shieldTimer > 0 && entity.alive;
    let bubble = this.shields.get(entity.id);

    if (!active) {
      if (bubble) bubble.visible = false;
      return;
    }
    if (!bubble) {
      // Wireframe rather than a solid shell: from your own chase camera you
      // are looking straight through your shield, and anything solid enough to
      // read as protection is also solid enough to hide the fight.
      bubble = new THREE.Mesh(
        new THREE.SphereGeometry(4.2, 12, 8),
        new THREE.MeshBasicMaterial({
          color: 0x7fd4ff,
          transparent: true,
          opacity: 0.5,
          depthWrite: false,
          wireframe: true,
        }),
      );
      this.shields.set(entity.id, bubble);
      this.scene.add(bubble);
    }
    bubble.visible = true;
    bubble.position.copy(at);
    // Pulses as it runs down, so the owner can feel it about to drop.
    const material = bubble.material as THREE.MeshBasicMaterial;
    material.opacity = 0.35 + 0.3 * Math.abs(Math.sin(entity.shieldTimer * 6));
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

  /**
   * Hide a craft's own hull, e.g. so it does not fill its own cockpit view.
   *
   * Recorded on the mesh rather than applied directly, because `syncEntities`
   * rewrites `visible` from the entity's own state every frame and would
   * undo it.
   */
  setCraftVisible(id: number, visible: boolean): void {
    const mesh = this.craft.get(id);
    if (mesh) mesh.userData.hidden = !visible;
  }

  /** Forget the craft meshes so a new round rebuilds them. */
  resetCraft(): void {
    for (const mesh of this.craft.values()) this.scene.remove(mesh);
    this.craft.clear();
    for (const mesh of this.decoys.values()) this.scene.remove(mesh);
    this.decoys.clear();
    for (const mesh of this.shields.values()) this.scene.remove(mesh);
    this.shields.clear();
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

/**
 * The ground marker: a flat ring plus the line down to it.
 *
 * Drawn in the craft's own colour so a split screen stays readable, and with
 * `depthWrite` off so it never z-fights the terrain it is lying on.
 */
function makeShadow(color: number): THREE.Object3D {
  const group = new THREE.Group();

  const disc = new THREE.Mesh(
    new THREE.RingGeometry(1.6, 2.6, 20),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  disc.rotation.x = -Math.PI / 2;

  // Unit height, scaled per frame to the craft's altitude.
  const line = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.12, 1, 5),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, depthWrite: false }),
  );

  group.add(disc, line);
  return group;
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

/** Fade a whole craft model, used for decoys running out of life. */
function setOpacity(object: THREE.Object3D, opacity: number): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.material) return;
    const material = mesh.material as THREE.Material;
    material.transparent = opacity < 1;
    material.opacity = opacity;
  });
}
