import { execFileSync } from "node:child_process"

const DATASET_ID = "a485ef05-3d6f-4a34-9e6e-90d7d1250d0e"
const DISPLAY_NAME = "outline-structure-adherence"
const FEEDBACK_KEY = "outline_structure_adherence"
const PROMPT_NAME = "eval_content_writer_agent_outline_structure_adherence"
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
    "title": "OutlineStructureAdherence",
    "type": "object",
    "strict": True,
    "properties": {
        "reasoning": {
            "type": "string",
            "description": "Step-by-step reasoning justifying the verdict before deciding true or false."
        },
        "${FEEDBACK_KEY}": {
            "type": "boolean",
            "description": "True when the generated page covers all sections from the outline in a logical order."
        }
    },
    "required": ["reasoning", "${FEEDBACK_KEY}"]
}

system_prompt = """You are grading whether a content-writer-agent output structurally adheres to the outline provided in the instructions.

Return true only when:
- The generated page covers every section or topic mentioned in the outline.
- Sections appear in a logical order consistent with the outline.
- Splitting a single outline section into multiple slices is acceptable. For example, if the outline says a section contains a paragraph followed by a comparison table, the agent may create two separate slices (one for the paragraph, one for the table). This is fine as long as the content is present and logically ordered.
- Merging distinct outline sections into one slice without losing content is also acceptable.

Return false when:
- An entire section or topic from the outline is missing from the output with no equivalent coverage elsewhere.
- The order of sections is significantly rearranged in a way that contradicts the outline without justification.
- The output introduces substantial new sections that displace or replace requested outline sections.

Focus only on structural presence and ordering. Do not judge the quality, relevance, or tone of the content itself -- only whether the outline structure is faithfully represented.

Judge only from the instructions (outline) and the XML diff output."""

human_prompt = """Please grade the following example according to the above criteria.

## Examples

Example 1
Instructions: Create a landing page with hero, three feature cards, pricing table, and FAQ section.
Output: The page has a hero slice, three feature card slices, a pricing table slice, and a FAQ slice in that order.
Verdict: true because all outline sections are present and in the expected order.

Example 2
Instructions: Build a blog post with introduction, three main sections (Benefits, Challenges, Best Practices), and a conclusion.
Output: The page has an introduction slice and a conclusion slice, but only two of the three main sections appear. The "Challenges" section is entirely missing.
Verdict: false because a required section from the outline is missing.

Example 3
Instructions: Create a page with a hero section containing a headline, subtitle, and comparison table.
Output: The page has a hero slice with the headline and subtitle, and a separate comparison table slice immediately after.
Verdict: true because the outline section was split into two slices but all content is present and logically ordered.

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

model = ChatOpenAI(model="gpt-5.4-mini", temperature=0)
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
						include_reasoning: true,
						model: {
							lc: 1,
							type: "constructor",
							id: ["langchain", "chat_models", "openai", "ChatOpenAI"],
							kwargs: {
								model: "gpt-5.4-mini",
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
