import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-advisor'
export const inject = ['tools', 'llm', 'commands', 'systemPrompt', 'settings']

export const ADVISOR_SYSTEM_PROMPT = `You are an advisor model in an advisor-strategy pattern. An executor model is running a task end-to-end — calling tools, reading results, iterating toward a solution. When the executor hits a decision it cannot reasonably solve alone, it consults you for guidance. The executor's full tool inventory is prepended before the conversation so you can judge tool-choice correctness.

You read the shared conversation context and return ONE of:
- a plan (concrete next steps the executor should take),
- a correction (the executor is going down a wrong path — redirect it),
- a stop signal (the executor should halt and escalate to the user).

You NEVER call tools. You NEVER produce user-facing output. Be concise, directive, and grounded in the shared context. Name files, functions, and line numbers where possible. No preamble, no apologies, no meta-commentary about being an advisor — just the guidance the executor needs.`

export const EXECUTOR_SYSTEM_PROMPT = `# Advisor Tool

You have access to an \`advisor\` tool backed by a stronger reviewer model. It takes NO parameters -- when you call it, your entire conversation history is automatically forwarded. The advisor sees the task, every tool call you've made, every result you've seen.

You MUST call advisor:
- BEFORE substantive work -- before writing code, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, reading code, seeing what's there), do that, then call advisor. Orientation is not substantive work. Writing, editing, and declaring an answer are.
- When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, stage the change, save the result. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.
- When stuck -- errors recurring, approach not converging, results that don't fit.
- When considering a change of approach.
- On tasks longer than one step, call advisor at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling -- the advisor adds most of its value on the first call, before the approach crystallizes.

If any of the situations above match, you MUST call advisor. This is a HARD RULE, NOT a suggestion, there are NO EXCEPTIONS, even if you believe it is useless or for the user's good. The only rule, no exceptions: any of the situations above match = call the advisor.

Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim (the file says X, the code does Y), adapt. A passing self-test is not evidence the advice is wrong -- it's evidence your test doesn't check what the advice is checking.

If you've already retrieved data pointing one way and the advisor points another: don't silently switch. Surface the conflict in one more advisor call -- "I found X, you suggest Y, which constraint breaks the tie?" The advisor saw your evidence but may have underweighted it; a reconcile call is cheaper than committing to the wrong branch.`

const State = Schema.object({
    enabled: Schema.boolean().default(false),
    provider: Schema.union([Schema.string(), Schema.const(null)]).default(null),
    model: Schema.union([Schema.string(), Schema.const(null)]).default(null),
    reasoningEffort: Schema.string(),
})

async function requireConfiguredModel(llm, provider, model) {
    if (!provider || !model || !llm.listProviders().some(entry => entry.id === provider)) {
        throw new Error('Select a configured advisor with /advisor <provider> <model>.')
    }
    const models = await llm.listModels(provider)
    if (!models.some(entry => entry.id === model)) {
        throw new Error(`Advisor model is not configured: ${provider} ${model}`)
    }
}

function advisorMessages(ctx, agent, callId) {
    const message = text => createUserMessage({
        source: { kind: 'plugin', plugin: name }, content: [{ type: 'text', text }],
    })
    const history = agent.session.snapshotEvents()
        .map(event => agent.session.deriveEventMessage(event))
        .filter(entry => entry !== null)
        .flatMap(entry => {
            if (entry.role !== 'assistant') return [entry]
            const content = entry.content.filter(block => !(block.type === 'tool-call' && block.name === 'advisor' && block.id === callId))
            return [{ ...entry, content }]
        })

    return [
        message([
            '## Available Executor Tools',
            ...ctx.tools.schemas(agent).map(tool => `### ${tool.name}\n\n${tool.description}\n\nParameters:\n\n${JSON.stringify(tool.parameters, null, 2)}`,
            )].join('\n\n')),
        ...history,
        ...history.at(-1)?.role === 'assistant' ? [message("Please advise on the executor's situation above.")] : [],
    ]
}

