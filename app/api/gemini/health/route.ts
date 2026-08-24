import { defaultGeminiModel } from "@/lib/gemini/gateway";
import {
  isDurableStateConfigured,
  stateBackend,
} from "@/lib/gemini/state-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    {
      ok: true,
      bridge: "gemini-canonical-ai-sdk-history",
      model: defaultGeminiModel(),
      stateBackend: stateBackend(),
      durableState: isDurableStateConfigured(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
