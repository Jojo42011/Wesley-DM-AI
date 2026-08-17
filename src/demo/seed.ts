import { randomUUID } from "node:crypto";
import type { Lead, Message } from "../domain/types.js";
import { ConversationStage } from "../domain/types.js";
import type { Store } from "../persistence/types.js";
import { DEFAULT_CAMPAIGN_KEY } from "../config/campaigns.js";

/**
 * Demo data seeding (DEMO_MODE=1) so the dashboard is reviewable before
 * real traffic flows. Skips seeding when any leads already exist.
 */

const NAMES: Array<[string, string]> = [
  ["mia.htx", "Mia Alvarez"], ["jordan_buyshomes", "Jordan Blake"], ["kelsey.rae", "Kelsey Rae"],
  ["tommy2turnt", "Tommy Nguyen"], ["ashley_inatx", "Ashley Park"], ["marcus.dfw", "Marcus Reed"],
  ["brithefirsttimer", "Bri Coleman"], ["dylan.saenz", "Dylan Saenz"], ["notyouravgrenter", "Sam Ortiz"],
  ["laurenloveshomes", "Lauren Diaz"], ["chris.p.homes", "Chris Peterson"], ["nina_wants_keys", "Nina Torres"],
  ["jakefromtiktok", "Jake Miller"], ["sofia.moves", "Sofia Herrera"], ["theewestside", "Devon Carter"],
  ["katie.buys", "Katie Lin"], ["rob_relocates", "Rob Fontaine"], ["emily.eastside", "Emily Novak"],
];

const STAGES: ConversationStage[] = [
  ConversationStage.ClarificationPending,
  ConversationStage.ValueOffered,
  ConversationStage.ContactRequested,
  ConversationStage.ContactCaptured,
  ConversationStage.HandoffReady,
  ConversationStage.FollowUpDue,
  ConversationStage.Closed,
];

function rand(n: number): number {
  return Math.floor(Math.random() * n);
}

export async function seedDemoData(store: Store): Promise<void> {
  if ((await store.leads.count()) > 0) return;

  const nowMs = Date.now();
  for (let i = 0; i < NAMES.length; i++) {
    const [username, displayName] = NAMES[i]!;
    const ageDays = rand(14);
    const created = new Date(nowMs - ageDays * 86400_000 - rand(43200_000));
    const stage = i < 6
      ? (i % 2 === 0 ? ConversationStage.ContactCaptured : ConversationStage.HandoffReady)
      : STAGES[rand(STAGES.length)]!;
    const hasPhone =
      stage === ConversationStage.ContactCaptured ||
      stage === ConversationStage.HandoffReady ||
      Math.random() < 0.2;

    const lead: Lead = {
      id: randomUUID(),
      platform: "tiktok",
      externalUserId: username,
      username,
      displayName,
      phone: hasPhone ? `+1512555${String(1000 + rand(9000))}` : null,
      email: null,
      stage,
      sourceCampaign: "spring_buyers",
      conversationGoal: DEFAULT_CAMPAIGN_KEY,
      qualification:
        Math.random() < 0.7
          ? { buy_or_sell: Math.random() < 0.75 ? "buy" : "sell", timeline: ["immediate", "near_term", "long_term"][rand(3)] }
          : {},
      tags: [],
      notes: null,
      aliases: [username],
      optedOut: stage === ConversationStage.Closed && Math.random() < 0.4,
      createdAt: created.toISOString(),
      updatedAt: created.toISOString(),
      lastInboundAt: new Date(created.getTime() + rand(7200_000)).toISOString(),
      lastOutboundAt: new Date(created.getTime() + rand(7200_000)).toISOString(),
    };
    await store.leads.create(lead);

    const convo: Array<[Message["role"], string, Message["source"]]> = [
      ["assistant", "Hey! Saw your comment — happy to help. Are you looking to buy or sell?", "manual_seed"],
      ["user", lead.qualification.buy_or_sell === "sell" ? "Thinking about selling my place actually" : "Looking to buy my first home!", "tiktok_manychat"],
      ["assistant", "Love that. Easiest way to get you real answers is a quick text — what's the best number for you?", "automation"],
    ];
    if (hasPhone) {
      convo.push(["user", `sure it's ${lead.phone}`, "tiktok_manychat"]);
      convo.push(["assistant", "Perfect, got it. I'll reach out shortly!", "automation"]);
    }
    let t = created.getTime();
    for (const [role, text, source] of convo) {
      t += 60_000 + rand(600_000);
      await store.conversations.appendMessage({
        id: randomUUID(),
        leadId: lead.id,
        role,
        text,
        providerMessageId: null,
        source,
        createdAt: new Date(t).toISOString(),
      });
    }
  }
}
