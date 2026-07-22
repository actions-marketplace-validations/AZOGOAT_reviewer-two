import { z } from "zod";

export const severities = ["critical", "major", "minor", "nit"] as const;
export type Severity = (typeof severities)[number];

/** One reviewer finding, anchored to a file and line in the PR head. */
export const findingSchema = z.object({
  path: z.string().min(1).describe("Repository-relative path of the file"),
  line: z
    .number()
    .int()
    .positive()
    .describe("Line number in the new version of the file"),
  severity: z.enum(severities),
  comment: z
    .string()
    .min(1)
    .describe("Short, direct comment stating the problem and its consequence"),
  suggestion: z
    .string()
    .optional()
    .describe(
      "Replacement code for the commented line(s), only when the fix is obvious",
    ),
  ruleRef: z
    .string()
    .min(1)
    .describe("Rule file or section violated, or 'general'"),
});
export type Finding = z.infer<typeof findingSchema>;

/** Structured output contract of the review phases. */
export const reviewOutputSchema = z.object({
  summary: z.string().describe("Two to four sentence overall assessment"),
  findings: z.array(findingSchema),
});
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

/** Phase-2 verdict on a single candidate finding. */
export const verificationSchema = z.object({
  verdict: z.enum(["confirmed", "discarded"]),
  evidence: z
    .string()
    .describe("Concrete code evidence, or the reason for discarding"),
  severity: z
    .enum(severities)
    .optional()
    .describe(
      "Corrected severity when the evidence shows the impact differs from what was stated",
    ),
});
