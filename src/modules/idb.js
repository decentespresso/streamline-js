import { logger } from './logger.js';

const DB_NAME = 'shot_history';
const DB_VERSION = 9;
const SHOTS_STORE_NAME = 'shots';
const SHOT_SUMMARIES_STORE_NAME = 'shot_summaries';
const SETTINGS_STORE_NAME = 'settings';
const EMAILS_STORE_NAME = 'decent_emails';
const SUMMARY_SEED_SIZE = 20;
const SUMMARY_BACKFILL_SIZE = 100;

let db;
let openPromise = null;
let summaryBackfillNeeded = false;

function seedShotSummaries(shotsStore, summariesStore) {
    let count = 0;
    const request = shotsStore.index('by_timestamp').openCursor(null, 'prev');
    request.onsuccess = event => {
        const cursor = event.target.result;
        if (!cursor || count >= SUMMARY_SEED_SIZE) return;
        summariesStore.put(toShotSummary(cursor.value));
        count += 1;
        cursor.continue();
    };
}

function repairMissingSummarySeed() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([SHOTS_STORE_NAME, SHOT_SUMMARIES_STORE_NAME], 'readwrite');
        const shotsStore = transaction.objectStore(SHOTS_STORE_NAME);
        const summariesStore = transaction.objectStore(SHOT_SUMMARIES_STORE_NAME);
        let needed = false;
        let shotCount;
        let summaryCount;
        const repair = () => {
            if (shotCount === undefined || summaryCount === undefined) return;
            needed = summaryCount < shotCount;
            if (!needed || summaryCount > 0) return;
            const cursor = shotsStore.index('by_timestamp').openCursor(null, 'prev');
            let seeded = 0;
            cursor.onsuccess = event => {
                const current = event.target.result;
                if (!current || seeded >= SUMMARY_SEED_SIZE) return;
                summariesStore.put(toShotSummary(current.value));
                seeded += 1;
                current.continue();
            };
        };
        const shotsCountRequest = shotsStore.count();
        const summariesCountRequest = summariesStore.count();
        shotsCountRequest.onsuccess = () => { shotCount = shotsCountRequest.result; repair(); };
        summariesCountRequest.onsuccess = () => { summaryCount = summariesCountRequest.result; repair(); };
        transaction.oncomplete = () => resolve(needed);
        transaction.onerror = event => reject(event.target.error);
    });
}

function backfillShotSummaries(afterKey = null) {
    if (!db) return;
    const transaction = db.transaction([SHOTS_STORE_NAME, SHOT_SUMMARIES_STORE_NAME], 'readwrite');
    const shotsStore = transaction.objectStore(SHOTS_STORE_NAME);
    const summariesStore = transaction.objectStore(SHOT_SUMMARIES_STORE_NAME);
    const range = afterKey === null ? null : IDBKeyRange.lowerBound(afterKey, true);
    const request = shotsStore.openCursor(range);
    let count = 0;
    let lastKey = null;
    request.onsuccess = event => {
        const cursor = event.target.result;
        if (!cursor || count >= SUMMARY_BACKFILL_SIZE) return;
        summariesStore.put(toShotSummary(cursor.value));
        lastKey = cursor.key;
        count += 1;
        cursor.continue();
    };
    transaction.oncomplete = () => {
        if (count === SUMMARY_BACKFILL_SIZE) setTimeout(() => backfillShotSummaries(lastKey), 0);
    };
    transaction.onerror = event => logger.error('Error backfilling shot summaries:', event.target.error);
}

function scheduleSummaryBackfill() {
    requestAnimationFrame(() => requestAnimationFrame(() => backfillShotSummaries()));
}

