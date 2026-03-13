<template>
  <section class="card panel storage-panel">
    <div class="panel-head storage-head">
      <div>
        <h2>存储配置</h2>
        <p class="muted">管理后端配置、测试连接状态，并切换默认存储目标。</p>
        <p class="muted">WebDAV 更适合作为挂载型或聚合型入口，例如 alist/openlist 的 WebDAV 地址。</p>
      </div>
      <button class="btn btn-ghost" @click="resetForm">新建配置</button>
    </div>

    <div class="storage-layout">
      <article class="storage-list card-lite">
        <h3>已配置后端</h3>
        <ul v-if="items.length" class="list storage-listing">
          <li v-for="item in items" :key="item.id" class="storage-row">
            <div class="storage-row-main">
              <div class="storage-row-top">
                <strong>{{ item.name }}</strong>
                <span class="badge">{{ getStorageLabel(item.type) }}</span>
                <span class="badge" :class="item.enabled ? 'badge-ok' : 'badge-danger'">
                  {{ item.enabled ? '已启用' : '已禁用' }}
                </span>
                <span class="badge" v-if="item.isDefault">默认</span>
              </div>
              <p class="muted">ID: {{ item.id }}</p>
              <p v-if="testResults[item.id]" class="storage-test" :class="testResults[item.id].connected ? 'ok' : 'fail'">
                {{ formatTestMessage(testResults[item.id]) }}
              </p>
            </div>

            <div class="storage-actions">
              <button class="btn btn-ghost" @click="editItem(item)">编辑</button>
              <button class="btn btn-ghost" @click="testItem(item.id)">测试</button>
              <button class="btn btn-ghost" @click="toggleEnabled(item)">
                {{ item.enabled ? '禁用' : '启用' }}
              </button>
              <button class="btn btn-ghost" @click="setDefault(item.id)" :disabled="item.isDefault">设为默认</button>
              <button class="btn btn-danger" @click="removeItem(item.id)">删除</button>
            </div>
          </li>
        </ul>
        <p v-else class="muted">暂无存储配置。</p>
      </article>

      <article class="storage-editor card-lite">
        <h3>{{ editingId ? '编辑存储' : '新建存储' }}</h3>

        <form class="form-grid" @submit.prevent="submit">
          <label>
            名称
            <input v-model.trim="form.name" required placeholder="便于识别的名称" />
          </label>

          <label>
            类型
            <select v-model="form.type" @change="onTypeChanged">
              <optgroup label="直连上传后端">
                <option v-for="type in directTypes" :key="type.value" :value="type.value">{{ type.label }}</option>
              </optgroup>
              <optgroup label="挂载 / 聚合后端">
                <option v-for="type in mountedTypes" :key="type.value" :value="type.value">{{ type.label }}</option>
              </optgroup>
            </select>
          </label>

          <div class="toggle-row">
            <label><input v-model="form.enabled" type="checkbox" /> 启用</label>
            <label><input v-model="form.isDefault" type="checkbox" /> 设为默认</label>
          </div>

          <div class="field-grid">
            <label v-for="field in currentFields" :key="field.key">
              <span>{{ field.label }}</span>

              <select
                v-if="field.input === 'select'"
                v-model="form.config[field.key]"
                :required="field.required"
              >
                <option
                  v-for="option in field.options || []"
                  :key="`${field.key}-${option.value}`"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>

              <textarea
                v-else-if="field.input === 'textarea'"
                v-model="form.config[field.key]"
                :placeholder="field.placeholder"
                :required="field.required"
                rows="4"
              ></textarea>

              <input
                v-else
                v-model.trim="form.config[field.key]"
                :type="field.secret ? 'password' : 'text'"
                :placeholder="field.placeholder"
                :required="field.required"
              />
            </label>
          </div>

          <p v-if="STORAGE_NOTES[form.type]" class="muted">{{ STORAGE_NOTES[form.type] }}</p>

          <div class="form-actions">
            <button class="btn" :disabled="saving">{{ saving ? '保存中...' : '保存配置' }}</button>
            <button class="btn btn-ghost" type="button" :disabled="testing" @click="testDraftConfig">
              {{ testing ? '测试中...' : '测试草稿配置' }}
            </button>
          </div>
        </form>

        <div v-if="draftTest" class="test-detail" :class="draftTest.connected ? 'ok' : 'fail'">
          <strong>{{ draftTest.connected ? '草稿连接成功' : '草稿连接失败' }}</strong>
          <pre>{{ stringifyDetail(draftTest) }}</pre>
        </div>
      </article>
    </div>

    <p v-if="message" class="muted">{{ message }}</p>
    <p v-if="error" class="error">{{ error }}</p>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import {
  createStorageConfig,
  deleteStorageConfig,
  listStorageConfigs,
  setDefaultStorageConfig,
  testStorageConfigById,
  testStorageDraft,
  updateStorageConfig,
} from '../api/storage';
import {
  STORAGE_FIELDS,
  STORAGE_NOTES,
  STORAGE_TYPES,
  getStorageFields,
  getStorageLabel,
} from '../config/storage-definitions';

