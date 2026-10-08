/** No listing knowledge is available yet. Public copy cannot contain model facts. */
export function safeCommentReply(bucket: string, key: string, knownContact = false): string | null {
  if (bucket === "skip") return null;
  if (knownContact) return "Good to hear from you again! We can continue in our messages here.";
  const variants: Record<string, string[]> = {
    high_intent: [
      "Thanks for reaching out! Would you mind messaging me here so we can go over the details?",
      "I'd love to help with the details! Would you mind sending me a quick message here?",
      "Happy to go over it with you! Could you send me a message here?",
    ],
    casual: ["Thanks for checking it out! Feel free to message me if you'd like more information."],
    social: ["Thanks for sharing your thoughts!"],
    frustrated: ["I hear you, sorry for the runaround. You're welcome to message me with your questions."],
  };
  const options = variants[bucket];
  if (!options) return null;
  const hash = Array.from(key).reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
  return options[hash % options.length]!;
}
