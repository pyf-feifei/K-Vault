<template>
  <section class="card panel drive-panel">
    <header class="drive-header">
      <div>
        <h2>文件库</h2>
        <p class="muted">在一个页面里上传文件、整理目录，并复制直链或分享链接。</p>
      </div>
      <div class="drive-head-actions">
        <button class="btn btn-ghost" @click="refreshAll">刷新</button>
      </div>
    </header>

    <section class="adapter-visibility card-lite">
      <div class="adapter-visibility-head">
        <h3>存储能力总览</h3>
        <p class="muted">即使未配置，所有适配器也会保持可见。</p>
      </div>
      <div class="adapter-grid">
        <article
          v-for="cap in capabilityCards"
          :key="cap.type"
          class="adapter-card"
          :class="{ active: selectedStorage === cap.type, unavailable: !cap.available }"
          @click="selectStorage(cap)"
        >
          <div class="adapter-card-top">
            <strong>{{ cap.label }}</strong>
            <span class="badge">{{ cap.layerLabel }}</span>
          </div>
          <p class="muted">{{ cap.description }}</p>
          <p class="adapter-status" :class="cap.available ? 'ok' : (cap.configured ? 'warn' : 'fail')">
            {{ cap.statusText }}
          </p>
          <p class="adapter-hint">{{ cap.hint }}</p>
        </article>
      </div>
    </section>

    <section
      class="drive-dropzone"
      :class="{ active: dragActive }"
      @dragover.prevent="dragActive = true"
      @dragleave.prevent="dragActive = false"
      @drop.prevent="handleDrop"
      @click="openPicker"
    >
      <input ref="picker" type="file" multiple hidden @change="handleFilePick" />
      <p class="dropzone-title">拖拽文件到此处，或点击上传</p>
      <p class="muted">当前存储：{{ currentStorageLabel }} | 目录：/{{ currentPath || '' }}</p>
    </section>

    <form class="url-row" @submit.prevent="uploadUrl">
      <input v-model.trim="urlInput" placeholder="https://example.com/file.zip" />
      <button class="btn" :disabled="urlUploading || !urlInput">
        {{ urlUploading ? '上传中...' : '上传 URL 到当前目录' }}
      </button>
    </form>

    <div v-if="queue.length" class="list-wrap">
      <h3>上传队列</h3>
      <ul class="list">
        <li v-for="item in queue" :key="item.id" class="list-item">
          <div class="list-title">
            <strong>{{ item.file.name }}</strong>
            <span>{{ formatSize(item.file.size) }}</span>
          </div>
          <p class="muted" v-if="item.relativePath">相对路径：{{ item.relativePath }}</p>
          <p class="muted">目标目录：/{{ item.targetFolderPath || '' }}</p>
          <div class="progress-track">
            <span class="progress-fill" :style="{ width: `${item.progress}%` }"></span>
          </div>
          <div class="list-meta">
            <span>{{ getQueueStatusLabel(item.status) }}</span>
            <span v-if="item.error" class="error">{{ item.error }}</span>
          </div>
          <div class="result-actions">
            <button class="btn btn-ghost" v-if="item.status === 'error'" @click="retryUpload(item.id)">重试</button>
            <button class="btn btn-ghost" v-if="item.status === 'uploading'" @click="cancelUpload(item.id)">取消</button>
          </div>
        </li>
      </ul>
    </div>

    <div class="drive-layout">
      <aside class="folder-tree card-lite">
        <div class="folder-tree-head">
          <h3>目录</h3>
          <button class="btn btn-ghost" @click="promptCreateFolder">新建</button>
        </div>
        <ul class="tree-list">
          <li
            v-for="node in flatTreeNodes"
            :key="node.path || '__root__'"
            class="tree-item"
            :class="{ active: currentPath === node.path }"
            :style="{ paddingLeft: `${12 + node.depth * 14}px` }"
          >
            <button class="tree-link" @click="openPath(node.path)">
              <span>{{ node.name }}</span>
              <small>{{ node.fileCount }}</small>
            </button>
          </li>
        </ul>
      </aside>

      <article class="drive-main card-lite">
        <div class="drive-toolbar">
          <div class="breadcrumbs">
            <button
              v-for="crumb in breadcrumbs"
              :key="crumb.path || '__root__'"
              class="crumb"
              @click="openPath(crumb.path)"
            >
              {{ crumb.name }}
            </button>
          </div>
          <div class="toolbar">
            <input v-model.trim="search" placeholder="搜索当前视图" @keyup.enter="reloadExplorer" />
            <select v-model="storageFilter" @change="refreshAll">
              <option value="all">全部存储</option>
              <option v-for="type in STORAGE_TYPES" :key="type.value" :value="type.value">{{ type.label }}</option>
            </select>
            <select v-model="viewMode">
              <option value="list">列表</option>
              <option value="grid">网格</option>
            </select>
            <button class="btn btn-ghost" @click="promptMoveSelected" :disabled="selectedFileIds.length === 0">移动</button>
            <button class="btn btn-danger" @click="deleteSelected" :disabled="selectedFileIds.length === 0">删除</button>
          </div>
        </div>

        <div class="folder-inline-list" v-if="folders.length">
          <article v-for="folder in folders" :key="folder.path" class="folder-card">
            <button class="folder-open" @dblclick="openPath(folder.path)" @click="openPath(folder.path)">
              <strong>{{ folder.name }}</strong>
              <small>{{ folder.fileCount }} 个文件</small>
            </button>
            <div class="folder-card-actions">
              <button class="btn btn-ghost" @click="promptRenameFolder(folder)">重命名</button>
              <button class="btn btn-ghost" @click="promptMoveFolder(folder)">移动</button>
              <button class="btn btn-danger" @click="deleteFolderAction(folder)">删除</button>
            </div>
          </article>
        </div>

        <div v-if="viewMode === 'grid'" class="file-grid">
          <article v-for="file in files" :key="file.name" class="file-card">
            <label class="file-check">
              <input type="checkbox" :checked="selectedSet.has(file.name)" @change="toggleFileSelection(file.name)" />
            </label>
            <a :href="fileLink(file.name)" target="_blank" rel="noopener" class="file-preview">
              <img v-if="isImage(file.metadata?.fileName || file.name)" :src="fileLink(file.name)" :alt="file.metadata?.fileName || file.name" />
              <span v-else>文件</span>
            </a>
            <button class="file-name file-name-button" @click="openPreview(file)">
              {{ file.metadata?.fileName || file.name }}
            </button>
            <small class="muted">{{ formatSize(file.metadata?.fileSize || 0) }}</small>
            <div class="file-actions">
              <button class="btn btn-ghost" @click="copyDirect(file)">直链</button>
              <button class="btn btn-ghost" @click="copyShare(file)">分享</button>
              <button class="btn btn-ghost" @click="promptRenameFile(file)">重命名</button>
              <button class="btn btn-ghost" @click="promptMoveFile(file)">移动</button>
              <button class="btn btn-danger" @click="deleteFile(file)">删除</button>
            </div>
          </article>
        </div>

        <div v-else class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th><input type="checkbox" :checked="allSelected" @change="toggleSelectAll" /></th>
                <th>名称</th>
                <th>存储</th>
                <th>大小</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="file in files" :key="file.name">
                <td><input type="checkbox" :checked="selectedSet.has(file.name)" @change="toggleFileSelection(file.name)" /></td>
                <td>
                  <div class="file-col">
                    <button class="file-name-button file-name-inline" @click="openPreview(file)">
                      {{ file.metadata?.fileName || file.name }}
                    </button>
                    <small>{{ file.name }}</small>
                  </div>
                </td>
                <td><span class="badge">{{ file.metadata?.storageType || '未知' }}</span></td>
                <td>{{ formatSize(file.metadata?.fileSize || 0) }}</td>
                <td>{{ formatTime(file.metadata?.TimeStamp) }}</td>
                <td>
                  <div class="table-actions file-table-actions">
                    <button class="btn btn-ghost" @click="copyDirect(file)">直链</button>
                    <button class="btn btn-ghost" @click="copyShare(file)">分享</button>
                    <button class="btn btn-ghost" @click="promptRenameFile(file)">重命名</button>
                    <button class="btn btn-ghost" @click="promptMoveFile(file)">移动</button>
                    <button class="btn btn-danger" @click="deleteFile(file)">删除</button>
                  </div>
                </td>
              </tr>
              <tr v-if="!loading && files.length === 0">
                <td colspan="6" class="empty">当前目录暂无文件。</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="footer-actions">
          <button v-if="nextCursor" class="btn" :disabled="loading" @click="loadMore">
            {{ loading ? '加载中...' : '加载更多' }}
          </button>
        </div>
      </article>
    </div>

    <p v-if="message" class="muted">{{ message }}</p>
    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="previewFile" class="modal-backdrop" @click.self="closePreview">
      <section class="card modal-card preview-modal">
        <div class="modal-head">
          <div>
            <h3>{{ previewFile.metadata?.fileName || previewFile.name }}</h3>
            <p class="muted">{{ previewFile.name }}</p>
          </div>
          <div class="form-actions">
            <a class="btn btn-ghost" :href="fileLink(previewFile.name)" target="_blank" rel="noopener">直链</a>
            <button class="btn btn-ghost" type="button" @click="closePreview">关闭</button>
          </div>
        </div>

        <div class="preview-modal-body">
          <img
            v-if="isImage(previewFile.metadata?.fileName || previewFile.name)"
            class="preview-modal-image"
            :src="fileLink(previewFile.name)"
            :alt="previewFile.metadata?.fileName || previewFile.name"
          />
          <video
            v-else-if="isVideo(previewFile.metadata?.fileName || previewFile.name)"
            class="preview-modal-video"
            :src="fileLink(previewFile.name)"
            controls
          ></video>
          <audio
            v-else-if="isAudio(previewFile.metadata?.fileName || previewFile.name)"
            class="preview-modal-audio"
            :src="fileLink(previewFile.name)"
            controls
          ></audio>
          <iframe
            v-else-if="isPdf(previewFile.metadata?.fileName || previewFile.name)"
            class="preview-modal-frame"
            :src="fileLink(previewFile.name)"
            title="文件预览"
          ></iframe>
          <div v-else class="preview-modal-empty">
            <p class="muted">当前文件类型不支持页内预览。</p>
            <a class="btn" :href="fileLink(previewFile.name)" target="_blank" rel="noopener">打开文件</a>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { apiFetch, absoluteFileUrl, getApiBase } from '../api/client';
