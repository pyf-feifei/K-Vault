<template>
  <section class="card panel status-panel">
    <div class="panel-head">
      <div>
        <h2>系统状态</h2>
        <p class="muted">查看存储可用性、诊断信息，以及排查问题的建议。</p>
      </div>
      <button class="btn btn-ghost" @click="loadStatus" :disabled="loading">
        {{ loading ? '刷新中...' : '刷新' }}
      </button>
    </div>

    <div class="adapter-grid">
      <article v-for="item in adapters" :key="item.type" class="adapter-card">
        <div class="adapter-card-top">
          <strong>{{ item.label }}</strong>
          <span class="badge" :class="item.connected ? 'badge-ok' : 'badge-danger'">
            {{ item.connected ? '已连接' : '不可用' }}
          </span>
        </div>
        <p class="muted">{{ item.message }}</p>
        <p class="muted">已配置：{{ item.configured ? '是' : '否' }} | 接入方式：{{ item.layer }}</p>
        <p v-if="item.errorMessage" class="error">{{ item.errorMessage }}</p>
      </article>
    </div>

    <section class="card-lite diagnostic-card" v-if="telegramDiag">
      <h3>Telegram 诊断</h3>
      <p class="muted">{{ translateStatusMessage(telegramDiag.summary) }}</p>
      <ul class="diag-list">
        <li><strong>配置来源：</strong> {{ telegramDiag.configSource || '未知' }}</li>
        <li><strong>机器人 Token 来源：</strong> {{ telegramDiag.tokenSource || '未找到' }}</li>
        <li><strong>聊天 ID 来源：</strong> {{ telegramDiag.chatIdSource || '未找到' }}</li>
        <li><strong>API 地址来源：</strong> {{ telegramDiag.apiBaseSource || '默认' }}</li>
      </ul>
      <ol class="diag-steps">
        <li>调用 `/api/status`，检查 Telegram 的 `message` 和 `errorModel.detail` 字段。</li>
        <li>核对 Docker 环境变量，确认上方显示的别名是否生效。</li>
        <li>如果 Token 和 Chat ID 都正确但仍然超时，请检查服务器到 Telegram API 的出站网络。</li>
      </ol>
    </section>

    <section class="card-lite diagnostic-card" v-if="fileCache">
      <h3>文件缓存</h3>
      <p class="muted">
        {{ fileCache.enabled ? '已启用本地文件代理缓存。' : '文件代理缓存未启用。' }}
      </p>
      <p class="muted">
        当前来源：{{ fileCache.overrideActive ? '应用设置覆盖' : '环境变量默认值' }}
      </p>
      <ul class="diag-list">
        <li><strong>缓存目录：</strong> {{ fileCache.dir || '-' }}</li>
        <li><strong>当前占用：</strong> {{ formatBytes(fileCache.currentBytes) }} / {{ formatBytes(fileCache.maxBytes) }}</li>
        <li><strong>当前文件数：</strong> {{ fileCache.currentFiles || 0 }} / {{ fileCache.maxFiles || 0 }}</li>
        <li><strong>单文件上限：</strong> {{ formatBytes(fileCache.maxFileBytes) }}</li>
        <li><strong>过期时间：</strong> {{ formatHours(fileCache.ttlMs) }}</li>
        <li><strong>磁盘保底空闲：</strong> {{ formatBytes(fileCache.minFreeBytes) }}</li>
        <li><strong>当前磁盘空闲：</strong> {{ formatBytes(fileCache.freeBytes) }}</li>
        <li><strong>预热任务：</strong> {{ fileCache.warming || 0 }}</li>
      </ul>
      <div class="cache-summary">
        <p class="muted">{{ estimateMediaSummary(100) }}</p>
        <p class="muted">{{ estimateMediaSummary(300) }}</p>
      </div>
      <form class="cache-settings-form" @submit.prevent="saveFileCacheSettings">
        <label class="cache-settings-toggle">
          <input v-model="fileCacheForm.enabled" type="checkbox" />
          启用文件缓存
        </label>
        <label>
          <span>缓存过期时间（小时）</span>
          <input v-model="fileCacheForm.ttlHours" type="number" min="1" step="1" />
        </label>
        <label>
          <span>缓存总上限</span>
          <input v-model.trim="fileCacheForm.maxBytes" type="text" placeholder="5GB" />
        </label>
        <label>
          <span>缓存文件数上限</span>
          <input v-model="fileCacheForm.maxFiles" type="number" min="1" step="1" />
        </label>
        <label>
          <span>磁盘保底空闲</span>
          <input v-model.trim="fileCacheForm.minFreeBytes" type="text" placeholder="2GB" />
        </label>
        <label>
          <span>单文件缓存上限</span>
          <input v-model.trim="fileCacheForm.maxFileBytes" type="text" placeholder="256MB" />
        </label>
        <div class="form-actions">
          <button class="btn" :disabled="settingsSaving">
            {{ settingsSaving ? '保存中...' : '保存缓存设置' }}
          </button>
          <button class="btn btn-ghost" type="button" :disabled="settingsSaving" @click="resetFileCacheSettings">
            恢复默认值
          </button>
        </div>
      </form>
      <p v-if="settingsMessage" class="muted">{{ settingsMessage }}</p>
      <div class="cache-metrics" v-if="fileCache.metrics">
        <div class="cache-metric">
          <span>命中</span>
          <strong>{{ fileCache.metrics.hit || 0 }}</strong>
        </div>
        <div class="cache-metric">
          <span>首次填充</span>
          <strong>{{ fileCache.metrics.missFill || 0 }}</strong>
        </div>
        <div class="cache-metric">
          <span>边回源边缓存</span>
          <strong>{{ fileCache.metrics.missStore || 0 }}</strong>
        </div>
        <div class="cache-metric">
          <span>回源分片</span>
          <strong>{{ fileCache.metrics.bypassRange || 0 }}</strong>
        </div>
        <div class="cache-metric">
          <span>其他直通</span>
          <strong>{{ fileCache.metrics.bypass || 0 }}</strong>
        </div>
        <div class="cache-metric">
          <span>命中率</span>
          <strong>{{ formatPercent(fileCache.metrics.hitRate) }}</strong>
        </div>
      </div>
    </section>

    <p v-if="error" class="error">{{ error }}</p>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { apiFetch } from '../api/client';
