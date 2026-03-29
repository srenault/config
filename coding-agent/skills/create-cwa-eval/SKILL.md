---
name: create-cwa-eval
description: >-
  Create LLM-as-a-judge evaluators for the content-writer-agent. Supports two
  scopes: general evals (pushed to LangSmith hub and bound as dataset rules) and
  specific evals (prompt defined inline in code, run on demand). Use when the
  user asks to create, add, or set up a new evaluator for the content writer agent.
---

# LangSmith Evaluator for Content Writer Agent

Workflow for creating an LLM-as-a-judge evaluator for the `content-writer-agent` dataset (`c784905c-2974-4e56-811b-d871039b65ee`).

Two eval scopes are supported:

| Scope | When to use | Prompt lives in | Attached to dataset? | Runs automatically? |
|---|---|---|---|---|
| **General** | Criterion applies to all/most examples (e.g. `instruction_met`, `formatting-rich-text-quality`) | LangSmith hub | Yes (rule) | Yes, on every experiment |
| **Specific** | Criterion targets narrow cases or specific examples (e.g. `bullet_points_in_hero_section`) | Inline in the test file | No | Only when explicitly triggered |

Reference implementation: `createFormattingRichTextQualityEval.ts` (in this skill directory).

## Step 1: Design the evaluator

Gather from the user:

1. **Evaluator display name** -- kebab-case, no capitals, no spaces (e.g. `formatting-rich-text-quality`).
2. **What it checks** -- the evaluation criteria for the system prompt.
3. **Feedback key** -- single boolean, snake_case only, no whitespace or capitals (e.g. `formatting_rich_text_quality`).
4. **Variables needed** -- which dataset fields the prompt template uses.
5. **Dataset splits** -- which splits to run the eval against (e.g. `["formatting"]`, `["regression"]`, or `[]` for all examples).
6. **Pass rate threshold** -- minimum pass rate for the eval runner test (default `0.9`, i.e. 90%).
7. **Eval scope** -- `general` or `specific`.
   - **General**: the criterion is relevant across all (or most) dataset examples. The prompt will be pushed to the LangSmith hub and bound as a dataset rule so it runs automatically on every experiment.
   - **Specific**: the criterion targets narrow cases or specific examples. The prompt will be defined inline in the test file and only runs when explicitly triggered. No hub push, no dataset rule.

### Available variable mappings

| Template variable | Maps to | Description |
|---|---|---|
| `instructions` | `input.messages` | The user request that triggered generation |
| `output` | `output.xmlDiffTextContent` | XML diff showing before/after content changes |
| `customType` | `input.customType` | Prismic custom type schema |
| `inputDocument` | `input.inputDocumentContent` | Original document before changes |
| `appliedChanges` | `output.appliedChanges` | Array of individual field changes |
| `sliceConfig` | `input.resolvedSliceConfig` | Resolved slice configuration |
| `outputDocument` | `output.outputDocumentContent` | Final document after changes |
| `todos` | `output.todos` | Agent's todo list |

The standard pair is `instructions` + `output`. Add others only if the evaluator needs them.

## Step 2: Choose the judge model

Before building the prompt, determine the best OpenAI model for this evaluator.

1. **Fetch the latest models** -- Use the WebFetch tool to load `https://platform.openai.com/docs/models` and identify the current frontier model lineup (names, pricing, context windows, reasoning support).
2. **Assess eval complexity** -- Consider the criteria gathered in Step 1:
   - **Simple** (single criterion, pattern-matching, short inputs): pick the **nano**-tier model (cheapest, fastest).
   - **Moderate** (2-3 criteria, moderate input length, some judgment): pick the **mini**-tier model (good balance of accuracy and cost).
   - **Complex** (multi-dimensional criteria, long inputs, nuanced subjective judgment, tone/style assessment): pick the **full flagship** model (highest accuracy).
3. **Present the recommendation** to the user with a brief justification, and confirm before proceeding. Include the model ID, pricing, and why it fits the eval's complexity.
4. **Use the chosen model** in all subsequent steps (prompt push, evaluator rule, creation script). Do NOT hardcode a model -- always use the one selected in this step.

