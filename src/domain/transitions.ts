import { ConversationStage } from "./types.js";

/**
 * Deterministic stage transitions. Campaigns are not forced through every
 * stage — these are the *allowed* moves; guard handlers decide when to move.
 */
const ALLOWED: Record<ConversationStage, ConversationStage[]> = {
  [ConversationStage.New]: [
    ConversationStage.ClarificationPending,
    ConversationStage.ValueOffered,
    ConversationStage.ContactRequested,
    ConversationStage.ContactCaptured,
    ConversationStage.HumanReview,
    ConversationStage.Closed,
  ],
  [ConversationStage.ClarificationPending]: [
    ConversationStage.ValueOffered,
    ConversationStage.ContactRequested,
    ConversationStage.ContactCaptured,
    ConversationStage.HumanReview,
    ConversationStage.Closed,
  ],
  [ConversationStage.ValueOffered]: [
    ConversationStage.ContactRequested,
    ConversationStage.ContactCaptured,
    ConversationStage.FollowUpDue,
    ConversationStage.HumanReview,
    ConversationStage.Closed,
  ],
  [ConversationStage.ContactRequested]: [
    ConversationStage.ContactCaptured,
    ConversationStage.ValueOffered,
    ConversationStage.FollowUpDue,
    ConversationStage.HumanReview,
    ConversationStage.Closed,
  ],
  [ConversationStage.ContactCaptured]: [
    ConversationStage.Qualification,
    ConversationStage.HandoffReady,
    ConversationStage.HumanReview,
    ConversationStage.Closed,
  ],
  [ConversationStage.Qualification]: [
    ConversationStage.HandoffReady,
    ConversationStage.HumanReview,
    ConversationStage.Closed,
  ],
  [ConversationStage.HandoffReady]: [
    ConversationStage.Closed,
    ConversationStage.HumanReview,
  ],
  [ConversationStage.FollowUpDue]: [
    ConversationStage.ValueOffered,
    ConversationStage.ContactRequested,
    ConversationStage.ContactCaptured,
    ConversationStage.HumanReview,
    ConversationStage.Closed,
  ],
  [ConversationStage.HumanReview]: [ConversationStage.Closed],
  [ConversationStage.Closed]: [
    // A closed conversation can be reopened by a new inbound message.
    ConversationStage.FollowUpDue,
    ConversationStage.ContactRequested,
    ConversationStage.HumanReview,
  ],
};

export function canTransition(
  from: ConversationStage,
  to: ConversationStage,
): boolean {
  if (from === to) return true;
  return ALLOWED[from]?.includes(to) ?? false;
}

/** Move if allowed, otherwise stay (transitions are never model-authoritative). */
export function transition(
  from: ConversationStage,
  to: ConversationStage,
): ConversationStage {
  return canTransition(from, to) ? to : from;
}
