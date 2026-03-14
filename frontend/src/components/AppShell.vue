<template>
  <div class="app-bg">
    <header class="topbar card">
      <div class="brand-group">
        <span class="brand-dot"></span>
        <div>
          <h1>K-Vault</h1>
          <p>Docker + Cloudflare 双模式运行</p>
        </div>
      </div>
      <nav class="nav-row">
        <router-link class="nav-link" to="/">上传</router-link>
        <router-link class="nav-link" to="/drive">文件库</router-link>
        <router-link class="nav-link" to="/storage">存储配置</router-link>
        <router-link class="nav-link" to="/cache">缓存</router-link>
        <router-link class="nav-link" to="/status">状态</router-link>
        <a class="nav-link" href="/legacy/index.html" target="_blank" rel="noopener">旧版</a>
      </nav>
      <div class="toolbar">
        <router-link
          v-if="authStore.authRequired && !authStore.authenticated"
          class="btn btn-ghost"
          to="/login"
        >
          登录
        </router-link>
        <button v-if="authStore.authenticated" class="btn btn-ghost" @click="handleLogout">退出</button>
      </div>
    </header>

    <section v-if="authStore.guestMode" class="guest-note card">
      <strong>访客模式已启用。</strong>
      <span>
        单文件上限：{{ formatSize(authStore.guestUpload.maxFileSize) }}，
        每日最多 {{ authStore.guestUpload.dailyLimit }} 次上传。
      </span>
    </section>

    <main class="page-wrap">
      <router-view />
    </main>
  </div>
</template>

<script setup>
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const authStore = useAuthStore();
const router = useRouter();

function formatSize(bytes = 0) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
}

async function handleLogout() {
  try {
    await authStore.logout();
  } finally {
    router.push('/login');
  }
}
</script>
