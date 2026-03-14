<template>
  <section class="card panel status-panel">
    <div class="panel-head">
      <div>
        <h2>API Tokens</h2>
        <p class="muted">为其他系统签发 Bearer Token，用于无网页登录上传。默认不限制存储或目录，只有配置时才生效。</p>
      </div>
      <button class="btn btn-ghost" @click="loadTokens" :disabled="loading">
        {{ loading ? '刷新中...' : '刷新' }}
      </button>
    </div>

    <section class="card-lite diagnostic-card">
      <h3>{{ editingId ? '编辑 Token' : '新建 Token' }}</h3>
      <form class="form-grid" @submit.prevent="submitCreate">
        <label>
          <span>名称</span>
          <input v-model.trim="form.name" required placeholder="例如：cms-uploader" />
        </label>
        <label>
          <span>有效期（天）</span>
          <input v-model.number="form.expiresInDays" type="number" min="1" step="1" placeholder="可留空表示不过期" />
        </label>
        <label class="cache-settings-toggle">
          <input v-model="form.enabled" type="checkbox" />
          创建后立即启用
        </label>
        <div class="token-scope-list">
          <label v-for="scope in scopes" :key="scope" class="cache-settings-toggle">
            <input v-model="form.scopes" type="checkbox" :value="scope" />
            {{ scope }}
          </label>
        </div>
        <label>
          <span>限制存储配置（可选）</span>
          <select v-model="form.restrictions.storageConfigId">
            <option value="">不限制</option>
            <option v-for="item in storageOptions" :key="item.id" :value="item.id">
              {{ item.name }} ({{ item.type }})
            </option>
          </select>
        </label>
        <label>
          <span>限制目录前缀（可选）</span>
          <input v-model.trim="form.restrictions.folderPath" placeholder="例如 media/videos" />
        </label>
        <div class="form-actions">
          <button class="btn" type="submit" :disabled="saving">
            {{ saving ? (editingId ? '保存中...' : '创建中...') : (editingId ? '保存 Token' : '创建 Token') }}
          </button>
          <button v-if="editingId" class="btn btn-ghost" type="button" :disabled="saving" @click="resetForm">
            取消编辑
          </button>
        </div>
      </form>

      <div v-if="latestToken" class="test-detail ok">
        <strong>新 Token 已创建</strong>
        <input :value="latestToken" readonly class="token-display-input" @focus="$event.target.select()" />
        <div class="form-actions">
          <button class="btn btn-ghost" type="button" @click="copy(latestToken, 'Token 已复制。')">复制 Token</button>
          <button class="btn btn-ghost" type="button" @click="copy(uploadExample, '上传命令已复制。')">复制命令</button>
        </div>
        <p class="muted">明文 Token 只会在创建时展示一次，刷新页面后无法再恢复。</p>
        <pre>{{ uploadExample }}</pre>
      </div>
    </section>

    <section class="card-lite diagnostic-card">
      <h3>已签发 Token</h3>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>名称</th>
              <th>Scopes</th>
              <th>过期时间</th>
              <th>状态</th>
              <th>最近使用</th>
              <th>限制</th>
              <th>预览</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="token in tokens" :key="token.id">
              <td>
                <div class="file-col">
                  <strong>{{ token.name }}</strong>
                  <small>{{ token.id }}</small>
                </div>
              </td>
              <td>{{ (token.scopes || []).join(', ') || '-' }}</td>
              <td>{{ formatDateTime(token.expiresAt) }}</td>
              <td>
                <span class="badge" :class="token.enabled ? 'badge-ok' : 'badge-danger'">
                  {{ token.enabled ? '已启用' : '已禁用' }}
                </span>
              </td>
              <td>{{ formatDateTime(token.lastUsedAt) }}</td>
              <td>{{ formatRestrictions(token.restrictions) }}</td>
              <td>{{ token.tokenPreview }}</td>
              <td>
                <div class="form-actions">
                  <button class="btn btn-ghost" type="button" @click="editToken(token)">编辑</button>
                  <button class="btn btn-ghost" type="button" @click="toggleToken(token)">
                    {{ token.enabled ? '禁用' : '启用' }}
                  </button>
                  <button class="btn btn-danger" type="button" @click="removeToken(token.id)">删除</button>
                </div>
              </td>
            </tr>
            <tr v-if="tokens.length === 0">
              <td colspan="8" class="empty">当前没有 API Token。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <p v-if="message" class="muted">{{ message }}</p>
    <p v-if="error" class="error">{{ error }}</p>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { createApiToken, deleteApiToken, listApiTokens, updateApiToken } from '../api/tokens';
