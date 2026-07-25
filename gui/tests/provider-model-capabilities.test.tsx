import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ProviderModels from "../src/components/provider-workspace/ProviderModels";
import { LanguageProvider } from "../src/i18n/provider";

let previousLanguage: unknown;

beforeEach(() => {
  previousLanguage = (globalThis.navigator as { language?: unknown } | undefined)?.language;
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
});

afterEach(() => {
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: previousLanguage,
  });
});

test("provider models show imported display names and explicit capabilities", () => {
  const html = renderToStaticMarkup(
    <LanguageProvider>
      <ProviderModels
        item={{
          name: "gateway-gpt",
          adapter: "openai-responses",
          baseUrl: "https://gateway.example/v1",
          defaultModel: "gpt-5.6-sol",
          models: ["gpt-5.6-sol"],
          gateway: { kind: "sub2api", label: "Team gateway", manifestVersion: 2 },
          modelDisplayNames: { "gpt-5.6-sol": "GPT 5.6 Sol · Team" },
          modelInputModalities: { "gpt-5.6-sol": ["text", "image"] },
          modelReasoningEfforts: { "gpt-5.6-sol": ["low", "high", "xhigh"] },
          modelDefaultReasoningEfforts: { "gpt-5.6-sol": "high" },
          modelServiceTiers: { "gpt-5.6-sol": ["priority"] },
        }}
        availableModels={["gpt-5.6-sol"]}
        selectedModels={["gpt-5.6-sol"]}
      />
    </LanguageProvider>,
  );

  expect(html).toContain("GPT 5.6 Sol · Team");
  expect(html).toContain("gpt-5.6-sol");
  expect(html).toContain("Fast");
  expect(html).toContain("Reasoning: low / high / xhigh");
  expect(html).toContain("Vision");
  expect(html).toContain("Default reasoning: high");
});

test("legacy models do not claim undeclared Fast or reasoning support", () => {
  const html = renderToStaticMarkup(
    <LanguageProvider>
      <ProviderModels
        item={{
          name: "legacy",
          adapter: "openai-responses",
          baseUrl: "https://legacy.example/v1",
          models: ["gpt-5.6-sol"],
        }}
        availableModels={["gpt-5.6-sol"]}
        selectedModels={[]}
      />
    </LanguageProvider>,
  );

  expect(html).not.toContain(">Fast<");
  expect(html).not.toContain("Reasoning:");
  expect(html).not.toContain(">Vision<");
});
