export function createLatestTaskRunner(run, onError) {
    let active = false;
    let latest = null;
    let disposed = false;
    let idle = Promise.resolve();
    let resolveIdle = null;

    const drain = async (first) => {
        active = true;
        let current = first;
        while (current && !disposed) {
            latest = null;
            try {
                await run(current);
            } catch (error) {
                onError(error);
            }
            current = latest;
        }
        active = false;
        resolveIdle?.();
        resolveIdle = null;
    };

    const enqueue = (task) => {
        if (disposed) return;
        if (active) {
            latest = task;
            return;
        }
        idle = new Promise(resolve => { resolveIdle = resolve; });
        void drain(task);
    };
    enqueue.dispose = () => {
        disposed = true;
        latest = null;
        return idle;
    };
    return enqueue;
}
