import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';

export const careerToolCapability = Object.freeze({ careerToolCapability: true });
export const careerToolContextSchema = z.object({
  ownerId: z.string().min(1),
  actorId: z.string().min(1),
  conversationId: z.string().min(1),
  requestId: z.string().min(1),
  resumeJobId: z.string().min(1).optional(),
  capability: z.custom<object>((value) => value === careerToolCapability, 'Career tool authorization is required.'),
});
export type CareerToolContext = z.infer<typeof careerToolContextSchema>;

export function createCareerToolContext(input: Omit<CareerToolContext, 'capability'>) {
  const context = new RequestContext<CareerToolContext>();
  for (const [key, value] of Object.entries({ ...input, capability: careerToolCapability })) if (value !== undefined) context.set(key as keyof CareerToolContext, value as never);
  return context;
}
