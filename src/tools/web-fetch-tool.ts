import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { assertJobUrl, assertSameJobSite } from './job-url';

export const webFetchTool = createTool({
  id: 'web_fetch',
  description: 'Fetch a web page by URL and return text content with basic response metadata.',
  inputSchema: z.object({
    url: z.url().describe('The fully qualified URL to fetch.'),
  }),
  outputSchema: z.object({
    url: z.string(),
    status: z.number(),
    statusText: z.string(),
    contentType: z.string().nullable(),
    text: z.string(),
  }),
  execute: async ({ url }: { url: string }) => {
    const jobUrl = assertJobUrl(url);
    const response = await fetch(jobUrl, {
      headers: {
        'user-agent': 'Mastra Workspace Agent/1.0',
        accept: 'text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15_000),
    });
    const finalUrl = assertSameJobSite(jobUrl, response.url);
    const text = await response.text();

    return {
      url: finalUrl.toString(),
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type'),
      text: text.slice(0, 100_000),
    };
  },
});
