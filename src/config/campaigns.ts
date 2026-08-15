import type { DmCampaignPolicy } from "../domain/types.js";

/**
 * Campaign policy configuration. ALL client business behavior lives here.
 *
 * Placeholders marked [WESLEY: ...] must be confirmed with Wesley before
 * production launch. The engine never invents business facts — it can only
 * state what `allowedClaims` contains and must never state `prohibitedClaims`.
 */

export const WESLEY_REALTOR_LEADS: DmCampaignPolicy = {
  key: "wesley_realtor_leads",
  objective:
    "Convert inbound TikTok DMs from people interested in buying or selling a home into a phone number Wesley can call.",
  valueProposition:
    "[WESLEY: confirm value prop] Wesley helps people find and tour homes that fit their budget and answers their real-estate questions directly.",
  primaryCallToAction:
    "Ask for the best phone number so Wesley can text or call them personally.",
  contactFieldGoal: "phone",
  maxReplyCharacters: 320,
  maxSentences: 3,
  allowedClaims: [
    "Wesley is a licensed real estate agent.",
    "Wesley personally reads and answers his DMs.",
    "There is no cost or obligation to ask questions.",
  ],
  prohibitedClaims: [
    "guaranteed approval",
    "guaranteed price",
    "guaranteed sale",
    "no credit check",
    "lowest rate",
    "instant pre-approval",
    "free house",
    "zero down for everyone",
  ],
  requiredDisclosures: [],
  qualificationFields: [
    { key: "buy_or_sell", question: "Are they looking to buy or sell?", required: false },
    { key: "area", question: "What area are they looking in?", required: false },
    { key: "timeline", question: "What's their timeline?", required: false },
  ],
  escalationRules: [
    {
      key: "wants_wesley_personally",
      description: "Person explicitly asks to speak to Wesley personally / a real human",
      patterns: ["\\bis this a bot\\b", "\\breal person\\b", "\\bspeak to wesley\\b", "\\btalk to wesley\\b"],
    },
    {
      key: "legal_financial_advice",
      description: "Legal, tax or contractual advice beyond approved language",
      patterns: ["\\blawsuit\\b", "\\bsue\\b", "\\bforeclosure notice\\b", "\\battorney\\b", "\\beviction\\b"],
    },
    {
      key: "safety",
      description: "Threats, harassment, self-harm, emergencies",
      patterns: ["\\bkill\\b", "\\bhurt (myself|someone)\\b", "\\bsuicid", "\\bemergency\\b", "\\bthreat"],
    },
    {
      key: "complaint",
      description: "Strong complaint or accusation",
      patterns: ["\\bscam\\b", "\\bfraud\\b", "\\breport(ing)? you\\b", "\\bbetter business bureau\\b"],
    },
  ],
  silenceRules: [
    {
      key: "ack_after_commitment",
      description:
        "Person says thanks/ok after Wesley already committed to an action; prefer silence.",
      preferSilence: true,
    },
  ],
  fallbackResponses: {
    generic_first_response: [
      "Hey! Thanks for reaching out — happy to help. What are you looking for right now, buying or selling?",
      "Hey, appreciate you messaging! Are you thinking about buying, selling, or just have a question?",
    ],
    clarification: [
      "Just so I point you the right way — are you looking to buy, sell, or just have a question?",
      "Got it — can you tell me a little more about what you're looking for?",
    ],
    direct_question_ack: [
      "Good question — let me get you a real answer instead of guessing. What's the best number to text you at?",
    ],
    cta_request: [
      "Easiest way to get you real answers is a quick text. What's the best number for you?",
      "I can get you exactly what you need — what's a good number to reach you at?",
    ],
    cta_resistance: [
      "Totally fine — no pressure at all. I'm here whenever you're ready.",
      "No worries, happy to keep chatting here. What else can I answer for you?",
    ],
    contact_captured: [
      "Perfect, got it. I'll reach out shortly!",
      "Awesome, locked in. Expect a text from me soon.",
    ],
    info_already_sent: [
      "Hmm, I don't see it on my end — mind sending it one more time?",
    ],
    cannot_answer: [
      "Let me double-check that so I don't give you bad info — I'll get back to you shortly.",
    ],
    human_handoff: [
      "I hear you — let me personally take a look and get back to you.",
    ],
    closeout: [
      "Sounds good — I'm here anytime you need anything!",
    ],
  },
  pinnedAnswers: [
    {
      patterns: ["\\bdoes (this|it) cost\\b", "\\bhow much (do you|does this) (cost|charge)\\b", "\\bis (this|it) free\\b"],
      answer:
        "Nope — asking questions costs nothing and there's zero obligation. Happy to help either way!",
    },
    {
      patterns: ["\\bare you (really )?a (licensed )?(realtor|agent)\\b", "\\bare you licensed\\b"],
      answer: "Yep, I'm a licensed real estate agent — and I personally read and answer my DMs.",
    },
  ],
  optOutConfirmation:
    "Understood — I won't message you again. Take care!",
  defaultPhoneRegion: "US",
};

const CAMPAIGNS: Record<string, DmCampaignPolicy> = {
  [WESLEY_REALTOR_LEADS.key]: WESLEY_REALTOR_LEADS,
};

export const DEFAULT_CAMPAIGN_KEY = WESLEY_REALTOR_LEADS.key;

export function getCampaign(key: string | null | undefined): DmCampaignPolicy {
  if (key && CAMPAIGNS[key]) return CAMPAIGNS[key];
  return WESLEY_REALTOR_LEADS;
}

export function registerCampaign(policy: DmCampaignPolicy): void {
  CAMPAIGNS[policy.key] = policy;
}