export function openDB() {
    logger.debug('openDB called.');

    if (db) {
        logger.debug('DB already open, returning existing instance.');
        return Promise.resolve(db);
    }

    if (openPromise) {
        logger.debug('DB opening in progress, returning existing promise.');
        return openPromise;
    }

    logger.debug('No existing DB instance or open promise, creating new open promise.');
    openPromise = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) {
            logger.error('IndexedDB is not supported in this browser.');
            openPromise = null;
            return reject('IndexedDB not supported.');
        }

        logger.debug(`Requesting IndexedDB.open with name: ${DB_NAME}, version: ${DB_VERSION}`);
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onblocked = () => {
            // This event can happen if another tab has an older version of the DB open.
            logger.warn('IndexedDB open request is blocked. Please close other tabs with this app open.');
        };

        request.onerror = (event) => {
            logger.error('IndexedDB error:', event.target.error);
            openPromise = null; // Clear promise on error
            reject('Error opening IndexedDB.');
        };

        request.onsuccess = async (event) => {
            logger.debug('IndexedDB open request.onsuccess event fired.');
            db = event.target.result;

            // This is a good practice to handle cases where the DB is deleted
            // or schema is updated from another tab.
            db.onversionchange = () => {
                db.close();
                logger.warn("Database version change detected, closing connection. Please reload the page.");
                alert("A new version of the database is required. Please reload the page.");
            };

            logger.info('IndexedDB opened successfully.');
            if (!summaryBackfillNeeded) {
                summaryBackfillNeeded = await repairMissingSummarySeed().catch(error => {
                    logger.error('Error repairing shot summary seed:', error);
                    return false;
                });
            }
            openPromise = null; // Clear promise on success
            resolve(db);
            if (summaryBackfillNeeded) {
                summaryBackfillNeeded = false;
                scheduleSummaryBackfill();
            }
        };

        request.onupgradeneeded = (event) => {
            logger.debug('IndexedDB open request.onupgradeneeded event fired.');
            const tempDb = event.target.result;
            const upgradeTransaction = event.target.transaction;
            let shotsStore;
            if (!tempDb.objectStoreNames.contains(SHOTS_STORE_NAME)) {
                logger.info('Creating shots object store');
                shotsStore = tempDb.createObjectStore(SHOTS_STORE_NAME, { keyPath: 'id' });
            } else {
                shotsStore = upgradeTransaction.objectStore(SHOTS_STORE_NAME);
            }
            // Every shot record already carries `timestamp` -- index it so the
            // newest cached shot can be read with one indexed cursor instead of
            // getAllShots() (reads the whole store just to find the max).
            if (!shotsStore.indexNames.contains('by_timestamp')) {
                logger.info('Creating by_timestamp index on shots store');
                shotsStore.createIndex('by_timestamp', 'timestamp');
            }
            let shotSummariesStore;
            if (!tempDb.objectStoreNames.contains(SHOT_SUMMARIES_STORE_NAME)) {
                shotSummariesStore = tempDb.createObjectStore(SHOT_SUMMARIES_STORE_NAME, { keyPath: 'id' });
            } else {
                shotSummariesStore = upgradeTransaction.objectStore(SHOT_SUMMARIES_STORE_NAME);
            }
            if (!shotSummariesStore.indexNames.contains('by_timestamp')) {
                shotSummariesStore.createIndex('by_timestamp', 'timestamp');
            }
            if (event.oldVersion > 0 && event.oldVersion < 9) {
                seedShotSummaries(shotsStore, shotSummariesStore);
                summaryBackfillNeeded = true;
            }
            if (!tempDb.objectStoreNames.contains(SETTINGS_STORE_NAME)) {
                logger.info('Creating settings object store');
                tempDb.createObjectStore(SETTINGS_STORE_NAME, { keyPath: 'id' });
            }
            if (!tempDb.objectStoreNames.contains(EMAILS_STORE_NAME)) {
                logger.info('Creating decent_emails object store');
                tempDb.createObjectStore(EMAILS_STORE_NAME, { keyPath: 'emailid' });
            }
        };
    });
    return openPromise;
}

