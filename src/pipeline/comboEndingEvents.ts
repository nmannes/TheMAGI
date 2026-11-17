// ── Combo-ending ledger: ender choice and the first post-hit decision ──
//
// What a player does after the final hit of one of their own conversions:
// which move ended it, where the victim ended up, what the attacker's first
// commitment after the measured endlag was, and whether that decision
// extended, whiffed, got punished or handed the victim a recovery.
//
// Melee/data constraints (see docs/melee-accuracy.md):
//  - Unit = one own conversion. Conversions are not verified true combos:
//    slippi-js keeps a conversion alive through tech chases and ledge traps.
//  - The anchor is the FINAL CONNECTED HIT (moves.at(-1).frame), never
//    conversion.endFrame. endFrame is 45 frames after the victim regains
//    control (or the stock-drop frame on a kill), so an endFrame anchor would
//    miss every early post-hit decision.
//  - Decisions during endlag are not choices. The window opens at the
//    attacker's first actionable frame, measured from the matching
//    AttackInstance; multihit/grab sequences can make that match ambiguous,
//    so the documented fallback is resolveCommitmentEnd() and then a bounded
//    forward scan.
//  - No intent claims. The record says what was measured — never "dropped
//    combo", "missed kill" or "overextension".

import { State, Frames, isCommandGrabbed, type FramesType } from "@slippi/slippi-js/node";

import { GUARD, GUARD_REFLECT, isAirborne, isKnockdown, isOffstage, isOnLedge } from "./helpers.js";
import {
  attackKindOf,
  attackStateLabel,
  isActionableState,
  isDamagedState,
  isDeadOrRespawningState,
  isGrabbedState,
  resolveCommitmentEnd,
  type AttackInstance,
  type ComboEnderFamily,
  type ComboEndingEvent,
  type ConversionRecord,
  type PlayerSlot,
  type PostHitDecision,
  type RecoverySpan,
  type StockRecord,
  type VictimEndState,
} from "./frameEvents.js";
import { displayMoveName, familyOfMove } from "./openingEvents.js";

/** Frames after the attacker's first actionable frame that count as the post-hit decision window. */
export const POST_HIT_WINDOW_FRAMES = 30;
/** Give up locating the attacker's first actionable frame after this many frames. */
const ACTIONABLE_SCAN_CAP_FRAMES = 90;
/** Perpendicular/positional bounds for a victim that never leaves hitstun before the data ends. */
const END_STATE_SCAN_CAP_FRAMES = 240;

const NOTHING_STATE = 11;
const ACTION_WAIT = 14;
const WALK_SLOW = 15;
const WALK_FAST = 17;
const RUN = 21;
const RUN_BRAKE = 23;
const DEAD_FALL = 35;
const PLATFORM_DROP = 244;
const REBOUND_STOP = 237; // knockback collision states are still hitstun
const REBOUND = 238;
const BOUNCE_WALL = 247;
const SLIDING_OFF_EDGE = 251;
const CLIFF_END = 263;
const AERIAL_LANDING_START = State.AERIAL_LANDING_START;
const AERIAL_LANDING_END = State.AERIAL_LANDING_END;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isKnockbackFollow(s: number): boolean {
  return (s >= REBOUND_STOP && s <= REBOUND) || (s >= BOUNCE_WALL && s <= SLIDING_OFF_EDGE);
}

function isDefendState(s: number): boolean {
  // Shield hold/raise/drop (178/179/180/182), roll forward/backward, spot
  // dodge, air dodge. GuardSetOff (181) is shieldstun — a reaction, not a
  // chosen commitment — so it is skipped until the next real state.
  if (s === State.GUARD_ON || s === GUARD || s === 180 || s === GUARD_REFLECT) return true;
  return s >= State.ROLL_FORWARD && s <= State.AIR_DODGE;
}

function isRepositionState(s: number): boolean {
  if (s >= WALK_SLOW && s <= State.ACTION_KNEE_BEND) return true; // 15-24 walk/turn/dash/run/jumpsquat
  if (s >= State.CONTROLLED_JUMP_START && s <= State.CONTROLLED_JUMP_END) return true; // 24-34 jump/fall
  if (s >= DEAD_FALL && s <= 37) return true; // helpless fall
  if (s >= State.SQUAT_START && s <= State.SQUAT_END) return true; // crouch 39-41
  if (s === 42 || s === State.LANDING_FALL_SPECIAL) return true;
  if (s >= AERIAL_LANDING_START && s <= AERIAL_LANDING_END) return true;
  if (s === PLATFORM_DROP || s === State.TEETER) return true;
  if (s >= State.CLIFF_CATCH && s <= CLIFF_END) return true; // ledge grab/getup/jump
  return false;
}