### Workflow branching

After Step 2, the workflow diverges based on the eval scope chosen in Step 1:

| Step | General | Specific |
|---|---|---|
| Step 3: Push prompt to hub | **Yes** | Skip |
| Step 4: Create evaluator rule | **Yes** | Skip |
| Step 5: Save creation script | **Yes** | Skip |
| Step 6: Generate eval runner test | Yes (pulls prompt from hub) | Yes (prompt defined inline) |

If the scope is **specific**, skip directly to Step 6 after Step 2.

## Step 3: Push a StructuredPrompt to the LangSmith hub *(general only)*

> **Skip this step if the eval scope is `specific`.**

Use the Python SDK. The TypeScript SDK fails with StructuredPrompt ("Manifest must have an id field").

Prompt naming convention: `eval_content_writer_agent_<name_in_snake_case>`.

Run this via `python3 -c "..."` in the shell:

```python
OPENAI_API_KEY=placeholder python3 -c "
from langsmith import Client
from langchain_core.prompts.structured import StructuredPrompt
from langchain_openai import ChatOpenAI

client = Client()

schema = {
    'title': '<SchemaTitle>',
    'type': 'object',
    'strict': True,
    'properties': {
        'reasoning': {
            'type': 'string',
            'description': 'Step-by-step reasoning justifying the verdict before deciding true or false.'
        },
        '<feedback_key>': {
            'type': 'boolean',
            'description': '<what true/false means>'
        }
    },
    'required': ['reasoning', '<feedback_key>']
}

prompt = StructuredPrompt.from_messages_and_schema(
    [
        ('system', '''<system prompt with evaluation criteria>'''),
        ('human', '''Please grade the following example according to the above criteria.

## Examples

<include 1-3 concise examples from real dataset entries showing pass/fail verdicts>

## Instructions

{instructions}

## Content to review with inline changes

{output}''')
    ],
    schema=schema,
)

model = ChatOpenAI(model='<chosen_model>', temperature=0)
chain = prompt | model

url = client.push_prompt('<prompt_name>', object=chain, is_public=False)
print(f'Prompt pushed: {url}')
"
```

Key details:
- Always include a `reasoning` string field in the schema **before** the feedback key. This enables the evaluator to explain its verdict. The `reasoning` field must be listed first in both `properties` and `required` so the model generates its justification before the boolean verdict.
- In the evaluator rule (Step 4), set `"include_reasoning": true` in the `structured` config to surface the reasoning in the LangSmith UI.
- Add few-shot examples to the human message between the criteria reference and the actual input. Use 1-3 short, representative snippets from the dataset showing clear pass/fail verdicts with a one-line explanation. Pull candidates with `python3 -c "..."` from `/tmp/content-writer-agent-dataset.json` (export with `langsmith dataset read "content-writer-agent" > /tmp/content-writer-agent-dataset.json` if needed).
- Push as `prompt | model` chain -- required for rule API validation to pass.
- `OPENAI_API_KEY=placeholder` is fine; the real key is injected by LangSmith at runtime.
- Template uses f-string format with single curly braces (`{var}`). Do NOT use double curly braces (`{{var}}`) -- those are treated as escaped literals.
- Verify the push succeeds before proceeding.

## Step 4: Create the evaluator rule via the API *(general only)*

> **Skip this step if the eval scope is `specific`.**

```bash
curl -s -X POST "https://api.smith.langchain.com/api/v1/runs/rules" \
  -H "x-api-key: $LANGSMITH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "display_name": "<evaluator-display-name>",
    "dataset_id": "c784905c-2974-4e56-811b-d871039b65ee",
    "sampling_rate": 1.0,
    "filter": "eq(is_root, true)",
    "evaluators": [
      {
        "structured": {
          "hub_ref": "<prompt_name>:latest",
          "variable_mapping": {
            "instructions": "input.messages",
            "output": "output.xmlDiffTextContent"
          },
          "include_reasoning": true,
          "model": {
            "lc": 1,
            "type": "constructor",
            "id": ["langchain", "chat_models", "openai", "ChatOpenAI"],
            "kwargs": {
              "model": "<chosen_model>",
              "temperature": 0,
              "openai_api_key": {
                "lc": 1,
                "type": "secret",
                "id": ["OPENAI_API_KEY"]
              }
            }
          }
        }
      }
    ]
  }'
```

