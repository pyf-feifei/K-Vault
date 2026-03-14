<template>
  <section class="card panel status-panel">
    <div class="panel-head">
      <div>
        <h2>缓存管理</h2>
        <p class="muted">管理本地文件代理缓存、查看命中情况，并调整运行时缓存策略。</p>
      </div>
      <div class="form-actions">
        <button class="btn btn-ghost" @click="loadCachePage" :disabled="loading || saving">
          {{ loading ? '刷新中...' : '刷新' }}
        </button>
        <button class="btn btn-ghost" @click="runCleanup" :disabled="loading || saving">
          手动清理
        </button>
        <button class="btn btn-danger" @click="clearAllCache" :disabled="loading || saving">
          清空缓存
        </button>
      </div>
    </div>

    <section class="card-lite diagnostic-card" v-if="cacheStatus">
      <h3>缓存总览</h3>
      <p class="muted">
        {{ cacheStatus.enabled ? '已启用本地文件代理缓存。' : '文件代理缓存未启用。' }}
      </p>
      <p class="muted">
        当前来源：{{ cacheStatus.overrideActive ? '应用设置覆盖' : '环境变量默认值' }}
      </p>
      <ul class="diag-list">
        <li><strong>缓存目录：</strong> {{ cacheStatus.dir || '-' }}</li>
        <li><strong>当前占用：</strong> {{ formatBytes(cacheStatus.currentBytes) }} / {{ formatBytes(cacheStatus.maxBytes) }}</li>
        <li><strong>当前文件数：</strong> {{ cacheStatus.currentFiles || 0 }} / {{ cacheStatus.maxFiles || 0 }}</li>
        <li><strong>单文件上限：</strong> {{ formatBytes(cacheStatus.maxFileBytes) }}</li>
        <li><strong>过期时间：</strong> {{ formatHours(cacheStatus.ttlMs) }}</li>
        <li><strong>磁盘保底空闲：</strong> {{ formatBytes(cacheStatus.minFreeBytes) }}</li>
        <li><strong>当前磁盘空闲：</strong> {{ formatBytes(cacheStatus.freeBytes) }}</li>
        <li><strong>预热任务：</strong> {{ cacheStatus.warming || 0 }}</li>
      </ul>
      <div class="cache-summary">
        <p class="muted">{{ estimateMediaSummary(100) }}</p>
        <p class="muted">{{ estimateMediaSummary(300) }}</p>
      </div>
      <div class="cache-metrics" v-if="cacheStatus.metrics">
        <div class="cache-metric">
          <span>命中</span>
          <strong>{{ cacheStatus.metrics.hit || 0 }}</strong>
        </div>
        <div class="cache-metric">
          <span>首次填充</span>
          <strong>{{ cacheStatus.metrics.missFill || 0 }}</strong>
        </div>
        <div class="cache-metric">
          <span>边回源边缓存</span>
          <strong>{{ cacheStatus.metrics.missStore || 0 }}</strong>
        </div>
        <div class="cache-metric">
          <span>回源分片</span>
          <strong>{{ cacheStatus.metrics.bypassRange || 0 }}</strong>
        </div>
        <div class="cache-metric">
          <span>其他直通</span>
          <strong>{{ cacheStatus.metrics.bypass || 0 }}</strong>
        </div>
        <div class="cache-metric">
          <span>命中率</span>
          <strong>{{ formatPercent(cacheStatus.metrics.hitRate) }}</strong>
        </div>
      </div>
    </section>

    <section class="card-lite diagnostic-card" v-if="cacheStatus">
      <h3>缓存设置</h3>
      <form class="cache-settings-form" @submit.prevent="saveCacheSettings">
        <label class="cache-settings-toggle">
          <input v-model="cacheForm.enabled" type="checkbox" />
          启用文件缓存
        </label>
        <label>
          <span>缓存过期时间（小时）</span>
          <input v-model="cacheForm.ttlHours" type="number" min="1" step="1" />
        </label>
        <label>
          <span>缓存总上限</span>
          <input v-model.trim="cacheForm.maxBytes" type="text" placeholder="5GB" />
        </label>
        <label>
          <span>缓存文件数上限</span>
          <input v-model="cacheForm.maxFiles" type="number" min="1" step="1" />
        </label>
        <label>
          <span>磁盘保底空闲</span>
          <input v-model.trim="cacheForm.minFreeBytes" type="text" placeholder="2GB" />
        </label>
        <label>
          <span>单文件缓存上限</span>
          <input v-model.trim="cacheForm.maxFileBytes" type="text" placeholder="256MB" />
        </label>
        <div class="form-actions">
          <button class="btn" :disabled="loading || saving">
            {{ saving ? '保存中...' : '保存缓存设置' }}
          </button>
          <button class="btn btn-ghost" type="button" :disabled="loading || saving" @click="resetCacheSettings">
            恢复默认值
          </button>
        </div>
      </form>
    </section>

    <section class="card-lite diagnostic-card">
      <div class="panel-head">
        <h3>最近缓存文件</h3>
        <p class="muted">按最近访问时间排序，仅展示前 {{ entries.length }} 项。</p>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>文件</th>
              <th>大小</th>
              <th>缓存时间</th>
              <th>最近访问</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in entries" :key="entry.fileId">
              <td>
                <div class="file-col">
                  <strong>{{ entry.fileName || entry.fileId }}</strong>
                  <small>{{ entry.fileId }}</small>
                </div>
              </td>
              <td>{{ formatBytes(entry.bytes) }}</td>
              <td>{{ formatDateTime(entry.cachedAt) }}</td>
              <td>{{ formatDateTime(entry.lastAccessAt) }}</td>
            </tr>
            <tr v-if="entries.length === 0">
              <td colspan="4" class="empty">当前没有缓存文件。</td>
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
import { onMounted, reactive, ref } from 'vue';
import { cleanupCache, clearCache, getCacheEntries, getCacheStatus } from '../api/cache';
import { deleteSettings, updateSettings } from '../api/settings';

