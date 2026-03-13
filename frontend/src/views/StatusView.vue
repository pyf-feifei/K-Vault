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

    <p v-if="error" class="error">{{ error }}</p>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { apiFetch } from '../api/client';

const loading = ref(false);
const error = ref('');
const status = ref(null);

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
</script>
