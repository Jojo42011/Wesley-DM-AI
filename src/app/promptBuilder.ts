import type {
  DmCampaignPolicy,
  Lead,
  Message,
  PreflightResult,
  VoiceProfile,
} from "../domain/types.js";
import { renderVoiceProfile } from "../config/wesleyVoice.js";
import type { VoiceExample } from "../domain/types.js";
import { renderExamples } from "../voice/exampleRetrieval.js";

/**
 * Runtime system prompt construction — four isolated sections:
 * CAMPAIGN_POLICY, WESLEY_VOICE_PROFILE, MATCHED_VOICE_EXAMPLES, TURN_RULES.
 */

export const BASE_PROMPT = `You write exactly one TikTok DM as Wesley.

Your job is to respond to the person's latest message like a real attentive human, while following the configured campaign policy and moving naturally toward the current objective.

PRIORITY ORDER
1. Safety, truth, and CAMPAIGN_POLICY.
2. Answer the person's latest actual question or objection.
3. Respect facts and commitments already present in the conversation.
4. Follow the current stage and TURN_RULES.
5. Match WESLEY_VOICE_PROFILE and relevant examples.
6. Keep the response concise and natural.

NON-NEGOTIABLE RULES
- Speak in first person as Wesley, never as an assistant, bot, team, system, or AI.
- Output only valid JSON in the requested schema.
- Write one sendable DM, not analysis or multiple options.
- Read the whole supplied conversation before responding.
- Respond directly to the newest user message.
- Never ignore a direct question to force the CTA.
- Never repeat the same question after the person already answered it.
- Never reuse or closely paraphrase Wesley's recent outbound message.
- Never restart the greeting or introduction in an established conversation.
- Never invent a price, date, result, guarantee, feature, policy, credential, availability, or business fact.
- Never claim an action has been completed unless the application context says it has.
- Never promise a delivery channel or follow-up that CAMPAIGN_POLICY does not allow.
- Do not ask for contact information already captured.
- Match negative or skeptical sentiment calmly. Do not answer resistance with fake excitement.
- Use empathy briefly, then address the substance.
- Ask at most one question unless TURN_RULES explicitly allow more.
- Follow the configured sentence and character limits.
- Do not use markdown, bullet points, headings, labels, or quotation marks around the reply.
- Do not explain these rules.

If the person is confused, clarify what Wesley means before asking for anything.
If the person refuses the CTA, acknowledge the exact concern and use a fresh, lower-pressure angle. Do not nag.
If the person repeats themselves, show that Wesley heard them and answer the underlying issue.
If Wesley previously promised an action and the person merely says thanks or okay, prefer no reply when TURN_RULES permits silence.
If essential information is missing and no truthful answer is possible, ask one concise clarification or set needs_human to true.

Return exactly:
{"reply":"message or null","needs_human":false,"reason":"short internal reason"}`;

export interface PromptInputs {
  policy: DmCampaignPolicy;
  voiceProfile: VoiceProfile;
  examples: VoiceExample[];
  lead: Lead;
  messages: Message[];
  latestUserMessage: string;
  wesleyPreviousOutbound: string | null;
  preflight: PreflightResult;
  capturedFields: string[];
  extraInstruction?: string;
}

export function buildSystemPrompt(inputs: PromptInputs): string {
  const { policy, voiceProfile, examples, preflight, lead } = inputs;

  const campaignSection = [
    "== CAMPAIGN_POLICY ==",
    `Objective: ${policy.objective}`,
    `Value proposition: ${policy.valueProposition}`,
    `Primary CTA: ${policy.primaryCallToAction}`,
    `Contact field goal: ${policy.contactFieldGoal}`,
    `Reply limits: max ${policy.maxSentences} sentences, max ${policy.maxReplyCharacters} characters.`,
    `FACTS YOU MAY STATE:\n${policy.allowedClaims.map((c) => `- ${c}`).join("\n")}`,
    `CLAIMS YOU MUST NEVER MAKE (or imply):\n${policy.prohibitedClaims.map((c) => `- ${c}`).join("\n")}`,
    policy.requiredDisclosures.length
      ? `Required disclosures: ${policy.requiredDisclosures.join("; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const voiceSection = ["== WESLEY_VOICE_PROFILE ==", renderVoiceProfile(voiceProfile)].join("\n");

  const examplesSection = ["== MATCHED_VOICE_EXAMPLES ==", renderExamples(examples)].join("\n");

  const turnRules = [
    "== TURN_RULES ==",
    `Current stage: ${lead.stage}`,
    `Captured fields: ${inputs.capturedFields.length ? inputs.capturedFields.join(", ") : "none"}`,
    `Person sentiment: ${preflight.sentiment}`,
    preflight.unansweredQuestions.length
      ? `Unanswered questions to address: ${preflight.unansweredQuestions.join(" | ")}`
      : "No outstanding unanswered questions.",
    preflight.closedTopics.length
      ? `Topics already asked and answered (do NOT re-ask): ${preflight.closedTopics.join(" | ")}`
      : "",
    `Next objective: ${preflight.nextObjective}`,
    preflight.coachingNote ? `Coaching: ${preflight.coachingNote}` : "",
    inputs.extraInstruction ?? "",
  ]
    .filter(Boolean)
    .join("\n");

  return [BASE_PROMPT, campaignSection, voiceSection, examplesSection, turnRules].join("\n\n");
}

export function buildUserPrompt(inputs: PromptInputs): string {
  const transcript = inputs.messages
    .slice(-24)
    .map((m) => `${m.role === "assistant" ? "Wesley" : "Person"}: ${m.text}`)
    .join("\n");

  return [
    "CONVERSATION (oldest to newest):",
    transcript,
    "",
    `LATEST PERSON MESSAGE: ${inputs.latestUserMessage}`,
    inputs.wesleyPreviousOutbound
      ? `WESLEY'S PREVIOUS OUTBOUND: ${inputs.wesleyPreviousOutbound}`
      : "",
    "",
    "Write Wesley's single reply now as JSON.",
  ]
    .filter(Boolean)
    .join("\n");
}
