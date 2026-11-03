// Netlify adapter: /v1/* and /healthz go to the shared handler in serverless/core.mjs.
import { handle } from '../../serverless/core.mjs';

export default async (request) => handle(request, process.env);

export const config = { path: ['/v1/*', '/healthz'] };