import {
  createFolder,
  deleteFiles,
  deleteFolder,
  getDriveExplorer,
  getDriveTree,
  moveFiles,
  moveFolder,
  renameFile,
  signShareLink,
} from '../api/drive';
import { STORAGE_TYPES, getStorageLabel, storageEnabledFromStatus } from '../config/storage-definitions';

const picker = ref(null);
const dragActive = ref(false);
const queue = ref([]);
const uploading = ref(false);
const urlInput = ref('');
const urlUploading = ref(false);
const status = ref(null);
const selectedStorage = ref('telegram');

const treeNodes = ref([]);
const folders = ref([]);
const files = ref([]);
const breadcrumbs = ref([{ path: '', name: '全部文件' }]);
const currentPath = ref('');
const storageFilter = ref('all');
const search = ref('');
const nextCursor = ref(null);
const loading = ref(false);
const viewMode = ref('list');
const selectedFileIds = ref([]);
const message = ref('');
const error = ref('');
const previewFile = ref(null);

const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;
const SMALL_FILE_THRESHOLD = 20 * 1024 * 1024;
const V2_ACCEPT = 'application/vnd.kvault.v2+json, application/json;q=0.9, text/plain;q=0.5, */*;q=0.1';

const selectedSet = computed(() => new Set(selectedFileIds.value));
const allSelected = computed(() => files.value.length > 0 && selectedFileIds.value.length === files.value.length);