import { getApiBase } from '../api/client';
import { listStorageConfigs } from '../api/storage';

const loading = ref(false);
const saving = ref(false);
const error = ref('');
const message = ref('');
const tokens = ref([]);
const scopes = ref([]);
const storageOptions = ref([]);
const latestToken = ref('');
const editingId = ref('');
const form = reactive({
  name: '',
  scopes: ['upload'],
  expiresInDays: null,
  enabled: true,
  restrictions: {
    storageConfigId: '',
    folderPath: '',
  },
});

const uploadExample = computed(() => {
  if (!latestToken.value) return '';
  return [
    'curl -X POST \\',
    `  -H "Authorization: Bearer ${latestToken.value}" \\`,
    '  -F "file=@demo.png" \\',
    '  -F "storageMode=huggingface" \\',
    `  ${window.location.origin}${getApiBase()}/api/v1/upload`,
  ].join('\n');
});

onMounted(() => {
  void loadTokens();
});

async function loadTokens() {
  loading.value = true;
  error.value = '';
  try {
    const [data, storageItems] = await Promise.all([
      listApiTokens(),
      listStorageConfigs(),
    ]);
    tokens.value = data.tokens;
    scopes.value = data.scopes;
    storageOptions.value = storageItems.filter((item) => item.enabled);
  } catch (err) {
    error.value = err.message || '加载 API Tokens 失败';
  } finally {
    loading.value = false;
  }
}

async function submitCreate() {
  saving.value = true;
  error.value = '';
  message.value = '';

  try {
    const payload = {
      name: form.name,
      scopes: [...form.scopes],
      enabled: Boolean(form.enabled),
      restrictions: buildRestrictionsPayload(),
    };
    if (form.expiresInDays) {
      payload.expiresInDays = Number(form.expiresInDays);
    }

    if (editingId.value) {
      await updateApiToken(editingId.value, payload);
      latestToken.value = '';
      message.value = 'API Token 已更新。';
    } else {
      const created = await createApiToken(payload);
      latestToken.value = created.token || '';
      message.value = 'API Token 已创建。';
    }
    resetForm();
    await loadTokens();
  } catch (err) {
    error.value = err.message || '创建 API Token 失败';
  } finally {
    saving.value = false;
  }
}

function editToken(token) {
  editingId.value = token.id;
  latestToken.value = '';
  form.name = token.name;
  form.scopes = [...(token.scopes || [])];
  form.expiresInDays = null;
  form.enabled = Boolean(token.enabled);
  form.restrictions.storageConfigId = token.restrictions?.storageConfigId || '';
  form.restrictions.folderPath = token.restrictions?.folderPath || '';
  message.value = '';
  error.value = '';
}

function resetForm() {
  editingId.value = '';
  form.name = '';
  form.scopes = ['upload'];
  form.expiresInDays = null;
  form.enabled = true;
  form.restrictions.storageConfigId = '';
  form.restrictions.folderPath = '';
}

async function toggleToken(token) {
  error.value = '';
  message.value = '';
  try {
    await updateApiToken(token.id, {
      enabled: !token.enabled,
    });
    message.value = 'API Token 状态已更新。';
    await loadTokens();
  } catch (err) {
    error.value = err.message || '更新失败';
  }
}

async function removeToken(id) {
  if (!window.confirm('确认删除这个 API Token 吗？')) return;
  error.value = '';
  message.value = '';
  try {
    await deleteApiToken(id);
    message.value = 'API Token 已删除。';
    await loadTokens();
  } catch (err) {
    error.value = err.message || '删除失败';
  }
}

async function copy(text, successMessage = '已复制。') {
  try {
    await navigator.clipboard.writeText(text);
    message.value = successMessage;
  } catch {
    const input = document.createElement('textarea');
    input.value = text;
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(input);
    if (copied) {
      message.value = successMessage;
      return;
    }
    window.prompt('请手动复制下面的内容：', text);
  }
}

function formatDateTime(value) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '-';
  return new Date(timestamp).toLocaleString('zh-CN');
}

function buildRestrictionsPayload() {
  const restrictions = {};
  if (form.restrictions.storageConfigId) {
    restrictions.storageConfigId = form.restrictions.storageConfigId;
  }
  if (form.restrictions.folderPath) {
    restrictions.folderPath = form.restrictions.folderPath;
  }
  return restrictions;
}

function formatRestrictions(restrictions = {}) {
  const values = [];
  if (restrictions.storageConfigId) values.push(`存储:${restrictions.storageConfigId}`);
  if (restrictions.folderPath) values.push(`目录:${restrictions.folderPath}`);
  return values.length > 0 ? values.join(' | ') : '不限制';
}
</script>
