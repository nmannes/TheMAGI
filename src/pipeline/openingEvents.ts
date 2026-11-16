// ── Opening ledger: the first hit in neutral ────────────────────────────
//
// Existing conversion stats know THAT the target was opened; this ledger
// records the moment the opening started — what the victim was doing on the
// frame before the first hit, where both players stood, and how the first hit
// was delivered. Rule-based buckets (openingClusters.ts) and descriptive
// conversion-sequence clusters both read these rows, filtered by the player's
// character, the opponent's character and the stage.
//
// Melee/data constraints (see docs/melee-accuracy.md):
//  - conversion.startFrame is the first stun/grab frame. For a grab it is the
//    GRAB frame, not the later throw; openerMoveId is still the conversion's
//    first damaging move (a throw or pummel).
//  - The neutral gate reads startFrame - 1. A conversion that starts while the
//    victim is already in hitstun, tumbling, down/tech, grabbed/thrown,
//    on the ledge, offstage, dead or respawning is a combo continuation or a
//    situation another ledger owns — not an opening.
//  - Own attack/special/air-dodge commitments, landing lag, shield and
//    shieldstun ARE included and labeled: those are the decisions that get
//    punished.
//  - A projectile family is claimed only when the first hit has no attributed
//    direct move (move id 1/null) AND an attacker-owned item is present right
//    around the hit. Special move ids stay "special" even with a lingering
//    item, because the move id cannot establish which hitbox connected.

import { State, Frames, isCommandGrabbed, type FramesType } from "@slippi/slippi-js/node";

import {
  GUARD,
  GUARD_ON,
  GUARD_REFLECT,
  GUARD_SET_OFF,
  STAGE_LEDGE_X,
  getMoveName,
  isAirborne,
  isOffstage,
  isOnPlatform,
  moveIdToName,
} from "./helpers.js";
import {
  attackKindOf,
  isDamagedState,
  isDeadOrRespawningState,
  isGrabbedState,
  type ConversionRecord,
  type OpeningEvent,
  type OpeningFamily,
  type OpeningSituation,
  type PlayerSlot,
  type StockRecord,
} from "./frameEvents.js";

// Action-state anchors verified against the community action-state map.
const CLIFF_END = 263; // ledge catch (252) through the last ledge-jump variant
const REBOUND_STOP = 237; // knockback collision states
const REBOUND = 238;
const BOUNCE_WALL = 247; // wall/ceiling bounces are still hitstun
const SLIDING_OFF_EDGE = 251;
const PLATFORM_DROP = 244;
const TAUNT_RIGHT = 264;
const TAUNT_LEFT = 265;
const BARREL_WAIT = State.BARREL_WAIT; // 293 — committed carrier animation
const NOTHING_STATE = 11;
const DEAD_FALL = 35;
const SHIELD_OFF = 180;
const SHIELD_BREAK_START = 205;
const SHIELD_BREAK_END = 211; // includes ShieldBreakTeeter
const DODGE_START = 233; // roll forward / roll backward / spot dodge / air dodge
const DODGE_END = 236;
const HAMMER_WAIT = 305; // warp-star / hammer / other item animations
const COMMAND_GRAB_END = 340; // below SPECIAL_STATE_START; command-grab states are gated out above

const CORNER_FRACTION = 0.7; // same rule as habit conditions
const PROJECTILE_ITEM_LOOKBACK = 2; // items can disappear on the hit frame

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** True when a victim state on the pre-hit frame is neutral enough to open. */
function isNeutralOpeningState(s: number): boolean {
  if (isDamagedState(s)) return false; // hitstun 75-91 + tumbling 38
  if (isGrabbedState(s)) return false; // captured 223-232 + thrown 239-243
  if (isCommandGrabbed(s)) return false; // command-grab victim states
  if (s >= State.DOWN_START && s <= State.TECH_END) return false; // down / tech / jab reset
  if (isDeadOrRespawningState(s) || s === NOTHING_STATE || s === DEAD_FALL) return false;
  if (s >= State.CLIFF_CATCH && s <= CLIFF_END) return false; // ledge owned by the ledge ledger
  if (s >= REBOUND_STOP && s <= REBOUND) return false; // knockback rebound
  if (s >= BOUNCE_WALL && s <= SLIDING_OFF_EDGE) return false; // hitstun bounces / missed-tech slide
  return true;
}