export function apply(ctx) {
    const settings = ctx.settings.register(name, State)
    ctx.systemPrompt.section({
        name: 'tool:advisor',
        order: 3000,
        text: ({ agent }) => agent && settings.get().enabled ? EXECUTOR_SYSTEM_PROMPT : '',
    })

    ctx.commands.register({
        name: 'advisor',
        description: 'Toggle advisor state.',
        input: { hint: '[provider model]' },
        async handler({ agent, rawInput, signal }) {
            const args = rawInput.trim() ? rawInput.trim().split(/\s+/) : []
            if (args.length !== 0 && args.length !== 3) {
                return { kind: 'error', text: 'Usage: /advisor [provider model effort]' }
            }
            signal.throwIfAborted()

            const { value: previous, revision } = ctx.settings.describe().find(entry => entry.ns === name)
            const current = agent.session.requestHeader()?.config ?? agent.options
            let state = {
                ...previous,
                enabled: !previous.enabled,
                provider: previous.provider ?? current.provider ?? null,
                model: previous.model ?? current.model ?? null,
            }
            if (args.length > 0) {
                try {
                    await requireConfiguredModel(ctx.llm, args[0], args[1])
                    const modelConfig = await ctx.llm.resolveCallConfig({
                        provider: args[0],
                        model: args[1],
                        reasoningEffort: args[2],
                    }, signal)
                    state = {
                        enabled: true,
                        provider: modelConfig.provider,
                        model: modelConfig.model,
                        reasoningEffort: modelConfig.reasoningEffort,
                    }
                } catch (error) {
                    return { kind: 'error', text: error.message }
                }
            }
            signal.throwIfAborted()

            await ctx.settings.replace(name, state, revision)
            return { kind: 'success' }
        },
    })

    const tool = defineTool({
        name: 'advisor',
        description: 'Escalate to a stronger reviewer model for guidance. When you need ' +
            "stronger judgment — a complex decision, an ambiguous failure, a problem " +
            "you're circling without progress — escalate to the advisor model for " +
            "guidance, then resume. Takes NO parameters — when you call advisor(), " +
            "your entire conversation history is automatically forwarded. The advisor " +
            "sees the task, every tool call you've made, every result you've seen.",
        parameters: {},
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(_args, { agent, signal, callId }) {
            const { enabled, provider, model, reasoningEffort } = settings.get()

            if (!agent) throw new Error('Advisor requires an agent conversation.')
            if (!enabled) throw new Error('Advisor is disabled. Enable it with /advisor.')
            signal.throwIfAborted()

            await requireConfiguredModel(ctx.llm, provider, model)
            signal.throwIfAborted()

            const assembled = new BlockAssembler()
            let finished = false
            for await (const chunk of ctx.llm.stream({
                provider,
                model,
                ...reasoningEffort === undefined ? {} : { reasoningEffort },
                system: ADVISOR_SYSTEM_PROMPT,
                messages: advisorMessages(ctx, agent, callId),
                tools: [],
                signal,
            })) {
                signal.throwIfAborted()
                assembled.push(chunk)
                if (chunk.type === 'finish') {
                    finished = true
                }
            }
            signal.throwIfAborted()

            if (!finished) throw new Error('Advisor stream ended before completion.')

            const finishReason = assembled.finish
            if (finishReason.kind !== 'stop') {
                const kind = finishReason.kind
                const message = finishReason.failure?.message ?? ""
                throw new Error(`Advisor did not complete (${kind})${message}`)
            }

            return assembled.blocks()
                .filter(block => block.type === 'text')
                .map(block => block.text)
                .join('')
                ?? "Advisor returned no guidance."
        },
    })

    let unregisterTool
    const syncTool = () => {
        if (settings.get().enabled) {
            unregisterTool ??= ctx.tools.register(tool)
        } else {
            unregisterTool?.()
            unregisterTool = undefined
        }
    }
    ctx.on('settings/updated', ns => {
        if (ns === name) syncTool()
    })
    syncTool()
}