const capabilityCards = computed(() => {
  const capabilityList = Array.isArray(status.value?.capabilities)
    ? status.value.capabilities
    : STORAGE_TYPES.map((item) => ({
      type: item.value,
      label: item.label,
      layer: item.layer || 'direct',
      enableHint: '请先在“存储配置”中完成配置。',
    }));

  return capabilityList.map((cap) => {
    const detail = status.value?.[cap.type] || {};
    const configured = Boolean(detail.configured);
    const available = storageEnabledFromStatus(status.value, cap.type);
    const layerLabel = cap.layer === 'mounted' ? '挂载' : '直连';
    let statusText = '未配置';
    if (available) statusText = '可用';
    else if (configured) statusText = '已配置但当前不可用';
    return {
      ...cap,
      description: STORAGE_TYPES.find((x) => x.value === cap.type)?.description || '',
      configured,
      available,
      layerLabel,
      statusText,
      hint: available ? '可直接使用' : (cap.enableHint || '请先完成配置后再启用'),
    };
  });
});

const availableModes = computed(() => capabilityCards.value.filter((item) => item.available));

const currentStorageLabel = computed(() => {
  const found = capabilityCards.value.find((item) => item.type === selectedStorage.value);
  return found?.label || 'Telegram';
});

const flatTreeNodes = computed(() => {
  const sorted = [...treeNodes.value].sort((a, b) => {
    const depthA = a.path ? a.path.split('/').length : 0;
    const depthB = b.path ? b.path.split('/').length : 0;
    if (depthA !== depthB) return depthA - depthB;
    return String(a.path || '').localeCompare(String(b.path || ''), 'en', { sensitivity: 'base' });
  });
  return sorted.map((node) => ({
    ...node,
    depth: node.path ? node.path.split('/').length : 0,
  }));
});