const items = ref([]);
const editingId = ref('');
const saving = ref(false);
const testing = ref(false);
const message = ref('');
const error = ref('');
const draftTest = ref(null);
const testResults = reactive({});

const form = reactive({
  name: '',
  type: 'telegram',
  enabled: true,
  isDefault: false,
  config: {},
});

const currentFields = computed(() => getStorageFields(form.type));
const directTypes = computed(() => STORAGE_TYPES.filter((item) => item.layer !== 'mounted'));
const mountedTypes = computed(() => STORAGE_TYPES.filter((item) => item.layer === 'mounted'));

onMounted(async () => {
  form.config = buildConfigByType(form.type);
  await loadItems();
});

function buildConfigByType(type, source = {}) {
  const fields = STORAGE_FIELDS[type] || [];
  const target = {};
  for (const field of fields) {
    if (source[field.key] != null) {
      target[field.key] = source[field.key];
      continue;
    }
    if (field.input === 'select') {
      target[field.key] = field.options?.[0]?.value || '';
      continue;
    }
    target[field.key] = '';
  }
  return target;
}

async function loadItems() {
  error.value = '';
  try {
    items.value = await listStorageConfigs();
  } catch (err) {
    error.value = err.message || '加载存储配置失败。';
  }
}

function resetForm() {
  editingId.value = '';
  form.name = '';
  form.type = 'telegram';
  form.enabled = true;
  form.isDefault = false;
  form.config = buildConfigByType('telegram');
  draftTest.value = null;
  message.value = '';
  error.value = '';
}

function onTypeChanged() {
  form.config = buildConfigByType(form.type, form.config);
}

function editItem(item) {
  editingId.value = item.id;
  form.name = item.name;
  form.type = item.type;
  form.enabled = Boolean(item.enabled);
  form.isDefault = Boolean(item.isDefault);
  form.config = buildConfigByType(item.type, item.config || {});
  draftTest.value = null;
  message.value = '';
  error.value = '';
}

function buildPayload() {
  return {
    name: form.name,
    type: form.type,
    enabled: Boolean(form.enabled),
    isDefault: Boolean(form.isDefault),
    config: { ...form.config },
  };
}

async function submit() {
  saving.value = true;
  error.value = '';
  message.value = '';

  try {
    const payload = buildPayload();
    if (editingId.value) {
      await updateStorageConfig(editingId.value, payload);
      message.value = '存储配置已更新。';
    } else {
      await createStorageConfig(payload);
      const successMessage = '存储配置已创建。';
      resetForm();
      message.value = successMessage;
    }

    await loadItems();
  } catch (err) {
    error.value = err.message || '保存失败';
  } finally {
    saving.value = false;
  }
}

async function testDraftConfig() {
  testing.value = true;
  error.value = '';
  message.value = '';

  try {
    const result = await testStorageDraft(form.type, { ...form.config });
    draftTest.value = result || { connected: false };
    message.value = result?.connected ? '草稿测试成功。' : '草稿测试失败。';
  } catch (err) {
    draftTest.value = null;
    error.value = err.message || '连接测试失败';
  } finally {
    testing.value = false;
  }
}

async function testItem(id) {
  error.value = '';
  message.value = '';

  try {
    const result = await testStorageConfigById(id);
    testResults[id] = {
      ...(result || {}),
      testedAt: Date.now(),
    };
    message.value = result?.connected ? '连接成功。' : '连接失败。';
  } catch (err) {
    error.value = err.message || '存储测试失败';
  }
}

async function toggleEnabled(item) {
  error.value = '';
  message.value = '';

  try {
    await updateStorageConfig(item.id, {
      enabled: !item.enabled,
    });
    message.value = '存储状态已更新。';
    await loadItems();
  } catch (err) {
    error.value = err.message || '更新失败';
  }
}

async function setDefault(id) {
  error.value = '';
  message.value = '';

  try {
    await setDefaultStorageConfig(id);
    message.value = '默认存储已更新。';
    await loadItems();
  } catch (err) {
    error.value = err.message || '设置默认存储失败';
  }
}

async function removeItem(id) {
  if (!window.confirm('确认删除这个存储配置吗？')) return;

  error.value = '';
  message.value = '';

  try {
    await deleteStorageConfig(id);
    message.value = '存储配置已删除。';
    await loadItems();

    if (editingId.value === id) {
      resetForm();
    }
  } catch (err) {
    error.value = err.message || '删除失败';
  }
}

function formatTestMessage(result) {
  const statusText = result.connected ? '已连接' : '失败';
  const statusCode = result.status ? `（HTTP ${result.status}）` : '';
  const detail = result.detail ? ` - ${String(result.detail)}` : '';
  return `${statusText}${statusCode}${detail}`;
}

function stringifyDetail(data) {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data || '');
  }
}
</script>
