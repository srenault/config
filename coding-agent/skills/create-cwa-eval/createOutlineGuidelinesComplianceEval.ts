import { execFileSync } from "node:child_process"

const DATASET_ID = "a485ef05-3d6f-4a34-9e6e-90d7d1250d0e"
const DISPLAY_NAME = "outline-guidelines-compliance"
const FEEDBACK_KEY = "outline_guidelines_compliance"
const PROMPT_NAME = "eval_content_writer_agent_outline_guidelines_compliance"
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
    "title": "OutlineGuidelinesCompliance",
    "type": "object",
    "strict": True,
    "properties": {
        "reasoning": {
            "type": "string",
            "description": "Step-by-step reasoning justifying the verdict before deciding true or false."
        },
        "${FEEDBACK_KEY}": {
            "type": "boolean",
            "description": "True when the generated page respects all content guidelines specified in the outline, or when no guidelines are specified."
        }
    },
    "required": ["reasoning", "${FEEDBACK_KEY}"]
}

system_prompt = """You are grading whether a content-writer-agent output respects the content guidelines specified in the outline (instructions).

Content guidelines include any explicit constraints mentioned in the outline such as:
- Tone of voice (e.g. professional, casual, friendly, authoritative)
- Text length (e.g. max 2 sentences per card, keep paragraphs short, 500 words per section)
- Style (e.g. use active voice, avoid jargon, write in second person)
- Target audience (e.g. developers, marketing managers, beginners)
- Keywords to incorporate (e.g. specific SEO keywords, product names)
- Formatting preferences (e.g. use bullet points, include CTAs, no exclamation marks)

Return true when:
- All content guidelines explicitly stated in the outline are respected in the generated output.
- Minor deviations are acceptable if the spirit of the guideline is met (e.g. slightly over or under a word count target, or 3 sentences instead of 2 when the content is concise).
- If no content guidelines are mentioned in the outline, this criterion is automatically satisfied -- return true.

Return false when:
- The tone of voice clearly violates what was requested (e.g. casual when professional was specified).
- Text length constraints are significantly exceeded or ignored.
- Specified keywords are absent from the output when they were explicitly required.
- Style or audience guidelines are clearly violated.

Focus only on content guidelines compliance. Do not judge structural ordering or content relevance -- only whether the guidelines (tone, length, style, keywords, audience, formatting) are respected.

Judge only from the instructions (outline) and the XML diff output."""

human_prompt = """Please grade the following example according to the above criteria.

## Examples

Example 1
Instructions: Write a product page with a casual, friendly tone. Keep paragraphs short (2-3 sentences max). Target audience: small business owners.
Output: The page uses a warm, conversational tone throughout ("You will love how easy this is"). Paragraphs are 2-3 sentences each. The content references small business challenges and workflows.
Verdict: true because the tone is casual and friendly, paragraph lengths are within the guideline, and the content addresses the target audience.

Example 2
Instructions: Create a landing page. Use a professional tone. Each feature card should be max 2 sentences. Incorporate the keywords "cloud migration" and "zero downtime" naturally.
Output: The page uses professional language. Feature cards have 5-6 sentences each. "Cloud migration" appears once but "zero downtime" is absent from the entire page.
Verdict: false because feature card length significantly exceeds the guideline (5-6 vs max 2 sentences) and a required keyword ("zero downtime") is missing.

Example 3
Instructions: Build a blog post about project management tools. No specific tone, length, or keyword guidelines mentioned.
Output: The page has a neutral professional tone with varying paragraph lengths.
Verdict: true because no content guidelines were specified in the outline, so this criterion is automatically satisfied.

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
