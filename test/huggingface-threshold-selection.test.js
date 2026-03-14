const assert = require('assert');

const { UploadService } = require('../server/lib/services/upload-service');

describe('HuggingFace threshold selection', function () {
  it('switches to the next enabled HuggingFace config when the first exceeds threshold', async function () {
    const configs = [
      { id: 'hf-a', type: 'huggingface', updatedAt: 1, config: {} },
      { id: 'hf-b', type: 'huggingface', updatedAt: 2, config: {} },
    ];

    const storageRepo = {
      async findEnabledByType(type) {
        assert.strictEqual(type, 'huggingface');
        return configs;
      },
      async resolveStorageSelection() {
        throw new Error('resolveStorageSelection should not be called when a threshold candidate exists');
      },
    };

    const storageFactory = {
      createAdapter(config) {
        return {
          async getCapacityInfo() {
            return {
              withinThreshold: config.id === 'hf-b',
            };
          },
        };
      },
    };

    const service = new UploadService({
      storageRepo,
      fileRepo: {},
      storageFactory,
    });

    const selected = await service.resolveStorage({ storageMode: 'huggingface' });
    assert.strictEqual(selected.id, 'hf-b');
  });

  it('throws when all enabled HuggingFace configs exceed threshold', async function () {
    const configs = [
      { id: 'hf-a', type: 'huggingface', updatedAt: 1, config: {} },
      { id: 'hf-b', type: 'huggingface', updatedAt: 2, config: {} },
    ];

    const service = new UploadService({
      storageRepo: {
        async findEnabledByType() {
          return configs;
        },
        async resolveStorageSelection() {
          throw new Error('resolveStorageSelection should not be used in this case');
        },
      },
      fileRepo: {},
      storageFactory: {
        createAdapter() {
          return {
            async getCapacityInfo() {
              return { withinThreshold: false };
            },
          };
        },
      },
    });

    await assert.rejects(
      () => service.resolveStorage({ storageMode: 'huggingface' }),
      /configured capacity thresholds/i
    );
  });
});
