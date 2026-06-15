<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { adminApi, type ApiError } from '../../shared/api';
import ThemeToggle from '../../shared/ThemeToggle.vue';
import Icon from '../../shared/Icon.vue';

const router = useRouter();
const route = useRoute();
const username = ref('');
const password = ref('');
const error = ref<string | null>(null);
const submitting = ref(false);

onMounted(() => {
  const q = route.query.error;
  if (typeof q === 'string' && q.trim()) error.value = q;
});

async function submit() {
  error.value = null;
  submitting.value = true;
  try {
    await adminApi.login(username.value, password.value);
    router.replace({ name: 'dashboard' });
  } catch (err) {
    error.value = (err as ApiError).message ?? 'login failed';
  } finally {
    submitting.value = false;
  }
}

function signInWithGoogle() {
  window.location.href = '/api/admin/login/google/start';
}
</script>

<template>
  <div class="wrap">
    <div class="theme-corner"><ThemeToggle /></div>
    <form class="card" @submit.prevent="submit">
      <div class="brand">
        <img src="/prism-logo.png" alt="PRISM" class="brand-logo" />
        PRISM admin
      </div>
      <label>Username
        <input v-model="username" autocomplete="username" required />
      </label>
      <label>Password
        <input v-model="password" type="password" autocomplete="current-password" required />
      </label>
      <div v-if="error" class="error-box">{{ error }}</div>
      <button class="primary" :disabled="submitting" type="submit"><Icon name="login" :size="16" />{{ submitting ? 'Signing in…' : 'Sign in' }}</button>

      <div class="divider" role="separator"><span>or</span></div>

      <button class="secondary google-btn" type="button" @click="signInWithGoogle">
        <span class="google-mark" aria-hidden="true">G</span>
        Sign in with Google
      </button>
    </form>
  </div>
</template>

<style scoped>
.wrap {
  min-height: 100vh;
  min-height: 100dvh;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  position: relative;
  background: hsl(var(--muted) / 0.3);
}
.theme-corner { position: absolute; top: 16px; right: 16px; }
form {
  width: 100%;
  max-width: 400px;
  padding: 32px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 700;
  font-size: 1.125rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  margin-bottom: 4px;
}
.brand-logo { width: 36px; height: 36px; object-fit: contain; }
label { display: flex; flex-direction: column; gap: 6px; }
.divider {
  display: flex;
  align-items: center;
  gap: 12px;
  color: hsl(var(--muted-foreground));
  font-size: 0.8125rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.divider::before,
.divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: hsl(var(--border));
}
.google-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
}
.google-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  background: #fff;
  color: #4285f4;
  font-weight: 700;
  font-size: 12px;
  line-height: 1;
  border: 1px solid hsl(var(--border));
}
</style>
