// The stand-ins for Tavily and Token Factory in verify:windows's research checks (D37), on loopback in the distribution
// verify-windows.ts runs in. Tavily's search finds one page and its extract reads one passage; the model answers a
// repository's turn by reading its README and replying with the plan, and research with one contradicted assumption
// whose quotation is in that passage. Nothing reaches the network.
import { extractAnswer, searchAnswer, startTavilyStub, type TavilyStub } from "../../engine/test/stub-tavily.ts";
import { startStub, toolCall, type Stub } from "../../engine/test/stub-token-factory.ts";
import { isResearchRequest, RESEARCH_PLAN } from "./stand-in.ts";

const WHATSNEW = "https://docs.python.org/3/whatsnew/3.12.html";
const ASSESSED = {
  assessments: [
    {
      assumption: "A1",
      outcome: "contradicted",
      reasoning: "The 3.12 release notes say distutils was removed.",
      citations: [{ passage: "S1.1", stance: "contradicts", quote: "has been removed from the standard library" }],
      applicability: { plan: "Python 3.12", source: "Python 3.12", where: "title" },
      uncertainty: "",
      amendment: "Install setuptools in the 3.12 image before switching.",
    },
  ],
};

export interface ResearchStandIns {
  tavily: TavilyStub;
  model: Stub;
  close(): Promise<void>;
}

export async function startResearchStandIns(): Promise<ResearchStandIns> {
  const tavily = await startTavilyStub((call) => {
    if (call.path === "/search") return { body: searchAnswer([{ url: WHATSNEW, title: "What's New In Python 3.12" }]) };
    if (call.path === "/extract") return { body: extractAnswer([{ url: WHATSNEW, chunks: ["## Removed\nThe distutils package has been removed from the standard library."] }]) };
    return { status: 404, body: {} };
  });
  const model = await startStub({
    models: [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }],
    chat: (request, index) => {
      if (isResearchRequest(request)) return toolCall("submit_research", ASSESSED);
      return request.raw.includes('"role":"tool"')
        ? toolCall("submit_reply", { answer: RESEARCH_PLAN, evidence: [{ statement: "The README names the image.", citations: [{ path: "README.md", startLine: 1, endLine: 1 }] }] }, { id: `r${index}` })
        : toolCall("read_file", { path: "README.md" }, { id: `q${index}` });
    },
  });
  return {
    tavily,
    model,
    close: async () => {
      await Promise.all([tavily.close(), model.close()]);
    },
  };
}