function repositionLabel(s: number): string {
  if (s >= WALK_SLOW && s <= WALK_FAST) return "walk";
  if (s === State.TURN) return "turn";
  if (s === State.DASH) return "dash";
  if (s >= RUN && s <= RUN_BRAKE) return "run";
  if (s === State.ACTION_KNEE_BEND) return "jumpsquat";
  if (s === State.JUMP_FORWARD || s === State.JUMP_BACKWARD) return "jump";
  if (s === 27 || s === 28) return "double jump";
  if (s >= State.FALL && s <= State.FALL_BACKWARD) return "fall";
  if (s === State.DAMAGE_FALL) return "tumble";
  if (s >= DEAD_FALL && s <= 37) return "helpless";
  if (s >= State.SQUAT_START && s <= State.SQUAT_END) return "crouch";
  if (s === 42 || s === State.LANDING_FALL_SPECIAL || (s >= AERIAL_LANDING_START && s <= AERIAL_LANDING_END)) {
    return "landing";
  }
  if (s === PLATFORM_DROP) return "platform drop";
  if (s === State.TEETER) return "teeter";
  if (s === State.CLIFF_CATCH) return "ledge grab";
  if (s >= 254 && s <= 259) return "ledge getup";
  if (s >= 260 && s <= CLIFF_END) return "ledge jump";
  return "movement";
}

function defendLabel(s: number): string {
  if (s === State.ROLL_FORWARD) return "roll forward";
  if (s === State.ROLL_BACKWARD) return "roll backward";
  if (s === State.SPOT_DODGE) return "spot dodge";
  if (s === State.AIR_DODGE) return "air dodge";
  return "shield";
}

/**
 * Exact move id implied by an attack action state, when the state maps one to
 * one. Specials and grabs cannot establish which move connected from the
 * action state alone, so they stay null rather than guessed.
 */
function postHitMoveId(s: number): number | null {
  if (s >= State.AERIAL_NAIR && s <= State.AERIAL_DAIR) return 13 + (s - State.AERIAL_NAIR);
  if (s === 50) return 6; // dash attack
  if (s >= 51 && s <= 55) return 7; // ftilt
  if (s === 56) return 8; // utilt
  if (s === 57) return 9; // dtilt
  if (s >= 58 && s <= 62) return 10; // fsmash
  if (s === 63) return 11; // usmash
  if (s === 64) return 12; // dsmash
  if (s >= 44 && s <= 47) return 2; // jab family; the label keeps rapid jab distinct
  return null;
}

function moveLabelForState(s: number): string | null {
  const kind = attackKindOf(s);
  if (kind) return attackStateLabel(s);
  if (isDefendState(s)) return defendLabel(s);
  if (isRepositionState(s)) return repositionLabel(s);
  return null;
}

function attackInstanceAt(
  attacks: [AttackInstance[], AttackInstance[]],
  attackerSlot: PlayerSlot,
  frame: number,
): AttackInstance | null {
  const list = attacks[attackerSlot];
  return list.find((a) => a.startFrame <= frame && frame <= a.endFrame) ?? null;
}

interface VictimEnd {
  state: VictimEndState;
  frame: number | null;
  x: number | null;
  y: number | null;
  percent: number | null;
}

/**
 * Classify the victim's state once they are free of the final hit. Hitstun,
 * grabs, command grabs and knockback collisions are followed through; the
 * first free frame is the end state. Killed conversions are dead by
 * definition and keep the final-hit frame's position/percent as the end
 * measurement (the death percent is recorded separately from the stock row).
 */