The `model` block is required for validation even though the response returns `model: null`.

Verify with: `langsmith evaluator list --format json | python3 -c "import json,sys; [print(e['name']) for e in json.load(sys.stdin) if e.get('dataset_id')=='c784905c-2974-4e56-811b-d871039b65ee']"`

## Step 5: Save the creation script *(general only)*

> **Skip this step if the eval scope is `specific`.**

Create an idempotent TypeScript script next to this skill, at `create<EvalName>Eval.ts` (in this skill directory), following the pattern in `createFormattingRichTextQualityEval.ts`. The script should:

- Check if the evaluator already exists before creating.
- Include the `reasoning` string field in the prompt schema (before the feedback key) and set `"include_reasoning": true` in the evaluator rule.
- Use `fetch` against the LangSmith API (no SDK needed for the rule).
- Be runnable with `npx tsx <script>`.

## Step 6: Generate eval runner test

Create a Vitest test file at `agents/src/contentWriterAgent/evals/run<EvalName>Eval.test.ts` that runs a LangSmith experiment: it re-runs the `contentWriterAgent` on dataset examples (filtered by splits), scores each run with the evaluator, and asserts the pass rate exceeds the threshold.

Create the `agents/src/contentWriterAgent/evals/` directory if it does not already exist.

### Variable mapping for the evaluator function

Map dataset fields to prompt variables inside the evaluator function. Use the variable mapping table from Step 1. The `inputs` object contains the dataset example's input fields, and the `outputs` object contains the agent's output fields.

| Prompt variable | Evaluator function source |
|---|---|
| `instructions` | `inputs.messages` |
| `output` | `outputs.xmlDiffTextContent` |
| `customType` | `inputs.customType` |
| `inputDocument` | `inputs.inputDocumentContent` |
| `appliedChanges` | `outputs.appliedChanges` |
| `sliceConfig` | `inputs.resolvedSliceConfig` |
| `outputDocument` | `outputs.outputDocumentContent` |
| `todos` | `outputs.todos` |

Only include variables that this evaluator actually uses (as determined in Step 1).

### Template: general scope (prompt pulled from hub)

Use this template when the eval scope is **general**. The judge chain is loaded from the LangSmith hub (pushed in Step 3).