function isLandingState(s: number): boolean {
  return (
    s === 42 || // Landing
    s === State.LANDING_FALL_SPECIAL || // special landing lag
    (s >= State.AERIAL_LANDING_START && s <= State.AERIAL_LANDING_END)
  );
}

function isCommitmentState(s: number): boolean {
  if (attackKindOf(s) != null) return true; // grounded/aerial attacks, grabs, specials (>=341)
  if (s >= SHIELD_BREAK_START && s <= SHIELD_BREAK_END) return true;
  if (s >= DODGE_START && s <= DODGE_END) return true;
  if (s === PLATFORM_DROP) return true;
  if (s === TAUNT_RIGHT || s === TAUNT_LEFT) return true;
  if (s === BARREL_WAIT) return true;
  if (s >= HAMMER_WAIT && s <= COMMAND_GRAB_END) return true;
  return false;
}

function classifySituation(s: number): OpeningSituation {
  if (s === GUARD_SET_OFF) return "shieldstun";
  if (s === GUARD_ON || s === GUARD || s === SHIELD_OFF || s === GUARD_REFLECT) return "shield";
  if (isLandingState(s)) return "landing";
  if (isCommitmentState(s)) return "commitment";
  if (isAirborne(s)) return "neutral-airborne";
  return "neutral-grounded";
}

/** Project display name, falling back to slippi's short name for unknown ids. */
function displayMoveName(moveId: number): string {
  return moveIdToName[moveId] ?? getMoveName(moveId);
}

function familyOfMove(moveId: number | null): OpeningFamily {
  if (moveId == null) return "special";
  if (moveId >= 13 && moveId <= 17) return "aerial";
  if (moveId >= 2 && moveId <= 12) return "grounded";
  if (moveId === 50 || moveId === 51 || moveId === 61 || moveId === 62) return "grounded"; // getup / ledge attack
  if (moveId >= 18 && moveId <= 21) return "special"; // neutral/side/up/down b
  if (moveId >= 52 && moveId <= 56) return "grab"; // throws / pummel (grab conversions)
  return "special"; // move id 1 (misc) or an id outside the known table
}

function hasAttackerOwnedItem(frames: FramesType, frame: number, attackerIndex: number): boolean {
  for (let f = frame - PROJECTILE_ITEM_LOOKBACK; f <= frame; f++) {
    const items = frames[f]?.items;
    if (!items) continue;
    for (const item of items) {
      if (item.owner === attackerIndex) return true;
    }
  }
  return false;
}

function conversionStartIsGrab(
  moveId: number | null,
  frames: FramesType,
  startFrame: number,
  attackerIndex: number,
  victimIndex: number,
): boolean {
  if (moveId != null && moveId >= 52 && moveId <= 56) return true; // throw / pummel
  const attackerState = frames[startFrame]?.players[attackerIndex]?.post?.actionStateId;
  if (attackerState != null && attackerState >= State.GRAB && attackerState <= State.GRAB_WAIT) return true;
  const victimState = frames[startFrame]?.players[victimIndex]?.post?.actionStateId;
  if (victimState != null && victimState >= State.CAPTURE_START && victimState <= State.CAPTURE_END) return true;
  return false;
}