const loading = ref(false);
const saving = ref(false);
const error = ref('');
const message = ref('');
const cacheStatus = ref(null);
const entries = ref([]);
const cacheForm = reactive({
  enabled: true,
  ttlHours: '168',
  maxBytes: '5GB',
  maxFiles: '5000',
  minFreeBytes: '2GB',
  maxFileBytes: '256MB',
});

onMounted(() => {
  void loadCachePage();
});

async function loadCachePage() {
  loading.value = true;
  error.value = '';
  try {
    const [nextStatus, nextEntries] = await Promise.all([
      getCacheStatus(),
      getCacheEntries(100),
    ]);
    cacheStatus.value = nextStatus;
    entries.value = nextEntries;
    syncForm(nextStatus);
  } catch (err) {
    error.value = err.message || '加载缓存管理失败';
  } finally {
    loading.value = false;
  }
}

function syncForm(status) {
  const editable = status?.editable;
  if (!editable) return;
  cacheForm.enabled = Boolean(editable.enabled);
  cacheForm.ttlHours = String(editable.ttlHours || 168);
  cacheForm.maxBytes = formatBytesInput(editable.maxBytes);
  cacheForm.maxFiles = String(editable.maxFiles || 5000);
  cacheForm.minFreeBytes = formatBytesInput(editable.minFreeBytes);
  cacheForm.maxFileBytes = formatBytesInput(editable.maxFileBytes);
}

async function saveCacheSettings() {
  saving.value = true;
  error.value = '';
  message.value = '';
  try {
    await updateSettings({
      fileCache: {
        enabled: Boolean(cacheForm.enabled),
        ttlHours: Number(cacheForm.ttlHours),
        maxBytes: cacheForm.maxBytes,
        maxFiles: Number(cacheForm.maxFiles),
        minFreeBytes: cacheForm.minFreeBytes,
        maxFileBytes: cacheForm.maxFileBytes,
      },
    });
    message.value = '文件缓存设置已保存并即时生效。';
    await loadCachePage();
  } catch (err) {
    error.value = err.message || '保存缓存设置失败';
  } finally {
    saving.value = false;
  }
}

async function resetCacheSettings() {
  saving.value = true;
  error.value = '';
  message.value = '';
  try {
    await deleteSettings(['fileCache']);
    message.value = '文件缓存设置已恢复为环境变量默认值。';
    await loadCachePage();
  } catch (err) {
    error.value = err.message || '恢复默认值失败';
  } finally {
    saving.value = false;
  }
}

async function runCleanup() {
  loading.value = true;
  error.value = '';
  message.value = '';
  try {
    cacheStatus.value = await cleanupCache();
    entries.value = await getCacheEntries(100);
    syncForm(cacheStatus.value);
    message.value = '缓存清理已完成。';
  } catch (err) {
    error.value = err.message || '执行缓存清理失败';
  } finally {
    loading.value = false;
  }
}

async function clearAllCache() {
  if (!window.confirm('确认清空全部缓存文件吗？')) return;

  loading.value = true;
  error.value = '';
  message.value = '';
  try {
    const result = await clearCache();
    cacheStatus.value = result.status;
    entries.value = [];
    syncForm(cacheStatus.value);
    message.value = `已清空 ${result.deleted} 个缓存文件。`;
  } catch (err) {
    error.value = err.message || '清空缓存失败';
  } finally {
    loading.value = false;
  }
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

function formatBytesInput(bytes = 0) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0B';
  if (value % (1024 * 1024 * 1024) === 0) return `${value / (1024 * 1024 * 1024)}GB`;
  if (value % (1024 * 1024) === 0) return `${value / (1024 * 1024)}MB`;
  if (value % 1024 === 0) return `${value / 1024}KB`;
  return `${value}B`;
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

function formatDateTime(value) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '-';
  return new Date(timestamp).toLocaleString('zh-CN');
}

function estimateMediaSummary(sizeMb) {
  const cache = cacheStatus.value;
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