export function setSetting(key, value) {
    return new Promise((resolve, reject) => {
        if (!db) return reject('DB not open');
        const transaction = db.transaction([SETTINGS_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(SETTINGS_STORE_NAME);
        store.put({ id: key, value: value });
        transaction.oncomplete = () => resolve();
        transaction.onabort = (event) => {
            logger.error(`Error setting key "${key}" in IndexedDB:`, event.target.error);
            reject(`Error setting key "${key}"`);
        };
    });
}

export function getSetting(key) {
    return new Promise((resolve, reject) => {
        if (!db) return reject('DB not open');
        const transaction = db.transaction([SETTINGS_STORE_NAME], 'readonly');
        const store = transaction.objectStore(SETTINGS_STORE_NAME);
        const request = store.get(key);
        request.onsuccess = (event) => {
            resolve(event.target.result ? event.target.result.value : undefined);
        };
        request.onerror = (event) => {
            logger.error(`Error getting key "${key}" from IndexedDB:`, event.target.error);
            reject(`Error getting key "${key}"`);
        };
    });
}


export function addShot(shot) {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject('DB not open');
        }
        const transaction = db.transaction([SHOTS_STORE_NAME, SHOT_SUMMARIES_STORE_NAME], 'readwrite');
        transaction.objectStore(SHOTS_STORE_NAME).put(shot);
        transaction.objectStore(SHOT_SUMMARIES_STORE_NAME).put(toShotSummary(shot));

        transaction.oncomplete = () => {
            logger.info('Shot added to IndexedDB');
            resolve();
        };

        transaction.onabort = (event) => {
            logger.error('Error adding shot to IndexedDB:', event.target.error);
            reject('Error adding shot.');
        };
    });
}

// Bulk write, one transaction/commit for the whole page instead of one
// transaction per shot -- addShot() in a loop serializes N separate commits.
export function addShots(shotsArray) {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject('DB not open');
        }
        if (!shotsArray || shotsArray.length === 0) {
            return resolve();
        }
        const transaction = db.transaction([SHOT_SUMMARIES_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(SHOT_SUMMARIES_STORE_NAME);
        for (const shot of shotsArray) {
            store.put(toShotSummary(shot));
        }

        transaction.oncomplete = () => {
            logger.info(`${shotsArray.length} shots added to IndexedDB in one transaction`);
            resolve();
        };

        transaction.onerror = (event) => {
            logger.error('Error bulk-adding shots to IndexedDB:', event.target.error);
            reject('Error bulk-adding shots.');
        };
    });
}

function toShotSummary(shot) {
    const { measurements, ...summary } = shot;
    return summary;
}

function getShotSummaryPage(storeName, limit, offset) {
    return new Promise((resolve, reject) => {
        if (!db) return reject('DB not open');
        if (limit <= 0) return resolve([]);
        const transaction = db.transaction([storeName], 'readonly');
        const request = transaction.objectStore(storeName)
            .index('by_timestamp')
            .openCursor(null, 'prev');
        const summaries = [];
        let advanced = offset === 0;

        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (!cursor || summaries.length >= limit) return resolve(summaries);
            if (!advanced) {
                advanced = true;
                cursor.advance(offset);
                return;
            }
            summaries.push(storeName === SHOTS_STORE_NAME ? toShotSummary(cursor.value) : cursor.value);
            if (summaries.length >= limit) return resolve(summaries);
            cursor.continue();
        };
        request.onerror = (event) => {
            logger.error('Error getting latest shot summaries from IndexedDB:', event.target.error);
            reject('Error getting shot summaries.');
        };
    });
}

export function getLatestShotSummaries(limit, offset = 0) {
    return getShotSummaryPage(SHOT_SUMMARIES_STORE_NAME, limit, offset);
}

export function getLatestCachedShotSummaries(limit, offset = 0) {
    return getShotSummaryPage(SHOTS_STORE_NAME, limit, offset);
}

export function getShotSummaryCount() {
    return new Promise((resolve, reject) => {
        if (!db) return reject('DB not open');
        const request = db.transaction([SHOT_SUMMARIES_STORE_NAME], 'readonly')
            .objectStore(SHOT_SUMMARIES_STORE_NAME)
            .count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = (event) => reject(event.target.error);
    });
}

// Single most-recent cached shot via the by_timestamp index -- an indexed
// cursor, not a full-store read like getAllShots(). Used to paint the chart
// instantly on boot from whatever's already local, before the network fetch
// (which may reveal a newer shot) resolves.
export function getLatestCachedShot() {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject('DB not open');
        }
        const transaction = db.transaction([SHOTS_STORE_NAME], 'readonly');
        const store = transaction.objectStore(SHOTS_STORE_NAME);
        const cursorRequest = store.index('by_timestamp').openCursor(null, 'prev');

        cursorRequest.onsuccess = (event) => {
            const cursor = event.target.result;
            resolve(cursor ? cursor.value : null);
        };

        cursorRequest.onerror = (event) => {
            logger.error('Error getting latest cached shot from IndexedDB:', event.target.error);
            reject('Error getting latest cached shot.');
        };
    });
}