export function extractOpeningEvents(
  conversions: ConversionRecord[],
  stocks: StockRecord[],
  frames: FramesType,
  lastFrame: number,
  stageId: number,
  p0Index: number,
  p1Index: number,
): OpeningEvent[] {
  // Trades: in 1v1 a trade is exactly two conversions starting on one frame.
  const attackersByStart = new Map<number, Set<PlayerSlot>>();
  for (const c of conversions) {
    const set = attackersByStart.get(c.startFrame) ?? new Set<PlayerSlot>();
    set.add(c.attackerSlot);
    attackersByStart.set(c.startFrame, set);
  }

  const indexBySlot: [number, number] = [p0Index, p1Index];
  const out: OpeningEvent[] = [];

  for (const c of conversions) {
    if (c.startFrame < Frames.FIRST_PLAYABLE || c.startFrame > lastFrame) continue;
    if (c.openerMoveId == null) continue; // no damaging hit to describe

    const attackerSlot = c.attackerSlot;
    const victimSlot: PlayerSlot = attackerSlot === 0 ? 1 : 0;
    const attackerIndex = indexBySlot[attackerSlot];
    const victimIndex = indexBySlot[victimSlot];

    const pre = frames[c.startFrame - 1];
    const victimPost = pre?.players[victimIndex]?.post;
    const attackerPost = pre?.players[attackerIndex]?.post;
    if (!victimPost || !attackerPost) continue;

    const victimState = victimPost.actionStateId ?? 0;
    if (!isNeutralOpeningState(victimState)) continue;

    const victimX = victimPost.positionX ?? 0;
    const victimY = victimPost.positionY ?? 0;
    if (isOffstage(victimX, victimY, stageId)) continue; // recovery/edgeguard domain

    const attackerX = attackerPost.positionX ?? 0;
    const attackerY = attackerPost.positionY ?? 0;
    const attackerState = attackerPost.actionStateId ?? 0;

    const grab = conversionStartIsGrab(c.openerMoveId, frames, c.startFrame, attackerIndex, victimIndex);
    let openerFamily: OpeningFamily;
    let openerLabel: string;
    if (grab) {
      const moveName = displayMoveName(c.openerMoveId);
      openerFamily = "grab";
      openerLabel = c.openerMoveId >= 52 && c.openerMoveId <= 56 ? `grab (${moveName})` : "grab";
    } else if (
      (c.openerMoveId === 1 || c.openerMoveId == null) &&
      hasAttackerOwnedItem(frames, c.startFrame, attackerIndex)
    ) {
      openerFamily = "projectile";
      openerLabel = "projectile";
    } else {
      openerFamily = familyOfMove(c.openerMoveId);
      openerLabel = displayMoveName(c.openerMoveId);
    }

    const facing = victimPost.facingDirection ?? 1;
    const dx = attackerX - victimX;
    const dy = attackerY - victimY;

    const ledgeX = STAGE_LEDGE_X[stageId] ?? 80;
    const side = Math.sign(victimX) || 1;
    const cornered =
      Math.abs(victimX) > CORNER_FRACTION * ledgeX && side * attackerX < Math.abs(victimX) && side * attackerX > -15;

    let stockNumber: number | null = null;
    let deathFrame: number | null = null;
    let deathVerdict: OpeningEvent["deathVerdict"] = null;
    if (c.didKill && c.endFrame != null) {
      const stock = stocks.find(
        (s) => s.victimSlot === victimSlot && s.endFrame != null && Math.abs(s.endFrame - (c.endFrame ?? 0)) < 10,
      );
      if (stock) {
        stockNumber = stock.stockNumber;
        deathFrame = stock.endFrame;
        deathVerdict = stock.verdict;
      }
    }

    out.push({
      victimSlot,
      attackerSlot,
      startFrame: c.startFrame,
      endFrame: c.endFrame,
      openerMoveId: c.openerMoveId,
      openerLabel,
      openerFamily,
      grab,
      openingType: c.openingType,
      traded: (attackersByStart.get(c.startFrame)?.size ?? 0) > 1,
      situation: classifySituation(victimState),
      victimState,
      attackerState,
      victimPercent: round2(victimPost.percent ?? 0),
      attackerPercent: round2(attackerPost.percent ?? 0),
      victimX: round2(victimX),
      victimY: round2(victimY),
      attackerX: round2(attackerX),
      attackerY: round2(attackerY),
      relativeX: round2(dx * facing),
      relativeY: round2(dy),
      distance: round2(Math.hypot(dx, dy)),
      cornered,
      onPlatform: isOnPlatform(victimY, stageId),
      damage: c.damage,
      moveCount: c.moveCount,
      didKill: c.didKill,
      stockNumber,
      deathFrame,
      deathVerdict,
      // The full conversion's ordered move ids are the conversion-sequence
      // evidence used by openingClusters.ts. Omitted when the parser
      // recorded no damaging hits (the opener check above already skips
      // those, so this is a guard, not a normal case).
      ...(c.moves.length > 0 ? { moveIds: c.moves.map((m) => m.moveId) } : {}),
    });
  }

  return out.sort((a, b) => a.startFrame - b.startFrame || a.victimSlot - b.victimSlot);
}
