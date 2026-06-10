<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import { adminApi, healthApi } from '../shared/api';
import ThemeToggle from '../shared/ThemeToggle.vue';
import { adminWs } from '../shared/ws';

const router = useRouter();
const route = useRoute();
const username = ref<string | null>(null);
const serverVersion = ref<string | null>(null);
const ready = ref(false);

onMounted(async () => {
  healthApi.get().then((h) => { serverVersion.value = h.version; }).catch(() => null);
  try {
    const me = await adminApi.me();
    username.value = me.principal?.username ?? null;
    adminWs.connect();
  } catch {
    // Not authenticated — bounce to login, unless we're already there.
    if (route.name !== 'login') router.replace({ name: 'login' });
  } finally {
    ready.value = true;
  }
});

async function logout() {
  await adminApi.logout().catch(() => null);
  username.value = null;
  adminWs.disconnect();
  router.replace({ name: 'login' });
}
</script>

<template>
  <div v-if="ready" :class="['layout', { 'layout--bare': route.name === 'login' }]">
    <aside v-if="route.name !== 'login'">
      <div class="brand">
        <img src="/prism-logo.png" alt="PRISM" class="brand-logo" />
        PRISM
      </div>
      <nav>
        <RouterLink :to="{ name: 'dashboard'    }">Dashboard</RouterLink>
        <RouterLink :to="{ name: 'workstations' }">Workstations</RouterLink>
        <RouterLink :to="{ name: 'pipeline'     }">Pipeline</RouterLink>
        <RouterLink :to="{ name: 'visualiser'   }">Visualiser</RouterLink>
        <RouterLink :to="{ name: 'project-attachments' }" class="nav-sub">↳ Project attachments</RouterLink>
        <RouterLink :to="{ name: 'materials'    }">Materials</RouterLink>
        <RouterLink :to="{ name: 'textures'     }" class="nav-sub">↳ Textures</RouterLink>
        <RouterLink :to="{ name: 'fixtures'     }">Fixtures</RouterLink>
        <RouterLink :to="{ name: 'fixture-import' }" class="nav-sub">↳ Import GDTF</RouterLink>
        <RouterLink :to="{ name: 'keys'         }">API keys</RouterLink>
        <RouterLink :to="{ name: 'webhooks'     }">Webhooks</RouterLink>
        <RouterLink :to="{ name: 'settings'     }">Settings</RouterLink>
        <RouterLink :to="{ name: 'users'        }">Users</RouterLink>
        <RouterLink :to="{ name: 'analytics'    }">Analytics</RouterLink>
        <RouterLink :to="{ name: 'logs'         }">Logs</RouterLink>
        <a href="/docs/" target="_blank" rel="noopener" class="external">API docs ↗</a>
      </nav>
      <div class="user-box">
        <div class="muted" style="font-size: 11px;">Signed in as</div>
        <RouterLink :to="{ name: 'profile' }" class="profile-link">
          {{ username ?? '—' }}
        </RouterLink>
        <div class="user-actions">
          <button class="flex-1" @click="logout">Log out</button>
          <ThemeToggle />
        </div>
      </div>
      <div v-if="serverVersion" class="server-version muted">PRISM server v{{ serverVersion }}</div>
    </aside>
    <main class="app-shell-main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  height: 100vh;
  overflow: hidden;
}
.layout--bare { grid-template-columns: 1fr; }
.layout--bare main { padding: 0; overflow: visible; background: hsl(var(--background)); }

aside {
  background: hsl(var(--sidebar-background));
  border-right: 1px solid hsl(var(--sidebar-border));
  padding: 0 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 40;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 68px;
  min-height: 68px;
  padding: 0 4px;
  font-weight: 700;
  font-size: 1rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: hsl(var(--sidebar-foreground));
}
.brand-logo { width: 32px; height: 32px; object-fit: contain; }

nav { display: flex; flex-direction: column; gap: 2px; flex: 1; }
nav a {
  padding: 10px 12px;
  border-radius: calc(var(--radius) - 2px);
  color: hsl(var(--sidebar-foreground));
  text-decoration: none;
  font-weight: 500;
  font-size: 0.8125rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  transition: background-color 120ms ease, color 120ms ease;
}
nav a:hover {
  background: hsl(var(--sidebar-accent));
  color: hsl(var(--sidebar-accent-foreground));
}
nav a.router-link-active {
  background: hsl(var(--sidebar-accent));
  color: hsl(var(--sidebar-primary));
  font-weight: 600;
}
nav a.nav-sub {
  padding-left: 24px;
  font-size: 0.75rem;
  font-weight: 400;
  letter-spacing: 0.02em;
}
nav a.external {
  margin-top: 8px;
  border-top: 1px solid hsl(var(--sidebar-border));
  padding-top: 14px;
  font-size: 0.75rem;
}
nav a.external:hover { color: hsl(var(--sidebar-foreground)); }

.user-box {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 12px;
  border-top: 1px solid hsl(var(--sidebar-border));
}
.server-version { font-size: 0.6875rem; text-align: center; }
.user-actions { display: flex; align-items: center; gap: 6px; }
.profile-link {
  color: hsl(var(--sidebar-foreground));
  text-decoration: none;
  font-weight: 600;
  padding: 4px 0;
}
.profile-link:hover { color: hsl(var(--sidebar-primary)); }

main { padding: 16px 24px; overflow: auto; }
</style>