```typescript
import { Client } from "langsmith"
import { evaluate } from "langsmith/evaluation"
import type { EvaluationResult } from "langsmith/evaluation"
import * as hub from "langchain/hub"
import type { Runnable } from "@langchain/core/runnables"
import { describe, expect, it } from "vitest"

const EXPERIMENTAL = process.env["EXPERIMENTAL"] === "true"

const DATASET_NAME = "content-writer-agent"
const PROMPT_NAME = "<prompt_name>"
const FEEDBACK_KEY = "<feedback_key>"
const SPLITS: string[] = [<splits>]
const PASS_RATE_THRESHOLD = <threshold>

const describeBlock = EXPERIMENTAL ? describe : describe.skip
describeBlock("eval: <display-name>", () => {
	if (!EXPERIMENTAL) {
		return
	}

	it(
		`should pass on at least ${PASS_RATE_THRESHOLD * 100}% of dataset examples`,
		{ timeout: 900000 },
		async () => {
			const client = new Client()

			// Load the evaluator prompt+model chain from the hub
			const judgeChain = await hub.pull<Runnable>(PROMPT_NAME, {
				includeModel: true,
			})

			// Target: run the contentWriterAgent via LangGraph server
			const target = async (
				inputs: Record<string, unknown>,
			): Promise<Record<string, unknown>> => {
				const thread = await client.createThread()
				const run = await client.runs.create(thread.thread_id, {
					assistantId: "contentWriterAgent",
					input: inputs,
					config: {
						recursionLimit: 100,
					},
				})
				await client.runs.join(thread.thread_id, run.run_id)
				const state = await client.threads.getState(thread.thread_id)
				return state.values as Record<string, unknown>
			}

			// Evaluator: invoke the judge chain on the agent's output
			const evaluator = async ({
				inputs,
				outputs,
			}: {
				inputs: Record<string, unknown>
				outputs: Record<string, unknown>
			}): Promise<EvaluationResult> => {
				const result = await judgeChain.invoke({
					// Map dataset fields to prompt variables (only include
					// the variables this evaluator needs from Step 1)
					<variable_mapping>
				})

				return {
					key: FEEDBACK_KEY,
					score: result[FEEDBACK_KEY] === true,
					comment: result.reasoning,
				}
			}

			// Run the experiment filtered by splits
			const data =
				SPLITS.length > 0
					? client.listExamples({
							datasetName: DATASET_NAME,
							splits: SPLITS,
						})
					: DATASET_NAME

			const experimentResults = await evaluate(target, {
				data,
				evaluators: [evaluator],
				experimentPrefix: `eval-${FEEDBACK_KEY}`,
				maxConcurrency: 2,
				client,
			})

			// Assert pass rate
			const scores = experimentResults.results.map(
				(r) =>
					r.evaluationResults.results.find(
						(er) => er.key === FEEDBACK_KEY,
					)?.score,
			)
			const passed = scores.filter((s) => s === true).length
			const total = scores.length
			const passRate = passed / total

			expect(total).toBeGreaterThan(0)
			expect(
				passRate,
				`Pass rate ${passed}/${total} (${(passRate * 100).toFixed(1)}%) is below ${PASS_RATE_THRESHOLD * 100}% threshold`,
			).toBeGreaterThan(PASS_RATE_THRESHOLD)
		},
	)
})
```

### Template: specific scope (prompt defined inline)

Use this template when the eval scope is **specific**. The judge chain is constructed inline — no hub interaction, no dataset rule.

```typescript
import { Client } from "langsmith"
import { evaluate } from "langsmith/evaluation"
import type { EvaluationResult } from "langsmith/evaluation"
import { ChatOpenAI } from "@langchain/openai"
import { ChatPromptTemplate } from "@langchain/core/prompts"
import { z } from "zod"
import { describe, expect, it } from "vitest"

const EXPERIMENTAL = process.env["EXPERIMENTAL"] === "true"

const DATASET_NAME = "content-writer-agent"
const FEEDBACK_KEY = "<feedback_key>"
const SPLITS: string[] = [<splits>]
const PASS_RATE_THRESHOLD = <threshold>

const feedbackSchema = z.object({
	reasoning: z
		.string()
		.describe(
			"Step-by-step reasoning justifying the verdict before deciding true or false.",
		),
	<feedback_key>: z
		.boolean()
		.describe("<what true/false means>"),
})

const judgeChain = ChatPromptTemplate.fromMessages([
	[
		"system",
		`<system prompt with evaluation criteria>`,
	],
	[
		"human",
		`Please grade the following example according to the above criteria.

## Instructions

{instructions}

## Content to review with inline changes

