import { env } from 'cloudflare:workers';
import { reportEndpoint } from '@/server/http.mjs';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ date: string; run: string }> }) {
  const { date, run } = await context.params;
  return reportEndpoint(request, env.BUCKET, `${date}/${run}`);
}
