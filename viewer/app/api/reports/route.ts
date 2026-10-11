import { env } from 'cloudflare:workers';
import { reportsEndpoint } from '@/server/http.mjs';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return reportsEndpoint(request, env.BUCKET);
}

export async function POST(request: Request) {
  return reportsEndpoint(request, env.BUCKET);
}