onMounted(async () => {
  await refreshStatus();
  await refreshAll();
});

function selectStorage(capability) {
  if (!capability.available) return;
  selectedStorage.value = capability.type;
}

async function refreshStatus() {
  try {
    status.value = await apiFetch('/api/status');
    if (!availableModes.value.some((item) => item.type === selectedStorage.value)) {
      selectedStorage.value = availableModes.value[0]?.type || 'telegram';
    }
  } catch (err) {
    error.value = err.message || '加载状态失败';
  }
}

async function refreshAll() {
  await Promise.all([loadTree(), reloadExplorer()]);
}

async function loadTree() {
  try {
    treeNodes.value = await getDriveTree(storageFilter.value);
  } catch (err) {
    error.value = err.message || '加载目录树失败';
  }
}

async function reloadExplorer() {
  nextCursor.value = null;
  await loadExplorer(true);
}

async function loadMore() {
  await loadExplorer(false);
}

async function loadExplorer(reset) {
  if (loading.value) return;
  loading.value = true;
  error.value = '';

  try {
    const data = await getDriveExplorer({
      path: currentPath.value,
      storage: storageFilter.value,
      search: search.value,
      limit: 100,
      cursor: reset ? '' : (nextCursor.value || ''),
      includeStats: reset,
    });

    folders.value = Array.isArray(data.folders) ? data.folders : [];
    breadcrumbs.value = Array.isArray(data.breadcrumbs) ? data.breadcrumbs : [{ path: '', name: '全部文件' }];

    const incomingFiles = Array.isArray(data.files) ? data.files : [];
    if (reset) {
      files.value = incomingFiles;
      selectedFileIds.value = [];
    } else {
      const seen = new Set(files.value.map((item) => item.name));
      for (const item of incomingFiles) {
        if (!seen.has(item.name)) files.value.push(item);
      }
    }

    nextCursor.value = data.list_complete ? null : data.cursor;
  } catch (err) {
    error.value = err.message || '加载文件浏览失败';
  } finally {
    loading.value = false;
  }
}

