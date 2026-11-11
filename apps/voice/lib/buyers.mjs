// Buyer-finding swarm. Given a product profile, three agents hunt for PRIVATE COMPANIES likely
// to buy it, each from a different angle, and write buyers to the campaign folder on the
// shared Archil disk (deduped across agents by organization name). Government buyers are
// rejected in code: outreach is to private companies only.
//   agent-contractors   contractors building projects that need the product (uses the
//                       construction jobs the RFQ Scout set aside as leads)
//   agent-industrial    plants, manufacturers and OEMs that consume the product
//   agent-private-util  investor-owned utilities, EPC/engineering-construction firms, developers
import { ToolLoopAgent, tool, stepCountIs } from "ai";
import { z } from "zod";
import { Keenable } from "keenable";
import { llm } from "./llm.mjs";
import crypto from "node:crypto";
const sha = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);

const BuyerInput = z.object({
  org: z.string().describe("organization name"),
  buyer_type: z.enum(["contractor", "manufacturer", "private_utility", "epc_or_developer", "distributor", "other_private", "government"])
    .describe("government = any public agency (city, county, state, federal, public utility district, school district); those are rejected"),
  location: z.string().describe("city, state"),
  contact_name: z.string().describe("purchasing/procurement contact if found, else empty"),
  contact_title: z.string(),
  phone: z.string().describe("direct or purchasing-office phone number from a public page, else empty"),
  email: z.string(),
  buying_signal: z.string().describe("the concrete evidence they buy this: open RFQ + due date, past award, annual contract, project"),
  evidence_url: z.string(),
  why_fit: z.string().describe("one sentence: why this product fits their need"),
  fit_score: z.number().describe("1-10, 10 = active open need for exactly this product"),
});

const orgKey = (s) => s.toLowerCase().replace(/\b(the|city|county|of|inc|llc|co|corp|department|dept)\b/g, "").replace(/[^a-z0-9]/g, "");

