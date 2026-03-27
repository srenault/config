import { execFileSync } from "node:child_process"

const DATASET_ID = "c784905c-2974-4e56-811b-d871039b65ee"
const DISPLAY_NAME = "formatting-rich-text-quality"
const FEEDBACK_KEY = "formatting_rich_text_quality"
const PROMPT_NAME = "eval_content_writer_agent_formatting_rich_text_quality"
const API_BASE_URL =
	process.env.LANGSMITH_BASE_URL ?? "https://api.smith.langchain.com"

function requireEnv(name: string): string {
	const value = process.env[name]
	if (!value) {
		throw new Error(`${name} is required`)
	}

	return value
}

function runCommand(command: string, args: string[], env?: NodeJS.ProcessEnv): string {
	return execFileSync(command, args, {
		encoding: "utf8",
		env: { ...process.env, ...env },
	})
}

function listEvaluators(): Array<{ name?: string; dataset_id?: string }> {
	const output = runCommand("langsmith", ["evaluator", "list", "--format", "json"])
	return JSON.parse(output) as Array<{ name?: string; dataset_id?: string }>
}

function pushPrompt(): string {
	const pythonScript = `
from langsmith import Client
from langchain_core.prompts.structured import StructuredPrompt
from langchain_openai import ChatOpenAI

client = Client()

schema = {
    "title": "FormattingRichTextQuality",
    "type": "object",
    "strict": True,
    "properties": {
        "${FEEDBACK_KEY}": {
            "type": "boolean",
            "description": "True when the content changes preserve or improve rich text formatting quality and follow the user's instructions."
        }
    },
    "required": ["${FEEDBACK_KEY}"]
}

system_prompt = """You are grading the formatting quality of content-writer-agent output.

Return true only when the XML diff shows that the changes follow the user's instructions and preserve or improve rich text formatting quality.

Pass criteria:
- The edited content matches the intent of the instructions.
- Headings remain headings when the change clearly targets a heading.
- Bold, italic, links, and other inline formatting are preserved when they should remain, or are introduced only when appropriate.
- The resulting diff looks editorially coherent and does not downgrade structured rich text into plain paragraphs without justification.

Fail criteria:
- The diff ignores or contradicts the instructions.
- A heading is flattened into a paragraph or otherwise loses its intended hierarchy.
- Meaningful emphasis, spans, or links are removed or corrupted without a good reason.
- The diff introduces awkward formatting regressions or clearly broken rich text structure.

Judge only what is visible in the instructions and XML diff."""

human_prompt = """Please grade the following example according to the above criteria.

## Examples

Example 1
Instructions: Update the hero title to emphasize enterprise teams while keeping the heading structure intact.
Diff: The hero heading text changes and remains a heading node.
Verdict: true because the requested content changed and the heading structure was preserved.

Example 2
Instructions: Refresh the section heading copy.
Diff: The heading content is rewritten, but the rich text block becomes a paragraph.
Verdict: false because the requested content changed but the heading formatting regressed.

## Instructions

{instructions}

## Content to review with inline changes

{output}"""

prompt = StructuredPrompt.from_messages_and_schema(
    [
        ("system", system_prompt),
        ("human", human_prompt),
    ],
    schema=schema,
)

model = ChatOpenAI(model="gpt-4.1-mini", temperature=0)
chain = prompt | model

url = client.push_prompt("${PROMPT_NAME}", object=chain, is_public=False)
print(url)
`.trim()

	return runCommand("python3", ["-c", pythonScript], {
		OPENAI_API_KEY: "placeholder",
	}).trim()
}

async function createRule(langsmithApiKey: string) {
	const response = await fetch(`${API_BASE_URL}/api/v1/runs/rules`, {
		method: "POST",
		headers: {
			"x-api-key": langsmithApiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			display_name: DISPLAY_NAME,
			dataset_id: DATASET_ID,
			sampling_rate: 1.0,
			filter: "eq(is_root, true)",
			evaluators: [
				{
					structured: {
						hub_ref: `${PROMPT_NAME}:latest`,
						variable_mapping: {
							instructions: "input.messages",
							output: "output.xmlDiffTextContent",
						},
						model: {
							lc: 1,
							type: "constructor",
							id: ["langchain", "chat_models", "openai", "ChatOpenAI"],
							kwargs: {
								model: "gpt-4.1-mini",
								temperature: 0,
								openai_api_key: {
									lc: 1,
									type: "secret",
									id: ["OPENAI_API_KEY"],
								},
							},
						},
					},
				},
			],
		}),
	})

	if (!response.ok) {
		throw new Error(await response.text())
	}

	return response.json()
}

async function main() {
	const langsmithApiKey = requireEnv("LANGSMITH_API_KEY")
	const existingEvaluator = listEvaluators().find(
		(evaluator) =>
			evaluator.dataset_id === DATASET_ID && evaluator.name === DISPLAY_NAME,
	)

	if (existingEvaluator) {
		console.log(`Evaluator "${DISPLAY_NAME}" already exists.`)
		return
	}

	const promptUrl = pushPrompt()
	const rule = await createRule(langsmithApiKey)

	console.log(`Prompt pushed: ${promptUrl}`)
	console.log(`Evaluator created: ${DISPLAY_NAME}`)
	console.log(JSON.stringify(rule, null, 2))
}

await main()