function openPath(path) {
  currentPath.value = path || '';
  void reloadExplorer();
}

function openPicker() {
  picker.value?.click();
}

function handleFilePick(event) {
  const filesPicked = Array.from(event.target.files || []);
  enqueueFiles(filesPicked.map((file) => ({ file, relativePath: '' })));
  event.target.value = '';
}

async function handleDrop(event) {
  dragActive.value = false;
  const dropped = await extractDroppedFiles(event.dataTransfer);
  enqueueFiles(dropped);
}

async function extractDroppedFiles(dataTransfer) {
  const output = [];
  if (!dataTransfer?.items?.length) {
    return Array.from(dataTransfer?.files || []).map((file) => ({ file, relativePath: '' }));
  }

  const tasks = [];
  for (const item of Array.from(dataTransfer.items)) {
    const entry = item.webkitGetAsEntry?.();
    if (!entry) {
      const file = item.getAsFile?.();
      if (file) output.push({ file, relativePath: '' });
      continue;
    }
    tasks.push(readEntry(entry, ''));
  }

  const nested = await Promise.all(tasks);
  for (const list of nested) {
    output.push(...list);
  }
  return output;
}

function readEntry(entry, parentPath) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => {
        resolve([{ file, relativePath: parentPath ? `${parentPath}/${file.name}` : file.name }]);
      });
      return;
    }

    if (!entry.isDirectory) {
      resolve([]);
      return;
    }

    const reader = entry.createReader();
    const entries = [];

    function readBatch() {
      reader.readEntries(async (batch) => {
        if (!batch.length) {
          const children = await Promise.all(entries.map((child) => readEntry(child, parentPath ? `${parentPath}/${entry.name}` : entry.name)));
          resolve(children.flat());
          return;
        }
        entries.push(...batch);
        readBatch();
      });
    }

    readBatch();
  });
}

function joinPath(base, extra) {
  const segments = [];
  for (const piece of [base, extra]) {
    const normalized = String(piece || '').replace(/\\/g, '/');
    for (const part of normalized.split('/')) {
      const cleaned = part.trim();
      if (!cleaned || cleaned === '.') continue;
      if (cleaned === '..') {
        segments.pop();
      } else {
        segments.push(cleaned);
      }
    }
  }
  return segments.join('/');
}

function enqueueFiles(list) {
  for (const item of list) {
    const file = item.file;
    const relativePath = item.relativePath || '';
    const parentPath = relativePath.includes('/')
      ? relativePath.split('/').slice(0, -1).join('/')
      : '';
    const targetFolderPath = joinPath(currentPath.value, parentPath);

    queue.value.push({
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      file,
      relativePath,
      targetFolderPath,
      progress: 0,
      status: 'pending',
      error: '',
      cancelled: false,
      xhr: null,
    });
  }
  void processQueue();
}

async function processQueue() {
  if (uploading.value) return;
  uploading.value = true;
  let shouldReload = false;

  try {
    for (const item of queue.value) {
      if (item.status !== 'pending') continue;
      if (!availableModes.value.some((mode) => mode.type === selectedStorage.value)) {
        item.status = 'error';
        item.error = '所选存储当前不可用。';
        continue;
      }

      item.status = 'uploading';
      item.error = '';
      item.cancelled = false;

      try {
        if (item.file.size > SMALL_FILE_THRESHOLD) {
          await chunkUpload(item);
        } else {
          await directUpload(item);
        }
        item.status = 'success';
        item.progress = 100;
        shouldReload = true;
      } catch (err) {
        if (item.cancelled) {
          item.status = 'cancelled';
          item.error = '';
        } else {
          item.status = 'error';
          item.error = humanizeError(err.message || '上传失败');
        }
      }
    }
  } finally {
    uploading.value = false;
    if (shouldReload) {
      await refreshAll();
    }
  }
}

