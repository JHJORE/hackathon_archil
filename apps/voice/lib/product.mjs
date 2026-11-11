// Reads an uploaded spec sheet (PDF or text) and turns it into a product profile the
// buyer swarm and call scripts work from. Uses Claude on Bedrock with native PDF input.
import { generateText, Output } from "ai";
import { z } from "zod";
import { llm } from "./llm.mjs";

export const ProductSchema = z.object({
  product_name: z.string(),
  seller: z.string().describe("manufacturer or seller named in the document, empty string if none"),
  category: z.string().describe("short product category, e.g. 'ductile iron pipe', 'sodium hypochlorite 12.5%'"),
  summary: z.string().describe("2 sentences a buyer would care about"),
  key_specs: z.array(z.object({ name: z.string(), value: z.string() })).describe("the 5-10 specs a purchasing agent checks"),
  standards: z.array(z.string()).describe("certifications/standards met, e.g. AWWA C151, NSF 61, ASTM, Buy America"),
  applications: z.array(z.string()),
  selling_points: z.array(z.string()).describe("3-5 concrete advantages stated or clearly implied by the document"),
  typical_buyers: z.array(z.string()).describe("types of organizations that buy this, e.g. 'municipal water utilities'"),
  buyer_search_queries: z.array(z.string()).describe("8 diverse web searches that would surface organizations buying this product in the US: bid solicitations, bid tabulations, annual supply contracts, award notices, plant/project announcements"),
  unit_of_sale: z.string().describe("e.g. 'per linear foot', 'per gallon', 'per each'"),
});

export async function extractProduct({ pdf, text, filename }) {
  const content = [];
  if (pdf) content.push({ type: "file", data: pdf, mediaType: "application/pdf", filename: filename || "spec.pdf" });
  content.push({
    type: "text",
    text: (text ? `SPEC TEXT:\n${text.slice(0, 30000)}\n\n` : "") +
      "Build a product profile from this specification for a B2B sales team that will find and call potential US buyers. " +
      "Only use facts from the document; use empty strings or empty lists where it is silent.",
  });
  const { output } = await generateText({
    model: llm(),
    output: Output.object({ schema: ProductSchema }),
    messages: [{ role: "user", content }],
  });
  return output;
}