export function getAllShots() {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject('DB not open');
        }
        const transaction = db.transaction([SHOTS_STORE_NAME], 'readonly');
        const store = transaction.objectStore(SHOTS_STORE_NAME);
        const request = store.getAll();

        request.onsuccess = (event) => {
            resolve(event.target.result);
            logger.info("getAllShots success")
        };

        request.onerror = (event) => {
            logger.error('Error getting all shots from IndexedDB:', event.target.error);
            reject('Error getting shots.');
        };
    });
}

export function getLatestShotTimestamp() {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject('DB not open');
        }
        const transaction = db.transaction([SHOTS_STORE_NAME], 'readonly');
        const store = transaction.objectStore(SHOTS_STORE_NAME);
        const cursorRequest = store.openCursor(null, 'prev');

        let latestTimestamp = 0;

        cursorRequest.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                latestTimestamp = cursor.value.timestamp;
                resolve(latestTimestamp);
            } else {
                resolve(null); // No shots in the database
            }
        };

        cursorRequest.onerror = (event) => {
            logger.error('Error getting latest shot timestamp:', event.target.error);
            reject('Error getting latest shot timestamp.');
        };
    });
}

export function getShot(id) {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject('DB not open');
        }
        const transaction = db.transaction([SHOTS_STORE_NAME], 'readonly');
        const store = transaction.objectStore(SHOTS_STORE_NAME);
        const request = store.get(id);

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onerror = (event) => {
            logger.error('Error getting shot from IndexedDB:', event.target.error);
            reject('Error getting shot.');
        };
    });
}

export function deleteShot(id) {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject('DB not open');
        }
        const transaction = db.transaction([SHOTS_STORE_NAME, SHOT_SUMMARIES_STORE_NAME], 'readwrite');
        transaction.objectStore(SHOTS_STORE_NAME).delete(id);
        transaction.objectStore(SHOT_SUMMARIES_STORE_NAME).delete(id);

        transaction.oncomplete = () => {
            logger.info('Shot deleted from IndexedDB');
            resolve();
        };

        transaction.onabort = (event) => {
            logger.error('Error deleting shot from IndexedDB:', event.target.error);
            reject('Error deleting shot.');
        };
    });
}

export function clearShots() {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject('DB not open');
        }
        const transaction = db.transaction([SHOTS_STORE_NAME, SHOT_SUMMARIES_STORE_NAME], 'readwrite');
        transaction.objectStore(SHOTS_STORE_NAME).clear();
        transaction.objectStore(SHOT_SUMMARIES_STORE_NAME).clear();

        transaction.oncomplete = () => {
            logger.info('Shot history cleared from IndexedDB');
            resolve();
        };

        transaction.onabort = (event) => {
            logger.error('Error clearing shot history from IndexedDB:', event.target.error);
            reject('Error clearing shot history.');
        };
    });
}

export function addEmails(emails) {
    return new Promise((resolve, reject) => {
        if (!db) return reject('DB not open');
        const transaction = db.transaction([EMAILS_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(EMAILS_STORE_NAME);
        emails.forEach(email => store.put(email));
        transaction.oncomplete = () => resolve();
        transaction.onerror = (event) => reject(event.target.error);
    });
}

export function getAllEmails() {
    return new Promise((resolve, reject) => {
        if (!db) return reject('DB not open');
        const transaction = db.transaction([EMAILS_STORE_NAME], 'readonly');
        const store = transaction.objectStore(EMAILS_STORE_NAME);
        const request = store.getAll();
        request.onsuccess = (event) => {
            const emails = event.target.result || [];
            emails.sort((a, b) => (a.now || 0) - (b.now || 0));
            resolve(emails);
        };
        request.onerror = (event) => reject(event.target.error);
    });
}

export function getLatestEmailTimestamp() {
    return new Promise((resolve, reject) => {
        if (!db) return reject('DB not open');
        const transaction = db.transaction([EMAILS_STORE_NAME], 'readonly');
        const store = transaction.objectStore(EMAILS_STORE_NAME);
        const request = store.getAll();
        request.onsuccess = (event) => {
            const emails = event.target.result || [];
            if (!emails.length) return resolve(null);
            resolve(Math.max(...emails.map(e => e.now || 0)));
        };
        request.onerror = (event) => reject(event.target.error);
    });
}