function apiUrl(path) {
  return `${getApiBase()}${path}`;
}

function truncate(text, maxLength = 220) {
  const value = String(text || '');
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function parseJsonSafe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function humanizeError(message) {
  const text = String(message || '');
  const normalized = text.toLowerCase();

  if (normalized.includes('auth_failed') || normalized.includes('unauthorized') || normalized.includes('forbidden')) {
    return `认证失败：${text}`;
  }
  if (normalized.includes('rate') || normalized.includes('too many requests') || normalized.includes('flood')) {
    return `触发频率限制：${text}`;
  }
  if (normalized.includes('quota') || normalized.includes('limit exceeded') || normalized.includes('too large') || normalized.includes('413')) {
    return `超出文件大小或配额限制：${text}`;
  }
  if (normalized.includes('network') || normalized.includes('timeout') || normalized.includes('fetch failed')) {
    return `网络或上游服务异常：${text}`;
  }
  if (normalized.includes('not configured')) {
    return `存储尚未配置：${text}`;
  }
  return text || '上传失败';
}

function resolveUploadErrorMessage(payload, statusCode, rawText = '') {
  if (payload && typeof payload === 'object') {
    const nestedMessage = typeof payload?.error?.message === 'string' ? payload.error.message : '';
    const message = nestedMessage
      || payload?.error
      || payload?.message
      || payload?.errorDetail
      || payload?.detail;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }

  if (rawText) {
    return `后端返回了非 JSON 响应（${statusCode}）：${truncate(rawText)}`;
  }
  return `上传失败（${statusCode}）`;
}

function directUpload(item) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', item.file);
    formData.append('storageMode', selectedStorage.value);
    formData.append('folderPath', item.targetFolderPath || '');

    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    xhr.open('POST', apiUrl('/upload'));
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', V2_ACCEPT);
    xhr.setRequestHeader('X-KVault-Client', 'app-v2');

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      item.progress = Math.max(1, Math.floor((event.loaded / event.total) * 100));
    };

    xhr.onload = () => {
      item.xhr = null;
      const rawText = String(xhr.responseText || '');
      const body = parseJsonSafe(rawText);
      if (xhr.status < 200 || xhr.status >= 300) {
        const message = resolveUploadErrorMessage(body, xhr.status, rawText);
        reject(new Error(humanizeError(message)));
        return;
      }
      if (!body) {
        reject(new Error(`后端返回了非 JSON 响应：${truncate(rawText) || '<空响应体>'}`));
        return;
      }
      resolve(body);
    };

    xhr.onerror = () => {
      item.xhr = null;
      reject(new Error('网络错误'));
    };

    xhr.onabort = () => {
      item.xhr = null;
      item.cancelled = true;
      reject(new Error('上传已取消'));
    };

    xhr.send(formData);
  });
}

async function chunkUpload(item) {
  const totalChunks = Math.ceil(item.file.size / DEFAULT_CHUNK_SIZE);
  const init = await apiFetch('/api/chunked-upload/init', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: V2_ACCEPT,
      'X-KVault-Client': 'app-v2',
    },
    body: JSON.stringify({
      fileName: item.file.name,
      fileSize: item.file.size,
      fileType: item.file.type,
      totalChunks,
      storageMode: selectedStorage.value,
      folderPath: item.targetFolderPath || '',
    }),
  });

  const uploadId = init.uploadId;
  const chunkSize = Number(init.chunkSize || DEFAULT_CHUNK_SIZE);

  for (let index = 0; index < totalChunks; index += 1) {
    if (item.cancelled) throw new Error('上传已取消');

    const start = index * chunkSize;
    const end = Math.min(item.file.size, start + chunkSize);
    const chunk = item.file.slice(start, end);

    const body = new FormData();
    body.append('uploadId', uploadId);
    body.append('chunkIndex', String(index));
    body.append('chunk', chunk);

    await apiFetch('/api/chunked-upload/chunk', {
      method: 'POST',
      headers: {
        Accept: V2_ACCEPT,
        'X-KVault-Client': 'app-v2',
      },
      body,
    });

    item.progress = Math.min(95, Math.floor(((index + 1) / totalChunks) * 95));
  }

  await apiFetch('/api/chunked-upload/complete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: V2_ACCEPT,
      'X-KVault-Client': 'app-v2',
    },
    body: JSON.stringify({ uploadId }),
  });
}

