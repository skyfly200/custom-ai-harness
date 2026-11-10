// Vercel adapter (Edge runtime): vercel.json rewrites /v1/* here. The shared handler in
// serverless/core.mjs does the work.
import { handle } from '../../serverless/core.mjs';

export const config = { runtime: 'edge' };

export default function handler(request) {
    return handle(request, process.env);
}
