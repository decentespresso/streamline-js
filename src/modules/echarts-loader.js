let echartsPromise;

export function loadECharts() {
    if (window.echarts) return Promise.resolve(window.echarts);
    if (!echartsPromise) {
        echartsPromise = new Promise(resolve => requestAnimationFrame(resolve))
            .then(() => import('./echarts-streamline.min.js'))
            .then(({ echarts }) => echarts)
            .catch(error => {
                echartsPromise = null;
                throw error;
            });
    }
    return echartsPromise;
}