import { deleteSettings, updateSettings } from '../api/settings';

const loading = ref(false);
const error = ref('');
const status = ref(null);
const settingsSaving = ref(false);
const settingsMessage = ref('');
const fileCacheForm = reactive({
  enabled: true,
  ttlHours: '168',
  maxBytes: '5GB',
  maxFiles: '5000',
  minFreeBytes: '2GB',
  maxFileBytes: '256MB',
});

const adapters = computed(() => {
  const source = status.value || {};
  const list = Array.isArray(source.capabilities) ? source.capabilities : [];
  return list.map((cap) => {
    const detail = source[cap.type] || {};
    const errorMessage = detail.errorModel?.detail || '';
    return {
      type: cap.type,
      label: cap.label,
      connected: Boolean(detail.connected),
      configured: Boolean(detail.configured),
      layer: translateLayer(cap.layer || detail.layer || 'direct'),
      message: translateStatusMessage(detail.message || cap.enableHint || '暂无数据'),
      errorMessage,
    };
  });
});

const telegramDiag = computed(() => status.value?.diagnostics?.telegram || null);
const fileCache = computed(() => status.value?.fileCache || null);

watch(fileCache, (nextValue) => {
  if (!nextValue?.editable) return;
  fileCacheForm.enabled = Boolean(nextValue.editable.enabled);
  fileCacheForm.ttlHours = String(nextValue.editable.ttlHours || 168);
  fileCacheForm.maxBytes = formatBytesInput(nextValue.editable.maxBytes);
  fileCacheForm.maxFiles = String(nextValue.editable.maxFiles || 5000);
  fileCacheForm.minFreeBytes = formatBytesInput(nextValue.editable.minFreeBytes);
  fileCacheForm.maxFileBytes = formatBytesInput(nextValue.editable.maxFileBytes);
}, { immediate: true });

onMounted(() => {
  void loadStatus();
});

async function loadStatus() {
  loading.value = true;
  error.value = '';
  try {
    status.value = await apiFetch('/api/status');
  } catch (err) {
    error.value = err.message || '加载状态失败';
  } finally {
    loading.value = false;
  }
}

