/** No runtime invariant for the Scheduler client UI. */
export const name = 'ui-wh-scheduler-invariant'
export const inject = ['invariants']
export const apply = (): Promise<() => void> => Promise.resolve(() => {})
