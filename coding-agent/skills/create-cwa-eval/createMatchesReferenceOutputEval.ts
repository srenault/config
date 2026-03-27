import { execFileSync } from "node:child_process"

const DATASET_ID = "c784905c-2974-4e56-811b-d871039b65ee"
const DISPLAY_NAME = "matches-reference-output"
const FEEDBACK_KEY = "matches_reference_output"
const PROMPT_NAME = "eval_content_writer_agent_matches_reference_output"
const API_BASE_URL =
	process.env.LANGSMITH_BASE_URL ?? "https://api.smith.langchain.com"

function requireEnv(name: string): string {
	const value = process.env[name]
	if (!value) {
		throw new Error(`${name} is required`)
	}

	return value
}

function runCommand(
	command: string,
	args: string[],
	env?: NodeJS.ProcessEnv,
): string {
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
    "title": "MatchesReferenceOutput",
    "type": "object",
    "strict": True,
    "properties": {
        "${FEEDBACK_KEY}": {
            "type": "boolean",
            "description": "True when the new output matches the reference output in page structure and page content, allowing only minor formatting or whitespace differences."
        }
    },
    "required": ["${FEEDBACK_KEY}"]
}

system_prompt = """You are judging whether a new content-writer-agent output matches a known-good reference output.

Return true only when the new output is semantically equivalent to the reference output in both:
- page structure
- page content

Page structure includes:
- which sections or slices were changed
- whether content was added, removed, or reordered
- whether the same fields or regions of the page were updated

Page content includes:
- the actual wording and meaning of the changes
- whether the same information and intent are present

Accept minor whitespace, punctuation, or formatting differences when they do not change meaning or structure.

Return false when:
- different parts of the page are modified
- content is added or removed with no equivalent in the reference
- the structure of the page changes in a meaningful way
- the wording or meaning materially differs from the reference

Judge only from the reference output and the new output."""

human_prompt = """Compare the new output against the reference output and decide whether they match.

## Examples

Example 1
Reference output: The same hero and benefits fields are updated, with equivalent wording and the same overall page structure.
New output: The same hero and benefits fields are updated, with minor punctuation differences only.
Verdict: true because the structure and content are semantically equivalent.

Example 2
Reference output: The hero and FAQ sections are updated.
New output: The hero is updated, but the FAQ is missing and a testimonial section is added instead.
Verdict: false because the page structure and changed content do not match the reference.

## Reference output

{reference_output}

## New output

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
							output: "output.xmlDiffTextContent",
							reference_output: "reference.xmlDiffTextContent",
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

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