async function saveFileCacheSettings() {
  settingsSaving.value = true;
  settingsMessage.value = '';
  error.value = '';

  try {
    await updateSettings({
      fileCache: {
        enabled: Boolean(fileCacheForm.enabled),
        ttlHours: Number(fileCacheForm.ttlHours),
        maxBytes: fileCacheForm.maxBytes,
        maxFiles: Number(fileCacheForm.maxFiles),
        minFreeBytes: fileCacheForm.minFreeBytes,
        maxFileBytes: fileCacheForm.maxFileBytes,
      },
    });
    settingsMessage.value = '文件缓存设置已保存并即时生效。';
    await loadStatus();
  } catch (err) {
    error.value = err.message || '保存缓存设置失败';
  } finally {
    settingsSaving.value = false;
  }
}

async function resetFileCacheSettings() {
  settingsSaving.value = true;
  settingsMessage.value = '';
  error.value = '';

  try {
    await deleteSettings(['fileCache']);
    settingsMessage.value = '文件缓存设置已恢复为环境变量默认值。';
    await loadStatus();
  } catch (err) {
    error.value = err.message || '恢复默认值失败';
  } finally {
    settingsSaving.value = false;
  }
}

function translateLayer(layer) {
  return layer === 'mounted' ? '挂载' : '直连';
}

function translateStatusMessage(message) {
  const text = String(message || '').trim();
  if (!text) return '暂无数据';
  if (text === 'Not configured') return '未配置';
  if (text === 'No data') return '暂无数据';
  if (text.startsWith('Connected (') && text.endsWith(')')) {
    return `已连接（${text.slice('Connected ('.length, -1)}）`;
  }
  if (text.startsWith('Configured (') && text.endsWith(') but disabled')) {
    return `已配置（${text.slice('Configured ('.length, text.length - ') but disabled'.length)}）但已禁用`;
  }
  if (text.startsWith('Connection failed: ')) {
    return `连接失败：${text.slice('Connection failed: '.length)}`;
  }
  if (text.startsWith('Connection error: ')) {
    return `连接异常：${text.slice('Connection error: '.length)}`;
  }
  if (text === 'Telegram adapter is connected.') return 'Telegram 适配器已连接。';
  if (text === 'Telegram storage profile is not created yet.') return 'Telegram 存储配置尚未创建。';
  if (text === 'Telegram adapter is unavailable.') return 'Telegram 适配器当前不可用。';
  if (text === 'Password auth enabled') return '已启用密码认证';
  if (text === 'No auth required') return '无需认证';
  if (text.toLowerCase().startsWith('create ') || text.toLowerCase().startsWith('configure ')) {
    return '请先在“存储配置”页面创建并启用对应配置。';
  }
  return text;
}

function formatBytes(bytes = 0) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatHours(ms = 0) {
  const value = Number(ms || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 小时';
  return `${(value / (60 * 60 * 1000)).toFixed(1)} 小时`;
}

function formatPercent(value = 0) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return '0.0%';
  return `${(numeric * 100).toFixed(1)}%`;
}

function formatBytesInput(bytes = 0) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0B';
  if (value % (1024 * 1024 * 1024) === 0) {
    return `${value / (1024 * 1024 * 1024)}GB`;
  }
  if (value % (1024 * 1024) === 0) {
    return `${value / (1024 * 1024)}MB`;
  }
  if (value % 1024 === 0) {
    return `${value / 1024}KB`;
  }
  return `${value}B`;
}

function estimateMediaSummary(sizeMb) {
  const cache = fileCache.value;
  if (!cache?.enabled) {
    return `${sizeMb}MB 视频：缓存未启用。`;
  }

  const bytes = sizeMb * 1024 * 1024;
  if (Number(cache.maxFileBytes || 0) < bytes) {
    return `${sizeMb}MB 视频：不会进入缓存，因为单文件上限只有 ${formatBytes(cache.maxFileBytes)}。`;
  }

  const remainingBytes = Math.max(0, Number(cache.maxBytes || 0) - Number(cache.currentBytes || 0));
  const count = Math.floor(remainingBytes / bytes);
  return `${sizeMb}MB 视频：会进入缓存；按当前缓存池剩余空间，约还能容纳 ${count} 个。`;
}
</script>