export async function runBuyerSwarm({ store, campaign, log = console.log, budgetMs = 200_000, target = 10 }) {
  const { id, product } = campaign;
  const keenable = new Keenable({ apiKey: process.env.KEENABLE_API_KEY, clientSource: "rfq-scout-buyers" });
  const since = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const found = new Map(); // orgKey -> buyer
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), budgetMs);

  const productBrief = `PRODUCT: ${product.product_name} (${product.category})\n${product.summary}\n` +
    `Specs: ${product.key_specs.map((s) => `${s.name}: ${s.value}`).join("; ")}\n` +
    `Standards: ${product.standards.join(", ") || "n/a"}\nTypical buyers: ${product.typical_buyers.join(", ")}`;

  const addBuyer = (agentId) => tool({
    description: "Add one potential buyer with evidence. Duplicates of an organization already on the list are rejected.",
    inputSchema: BuyerInput,
    execute: async (b) => {
      const k = orgKey(b.org);
      if (!k) return "rejected: missing organization";
      if (b.buyer_type === "government" || /\b(city of|county of|county|town of|village of|state of|department of|authority|public utilit|water district|sanitation district|school district|municipal|commission|board of)\b/i.test(b.org)) {
        return "rejected: government buyer — outreach targets private companies only";
      }
      if (found.has(k)) return `duplicate: ${b.org} is already on the list`;
      const buyer = { id: `b-${sha(k)}`, ...b, found_by: agentId, found_at: new Date().toISOString(), status: "new" };
      found.set(k, buyer);
      await store.put(`campaigns/${id}/buyers/${buyer.id}.json`, JSON.stringify(buyer, null, 2));
      log(`      + buyer [${b.fit_score}/10] ${b.org} (${b.location}) ${b.phone ? "☎ " + b.phone : "no phone yet"} via ${agentId}`);
      if (found.size >= target + 4) abort.abort(); // enough candidates to pick a strong top 10
      return `added (${found.size} buyers on the list so far)`;
    },
  });

  const webTools = (agentId) => ({
    search_web: tool({
      description: "Keenable web search (last 12 months).",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const r = await keenable.search(query, { maxResults: 8, publishedAfter: since, snippetMaxLength: 1200 });
        log(`      ${agentId.padEnd(16)} search: ${query.slice(0, 80)}`);
        return r.results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${(x.snippet || "").replace(/\s+/g, " ").slice(0, 400)}`).join("\n") || "no results";
      },
    }),
    read_page: tool({
      description: "Read a page (first 6000 chars) — use to find a purchasing contact name and phone number.",
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => {
        log(`      ${agentId.padEnd(16)} read: ${url.slice(0, 80)}`);
        return ((await keenable.fetch(url)).content || "").slice(0, 6000);
      },
    }),
    add_buyer: addBuyer(agentId),
  });

  // Construction jobs the RFQ Scout found but set aside (not goods purchases): the contractors
  // bidding on or building these projects are private companies that need materials.
  const projectKeys = (await store.list("rfqs/excluded")).filter((k) => k.endsWith(".json")).slice(0, 40);
  const projects = (await Promise.all(projectKeys.map(async (k) => JSON.parse((await store.get(k)) || "null")))).filter(Boolean);
  const projectList = projects.map((r) => `- ${r.buyer.agency} (${r.buyer.city || ""} ${r.buyer.state}) — ${r.title}; ${(r.line_items || []).map((i) => i.product).join(", ").slice(0, 140)}; ${r.source_url}`).join("\n");
  const rules = `Only PRIVATE COMPANIES — never a city, county, state agency, public utility district or school district (add_buyer rejects them). ` +
    `Find a procurement/purchasing or estimating phone number and a named contact where possible (read_page their contact page). ` +
    `Call add_buyer for up to 6 companies with real evidence of need. About 14 tool calls total.`;

  const agents = [
    {
      id: "agent-contractors",
      tools: webTools("agent-contractors"),
      instructions: `You find US contractors that will need this product for projects they are bidding on or building.\n${productBrief}\n\n` +
        `Public construction projects our RFQ scout found (find who is bidding/awarded: plan holder lists, apparent low bidder, bid results, award news):\n${projectList || "(none on file)"}\n\n` +
        `Also search for contractors recently awarded water main, pipeline or utility projects that use this product. ${rules}`,
      prompt: "Find contractors who need this product.",
    },
    {
      id: "agent-industrial",
      tools: webTools("agent-industrial"),
      instructions: `You find US plants, manufacturers and OEMs that consume this product, and companies announcing facilities or expansions that need it.\n${productBrief}\n` +
        `Search ideas: ${product.buyer_search_queries.join(" | ")}\n${rules}`,
      prompt: "Find industrial companies that buy this product.",
    },
    {
      id: "agent-private-util",
      tools: webTools("agent-private-util"),
      instructions: `You find US investor-owned/private utilities (e.g. water and wastewater companies), engineering-procurement-construction (EPC) firms ` +
        `and real-estate or industrial developers with current projects that need this product.\n${productBrief}\n${rules}`,
      prompt: "Find private utilities, EPC firms and developers that need this product.",
    },
  ];

  log(`      swarm: ${agents.map((a) => a.id).join(", ")} | ${projects.length} construction projects on disk as contractor leads | private companies only`);
  await Promise.all(agents.map(async (a) => {
    try {
      await new ToolLoopAgent({ model: llm(), tools: a.tools, instructions: a.instructions, stopWhen: stepCountIs(16) })
        .generate({ prompt: a.prompt, abortSignal: abort.signal });
    } catch (e) {
      if (!abort.signal.aborted) log(`      ${a.id} stopped: ${e.message.slice(0, 140)}`);
    }
  }));
  clearTimeout(timer);

  // Top 10: open need first, then reachable by phone, then fit.
  const ranked = [...found.values()].sort((a, b) => (b.fit_score + (b.phone ? 2 : 0)) - (a.fit_score + (a.phone ? 2 : 0))).slice(0, target);
  return ranked;
}
