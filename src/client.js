// Harness loads browser plugins through its shared module registry. Writing the small bundle directly avoids a build step and reuses the host's React instance.
window.__ModuleLoader__.load({
    id: 'dsh-advisor',
    factory: require => {
        const { createElement: h, useEffect, useLayoutEffect, useState, useSyncExternalStore } = require('react')
        const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')

        function AdvisorPicker({ advisorStore, catalogStore, picker, load, select, available, locked, t }) {
            const advisor = useSyncExternalStore(advisorStore.subscribe, advisorStore.getSnapshot)
            const catalog = useSyncExternalStore(catalogStore.subscribe, catalogStore.getSnapshot)
            const ModelPicker = useSyncExternalStore(picker.subscribe, picker.getSnapshot)
            const [directory] = useState(() => createSnapshotStore({
                ...catalog,
                current: null,
                status: catalog.status === 'selecting' ? 'ready' : catalog.status,
            }))

            // Give the native picker its own selection/error state while sharing the provider catalog. Never call the executor directory's select().
            useLayoutEffect(() => {
                const pending = directory.getSnapshot().status === 'selecting'
                directory.set({
                    ...catalog,
                    status: catalog.status === 'selecting' ? 'ready' : catalog.status,
                    current: advisor?.provider && advisor.model ? {
                        provider: advisor.provider,
                        model: advisor.model,
                        ...advisor.reasoningEffort === undefined ? {} : { reasoningEffort: advisor.reasoningEffort },
                    } : null,
                    ...pending ? { status: 'selecting', error: null } : {},
                })
            }, [catalog, advisor, directory])
            useEffect(() => {
                if (advisor?.enabled && available) {
                    load()
                }
            }, [advisor?.enabled, available, load])

            if (!advisor?.enabled || !available || !ModelPicker) return null
            return h('div', { role: 'group', 'aria-label': 'Advisor model', style: { display: 'inline-flex', alignItems: 'center', minWidth: 0 } },
                h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-caption)', marginRight: 5, } }, 'Advisor:'),
                h(ModelPicker, {
                    available,
                    locked,
                    directory,
                    load,
                    t,
                    select: async selection => {
                        directory.update(draft => { draft.status = 'selecting'; draft.error = null })
                        try {
                            await select(selection)
                            directory.update(draft => { draft.status = 'ready' })
                            return true
                        } catch (error) {
                            directory.update(draft => { draft.status = 'error'; draft.error = error.message })
                            return false
                        }
                    },
                }),
            )
        }

        return {
            inject: ['slots', 'modelDirectories', 'remote', 'remote.settings', 'sessions', 'locale'],
            apply(ctx) {
                const advisorStore = createSnapshotStore(null)
                let generation = 0
                const loadAdvisor = async () => {
                    const request = ++generation
                    const result = await ctx.remote.settings.describe()

                    if (request !== generation) return
                    if (!result.ok) throw new Error(result.error.message)

                    advisorStore.set(result.value.namespaces.find(entry => entry.ns === 'dsh-advisor')?.value ?? null)
                }

                ctx.remote.$on('settings/document-updated', ns => {
                    if (ns === 'dsh-advisor') loadAdvisor()
                })
                ctx.on('connection/reset', () => {
                    advisorStore.set(null)
                    loadAdvisor()
                })
                ctx.effect(() => () => { generation++ })
                loadAdvisor()

                ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
                    {
                        name: 'conversation.input.left',
                        id: 'dsh-advisor',
                        locale: 'model',
                        inject: sessionId => {
                            const directory = ctx.modelDirectories.directoryFor(sessionId)
                            const available = ctx.sessions.subagentAddress(sessionId) === undefined
                            return {
                                advisorStore,
                                available,
                                catalogStore: directory.store,
                                picker: {
                                    subscribe: listener => ctx.slots.subscribe('conversation.input.model', listener),
                                    getSnapshot: () => ctx.slots.entriesOfSlot('conversation.input.model')[0]?.component ?? null,
                                },
                                load: () => {
                                    if (available) directory.load().catch(() => {})
                                },
                                select: async ({ provider, model, reasoningEffort }) => {
                                    const described = await ctx.remote.settings.describe()
                                    if (!described.ok) throw new Error(described.error.message)
                                    const advisor = described.value.namespaces.find(entry => entry.ns === 'dsh-advisor')
                                    if (!advisor) throw new Error('Advisor settings are unavailable.')

                                    const result = await ctx.remote.settings.replace('dsh-advisor', {
                                        enabled: true,
                                        provider,
                                        model,
                                        reasoningEffort,
                                    }, advisor.revision)

                                    if (!result.ok) throw new Error(result.error.message)
                                    await loadAdvisor()
                                },
                            }
                        },
                    },
                    props => h(AdvisorPicker, { ...props, key: props.sessionId })),
                )
            },
        }
    },
})
