const loads = new Map();

function loadElement(tagName, path) {
    if (loads.has(path)) return loads.get(path);
    const promise = new Promise((resolve, reject) => {
        const element = document.createElement(tagName);
        if (tagName === 'script') {
            element.src = path;
            element.async = true;
        } else {
            element.rel = 'stylesheet';
            element.href = path;
        }
        element.onload = () => resolve(element);
        element.onerror = () => {
            element.remove();
            reject(new Error(`Failed to load ${path}`));
        };
        document.head.appendChild(element);
    }).catch(error => {
        loads.delete(path);
        throw error;
    });
    loads.set(path, promise);
    return promise;
}

function loadScript(path, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    return loadElement('script', path).then(() => {
        if (!window[globalName]) throw new Error(`${globalName} did not initialize`);
        return window[globalName];
    });
}

export function loadStyle(path) {
    return loadElement('link', path);
}

export async function loadEasyMDE() {
    const [, , EasyMDE] = await Promise.all([
        loadStyle('src/vendor/easymde.min.css'),
        loadStyle('src/vendor/font-awesome/easymde-icons.css'),
        loadScript('src/vendor/easymde.min.js', 'EasyMDE'),
    ]);
    await document.fonts?.load('14px FontAwesome');
    return EasyMDE;
}

export function loadIro() {
    return loadScript('src/vendor/iro.min.js', 'iro');
}
