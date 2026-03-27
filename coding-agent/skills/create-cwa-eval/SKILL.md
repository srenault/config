---
name: create-cwa-eval
description: >-
  Create LLM-as-a-judge evaluators on the content-writer-agent LangSmith dataset.
  Pushes a StructuredPrompt to the hub and binds an evaluator rule to the dataset
  via the API. Use when the user asks to create, add, or set up a new LangSmith
  evaluator for the content writer agent.
---

# LangSmith Evaluator for Content Writer Agent

Workflow for creating an LLM-as-a-judge evaluator bound to the `content-writer-agent` dataset (`c784905c-2974-4e56-811b-d871039b65ee`).

Reference implementation: `createFormattingRichTextQualityEval.ts` (in this skill directory).

## Step 1: Design the evaluator

Gather from the user:

1. **Evaluator display name** -- kebab-case, no capitals, no spaces (e.g. `formatting-rich-text-quality`).
2. **What it checks** -- the evaluation criteria for the system prompt.
3. **Feedback key** -- single boolean, snake_case only, no whitespace or capitals (e.g. `formatting_rich_text_quality`).
4. **Variables needed** -- which dataset fields the prompt template uses.

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

## Step 3: Push a StructuredPrompt to the LangSmith hub

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

## Step 4: Create the evaluator rule via the API

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

## Step 5: Save the creation script

Create an idempotent TypeScript script next to this skill, at `create<EvalName>Eval.ts` (in this skill directory), following the pattern in `createFormattingRichTextQualityEval.ts`. The script should:

- Check if the evaluator already exists before creating.
- Include the `reasoning` string field in the prompt schema (before the feedback key) and set `"include_reasoning": true` in the evaluator rule.
- Use `fetch` against the LangSmith API (no SDK needed for the rule).
- Be runnable with `npx tsx <script>`.

## Existing evaluators on the dataset

- `no-unresolved-placeholders`
- `bullet_points_in_hero_section`
- `instruction_met`
- `formatting-rich-text-quality`
