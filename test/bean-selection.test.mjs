import test from 'node:test';
import assert from 'node:assert/strict';
import { selectableBeans, selectableBatches, currentBeanContext } from '../src/modules/bean-selection.js';

test('bean selector excludes archived or malformed catalog entries', () => {
    assert.deepEqual(selectableBeans([{ id: 'b', name: 'Beans' }, { id: 'old', archived: true }, {}]), [{ id: 'b', name: 'Beans' }]);
    assert.deepEqual(selectableBatches([{ id: 'batch' }, { id: 'old', archived: true }, null]), [{ id: 'batch' }]);
});

test('current bean context is a partial workflow update', () => {
    assert.deepEqual(currentBeanContext({ id: 'bean', name: 'Lot', roaster: 'Roaster' }, { id: 'batch', roastDate: '2026-10-11' }), { beanBatchId: 'batch', coffeeName: 'Lot', coffeeRoaster: 'Roaster' });
    assert.equal(currentBeanContext(null, { id: 'batch' }), null);
});