function cancelUpload(id) {
  const target = queue.value.find((item) => item.id === id);
  if (!target) return;
  target.cancelled = true;
  if (target.xhr) {
    target.xhr.abort();
    return;
  }
  if (target.status === 'pending') {
    target.status = 'cancelled';
  }
}

function retryUpload(id) {
  const target = queue.value.find((item) => item.id === id);
  if (!target) return;
  target.status = 'pending';
  target.progress = 0;
  target.error = '';
  target.cancelled = false;
  void processQueue();
}

async function uploadUrl() {
  if (!urlInput.value || urlUploading.value) return;
  urlUploading.value = true;
  error.value = '';

  try {
    await apiFetch('/api/upload-from-url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: V2_ACCEPT,
        'X-KVault-Client': 'app-v2',
      },
      body: JSON.stringify({
        url: urlInput.value,
        storageMode: selectedStorage.value,
        folderPath: currentPath.value,
      }),
    });
    urlInput.value = '';
    await refreshAll();
  } catch (err) {
    error.value = humanizeError(err.message || 'URL 上传失败');
  } finally {
    urlUploading.value = false;
  }
}

function toggleFileSelection(id) {
  if (selectedSet.value.has(id)) {
    selectedFileIds.value = selectedFileIds.value.filter((item) => item !== id);
  } else {
    selectedFileIds.value = [...selectedFileIds.value, id];
  }
}

function toggleSelectAll() {
  if (allSelected.value) {
    selectedFileIds.value = [];
  } else {
    selectedFileIds.value = files.value.map((file) => file.name);
  }
}

async function promptCreateFolder() {
  const name = window.prompt('请输入目录名称');
  if (!name) return;
  const path = joinPath(currentPath.value, name);
  try {
    await createFolder(path);
    await refreshAll();
  } catch (err) {
    error.value = err.message || '创建目录失败';
  }
}

async function promptRenameFolder(folder) {
  const nextName = window.prompt('重命名目录', folder.name);
  if (!nextName || nextName === folder.name) return;
  const parent = folder.parentPath || '';
  const targetPath = joinPath(parent, nextName);
  try {
    await moveFolder(folder.path, targetPath);
    if (currentPath.value.startsWith(`${folder.path}/`) || currentPath.value === folder.path) {
      currentPath.value = currentPath.value.replace(folder.path, targetPath);
    }
    await refreshAll();
  } catch (err) {
    error.value = err.message || '目录重命名失败';
  }
}

async function promptMoveFolder(folder) {
  const target = window.prompt('将目录移动到目标路径（例如 assets/images）', folder.path);
  if (!target || target === folder.path) return;
  try {
    await moveFolder(folder.path, target);
    if (currentPath.value.startsWith(`${folder.path}/`) || currentPath.value === folder.path) {
      currentPath.value = currentPath.value.replace(folder.path, target);
    }
    await refreshAll();
  } catch (err) {
    error.value = err.message || '目录移动失败';
  }
}

