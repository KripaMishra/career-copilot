import { z } from 'zod';

export const OnboardingStatusSchema = z.enum(['collecting', 'review', 'completed', 'cancelled']);
export type OnboardingStatus = z.infer<typeof OnboardingStatusSchema>;

const answer = z.string().trim().min(1).max(4000);
export const OnboardingDraftSchema = z.object({
  currentStatus: answer.optional(),
  experience: answer.optional(),
  education: answer.optional(),
  skills: answer.optional(),
  projects: answer.optional(),
  achievements: answer.optional(),
  targetRoles: answer.optional(),
  locationPreferences: answer.optional(),
  workAuthorization: answer.optional(),
  employmentPreferences: answer.optional(),
  compensation: answer.optional(),
  motivators: answer.optional(),
  careerGoals: answer.optional(),
  exampleJob: answer.optional(),
}).strict();
export type OnboardingDraft = z.infer<typeof OnboardingDraftSchema>;
export type OnboardingField = keyof OnboardingDraft;

export const OnboardingDecisionSchema = z.object({
  reply: z.string().trim().min(1).max(1200),
  draftPatch: OnboardingDraftSchema,
  readyForReview: z.boolean(),
}).strict();
export type OnboardingDecision = z.infer<typeof OnboardingDecisionSchema>;

export const onboardingFields: Array<{ key: OnboardingField; label: string; question: string; required: boolean }> = [
  { key: 'currentStatus', label: 'Current role/status', question: 'What is your current role/status and experience level?', required: true },
  { key: 'experience', label: 'Experience', question: 'What experience should I highlight?', required: true },
  { key: 'education', label: 'Education', question: 'What education or certifications should I include?', required: true },
  { key: 'skills', label: 'Skills', question: 'What skills and technologies should I emphasize?', required: true },
  { key: 'projects', label: 'Projects', question: 'What projects best show your work?', required: true },
  { key: 'achievements', label: 'Achievements', question: 'What achievements should stand out?', required: true },
  { key: 'targetRoles', label: 'Target roles', question: 'What target roles, seniority, industries, or companies do you prefer?', required: true },
  { key: 'locationPreferences', label: 'Location preferences', question: 'What location, remote, and relocation preferences should I use?', required: true },
  { key: 'workAuthorization', label: 'Work authorization', question: 'What work authorization or sponsorship requirements matter?', required: true },
  { key: 'employmentPreferences', label: 'Employment preferences', question: 'What employment type and availability should I use?', required: true },
  { key: 'compensation', label: 'Compensation', question: 'Optional: any compensation expectations to include or avoid? Reply skip if none.', required: false },
  { key: 'motivators', label: 'Strengths and preferences', question: 'What strengths, growth areas, likes, dislikes, or deal-breakers matter?', required: true },
  { key: 'careerGoals', label: 'Career goals', question: 'What career goals should guide recommendations?', required: true },
  { key: 'exampleJob', label: 'Example job', question: 'Optional: describe an example desired job. Reply skip if none.', required: false },
];

export function onboardingMissingFields(draft: OnboardingDraft) {
  return onboardingFields.filter((field) => field.required && !draft[field.key]?.trim()).map((field) => field.key);
}

export function nextOnboardingQuestion(draft: OnboardingDraft) {
  const field = onboardingFields.find((candidate) => candidate.required && !draft[candidate.key]?.trim()) ?? onboardingFields.find((candidate) => !candidate.required && !draft[candidate.key]?.trim());
  return field?.question ?? null;
}

export function requiredOnboardingComplete(draft: OnboardingDraft) {
  return onboardingMissingFields(draft).length === 0;
}

export function onboardingReviewText(draft: OnboardingDraft) {
  const parsed = OnboardingDraftSchema.parse(draft);
  const lines = onboardingFields.filter((field) => parsed[field.key]?.trim()).map((field) => `- ${field.label}: ${parsed[field.key]}`);
  return `Review your onboarding profile:\n${lines.join('\n')}\n\nReply confirm to activate it, edit <field>: <value>, or cancel.`;
}

export function buildOnboardingProfileText(draft: OnboardingDraft) {
  const parsed = OnboardingDraftSchema.parse(draft);
  return ['# Career onboarding profile', ...onboardingFields.filter((field) => parsed[field.key]?.trim()).map((field) => `${field.label}: ${parsed[field.key]}`)].join('\n');
}

export type OnboardingRecord = { ownerId: string; conversationId: string; status: OnboardingStatus; draft: OnboardingDraft; version: number; createdAt: number; updatedAt: number };

export function onboardingFieldFromLabel(label: string): OnboardingField | null {
  const normalized = label.toLowerCase().replace(/[^a-z]/g, '');
  const match = onboardingFields.find((field) => field.key.toLowerCase() === normalized || field.label.toLowerCase().replace(/[^a-z]/g, '') === normalized);
  return match?.key ?? null;
}

export function isUnavailableOnboardingInput(text: string) {
  return /\b(resume|cv|upload|file|pdf|docx?|image|png|jpe?g|screenshot)\b/i.test(text) || /https?:\/\//i.test(text);
}

export function isDirectIdentifierOnboardingInput(text: string) {
  const labeledIdentifier = /\b(?:ssn|social security|aadhaar|aadhar|pan card|passport|driver'?s license|tax id|government id|bank account|credit card|debit card|iban|routing number)\b\s*(?:(?:number|no\.?)\s*)?(?:is\s+|[:=#]\s*|\s+(?=[A-Z0-9-]*\d))[A-Z0-9][A-Z0-9 -]{3,}/i;
  return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
    || /\b(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})\b/.test(text)
    || /\b(?:legal name|full legal name|my name is|date of birth|birth date|dob|born on|birthday|my address is|home address|street address)\b/i.test(text)
    || labeledIdentifier.test(text)
    || /\b[A-Z]{5}\d{4}[A-Z]\b/.test(text)
    || /\b\d{3}-\d{2}-\d{4}\b/.test(text)
    || /\b(?:\d[ -]?){12,19}\b/.test(text)
    || /\b(?:password|passwd|api[_ -]?key|secret|token|credential)\s*[:=]\s*\S+/i.test(text);
}

export function assertSafeOnboardingDraft(draft: OnboardingDraft) {
  for (const value of Object.values(OnboardingDraftSchema.parse(draft))) if (value && isDirectIdentifierOnboardingInput(value)) throw new Error('Onboarding draft contains direct personal identifiers.');
}