{output}`,
	],
]).pipe(
	new ChatOpenAI({
		model: "<chosen_model>",
		temperature: 0,
	}).withStructuredOutput(feedbackSchema),
)

const describeBlock = EXPERIMENTAL ? describe : describe.skip
describeBlock("eval: <display-name>", () => {
	if (!EXPERIMENTAL) {
		return
	}

	it(
		`should pass on at least ${PASS_RATE_THRESHOLD * 100}% of dataset examples`,
		{ timeout: 900000 },
		async () => {
			const client = new Client()

			// Target: run the contentWriterAgent via LangGraph server
			const target = async (
				inputs: Record<string, unknown>,
			): Promise<Record<string, unknown>> => {
				const thread = await client.createThread()
				const run = await client.runs.create(thread.thread_id, {
					assistantId: "contentWriterAgent",
					input: inputs,
					config: {
						recursionLimit: 100,
					},
				})
				await client.runs.join(thread.thread_id, run.run_id)
				const state = await client.threads.getState(thread.thread_id)
				return state.values as Record<string, unknown>
			}

			// Evaluator: invoke the inline judge chain on the agent's output
			const evaluator = async ({
				inputs,
				outputs,
			}: {
				inputs: Record<string, unknown>
				outputs: Record<string, unknown>
			}): Promise<EvaluationResult> => {
				const result = await judgeChain.invoke({
					// Map dataset fields to prompt variables (only include
					// the variables this evaluator needs from Step 1)
					<variable_mapping>
				})

				return {
					key: FEEDBACK_KEY,
					score: result[FEEDBACK_KEY] === true,
					comment: result.reasoning,
				}
			}

			// Run the experiment filtered by splits
			const data =
				SPLITS.length > 0
					? client.listExamples({
							datasetName: DATASET_NAME,
							splits: SPLITS,
						})
					: DATASET_NAME

			const experimentResults = await evaluate(target, {
				data,
				evaluators: [evaluator],
				experimentPrefix: `eval-${FEEDBACK_KEY}`,
				maxConcurrency: 2,
				client,
			})

			// Assert pass rate
			const scores = experimentResults.results.map(
				(r) =>
					r.evaluationResults.results.find(
						(er) => er.key === FEEDBACK_KEY,
					)?.score,
			)
			const passed = scores.filter((s) => s === true).length
			const total = scores.length
			const passRate = passed / total

			expect(total).toBeGreaterThan(0)
			expect(
				passRate,
				`Pass rate ${passed}/${total} (${(passRate * 100).toFixed(1)}%) is below ${PASS_RATE_THRESHOLD * 100}% threshold`,
			).toBeGreaterThan(PASS_RATE_THRESHOLD)
		},
	)
})
```

Key differences from the general template:
- No `langchain/hub` import -- prompt is defined inline with `ChatPromptTemplate`.
- Schema uses `zod` (already a project dependency) instead of a raw JSON schema object.
- The `ChatOpenAI` model and `withStructuredOutput` are configured directly.
- Few-shot examples can be included in the human message template if needed.
- The system prompt and human message template are written inline -- fill them with the criteria from Step 1.

### Placeholder substitution reference

| Placeholder | Source | General | Specific |
|---|---|---|---|
| `<prompt_name>` | Prompt name from Step 3 | Yes | Not used |
| `<feedback_key>` | Feedback key from Step 1 | Yes | Yes |
| `<display-name>` | Display name from Step 1 | Yes | Yes |
| `<splits>` | Dataset splits from Step 1 as quoted strings | Yes | Yes |
| `<threshold>` | Pass rate threshold from Step 1 (e.g. `0.9`) | Yes | Yes |
| `<variable_mapping>` | Key-value pairs mapping prompt variables to `inputs`/`outputs` fields | Yes | Yes |
| `<chosen_model>` | Model from Step 2 | Not used (baked into hub prompt) | Yes |
| `<system prompt ...>` | Evaluation criteria from Step 1 | Not used (baked into hub prompt) | Yes |

### Key conventions

- **Framework**: Vitest -- matches existing tests in `agents/src/contentWriterAgent/tests/`.
- **Gating**: `EXPERIMENTAL` env var with `describe.skip` -- exact pattern from `testUtils.ts`.
- **Timeout**: 900000ms (15 min) -- agent re-run + LLM judge per example.
- **Concurrency**: `maxConcurrency: 2` -- avoids overwhelming the LangGraph server.
- **Tab indentation** -- matches existing codebase style.

## Existing evaluators on the dataset

- `no-unresolved-placeholders`
- `bullet_points_in_hero_section`
- `instruction_met`
- `formatting-rich-text-quality`