async function deleteFolderAction(folder) {
  if (!window.confirm(`确定删除目录“${folder.name}”吗？`)) return;
  try {
    await deleteFolder(folder.path, false);
    await refreshAll();
  } catch (err) {
    if (String(err.message || '').includes('not empty')) {
      const recursive = window.confirm('目录非空，是否递归删除（包含文件）？');
      if (!recursive) return;
      try {
        await deleteFolder(folder.path, true);
        if (currentPath.value.startsWith(folder.path)) {
          currentPath.value = '';
        }
        await refreshAll();
      } catch (nestedError) {
        error.value = nestedError.message || '递归删除失败';
      }
      return;
    }
    error.value = err.message || '删除目录失败';
  }
}

async function promptRenameFile(file) {
  const nextName = window.prompt('重命名文件', file.metadata?.fileName || file.name);
  if (!nextName) return;
  try {
    await renameFile(file.name, nextName);
    await reloadExplorer();
  } catch (err) {
    error.value = err.message || '重命名失败';
  }
}

async function promptMoveFile(file) {
  const target = window.prompt('将文件移动到目录路径（留空表示根目录）', currentPath.value);
  if (target == null) return;
  try {
    await moveFiles([file.name], target);
    await refreshAll();
  } catch (err) {
    error.value = err.message || '移动失败';
  }
}

async function deleteFile(file) {
  if (!window.confirm(`确定删除 ${file.metadata?.fileName || file.name} 吗？`)) return;
  try {
    await deleteFiles([file.name]);
    await refreshAll();
  } catch (err) {
    error.value = err.message || '删除失败';
  }
}

async function promptMoveSelected() {
  const target = window.prompt('将已选文件移动到目录路径（留空表示根目录）', currentPath.value);
  if (target == null) return;
  try {
    await moveFiles(selectedFileIds.value, target);
    selectedFileIds.value = [];
    await refreshAll();
  } catch (err) {
    error.value = err.message || '批量移动失败';
  }
}

async function deleteSelected() {
  if (selectedFileIds.value.length === 0) return;
  if (!window.confirm(`确定删除已选中的 ${selectedFileIds.value.length} 个文件吗？`)) return;
  try {
    await deleteFiles(selectedFileIds.value);
    selectedFileIds.value = [];
    await refreshAll();
  } catch (err) {
    error.value = err.message || '批量删除失败';
  }
}

function fileLink(id) {
  return absoluteFileUrl(id);
}

function openPreview(file) {
  previewFile.value = file;
}

function closePreview() {
  previewFile.value = null;
}

async function copyDirect(file) {
  await copyText(fileLink(file.name));
  message.value = '直链已复制。';
}

async function copyShare(file) {
  try {
    const payload = await signShareLink(file.name);
    await copyText(payload.shareUrl);
    const expireAt = payload.expiresAt ? new Date(payload.expiresAt).toLocaleString() : '永不过期';
    message.value = `分享链接已复制。权限：${payload.permission}。过期时间：${expireAt}。`;
  } catch (err) {
    error.value = err.message || '创建分享链接失败';
  }
}

async function copyText(text) {
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

function isImage(name = '') {
  const ext = String(name).split('.').pop()?.toLowerCase() || '';
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'heic'].includes(ext);
}

function isVideo(name = '') {
  const ext = String(name).split('.').pop()?.toLowerCase() || '';
  return ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'].includes(ext);
}

function isAudio(name = '') {
  const ext = String(name).split('.').pop()?.toLowerCase() || '';
  return ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'].includes(ext);
}

function isPdf(name = '') {
  const ext = String(name).split('.').pop()?.toLowerCase() || '';
  return ext === 'pdf';
}

function formatSize(bytes = 0) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatTime(timestamp) {
  if (!timestamp) return '-';
  try {
    return new Date(Number(timestamp)).toLocaleString();
  } catch {
    return '-';
  }
}

function getQueueStatusLabel(status) {
  const map = {
    pending: '待上传',
    uploading: '上传中',
    success: '上传成功',
    error: '上传失败',
    cancelled: '已取消',
  };
  return map[status] || status || '';
}
</script>
