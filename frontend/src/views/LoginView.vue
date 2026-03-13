<template>
  <div class="app-bg login-page">
    <section class="card login-card">
      <h1>登录</h1>
      <p class="muted">使用后端配置的 BASIC_USER / BASIC_PASS 登录。</p>

      <form class="form-grid" @submit.prevent="submit">
        <label>
          用户名
          <input v-model.trim="username" autocomplete="username" required />
        </label>
        <label>
          密码
          <input v-model="password" type="password" autocomplete="current-password" required />
        </label>
        <button class="btn" :disabled="submitting">
          {{ submitting ? '登录中...' : '登录' }}
        </button>
      </form>

      <p v-if="error" class="error">{{ error }}</p>
      <p class="muted link-row">
        需要旧版页面？
        <a href="/login.html" target="_blank" rel="noopener">打开旧版登录页</a>
      </p>
    </section>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const authStore = useAuthStore();
const route = useRoute();
const router = useRouter();

const username = ref('');
const password = ref('');
const submitting = ref(false);
const error = ref('');

onMounted(async () => {
  if (!authStore.initialized) {
    await authStore.refresh();
  }

  if (!authStore.authRequired || authStore.authenticated) {
    const target = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    router.replace(target);
  }
});

async function submit() {
  submitting.value = true;
  error.value = '';
  try {
    await authStore.login(username.value, password.value);
    const target = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    router.push(target);
  } catch (err) {
    error.value = err.message || '登录失败';
  } finally {
    submitting.value = false;
  }
}
</script>