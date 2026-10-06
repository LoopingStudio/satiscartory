import * as THREE from 'three';
import { RAPIER, type PhysicsWorld } from '../core/physics/PhysicsWorld';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../config/constants';
import { PLAYER } from '../data/player';

export interface MoveInput {
  /** Desired horizontal direction in world space (length 0..1). */
  dirX: number;
  dirZ: number;
  sprint: boolean;
  jump: boolean;
}

/** Kinematic capsule driven by Rapier's KinematicCharacterController. Position = feet. */
export class CharacterController {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  private readonly kcc: RAPIER.KinematicCharacterController;
  private vy = 0;
  grounded = false;
  /** Horizontal speed actually achieved last step (for animation). */
  speed = 0;
  readonly prev = new THREE.Vector3();
  readonly cur = new THREE.Vector3();
  /** Set on the step the character lands (for squash animation). */
  landedImpact = 0;
  private readonly halfHeight = PLAYER_HEIGHT / 2 - PLAYER_RADIUS;

  constructor(private readonly physics: PhysicsWorld, spawn: THREE.Vector3) {
    const world = physics.world;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y + PLAYER_HEIGHT / 2, spawn.z),
    );
    this.collider = world.createCollider(RAPIER.ColliderDesc.capsule(this.halfHeight, PLAYER_RADIUS), this.body);
    this.kcc = world.createCharacterController(0.05);
    this.kcc.setUp({ x: 0, y: 1, z: 0 });
    this.kcc.enableAutostep(PLAYER.STEP_HEIGHT, 0.2, false);
    this.kcc.enableSnapToGround(0.3);
    this.kcc.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    this.kcc.setApplyImpulsesToDynamicBodies(true);
    this.readPos(this.cur);
    this.prev.copy(this.cur);
  }

  private readPos(out: THREE.Vector3): void {
    const t = this.body.translation();
    out.set(t.x, t.y - PLAYER_HEIGHT / 2, t.z);
  }

  teleport(p: THREE.Vector3): void {
    this.body.setTranslation({ x: p.x, y: p.y + PLAYER_HEIGHT / 2, z: p.z }, true);
    this.body.setNextKinematicTranslation({ x: p.x, y: p.y + PLAYER_HEIGHT / 2, z: p.z });
    this.vy = 0;
    this.readPos(this.cur);
    this.prev.copy(this.cur);
  }

  step(dt: number, input: MoveInput, gravity: number): void {
    this.prev.copy(this.cur);
    const speed = input.sprint ? PLAYER.SPRINT_SPEED : PLAYER.WALK_SPEED;
    if (this.grounded && input.jump) this.vy = PLAYER.JUMP_SPEED;
    this.vy += gravity * dt;
    if (this.vy < -40) this.vy = -40;
    const desired = { x: input.dirX * speed * dt, y: this.vy * dt, z: input.dirZ * speed * dt };
    this.kcc.computeColliderMovement(this.collider, desired);
    const mv = this.kcc.computedMovement();
    const t = this.body.translation();
    this.body.setNextKinematicTranslation({ x: t.x + mv.x, y: t.y + mv.y, z: t.z + mv.z });
    const wasGrounded = this.grounded;
    this.grounded = this.kcc.computedGrounded();
    if (this.grounded) {
      if (!wasGrounded) this.landedImpact = Math.min(1, Math.max(0, -this.vy / 12));
      if (this.vy < 0) this.vy = 0;
    } else if (mv.y > desired.y + 1e-4 && this.vy > 0) {
      // Bumped the head: stop rising.
      this.vy = 0;
    }
    this.speed = Math.hypot(mv.x, mv.z) / dt;
    this.cur.set(t.x + mv.x, t.y + mv.y - PLAYER_HEIGHT / 2, t.z + mv.z);
    // Safety net: never fall out of the world.
    if (this.cur.y < -30) this.teleport(new THREE.Vector3(this.cur.x, 5, this.cur.z));
  }

  dispose(): void {
    this.physics.world.removeCharacterController(this.kcc);
  }
}