function victimEndState(
  frames: FramesType,
  victimIndex: number,
  lastHitFrame: number,
  didKill: boolean,
  conversionEndFrame: number | null,
  lastFrame: number,
  stageId: number,
  fallbackPercent: number,
): VictimEnd {
  if (didKill) {
    const post = frames[lastHitFrame]?.players[victimIndex]?.post;
    return {
      state: "dead",
      frame: lastHitFrame,
      x: post?.positionX != null ? round2(post.positionX) : null,
      y: post?.positionY != null ? round2(post.positionY) : null,
      percent: post?.percent != null ? round2(post.percent) : round2(fallbackPercent),
    };
  }

  const cap = Math.min(lastFrame, conversionEndFrame ?? lastFrame, lastHitFrame + END_STATE_SCAN_CAP_FRAMES);
  let last: { frame: number; x: number; y: number; percent: number; state: number } | null = null;

  for (let f = lastHitFrame + 1; f <= cap; f++) {
    const post = frames[f]?.players[victimIndex]?.post;
    if (!post) continue;
    const s = post.actionStateId ?? 0;
    const x = post.positionX ?? 0;
    const y = post.positionY ?? 0;
    const percent = post.percent ?? 0;
    last = { frame: f, x, y, percent, state: s };

    if (isDamagedState(s) || isGrabbedState(s) || isCommandGrabbed(s) || isKnockbackFollow(s)) continue;
    if (isDeadOrRespawningState(s)) {
      return { state: "dead", frame: f, x: round2(x), y: round2(y), percent: round2(percent) };
    }

    if (isOnLedge(s) || (s >= State.CLIFF_CATCH && s <= CLIFF_END)) {
      return { state: "ledge", frame: f, x: round2(x), y: round2(y), percent: round2(percent) };
    }
    if (isKnockdown(s) || (s >= State.TECH_START && s <= State.TECH_END)) {
      return { state: "knockdown", frame: f, x: round2(x), y: round2(y), percent: round2(percent) };
    }
    if (isOffstage(x, y, stageId)) {
      return { state: "offstage", frame: f, x: round2(x), y: round2(y), percent: round2(percent) };
    }
    if (isAirborne(s) || post.isAirborne === true) {
      return { state: "airborne", frame: f, x: round2(x), y: round2(y), percent: round2(percent) };
    }
    return { state: "onstage", frame: f, x: round2(x), y: round2(y), percent: round2(percent) };
  }

  // Never saw a free frame (replay ended during the launch). If the victim
  // was offstage on the last observed frame, that is still measured evidence.
  if (last) {
    if (isOffstage(last.x, last.y, stageId)) {
      return {
        state: "offstage",
        frame: last.frame,
        x: round2(last.x),
        y: round2(last.y),
        percent: round2(last.percent),
      };
    }
    return {
      state: "unknown",
      frame: last.frame,
      x: round2(last.x),
      y: round2(last.y),
      percent: round2(last.percent),
    };
  }
  return { state: "unknown", frame: null, x: null, y: null, percent: null };
}

interface Commitment {
  decision: PostHitDecision;
  frame: number;
  moveId: number | null;
  label: string | null;
  instance: AttackInstance | null;
}

/**
 * First commitment in [firstActionable, firstActionable + 30].
 *
 * Wait (14) and Nothing (11) are passive and skipped. Getting hit, grabbed,
 * dying or falling into hitstun ends the window with no commitment. An
 * attacker who leaves the stage or takes the ledge while the victim is
 * offstage/ledging is classified `edgeguard` regardless of the underlying
 * action (jump, special, aerial, ledge grab).
 */
function firstCommitment(
  frames: FramesType,
  attackerIndex: number,
  attacks: [AttackInstance[], AttackInstance[]],
  attackerSlot: PlayerSlot,
  firstActionableFrame: number,
  windowEnd: number,
  stageId: number,
  edgeguardContext: boolean,
): Commitment | null {
  for (let f = firstActionableFrame; f <= windowEnd; f++) {
    const post = frames[f]?.players[attackerIndex]?.post;
    if (!post) continue;
    const s = post.actionStateId ?? 0;
    if (s === ACTION_WAIT || s === NOTHING_STATE) continue;
    if (isDamagedState(s) || isGrabbedState(s) || isCommandGrabbed(s) || isDeadOrRespawningState(s)) return null;

    const kind = attackKindOf(s);
    const attacking = kind != null;
    const defending = isDefendState(s);
    const repositioning = isRepositionState(s);
    if (!attacking && !defending && !repositioning) continue; // unknown/scripted state: no claim

    const x = post.positionX ?? 0;
    const y = post.positionY ?? 0;
    const atLedge = s >= State.CLIFF_CATCH && s <= CLIFF_END;
    const edgeguard = edgeguardContext && (atLedge || isOffstage(x, y, stageId));

    let decision: PostHitDecision;
    if (edgeguard) decision = "edgeguard";
    else if (attacking) decision = kind === "grab" ? "grab" : kind === "special" ? "special" : "attack";
    else if (defending) decision = "defend";
    else decision = "reposition";

    return {
      decision,
      frame: f,
      moveId: attacking ? postHitMoveId(s) : null,
      label: moveLabelForState(s),
      instance: attacking ? attackInstanceAt(attacks, attackerSlot, f) : null,
    };
  }
  return null;
}

