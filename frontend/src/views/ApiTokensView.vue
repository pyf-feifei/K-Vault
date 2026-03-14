<template>
  <section class="card panel status-panel">
    <div class="panel-head">
      <div>
        <h2>API Tokens</h2>
        <p class="muted">为其他系统签发 Bearer Token，用于无网页登录上传。</p>
      </div>
      <button class="btn btn-ghost" @click="loadTokens" :disabled="loading">
        {{ loading ? '刷新中...' : '刷新' }}
      </button>
    </div>

    <section class="card-lite diagnostic-card">
      <h3>新建 Token</h3>
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
        <div class="form-actions">
          <button class="btn" :disabled="saving">
            {{ saving ? '创建中...' : '创建 Token' }}
          </button>
        </div>
      </form>

      <div v-if="latestToken" class="test-detail ok">
        <strong>新 Token 已创建</strong>
        <pre>{{ latestToken }}</pre>
        <div class="form-actions">
          <button class="btn btn-ghost" @click="copy(latestToken)">复制 Token</button>
        </div>
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
              <td>{{ token.tokenPreview }}</td>
              <td>
                <div class="form-actions">
                  <button class="btn btn-ghost" @click="toggleToken(token)">
                    {{ token.enabled ? '禁用' : '启用' }}
                  </button>
                  <button class="btn btn-danger" @click="removeToken(token.id)">删除</button>
                </div>
              </td>
            </tr>
            <tr v-if="tokens.length === 0">
              <td colspan="7" class="empty">当前没有 API Token。</td>
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

const loading = ref(false);
const saving = ref(false);
const error = ref('');
const message = ref('');
const tokens = ref([]);
const scopes = ref([]);
const latestToken = ref('');
const form = reactive({
  name: '',
  scopes: ['upload'],
  expiresInDays: null,
  enabled: true,
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
    const data = await listApiTokens();
    tokens.value = data.tokens;
    scopes.value = data.scopes;
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
    };
    if (form.expiresInDays) {
      payload.expiresInDays = Number(form.expiresInDays);
    }

    const created = await createApiToken(payload);
    latestToken.value = created.token || '';
    message.value = 'API Token 已创建。';
    form.name = '';
    form.scopes = ['upload'];
    form.expiresInDays = null;
    form.enabled = true;
    await loadTokens();
  } catch (err) {
    error.value = err.message || '创建 API Token 失败';
  } finally {
    saving.value = false;
  }
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

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const input = document.createElement('textarea');
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
  }
}

function formatDateTime(value) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '-';
  return new Date(timestamp).toLocaleString('zh-CN');
}
</script>
