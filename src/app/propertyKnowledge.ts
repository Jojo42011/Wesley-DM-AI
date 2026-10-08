/** Service area and conversation history are not verified listing facts. */
export function asksForListingFacts(text: string): boolean {
  return /\b(?:price|pricing|location|address|how much|what (?:city|area)|where (?:is|in|at)|bedrooms?|bathrooms?|square feet|sqft|acreage|builder|still available)\b/i.test(text)
    && !/\b(?:my budget|i (?:live|work)|do you (?:work|sell|cover)|buying process|closing costs|interest rate)\b/i.test(text);
}

export function unverifiedListingReply(hasPhone: boolean): string {
  return "I don't have verified details for that property yet, so I don't want to guess. " +
    (hasPhone ? "I have your number on file. Could you send the video or listing so we can confirm the right one?"
      : "Could you send the video or listing so we can confirm the right one?");
}

export function requestsPhoneNumber(text: string): boolean {
  return /\b(?:what(?:'s| is)|which)\b[^.!?]{0,70}\b(?:phone|number|digits)\b/i.test(text)
    || /\b(?:share|drop|provide|leave|give me|send me|text me)\b[^.!?]{0,50}\b(?:phone|number|digits)\b/i.test(text)
    || /\b(?:can|could|may) (?:i|we) (?:get|have)\b[^.!?]{0,50}\b(?:phone|number|digits)\b/i.test(text);
}