/** First actionable frame after the final hit: instance → resolveCommitmentEnd → bounded scan. */
function attackerActionableFrame(
  frames: FramesType,
  attackerIndex: number,
  lastHitFrame: number,
  instance: AttackInstance | null,
  lastFrame: number,
  conversionEndFrame: number | null,
): number | null {
  if (instance?.firstActionableFrame != null) {
    return Math.max(lastHitFrame, instance.firstActionableFrame);
  }
  if (instance) {
    return Math.max(lastHitFrame, resolveCommitmentEnd(frames, attackerIndex, instance, lastFrame));
  }
  const cap = Math.min(lastFrame, conversionEndFrame ?? lastHitFrame + ACTIONABLE_SCAN_CAP_FRAMES);
  for (let f = lastHitFrame; f <= cap; f++) {
    const s = frames[f]?.players[attackerIndex]?.post?.actionStateId;
    if (s != null && isActionableState(s)) return f;
  }
  return null;
}

export function extractComboEndingEvents(
  conversions: ConversionRecord[],
  stocks: StockRecord[],
  frames: FramesType,
  lastFrame: number,
  stageId: number,
  p0Index: number,
  p1Index: number,
  attacks: [AttackInstance[], AttackInstance[]],
  recoverySpans: RecoverySpan[],
): ComboEndingEvent[] {
  const indexBySlot: [number, number] = [p0Index, p1Index];
  const out: ComboEndingEvent[] = [];

  for (const c of conversions) {
    const finalHit = c.moves[c.moves.length - 1];
    if (!finalHit) continue; // no damaging hit to describe
    if (finalHit.frame < Frames.FIRST_PLAYABLE || finalHit.frame > lastFrame) continue;

    const attackerSlot = c.attackerSlot;
    const victimSlot: PlayerSlot = attackerSlot === 0 ? 1 : 0;
    const attackerIndex = indexBySlot[attackerSlot];
    const victimIndex = indexBySlot[victimSlot];

    const endState = victimEndState(
      frames,
      victimIndex,
      finalHit.frame,
      c.didKill,
      c.endFrame,
      lastFrame,
      stageId,
      c.endPercent,
    );

    const instance = attackInstanceAt(attacks, attackerSlot, finalHit.frame);
    const firstActionable = attackerActionableFrame(
      frames,
      attackerIndex,
      finalHit.frame,
      instance,
      lastFrame,
      c.endFrame,
    );
    const windowEnd = firstActionable != null ? Math.min(lastFrame, firstActionable + POST_HIT_WINDOW_FRAMES) : null;

    const victimSpan =
      firstActionable == null
        ? null
        : (recoverySpans.find(
            (span) =>
              span.playerSlot === victimSlot && span.startFrame <= windowEnd! && span.endFrame >= firstActionable,
          ) ?? null);
    const edgeguardLinked = (endState.state === "offstage" || endState.state === "ledge") && victimSpan != null;

    const commitment =
      firstActionable == null || windowEnd == null
        ? null
        : firstCommitment(
            frames,
            attackerIndex,
            attacks,
            attackerSlot,
            firstActionable,
            windowEnd,
            stageId,
            endState.state === "offstage" || endState.state === "ledge",
          );

    // A special can fire a projectile that hits after its own action state
    // ends, so a missing hit during the special does not establish a whiff.
    // Record positive contact evidence only; direct attacks and grabs keep the
    // measured true-hit / shield / whiff distinction.
    const postHitSpecial = commitment?.decision === "special";
    const specialUnverified =
      postHitSpecial && commitment?.instance != null && !commitment.instance.connected && !commitment.instance.onShield;
    const postHitConnected = commitment?.instance
      ? specialUnverified
        ? null
        : commitment.instance.connected && !commitment.instance.onShield
      : null;
    const postHitOnShield = commitment?.instance ? (specialUnverified ? null : commitment.instance.onShield) : null;
    const whiffed = !postHitSpecial && commitment?.instance != null && !commitment.instance.connected;

    // Outcomes are measured from conversion records inside the measured window.
    let extended = false;
    let punished = false;
    let punishDelay: number | null = null;
    let punishOpenerMoveId: number | null = null;
    let punishDamage = 0;

    if (firstActionable != null && windowEnd != null) {
      extended = conversions.some(
        (other) =>
          other !== c &&
          other.attackerSlot === attackerSlot &&
          other.startFrame >= firstActionable &&
          other.startFrame <= windowEnd!,
      );
      const punish = conversions
        .filter(
          (other) =>
            other !== c &&
            other.attackerSlot === victimSlot &&
            other.startFrame >= firstActionable &&
            other.startFrame <= windowEnd!,
        )
        .sort((a, b) => a.startFrame - b.startFrame)[0];
      if (punish) {
        punished = true;
        punishDelay = punish.startFrame - firstActionable;
        punishOpenerMoveId = punish.openerMoveId;
        punishDamage = round2(
          punish.moves
            .filter((m) => m.frame >= firstActionable! && m.frame <= windowEnd!)
            .reduce((sum, m) => sum + m.damage, 0),
        );
      }
    }

    // Existing stock attribution: a didKill conversion whose endFrame is the
    // stock-loss frame (within 10 frames) owns the death. Stocks are matched
    // for the death percent/frame even when didKill is false, but `killed`
    // itself follows didKill so no stock is attributed to the wrong hit.
    const stock =
      c.endFrame != null
        ? (stocks.find(
            (s) => s.victimSlot === victimSlot && s.endFrame != null && Math.abs(s.endFrame - (c.endFrame ?? 0)) < 10,
          ) ?? null)
        : null;
    const deathFrame = stock?.endFrame ?? (c.didKill ? c.endFrame : null);
    const victimDeathPercent = stock?.deathPercent ?? (c.didKill ? (endState.percent ?? c.endPercent) : null);

    // Ender family mirrors the opening ledger: exact family from the move id,
    // never a named technique. Throws/pummel are grabs; ids outside the known
    // table are specials. The ender is the final connected hit's move id —
    // c.lastMoveId is the same move but typed nullable.
    const enderMoveId = finalHit.moveId;
    // Same classifier as the opening ledger; a damaging move is never a
    // projectile (those are item spawns), so `projectile` is narrowed away.
    const enderFamilyKey = familyOfMove(enderMoveId);
    const enderFamily: ComboEnderFamily = enderFamilyKey === "projectile" ? "special" : enderFamilyKey;

    out.push({
      attackerSlot,
      conversionStartFrame: c.startFrame,
      lastHitFrame: finalHit.frame,
      conversionEndFrame: c.endFrame,
      openerMoveId: c.openerMoveId,
      enderMoveId,
      enderLabel: displayMoveName(enderMoveId),
      enderFamily,
      openingType: c.openingType,
      moveCount: c.moveCount,
      damage: c.damage,
      startPercent: c.startPercent,
      endPercent: c.endPercent,
      didKill: c.didKill,
      victimEndState: endState.state,
      victimEndX: endState.x,
      victimEndY: endState.y,
      victimEndPercent: endState.percent,
      attackerFirstActionableFrame: firstActionable,
      framesFromLastHitToActionable: firstActionable != null ? firstActionable - finalHit.frame : null,
      postHitDecision: commitment?.decision ?? "none",
      postHitMoveId: commitment?.moveId ?? null,
      postHitMoveLabel: commitment?.label ?? null,
      postHitStartFrame: commitment?.frame ?? null,
      postHitConnected,
      postHitOnShield,
      extended,
      whiffed,
      punished,
      punishDelay,
      punishOpenerMoveId,
      punishDamage,
      edgeguardLinked,
      victimDeathPercent,
      deathFrame,
    });
  }

  return out.sort((a, b) => a.lastHitFrame - b.lastHitFrame || a.attackerSlot - b.attackerSlot);
}
