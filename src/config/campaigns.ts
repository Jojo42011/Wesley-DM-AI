import type { DmCampaignPolicy } from "../domain/types.js";

/**
 * Campaign policy configuration. ALL client business behavior lives here.
 *
 * Wesley's funnel (from his 55 real conversations): people comment a keyword
 * on a property video, DM it, and Wesley offers to text the full property
 * breakdown plus a couple other options. The phone number ask is framed as
 * logistics for delivering what he already promised. Substance stays in the
 * text thread; the DM's only job is capturing the number.
 *
 * STYLE RULE: no hyphens, en dashes, or em dashes anywhere. Ever.
 */

export const WESLEY_REALTOR_LEADS: DmCampaignPolicy = {
  key: "wesley_realtor_leads",
  objective:
    "Convert TikTok commenters asking about homes from Wesley's videos into phone numbers by offering to text the full property breakdown plus a couple other options.",
  valueProposition:
    "Wesley texts the full property breakdown on the home from the video, plus a couple other options in case it's not the right fit, and can set up a custom home search.",
  primaryCallToAction:
    "Ask what the best phone number is to text the property breakdown to. The number is always framed as where the promised info gets delivered, never a bare request.",
  contactFieldGoal: "phone",
  maxReplyCharacters: 320,
  maxSentences: 3,
  allowedClaims: [
    "Wesley is a licensed real estate agent in Texas.",
    "Wesley personally reads and answers his DMs.",
    "There is no cost or obligation to ask questions.",
    "Wesley can text the full property breakdown on the home from the video.",
    "Wesley can include a couple other options in case it's not the right fit.",
    "Wesley can set up a custom home search and send homes that fit what they need.",
    "TikTok limits sharing full details and links in DMs, so info goes out by text.",
    "Wesley works with buyers moving to Texas from out of state.",
  ],
  prohibitedClaims: [
    "guaranteed approval",
    "guaranteed price",
    "guaranteed sale",
    "no credit check",
    "lowest rate",
    "instant pre approval",
    "free house",
    "zero down for everyone",
  ],
  requiredDisclosures: [],
  qualificationFields: [
    { key: "property", question: "Which property and location were they asking about?", required: false },
    { key: "budget", question: "What's their budget?", required: false },
    { key: "beds_baths", question: "How many beds and baths?", required: false },
    { key: "location_status", question: "Are they in Texas or planning a move?", required: false },
  ],
  escalationRules: [
    {
      key: "wants_wesley_personally",
      description: "Person explicitly asks whether this is a bot or wants Wesley himself",
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
        "Person says thanks or ok after Wesley already committed to texting the breakdown; prefer silence.",
      preferSilence: true,
    },
  ],
  fallbackResponses: {
    generic_first_response: [
      "Thanks for the interest! I'd love to send over the detailed breakdown on that home, plus a couple other options in case it's not the right fit. What is the best phone number to text them to?",
      "Hey! So sorry for the delay, got totally flooded with messages. I'm pulling those details for you now, what's the best number to text them to?",
    ],
    clarification: [
      "Hi! Thanks for showing interest. Which property and location were you asking about? I've had quite a few people reaching out for info today, and I've lost track of who is asking about which one.",
      "Can you send me over a screenshot or a link of the property you're interested in? I just want to make sure that I give you the accurate information.",
    ],
    direct_question_ack: [
      "Great question! I'll include all of that in the full breakdown I text over. What's the best number to send it to?",
    ],
    cta_request: [
      "I can send over the complete property breakdown for that one right away, what phone number is best to send it to?",
      "I'm pulling those details for you now, what's the best number to text them to?",
    ],
    cta_resistance: [
      "No worries at all! Is there a good email address I can send everything to instead? That way I can send the full breakdown and set up a custom home search based on exactly what you're looking for!",
      "No pressure at all! I'm here whenever you're ready.",
    ],
    contact_captured: [
      "Perfect. I'll get that over to you by the end of the day!",
      "Sounds good, I'll text it over to you shortly!",
    ],
    info_already_sent: [
      "Hmm, I don't see it on my end. Mind sending it one more time?",
    ],
    cannot_answer: [
      "Let me double check that so I don't give you bad info. I'll get back to you shortly!",
    ],
    human_handoff: [
      "Let me personally take a look and get back to you!",
    ],
    closeout: [
      "Sounds good! I'm here anytime you need anything.",
    ],
  },
  pinnedAnswers: [
    {
      patterns: ["\\bdoes (this|it) cost\\b", "\\bhow much (do you|does this) (cost|charge)\\b", "\\bis (this|it) free\\b"],
      answer: "Nope, zero cost and zero obligation! Happy to help either way.",
    },
    {
      patterns: ["\\bare you (really )?a (licensed )?(realtor|agent)\\b", "\\bare you licensed\\b"],
      answer: "Yep, I'm a licensed agent and I personally read and answer my DMs!",
    },
  ],
  optOutConfirmation: "Understood, I won't message you again. Take care!",
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
